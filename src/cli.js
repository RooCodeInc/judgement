#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { check, exitCode, formatReport } from './index.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      staged: { type: 'boolean' },
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
      'judgement check [--staged [--hook] | --base <commit> --head <commit>] [--dry-run] [--format json] [--timeout-ms <ms>] [--no-cache] [--advisory]\nReads JUDGE.json from the base tree. Hooks allow incomplete checks after 3 seconds; strict checks exit 3.',
    );
  } else {
    if (
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
  process.exitCode = 2;
}
