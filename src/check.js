import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  blobParts,
  git,
  hash,
  head,
  importPaths,
  inventory,
  policyBlob,
  snapshot,
  textChunks,
} from './git.js';
import { ConfigurationError, matches, parsePolicy } from './policy.js';
import {
  createJevEvaluator,
  MAX_EVIDENCE_BYTES,
  MODEL,
  PROTOCOL_VERSION,
  validateAnswer,
} from './model.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const regular = (mode) => ['100644', '100755'].includes(mode);

function pool(concurrency) {
  let active = 0;
  const queue = [];
  const advance = () => {
    while (active < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          advance();
        });
    }
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      advance();
    });
}

export async function check(options = {}) {
  const started = performance.now();
  const result = {
    status: 'incomplete',
    rules: [],
    coverage: { files: 0, packets: 0, judged: 0, cached: 0, unsupported: [] },
    messages: [],
    elapsedMs: 0,
  };
  const deadlineMs = options.deadlineMs ?? (options.hook ? 3000 : 120_000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new ConfigurationError('deadlineMs must be positive.');
  if (
    options.concurrency !== undefined &&
    (!Number.isInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 32)
  )
    throw new ConfigurationError('concurrency must be between 1 and 32.');
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let stopped = false;
  const work = run(options, result, signal, () => stopped).catch((error) => {
    if (!stopped) {
      result.messages.push(
        error instanceof ConfigurationError
          ? error.message
          : signal.aborted
            ? 'Check deadline reached; a full check is still required.'
            : 'Check could not finish. Verify Git access and the judgment backend.',
      );
      if (error instanceof ConfigurationError) result.status = 'invalid';
    }
  });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      stopped = true;
      controller.abort();
      result.messages.push(
        'Check deadline reached; a full check is still required.',
      );
      resolve();
    }, deadlineMs);
  });
  await Promise.race([work, deadline]);
  clearTimeout(timer);
  controller.abort();
  // Keep findings even if another request failed or timed out.
  if (result.rules.some((rule) => rule.status === 'violation'))
    result.status = 'violation';
  else if (
    result.status !== 'invalid' &&
    !stopped &&
    !result.messages.length &&
    result.rules.every((rule) =>
      ['pass', 'not_applicable'].includes(rule.status),
    )
  )
    result.status = 'pass';
  result.elapsedMs = Math.round(performance.now() - started);
  return structuredClone(result);
}

async function run(options, result, signal, stopped) {
  const snap = await snapshot(options, signal);
  result.snapshot = { base: snap.base, tree: snap.tree };
  result.coverage.files = snap.changes.length;
  let policyText = await policyBlob(snap, snap.base, signal);
  result.policySource = 'base';
  if (policyText === null) {
    policyText = await policyBlob(snap, snap.tree, signal);
    result.policySource = 'proposed';
  }
  if (policyText === null) {
    result.policySource = 'absent';
    return;
  }
  const policy = parsePolicy(policyText);
  if (snap.changes.length === 0) return;
  const files = await inventory(snap, signal);
  const limit = pool(options.concurrency ?? 8);
  const modelLimit = pool(options.concurrency ?? 8);
  const evaluator = options.evaluate ?? createJevEvaluator(options);
  const cacheIdentity =
    options.cacheIdentity ??
    (options.evaluate
      ? null
      : `typesafe:${options.endpoint ?? 'https://api.typesafe.ai/v1/systemone'}:${options.model ?? MODEL}`);
  let cacheDir;
  if (options.cache !== false && cacheIdentity) {
    const gitDir = await git(
      snap.root,
      ['rev-parse', '--absolute-git-dir'],
      signal,
      snap.env,
    );
    cacheDir = join(gitDir, 'judgement-cache');
  }
  const ask = async (request) => {
    signal.throwIfAborted();
    result.coverage.packets++;
    if (options.dryRun) return { outcome: 'unclear', confidence: 0 };
    // Cache raw answers, not approval of a repository. Planning runs again on every snapshot.
    // Negative lookups depend on the whole tree; positive evidence carries exact blob identities.
    const searchTree = request.unresolved?.length ? snap.tree : undefined;
    const key = hash(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        backend: cacheIdentity,
        searchTree,
        request,
      }),
    );
    const target = cacheDir && join(cacheDir, key + '.json');
    if (target) {
      try {
        const cached = validateAnswer(
          JSON.parse(await readFile(target, 'utf8')),
          request,
        );
        if (!stopped()) {
          result.coverage.cached++;
          result.coverage.judged++;
        }
        return cached;
      } catch {
        /* Missing or invalid cache entries are evaluated again. */
      }
    }
    const answer = validateAnswer(
      await modelLimit(() => {
        signal.throwIfAborted();
        return evaluator(request, signal);
      }),
      request,
    );
    signal.throwIfAborted();
    if (!stopped()) result.coverage.judged++;
    if (target && !['unclear'].includes(answer.outcome)) {
      // Cache failures cannot turn an otherwise completed check into a failure.
      try {
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}`;
        await writeFile(temporary, JSON.stringify(answer), { mode: 0o600 });
        await rename(temporary, target);
      } catch {
        /* Optional cache. */
      }
    }
    return answer;
  };

  const loaded = new Map();
  const load = async (path) => {
    if (loaded.has(path)) return loaded.get(path);
    const entry = files.get(path);
    if (!entry || !regular(entry.mode)) return null;
    const promise = blobParts(snap, path, entry.oid, 'context', signal);
    loaded.set(path, promise);
    return promise;
  };

  const evidenceFor = async (change) => {
    const evidence = [];
    if (
      (change.mode !== '000000' && !regular(change.mode)) ||
      (change.oldMode !== '000000' && !regular(change.oldMode))
    )
      return null;
    if (change.mode !== '000000') {
      const parts = await load(change.path);
      if (!parts) return null;
      evidence.push(...parts.map((part) => ({ ...part, kind: 'after' })));
    }
    for await (const chunk of textChunks(
      snap,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--unified=12',
        snap.base,
        snap.tree,
        '--',
        change.path,
      ],
      signal,
    )) {
      if (
        chunk.binary ||
        chunk.text.includes('GIT binary patch') ||
        /^Binary files .* differ$/m.test(chunk.text)
      )
        return null;
      evidence.push({
        path: change.path,
        kind: 'patch',
        line: chunk.line,
        text: chunk.text,
      });
    }
    return evidence;
  };

  await Promise.all(
    policy.criteria.map((criterion) =>
      limit(async () => {
        const record = {
          id: criterion.id,
          rule: criterion.rule,
          status: 'incomplete',
          findings: [],
          unresolved: [],
        };
        if (stopped()) return;
        result.rules.push(record);
        try {
          signal.throwIfAborted();
          const changes = snap.changes.filter(
            (change) =>
              change.path !== 'JUDGE.json' &&
              matches(change.path, criterion.files),
          );
          if (!changes.length) {
            record.status = 'not_applicable';
            return;
          }
          const units = [];
          for (const change of changes) {
            const evidence = await evidenceFor(change);
            signal.throwIfAborted();
            if (!evidence) {
              record.unresolved.push(`Unsupported content: ${change.path}`);
              if (!result.coverage.unsupported.includes(change.path))
                result.coverage.unsupported.push(change.path);
            } else units.push({ path: change.path, evidence });
          }
          const related = new Map(),
            unresolved = new Set();
          for (const pattern of criterion.context ?? []) {
            const paths = [...files.keys()].filter((path) =>
              matches(path, [pattern]),
            );
            if (!paths.length) {
              unresolved.add(`Context pattern matched no files: ${pattern}`);
              record.unresolved.push(
                `Context pattern matched no files: ${pattern}`,
              );
            }
            for (const path of paths) related.set(path, true);
          }
          // Two deterministic dependency hops; do not read the working tree or execute repository code.
          let frontier = units.flatMap((unit) =>
            unit.evidence.filter((part) => part.kind === 'after'),
          );
          for (let depth = 0; depth < 2; depth++) {
            const next = [];
            for (const part of frontier) {
              const imports = importPaths(part.path, part.text, files);
              for (const name of imports.unresolved)
                unresolved.add(`${part.path}: unresolved import ${name}`);
              for (const path of imports.found)
                if (!related.has(path)) {
                  related.set(path, true);
                  const parts = await load(path);
                  if (parts) next.push(...parts);
                }
            }
            frontier = next;
          }
          const changedPaths = new Set(units.map((unit) => unit.path));
          const context = [];
          for (const path of related.keys()) {
            if (changedPaths.has(path)) continue;
            const parts = await load(path);
            if (!parts) record.unresolved.push(`Unsupported context: ${path}`);
            else context.push(...parts);
          }
          const makeRequest = (evidence, focusPaths, complete) => ({
            kind: 'judge',
            rule: criterion.rule,
            evidence,
            focusPaths,
            complete,
            unresolved: [...unresolved],
          });
          const whole = makeRequest(
            [...units.flatMap((unit) => unit.evidence), ...context],
            units.map((unit) => unit.path),
            true,
          );
          const consume = (answer, request) => {
            if (
              answer.outcome === 'violation' &&
              answer.confidence >= criterion.threshold
            ) {
              record.status = 'violation';
              record.findings.push({
                paths: request.focusPaths,
                confidence: answer.confidence,
                sources: request.evidence.map(({ path, kind, line }) => ({
                  path,
                  kind,
                  line,
                })),
              });
            } else if (
              answer.outcome === 'unclear' ||
              answer.confidence < criterion.threshold ||
              answer.outcome === 'violation'
            )
              record.unresolved.push(
                `More evidence needed: ${request.focusPaths.join(', ')}`,
              );
          };
          if (bytes(whole) <= MAX_EVIDENCE_BYTES) {
            consume(await ask(whole), whole);
          } else {
            const strategy = await ask({
              kind: 'strategy',
              rule: criterion.rule,
            });
            // A conservative model interpretation; never a generic AND/OR over chunk verdicts.
            const local =
              strategy.outcome === 'local' && strategy.confidence >= 0.95;
            if (!local)
              record.unresolved.push(
                'The whole-change relationship exceeds the evidence budget.',
              );
            await Promise.all(
              units.map(async (unit) => {
                signal.throwIfAborted();
                // Include all changed dependency files as well as unchanged dependencies.
                // Include every changed related file collected by the bounded dependency walk.
                const dependencyPaths = new Set(related.keys());
                const linked = units
                  .filter(
                    (other) =>
                      other.path !== unit.path &&
                      dependencyPaths.has(other.path),
                  )
                  .flatMap((other) => other.evidence);
                const request = makeRequest(
                  [...unit.evidence, ...linked, ...context],
                  [unit.path],
                  local,
                );
                if (local && bytes(request) <= MAX_EVIDENCE_BYTES)
                  consume(await ask(request), request);
                else {
                  record.unresolved.push(
                    `Evidence requires a larger relationship check: ${unit.path}`,
                  );
                  // Visit every source/patch chunk. Screens may find direct violations but cannot approve the rule.
                  for (const part of [
                    ...unit.evidence,
                    ...linked,
                    ...context,
                  ]) {
                    const screen = makeRequest([part], [unit.path], false);
                    if (bytes(screen) > MAX_EVIDENCE_BYTES) {
                      record.unresolved.push(
                        'Rule or source metadata exceeds the request budget.',
                      );
                      continue;
                    }
                    consume(await ask(screen), screen);
                    await setImmediate();
                  }
                }
              }),
            );
          }
          signal.throwIfAborted();
          if (stopped()) return;
          record.status = record.findings.length
            ? 'violation'
            : record.unresolved.length || options.dryRun
              ? 'incomplete'
              : 'pass';
          if (options.dryRun)
            record.unresolved.push('Dry run: no model requests were sent.');
          options.onProgress?.({ id: criterion.id, status: record.status });
        } catch {
          if (!stopped()) {
            record.status = record.findings.length ? 'violation' : 'incomplete';
            record.unresolved.push('Evidence collection or judgment failed.');
          }
        }
      }),
    ),
  );
  signal.throwIfAborted();
  if (options.base === undefined) {
    const finalTree = await git(snap.root, ['write-tree'], signal, snap.env);
    if (
      finalTree !== snap.tree ||
      (await head(snap.root, signal, snap.env)) !== snap.originalHead
    ) {
      result.messages.push(
        'Git changed during the check; rerun against the new snapshot.',
      );
      for (const rule of result.rules)
        if (rule.status === 'pass') rule.status = 'incomplete';
    }
  }
  if (result.rules.some((rule) => rule.status === 'incomplete'))
    result.messages.push(
      'Some rules remain incomplete; a full check is required before merge.',
    );
}

export function exitCode(report, { hook = false, advisory = false } = {}) {
  if (advisory) return 0;
  if (report.status === 'invalid') return 2;
  if (report.status === 'violation') return 1;
  if (report.status === 'pass') return 0;
  return hook ? 0 : 3;
}

export function formatReport(report) {
  const lines = [
    `judgement: ${report.status} (${report.elapsedMs} ms; ${report.coverage.judged} judgments, ${report.coverage.cached} cached)`,
  ];
  for (const rule of report.rules) {
    if (rule.status === 'pass' || rule.status === 'not_applicable') continue;
    lines.push(`${rule.status}: ${rule.id}: ${rule.rule}`);
    for (const finding of rule.findings)
      lines.push(
        `  ${finding.paths.join(', ')} (confidence ${finding.confidence.toFixed(2)})`,
      );
    for (const unresolved of new Set(rule.unresolved))
      lines.push(`  ${unresolved}`);
  }
  lines.push(...report.messages);
  return lines.join('\n');
}
