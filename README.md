# Judgement

Check code changes against your team's business rules, written in plain language.

```json
{
  "criteria": [
    {
      "id": "billing-audit",
      "rule": "Every billing operation must record an audit event for that same operation.",
      "files": ["src/billing/**"],
      "context": ["src/audit/**", "src/auth/**"]
    },
    {
      "id": "payment-owner",
      "rule": "Only workspace owners may change payment settings."
    }
  ]
}
```

Save this as `.judgement/rules.json` in your repository. Run Judgement before a commit
or in CI. It uses [Jev](https://typesafe.ai) to make focused judgments and reads
related source files from the exact Git snapshot being checked.

## Agent instructions

Coding agents: read [the agent guide](docs/agents.md) before adding or tuning rules.
It is included in the npm package and covers fixtures, commands, uncertainty, and
validation. Projects should keep their rules and examples, not copy the runner.

## Install

Node 22.20+ or 24+ and Git are required. Glob matching uses the small `picomatch` dependency.
Install the published package from npm.

```sh
npm install --save-dev --save-exact @roo-code/judgement@0.3.0
export TYPESAFE_API_KEY=...
./node_modules/.bin/judgement check --staged
```

Pin the installed version. Do not download a package at commit time.

## Fast local checks

Add this after your formatting commands in `.husky/pre-commit` or an existing
Git hook:

```sh
./node_modules/.bin/judgement check --staged --hook
```

Hook mode has a **three-second execution budget**. It blocks a confirmed
violation or invalid configuration. If time expires, the model is unavailable,
or evidence is insufficient, it reports **incomplete** and allows the commit.
It never presents an unfinished review as a pass. Process startup and operating
system scheduling add overhead; use the benchmark to measure your environment.

A required CI check must finish that work before merging. Judgement does not
schedule a background check or configure branch protection for you.

For the [pre-commit framework](https://pre-commit.com), use this repository's
`.pre-commit-hooks.yaml` with `rev: v0.1.5` and hook `id: judgement`.

## CI and strict checks

```sh
judgement check --base origin/main --head HEAD
judgement check --staged --format json
judgement check --staged --dry-run
judgement check --staged --no-cache
judgement check --staged --verbose
```

`--base` is an exact base revision, not an implicit merge-base operation. For a
PR, resolve the merge base explicitly and pass its SHA. Checkout full history.
Use policy from a trusted base and provide the API key through CI secrets.
Run untrusted contributions without write-capable repository tokens.

| Exit | Strict check                               | `--hook`                            |
| ---- | ------------------------------------------ | ----------------------------------- |
| 0    | Completed without a blocking finding       | Completed or explicitly incomplete  |
| 1    | Confirmed violation                        | Confirmed violation                 |
| 2    | Invalid configuration or invocation        | Invalid configuration or invocation |
| 3    | Incomplete, uncertain, service/Git failure | Reported, commit allowed            |

`--advisory` reports all outcomes without blocking. `--timeout-ms` changes the
budget (strict mode defaults to 120 seconds). Use JSON `status` to distinguish
incomplete hook runs from completed ones. `--dry-run` sends no model requests.

`--verbose` (or `-v`) streams file/rule progress, request sizes, cache hits,
model answers, and timings to stderr. It does not print source contents or
credentials. JSON reports remain on stdout. Model answers are intermediate;
the final report applies violation-probability thresholds and coverage requirements.

## Rules

`criteria` is a non-empty array. Each criterion accepts:

- `rule`: required natural-language requirement.
- `id`: optional unique identifier for reports.
- `files`: optional repository-relative globs selecting changes that activate
  the rule. Other files can still be supporting evidence.
- `context`: optional repository-relative globs adding supporting source files from the proposed snapshot.
- `threshold`: violation-probability cutoff between 0 and 1; defaults to 0.85.
  A score at or above it flags a violation. A score below it does not flag one.

Globs use `picomatch` syntax and include dotfiles and hidden directories. Bare names also match path components;
trailing `/` selects a directory. Absolute paths, `..`, negation, and backslashes
are rejected. This is a small declarative configuration, never executable code.

Existing policy comes from the base tree. If no policy exists there, a newly
staged policy can bootstrap checking. Editing or deleting a policy does not
weaken the check for the same commit. Judgement never rewrites your policy.

## Project layout

```text
.judgement/
  rules.json
  examples/
    wording.json
    billing-audit.json
```

Give each rule a stable `id`. Calibration uses that ID to find its examples.
Policy files and `.judgement/examples/` are excluded from normal rule checks, so
labeled counterexamples do not trigger your commit hook.
Save rules in `.judgement/rules.json`. File and context globs are relative to the
repository root.

## Test all rules

```sh
judgement test --dry-run
judgement test --rule wording --repeats 3
judgement test --format json > /tmp/judgement-tests.json
judgement calibrate --all --format json > /tmp/judgement-calibration.json
```

`test` uses configured thresholds; a wrong, incomplete, or failed judgment exits

1. Dry runs and suites whose results all match their labels exit 0. Setup errors
   exit 2. `calibrate --all` compares candidates for every rule and exits 3 if any rule
   has no recommendation. Both commands require examples for every selected rule;
   missing or invalid examples fail before inference. Use `--examples-dir <path>` for
   a separate suite. Rules run sequentially, with bounded fixture concurrency within
   each rule. JSON suite reports include hashes of the normalized policy and exact
   fixture text used. Keep generated output local or in CI artifacts.

The library exposes `testRules(options)`, `calibrateRules(options)`,
`formatExampleSuite(report)`, and `exampleSuiteExitCode(report)`. Options include
an optional `ruleId` (omitting it selects all rules), `examplesDirectory`, and the
same custom `evaluate` callback used by `calibrate`. `testRules` always uses the
configured thresholds. This keeps project-specific inference adapters small.

## Calibration command

Save labeled examples in `.judgement/examples/wording.json` for a rule whose
`id` is `wording`:

```json
{
  "ruleId": "wording",
  "examples": [
    {
      "name": "Mid-sentence capital",
      "path": "docs/guide.md",
      "before": "Review the remaining checks.\n",
      "after": "Review the remaining Session checks.\n",
      "expected": "violation"
    },
    {
      "name": "Sentence beginning",
      "path": "docs/guide.md",
      "before": "History is available.\n",
      "after": "Session history is available.\n",
      "expected": "pass"
    }
  ]
}
```

Each example has a unique name and different `before`/`after` text. Use `null`
for the absent side of an addition or deletion. `path` defaults to `example.md`
and must match the rule's `files`. Optional `context` maps relative paths to
unchanged supporting file contents; the rule's `context` globs select which
ones the checker sees. Paths cannot escape the fixture or replace its policy
or Git metadata. Label valid exceptions and inapplicable changes as `pass`.

```sh
judgement calibrate --rule wording --dry-run
judgement calibrate --rule wording --repeats 3 --thresholds 0.8,0.85,0.9,0.96
judgement calibrate --rule wording --format json > calibration.json
```

The command reads your **working-tree policy**, then commits each candidate
policy in a disposable Git repository and stages its example there. Your real
policy, working tree, and index remain untouched. Checks use the full evaluator,
including context expansion, with caching disabled. Calibration is opt-in and
is never run by a commit hook. Real runs make paid model requests.

Defaults: three repetitions, two concurrent fixture checks, a three-second
per-check deadline, and thresholds `0.8`, `0.85`, `0.9`, `0.95`, plus the rule's
current threshold. Use `--examples <path>` to select a different examples file,
`--concurrency <1–8>` to limit parallel checks, `--timeout-ms <ms>` to match your
check budget, and `--verbose` for progress on stderr. JSON remains on stdout.

The report includes per-example answers and scores, caught violations, false
blocks, incorrect passes, incomplete results, failures, and timing. It recommends
only candidates that caught every labeled violation with zero false blocks,
provided there were no operational failures anywhere in the run. Among those
candidates it prefers more valid passes, then the highest threshold. A dataset
must contain both labels to receive a recommendation. An incomplete valid case
can remain even at the recommended threshold; inspect those rows before adopting
it. Nothing automatically rewrites your policy.

Calibration exits `0` when a candidate is recommended (or for a dry run), `3`
when none can be recommended, and `2` for invalid configuration or fixture setup.
Unlike `check`, an expected violation is a successful calibration observation.
Use a held-out examples file to verify the selected threshold before saving it.

Applications with their own inference configuration can use the same library
harness and supply their existing evaluator:

```js
import { calibrate, formatCalibrationReport } from '@roo-code/judgement';

const report = await calibrate({
  cwd: process.cwd(),
  ruleId: 'wording',
  evaluate: yourExistingEvaluator,
});
console.log(formatCalibrationReport(report));
```

The [wording example](examples/wording/.judgement/) includes a policy and fixtures.

## Inspect example requests

Use `prepareExamples` to load labeled fixtures into a model tester:

```js
import { prepareExamples } from '@roo-code/judgement';

const prepared = await prepareExamples({
  cwd: process.cwd(),
  ruleId: 'wording',
});
const example = prepared.examples[0];
const packet = example.packets[0];
// Send only packet.state and packet.questions to your inference backend.
console.log(example.name, example.expected, example.threshold, packet.stage);
```

Preparation uses disposable Git repositories and the checker's evidence planner.
It makes no inference calls and leaves the real index untouched. Packets include
initial evidence, expanded evidence for manual inspection, and partial screens
where needed. The default binary evaluator uses the initial packet; it does not
expand evidence merely because a probability is near the cutoff. Expected labels remain outside model inputs. The output
includes policy and fixture hashes for detecting stale presets. Options include
`ruleId`, `examplesPath`, `examplesDirectory`, `deadlineMs` (30 seconds per example),
and `signal`.

Replay packets to inspect violation probabilities and latency.
A packet answer is not a full check result: partial screens cannot approve a file,
and unresolved context still prevents approval. Testers with longer timeouts also
do not establish hook performance. Confirm improvements through `testRules` or
`calibrate`, with held-out examples and the production deadline.

The model answers one boolean question: do the changed lines need correction to
satisfy the rule? A yes means a changed passage violates a requirement.
TypeSafe's [Noul primitive](https://docs.typesafe.ai/primitives/noul) returns the
probability of yes, without a separate confidence score. Judgement flags a violation
at or above the rule's threshold. Every lower score, including 0.5, produces no
finding. Missing required context, unsupported or partial evidence, and request
failures still make the check incomplete. A completed check with no findings is
reported as `pass`; this is not a guarantee that the changes contain no violations.

## Calibrating a rule's violation cutoff

Choose a cutoff from labeled examples of your rule. A higher cutoff requires
stronger evidence to flag a violation; it can also miss more real violations.
The default `0.85` is a starting point. Recalibrate when changing the question,
primitive, or model: a Choice confidence cutoff does not transfer to a Noul
probability cutoff.

1. **Build a small labeled set before looking at scores.** Include clear
   violations, valid changes, and valid exceptions that resemble violations.
   For a capitalization rule, test mid-sentence capitals, sentence beginnings,
   headings, quoted UI labels, code identifiers, fixes to existing violations,
   and unrelated edits near old violations. Include realistic file paths,
   surrounding context, and small edits to large files. Reserve some examples
   to validate your choice after tuning.
2. **Use an isolated test repository for each candidate policy.** Commit the
   candidate `.judgement/rules.json` as the baseline, then stage a representative change.
   Merely editing or staging a new threshold in an existing repository will
   still evaluate against its base policy. Do not overwrite your real staged
   work to run calibration fixtures. Isolating one rule also makes its results
   easier to interpret.
3. **Run through the same backend and model used by your hook.** For the
   standalone CLI, inspect the plan and then collect real scores:

   ```sh
   judgement check --staged --dry-run --verbose
   judgement check --staged --verbose --no-cache
   judgement check --staged --hook --verbose --no-cache
   ```

   A dry run checks evidence planning without inference. Repeat real evaluations
   several times per example, such as three to five runs, with caching disabled.
   When Judgement is embedded in an application, use its evaluator and settings
   rather than accidentally testing a different standalone backend. Record the
   backend/model version, outcomes, violation probabilities, final statuses, and time.
   Avoid concurrent checks against the same index; use separate fixtures or
   run their repetitions sequentially.

4. **Compare candidate thresholds.** Count violations that would block, valid
   changes that would incorrectly block, and incomplete checks in each group.
   Also track outright incorrect passes. A valid change reported as incomplete
   is not a successful pass: hook mode permits it, but strict mode blocks it.
   Likewise, an incomplete violation is a missed block in hook mode.
5. **Verify the chosen threshold through the full checker.** Raw probabilities are useful for comparing cutoffs. Repeat the full check
   to verify behavior on actual evidence and measure variation. Check final reports, held-out
   examples, and hook deadlines before adopting it. Recalibrate after changing
   the rule wording, evidence selection, model, or backend.

For binary answers, flag only when `violationProbability >= threshold`. Lowering
the cutoff can recover missed violations but may introduce false blocks. It cannot
fix unavailable inference or missing required evidence. If valid and violating
examples have overlapping scores, clarify the rule or improve the evidence before
selecting a cutoff. Report any rule without positive examples as uncalibrated for
detection; valid examples alone do not establish recall.

## Evidence and large changes

Judgement snapshots the index with `git write-tree`, including temporary indexes
used by `git commit -a` and path commits. It reads staged blobs rather than their
working-tree counterparts, preserving partially staged work. The final index is
checked again before a clean result is accepted.

Each matching changed file is evaluated independently with the supporting files
selected by `context`. Write localized rules: UI wording, use of a shared
component, or a guard around an operation in that file. Supply the helper or
convention file explicitly when the rule needs it. Repository-wide inventories,
uniqueness, parity, and aggregate rules are outside v1's supported scope; the
single-file evidence cannot establish those guarantees.

Checks start with every diff hunk and 12 nearby unchanged lines, plus explicit
`context` files. The default binary judgment makes one request for this packet.
A below-threshold score completes without a finding. Supply required supporting
files through `context`; the model cannot request missing semantic context with a
separate answer. `prepareExamples` also provides expanded packets for inspection.
Custom outcome/confidence evaluators can request one expansion by returning
`unclear` or a below-threshold confidence. Expansion includes the full staged file
when it fits, or 80 lines around every hunk, within the same execution deadline.

Large commits run file checks in parallel with bounded concurrency. Oversized
diffs or explicit context are screened in bounded chunks. Every text chunk is visited in a
completed run; the middle is never discarded. Partial screens can identify a
direct violation but **cannot approve the full file**. Evidence that cannot fit
together remains incomplete, even when all of its screens return pass.

There is no automatic import traversal, repository search, or hierarchical
summarization in v1. Context selection stays explicit and predictable. Missing
context patterns make a check incomplete. Model judgments remain probabilistic;
a localized rule can still require more evidence than the supplied files.

Renames are represented as deletion plus addition. Deleted text is included in
patches. Binary files, symlinks, and submodules are reported as unsupported when
an applicable rule needs them. No silent approval of unsupported content.

Raw judgments are cached in Git metadata by model/backend identity, rule,
algorithm version, exact evidence, and the changed file’s before/after blob identities. Planning runs again on every snapshot;
unresolved context also depends on the tree identity. Incomplete answers and
service failures are not cached as approvals. Use `--no-cache` in required CI if
cache provenance is not trusted.

## Library and custom backends

```js
import { check, exitCode, formatReport } from '@roo-code/judgement';

const report = await check({ cwd: process.cwd(), hook: true });
console.log(formatReport(report));
process.exitCode = exitCode(report, { hook: true });
```

An `evaluate(request, signal)` function can supply another transport. It returns
`{ violationProbability }`, a finite number between 0 and 1. Use exported `question(request)` to retain the same
rubric, honor the AbortSignal, and set a stable `cacheIdentity` that changes with
the model/backend configuration. Custom evaluators have caching disabled unless
an identity is supplied. Type declarations ship with the package. Custom evaluators returning
`{ outcome, confidence }` retain their existing confidence and uncertainty semantics.

`installGitHook({ cwd, command })` is available for managed runtimes. It stores
wrappers in Git metadata, runs the original pre-commit hook first, and preserves
other hook paths. Reinstalling is idempotent. Package managers that subsequently
change `core.hooksPath` require reinstallation. Existing hooks remain untouched;
restore the `previousHooksPath` returned by installation (or unset the local
setting if it was null) to remove the wrapper.

## With Danger

[Danger](https://danger.systems/js/) inspired the idea of repository-owned review
rules and actionable contributor feedback. Existing Danger pipelines can consume
Judgement's library report:

```js
import { fail, warn } from 'danger';
import { check, formatReport } from '@roo-code/judgement';

if (!process.env.REVIEW_BASE)
  throw new Error('Set REVIEW_BASE to the trusted base SHA');
const report = await check({
  base: process.env.REVIEW_BASE,
  head: 'HEAD',
  cache: false,
});
if (report.status === 'violation' || report.status === 'invalid')
  fail(formatReport(report));
else if (report.status === 'incomplete') warn(formatReport(report));
```

Choose whether incomplete results should block in your own Danger policy. The
standalone strict CLI blocks them by default. Judgement itself does not post PR
comments or request repository write access.

## Development and evaluation

```sh
npm test
npm run benchmark
npm pack --dry-run
```

Tests use real temporary Git repositories and injected model answers. They verify
snapshot handling, context collection, coverage, aggregation, deadlines, caches,
and real hooks. They do not establish the model's semantic accuracy.

The benchmark reports cached/no-change overhead with no paid API calls. The
engineering targets are under 300 ms for warm/no-op runs and under two seconds
for ordinary model-backed runs; the latter requires measurement on your own
network and rules. Broad business-rule reliability has not yet been calibrated.
Use advisory mode on a labeled sample before enforcing a rule.

## Inspiration

- [Danger](https://danger.systems/): project-owned review rules and contributor feedback.
- [jev-commit](https://github.com/valentynkit/jev-commit): staged Git handling and hunk batching.
- [jev-lint](https://github.com/mizchi/jev-lint): caching, calibration, and hook integration.

This implementation is independently written. MIT licensed.

## Inspect a finding

Text reports show the rule, violation probability, cutoff, and a bounded preview
of changed lines with before/after line numbers. The model judges an evidence
packet; the preview does not claim to identify the exact offending line. JSON
reports include the same preview and indicate omitted or truncated lines.

Checks show delayed progress on stderr, including checked packets and cache hits.
Use `--no-progress` for quiet output or `--verbose` for individual requests. JSON
stays on stdout. Progress makes no inference calls and does not extend the hook
budget. Cached answers are reused only for matching evidence, rule, model/backend
identity, and protocol. Custom evaluators must supply a stable `cacheIdentity` to
opt into caching; hosts with mutable inference settings may leave it disabled.

## Turn a mistake into an example

Preview an incorrectly blocked edit (`pass`) or a missed violation (`violation`):

```sh
judgement capture --rule wording --path docs/guide.md \
  --name "Quoted UI label" --expected pass
```

Capture reads the index against HEAD, including unchanged supporting files named
by the rule's context globs. It does not read unstaged changes or call the model.
Use `--base <commit> --head <commit>` for committed changes and repeat
`--context <path>` to include additional unchanged supporting files.

Review and redact the preview, then save a new fixture file:

```sh
judgement capture --rule wording --path docs/guide.md \
  --name "Quoted UI label" --expected pass \
  --output .judgement/examples/quoted-label.json
judgement test --rule wording --examples .judgement/examples/quoted-label.json
```

`--output` refuses to overwrite existing files and never stages anything. If the
preview contains sensitive values, save the preview to a local scratch file and
replace them with synthetic values before adding it to the repository. The fixture
can be tested independently with `--examples` or its example merged into the
rule's main fixture file. Multi-file changes need reduction to a single changed
file with unchanged supporting context. Binary files, symlinks, and captures above
256 KB are rejected instead of producing misleading fixtures.

## Compare calibration runs

Keep the fixtures fixed while changing a rule, prompt, model, or cutoff:

```sh
mkdir -p .judgement/results
judgement test --format json > .judgement/results/before.json
# Make the candidate change, then rerun the same examples.
judgement test --format json > .judgement/results/after.json
judgement compare --before .judgement/results/before.json \
  --after .judgement/results/after.json
```

Comparison lists improvements and regressions per example, so a net gain does not
hide a new false block. It compares correct-run rates when repetition counts differ
and retains incomplete results, failures, and raw probability ranges in JSON.
A regression exits 1; incompatible input exits 2. Fixture hashes and labels must
match. Reports without fixture provenance must be regenerated. Calibration reports
with several cutoffs use each report's configured cutoff by default; select another
recorded cutoff with `--before-threshold` or `--after-threshold`. Comparison is local
and makes no inference calls. Keep generated reports out of source control.

## Strict CI checks

Run `judgement check --base <merge-base> --head <pr-head> --timeout-ms 120000`
without `--hook` or `--advisory`. Violations exit 1, invalid configuration exits 2,
and incomplete coverage or inference failures exit 3. Make that check required
in the repository's merge rules; a local hook may be skipped or time out.

For public contributions, run a pinned, trusted copy of Judgement with trusted
workflow code and a read-only checkout of the base revision. Fetch the PR head as
Git objects and inspect its diff without checking out or executing PR code. Keep
inference credentials scoped to the checking step, disable package install scripts,
and never restore caches controlled by untrusted PR code into that job. CI uses
its configured inference backend; align its model with the one used for calibration.
