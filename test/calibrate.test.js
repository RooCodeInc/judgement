import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calibrate } from '../src/index.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const examples = [
  {
    name: 'capital',
    before: 'remaining checks\n',
    after: 'remaining Session checks\n',
    expected: 'violation',
  },
  {
    name: 'lowercase',
    before: 'remaining checks\n',
    after: 'remaining session checks\n',
    expected: 'pass',
  },
];
async function fixture(t, cases = examples, rule = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'calibration-input-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.judgement/examples'), { recursive: true });
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({
      criteria: [
        {
          id: 'wording',
          rule: 'Use lowercase session.',
          threshold: 0.96,
          ...rule,
        },
      ],
    }),
  );
  const path = join(cwd, '.judgement/examples/wording.json');
  await writeFile(path, JSON.stringify({ ruleId: 'wording', examples: cases }));
  return {
    cwd,
    path,
    run: (options = {}) =>
      calibrate({
        cwd,
        ruleId: 'wording',
        thresholds: [0.85, 0.96],
        repeats: 2,
        ...options,
      }),
  };
}
const judge = async (request) => ({
  outcome: request.evidence.some((part) =>
    part.text.includes('+remaining Session'),
  )
    ? 'violation'
    : 'pass',
  confidence: 0.91,
});

test('compares complete checks at each threshold, repeats without caching, and preserves the caller index', async (t) => {
  const f = await fixture(t);
  await exec('git', ['init', '-q'], { cwd: f.cwd });
  await exec('git', ['add', '.'], { cwd: f.cwd });
  const before = await readFile(join(f.cwd, '.git/index'));
  const policy = await readFile(join(f.cwd, '.judgement/rules.json'));
  let calls = 0;
  const report = await f.run({
    evaluate: async (request) => {
      calls++;
      return judge(request);
    },
  });
  assert.equal(report.recommendation, 0.85);
  assert.equal(report.results.length, 8);
  assert.equal(report.summaries[0].caughtViolations, 2);
  assert.equal(report.summaries[0].validPasses, 2);
  assert.equal(report.summaries[1].incompleteViolations, 2);
  assert.equal(calls, 12); // Four higher-threshold checks expand context.
  assert.deepEqual(await readFile(join(f.cwd, '.git/index')), before);
  assert.deepEqual(
    await readFile(join(f.cwd, '.judgement/rules.json')),
    policy,
  );
});

test('recommends nothing when every threshold falsely blocks valid changes', async (t) => {
  const f = await fixture(t);
  const report = await f.run({
    evaluate: async () => ({ outcome: 'violation', confidence: 1 }),
  });
  assert.equal(report.recommendation, null);
  assert(report.summaries.every((row) => row.falseBlocks === 2));
});

test('errors, missing labels and ignored cancellation do not yield a recommendation or late mutations', async (t) => {
  const f = await fixture(t, [examples[0]]);
  const oneLabel = await f.run({ evaluate: judge });
  assert.equal(oneLabel.recommendation, null);
  const failed = await f.run({
    evaluate: async () => {
      throw new Error('private backend error');
    },
  });
  assert.equal(failed.recommendation, null);
  assert.equal(failed.summaries[0].operationalFailures, 2);
  assert(!JSON.stringify(failed).includes('private backend error'));
  const late = await f.run({
    thresholds: [0.85],
    repeats: 1,
    deadlineMs: 100,
    evaluate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { outcome: 'violation', confidence: 1 };
    },
  });
  const snapshot = JSON.stringify(late);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(JSON.stringify(late), snapshot);
  assert.equal(late.recommendation, null);
});

test('uses explicit context, handles addition/deletion, and bounds model concurrency', async (t) => {
  const cases = [
    {
      name: 'addition',
      path: 'src/file.ts',
      before: null,
      after: 'operation();',
      expected: 'violation',
      context: { 'shared/helper.ts': 'guard();' },
    },
    {
      name: 'deletion',
      path: 'src/file.ts',
      before: 'operation();',
      after: null,
      expected: 'pass',
      context: { 'shared/helper.ts': 'guard();' },
    },
  ];
  const f = await fixture(t, cases, {
    files: ['src/**'],
    context: ['shared/**'],
  });
  let active = 0,
    peak = 0;
  const report = await f.run({
    concurrency: 1,
    thresholds: [0.85],
    evaluate: async (request) => {
      active++;
      peak = Math.max(peak, active);
      try {
        assert(
          request.evidence.some(
            (part) => part.kind === 'context' && part.text === 'guard();',
          ),
        );
        return {
          outcome: request.evidence.some((part) =>
            part.text.includes('new file mode'),
          )
            ? 'violation'
            : 'pass',
          confidence: 1,
        };
      } finally {
        active--;
      }
    },
  });
  assert.equal(peak, 1);
  assert.equal(report.recommendation, 0.85);
});

test('rejects unsafe or unrepresentative fixtures before making model requests', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return judge({ evidence: [] });
  };
  for (const path of [
    '../escape',
    '/absolute',
    '.git/config',
    '.GIT/config',
    '.judgement/rules.json',
    'a\\b',
    'CON',
    'a/../b',
  ]) {
    await writeFile(
      f.path,
      JSON.stringify({
        ruleId: 'wording',
        examples: [{ ...examples[0], path }],
      }),
    );
    await assert.rejects(f.run({ evaluate }), /safe relative path/);
  }
  await writeFile(
    f.path,
    JSON.stringify({
      ruleId: 'wording',
      examples: [{ ...examples[0], context: { 'example.md': 'collision' } }],
    }),
  );
  await assert.rejects(f.run({ evaluate }), /overlap/);
  await writeFile(
    f.path,
    JSON.stringify({
      ruleId: 'wording',
      examples: [{ ...examples[0], before: examples[0].after }],
    }),
  );
  await assert.rejects(f.run({ evaluate }), /different before/);
  assert.equal(calls, 0);
});

test('CLI plans canonical fixtures without credentials and separates diagnostics from JSON', async (t) => {
  const f = await fixture(t);
  const result = await exec(
    process.execPath,
    [
      cli,
      'calibrate',
      '--cwd',
      f.cwd,
      '--rule',
      'wording',
      '--thresholds',
      '0.85',
      '--repeats',
      '1',
      '--dry-run',
      '--verbose',
      '--format',
      'json',
    ],
    { env: { PATH: process.env.PATH } },
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.results.length, 2);
  assert.equal(report.recommendation, null);
  assert(report.results.every((run) => run.judgments === 0));
  assert.match(result.stderr, /cache disabled/);
  assert(!result.stdout.includes('remaining Session'));
});

test('ignores inherited Git index and worktree overrides', async (t) => {
  const f = await fixture(t);
  const index = join(f.cwd, 'sentinel');
  await writeFile(index, 'unchanged');
  await exec(
    process.execPath,
    [
      cli,
      'calibrate',
      '--cwd',
      f.cwd,
      '--rule',
      'wording',
      '--thresholds',
      '0.85',
      '--repeats',
      '1',
      '--dry-run',
      '--format',
      'json',
    ],
    {
      env: {
        PATH: process.env.PATH,
        GIT_INDEX_FILE: index,
        GIT_DIR: join(f.cwd, 'missing'),
        GIT_WORK_TREE: f.cwd,
      },
    },
  );
  assert.equal(await readFile(index, 'utf8'), 'unchanged');
});

test('chooses the highest threshold when detection and valid passes tie', async (t) => {
  const f = await fixture(t);
  const report = await f.run({
    repeats: 1,
    evaluate: async (request) => ({ ...(await judge(request)), confidence: 1 }),
  });
  assert.equal(report.recommendation, 0.96);
});

test('cancellation waits for workers and removes disposable repositories', async (t) => {
  const f = await fixture(t);
  const temporary = join(f.cwd, 'temporary');
  await mkdir(temporary);
  // Other test files also run calibrations. Isolate this invocation's temp root
  // in a child process so cleanup assertions cannot observe their repositories.
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { readdir } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import { calibrate } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
        const controller = new AbortController();
        let calls = 0;
        await assert.rejects(calibrate({
          cwd: process.argv[1],
          ruleId: 'wording',
          thresholds: [0.85, 0.96],
          repeats: 2,
          signal: controller.signal,
          evaluate: async () => {
            calls++;
            controller.abort();
            throw new Error('stop');
          },
        }));
        assert.ok(calls > 0, 'Cancellation must happen during evaluation');
        assert.deepEqual(await readdir(tmpdir()), []);
      `,
      f.cwd,
    ],
    {
      env: {
        ...process.env,
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
      },
    },
  );
  assert.deepEqual(await readdir(temporary), []);
});

test('missing policies and unmatched files fail before inference', async (t) => {
  const f = await fixture(t, examples, { files: ['src/**'] });
  await assert.rejects(f.run({ evaluate: judge }), /matching the rule/);
  await rm(join(f.cwd, '.judgement/rules.json'));
  await assert.rejects(f.run(), /No \.judgement\/rules.json policy found/);
});
