import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { check } from './check.js';
import { git, gitEnv } from './git.js';
import {
  ConfigurationError,
  matches,
  readPolicy,
  isConfigurationPath,
} from './policy.js';
import {
  createJevEvaluator,
  MODEL,
  PROTOCOL_VERSION,
  validateAnswer,
} from './model.js';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value) => typeof value === 'string' && !value.includes('\0');
const fail = (message) => {
  throw new ConfigurationError(message);
};
const safePath = (path) => {
  if (
    !text(path) ||
    !path ||
    /[\\:\r\n]/.test(path) ||
    ['.judgement/rules.json'].some(
      (reserved) =>
        reserved === path.toLowerCase() ||
        reserved.startsWith(`${path.toLowerCase()}/`) ||
        path.toLowerCase().startsWith(`${reserved}/`),
    )
  )
    return false;
  return path
    .split('/')
    .every(
      (part) =>
        part &&
        !['.', '..', '.git'].includes(part.toLowerCase()) &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
};

function examplesFrom(value, criterion) {
  if (
    !object(value) ||
    !keys(value, ['ruleId', 'examples']) ||
    value.ruleId !== criterion.id ||
    !Array.isArray(value.examples) ||
    !value.examples.length
  )
    fail(
      'Examples must contain the selected ruleId and a non-empty examples array.',
    );
  const names = new Set();
  return value.examples.map((example) => {
    if (
      !object(example) ||
      !keys(example, [
        'name',
        'path',
        'before',
        'after',
        'expected',
        'context',
      ]) ||
      !text(example.name) ||
      !example.name.trim() ||
      names.has(example.name) ||
      !['pass', 'violation'].includes(example.expected) ||
      !(example.before === null || text(example.before)) ||
      !(example.after === null || text(example.after)) ||
      example.before === example.after
    )
      fail(
        'Each example needs a unique name, different before/after text (or null), and expected pass or violation.',
      );
    names.add(example.name);
    const path = example.path ?? 'example.md';
    if (
      !safePath(path) ||
      isConfigurationPath(path) ||
      !matches(path, criterion.files)
    )
      fail(
        `Example ${JSON.stringify(example.name)} needs a safe relative path matching the rule's files.`,
      );
    const context = example.context ?? {};
    if (
      !object(context) ||
      Object.entries(context).some(
        ([path, value]) => !safePath(path) || !text(value),
      )
    )
      fail('Example context must map safe relative file paths to text.');
    const paths = [path, ...Object.keys(context)].map((path) =>
      path.toLowerCase(),
    );
    if (
      paths.some((path, i) =>
        paths.some(
          (other, j) =>
            i !== j && (path === other || path.startsWith(`${other}/`)),
        ),
      )
    )
      fail('Example file paths must not overlap.');
    return { ...example, path, context };
  });
}

/** Run real checks in disposable Git repositories, never in the caller's index. */
export async function calibrate(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const policy = await readPolicy(cwd);
  if (!options.ruleId) fail('Calibration requires --rule <id>.');
  const criterion = policy.criteria.find((rule) => rule.id === options.ruleId);
  if (!criterion) fail('The selected rule ID does not exist in the policy.');
  if (
    !options.examplesPath &&
    (!safePath(`${criterion.id}.json`) || criterion.id.includes('/'))
  )
    fail('This rule ID needs an explicit --examples path.');
  let input;
  try {
    input = JSON.parse(
      await readFile(
        resolve(
          cwd,
          options.examplesPath ?? `.judgement/examples/${criterion.id}.json`,
        ),
        'utf8',
      ),
    );
  } catch {
    fail('Cannot read examples JSON. Use --examples <path>.');
  }
  const examples = examplesFrom(input, criterion);
  const repeats = options.repeats ?? 3;
  const concurrency = options.concurrency ?? 2;
  const deadlineMs = options.deadlineMs ?? 3000;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
    fail('Repeats must be an integer from 1 to 20.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    fail('Concurrency must be an integer from 1 to 8.');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    fail('The check timeout must be positive.');
  const candidates = options.thresholds ?? [
    0.8,
    0.85,
    0.9,
    0.95,
    criterion.threshold,
  ];
  if (
    !Array.isArray(candidates) ||
    !candidates.length ||
    candidates.length > 20 ||
    candidates.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    fail('Thresholds must contain 1 to 20 numbers between 0 and 1.');
  const thresholds = [...new Set(candidates)].sort((a, b) => a - b);
  const diagnostics = (message) => {
    try {
      options.onDiagnostic?.(message);
    } catch {
      /* Optional UI. */
    }
  };
  const report = {
    ruleId: criterion.id,
    configuredThreshold: criterion.threshold,
    backend: options.evaluate ? 'custom' : (options.model ?? MODEL),
    protocolVersion: PROTOCOL_VERSION,
    repeats,
    deadlineMs,
    dryRun: Boolean(options.dryRun),
    examples: examples.length,
    plannedChecks: examples.length * thresholds.length * repeats,
    results: [],
    summaries: [],
    recommendation: null,
    recommendationReason: '',
  };
  diagnostics(
    `calibration: ${report.plannedChecks} checks; ${thresholds.length} thresholds; cache disabled${options.dryRun ? '; no model requests' : '; each check may make multiple model requests'}`,
  );
  const evaluate = options.evaluate ?? createJevEvaluator(options);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const directory = await mkdtemp(join(tmpdir(), 'judgement-calibrate-'));
  // Ignore alternate indexes, worktrees, templates, hooks, and user Git config.
  const env = Object.fromEntries(
    Object.entries(gitEnv()).filter(([key]) => !key.startsWith('GIT_')),
  );
  env.HOME = join(directory, 'home');
  env.USERPROFILE = env.HOME;
  const template = join(directory, 'template');
  const jobs = examples.flatMap((example) =>
    thresholds.map((threshold) => ({ example, threshold })),
  );
  let next = 0;
  try {
    await mkdir(env.HOME);
    await mkdir(template);
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        (async () => {
          while (next < jobs.length) {
            const jobIndex = next++;
            const { example, threshold } = jobs[jobIndex];
            signal.throwIfAborted();
            const root = join(directory, String(jobIndex));
            await mkdir(root);
            const runGit = (args) => git(root, args, signal, env);
            const put = async (path, contents) => {
              await mkdir(dirname(join(root, path)), { recursive: true });
              await writeFile(join(root, path), contents);
            };
            await runGit(['init', '-q', `--template=${template}`]);
            await runGit(['config', 'core.hooksPath', template]);
            await runGit(['config', 'core.autocrlf', 'false']);
            await runGit([
              'config',
              'core.excludesFile',
              join(template, 'exclude'),
            ]);
            await put(
              '.judgement/rules.json',
              JSON.stringify({ criteria: [{ ...criterion, threshold }] }),
            );
            for (const [path, contents] of Object.entries(example.context))
              await put(path, contents);
            if (example.before !== null)
              await put(example.path, example.before);
            await runGit(['add', '--force', '--all']);
            const tree = await runGit(['write-tree']);
            const commit = await runGit([
              '-c',
              'user.name=Judgement',
              '-c',
              'user.email=judgement@example.invalid',
              '-c',
              'commit.gpgSign=false',
              'commit-tree',
              tree,
              '-m',
              'Calibration baseline',
            ]);
            await runGit(['update-ref', 'HEAD', commit]);
            if (example.after === null) await rm(join(root, example.path));
            else await put(example.path, example.after);
            await runGit(['add', '--force', '--all']);
            for (let repetition = 1; repetition <= repeats; repetition++) {
              signal.throwIfAborted();
              const answers = [];
              let backendErrors = 0;
              const result = await check({
                cwd: root,
                env,
                hook: true,
                deadlineMs,
                signal,
                concurrency: 1,
                cache: false,
                dryRun: options.dryRun,
                evaluate: async (request, signal) => {
                  try {
                    const answer = validateAnswer(
                      await evaluate(request, signal),
                      request,
                    );
                    // A custom evaluator can ignore cancellation; late results must not mutate the report.
                    signal.throwIfAborted();
                    answers.push({ ...answer, complete: request.complete });
                    return answer;
                  } catch {
                    if (!signal.aborted) backendErrors++;
                    throw new Error('Calibration evaluator failed.');
                  }
                },
              });
              signal.throwIfAborted();
              const operationalFailure =
                !options.dryRun &&
                (backendErrors > 0 ||
                  result.status === 'invalid' ||
                  result.coverage.judged === 0 ||
                  result.messages.some((message) =>
                    message.includes('deadline'),
                  ));
              report.results.push({
                example: example.name,
                expected: example.expected,
                threshold,
                repetition,
                status: result.status,
                elapsedMs: result.elapsedMs,
                judgments: result.coverage.judged,
                answers,
                operationalFailure,
              });
              diagnostics(
                `${JSON.stringify(example.name)} threshold ${threshold} run ${repetition}: ${result.status}; ${answers.map((answer) => `${answer.outcome} ${answer.confidence.toFixed(2)}`).join(', ') || 'no judgments'}`,
              );
            }
          }
        })().catch((error) => {
          controller.abort();
          throw error;
        }),
      ),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  report.results.sort(
    (a, b) =>
      a.threshold - b.threshold ||
      a.example.localeCompare(b.example) ||
      a.repetition - b.repetition,
  );
  report.summaries = thresholds.map((threshold) => {
    const runs = report.results.filter((run) => run.threshold === threshold);
    const count = (expected, status) =>
      runs.filter((run) => run.expected === expected && run.status === status)
        .length;
    return {
      threshold,
      violationRuns: runs.filter((run) => run.expected === 'violation').length,
      validRuns: runs.filter((run) => run.expected === 'pass').length,
      caughtViolations: count('violation', 'violation'),
      falseBlocks: count('pass', 'violation'),
      incorrectPasses: count('violation', 'pass'),
      validPasses: count('pass', 'pass'),
      incompleteViolations: count('violation', 'incomplete'),
      incompleteValid: count('pass', 'incomplete'),
      operationalFailures: runs.filter((run) => run.operationalFailure).length,
      judgments: runs.reduce((total, run) => total + run.judgments, 0),
      meanElapsedMs: Math.round(
        runs.reduce((total, run) => total + run.elapsedMs, 0) / runs.length,
      ),
    };
  });
  const eligible = report.summaries.filter(
    (row) =>
      row.violationRuns &&
      row.validRuns &&
      row.caughtViolations === row.violationRuns &&
      row.falseBlocks === 0,
  );
  eligible.sort(
    (a, b) => b.validPasses - a.validPasses || b.threshold - a.threshold,
  );
  if (options.dryRun)
    report.recommendationReason = 'Dry run: no model judgments.';
  else if (report.summaries.some((row) => row.operationalFailures))
    report.recommendationReason =
      'Some checks failed or timed out; rerun before choosing a threshold.';
  else if (!eligible.length)
    report.recommendationReason =
      'No candidate caught every labeled violation without false blocks. Include both labels; inspect the examples and clarify the rule or context.';
  else {
    report.recommendation = eligible[0].threshold;
    report.recommendationReason =
      'Caught all labeled violations with no false blocks; preferred more valid passes, then the highest threshold. This is a sample-based recommendation; verify held-out examples.';
  }
  return report;
}

export function formatCalibrationReport(report) {
  const lines = [
    `Calibration: ${report.ruleId} (${report.backend}); ${report.examples} examples × ${report.repeats} repeats per threshold`,
    'Threshold | Caught violations | False blocks | Valid passes | Incomplete (violation/valid) | Errors | Mean ms',
    ...report.summaries.map(
      (row) =>
        `${row.threshold.toFixed(2)} | ${row.caughtViolations}/${row.violationRuns} | ${row.falseBlocks}/${row.validRuns} | ${row.validPasses}/${row.validRuns} | ${row.incompleteViolations}/${row.incompleteValid} | ${row.operationalFailures} | ${row.meanElapsedMs}`,
    ),
    `Recommendation: ${report.recommendation ?? 'none'}. ${report.recommendationReason}`,
    'Incomplete checks permit hook commits but fail strict checks. No policy files were changed.',
    'Example results (confidence may include context expansion):',
    ...report.results.map(
      (run) =>
        `  ${JSON.stringify(run.example)} @ ${run.threshold}, run ${run.repetition}: ${run.status}; ${run.answers.map((answer) => `${answer.outcome} ${answer.confidence.toFixed(2)}${answer.complete ? '' : ' [partial]'}`).join(', ') || 'no judgments'}`,
    ),
  ];
  return lines.join('\n');
}
