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
      "rule": "Only workspace owners may change payment settings."
    }
  ]
}
```

Save this as `JUDGE.json` at the repository root. Run Judgement before a commit
or in CI. It uses [Jev](https://typesafe.ai) to make focused judgments and reads
related source files from the exact Git snapshot being checked.

## Install

Node 22.20+ or 24+ and Git are required. There are no runtime npm dependencies.
The package is distributed from this repository; it is not yet published to npm.

```sh
npm install --save-dev https://github.com/RooCodeInc/judgement/archive/refs/tags/v0.1.0.tar.gz
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
`.pre-commit-hooks.yaml` with `rev: v0.1.0` and hook `id: judgement`.

## CI and strict checks

```sh
judgement check --base origin/main --head HEAD
judgement check --staged --format json
judgement check --staged --dry-run
judgement check --staged --no-cache
```

`--base` is an exact base revision, not an implicit merge-base operation. For a
PR, resolve the merge base explicitly and pass its SHA. Checkout full history.
Use policy from a trusted base and provide the API key through CI secrets.
Run untrusted contributions without write-capable repository tokens.

| Exit | Strict check | `--hook` |
| --- | --- | --- |
| 0 | Completed without a blocking finding | Completed or explicitly incomplete |
| 1 | Confirmed violation | Confirmed violation |
| 2 | Invalid configuration or invocation | Invalid configuration or invocation |
| 3 | Incomplete, uncertain, service/Git failure | Reported, commit allowed |

`--advisory` reports all outcomes without blocking. `--timeout-ms` changes the
budget (strict mode defaults to 120 seconds). Use JSON `status` to distinguish
incomplete hook runs from completed ones. `--dry-run` sends no model requests.

## Rules

`criteria` is a non-empty array. Each criterion accepts:

- `rule`: required natural-language requirement.
- `id`: optional unique identifier for reports.
- `files`: optional repository-relative globs selecting changes that activate
  the rule. Other files can still be supporting evidence.
- `context`: optional repository-relative globs adding unchanged source files.
- `threshold`: confidence cutoff between 0 and 1; defaults to 0.85. It is not a
  measured probability that the change is correct.

Globs use Node's `path.matchesGlob` syntax. Bare names also match path components;
trailing `/` selects a directory. Absolute paths, `..`, negation, and backslashes
are rejected. This is a small declarative configuration, never executable code.

Existing policy comes from the base tree. If no policy exists there, a newly
staged policy can bootstrap checking. Editing or deleting a policy does not
weaken the check for the same commit. Judgement never rewrites your policy.

## Evidence and large changes

Judgement snapshots the index with `git write-tree`, including temporary indexes
used by `git commit -a` and path commits. It reads staged blobs rather than their
working-tree counterparts, preserving partially staged work. The final index is
checked again before a clean result is accepted.

Small changes and their context are evaluated together. For larger changes,
a conservative model decision determines whether the rule can be checked for
every affected file independently with related evidence. Each such check still
covers all operations in that file. Global, existential, parity, and aggregate
rules are not reduced to independent passes.

Oversized evidence is screened in bounded chunks. Every text chunk is visited
in a completed run; the middle is never discarded. Partial screens can identify
a direct violation but **cannot approve the full rule**. A relationship that
cannot be assembled within the model's context limit remains incomplete.

The initial context collector follows relative JS/TS imports for two hops and
reads `context` globs. It does not build a universal call graph, understand every
path alias, or search external systems. Use context globs for authorization
wrappers, provider registries, tests, and other relevant files. Missing or
ambiguous evidence should produce an incomplete judgment. Model decisions,
including the independent-file interpretation, remain probabilistic.

Renames are represented as deletion plus addition. Deleted text is included in
patches. Binary files, symlinks, and submodules are reported as unsupported when
an applicable rule needs them. No silent approval of unsupported content.

Raw judgments are cached in Git metadata by model/backend identity, rule,
algorithm version, and exact evidence. Planning runs again on every snapshot;
negative import lookups also depend on the tree identity. Incomplete answers and
service failures are not cached as approvals. Use `--no-cache` in required CI if
cache provenance is not trusted.

## Library and custom backends

```js
import { check, exitCode, formatReport } from '@roocodeinc/judgement';

const report = await check({ cwd: process.cwd(), hook: true });
console.log(formatReport(report));
process.exitCode = exitCode(report, { hook: true });
```

An `evaluate(request, signal)` function can supply another transport. It returns
`{ outcome, confidence }`. Use exported `question(request)` to retain the same
rubric, honor the AbortSignal, and set a stable `cacheIdentity` that changes with
the model/backend configuration. Custom evaluators have caching disabled unless
an identity is supplied. Type declarations ship with the package.

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
import { check, formatReport } from '@roocodeinc/judgement';

const report = await check({ base: process.env.REVIEW_BASE, head: 'HEAD', cache: false });
if (report.status === 'violation' || report.status === 'invalid') fail(formatReport(report));
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
