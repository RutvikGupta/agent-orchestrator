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
  - **Items passed up to you.** When one of your tasks is not running (it was stopped, or it
    ended), an item of a task it started is yours: it would have gone to that task. `wait` lists it
    as `<run>/<task>: <kind> — <reason> (passed on: task <run>/<task> is not running)`, with the
    run of the task that needs it, and wakes for it like any other item. Results awaiting review
    count here, since nobody below reads them. Close the task, or resume its parent to handle it.
- **Exit 6:** this agent got a new unread message during the call. Read it, then run the same
  command again.
- **Notes do not wake it.** In your own session, a note that a task sends with `tell` needs no
  answer, so `wait` keeps waiting. It holds the note and prints every held note, oldest first, with
  its next exit, whatever ends it: a result, attention, or the timeout (exit 3).
  - A note sent while no `wait` ran prints with the next `wait`'s exit. Each note prints once.
  - `wait --notes` ends at the first new note instead, with exit 6. Use it when you want each note
    as it comes.
  - A question (`ask`), a handed-back decision and a message still wake `wait` at once.
  - `dispatch --follow` does not read notes, and the Stop hook does not count them; the next
    `wait` prints them.
- `wait` also names the tasks ready to dispatch or awaiting review.

A result is unread until you run `result` on it, `close` the task, `accept` it, or `resolve` its
decision. `result` on a task that handed back a decision marks the decision seen; `close` on it
marks the decision resolved. `resolve` moves the task to awaiting review, where it can be accepted.

A task that a stop ended (`stopped`) has no unread result. It counts as finished, so `wait` returns
once nothing else it watches runs, but it never wakes `wait` by itself.

## How `wait` and `nap` idle

On POSIX, with a Node version that supports `process.execve`, `wait` and `nap` spend idle time in a
small shell. It checks watched PIDs and message and result files every second. It returns to Node on
a change, at the deadline, or after `AGENT_ORCH_PARK_MAX` (default `30s`). Other attention, such as
a task becoming silent, is checked at that maximum interval.

Inside a Claude, Codex or Gemini task, `nap` also keeps a budget. Each nap adds its duration to a total for
the attempt (`naps.json` in the attempt's folder). Once the total would pass `AGENT_ORCH_NAP_BUDGET`
(default `10m`), `nap` refuses with exit 2 and a message that says to park with `park-until`
(below). Outside a task, and in a command task, `nap` is unchanged, and so is a babysitter's
`pr-watch` (`references/messages.md`).

## Parked tasks

A task that has only a wait left can **park**: it ends its turn, its agent exits and frees its
memory, and a small watcher wakes the same session later. The watcher is a shell loop with no model.
A babysitter parks this way (`references/babysit.md`). So can any Claude, Codex or Gemini task, for a wait of
more than a few minutes.

- **Record the wait.** `$ORCH park-until [--every DUR] [--for DUR] [--why TEXT] -- COMMAND [ARGS...]`
  runs inside a task's shell: it finds the task from `AGENT_ORCH_RUN` and `AGENT_ORCH_TASK`. It
  records a **wake condition** for the task's current attempt in `park-until.json` in the attempt's
  folder. A later call in the same attempt replaces it.
  - `--every` defaults to `2m` and is at least `30s`. `--for` defaults to `6h` and is at most `24h`.
  - It refuses (exit 2) outside a task, in a command task, with a bad `--every` or `--for`, and when
    `COMMAND` is neither a file nor a program on `PATH`.
  - It prints what the agent must do next: end its turn with `PARKED: waits for <what>` and an
    `orch-result` outcome `parked`.
- **Who parks.** A babysitter, as before. And any Claude, Codex or Gemini task whose attempt ends with
  `PARKED:`, when either it recorded a wake condition in that attempt, or a task it started (with
  `start`, in any attempt) had not ended for it when the attempt ended: it still ran or was parked,
  or its finish notice was not read yet. A child that ends just before the parent's result is
  written so still wakes the parent. When a child's notice has not come 2 minutes after it ended
  (its finish watcher is gone), the parent's watcher writes it. A `PARKED:` with neither does not park: the task ends
  `completed`, and `result` prints a line `not parked: ...` that says why. Command tasks never park.
- **What the watcher does.** Every `--every` it runs the condition command in the folder
  `park-until` ran in, with the task's own environment: the starter's environment, the user's
  `agent-env.json`, the agent's `PATH`, and the task's `AGENT_ORCH_*` variables; for a Codex task
  started with `--clean-env`, only what that option and its `--keep-env` names keep. One run may take
  its interval, at least 10 seconds and at most 10 minutes, and never past `--for`; a run cut off
  counts as not met. The deadline is checked every minute (`AGENT_ORCH_PARK_INTERVAL`), whatever
  `--every` says. The output goes to `park-condition.log` in the attempt's folder.
- **What wakes the task.** The watcher resumes the same session, at the same tier and with the same
  relay options, when:
  - the command exits 0;
  - `--for` has passed;
  - an unread message arrives;
  - a task it started finishes (its finish notice is a message).

  A command that cannot run (a missing program, a folder that is gone) wakes the task with the error
  instead of trying forever. A run that exited 0 or could not run stays the event until a resume
  delivers it, also when the machine has no room for the resume at first. The resume brief says
  which of these happened, gives the command's exit code and its last 40 lines of output when they
  matter, with obvious secrets replaced by `[redacted]`, and says not to run the condition again to
  check. A sandboxed Codex task with the network on resumes with its sandbox named
  (`--sandbox workspace-write`), which the Codex relay needs to resume it.
- **How it shows.** As for a parked babysitter: `status` and the dashboard show the task as
  `parked`, with what it waits for. `wait` treats it as running. It takes no parallel slot and keeps
  its checkout. `stop` and `close` end the watcher. `status`, `start`, `wait`, `dispatch` and the
  dashboard restart a watcher that died.
- **A resume that is refused.** The watcher's resume goes through `start`'s checks, so another task
  writing in the same checkout refuses it. The watcher releases its claim and tries again at the
  next check; `status` shows `resume waits: <reason>`, and `send` says the message is stored and the
  resume blocked. After `AGENT_ORCH_RESUME_BLOCKED_AFTER` (default `10m`) of refusals the task has a
  `resume blocked` attention item: `wait` exits 5, and the dashboard and escalation list it. Give the
  task its own worktree, pass `--force` to `start`, or wait for the other writer. A `start` that
  finds the watcher mid-try waits up to 20 seconds (`AGENT_ORCH_PARK_CLAIM_WAIT`) for it to let go.
- **A babysitter's fix.** When a babysitter's watch attempt ends with `NEEDS FIX:`, the task shows as
  running while the fix attempt starts, with `needs a fix · <reason> · starting its fix attempt at
  the complex tier`. When no fix starts, it shows as `needs-decision` and `wait` exits 5
  (`references/babysit.md`, "Watching and fixing").

## Context cap of Claude agents

Claude Code **compacts** a session, which summarizes its context to shrink it, once the context
passes a set size. Left alone, a session with a 1M-token window compacts only near 967k tokens, and
every call sends the whole context again. When `start` launches a Claude relay, it sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the relay's environment from `AGENT_ORCH_CLAUDE_COMPACT_WINDOW`:

- The default is `300k` (300000 tokens).
- A value from `100k` to `1M` sets it. Forms like `300000`, `300k` and `1m` work.
- `off` leaves Claude Code's own default.
- A bad value falls back to the default without failing.
- A `CLAUDE_CODE_AUTO_COMPACT_WINDOW` already set in the caller's environment, or in `agent-env.json`,
  is kept.
- The attempt records the value used, and `result` prints it on a `compact window:` line.

Codex is unchanged.

## The `Stop` hook

The `Stop` hook `scripts/hooks/orch-stop.mjs` (set up in `integrations/claude/settings.example.json`;
Codex 0.166 and later run it too) blocks ending your turn, once per set of items, while any of these
holds:

- a question, an unread result or an open decision waits on you (a closed task never does, nor
  does a task that a stop ended);
- a task runs with no live `wait`.

## Question dialogs

In Claude Code, a question dialog (the `AskUserQuestion` tool, which asks the user to pick an
option) stops your session until the user answers it. While it is open, nothing reaches you: a
`wait` that exits stays queued, scheduled prompts do not fire, the `Stop` hook does not run, and
messages wait. If the user is away, your tasks' results sit unread for hours.

So while your tasks run, never stop to wait for the user:

- Ask in your reply instead: the question, the options and your recommendation. If the user may be
  away, also send them a message.
- Go on with your recommended option, or with work that does not depend on the answer.
- Keep `wait` running.

The hook `scripts/hooks/orch-ask.mjs` (set up in `integrations/claude/settings.example.json`)
refuses the dialog, and says what is in flight, while one of your tasks runs or is parked, a result
is unread, or a question or decision waits on you. Inside an orch task it always refuses, since
nobody answers a dialog there: decide what the brief covers, and hand back the rest with `ask` or
`NEEDS DECISION:`. `AGENT_ORCH_ASK_HOOK=off` turns it off.

## Automatic retry

When a task fails with a transient provider or network error, `wait` resumes it once in the same
session (`AGENT_ORCH_MAX_RETRIES`, default 1) and prints `retried <task> …`. A deliberate stop, a
timeout and a usage limit are never retried.

## States, phases and health

- A task is **finished** when its relay process has exited. Its **state** is the relay's
  `result.json` status: `completed`, `failed`, `timeout`, `aborted`, or `<cli>_unavailable`.
  `aborted` with no result means the relay died early; read `log`.
- A task reads **`stopped`** when a stop ended its current attempt: `stop`, or `close` of a task
  that still ran, recorded the stop on the task, no later `start` cleared it, and the attempt did
  not end on its own first. A relay records `aborted` on SIGTERM, and a stopped task reads `stopped`
  instead. It raises no attention item, counts as no failure, is never awaiting review or unread,
  and its health is `ok`. Its phase is still `failed`. `start` resumes it and clears the stop.
  `references/agents.md`, "Stopping a task", says what a stop reaches.
- A task counts as running only while its recorded PID is its own relay, the one that writes that
  attempt's folder. A PID that was reused, even by another task's relay, no longer keeps a dead task
  running, and `stop` and `close` never signal it.
- Its **phase** is one of:
  - `prepared`, `running`, `needs-decision`;
  - `parked`: the task ended its turn and its watcher wakes it ("Parked tasks"); `wait` counts it as
    running;
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

## Usage limits

Never weigh any agent's usage when you delegate, choose an agent or tier, or schedule work: never
defer a task, move it to another agent, or do it yourself because a window is nearly used up, and
never mention usage in `--why`. Act only when a task stopped on a usage limit (`USAGE LIMIT` in
`wait` or `result`), never on what `agents` shows, even a window at 100%: team plans add more. Then:

1. Ping the user once per limit, with the agent and the error's reset time if it gives one: a Slack
   DM through the `post-on-slack` skill where it is available, otherwise in your reply.
2. Resume the work on another agent if it is ready (a fresh session, a full brief, and a `--why`
   naming the limit). If all are limited, say so in the ping, and retry once one works again.
