# Changelog

## 2.2.0 (2026-11-12)

- An interrupt reaches a running agent in every state. `send --steer`, `steer` and the dashboard's
  Interrupt stop the agent's shell command, as before; when it is not in one, they stop its session
  and resume it in the same session with the unread messages, as a new `interrupt` attempt that
  keeps the task's relay options and counts as no failure. It did nothing outside a shell command.
- A task that ended its turn and waits on a background command or sub-agent of its own reads as
  idle. With a message unread it is flagged `unreachable` at once, a plain `send` says the message
  will not be read until that wait ends, and a message from the dashboard's box interrupts it.
- An interrupt is refused, with the reason, for a babysitter or parked task, a command task, a
  session not known yet, and while a publishing command such as `git push` runs.
- The dashboard lists every message that waits for the agent above the message box, with who sent
  it and when the agent will read it, and each row with waiting messages shows "✉ N waiting".
  `inbox RUN TASK` prints the same delivery line.
- One claim covers every way a task is resumed (`start`, retry, rework, escalation, the park
  watcher, an interrupt), so two of them cannot start the next attempt together, and `stop` and
  `close` cancel a resume that is between its two relays.
- While a publishing command holds an interrupt back, the delivery line, the attention item, a
  plain `send` and `inbox` say that an interrupt waits for that command too, and offer none.
- The waiting list above the message box shows each message whole, on its own lines under who
  sent it and when; it cut the text to a few words. The older "mid-step" hint no longer shows
  under the board's own line on when the agent reads them, which it could contradict.

## 2.1.1 (2026-11-12)

- A Claude session's row shows a `/model` or `/effort` change as soon as the command runs. The
  row took both from the session's latest reply, so it kept the old setting until the next turn.
- A command Claude Code runs itself, such as `/model` or `/effort`, no longer makes an idle
  session's row show `running`. Its record read as a new prompt, so the row stayed `running` for
  up to 30 minutes.
- `result` and `accept` find a check that an agent ran as a command task of its own run
  (`start --agent command -- CMD`), with that task's exit code. They read only the agent's own
  log, which has the `start` call and not the command, so such a check read `NOT FOUND in the log`.
- The three skills ask an agent that finds a bug in them to report it to the session that maintains
  the skill, and not to edit the skill (`references/troubleshooting.md`, "Report a bug in this
  skill"). A delegated agent sends it to whoever started it.
- Only a question holds a finished task open as `needs-decision`. An agent that listed a choice
  it had already made under `decisions` ("Merged 3 and 4") was held open until resolved or
  resumed; `result` now shows such an entry as a choice that needs no answer.
- `questions RUN [TASK] [--all]` prints agents' questions in full, with their options and
  recommendation. `send` and the dashboard's box record each answer as a line in the task's
  `answers.jsonl`, so `wait`, `inbox` and the Stop hook agree on which questions are open. `wait`
  names the command when a question ends it, and so does `inbox RUN` without a task.
- A task prepared with `worktree`, never started and then closed shows as `closed` ("closed before
  it started") in `status`, `wait` and the dashboard, where it stayed `prepared`. `close` says
  what it did with the worktree, and preparing the task again reopens it.
- `recover --all` is about three times faster on a state folder with hundreds of runs. It
  described every task of every run before it left out the runs with nothing to resume, and
  checked worktrees one at a time; it now filters first and checks four worktrees at once.
- `wait` keeps waiting when a task sends a `tell` note, which needs no answer, and prints every
  held note with its next exit. Each note ended `wait` with exit 6, so a task that sent several
  woke its orchestrator for a turn each time. `wait --notes` keeps the old behavior.
- `pr-watch` counts only the latest run of each check on the head commit. A run that was
  cancelled when a newer run of the same check replaced it was counted as a failed check, so a
  babysitter saw red CI on a pull request whose checks had all passed.
- The dashboard folds a finished row behind "show N older" at once when nothing is left to do
  with it (its result was read, accepted or closed). It waited `AGENT_ORCH_ROW_IDLE`, which now
  applies only to a row that is not finished: prepared, parked, idle or stopped.

## 2.1.0 (2026-11-11)

- `rename RUN TASK --to NAME` gives a task a name. `status`, `wait`, `result`, `recover`, `stop`,
  the Stop hook, the finish notice to a parent task and the dashboard (rows, the attention lane,
  the details panel) show the name in place of the id; `result` and the details panel also show
  the id and earlier names. Every command that takes a task takes the name too, in that run, and an
  id always wins over a name.
- The id stays the key of the task's folder, inbox, worktree, branch, nested runs and park watcher,
  so a rename restarts nothing, on a running, parked, finished or closed task. The task records
  each name with when and who set it, and `--to` its own id removes the name.
- The run's owner renames any of its tasks. A task's own agent may rename itself, and the owner
  gets a notice of it, as of a change by the user. One rename at a time checks and saves a name in
  a run, so two tasks cannot both take one name.
- An implementer can keep its pull request: `start RUN TASK --babysit --pr N -- --session ID` makes
  the finished task its babysitter in the same session, with one row, its attempts and its tokens,
  and `rename` then names it `babysit-N`. `start` now keeps that babysitter brief as the one a fresh
  session starts from after a handoff, where before it kept the implementer's.

## 2.0.2 (2026-11-10)

- `gc` prints only the runs with something to report, names the owner of each run it refuses,
  shows sizes in MB or GB, and ends with one line of totals. Before, a "freed 0 bytes" line for
  every run with nothing removed buried the result.

## 2.0.1 (2026-11-10)

- `gc` and the automatic cleanup now accept a worktree whose commits any local or remote-tracking
  branch holds, not only the task's branch or the run's base. A babysitter's worktree sits on its
  pull request's branch, so these were all kept. A commit that only a detached HEAD holds still
  keeps its worktree.

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
