# Runs you did not launch

Read this before you act on a run you did not launch, when a command refuses with exit 4, and when
you find that you changed another session's task. The rule itself is in `SKILL.md`, "Guardrails".

## What stays open

A refusal (exit 4) changes nothing. Reading stays open: `status`, `wait`, `result`, `log`,
`recover`, `inbox`, and `send` without `--steer`.

## Ask the owner instead

- A Claude session: with `SendMessage` (`ListAgents` finds it).
- An orch task: with `$ORCH send <run> <task> "<request>"`.
- Otherwise, the user.

Pass `--adopt` only when the refusal says the run is orphaned: every owner gone, and the run unused
for 30 minutes.

## When a change crossed sessions

- If you stopped, closed or changed another session's task by any route, tell that session at once,
  the same way as above. Name the tasks and what you did, and ask it to resume what it still needs.
  Then tell the user in one line.
- When `status` or `wait` says someone else changed one of your tasks, check it, and resume it if it
  was still needed. Leave what the user closed.
