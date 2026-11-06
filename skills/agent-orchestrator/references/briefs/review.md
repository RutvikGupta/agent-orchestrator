<!-- tier: standard for a small diff, on the agent that did not write it; complex for a large or risky diff -->
{{role}}

## Goal

{{goal}}

Report concrete defects only: behavior that is wrong, missing, or inconsistent with the
requirements or the surrounding code. Leave out style preferences, and say when you are unsure.

## Requirements

<fill in: what the change must do: the implementer's goal and done criteria, or the plan's acceptance items that it covers>

## The change

{{diff}}

## Context

{{context}}

## Scope

{{scope}}

## House rules

{{houseRules}}

{{testingSkills}}

## What to check

- Each requirement: implemented, connected to its callers, and covered by a test.
- Edits to existing tests: each must still check what it checked before.
- Testing skills: whether the implementer ran the repository's testing skill that applies to the
  change (listed under "Testing skills" when there are any) and reported its result as a check, or
  said in one line why none applies or can run here.
- Error paths and edge cases, and <fill in: the risks specific to this change, such as concurrency, security, or a data migration>.
- Files changed outside the implementer's scope: <fill in: the paths it owned>.

<fill in: optionally, the implementer's report. For a consequential change, leave it out, so that the review does not anchor on the implementer's explanation; or delete this line>

## Gates

<fill in: commands you may run to confirm a finding, such as the test suite, or "none" for a read-only Claude reviewer, which has no shell>

## Report contract

Use at most about 25 lines before the `orch-result` block; that block is not counted. Give one
line per changed file, the gate results, the decisions you took, and what is unresolved. Put long
evidence (logs, tables, reproductions) in a file outside the repository, for example under
`$TMPDIR`, and give its path.

End with a final message that lists each defect, most severe first: the file and line, what is
wrong, how to reproduce it or why it fails, and a suggested fix. Say plainly when you found none.
Then list the commands you ran, and what you could not check.

Finish the message with this block, filled in:

```orch-result
{"outcome": "done | partial | blocked",
 "changed": [],
 "checks": [{"cmd": "...", "result": "pass | fail | not-run", "note": "..."}],
 "decisions": [{"question": "...", "options": ["..."], "recommendation": "..."}],
 "unresolved": ["..."]}
```

`outcome` is `done` when you checked every requirement, and `partial` otherwise. `changed` stays
empty: you change no file. `checks` lists the commands you ran. `decisions` lists only the
questions you hand back (see "Decisions" below). `unresolved` lists the defects, one line each.
