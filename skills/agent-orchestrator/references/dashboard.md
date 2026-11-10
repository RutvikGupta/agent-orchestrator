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

## The attention lane

It lists what needs someone: questions from running agents, decisions, failures, results awaiting
review, and silent or stuck tasks (`references/monitor.md`).

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

- **Agents a task's shell starts.** A task whose shell starts headless agents (a wrapper script that
  runs `claude -p` or `codex exec`, such as a review script) gets one row per agent, nested under the
  task. The row shows the agent's own kind, model, state, steps, tokens and activity, and its details
  show its events, read from its transcript. Its tokens count in the section's totals, not in the
  task's own cell. After a resume, the row says which attempt started it. A finished agent stays
  listed while its task shows. The agent's own Agent-tool sub-agents, and any run it launches, nest
  under its row. The task's details list its agents in one line, each linking to its row.
- **Native sub-agents.** It lists, as `native`, the sub-agents that the launching session or its
  tasks started with their host's own tool. It sums Codex's automatic approval reviews into one row
  per parent, as `status` and `watch` do. Other Claude Code sessions whose sub-agents ran recently
  get a section too: a personal `SubagentStart` hook starts the dashboard and opens it unless a tab
  shows it. `references/agents.md` ("Native sub-agents") says how they are found.
- **External agents.** It lists, as `external`, the headless Codex and Claude Opus agents
  (`codex exec`, `claude -p`) that a skill's script started from a session, outside the
  orchestrator, such as a review script's `codex exec review`. Each goes under the session that ran
  the script, named after the script (`codex-review`), and stays listed after it exits. One started
  from a task's shell is not a row of its own: the task's row stands for it. Such an agent takes no
  messages and skips the model policy, so start agents through `$ORCH start` when they can take a
  brief. A script that must run its own `codex exec` or `claude -p` needs no runner task to be seen.
  `references/agents.md` ("Agents started outside the orchestrator") says how they are found.

## Idle runs

A run or session leaves the dashboard once nothing in it has run for `AGENT_ORCH_BOARD_IDLE`
(default 2h); `status` and `result` still read it. Rows quiet for `AGENT_ORCH_ROW_IDLE` (default 1h)
fold behind "show N older".
