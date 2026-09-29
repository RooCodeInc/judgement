import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createJevEvaluator } from '../src/index.js';

test('direct transport sends typed questions and validates the service answer', async (t) => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.headers.authorization, 'Bearer fake-key');
    assert.equal(body.questions.result.type, 'choice');
    assert.equal(body.model, 'jev-1.13.0');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        answers: {
          result: { type: 'choice', choice: 'pass', confidence: 0.99 },
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
  assert.deepEqual(answer, { outcome: 'pass', confidence: 0.99 });
});
