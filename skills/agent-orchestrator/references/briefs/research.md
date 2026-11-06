<!-- tier: Codex standard (only Codex has live web search); Claude light or standard for lookups and summaries; a test or gate run that only reports: Claude light (write mode, a brief that forbids edits) or Codex standard; complex only when the question needs deep judgment -->
{{role}}

## Question

{{goal}}

<fill in: what the answer is for, and which decision it feeds>

## Context

{{context}}

## Scope

{{scope}}

## House rules

{{houseRules}}

## Method

- Prefer primary sources: official documentation, specifications, source code, and release notes.
  Note each source's date or version.
- Keep what a source states apart from what you infer.
- <fill in: limits, such as the versions that matter, sources to avoid, or how deep to go>

## Report contract

Use at most about 25 lines before the `orch-result` block; that block is not counted. Give one
line per changed file, the gate results, the decisions you took, and what is unresolved. Put long
evidence (logs, tables, reproductions) in a file outside the repository, for example under
`$TMPDIR`, and give its path.

End with a final message that starts with the answer, in a few lines. Then give the evidence: each
claim with its source link, its date or version, and how confident you are. Then list the open
questions.

Finish the message with this block, filled in:

```orch-result
{"outcome": "done | partial | blocked",
 "changed": [],
 "checks": [{"cmd": "...", "result": "pass | fail | not-run", "note": "..."}],
 "decisions": [{"question": "...", "options": ["..."], "recommendation": "..."}],
 "unresolved": ["..."]}
```

`outcome` is `done` when the question is answered, and `partial` when only part of it is.
`changed` stays empty. `checks` lists any command you ran to verify a claim. `decisions` lists only
the questions you hand back (see "Decisions" below). `unresolved` lists the open questions.
