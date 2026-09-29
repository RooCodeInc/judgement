import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareExamples, calibrate, question } from '../src/index.js';

test('prepares the exact initial and expanded checker requests without labels in model input', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-prepare-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.judgement/examples'), { recursive: true });
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({
      criteria: [
        { id: 'wording', rule: 'Use lowercase session.', threshold: 0.85 },
      ],
    }),
  );
  const path = join(cwd, '.judgement/examples/wording.json');
  const text = JSON.stringify({
    ruleId: 'wording',
    examples: [
      {
        name: 'capital',
        before: 'old',
        after: 'new Session',
        expected: 'violation',
      },
    ],
  });
  await writeFile(path, text);
  const prepared = await prepareExamples({ cwd });
  const actual = [];
  await calibrate({
    cwd,
    ruleId: 'wording',
    repeats: 1,
    thresholds: [0.85],
    evaluate: async (request) => {
      actual.push(request);
      return { outcome: 'unclear', confidence: 1 };
    },
  });
  assert.deepEqual(
    prepared.examples[0].packets.map((p) => p.state),
    actual,
  );
  assert.deepEqual(
    prepared.examples[0].packets.map((p) => p.stage),
    ['initial', 'expanded'],
  );
  for (const packet of prepared.examples[0].packets) {
    assert.equal(packet.state.expected, undefined);
    assert.deepEqual(packet.questions, { result: question(packet.state) });
  }
  assert.equal(prepared.examples[0].expected, 'violation');
  assert.equal(await readFile(path, 'utf8'), text);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(prepareExamples({ cwd, signal: aborted.signal }), {
    name: 'AbortError',
  });
});

test('the model asks for the probability of a violation', () => {
  const request = {
    kind: 'judge',
    rule: 'rule',
    evidence: [],
    focusPaths: [],
    complete: true,
    unresolved: [],
  };
  const result = question(request);
  assert.equal(result.type, 'noul');
  assert.deepEqual(Object.keys(result.criteria), ['true', 'false']);
  assert.match(result.criteria.false, /stated exceptions/);
});
