<!-- tier: light or standard for a mechanical change or a well-specified one to 1 to 5 files with clear done criteria; complex for several modules, an open approach, or costly or subtle mistakes -->
{{role}}

## Goal

{{goal}}

Done when:

- <fill in: each condition that must hold at the end, stated so that a test or a command can check it>

## Context

{{context}}

## Scope

{{scope}}

## House rules

{{houseRules}}

{{testingSkills}}

## Gates

Run these in this directory before you finish, and fix what fails:

- <fill in: the project's real test, lint, and build commands, scoped to this task>

If this brief has a "Testing skills" section, the skill from it that applies to your change is a
gate too: use it as that section says, and report it as a check.

<fill in: any gate that this directory cannot run (it needs a service, or an ignored file the worktree lacks), so that you report it as not run; or delete this line>

Change an existing test only when the goal changes the behavior it checks, and say so in your report.

## Report contract

Use at most about 25 lines before the `orch-result` block; that block is not counted. Give one
line per changed file, the gate results, the decisions you took, and what is unresolved. Put long
evidence (logs, tables, reproductions) in a file outside the repository, for example under
`$TMPDIR`, and give its path.

End with a final message that lists:

- the changes per file;
- the gate commands with their results (pass and fail counts);
- anything not done;
- any decision you took that this brief did not specify.

Finish the message with this block, filled in:

```orch-result
{"outcome": "done | partial | blocked",
 "changed": ["path", "..."],
 "checks": [{"cmd": "...", "result": "pass | fail | not-run", "note": "..."}],
 "decisions": [{"question": "...", "options": ["..."], "recommendation": "..."}],
 "unresolved": ["..."]}
```

`outcome` is `done` only when every done criterion holds. `changed` lists every file you created or
changed. `decisions` lists only the questions you hand back (see "Decisions" below) and is empty
otherwise; choices you made yourself go in the message. `unresolved` lists anything left open.
