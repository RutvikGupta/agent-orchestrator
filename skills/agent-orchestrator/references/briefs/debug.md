<!-- tier: by the criteria: light or standard to reproduce a bug or test a narrow hypothesis; complex when the cause is unknown across modules or a wrong fix would be costly or subtle -->
{{role}}

## Goal

{{goal}}

## Symptom

<fill in: what fails, the exact error or output, how to reproduce it, and since when>

## Hypothesis

<fill in: the candidate cause that this task tests, or "unknown: find the cause">

<fill in: the other candidate causes that other investigators test at the same time, so that your experiment tells yours apart from them; or delete this line>

## Context

{{context}}

## Scope

{{scope}}

## House rules

{{houseRules}}

{{testingSkills}}

## Method

1. Reproduce the symptom. If it does not reproduce, stop and report what you ran.
2. Design an experiment whose result differs depending on whether the hypothesis holds, such as a
   changed input, a minimal test, or a log line.
3. Run it, and keep the commands and their output.
{{fixStep}}

## Gates

<fill in: the commands that reproduce the symptom and run the relevant tests>

If this brief has a "Testing skills" section, use the skill from it that applies to reproduce the
symptom with synthetic data or an end-to-end run, and to test any fix, as that section says.
Report it as a check.

## Report contract

Use at most about 25 lines before the `orch-result` block; that block is not counted. Give one
line per changed file, the gate results, the decisions you took, and what is unresolved. Put long
evidence (logs, tables, reproductions) in a file outside the repository, for example under
`$TMPDIR`, and give its path.

End with a final message that starts with the verdict on the hypothesis: `confirmed`, `falsified`,
or `inconclusive`. Then give the evidence (the experiment, the commands, and their output), the
cause in one or two sentences, and the fix you made or propose.

Finish the message with this block, filled in:

```orch-result
{"outcome": "done | partial | blocked",
 "changed": ["path", "..."],
 "checks": [{"cmd": "...", "result": "pass | fail | not-run", "note": "..."}],
 "decisions": [{"question": "...", "options": ["..."], "recommendation": "..."}],
 "unresolved": ["..."]}
```

`outcome` is `done` when the hypothesis is confirmed or falsified (and any fix passes the gates),
and `partial` when it is inconclusive. `changed` lists every file you changed; it is empty in
read-only mode. `decisions` lists only the questions you hand back (see "Decisions" below).
`unresolved` lists anything left open.
