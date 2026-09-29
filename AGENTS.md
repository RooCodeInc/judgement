# Working on Judgement

Judgement is a small ESM JavaScript library and CLI. Read README.md and
[docs/agents.md](docs/agents.md) for the public workflow and command semantics.

## Ownership

Keep generic checks, fixture loading, isolated Git setup, testing, calibration,
threshold selection, reporting, and cancellation in this library. Consuming
projects own their rules, labeled examples, and any custom inference adapter.
Generated calibration reports belong in local output or CI artifacts.

## Changes and validation

- Keep `src/index.d.ts` aligned with public JavaScript exports.
- Keep CLI help, README, and the packaged agent guide aligned with actual behavior.
- Run `npm run check` for code changes. Use `npm pack --dry-run --json` when changing
  package files or documentation intended for installed-package users.
- Test Git behavior with disposable repositories. Preserve staged/unstaged
  separation, base-policy enforcement, cancellation, and bounded concurrency.
- Unit tests use deterministic evaluators. Live model evaluations must be explicit,
  use synthetic data, and report incomplete and failed judgments accurately.
- Do not automatically run calibration during normal hooks, overwrite user rules,
  or silently drop examples that fail. Runtime and test commands have different
  exit semantics; document and test both.
- Preserve the project's pinned dependencies. Do not publish as a side effect of
  testing or preparing a PR.
