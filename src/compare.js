import { ConfigurationError } from './policy.js';
import { terminalText } from './presentation.js';

const fail = (message) => {
  throw new ConfigurationError(message);
};
function index(report, threshold) {
  const reports = report?.reports ?? [report];
  if (!Array.isArray(reports) || !reports.length)
    fail('Expected a calibration or example-suite JSON report.');
  const rules = new Map();
  for (const item of reports) {
    if (
      !item ||
      typeof item.ruleId !== 'string' ||
      !Array.isArray(item.results) ||
      !item.results.length ||
      item.dryRun
    )
      fail('Comparison requires completed, non-dry-run reports.');
    if (rules.has(item.ruleId)) fail('Duplicate rule in comparison input.');
    const selected = threshold ?? item.configuredThreshold;
    if (!Number.isFinite(selected) || selected < 0 || selected > 1)
      fail('Comparison thresholds must be between 0 and 1.');
    const groups = new Map();
    for (const row of item.results.filter(
      (row) => row.threshold === selected,
    )) {
      if (
        typeof row.example !== 'string' ||
        !['pass', 'violation'].includes(row.expected) ||
        !['pass', 'violation', 'incomplete', 'invalid'].includes(row.status)
      )
        fail('Malformed calibration result.');
      let group = groups.get(row.example);
      if (!group) {
        group = {
          expected: row.expected,
          total: 0,
          correct: 0,
          violations: 0,
          incomplete: 0,
          failures: 0,
          probabilityMin: null,
          probabilityMax: null,
        };
        groups.set(row.example, group);
      }
      if (group.expected !== row.expected)
        fail('An example has conflicting expected labels.');
      group.total++;
      if (row.status === row.expected && !row.operationalFailure)
        group.correct++;
      if (row.status === 'violation') group.violations++;
      if (row.status === 'incomplete') group.incomplete++;
      if (row.operationalFailure || row.status === 'invalid') group.failures++;
      for (const answer of row.answers ?? []) {
        const probability = answer.violationProbability;
        if (probability !== undefined) {
          if (
            !Number.isFinite(probability) ||
            probability < 0 ||
            probability > 1
          )
            fail('Malformed violation probability.');
          group.probabilityMin = Math.min(
            group.probabilityMin ?? probability,
            probability,
          );
          group.probabilityMax = Math.max(
            group.probabilityMax ?? probability,
            probability,
          );
        }
      }
    }
    if (!groups.size)
      fail(
        `No runs for ${item.ruleId} at cutoff ${selected}. Choose a recorded threshold.`,
      );
    rules.set(item.ruleId, {
      threshold: selected,
      fixtureSha256: item.fixtureSha256 ?? report.fixtureSha256?.[item.ruleId],
      groups,
    });
  }
  return rules;
}

/** Compare saved reports without making inference calls or selecting a new policy. */
export function compareReports(before, after, options = {}) {
  const left = index(before, options.beforeThreshold),
    right = index(after, options.afterThreshold);
  const result = {
    status: 'pass',
    improvements: 0,
    regressions: 0,
    unchanged: 0,
    examples: [],
  };
  if (left.size !== right.size) fail('Reports must contain the same rules.');
  for (const [id, a] of left) {
    const b = right.get(id);
    if (!b) fail('Reports must contain the same rules.');
    if (!a.fixtureSha256 || !b.fixtureSha256)
      fail(
        'Fixture provenance is missing. Regenerate both reports with the current Judgement version.',
      );
    if (a.fixtureSha256 !== b.fixtureSha256)
      fail(
        `Examples changed for ${id}. Compare the same fixtures to measure a rule, prompt, or model change.`,
      );
    if (a.groups.size !== b.groups.size)
      fail('Reports must contain the same examples.');
    for (const [name, previous] of a.groups) {
      const current = b.groups.get(name);
      if (!current || previous.expected !== current.expected)
        fail('Reports must contain the same example names and labels.');
      const oldCorrect = previous.correct / previous.total,
        newCorrect = current.correct / current.total;
      // A new service failure is still a regression when both runs were already incorrect.
      const regression =
        newCorrect < oldCorrect ||
        current.failures / current.total > previous.failures / previous.total;
      const improvement =
        !regression &&
        (newCorrect > oldCorrect ||
          current.failures / current.total <
            previous.failures / previous.total);
      const change = regression
        ? 'regression'
        : improvement
          ? 'improvement'
          : 'unchanged';
      if (regression) {
        result.regressions++;
        result.status = 'regression';
      } else if (improvement) result.improvements++;
      else result.unchanged++;
      result.examples.push({
        ruleId: id,
        name,
        expected: previous.expected,
        change,
        beforeThreshold: a.threshold,
        afterThreshold: b.threshold,
        before: previous,
        after: current,
      });
    }
  }
  return result;
}

export function formatComparison(report) {
  const lines = [
    `judgement compare: ${report.improvements} improved, ${report.regressions} regressed, ${report.unchanged} unchanged`,
  ];
  for (const item of report.examples.filter(
    (row) => row.change !== 'unchanged',
  )) {
    const details = (run) =>
      `${run.correct}/${run.total} correct; ${run.incomplete} incomplete; ${run.failures} failures`;
    lines.push(
      `${item.change}: ${item.ruleId}: ${item.name} (expected ${item.expected})`,
      `  ${item.beforeThreshold}: ${details(item.before)} → ${item.afterThreshold}: ${details(item.after)}`,
    );
  }
  lines.push(
    'Compared observed success rates per example; repeated samples are not independent coverage.',
  );
  return lines.map(terminalText).join('\n');
}
