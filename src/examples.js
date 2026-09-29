import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  calibrate,
  examplesFrom,
  safePath,
  formatCalibrationReport,
} from './calibrate.js';
import { ConfigurationError, readPolicy, POLICY_PATH } from './policy.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');

async function runExamples(options, mode) {
  if (mode === 'test' && options.thresholds !== undefined)
    throw new ConfigurationError(
      'Tests use configured thresholds. Use calibrate to compare candidates.',
    );
  const policy = await readPolicy(options.cwd ?? process.cwd());
  const rules = policy.criteria.filter(
    (rule) => !options.ruleId || rule.id === options.ruleId,
  );
  if (!rules.length) throw new ConfigurationError('No matching rules.');
  if (options.examplesPath && rules.length !== 1)
    throw new ConfigurationError(
      'An explicit examples file requires a single rule.',
    );
  const directory = resolve(
    options.cwd ?? '.',
    options.examplesDirectory ?? '.judgement/examples',
  );
  // Snapshot and validate every selected fixture before any inference requests.
  const fixtures = await Promise.all(
    rules.map(async (rule) => {
      if (
        !options.examplesPath &&
        (!safePath(`${rule.id}.json`) || rule.id.includes('/'))
      )
        throw new ConfigurationError(
          'This rule ID needs an explicit examples path.',
        );
      const path = options.examplesPath
        ? resolve(options.cwd ?? '.', options.examplesPath)
        : join(directory, `${rule.id}.json`);
      let text, value;
      try {
        text = await readFile(path, 'utf8');
        value = JSON.parse(text);
      } catch {
        throw new ConfigurationError(
          `Cannot read examples JSON for ${rule.id}.`,
        );
      }
      examplesFrom(value, rule);
      return { rule, text };
    }),
  );
  const policyText = JSON.stringify(policy);
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-examples-'));
  const reports = [];
  try {
    await mkdir(join(cwd, '.judgement'));
    await writeFile(join(cwd, POLICY_PATH), policyText);
    for (const [index, { rule, text }] of fixtures.entries()) {
      options.signal?.throwIfAborted();
      const examplesPath = join(cwd, `fixture-${index}.json`);
      await writeFile(examplesPath, text);
      reports.push(
        await calibrate({
          ...options,
          cwd,
          ruleId: rule.id,
          examplesPath,
          thresholds: mode === 'test' ? [rule.threshold] : options.thresholds,
        }),
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  const passed =
    mode === 'test'
      ? reports.every((report) =>
          report.results.every(
            (run) => !run.operationalFailure && run.status === run.expected,
          ),
        )
      : reports.every((report) => report.recommendation !== null);
  return {
    mode,
    status: options.dryRun ? 'dry-run' : passed ? 'pass' : 'fail',
    policySha256: hash(policyText),
    fixtureSha256: Object.fromEntries(
      fixtures.map(({ rule, text }) => [rule.id, hash(text)]),
    ),
    reports,
  };
}

export const testRules = (options = {}) => runExamples(options, 'test');
export const calibrateRules = (options = {}) =>
  runExamples(options, 'calibrate');
export function exampleSuiteExitCode(report) {
  return report.status !== 'fail' ? 0 : report.mode === 'test' ? 1 : 3;
}
export function formatExampleSuite(report) {
  return [
    `judgement ${report.mode}: ${report.status} (${report.reports.length} rules)`,
    ...report.reports.map((result) => {
      const text = formatCalibrationReport(result);
      return report.mode === 'test'
        ? text
            .replace(/^Calibration:/, 'Examples:')
            .split('\n')
            .filter((line) => !line.startsWith('Recommendation:'))
            .join('\n')
        : text;
    }),
  ].join('\n\n');
}
