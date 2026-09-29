# Using Judgement as a coding agent

Judgement checks repository diffs against natural-language rules. The project owns
its rules and labeled examples. Judgement owns running checks, testing examples,
comparing thresholds, and reporting results.

## Find the project setup

1. Read the repository's agent instructions and `.judgement/rules.json`.
2. Inspect its package scripts and existing inference adapter. Use the project's
   configured command and backend when available; a different model may score the
   same examples differently. Do not add credentials to files or output.
3. Use the installed, pinned package. Do not install packages inside a commit hook.
   The commands below require the release containing the calibration API; check
   `judgement --help` rather than assuming an older installation supports them.

## Write a rule

Use `.judgement/rules.json`, the only policy location:

```json
{
  "criteria": [
    {
      "id": "billing-audit",
      "rule": "Every successful billing mutation must record an audit event for that mutation. Read-only queries do not require audit events.",
      "files": ["src/billing/**"],
      "context": ["src/audit/**"],
      "threshold": 0.85
    }
  ]
}
```

- Give each rule a stable ID. Use letters, digits and hyphens for easy filenames.
- Describe one observable requirement, its scope, and meaningful exceptions.
  Split unrelated requirements when they need different evidence or thresholds.
- Scope `files` to relevant paths. Globs are relative to the repository root and
  match hidden paths too. `context` selects unchanged supporting files from the
  same Git snapshot. Keep it focused; it is not a request to inspect the whole repo.
- A threshold is a decision cutoff, not proof of accuracy. The default 0.85 is a
  starting point. Do not weaken the rule or lower its threshold just to get green.

## Save labeled examples

For each rule, write `.judgement/examples/<id>.json`:

```json
{
  "ruleId": "billing-audit",
  "examples": [
    {
      "name": "Mutation without audit event",
      "path": "src/billing/update.ts",
      "before": "export async function update(db, audit, id) { await db.update(id); await audit.record(id); }\n",
      "after": "export async function update(db, audit, id) { await db.update(id); }\n",
      "expected": "violation"
    },
    {
      "name": "Read-only query",
      "path": "src/billing/read.ts",
      "before": "export async function read(db) { return []; }\n",
      "after": "export async function read(db) { return db.findMany(); }\n",
      "expected": "pass"
    }
  ]
}
```

Label by the intended policy **before** looking at model scores. Include clear
violations, allowed exceptions, fixes, unrelated edits near old violations, and
realistic context. Keep failing examples; investigate them instead of changing the
expected label to match the model.

`before` and `after` must differ. Use `null` for the absent side of an addition or
deletion. Optional `context` maps unchanged relative paths to file contents; the
rule's context globs still control which files are included. Fixtures are source
text, not programs to execute. Never put real secrets or private data in examples.
If a rule allows synthetic placeholders, those are valid cases, not positive
secret-detection tests. State that coverage limitation explicitly.

## Test before tuning

Run with the project's pinned CLI or equivalent adapter command:

```sh
judgement test --dry-run
judgement test --rule billing-audit --repeats 3
judgement test --format json > /tmp/judgement-tests.json
judgement calibrate --rule billing-audit --thresholds 0.8,0.85,0.9,0.95
judgement calibrate --all --format json > /tmp/judgement-calibration.json
```

`test` uses each rule's configured threshold and requires every run to match its
label. A valid example must fully pass; an incomplete result fails the test.
`calibrate` compares candidates. A recommendation can still leave valid examples
incomplete, so read the full report. Live runs make paid model requests; dry runs
make none. A recommendation requires both valid and violating examples; a
single-label set can test behavior but cannot select a threshold. Testing and calibration are explicit operations, never part of the
normal commit hook.

The harness uses disposable Git repositories, repeats without a verdict cache,
and preserves the real working tree and index. It reads working-tree rules so
edited candidate thresholds can be tested. Normal diff checks use the base policy,
so a rule edit cannot weaken the check on its own commit.

Inspect false blocks, caught violations, incorrect passes, incomplete results,
operational failures, scores, and timing separately. When a case fails:

1. Check its label, path, rule wording, and selected supporting context.
2. Distinguish an uncertain correct answer from a wrong answer. Lowering a threshold
   cannot repair a wrong outcome and may turn uncertainty into a false block.
3. Repeat the run. Never present one score as a guarantee.
4. Validate a candidate against separately labeled held-out examples before adopting
   it. Use `--examples` for one rule, or `test --examples-dir` / `calibrate --all
--examples-dir` for a separate suite. Commit deliberate rule and fixture changes;
   keep generated reports local or as CI artifacts.

## Interpret exit codes and report honestly

- `test`: 0 means all labels matched (or dry run); 1 means wrong, incomplete, or
  operationally failed checks; 2 means invalid input/setup; 130 means interrupted.
- `calibrate`: 0 means a candidate was recommended (or dry run); 3 means no candidate
  was recommended for at least one selected rule; 2 means invalid input/setup.
- `check --hook` allows incomplete results to keep commits moving. Strict `check`
  rejects incomplete results. Neither behavior makes an incomplete result a pass.

Report what was tested, repeated counts, backend differences, incomplete cases,
and untested categories. Passing small fixtures does not prove that large commits,
missing context, or every possible violation will be handled correctly.

Applications with existing credentials should supply their evaluator to `testRules`
or `calibrateRules`. Keep that adapter thin: do not copy the runner, fixture loading,
isolated repository setup, threshold logic, or reporting into each application.
