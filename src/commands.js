import { ConfigurationError } from './policy.js';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { check, exitCode, formatReport } from './check.js';
import { calibrate, formatCalibrationReport } from './calibrate.js';
import {
  testRules,
  calibrateRules,
  exampleSuiteExitCode,
  formatExampleSuite,
} from './examples.js';
import { captureExample, saveCapturedExample } from './capture.js';
import { compareReports, formatComparison } from './compare.js';
import { createProgressReporter } from './presentation.js';

const HELP = `judgement check [--staged [--hook] | --base <commit> --head <commit>] [--verbose] [--no-progress] [--no-cache] [--timeout-ms <ms>] [--format json] [--dry-run] [--advisory]
Hooks allow incomplete checks after 3 seconds; strict checks exit 3. Progress goes to stderr.
judgement test [--rule <id>] [--examples-dir <path>] [--repeats 3] [--format json]
judgement calibrate (--rule <id> | --all) [--examples <path>] [--thresholds 0.75,0.8,0.85] [--format json]
judgement capture --rule <id> --path <file> --name <name> --expected pass|violation [--base <commit> --head <commit>] [--context <file>] [--output <new-file>]
Capture previews JSON from the index by default, with no inference. Review/redact before saving with --output. Never overwrites or stages files.
judgement compare --before <report.json> --after <report.json> [--before-threshold <n>] [--after-threshold <n>] [--format json]
Compare saved reports on identical fixtures; regressions exit 1. No inference calls.
All commands accept --cwd <directory>. Example commands read the working-tree policy; checks read the base policy.`;

/** Shared CLI for standalone use and hosts providing their own inference adapter. */
export async function runCli(args = process.argv.slice(2), options = {}) {
  const output = options.stdout ?? ((text) => process.stdout.write(text));
  const errorOutput = options.stderr ?? ((text) => process.stderr.write(text));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...Object.fromEntries(
        [
          'all',
          'staged',
          'hook',
          'advisory',
          'dry-run',
          'no-cache',
          'no-progress',
        ].map((key) => [key, { type: 'boolean' }]),
      ),
      ...Object.fromEntries(
        [
          'examples-dir',
          'rule',
          'examples',
          'repeats',
          'thresholds',
          'concurrency',
          'base',
          'head',
          'cwd',
          'format',
          'timeout-ms',
          'model',
          'path',
          'name',
          'expected',
          'output',
          'before',
          'after',
          'before-threshold',
          'after-threshold',
        ].map((key) => [key, { type: 'string' }]),
      ),
      context: { type: 'string', multiple: true },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    output(HELP + '\n');
    return 0;
  }
  const command = positionals[0] ?? 'check';
  const allowed = {
    check: [
      'staged',
      'hook',
      'advisory',
      'base',
      'head',
      'dry-run',
      'no-cache',
      'no-progress',
      'timeout-ms',
      'model',
      'verbose',
      'concurrency',
    ],
    test: [
      'rule',
      'examples',
      'examples-dir',
      'repeats',
      'concurrency',
      'timeout-ms',
      'model',
      'verbose',
      'dry-run',
    ],
    calibrate: [
      'all',
      'rule',
      'examples',
      'examples-dir',
      'repeats',
      'thresholds',
      'concurrency',
      'timeout-ms',
      'model',
      'verbose',
      'dry-run',
    ],
    capture: [
      'rule',
      'path',
      'name',
      'expected',
      'context',
      'output',
      'staged',
      'base',
      'head',
    ],
    compare: ['before', 'after', 'before-threshold', 'after-threshold'],
  };
  if (
    positionals.length > 1 ||
    !allowed[command] ||
    Object.keys(values).some(
      (key) => !['cwd', 'format', ...allowed[command]].includes(key),
    ) ||
    (values.format && !['text', 'json'].includes(values.format))
  )
    throw new ConfigurationError('Invalid command arguments. Use --help.');
  if (
    (values.staged && values.base) ||
    (values.head && !values.base) ||
    (values.hook && values.base)
  )
    throw new ConfigurationError('Invalid snapshot arguments.');
  if (values.model !== undefined && (options.evaluate || options.check))
    throw new ConfigurationError(
      'The host selects the inference model; --model requires the standalone evaluator.',
    );
  const cwd = resolve(values.cwd ?? options.cwd ?? process.cwd());
  if (command === 'compare') {
    if (!values.before || !values.after)
      throw new ConfigurationError(
        'Compare requires --before and --after reports.',
      );
    const before = JSON.parse(
      await readFile(resolve(cwd, values.before), 'utf8'),
    );
    const after = JSON.parse(
      await readFile(resolve(cwd, values.after), 'utf8'),
    );
    const report = compareReports(before, after, {
      beforeThreshold:
        values['before-threshold'] === undefined
          ? undefined
          : Number(values['before-threshold']),
      afterThreshold:
        values['after-threshold'] === undefined
          ? undefined
          : Number(values['after-threshold']),
    });
    output(
      (values.format === 'json'
        ? JSON.stringify(report)
        : formatComparison(report)) + '\n',
    );
    return report.regressions ? 1 : 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  let progress;
  try {
    const common = {
      cwd,
      signal: controller.signal,
      model: values.model,
      dryRun: values['dry-run'],
      concurrency:
        values.concurrency === undefined
          ? undefined
          : Number(values.concurrency),
      deadlineMs:
        values['timeout-ms'] === undefined
          ? undefined
          : Number(values['timeout-ms']),
      onDiagnostic: values.verbose
        ? (message) => errorOutput(`judgement: ${message}\n`)
        : undefined,
    };
    if (command === 'capture') {
      const fixture = await captureExample({
        cwd,
        signal: controller.signal,
        base: values.base,
        head: values.head,
        ruleId: values.rule,
        path: values.path,
        name: values.name,
        expected: values.expected,
        context: values.context,
      });
      if (values.output) {
        await saveCapturedExample(fixture, resolve(cwd, values.output));
        errorOutput(
          `Saved ${values.output}; not staged. Review and redact before committing.\n`,
        );
      }
      output(JSON.stringify(fixture, null, 2) + '\n');
      return 0;
    }
    if (command !== 'check') {
      if (
        (values.all && values.rule) ||
        (values.examples && values['examples-dir']) ||
        values.thresholds?.split(',').some((value) => !value.trim())
      )
        throw new ConfigurationError('Invalid example command arguments.');
      const suite = command === 'test' || values.all;
      if (values['examples-dir'] && !suite)
        throw new ConfigurationError(
          '--examples-dir requires test or calibrate --all.',
        );
      const run =
        command === 'test' ? testRules : suite ? calibrateRules : calibrate;
      const report = await run({
        ...common,
        evaluate: options.evaluate,
        ruleId: values.rule,
        examplesPath: values.examples,
        examplesDirectory: values['examples-dir'],
        repeats:
          values.repeats === undefined ? undefined : Number(values.repeats),
        thresholds: values.thresholds?.split(',').map(Number),
      });
      controller.signal.throwIfAborted();
      output(
        (values.format === 'json'
          ? JSON.stringify(report)
          : suite
            ? formatExampleSuite(report)
            : formatCalibrationReport(report)) + '\n',
      );
      return suite
        ? exampleSuiteExitCode(report)
        : report.dryRun || report.recommendation !== null
          ? 0
          : 3;
    }
    if (!values['no-progress'] && !values.verbose)
      progress = createProgressReporter({ write: errorOutput });
    const report = await (options.check ?? check)({
      ...common,
      evaluate: options.evaluate,
      base: values.base,
      head: values.head,
      hook: values.hook,
      cache: !values['no-cache'],
      onStatus: progress?.update,
    });
    controller.signal.throwIfAborted();
    progress?.stop();
    output(
      (values.format === 'json'
        ? JSON.stringify(report)
        : formatReport(report)) + '\n',
    );
    return values['dry-run'] && report.status !== 'invalid'
      ? 0
      : exitCode(report, values);
  } finally {
    progress?.stop();
    process.removeListener('SIGINT', interrupt);
  }
}
