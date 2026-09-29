import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createJevEvaluator, validateAnswer } from '../src/index.js';

test('direct transport sends typed questions and validates the service answer', async (t) => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.headers.authorization, 'Bearer fake-key');
    assert.equal(body.questions.result.type, 'noul');
    assert.equal(body.model, 'jev-1.13.0');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        answers: {
          result: { type: 'noul', noul: 0.01 },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const evaluate = createJevEvaluator({
    apiKey: 'fake-key',
    endpoint: `http://127.0.0.1:${server.address().port}`,
  });
  const answer = await evaluate(
    {
      kind: 'judge',
      rule: 'Owners only',
      evidence: [],
      focusPaths: [],
      complete: true,
      unresolved: [],
    },
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(answer, { violationProbability: 0.01 });
});

test('normalizes finite Noul probabilities without inventing confidence', () => {
  for (const probability of [0, 0.5, 1]) {
    assert.deepEqual(validateAnswer({ type: 'noul', noul: probability }), {
      violationProbability: probability,
    });
    assert.deepEqual(validateAnswer({ violationProbability: probability }), {
      violationProbability: probability,
    });
  }
  for (const probability of [
    null,
    undefined,
    -0.1,
    1.1,
    NaN,
    Infinity,
    '0.9',
  ]) {
    assert.throws(() => validateAnswer({ noul: probability }), /Invalid/);
  }
});
