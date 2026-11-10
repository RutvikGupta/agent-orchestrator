# Waiting and monitoring (step 5)

Read this when `wait` reports attention, a failure or a retry, or shows a state you do not know.
Messages between you and your agents are in `references/messages.md`; the dashboard is in
`references/dashboard.md`.

## Recover

`$ORCH recover [<run>] [--all]` is a read-only summary of the runs this session launched (`--all`:
every run active in the last 24 hours). It lists tasks by phase, blocked tasks, dirty worktrees,
dead processes, and the next command for each. `SKILL.md` ("Setup") says when to run it.

## What wakes `wait`

- **Exit 0:** a task it watches has an unread result, and `wait` names it. `--all` waits instead
  until every task has finished. A task that finished while no `wait` ran wakes the next `wait` at
  once.
- **Exit 3:** the timeout passed.
- **Exit 5:** a task newly needs **attention**: a decision, a question, a failure, a dead or silent
  task, or a transient error with no retries left.
  - A question for you wakes every `wait` until you answer it with `send`, even one asked before
    that `wait` started.
  - A finished task that has waited `AGENT_ORCH_REVIEW_REMIND` (default 10m) with no `accept`,
    `verdict` or `close` also wakes it, once per interval per task, and `wait` prints the commands.
  - Other attention that was there when `wait` started is listed, but does not wake it.
- **Exit 6:** this agent got a new unread message during the call, or, in your own session, a task
  sent you a note with `tell` (printed). Read it, then run the same command again.
- `wait` also names the tasks ready to dispatch or awaiting review.

A result is unread until you run `result` on it, `close` the task, `accept` it, or `resolve` its
decision. `result` on a task that handed back a decision marks the decision seen; `close` on it
marks the decision resolved. `resolve` moves the task to awaiting review, where it can be accepted.

## How `wait` and `nap` idle

On POSIX, with a Node version that supports `process.execve`, `wait` and `nap` spend idle time in a
small shell. It checks watched PIDs and message and result files every second. It returns to Node on
a change, at the deadline, or after `AGENT_ORCH_PARK_MAX` (default `30s`). Other attention, such as
a task becoming silent, is checked at that maximum interval.

## The `Stop` hook

The `Stop` hook `scripts/hooks/orch-stop.mjs` (set up in `integrations/claude/settings.example.json`;
Codex 0.166 and later run it too) blocks ending your turn, once per set of items, while any of these
holds:

- a question, an unread result or an open decision waits on you (a closed task never does);
- a task runs with no live `wait`.

## Automatic retry

When a task fails with a transient provider or network error, `wait` resumes it once in the same
session (`AGENT_ORCH_MAX_RETRIES`, default 1) and prints `retried <task> …`. A deliberate stop, a
timeout and a usage limit are never retried.

## States, phases and health

- A task is **finished** when its relay process has exited. Its **state** is the relay's
  `result.json` status: `completed`, `failed`, `timeout`, `aborted`, or `<cli>_unavailable`.
  `aborted` with no result means the relay died early; read `log`.
- Its **phase** is one of:
  - `prepared`, `running`, `needs-decision`;
  - `failed`: any unsuccessful end, including a usage limit;
  - `awaiting-review`: completed and not accepted yet;
  - `accepted`, `integrated`.
- Its **health** is one of:
  - `ok`;
  - `silent`: running with no events for longer than its expected quiet time (a babysitter's
    `pr-watch` wait is expected);
  - `dead`: its process is gone without a result;
  - `transient-error`: a provider overload or a network failure.
- A running task is **stuck** when one shell command failed its last 3 runs
  (`AGENT_ORCH_STUCK_REPEATS`) with only read-only inspection, such as `cat`, `grep` or `git diff`,
  in between. Any edit, other command or success ends it. It shows in the dashboard's attention
  lane, `status` and `watch`, and wakes `wait`; nothing acts on the agent. Read its log, then `send`
  a hint, steer it, or stop it.

## What `status` shows

`status` reads each session's event stream. Tokens add up across attempts, and a `~` marks partial
counts. No cost is shown, because Codex reports none. `quiet 6m · ...` means no events for 6m.
