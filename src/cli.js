#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  check,
  exitCode,
  formatReport,
  calibrate,
  formatCalibrationReport,
  testRules,
  calibrateRules,
  exampleSuiteExitCode,
  formatExampleSuite,
} from './index.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      'examples-dir': { type: 'string' },
      rule: { type: 'string' },
      examples: { type: 'string' },
      repeats: { type: 'string' },
      thresholds: { type: 'string' },
      concurrency: { type: 'string' },
      staged: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      hook: { type: 'boolean' },
      advisory: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' },
      cwd: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      format: { type: 'string' },
      'timeout-ms': { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'judgement check [--staged [--hook] | --base <commit> --head <commit>] [--dry-run] [--format json] [--timeout-ms <ms>] [--no-cache] [--advisory] [--verbose]\nReads .judgement/rules.json from the base tree. Hooks allow incomplete checks after 3 seconds; strict checks exit 3.\njudgement test [--rule <id>] [--examples-dir <path>] [--repeats 3] [--dry-run] [--format json]\njudgement calibrate (--rule <id> | --all) [--examples <path>] [--repeats 3] [--thresholds 0.8,0.85,0.9,0.95] [--concurrency 2] [--timeout-ms 3000] [--dry-run] [--format json] [--verbose]\nCalibration reads the working-tree policy and .judgement/examples/<id>.json; it never edits your policy or index.',
    );
  } else if (['calibrate', 'test'].includes(positionals[0])) {
    if (
      positionals.length !== 1 ||
      values.staged ||
      values.base ||
      values.head ||
      values.hook ||
      values.advisory ||
      (values.all && values.rule) ||
      (values.examples && values['examples-dir']) ||
      (positionals[0] === 'test' && values.thresholds !== undefined) ||
      (values.format && !['json', 'text'].includes(values.format))
    )
      throw new Error('Invalid calibration arguments. Use --help.');
    if (values.thresholds?.split(',').some((value) => !value.trim()))
      throw new Error('Thresholds must be comma-separated numbers.');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    const suite = positionals[0] === 'test' || values.all;
    const run =
      positionals[0] === 'test'
        ? testRules
        : values.all
          ? calibrateRules
          : calibrate;
    if (values['examples-dir'] && !suite)
      throw new Error('--examples-dir requires test or calibrate --all.');
    let report;
    try {
      report = await run({
        examplesDirectory: values['examples-dir'],
        signal: controller.signal,
        cwd: values.cwd,
        ruleId: values.rule,
        examplesPath: values.examples,
        repeats:
          values.repeats === undefined ? undefined : Number(values.repeats),
        thresholds: values.thresholds?.split(',').map(Number),
        concurrency:
          values.concurrency === undefined
            ? undefined
            : Number(values.concurrency),
        deadlineMs:
          values['timeout-ms'] === undefined
            ? undefined
            : Number(values['timeout-ms']),
        model: values.model,
        dryRun: values['dry-run'],
        onDiagnostic: values.verbose
          ? (message) => console.error(`judgement: ${message}`)
          : undefined,
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
    }
    console.log(
      values.format === 'json'
        ? JSON.stringify(report)
        : suite
          ? formatExampleSuite(report)
          : formatCalibrationReport(report),
    );
    process.exitCode = suite
      ? exampleSuiteExitCode(report)
      : report.dryRun || report.recommendation !== null
        ? 0
        : 3;
  } else {
    if (
      values.all ||
      values['examples-dir'] ||
      values.rule ||
      values.examples ||
      values.repeats ||
      values.thresholds ||
      values.concurrency ||
      positionals.length > 1 ||
      (positionals[0] && positionals[0] !== 'check') ||
      (values.staged && values.base) ||
      (values.head && !values.base) ||
      (values.hook && values.base) ||
      (values.format && !['json', 'text'].includes(values.format))
    )
      throw new Error('Invalid arguments. Use --help.');
    const report = await check({
      cwd: values.cwd,
      onDiagnostic: values.verbose
        ? (message) => console.error(`judgement: ${message}`)
        : undefined,
      base: values.base,
      head: values.head,
      hook: values.hook,
      dryRun: values['dry-run'],
      cache: !values['no-cache'],
      model: values.model,
      deadlineMs:
        values['timeout-ms'] === undefined
          ? undefined
          : Number(values['timeout-ms']),
    });
    console.log(
      values.format === 'json' ? JSON.stringify(report) : formatReport(report),
    );
    process.exitCode =
      values['dry-run'] && report.status !== 'invalid'
        ? 0
        : exitCode(report, { hook: values.hook, advisory: values.advisory });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.name === 'AbortError' ? 130 : 2;
}
