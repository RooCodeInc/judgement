import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  testRules,
  calibrateRules,
  exampleSuiteExitCode,
} from '../src/index.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'example-suite-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.judgement/examples'), { recursive: true });
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({
      criteria: [
        { id: 'first', rule: 'Reject forbidden.', threshold: 0.8 },
        { id: 'second', rule: 'Reject forbidden.', threshold: 0.95 },
      ],
    }),
  );
  for (const ruleId of ['first', 'second'])
    await writeFile(
      join(cwd, `.judgement/examples/${ruleId}.json`),
      JSON.stringify({
        ruleId,
        examples: [
          {
            name: 'bad',
            before: 'old',
            after: 'forbidden',
            expected: 'violation',
          },
          { name: 'good', before: 'old', after: 'allowed', expected: 'pass' },
        ],
      }),
    );
  return cwd;
}
const evaluate = async (request) => ({
  outcome: request.evidence.some((part) => part.text.includes('forbidden'))
    ? 'violation'
    : 'pass',
  confidence: 0.9,
});

test('test uses each configured threshold; calibration compares candidates across rules', async (t) => {
  const cwd = await fixture(t);
  const report = await testRules({ cwd, repeats: 1, evaluate });
  assert.equal(report.reports.length, 2);
  assert.equal(report.status, 'fail');
  assert.equal(exampleSuiteExitCode(report), 1);
  assert.equal(report.reports[0].results[0].status, 'violation');
  assert(report.reports[1].results.every((run) => run.status === 'incomplete'));
  assert.match(report.policySha256, /^[a-f0-9]{64}$/);
  const sweep = await calibrateRules({
    cwd,
    repeats: 1,
    thresholds: [0.8, 0.95],
    evaluate,
  });
  assert.equal(sweep.status, 'pass');
  assert.equal(exampleSuiteExitCode(sweep), 0);
  assert(sweep.reports.every((report) => report.recommendation === 0.8));
  await assert.rejects(
    testRules({ cwd, thresholds: [0.8] }),
    /configured thresholds/,
  );
});

test('missing or invalid later fixtures fail before any model requests', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, '.judgement/examples/second.json'), '{}');
  let calls = 0;
  await assert.rejects(
    testRules({
      cwd,
      evaluate: async () => {
        calls++;
        return { outcome: 'pass', confidence: 1 };
      },
    }),
  );
  assert.equal(calls, 0);
});

test('suite snapshots later fixtures before starting inference', async (t) => {
  const cwd = await fixture(t);
  let changed = false;
  const report = await testRules({
    cwd,
    repeats: 1,
    evaluate: async (request) => {
      if (!changed) {
        changed = true;
        await writeFile(
          join(cwd, '.judgement/examples/second.json'),
          'invalid replacement',
        );
      }
      return evaluate(request);
    },
  });
  assert.equal(report.reports.length, 2);
  assert.equal(report.reports[1].examples, 2);
});

test('CLI test and calibration --all support JSON dry runs without credentials', async (t) => {
  const cwd = await fixture(t);
  for (const args of [['test'], ['calibrate', '--all']]) {
    const { stdout } = await exec(process.execPath, [
      cli,
      ...args,
      '--cwd',
      cwd,
      '--dry-run',
      '--repeats',
      '1',
      '--format',
      'json',
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.status, 'dry-run');
    assert.equal(report.reports.length, 2);
    assert(
      report.reports.every((report) =>
        report.results.every((run) => run.judgments === 0),
      ),
    );
  }
});
