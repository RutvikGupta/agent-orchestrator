# Waiting and monitoring (step 5)

Read this when `wait` reports attention, a failure or a retry, or shows a state you do not know, and,
as a Codex orchestrator, before your first `$ORCH` command. Messages between you and your agents are
in `references/messages.md`; the dashboard is in `references/dashboard.md`.

## Waiting from Codex

- Run every `$ORCH` command outside the sandbox: child agents need the network and write their
  state under the home directory. Request escalated permissions, such as
  `sandbox_permissions: "require_escalated"`, with a one-line justification.
- Block in `$ORCH wait <run> --timeout 9m`, with a shell timeout above that (such as
  `timeout_ms: 600000`). Call it again while it exits 3.
- Ignore the delegate skills' advice to wait with `codex-background`: it does not run on macOS.

## Recover

`$ORCH recover [<run>] [--all]` is a read-only summary of the runs this session launched (`--all`:
every run active in the last 24 hours). It lists tasks by phase, blocked tasks, dirty worktrees,
dead processes, branches merged by hand, and the next command for each. `SKILL.md` ("Setup") says
when to run it.

## Skill changes

The first `orch.mjs` command of a Claude Code or Codex session, or of a delegated task, records a
fingerprint of this skill's `SKILL.md`, `references/` and `policy.json`. When they have changed on a
later command, it prints a notice on stderr and still runs. Output on stdout and `--json` stay
untouched.

- The notice names the changed files, the commits since (at most 5, in a git checkout), and what to
  read again (`SKILL.md`, "Setup", says what to do). It repeats on every command until
  `$ORCH skill --loaded` records the current fingerprint.
- `$ORCH skill` shows the recorded and the current fingerprint and what differs, and changes
  nothing.
- A caller with no session or task identity, such as a plain terminal, gets no notice.
  `AGENT_ORCH_SKILL_NOTICE=0` turns it off.

## What wakes `wait`

- **Exit 0:** a task it watches has an unread result, and `wait` names it. `--all` waits instead
  until every task has finished. A task that finished while no `wait` ran wakes the next `wait` at
  once.
- **Exit 3:** the timeout passed.
- **Exit 5:** a task newly needs **attention**: a decision, a question, a failure, a dead or silent
  task, or a transient error with no retries left.
  - A question for you wakes every `wait` until you answer it with `send`, even one asked before
    that `wait` started. `wait` shows a line of it and the command that prints it whole, with its
    options and recommendation: `$ORCH questions <run> <task-id>` (`references/messages.md`).
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
- A task counts as running only while its recorded PID is its own relay, the one that writes that
  attempt's folder. A PID that was reused, even by another task's relay, no longer keeps a dead task
  running, and `stop` and `close` never signal it.
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

In a run with a plan, `status` also shows:

- every planned task, started or not: `waiting` (with the tasks it waits on), `ready`, or the phase
  of a started one (`running`, `needs-decision`, `awaiting-review`, `accepted`, `integrated`,
  `failed`). A `ready` task notes when its brief is not ready, or when it is a babysitter to start
  by hand;
- the tasks recorded outside the plan;
- a warning for each task whose branch was merged by hand without `integrate`, with the command
  that records it (`references/integrate.md`, "A branch merged by hand"). `recover` flags the same.

`--json` adds `plannedTasks`, `unplannedTasks` and `manualMerges`.
