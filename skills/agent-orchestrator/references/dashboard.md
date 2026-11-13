# The dashboard

Read this when the user asks about the dashboard, or when it shows or escalates something you must
act on. `SKILL.md` step 5 says when to open it.

## The server

- `$ORCH dashboard --detach --open` starts a web server on `127.0.0.1:4777`, or reuses the running
  one, and opens it unless a tab already shows it.
- It exits by itself once no task is running and no tab has shown it for 30 minutes.
  `$ORCH dashboard --stop` stops it sooner.
- `$ORCH watch` shows the same tree in a terminal, for a user who asks for it.

## What it shows

- One section per launching session, holding all of its runs, and each child session: agent, model,
  why that agent was chosen, state, steps, tokens, session id, and current activity.
- Clicking a session shows its final report and its live event log. The log opens at the newest
  events and follows new output while the reader is at the bottom.
- For a task, the panel also shows its receipts: its brief, one line per attempt (clicking one shows
  that attempt's log), each check's saved evidence, and your `verify` runs, `verdict` rounds and
  acceptance.
- The header shows both agents' usage limits.
- A main session's state comes from `claude agents --json` when Claude Code reports that session
  (`stateSource` on the row), and from its transcript otherwise. Codex's app server is read only with
  `AGENT_ORCH_CODEX_APP_SERVER=1`, because a standalone server cannot see threads another Codex
  process runs.

## Messages to a task

The box under a task's details sends it a message (`references/messages.md`).

- **The waiting list.** Above the box, "Waiting for the agent (N)" lists every message the agent has
  not read yet, oldest first. Each row shows who sent it, when, how long it has waited, and its text.
  A message just sent from the page shows at once as "sending…", until the board lists it. A long
  list scrolls inside its own area, so the box stays in view. The list shows only while a message
  waits.
- **The delivery line.** Under the heading, one line says when the agent will read the messages, for
  example "It reads them after its next tool call." It is the line `$ORCH inbox` prints. A message
  that has waited 30 seconds adds a hint about interrupting.
- **The row marker.** A row with unread messages shows `✉ N waiting` after its name, and its tooltip
  lists them with their senders. Every row that takes messages shows it: a nested run's task, a
  renamed task, a babysitter, and a command task's row.
- **Idle tasks.** A task that ended its turn and waits on its own background command shows
  `running · idle`, and its activity says what it waits on. It reads nothing until that command ends.
  So a message from the box interrupts it at once, even with the Interrupt option off: its session
  is stopped and resumed with the message. While that resume runs, the row shows
  `running · resuming`.
- **Send now and the Interrupt option.** "Send now" in the waiting list, and a send with the
  Interrupt option on, deliver at once. What they do depends on what the agent is doing:
  - In a shell command: the command is stopped, so the agent reads the messages. A commit, push or
    other publishing command is never stopped; the messages wait for it.
  - Not in a shell command: the session is stopped and resumed in the same session, with the unread
    messages as its next prompt. This is a new attempt, with the reason `interrupt`, and every relay
    option of the attempt it replaces. The resume is checked first: one that cannot start stops
    nothing.
  - A babysitter, a parked task, a command task, a task whose session id is not known yet, and one
    with a publishing command still running are not interrupted. The messages wait for its next
    step (`references/messages.md`, "The interrupt").
- **The status line.** The line under the box says which of these happened: "Stopped `npm test` …
  so it reads it now", "Interrupted: the agent … so its session is resuming with the message", or
  "Not interrupted: …" with the reason. When another interrupt is already resuming the session, it
  says so.

## The attention lane

It lists what needs someone: questions from running agents, decisions, failures, results awaiting
review, and silent, stuck or unreachable tasks (`references/monitor.md`).

- An item for the agent that must act (the orch task that started the task, or the session that
  launched a top-level run) shows muted, "for <agent>", and never counts in the header's "N need
  attention".
- The user's items are usage limits, `ask --user`, runs started from a terminal, and items whose
  agent is gone.
- An agent is gone when it is an orch task that no longer runs, or a session whose process ended, or
  that has had no live `wait` on the run (parked ones count) for `AGENT_ORCH_AGENT_GRACE` (default
  15m, at least twice `AGENT_ORCH_PARK_MAX`).
- A decision handed back in a top-level run goes to its session first.
- A babysitter never awaits review.
- An `unreachable` item is a running task that ended its turn and waits on its own background
  command while a message waits unread. Nothing reaches it until that command ends, so it does not
  wait to show as silent. The item names the `steer` command that delivers the message now, and so
  does "Send now". It comes after stuck and before awaiting review (`references/messages.md`, "Idle").
- A review left waiting longer than `AGENT_ORCH_REVIEW_STALE` (default 24h) leaves the lane;
  `recover` still lists it.

## Escalation

A user's item that stays unhandled for `AGENT_ORCH_ESCALATE_AFTER` (default 10m), or a decision or
question that stays unhandled for `AGENT_ORCH_DECISION_ESCALATE_AFTER` (default 2m, or the first
when that is shorter), goes to the user once. The check runs every tenth of the shorter delay, from
1 to 10 seconds. It reaches the user while the dashboard runs, even with no tab open, through:

- a macOS notification (`AGENT_ORCH_NOTIFY=off` turns it off);
- a browser notification;
- the command in `notify.json` under the state root (`~/.local/state/agent-orchestrator`, or
  `AGENT_ORCH_HOME`), if that file exists: `{"command": ["/absolute/program", "arg"]}`, which gets the
  item as JSON on stdin.

An item for an orch task goes to that task instead, once, as an inbox message with what to do. One
for a session sends nothing, since its `wait` wakes on it. Once that agent is gone, or cannot take
the message, the item goes to the user and says so ("orchestrator session 425c2bc2 is gone (…);
review-me has waited 25m for review"). So review results as `wait` returns them, and handle
attention as soon as `wait` exits 5.

## Agents it finds on its own

- **Agents a task's shell starts.** A task whose shell starts headless agents (a script that runs
  `claude -p` or `codex exec`, such as a review script) shows them, whatever the script or model.
  A finished agent stays listed while its task shows. Which agents are seen with no dashboard
  running is in `references/agents.md`, "Agents started outside the orchestrator".
  - **A command task** has no model, so the agents its command runs are its work, and they get no
    rows. Once the board finds one, the task's row shows it:
    - The model, session and event log are those of the lead agent: the one of the latest
      attempt, a running one first, then the most recently active. When its agents ran more than
      one model, the model reads `+N` for the others.
    - The steps and tokens include the agents', and the section's totals count them once.
    - The activity is the lead agent's while it and the task both run, and the command's latest
      output line otherwise.
    - The details list each agent: its kind, model, state and session.
    - The log of an earlier attempt is the command's own output.
    - The agents' own Agent-tool sub-agents, and any run they launch, nest under the task's row.
  - **Any other task** gets one row per agent, nested under the task. The row shows the agent's own
    kind, model, state, steps, tokens and activity, and its details show its events, read from its
    transcript. Its tokens count in the section's totals, not in the task's own cell. After a
    resume, the row says which attempt started it. The agent's own Agent-tool sub-agents, and any
    run it launches, nest under its row. The task's details list its agents in one line, each
    linking to its row.
- **Native sub-agents.** It lists, as `native`, the sub-agents that the launching session or its
  tasks started with their host's own tool. It sums Codex's automatic approval reviews into one row
  per parent, as `status` and `watch` do. Other Claude Code sessions whose sub-agents ran recently
  get a section too: a personal `SubagentStart` hook starts the dashboard and opens it unless a tab
  shows it. `references/agents.md` ("Native sub-agents") says how they are found.
- **External agents.** It lists, as `external`, the headless Codex and Claude Opus agents
  (`codex exec`, `claude -p`) that a script under `~/.agents/`, `~/.claude/` or a skills folder
  started from a session, outside the orchestrator, such as a review script's `codex exec review`.
  Each goes under the session that ran the script, named after the script (`codex-review`), and
  stays listed after it exits. Its own sub-agents get no rows, and a Codex agent's sub-threads
  count in its tokens. One started from a task's shell is not an external row: the first bullet
  covers it. Such an agent takes no messages and skips the model policy, so start agents through
  `$ORCH start` when they can take a brief. A script that must run its own `codex exec` or
  `claude -p` is seen with no dashboard running when it runs as a command task.
  `references/agents.md` ("Agents started outside the orchestrator") says how they are found.

## Model ceiling warnings

A command task that has a ceiling (`references/agents.md`, "Model ceilings") shows a warning in its
activity column, after its current activity, for each agent that goes past it:

- `⚠ <agent> (<cli> <model>) exceeds the <tier> ceiling`: `policy.json` lists the model for that
  CLI, and it is stronger than the ceiling.
- `⚠ <agent> (<cli> <model>) unrecognized model`: `policy.json` does not list the model for that
  CLI, so it cannot be compared with the ceiling.

The warning covers every agent that the command ran, in any attempt, and the Agent-tool
sub-agents of its Claude agents, at any depth. An agent whose model is not known yet gets none. A
Codex agent's sub-threads and a Claude Workflow's agents have no rows, so they are not checked. A
task with no ceiling gets no warning, and neither does an agent task.

The warning only informs: nothing is stopped. It stays while the agent is listed. To clear it, find
where the script or sub-agent names that model, and change it.

## Idle runs

A run or session leaves the dashboard once nothing in it has run for `AGENT_ORCH_BOARD_IDLE`
(default 2h); `status` and `result` still read it. A finished row with nothing left for anyone (its
result was read, accepted or closed) folds behind "show N older" at once. A row that is not
finished and not running (prepared, parked, idle or stopped) folds once it has been quiet for
`AGENT_ORCH_ROW_IDLE` (default 1h). A row that runs or needs attention never folds, and a row stays
while a row under it stays. The page folds them again each time it loads.
