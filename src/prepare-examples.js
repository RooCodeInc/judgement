import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExampleInputs } from './examples.js';
import { calibrate } from './calibrate.js';
import { question, PROTOCOL_VERSION } from './model.js';
import { POLICY_PATH, ConfigurationError } from './policy.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');

/** Prepare exact checker requests for inspection, without calling an inference backend. */
export async function prepareExamples(options = {}) {
  const { policy, fixtures } = await loadExampleInputs(options);
  const policyText = JSON.stringify(policy);
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-prepare-'));
  const examples = [];
  try {
    await mkdir(join(cwd, '.judgement'));
    await writeFile(join(cwd, POLICY_PATH), policyText);
    for (const { rule, text } of fixtures) {
      for (const example of JSON.parse(text).examples) {
        options.signal?.throwIfAborted();
        const requests = [];
        const examplesPath = join(cwd, 'fixture.json');
        await writeFile(
          examplesPath,
          JSON.stringify({ ruleId: rule.id, examples: [example] }),
        );
        const report = await calibrate({
          cwd,
          ruleId: rule.id,
          examplesPath,
          repeats: 1,
          thresholds: [rule.threshold],
          concurrency: 1,
          deadlineMs: options.deadlineMs ?? 30_000,
          signal: options.signal,
          evaluate: async (request) => {
            requests.push(structuredClone(request));
            // Use the custom-evaluator expansion path to offer more context for inspection.
            return { outcome: 'unclear', confidence: 1 };
          },
        });
        if (
          !requests.length ||
          report.results.some((run) => run.operationalFailure)
        )
          throw new ConfigurationError(
            `Cannot prepare requests for ${rule.id}: ${example.name}. Check context and the preparation deadline.`,
          );
        examples.push({
          ruleId: rule.id,
          rule: rule.rule,
          threshold: rule.threshold,
          name: example.name,
          expected: example.expected,
          packets: requests.map((state, index) => ({
            stage: !state.complete
              ? 'screen'
              : index === 0
                ? 'initial'
                : 'expanded',
            state,
            questions: { result: question(state) },
          })),
        });
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    policySha256: hash(policyText),
    fixtureSha256: Object.fromEntries(
      fixtures.map(({ rule, text }) => [rule.id, hash(text)]),
    ),
    examples,
  };
}
