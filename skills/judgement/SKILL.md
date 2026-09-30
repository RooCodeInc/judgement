---
name: judgement
description: Turn recurring repository mistakes and user corrections into calibrated Judgement rules. Use when a user asks an agent to "never do that again," prevent a mistake from recurring, enforce a contextual code or prose requirement, or add, test, or tune Judgement rules. Applies to requirements visible in repository changes; conversation-only preferences belong in agent instructions or memory.
---

# Judgement

Make a recurring requirement concrete: a focused rule in `.judgement/rules.json`,
labeled examples, and evidence that the configured checker distinguishes the
mistake from allowed changes. Judgement checks Git diffs; it cannot guarantee that
an agent will never repeat a behavior.

## Turn the correction into a requirement

Use the user's correction and the surrounding task to identify the unwanted
behavior, where it matters, and the allowed exceptions. A clear request to prevent
recurrence is enough to make a scoped repository rule change. Ask a focused
question only if the intended requirement or scope is ambiguous.

Choose the appropriate mechanism:

- Use Judgement for contextual distinctions that need judgment: misleading setup
  prose, exposing internal errors to users, or carrying credentials across a trust
  boundary.
- Use an existing formatter, linter, type check, or deterministic test when it can
  express the requirement reliably. Do not add a model check for a mechanical ban.
- Use the project's agent instructions or the user's preferred memory mechanism
  for conversational or tool-use behavior that is not visible in committed files.
  A rule about Git diffs cannot enforce how an agent talks in chat.

Keep the scope the user intended. A correction to one situation does not establish
an unrelated repository-wide policy. Resolve equivalent existing rules before
adding another; preserve their stable IDs and useful examples.

## Find the setup and write the rule

Read repository instructions, `.judgement/rules.json`, existing fixtures, and the
package scripts. Use the project's pinned Judgement command and inference adapter.
Check its `--help` for available commands. If Judgement is not configured, explain
what setup is needed and use the repository's dependency and credential conventions
when setup is within the request. Installing this skill does not install the CLI
or configure inference.

Read [the agent guide](references/agent-guide.md) for the rule and example schemas,
commands, calibration, and result semantics before editing rules or fixtures.

Describe one observable requirement and its meaningful exceptions. Select relevant
`files` globs and only the supporting `context` needed to judge it. Favor localized
rules so evidence stays small and checks stay fast. Do not expand context to the
whole repository to compensate for an unclear rule.

For example, “stop capitalizing session everywhere” may mean ordinary nouns in
user-facing prose, while sentence starts, headings, exact UI labels, and code
identifiers remain valid. Preserve the exceptions the user actually intends.

## Demonstrate the behavior

Add labeled examples under `.judgement/examples/<rule-id>.json`. Include the
mistake, a corrected version, allowed exceptions, and a nearby unrelated edit that
should pass. Label examples from the intended requirement before inspecting scores.
Use synthetic or redacted content; do not copy private data into fixtures.

For staged or committed feedback, `judgement capture` can preview an example.
Review the preview before saving; do not stage unrelated user changes to capture
them. Preserve the index and working tree while testing.

Use the configured command to dry-run the fixtures, then run a bounded repeated
test of the affected rule when its inference backend is available. Use calibration
to compare cutoffs and separately labeled examples to check the chosen cutoff.
A cutoff is a violation-probability threshold, not a measured accuracy guarantee.
The default is a starting point, not evidence that a new rule is calibrated.

Keep intended labels even when the model gets them wrong. Inspect wording, scope,
and evidence when valid and violating scores overlap. Do not weaken a rule or tune
on one example merely to make a check pass. If inference is unavailable, validate
what you can and report that calibration remains untested.

Normal checks read the base policy; a new rule is tested through the example
harness's working-tree policy before it becomes part of the base. Keep calibration
out of commit hooks. Store generated reports locally or as CI artifacts; check in
deliberate rules and examples.

## Finish with an honest result

Summarize the requirement, scope and exceptions, examples tested, chosen cutoff,
and any missed violations, false blocks, or incomplete runs. Do not promise
“never again” from passing examples. Preserve the project's choice of optional or
required CI checks and its existing hook behavior; adding a rule does not authorize
changing merge protection, publishing a package, or posting messages.
