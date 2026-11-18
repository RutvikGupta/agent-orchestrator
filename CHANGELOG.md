# Changelog

## Unreleased

- Waiting needs no model, now said for a wait followed by fixed commands too (wait for a sync, then
  trigger a run): it is one command task, never an agent of any tier, and an agent that must judge
  after a wait parks. `SKILL.md`, the delegation note `start` appends, `references/agents.md` (a
  wait-then-trigger example) and the policy notes say so, and `start` notes a model task whose
  `--why` describes waiting.
- The dashboard no longer stands still after the machine sleeps. Its server timed each build on the
  wall clock and then rested twice that long, so a build in flight through a sleep counted as a build
  that long: the board stayed as it was for twice the sleep after waking (reads got the old board,
  with no stale mark), or, past `AGENT_ORCH_BUILD_KILL_TIMEOUT`, the worker was stopped as hung.
  Builds are now timed and paced on a clock that stops while the machine sleeps or the server is
  stopped, and the rest between builds is at most a minute. The page gives up a board read that gets
  no answer in 20 seconds and reads again, instead of waiting behind it until a reload.
- Dashboard colours: a parked task shows in teal (its state, dot and tree line) instead of the idle
  grey. A finished task whose result waits on review gets a purple-tinted row and a purple dot that
  pulses like a running task's.
- Dashboard: a long message in a task's thread, the "Messages" heading and the "Waiting for the agent"
  heading fold and open from a click anywhere on their row, not only on the arrow. A click on a
  button inside the row, or one that ends a text selection, leaves it as it is.
- A Claude session that Claude Code lists as busy only because a command it started in the background
  runs (a `wait`, a test run) shows as idle on the dashboard once its transcript has ended the turn
  and been quiet for 15 seconds, instead of running.
- Codex `strong` runs `gpt-6.2-sol` (was `gpt-6.1-sol`) and `complex` runs `gpt-6.2-astra` (was
  `gpt-6-astra`), at the same efforts (`medium` and `high`).
- `result` says when a final message has a `PARKED:` line that is neither its first line nor the last
  line before the `orch-result` block, so the task did not park.
- A parked task whose watcher cannot resume it now says so. When the watcher's tries are refused
  (another task writing in the same checkout, say) for `AGENT_ORCH_RESUME_BLOCKED_AFTER` (default
  `10m`), the task gets a `resume blocked` attention item: `wait` exits 5, and `status`, the
  dashboard and escalation show it, with what to do. `send` says the message is stored and the
  resume blocked, instead of promising a resume in seconds. A `start` that meets the watcher's claim
  waits up to 20 seconds for it (`AGENT_ORCH_PARK_CLAIM_WAIT`) instead of being refused with "its
  watcher is resuming it right now" while the watcher was not resuming anything.
- An agent no longer starts a second process on a Claude or Codex session that still runs. The
  Claude Code hook `scripts/hooks/orch-resume-guard.mjs` (matcher `Bash`, registered in
  `integrations/claude/settings.example.json`) refuses `claude --resume`, `claude -r`, `codex resume`
  and `codex exec resume` of a running session, also inside `tmux`, `nohup` or `bash -c`, and tells
  the agent to message the session; `start ... -- --session <id>` refuses the same. A session
  restarted under a new name had looked ended, and a copy of it ran beside the original.
  `AGENT_ORCH_RESUME_GUARD=off` turns the hook off.
- A Codex task stopped by a workspace spend cap ("You hit your spend cap set by the owner of your
  workspace") now reads as a usage limit (`USAGE LIMIT` in `result`, "stopped on a usage limit" in
  `wait`), not as an ordinary failure.
- A session that two Claude processes run (a second `claude --resume` in another terminal or tmux)
  shows the state of its most active process on the dashboard, not of whichever one Claude Code
  lists last: an idle duplicate made a working session read idle.
- A pull-request babysitter watches on Claude `standard` (Sonnet) by default. A watch attempt that
  ends with `NEEDS FIX: PR #<n> ...` resumes the same session at once on `complex` (Opus) to fix,
  push, reply and park; the next wake watches on `standard` again (`references/babysit.md`).
- Any Claude or Codex task that waits for something outside it parks: `orch.mjs park-until
  [--every] [--for] -- <command>`, then a final line `PARKED: waits for <what>`. A watcher with no
  model resumes the same session when the command exits 0, the deadline passes, a message arrives,
  or one of its child tasks finishes. `nap` refuses once a task's naps pass 10 minutes in one attempt.
- Claude agents run with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `AGENT_ORCH_CLAUDE_COMPACT_WINDOW`
  (default `300k`), so their context stops growing to about 1M tokens. A resume after the prompt
  cache expired, or onto another model, starts a fresh session from the handoff note when the last
  call was above 60k tokens.
- The skill's model ladder sends work to the lightest tier that does it well: `frontier` only for
  design and difficult work, and waiting to command tasks or parked tasks. Claude is no longer the
  default implementer: the choice between Claude and Codex compares their measured records, which
  `stats` now shows by agent, tier and task type. A Codex implementer hands its pull request to a
  Claude babysitter through a handoff note.
- `accept --unverified "<reason>"` accepts a task whose working folder was removed, and `close`
  takes a completed task out of "awaiting review".
- A live relay no longer reads as dead when `ps` cannot list the process table (it times out on a
  heavily loaded machine): `status` and `wait` reported such a task aborted, and `start` could launch a
  second agent for it.
- A dashboard build past `AGENT_ORCH_BUILD_TIMEOUT` (now `2m`, was 30s) only marks the board stale and keeps
  running; the worker is stopped as hung only past `AGENT_ORCH_BUILD_KILL_TIMEOUT` (5m). Stopping it at
  30s threw away its caches, so on a busy machine every replacement started cold and the board stayed
  stale.
- On macOS, relays, the finish and park watchers, the interrupt's resume helper and
  `dashboard --detach` start through a one-off launchd job, so quitting the terminal application
  no longer ends them. A direct start is the fallback, and `AGENT_ORCH_LAUNCHD=off` turns this off.
  A task whose folder or repository is in a folder macOS guards (Desktop, Documents, Downloads,
  iCloud Drive, another volume) still starts directly, because a process launchd starts would wait
  there for a privacy prompt; `AGENT_ORCH_LAUNCHD=on` sends it through launchd too.
  Tasks record `launch`, `result` shows a direct start, and `agents` says whether agents start
  outside the terminal (`references/agents.md`).
- A Claude Code hook, `scripts/hooks/orch-ask.mjs`, refuses a question dialog while the session's
  tasks run or wait on it, and always inside an orch task (`AGENT_ORCH_ASK_HOOK=off`): a dialog
  stops the session, and task results, messages and scheduled prompts do not reach it meanwhile.
  The board and notices no longer call a session gone while its process is alive.
- The dashboard's elapsed time counts up live for a running row and shows no seconds past one
  minute. The page's hover pop-ups that explained a control or summed up a row are gone; the few
  left hold a value shown nowhere else or cut short (a stale board's reason, a warning's detail,
  usage reset times, a link's address).
- The dashboard's state column shows the state only (the attempt counts are in its tooltip), and
  a section's heading shows at most about 60 characters of its title, and the whole title under
  it once the pointer rests on it. The heading's tooltip with the run's details is gone.
- The dashboard's tree is easier to follow: one line per parent, centred under its arrow and drawn
  to the bottom of its last child's row; each stretch, and each arrow, has the status colour of
  its row.
- In the details panel a long message folds to its first line; the arrow before it, or the one in
  the "Messages" heading for all of them, opens and folds it.
- `stop`, and `close` of a running task, also stop every task below it (the runs it created, and
  theirs), and list them in one line. A stop used to leave an agent's own sub-agents running.
- A task that a stop ended reads `stopped`, not `aborted`: no attention item, no failure, no unread
  result. An item whose agent is not running goes up the chain to the agent above, and says whom
  it passed; the run owner's `wait` shows it.
- Worktree creation refuses below `AGENT_ORCH_MIN_FREE_DISK` (default 15GB) of free disk, after
  first collecting unused worktrees; that collection stops at `AGENT_ORCH_COLLECT_TIMEOUT` (60s).
- `gc` also collects runs whose launching session has certainly ended, and only worktrees inside a
  run's folder. The dashboard runs `gc --auto` (24h idle, 1h on a low disk; `AGENT_ORCH_AUTO_GC=off`).
- The dashboard header shows free disk, amber when low and red below the minimum, and its first
  build gets `AGENT_ORCH_FIRST_BUILD_TIMEOUT` (default 5m) instead of 30 seconds.
- A machine-wide agent limit: `AGENT_ORCH_MAX_TOTAL` (default 75% of RAM in GiB, at least 4) and
  `AGENT_ORCH_MIN_FREE_AGENT` (default 1.5GB). `start` exits 7 or waits with `--wait [DUR]`,
  `dispatch` keeps such tasks ready, and `agents` shows the numbers. The limit is a load control:
  a start the system pauses as it spawns can put one task over it.
- A babysitter parks when the `PARKED:` line is the last line of its final message, as well as
  when it is the first. An agent told to end with the line was recorded as completed, with no
  watcher on its pull request. `status` starts the watcher of an attempt that ended that way.

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
- On the dashboard, a finished agent's sub-agents stay closed under its row, on every page load
  too, even while one of them still runs; the row then reads "+N hidden · M running". A row opens
  by itself only for a running agent or a main session with a running row under it. Finished rows
  stay listed until they have been quiet for `AGENT_ORCH_ROW_IDLE`, whose default is now 30m (was 1h).
- The waiting list above the message box collapses to its heading, with the count, and opens
  again from the arrow beside it; the choice is kept in the browser for every agent.
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
