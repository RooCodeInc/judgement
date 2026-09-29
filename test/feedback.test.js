import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  captureExample,
  saveCapturedExample,
  compareReports,
  formatComparison,
  check,
  formatReport,
  createProgressReporter,
  runCli,
  testRules,
} from '../src/index.js';
const exec = promisify(execFile);
async function repo(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-feedback-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) =>
    (
      await exec(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgSign=false',
          ...args,
        ],
        {
          cwd,
        },
      )
    ).stdout;
  await git('init', '-q', '--template=');
  await git('config', 'user.name', 'Example');
  await git('config', 'user.email', 'example@example.invalid');
  await mkdir(join(cwd, '.judgement/examples'), { recursive: true });
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({
      criteria: [
        {
          id: 'wording',
          rule: 'Use lowercase nouns.',
          files: ['*.ts'],
          context: ['context.ts'],
          threshold: 0.75,
        },
      ],
    }),
  );
  await writeFile(join(cwd, 'file.ts'), 'before\n\n');
  await writeFile(join(cwd, 'context.ts'), 'context\n');
  await git('add', '.');
  await git('commit', '-qm', 'baseline');
  return { cwd, git };
}
const capture = {
  ruleId: 'wording',
  path: 'file.ts',
  name: 'Ordinary noun',
  expected: 'pass',
};

test('capture preserves staged bytes and context, previews without writing, and refuses overwrite', async (t) => {
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'file.ts'), 'staged\n\n');
  await git('add', 'file.ts');
  await writeFile(join(cwd, 'file.ts'), 'unstaged\n');
  const index = await git('diff', '--cached');
  const fixture = await captureExample({ cwd, ...capture });
  assert.equal(fixture.examples[0].before, 'before\n\n');
  assert.equal(fixture.examples[0].after, 'staged\n\n');
  assert.deepEqual(fixture.examples[0].context, { 'context.ts': 'context\n' });
  assert.equal(await git('diff', '--cached'), index);
  assert.equal(await readFile(join(cwd, 'file.ts'), 'utf8'), 'unstaged\n');
  let stdout = '';
  await runCli(
    [
      'capture',
      '--rule',
      'wording',
      '--path',
      'file.ts',
      '--name',
      'preview',
      '--expected',
      'pass',
    ],
    { cwd, stdout: (s) => (stdout += s) },
  );
  assert.equal(JSON.parse(stdout).examples[0].after, 'staged\n\n');
  const file = join(cwd, '.judgement/examples/wording.json');
  await saveCapturedExample(fixture, file);
  await assert.rejects(saveCapturedExample(fixture, file), { code: 'EEXIST' });
  const report = await testRules({
    cwd,
    ruleId: 'wording',
    repeats: 1,
    evaluate: async () => ({ violationProbability: 0.01 }),
  });
  assert.equal(report.status, 'pass');
  assert.match(report.reports[0].fixtureSha256, /^[0-9a-f]{64}$/);
});

test('capture handles additions and deletions and refuses changed support, binary and symlink evidence', async (t) => {
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'new.ts'), 'new\n');
  await git('add', 'new.ts');
  let f = await captureExample({ cwd, ...capture, path: 'new.ts' });
  assert.equal(f.examples[0].before, null);
  await rm(join(cwd, 'file.ts'));
  await git('add', 'file.ts');
  f = await captureExample({ cwd, ...capture });
  assert.equal(f.examples[0].after, null);
  await writeFile(join(cwd, 'context.ts'), 'changed\n');
  await git('add', 'context.ts');
  await assert.rejects(captureExample({ cwd, ...capture }), /context changed/);
  await git('reset', '-q', 'HEAD', 'context.ts');
  await writeFile(join(cwd, 'new.ts'), Buffer.from([0, 1, 2]));
  await git('add', 'new.ts');
  await assert.rejects(
    captureExample({ cwd, ...capture, path: 'new.ts' }),
    /binary/,
  );
  await rm(join(cwd, 'new.ts'));
  await symlink('context.ts', join(cwd, 'new.ts'));
  await git('add', 'new.ts');
  await assert.rejects(
    captureExample({ cwd, ...capture, path: 'new.ts' }),
    /regular text/,
  );
});

function report(rows, extras = {}) {
  return {
    ruleId: 'r',
    fixtureSha256: 'same',
    configuredThreshold: 0.75,
    dryRun: false,
    results: rows.map(
      ([example, expected, status, p, operationalFailure = false]) => ({
        example,
        expected,
        status,
        threshold: 0.75,
        repetition: 1,
        answers: [{ violationProbability: p }],
        operationalFailure,
      }),
    ),
    ...extras,
  };
}
test('comparison exposes regressions despite net improvement and rejects changed fixtures', () => {
  const before = report([
    ['a', 'pass', 'violation', 0.8],
    ['b', 'violation', 'pass', 0.6],
    ['c', 'violation', 'violation', 0.9],
  ]);
  const after = report([
    ['a', 'pass', 'pass', 0.1],
    ['b', 'violation', 'violation', 0.9],
    ['c', 'violation', 'pass', 0.6],
  ]);
  const c = compareReports(before, after);
  assert.equal(c.improvements, 2);
  assert.equal(c.regressions, 1);
  assert.equal(c.status, 'regression');
  assert.match(formatComparison(c), /regression: r: c/);
  assert.throws(
    () => compareReports(before, { ...after, fixtureSha256: 'different' }),
    /Examples changed/,
  );
  assert.throws(
    () => compareReports({ ...before, fixtureSha256: undefined }, after),
    /provenance/,
  );
  assert.throws(
    () => compareReports({ ...before, dryRun: true }, after),
    /non-dry-run/,
  );
  assert.throws(
    () => compareReports(before, after, { afterThreshold: 0.9 }),
    /No runs/,
  );
});
test('comparison normalizes unequal repetitions and counts failed inference as regression', () => {
  const before = report([['a', 'pass', 'pass', 0.1]]);
  const after = report([
    ['a', 'pass', 'pass', 0.1],
    ['a', 'pass', 'pass', 0.2],
  ]);
  assert.equal(compareReports(before, after).unchanged, 1);
  const failed = report([['a', 'pass', 'incomplete', 0.1, true]]);
  assert.equal(compareReports(before, failed).regressions, 1);
});

test('findings show cutoff and actual changed-line coordinates, with cached results and safe progress', async (t) => {
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'file.ts'), 'changed\n\n');
  await git('add', 'file.ts');
  let calls = 0;
  const events = [];
  const options = {
    cwd,
    cacheIdentity: 'fixture',
    evaluate: async () => {
      calls++;
      return { violationProbability: 0.9 };
    },
    onStatus: (e) => events.push(e),
  };
  const first = await check(options);
  const second = await check(options);
  assert.equal(calls, 1);
  assert.equal(second.coverage.cached, 1);
  assert.equal(first.rules[0].threshold, 0.75);
  assert.deepEqual(
    first.rules[0].findings[0].changes.map((c) => [c.side, c.line, c.text]),
    [
      ['before', 1, 'before'],
      ['after', 1, 'changed'],
    ],
  );
  assert.match(formatReport(first), /cutoff 0.75/);
  assert.match(formatReport(first), /file.ts:1 \[after\] \+changed/);
  assert.match(formatReport(first), /not individual lines/);
  assert.ok(events.some((e) => e.cached === 1));
  assert.ok(events.some((e) => e.rulesFinished === 1));
  assert.equal(
    (
      await check({
        ...options,
        onStatus: () => {
          throw Error('display');
        },
      })
    ).status,
    'violation',
  );
});

test('delayed progress stays on stderr and stops after completion', async () => {
  const messages = [];
  const reporter = createProgressReporter({
    write: (s) => messages.push(s),
    delayMs: 30,
    intervalMs: 30,
  });
  reporter.update({
    files: 4,
    rulesTotal: 2,
    rulesFinished: 0,
    judged: 0,
    cached: 0,
    elapsedMs: 0,
  });
  assert.equal(messages.length, 0);
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(messages.length > 0);
  reporter.stop();
  const count = messages.length;
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(messages.length, count);
  let out = '',
    err = '';
  const code = await runCli(['check', '--format', 'json'], {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    check: async (options) => {
      options.onStatus({
        files: 10,
        rulesTotal: 2,
        rulesFinished: 0,
        judged: 0,
        cached: 0,
        elapsedMs: 0,
      });
      await new Promise((r) => setTimeout(r, 800));
      return {
        status: 'incomplete',
        rules: [],
        coverage: { judged: 0, cached: 0 },
        messages: [],
        elapsedMs: 800,
      };
    },
  });
  assert.equal(code, 3);
  assert.equal(JSON.parse(out).status, 'incomplete');
  assert.match(err, /10 files/);
});

test('CLI rejects cross-command flags and compare returns regression exit status', async (t) => {
  const { cwd } = await repo(t);
  await assert.rejects(runCli(['capture', '--hook'], { cwd }), /Invalid/);
  await writeFile(
    join(cwd, 'before.json'),
    JSON.stringify(report([['a', 'pass', 'pass', 0.1]])),
  );
  await writeFile(
    join(cwd, 'after.json'),
    JSON.stringify(report([['a', 'pass', 'violation', 0.9]])),
  );
  let out = '';
  assert.equal(
    await runCli(
      [
        'compare',
        '--before',
        'before.json',
        '--after',
        'after.json',
        '--format',
        'json',
      ],
      { cwd, stdout: (s) => (out += s) },
    ),
    1,
  );
  assert.equal(JSON.parse(out).regressions, 1);
});

test('capture supports committed changes and comparison honors selected recorded cutoffs', async (t) => {
  const { cwd, git } = await repo(t);
  const base = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(join(cwd, 'file.ts'), 'committed\n');
  await git('add', 'file.ts');
  await git('commit', '-qm', 'change');
  await writeFile(join(cwd, 'file.ts'), 'unstaged\n');
  const fixture = await captureExample({ cwd, ...capture, base, head: 'HEAD' });
  assert.equal(fixture.examples[0].after, 'committed\n');
  const runs = report([['a', 'violation', 'violation', 0.8]]);
  runs.results.push({ ...runs.results[0], threshold: 0.9, status: 'pass' });
  assert.equal(
    compareReports(runs, runs, { afterThreshold: 0.9 }).regressions,
    1,
  );
  await assert.rejects(
    runCli(['test', '--model', 'different'], {
      evaluate: async () => ({ violationProbability: 0 }),
    }),
    /host selects/,
  );
});
