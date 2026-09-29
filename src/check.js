import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  blobParts,
  git,
  hash,
  head,
  inventory,
  policyBlob,
  snapshot,
  textChunks,
} from './git.js';
import {
  ConfigurationError,
  matches,
  parsePolicy,
  POLICY_PATH,
  isConfigurationPath,
} from './policy.js';
import {
  createJevEvaluator,
  MAX_EVIDENCE_BYTES,
  MODEL,
  PROTOCOL_VERSION,
  formatAnswer,
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
  const trace = (message) => {
    if (!stopped()) {
      try {
        options.onDiagnostic?.(message);
      } catch {
        /* Diagnostics cannot change a verdict. */
      }
    }
  };
  const snap = await snapshot(options, signal);
  trace(`snapshot: ${snap.changes.length} changed files`);
  result.snapshot = { base: snap.base, tree: snap.tree };
  result.coverage.files = snap.changes.length;
  let policyText = await policyBlob(snap, snap.base, signal);
  result.policySource = 'base';
  // Reject nonregular proposed policies without letting a new policy weaken this check.
  const proposedPolicy =
    policyText === null ||
    snap.changes.some((change) => change.path === POLICY_PATH)
      ? await policyBlob(snap, snap.tree, signal)
      : null;
  if (policyText === null) {
    policyText = proposedPolicy;
    result.policySource = 'proposed';
  }
  if (policyText === null) {
    result.policySource = 'absent';
    trace('no Judgement policy; no model requests');
    return;
  }
  const policy = parsePolicy(policyText);
  trace(`policy: ${result.policySource}; ${policy.criteria.length} rules`);
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
  const ask = async (request, id) => {
    const label = `${JSON.stringify(id)} ${request.focusPaths.map((path) => JSON.stringify(path)).join(', ')}${request.complete ? '' : ' (partial screen)'}`;
    signal.throwIfAborted();
    result.coverage.packets++;
    if (options.dryRun) {
      trace(
        `dry run: ${label}; ${bytes(request)} evidence bytes; no model request`,
      );
      return { outcome: 'unclear', confidence: 0 };
    }
    // Cache raw answers, not approval of a repository. Planning runs again on every snapshot.
    // Negative lookups depend on the whole tree; positive evidence carries exact blob identities.
    const searchTree = request.unresolved?.length ? snap.tree : undefined;
    const key = hash(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        backend: cacheIdentity,
        searchTree,
        focusBlobs: snap.changes
          .filter((change) => request.focusPaths.includes(change.path))
          .map(({ oldOid, oid }) => ({ oldOid, oid })),
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
        trace(`cache hit: ${label}; ${formatAnswer(cached)}`);
        return cached;
      } catch {
        /* Missing or invalid cache entries are evaluated again. */
      }
    }
    const started = performance.now();
    trace(`judging: ${label}; ${bytes(request)} evidence bytes`);
    const answer = validateAnswer(
      await modelLimit(() => {
        signal.throwIfAborted();
        return evaluator(request, signal);
      }),
      request,
    );
    signal.throwIfAborted();
    if (!stopped()) result.coverage.judged++;
    trace(
      `answer: ${label}; ${formatAnswer(answer)} (${Math.round(performance.now() - started)} ms)`,
    );
    if (
      target &&
      ('violationProbability' in answer || answer.outcome !== 'unclear')
    ) {
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

  const evidenceFor = async (change, lines = 12) => {
    const evidence = [];
    if (
      (change.mode !== '000000' && !regular(change.mode)) ||
      (change.oldMode !== '000000' && !regular(change.oldMode))
    )
      return null;
    for await (const chunk of textChunks(
      snap,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        `--unified=${lines}`,
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
              !isConfigurationPath(change.path) &&
              matches(change.path, criterion.files),
          );
          trace(
            `rule ${JSON.stringify(criterion.id)}: ${changes.length} matching files`,
          );
          if (!changes.length) {
            record.status = 'not_applicable';
            return;
          }
          // Every matching file is an independent obligation. Context is explicit;
          // v1 does not reinterpret global rules as a collection of file checks.
          const context = [];
          const contextPaths = new Set();
          for (const pattern of criterion.context ?? []) {
            const paths = [...files.keys()].filter((path) =>
              matches(path, [pattern]),
            );
            if (!paths.length)
              record.unresolved.push(
                `Context pattern matched no files: ${pattern}`,
              );
            for (const path of paths) contextPaths.add(path);
          }
          for (const path of contextPaths) {
            const parts = await load(path);
            if (!parts) record.unresolved.push(`Unsupported context: ${path}`);
            else context.push(...parts);
          }
          const contextUnresolved = [...record.unresolved];
          const consume = (answer, request) => {
            if ('violationProbability' in answer) {
              if (answer.violationProbability >= criterion.threshold) {
                record.status = 'violation';
                record.findings.push({
                  paths: request.focusPaths,
                  confidence: answer.violationProbability,
                  violationProbability: answer.violationProbability,
                  sources: request.evidence.map(({ path, kind, line }) => ({
                    path,
                    kind,
                    line,
                  })),
                });
              }
              return;
            }
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
            ) {
              record.unresolved.push(
                `More evidence needed: ${request.focusPaths.join(', ')}`,
              );
            }
          };
          const fileLimit = pool(options.concurrency ?? 8);
          await Promise.all(
            changes.map((change) =>
              fileLimit(async () => {
                try {
                  signal.throwIfAborted();
                  trace(
                    `collecting: ${JSON.stringify(criterion.id)} ${JSON.stringify(change.path)}`,
                  );
                  const evidence = await evidenceFor(change);
                  signal.throwIfAborted();
                  if (!evidence) {
                    record.unresolved.push(
                      `Unsupported content: ${change.path}`,
                    );
                    if (!result.coverage.unsupported.includes(change.path))
                      result.coverage.unsupported.push(change.path);
                    return;
                  }
                  const request = {
                    kind: 'judge',
                    rule: criterion.rule,
                    evidence: [
                      ...evidence,
                      ...context.filter((part) => part.path !== change.path),
                    ],
                    focusPaths: [change.path],
                    complete: true,
                    unresolved: contextUnresolved,
                  };
                  if (bytes(request) <= MAX_EVIDENCE_BYTES) {
                    let answer = await ask(request, criterion.id);
                    const uncertain =
                      !('violationProbability' in answer) &&
                      (answer.outcome === 'unclear' ||
                        answer.confidence < criterion.threshold);
                    if (uncertain && !options.dryRun) {
                      // Expand only when needed; keep every hunk in either request.
                      const parts =
                        change.mode === '000000'
                          ? null
                          : await load(change.path);
                      let expanded = parts && {
                        ...request,
                        evidence: [
                          ...request.evidence,
                          ...parts.map((part) => ({ ...part, kind: 'after' })),
                        ],
                      };
                      if (!expanded || bytes(expanded) > MAX_EVIDENCE_BYTES) {
                        const wider = await evidenceFor(change, 80);
                        expanded = wider && {
                          ...request,
                          evidence: [
                            ...wider,
                            ...context.filter(
                              (part) => part.path !== change.path,
                            ),
                          ],
                        };
                      }
                      if (
                        expanded &&
                        bytes(expanded) <= MAX_EVIDENCE_BYTES &&
                        JSON.stringify(expanded.evidence) !==
                          JSON.stringify(request.evidence)
                      ) {
                        trace(
                          `expanding context: ${JSON.stringify(criterion.id)} ${JSON.stringify(change.path)}`,
                        );
                        answer = await ask(expanded, criterion.id);
                        consume(answer, expanded);
                      } else {
                        trace(
                          `context expansion cannot fit or adds no evidence: ${JSON.stringify(change.path)}`,
                        );
                        consume(answer, request);
                      }
                    } else {
                      consume(answer, request);
                    }
                  } else {
                    record.unresolved.push(
                      `Evidence exceeds the file budget: ${change.path}`,
                    );
                    // Screens visit every chunk and can establish direct violations.
                    // Even unanimous passes cannot approve a file split across requests.
                    for (const part of request.evidence) {
                      const screen = {
                        ...request,
                        evidence: [part],
                        complete: false,
                      };
                      if (bytes(screen) > MAX_EVIDENCE_BYTES) {
                        record.unresolved.push(
                          'Rule or source metadata exceeds the request budget.',
                        );
                        continue;
                      }
                      consume(await ask(screen, criterion.id), screen);
                      await setImmediate();
                    }
                  }
                } catch {
                  if (!stopped())
                    record.unresolved.push(
                      `Evidence collection or judgment failed: ${change.path}`,
                    );
                }
              }),
            ),
          );
          signal.throwIfAborted();
          if (stopped()) return;
          record.status = record.findings.length
            ? 'violation'
            : record.unresolved.length || options.dryRun
              ? 'incomplete'
              : 'pass';
          if (options.dryRun)
            record.unresolved.push('Dry run: no model requests were sent.');
          trace(`rule ${JSON.stringify(criterion.id)}: ${record.status}`);
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
        `  ${finding.paths.join(', ')} (${finding.violationProbability === undefined ? 'confidence' : 'violation probability'} ${finding.confidence.toFixed(2)})`,
      );
    for (const unresolved of new Set(rule.unresolved))
      lines.push(`  ${unresolved}`);
  }
  lines.push(...report.messages);
  return lines.join('\n');
}
