import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  check,
  exitCode,
  parsePolicy,
  createJevEvaluator,
} from '../src/index.js';
const exec = promisify(execFile);
const pass = async () => ({ outcome: 'pass', confidence: 0.99 });
const bad = async () => ({ outcome: 'violation', confidence: 0.99 });
const rule = { rule: 'Every billing operation must emit its own audit event.' };
async function repo(t, criteria = [rule], initial = true) {
  const root = await mkdtemp(join(tmpdir(), 'judgement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.com'], {
    cwd: root,
  });
  const put = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const git = (...args) => exec('git', args, { cwd: root });
  if (criteria)
    await put('.judgement/rules.json', JSON.stringify({ criteria }));
  await put('billing.js', 'original\n');
  if (initial) {
    await git('add', '.');
    await git('commit', '-qm', 'initial');
  }
  return {
    root,
    put,
    git,
    run: (options) =>
      check({ cwd: root, cache: false, evaluate: pass, ...options }),
  };
}

test('reads staged content and excludes unstaged fixes', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'BAD staged\n');
  await r.git('add', '.');
  await r.put('billing.js', 'GOOD unstaged\n');
  const report = await r.run({
    evaluate: async (request) => {
      const content = request.evidence
        .filter((p) => p.kind === 'patch')
        .map((p) => p.text)
        .join('');
      assert.match(content, /BAD staged/);
      assert.doesNotMatch(content, /GOOD unstaged/);
      return bad();
    },
  });
  assert.equal(report.status, 'violation');
  assert.equal(exitCode(report, { hook: true }), 1);
});

test('an unstaged violation does not contaminate the staged snapshot', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'GOOD staged\n');
  await r.git('add', '.');
  await r.put('billing.js', 'BAD unstaged\n');
  assert.equal(
    (
      await r.run({
        evaluate: async (request) => {
          assert.doesNotMatch(JSON.stringify(request), /BAD unstaged/);
          return pass();
        },
      })
    ).status,
    'pass',
  );
});

test('each changed file receives explicitly selected supporting context', async (t) => {
  const r = await repo(t, [{ ...rule, context: ['audit.js'] }]);
  await r.put('audit.js', 'export const record = () => auditEvent();\n');
  await r.git('add', '.');
  await r.git('commit', '-qm', 'helper');
  await r.put(
    'billing.js',
    'import { record } from "./audit.js";\nfunction charge() { mutate(); record(); }\n',
  );
  await r.put('other.js', 'second billing operation\n');
  await r.git('add', '.');
  let calls = 0;
  const result = await r.run({
    evaluate: async (request) => {
      calls++;
      assert.equal(request.focusPaths.length, 1);
      assert(['billing.js', 'other.js'].includes(request.focusPaths[0]));
      assert(
        request.evidence.some(
          (part) => part.path === 'audit.js' && part.kind === 'context',
        ),
      );
      return pass();
    },
  });
  assert.equal(result.status, 'pass');
  assert.equal(calls, 2);
});

test('policy edits do not weaken their own check and are never restored', async (t) => {
  const r = await repo(t);
  const updated = JSON.stringify({ criteria: [{ rule: 'A weaker rule.' }] });
  await r.put('.judgement/rules.json', updated);
  await r.put('billing.js', 'changed\n');
  await r.git('add', '.');
  await r.run({
    evaluate: async (request) => {
      assert.equal(request.rule, rule.rule);
      return pass();
    },
  });
  assert.equal(
    await readFile(join(r.root, '.judgement/rules.json'), 'utf8'),
    updated,
  );
});

test('bootstrap policy and initial commits work', async (t) => {
  const r = await repo(t, [rule], false);
  await r.git('add', '.');
  const report = await r.run();
  assert.equal(report.status, 'pass');
  assert.equal(report.policySource, 'proposed');
});

test('absent and invalid policies have distinct outcomes', async (t) => {
  const r = await repo(t, null);
  assert.equal((await r.run()).status, 'pass');
  await r.put('.judgement/rules.json', '{oops');
  await r.git('add', '.');
  const report = await r.run();
  assert.equal(report.status, 'invalid');
  assert.equal(exitCode(report, { hook: true }), 2);
});

test('deleted files are judged; binary changes are explicitly incomplete', async (t) => {
  const r = await repo(t);
  await r.git('rm', 'billing.js');
  const deletion = await r.run({
    evaluate: async (request) => {
      assert.match(JSON.stringify(request.evidence), /original/);
      return bad();
    },
  });
  assert.equal(deletion.status, 'violation');
  await r.git('reset', '--hard', 'HEAD');
  await r.put('image.bin', Buffer.from([1, 0, 2]));
  await r.git('add', '.');
  const binary = await r.run();
  assert.equal(binary.status, 'incomplete');
  assert.deepEqual(binary.coverage.unsupported, ['image.bin']);
});

test('large file visits its middle and cannot pass from partial screens', async (t) => {
  const r = await repo(t);
  const content =
    'prefix\n'.repeat(9000) + 'VIOLATION_IN_MIDDLE\n' + 'suffix\n'.repeat(9000);
  await r.put('billing.js', content);
  await r.git('add', '.');
  let middle = false;
  const report = await r.run({
    evaluate: async (request) => {
      if (JSON.stringify(request.evidence).includes('VIOLATION_IN_MIDDLE')) {
        middle = true;
        return bad();
      }
      return pass();
    },
  });
  assert(middle);
  assert.equal(report.status, 'violation');
  const clean = await r.run({
    evaluate: pass,
  });
  assert.equal(clean.status, 'incomplete');
});

test('file checks evaluate every changed file without losing the final violation', async (t) => {
  const r = await repo(t);
  for (let i = 0; i < 6; i++)
    await r.put(`file${i}.js`, 'large changed content\n'.repeat(150));
  await r.git('add', '.');
  const seen = new Set();
  const report = await r.run({
    evaluate: async (request) => {
      request.focusPaths.forEach((path) => seen.add(path));
      return request.focusPaths.includes('file5.js') ? bad() : pass();
    },
  });
  assert.equal(seen.size, 6);
  assert.equal(report.status, 'violation');
});

test('deadline preserves findings and returns even if an evaluator ignores cancellation', async (t) => {
  const r = await repo(t, [
    { id: 'bad', rule: 'bad' },
    { id: 'hang', rule: 'hang' },
  ]);
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  const start = performance.now();
  const report = await r.run({
    deadlineMs: 300,
    evaluate: async (request) =>
      request.rule === 'bad' ? bad() : new Promise(() => {}),
  });
  assert(performance.now() - start < 650);
  assert.equal(report.status, 'violation');
  assert.match(report.messages.join(' '), /deadline/);
});

test('failure in another rule never erases a violation', async (t) => {
  const r = await repo(t, [{ rule: 'bad' }, { rule: 'error' }]);
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  const report = await r.run({
    evaluate: async (request) => {
      if (request.rule === 'bad') return bad();
      throw new Error('offline');
    },
  });
  assert.equal(report.status, 'violation');
  assert(report.rules.some((rule) => rule.status === 'incomplete'));
});

test('index changes invalidate a clean judgment', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'first');
  await r.git('add', '.');
  const report = await r.run({
    evaluate: async () => {
      await r.put('billing.js', 'second');
      await r.git('add', '.');
      return pass();
    },
  });
  assert.equal(report.status, 'incomplete');
  assert.match(report.messages.join(' '), /Git changed/);
});

test('caches exact evidence and invalidates when unchanged context changes', async (t) => {
  const r = await repo(t, [{ ...rule, context: ['audit.js'] }]);
  await r.put('audit.js', 'old helper');
  await r.git('add', '.');
  await r.git('commit', '-qm', 'helper');
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  let calls = 0;
  const options = {
    cache: true,
    cacheIdentity: 'test:v1',
    evaluate: async () => {
      calls++;
      return pass();
    },
  };
  await r.run(options);
  const cached = await r.run(options);
  assert.equal(calls, 1);
  assert.equal(cached.coverage.cached, 1);
  await r.put('audit.js', 'new helper');
  await r.git('add', '.');
  await r.run(options);
  assert.equal(calls, 3);
});

test('respects alternate index and unusual filenames', async (t) => {
  const r = await repo(t);
  const index = join(r.root, '.git', 'alternate-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  await exec('git', ['read-tree', 'HEAD'], { cwd: r.root, env });
  await r.put('file with\nnewline.js', 'changed');
  await exec('git', ['add', '.'], { cwd: r.root, env });
  const report = await r.run({ env });
  assert.equal(report.coverage.files, 1);
  assert.equal(report.status, 'pass');
  assert.equal((await r.run()).coverage.files, 0);
});

test('strict base/head mode reviews committed changes; missing bases do not pass', async (t) => {
  const r = await repo(t);
  const base = (await r.git('rev-parse', 'HEAD')).stdout.trim();
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  await r.git('commit', '-qm', 'change');
  assert.equal(
    (await r.run({ base, head: 'HEAD', evaluate: bad })).status,
    'violation',
  );
  assert.equal((await r.run({ base: 'does-not-exist' })).status, 'incomplete');
});

test('validates policies and API answers', async () => {
  assert.throws(() =>
    parsePolicy('{"criteria":[{"rule":"hi","context":["../secret"]}]}'),
  );
  assert.throws(() =>
    parsePolicy('{"criteria":[{"rule":"hi","unknown":true}]}'),
  );
  await assert.rejects(
    createJevEvaluator({ apiKey: '' })({
      kind: 'judge',
      rule: 'hello',
      evidence: [],
      focusPaths: [],
      complete: true,
      unresolved: [],
    }),
    /API key/,
  );
});

test('an orphan branch with other refs can bootstrap a policy', async (t) => {
  const r = await repo(t);
  await r.git('checkout', '--orphan', 'new-root');
  assert.equal((await r.run()).status, 'pass');
});

test('missing explicitly required context cannot produce a pass', async (t) => {
  const r = await repo(t, [{ ...rule, context: ['missing.ts'] }]);
  await r.put('billing.js', 'change');
  await r.git('add', '.');
  assert.equal((await r.run()).status, 'incomplete');
});

test('large commits bound model concurrency and keep every file obligation', async (t) => {
  const r = await repo(t);
  for (let i = 0; i < 24; i++) await r.put(`part-${i}.js`, 'changed\n');
  await r.git('add', '.');
  let active = 0,
    peak = 0;
  const seen = new Set();
  const report = await r.run({
    concurrency: 3,
    evaluate: async (request) => {
      active++;
      peak = Math.max(peak, active);
      request.focusPaths.forEach((path) => seen.add(path));
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return pass();
    },
  });
  assert.equal(report.status, 'pass');
  assert.equal(seen.size, 24);
  assert(peak <= 3);
  assert(peak > 1);
});

test('explicit context comes from the index, including partially staged helpers', async (t) => {
  const r = await repo(t, [
    { ...rule, files: ['billing.js'], context: ['audit.js'] },
  ]);
  await r.put('billing.js', 'changed');
  await r.put('audit.js', 'STAGED_HELPER');
  await r.git('add', '.');
  await r.put('audit.js', 'UNSTAGED_HELPER');
  const result = await r.run({
    evaluate: async (request) => {
      assert.match(JSON.stringify(request.evidence), /STAGED_HELPER/);
      assert.doesNotMatch(JSON.stringify(request.evidence), /UNSTAGED_HELPER/);
      return pass();
    },
  });
  assert.equal(result.status, 'pass');
});

test('running from a subdirectory still checks the repository policy and all staged paths', async (t) => {
  const r = await repo(t);
  await r.put('nested/example.js', 'nested change');
  await r.put('billing.js', 'root change');
  await r.git('add', '.');
  const report = await r.run({ cwd: join(r.root, 'nested'), evaluate: bad });
  assert.equal(report.status, 'violation');
  assert.equal(report.rules[0].findings.length, 2);
});

test('verbose CLI keeps JSON output separate and does not expose source contents', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'PRIVATE_SOURCE_MARKER');
  await r.git('add', '.');
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const { stdout, stderr } = await exec(
    process.execPath,
    [cli, 'check', '--staged', '--dry-run', '--verbose', '--format', 'json'],
    { cwd: r.root },
  );
  assert.equal(JSON.parse(stdout).status, 'incomplete');
  assert.match(stderr, /snapshot: 1 changed files/);
  assert.match(stderr, /criterion_1/);
  assert.match(stderr, /billing.js/);
  assert.match(stderr, /dry run:/);
  assert.doesNotMatch(stderr, /PRIVATE_SOURCE_MARKER/);
  const quiet = await exec(
    process.execPath,
    [cli, 'check', '--staged', '--dry-run'],
    { cwd: r.root },
  );
  assert.equal(quiet.stderr, '');
});

test('diagnostics report model answers and cache hits without changing results', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  const messages = [];
  const options = {
    cache: true,
    cacheIdentity: 'verbose-test',
    evaluate: pass,
    onDiagnostic: (message) => messages.push(message),
  };
  assert.equal((await r.run(options)).status, 'pass');
  assert(messages.some((message) => message.includes('answer:')));
  messages.length = 0;
  assert.equal((await r.run(options)).status, 'pass');
  assert(messages.some((message) => message.includes('cache hit:')));
  assert.equal(
    (
      await r.run({
        onDiagnostic: () => {
          throw new Error('broken logger');
        },
      })
    ).status,
    'pass',
  );
});

test('broad rules include staged files and context in hidden directories', async (t) => {
  const r = await repo(t, [
    { ...rule, files: ['**/*'], context: ['.support/**/*'] },
  ]);
  await r.put('.support/conventions.md', 'SUPPORTING_CONTEXT');
  await r.git('add', '.');
  await r.git('commit', '-qm', 'context');
  await r.put('.agents/skills/example/SKILL.md', 'changed');
  await r.git('add', '.');
  const seen = [];
  const report = await r.run({
    evaluate: async (request) => {
      seen.push(...request.focusPaths);
      assert(
        request.evidence.some(
          (part) => part.path === '.support/conventions.md',
        ),
      );
      return bad();
    },
  });
  assert.deepEqual(seen, ['.agents/skills/example/SKILL.md']);
  assert.equal(report.status, 'violation');
});

test('small edit to a large file uses all diff hunks without the whole file', async (t) => {
  const r = await repo(t);
  const lines = Array.from({ length: 5000 }, (_, i) => `unchanged line ${i}\n`);
  await r.put('billing.js', lines.join(''));
  await r.git('add', '.');
  await r.git('commit', '-qm', 'large baseline');
  lines[1000] = 'first edit\n';
  lines[4000] = 'second edit\n';
  await r.put('billing.js', lines.join(''));
  await r.git('add', '.');
  let calls = 0;
  const report = await r.run({
    evaluate: async (request) => {
      calls++;
      assert(request.complete);
      assert(request.evidence.every((part) => part.kind === 'patch'));
      const text = JSON.stringify(request);
      assert.match(text, /first edit/);
      assert.match(text, /second edit/);
      assert(Buffer.byteLength(text) < 5000);
      return pass();
    },
  });
  assert.equal(report.status, 'pass');
  assert.equal(calls, 1);
});

test('uncertain diff expands to the staged file and can complete', async (t) => {
  const r = await repo(t);
  await r.put('billing.js', 'guard();\n' + 'context\n'.repeat(60) + 'old();\n');
  await r.git('add', '.');
  await r.git('commit', '-qm', 'baseline');
  await r.put(
    'billing.js',
    'guard();\n' + 'context\n'.repeat(60) + 'newOperation();\n',
  );
  await r.git('add', '.');
  await r.put('billing.js', 'unstaged content must not be used');
  let calls = 0;
  const report = await r.run({
    evaluate: async (request) => {
      calls++;
      if (calls === 1) {
        assert.doesNotMatch(JSON.stringify(request), /guard\(\)/);
        return { outcome: 'unclear', confidence: 0.99 };
      }
      assert(
        request.evidence.some(
          (part) => part.kind === 'after' && part.text.includes('guard();'),
        ),
      );
      assert.doesNotMatch(JSON.stringify(request), /unstaged content/);
      return pass();
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.status, 'pass');
});

test('large-file uncertainty widens context once and remains incomplete if unresolved', async (t) => {
  const r = await repo(t);
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`);
  await r.put('billing.js', lines.join(''));
  await r.git('add', '.');
  await r.git('commit', '-qm', 'baseline');
  lines[2500] = 'edit\n';
  await r.put('billing.js', lines.join(''));
  await r.git('add', '.');
  const sizes = [];
  const report = await r.run({
    evaluate: async (request) => {
      sizes.push(JSON.stringify(request).length);
      assert(request.complete);
      assert(request.evidence.every((part) => part.kind === 'patch'));
      return { outcome: 'unclear', confidence: 0.99 };
    },
  });
  assert.equal(sizes.length, 2);
  assert(sizes[1] > sizes[0]);
  assert.equal(report.status, 'incomplete');
});

test('policy edits still enforce the base rule', async (t) => {
  const r = await repo(t);
  await r.put(
    '.judgement/rules.json',
    JSON.stringify({ criteria: [{ rule: 'weaker replacement' }] }),
  );
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  const edited = await r.run({
    evaluate: async (request) => {
      assert.equal(request.rule, rule.rule);
      assert.deepEqual(request.focusPaths, ['billing.js']);
      return bad();
    },
  });
  assert.equal(edited.status, 'violation');
  await r.git('commit', '-qm', 'update policy');
  await r.put('billing.js', 'changed again');
  await r.git('add', '.');
  const canonical = await r.run({
    evaluate: async (request) => {
      assert.equal(request.rule, 'weaker replacement');
      return pass();
    },
  });
  assert.equal(canonical.status, 'pass');
});

test('nonregular policies are invalid', async (t) => {
  const r = await repo(t);
  await r.git('rm', '.judgement/rules.json');
  await r.put('.judgement/rules.json/nested', 'not a policy');
  await r.git('add', '.');
  assert.equal((await r.run()).status, 'invalid');
});

test('saved counterexamples do not trigger normal rule checks', async (t) => {
  const r = await repo(t);
  await r.put('.judgement/examples/wording.json', 'intentional violation');
  await r.git('add', '.');
  let calls = 0;
  const report = await r.run({
    evaluate: async () => {
      calls++;
      return bad();
    },
  });
  assert.equal(report.status, 'pass');
  assert.equal(calls, 0);
});

test('binary judgments use one inclusive threshold and do not expand scores below it', async (t) => {
  const r = await repo(t, [{ ...rule, threshold: 0.85 }]);
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  for (const probability of [0, 0.5, 0.849, 0.85, 1]) {
    let calls = 0;
    const messages = [];
    const result = await r.run({
      evaluate: async () => {
        calls++;
        return { violationProbability: probability };
      },
      onDiagnostic: (message) => messages.push(message),
    });
    assert.equal(result.status, probability >= 0.85 ? 'violation' : 'pass');
    assert.equal(calls, 1);
    assert(
      messages.some((message) => message.includes('violation probability')),
    );
  }
  const options = {
    cache: true,
    cacheIdentity: 'binary-test',
    evaluate: async () => ({ violationProbability: 0.5 }),
  };
  await r.run(options);
  assert.equal((await r.run(options)).coverage.cached, 1);
});

test('binary scores cannot approve missing context, unsupported files, partial screens or failed requests', async (t) => {
  const missing = await repo(t, [{ ...rule, context: ['missing.js'] }]);
  await missing.put('billing.js', 'changed');
  await missing.git('add', '.');
  assert.equal(
    (await missing.run({ evaluate: async () => ({ violationProbability: 0 }) }))
      .status,
    'incomplete',
  );

  const r = await repo(t);
  await r.put('billing.js', 'x'.repeat(60_000));
  await r.git('add', '.');
  const partial = await r.run({
    evaluate: async (request) => {
      assert.equal(request.complete, false);
      return { violationProbability: 0 };
    },
  });
  assert.equal(partial.status, 'incomplete');
  assert.equal(
    (await r.run({ evaluate: async () => ({ violationProbability: 1 }) }))
      .status,
    'violation',
  );
  await r.put('billing.js', Buffer.from([0, 1, 2]));
  await r.git('add', '.');
  assert.equal(
    (await r.run({ evaluate: async () => ({ violationProbability: 0 }) }))
      .status,
    'incomplete',
  );
  await r.put('billing.js', 'changed');
  await r.git('add', '.');
  assert.equal(
    (
      await r.run({
        evaluate: async () => {
          throw new Error('unavailable');
        },
      })
    ).status,
    'incomplete',
  );
  assert.equal(
    (
      await r.run({
        deadlineMs: 200,
        evaluate: async () => new Promise(() => {}),
      })
    ).status,
    'incomplete',
  );
});
