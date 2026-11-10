# Reviewing, accepting and reworking a result (step 6)

Read this before you review a result. Also follow the agent's
`~/.agents/skills/<agent>-delegate/references/review-and-land.md`.

## Read the result

```bash
$ORCH result <run> <task-id>   # report, orch-result, scope violations, health, tokens, files, session
git -C <task-cwd> status --porcelain && git -C <task-cwd> diff
```

`result` shows the agent's final message, its structured report (the `orch-result` block), its
**scope violations** (changed files outside the plan's `owns`), and its health. Treat all of it as
claims to check.

## Check it

- Read the whole diff against the brief, including untracked files.
- Reject scope creep: undo a scope violation, or keep it only for a reason you can state.
- Check any edits to existing tests before you trust a green gate.
- `result` marks each reported check `ran, exit N` or `NOT FOUND in the log`, from the agent's log,
  and warns when a `pass` failed or never ran.
- Still rerun the key gates with `$ORCH verify <run> <task-id> -- <command>`, which records the exit
  code, the commit and the output's tail.
- Check that the agent ran the testing skill that applies (its brief's "Testing skills"), or said why
  none could run.
- Check the messages the user sent it (`references/messages.md`), since they can change what it did.
- For a read-only task, check `readOnlyViolation` in `result --json`. Claude reports it; Codex's
  sandbox enforces read-only. The touched files are the whole `git status`, earlier changes too.

Record each round:

```bash
$ORCH verdict <run> <task-id> clean|changes|reject --note "<why>"
```

`changes` makes the next attempt a rework, and `reject` closes the task.

## A second reviewer

A risky write task gets a read-only review by the other agent by default (`brief --type review`).
A task is risky when it changes an interface, spans many files, or touches a risk from the `complex`
tier list (`SKILL.md`, "Choose the agent and model").

- Ask the reviewer for concrete defects only, and verify each one.
- For a consequential change, let one reviewer see the requirements and the diff before it sees the
  implementer's explanation.

## Accept

Implementers commit on their task's branch, unless they were started with `--no-publish`. Review
their commits (`git -C <worktree> log` and the diff from the
base). If an agent left changes uncommitted, commit them on the task's branch yourself, following
the repository's commit-message rules. Then record it, with your reason:

```bash
git -C <worktree> add <files> && git -C <worktree> commit -m "<message>"
$ORCH accept <run> <task-id> --note "<why>" [--commit <sha>]   # default: HEAD of its working directory
```

## Rework

Rework stays in the same agent session. Write a short delta brief that names what to fix, then run:

```bash
$ORCH start <run> <task-id> --agent <same> [--tier <same>] --brief <delta> -- --session <id>
```

Use the session id that `result` printed. The task keeps its working directory, and the attempt
number goes up.

A follow-up attempt that keeps its agent and tier may omit `--why`, and a Claude follow-up may omit
`--tier`: each keeps its earlier value. A Claude task recorded before tiers existed resumes at
`complex`; Codex always needs `--tier`.

## Escalate a tier

The "Quality guard" in `SKILL.md` says when to go one tier up: to the agent's next tier, lightest
first, in the table there.

- Resume with `--tier <next>`, a new `--why` that names what failed, and the same `--session`, so the
  stronger model keeps the context.
- When the earlier attempt went far off track, start fresh (no `--session`) with a corrected full
  brief.
- After two failed attempts, do not loop: move the task to the other agent (a fresh session with a
  full brief and a new `--why`), do the fix yourself, or re-plan.

## Lessons

When a failure or review shows a trap that is likely to recur, record it once it is verified:

```bash
$ORCH lesson <run> "<the trap and how to avoid it>" --evidence "<how you verified it>"
```

`--repo DIR` names the repository instead of a run, and `--list` prints the lessons. `brief` adds
them to later briefs for that repository (`references/briefing.md`). Keep the list short and true.
