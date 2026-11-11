# Changelog

## 2.0.0 (2026-11-10)

A major update to the `agent-orchestrator` skill: the review loop, the plan, cleanup and cost
control are now commands that `orch.mjs` enforces, where before they were instructions an
orchestrator had to remember.

### Changed behavior to know about

- **`accept` can refuse.** It refuses a write task whose report marks a check as passed when the
  latest matching run of that check failed. `--unverified "<reason>"` overrides. A check that
  matches no run, or a run whose exit status is unknown, is a warning.
- **Worktrees are collected.** `close` (after a run's last open task) and `integrate` remove the
  clean worktrees of closed or integrated tasks. Branches are always kept, and
  `worktree RUN TASK` restores a collected folder from its branch.
- **A run with a plan follows it.** The first `start` of a task refuses one whose prerequisites are
  not integrated, one that shares an owned path with a running task, and one the plan does not
  name (`--unplanned`).
- **Follow-ups escalate.** After two counted failures a task's next attempt runs one tier up in
  the same session; after two more, or at the top tier, `start` says to use the other agent.
  `--tier`, a changed `--agent` or `--no-escalate` overrides.
- **A delegated agent cannot start a stronger tier than its own,** and a command task's ceiling
  applies to the tasks its command starts.
- **`SKILL.md` is a 296-line core.** Each step names the file under `references/` to read before
  doing it.

### New commands and options

- `review RUN TASK` starts the other model as a read-only reviewer, sized by the diff, and
  `rework RUN TASK` resumes the author with the findings.
- `dispatch RUN --follow [--timeout DUR]` starts each planned task as its prerequisites are
  integrated, until the plan is done or a task needs the orchestrator.
- `integrate RUN TASK --already-merged` records a task merged by hand; `status` and `recover` flag
  hand merges.
- `gc [--dry-run] [--older-than DUR]` collects worktrees of idle runs the caller owns and expires
  finished tasks nobody read for 7 days.
- `start --agent command --max-tier TIER` sets a model and effort ceiling for the agents a command
  starts, and `model --agent claude|codex [--tier TIER]` prints the arguments for a tier, lowered to
  the ceiling. A sub-agent that names a full model id above the ceiling is warned about on the
  board, not prevented.
- `skill` and `skill --loaded`: `orch.mjs` tells a session when the skill's instructions changed
  since it loaded them.
- `tools/test.sh` runs the test files concurrently; `--quick` runs the files that start no
  dashboard or long-lived process.

### Improvements

- **Babysitters.** Waiting on a pull request costs no model tokens: a babysitter's watch returns
  at once so that it parks, and the watcher absorbs passing checks when nothing else is open. A
  parked babysitter whose context passes 150,000 tokens resumes in a fresh session from a handoff
  note it keeps current. The watcher also wakes it for a merge-queue ejection and a moved base.
- **Tier evidence.** `agents`, `stats` and the error that asks for `--tier` show each tier's
  results over the last 30 days: tasks, share accepted on the first attempt, and input tokens per
  accepted task.
- **Check evidence.** `result` and `accept` match a reported check to the command that ran through
  wrappers, compound commands and neutral flags, and keep the flags that change what a run proves.
- **Command tasks.** A command task's relay records the agents its command starts, however
  short-lived and with no dashboard running, and the board shows them in the task's own row.
- **Task liveness.** A task counts as running only when its recorded process is its own relay, so
  a reused process id can neither show a finished task as running nor be signalled by `stop` or
  `close`.
