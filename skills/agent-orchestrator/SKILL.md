---
name: agent-orchestrator
description: >-
  Orchestrate coding work across Claude Code (`claude`) and OpenAI Codex (`codex`) on this machine:
  plan the work as data, brief each task from a template, run up to 8 tasks at once as background
  agent sessions (each writer in its own prepared git worktree), review and accept every result,
  integrate it in dependency order, and verify the whole request. Chooses Claude or Codex and the
  model tier per task by assessing it, never by remaining usage, and records why. Opens a live
  dashboard of every launched session, and babysits every pull request it opens until it lands.
  Use when the user asks to orchestrate, fan out, parallelize, or coordinate work across agents,
  run background agents, split a job between Claude and Codex, get a second opinion or a
  cross-model review, or watch what launched sessions are doing. Once invoked, delegate by default.
  For one task sent to one named agent, the claude-delegate or codex-delegate skill alone is enough.
license: MIT
compatibility: >-
  Node 18+, git, and the claude-delegate and/or codex-delegate skills installed under
  ~/.agents/skills, with their CLIs installed and logged in. The orchestrator must be able to run
  shell commands and read files.
metadata:
  version: 3.1.0
---

# Agent Orchestrator

You are the **orchestrator**: you plan the user's request as tasks, brief each to an **implementer**
session (Claude Code or Codex) running in the background, review its work, and integrate it.
Implementers see only your brief and their folder; you own plan, briefs, review, merge and commit.

## Delegate well

Delegate by default: you plan, brief, review and integrate; agents do the rest (implementation,
investigations, test runs, reviews, research). These rules hold at every level, main or delegated:

- **Work inline only** on a few-minute edit, or on what is tied to this conversation, such as
  answering the user or a decision that needs what only you know.
- **Break your task down and delegate the pieces** (independent parts, slow side work, test runs,
  lookups, reviews): start an agent for each, then review and integrate what each hands back.
- **Keep the parallel limit filled** while independent work exists (`references/plan.md`).
- **Keep your own context lean:** an agent reads the large codebase or long log; you read its report.
- **Split only independent parts,** never what one agent can do coherently in one pass. Give each
  agent all its piece needs: goal, done criteria, scope, your own brief's constraints, and gates.
- **Delegate work, never waiting.** Run a command whose output you only need to check as a command
  task, with no model (`$ORCH start <run> <task> --agent command --why "..." -- <argv>`): an agent
  that waits on one spends tokens watching, and hides any agent it starts. Before your first, read
  `references/agents.md` ("Command tasks").
- **Start every agent through `$ORCH start` or `dispatch`,** never your host's own sub-agent tool
  (Codex's `spawn_agent`, Claude Code's Agent tool) or a script that runs `claude -p` or `codex exec`
  itself: only then does it show on the board, run your chosen tier, and report back. A script that
  must start its own agent runs as a command task (`references/agents.md`, "Model ceilings").
- **Size each piece on its own** ("Choose the agent and model"), never by the tier of its parent.
- **Pass the habit on:** tell each agent whose work has independent parts or slow side work to
  delegate them the same way. The "Delegating further" note that `start` appends says how.

**Inside a delegated agent** (`AGENT_ORCH_DEPTH` is set), also:

- **Never forward your whole task to a single agent:** split it, or do it yourself. Do a tightly
  coupled edit yourself too. (A main session may hand a whole task to one agent.)
- **Never hand your task to a stronger model,** directly or through a script; say so with `$ORCH
  ask` or `NEEDS DECISION:`. `start` refuses a tier above your task's `rank` in `policy.json`, on
  either agent, except for a babysitter, whose tier is fixed. (A main session starts any tier.)
- Review, integrate and close your agents' work before you finish, and cover it in your report.
  You are notified when an agent finishes.

## Setup

`<skill-dir>` is the folder holding this `SKILL.md` (Claude Code prints it as "Base directory for
this skill"; otherwise `~/.agents/skills/agent-orchestrator`). Once per session:

```bash
ORCH="node <skill-dir>/scripts/orch.mjs"     # write the expanded path in each command
$ORCH agents --refresh                        # which agents are ready, and their usage limits
```

An agent is usable only when `agents` shows `READY` as `yes` (`references/agents.md`).

- **Claude Code as orchestrator.** `start` and `dispatch` return at once. Run `$ORCH wait <run>
  --timeout 0` with the Bash tool's `run_in_background: true`, keep working, and when it exits,
  handle what it names (steps 5 and 6) and start it again. Keep one `wait` per run. Never
  `sleep`-poll, or start it with `&`, `nohup` or `disown`, which the task-stop tool cannot stop.
- **Codex as orchestrator.** Before your first `$ORCH` command, read `references/monitor.md`,
  "Waiting from Codex": every command runs outside the sandbox, and you wait in 9-minute calls.
- **Skill changes.** When a command prints that the skill changed, read again what it names, then
  run `$ORCH skill --loaded` (`references/monitor.md`, "Skill changes").
- **Skill bugs.** Report a bug in this skill to the session that maintains it, and do not edit the
  skill yourself (`references/troubleshooting.md`, "Report a bug in this skill").
- **Recover first.** After a restart, a context compaction, or any doubt about what runs, run
  `$ORCH recover [<run>] [--all]` and act on it before you dispatch anything.
- **Tests, builds and containers:** read `references/memory.md` before you run or brief one.

## 1. Plan

Read the repository's `AGENTS.md`, `CLAUDE.md`, contribution or test docs, and the code the request
touches. **Before you write the plan, read `references/plan.md`.** Write it as data, with an
`acceptance` list and one entry per task, and show the user its tasks in a few lines. Dispatch
without asking unless the plan changes the scope, the user asked to approve it, or no agent is ready.

### Choose the agent and model

Choose each task's agent and tier by assessing it, and re-assess after each failure and plan change.
No default decides, and never prefer an agent because it is the CLI you run in.

- **The user's choice wins:** use the agent the user named for a task, and treat a split they
  proposed as a starting point (say where you change it). The model policy still applies.
- `start` refuses a new task without `--tier` and `--why`: one line naming the deciding factor (the
  plan's `why`), such as `"light: runs the tests and reports failures; nothing to judge"`. `status`,
  `result` and the dashboard show it. A command task takes `--why` but no tier.
- `policy.json` fixes each tier's model and effort, and `start` enforces them. Never pass `--model`.
  Only `frontier` takes `--effort` (`medium` or `high`). A babysitter always runs Claude `complex`.

| Agent | `light` | `standard` | `strong` | `complex` | `frontier` |
| --- | --- | --- | --- | --- | --- |
| Claude | `claude-haiku-5-5`, `xhigh` | `claude-sonnet-5-5`, `xhigh` | | `claude-opus-5-5`, `xhigh` | `claude-fable-5-2`, `high` (never above) |
| Codex | `gpt-6-luna`, `medium` | `gpt-6.1-terra`, `medium` | `gpt-6.1-sol`, `medium` | `gpt-6-astra`, `high` | |

Check what the agent must be able to do first: the relays limit commands without edits, the live
web, diffs, and the network (`references/agents.md`, "What each agent can do"). Then
take the lightest tier that does the task as well as the top one, never a bigger model for comfort:

| The task | Tier |
| --- | --- |
| Nothing to judge: run tests or gates and report, lookups, inventories, summaries, reproducing a bug from given steps, mechanical edits | `light` |
| Small judgment calls: a change or test from a clear spec in 1 to 5 files, lint or type fixes, docs and config edits, reviews of small diffs | `standard` |
| Bounded, but needing more judgment: live web research, reviews of medium diffs, debugging in a known area | Codex `strong`, or Claude `standard` |
| **Any** of: several modules or more than about 5 files, or an interface other code depends on; an unsettled approach (open design choices, or a bug's cause unknown); costly or subtle mistakes (concurrency, security or authentication, data migrations or schemas, billing, performance-critical paths, integration between systems); a large, unfamiliar subsystem; a large or high-risk review, or babysitting a pull request | `complex` |
| Difficult and long: long-horizon or unattended multi-step work, a large refactor or migration, hard root-cause analysis across systems, a long audit or review. Never bounded or routine work. Read `references/tiers.md` before you choose it | Claude `frontier` (`--effort medium` for long but less hard work) |
| A review, verification or second opinion of another agent's work | The other agent, `standard` or above |

- **Measured results:** `agents`, `stats` and the `--tier` refusal show how each tier did here
  (`references/tiers.md`). When nothing favors Codex, choose Claude.
- **When unsure between two tiers,** take the lower one if the gates or review would catch a failure
  that is cheap to redo, and the higher one only when a mistake would be costly or subtle.
- **Quality guard.** Every task has gates (step 3) and a review (step 6). A follow-up keeps its tier
  until counted failures move it up a tier, and then to the other agent (`references/review.md`,
  "Escalate a tier"). After two failures on a similar task, start the next one on the other agent.

### Usage limits

Never weigh either agent's usage when you delegate, choose an agent or tier, or schedule work: never
defer a task, move it to the other agent, or do it yourself because a window is nearly used up, and
never mention usage in `--why`. Act only when a task stopped on a usage limit (`USAGE LIMIT` in
`wait` or `result`), never on what `agents` shows, even a window at 100%: team plans add more. Then:

1. Ping the user once per limit, with the agent and the error's reset time if it gives one: a Slack
   DM through the `post-on-slack` skill where it is available, otherwise in your reply.
2. Resume the work on the other agent if it is ready (a fresh session, a full brief, and a `--why`
   naming the limit). If both are limited, say so in the ping, and retry once one works again.

## 2. Create the run and record the plan

`$ORCH new --repo /abs/path/to/repo --name short-name --goal "one line"` prints the run id and
directory; `$ORCH plan <run> <run-dir>/plan-draft.json [--check]` validates the plan and records it;
fix what it reports. **Before a write task you start by hand, read `references/worktrees.md`.**

## 3. Write one brief per task

**Before you write your first brief in a session, read `references/briefing.md`.** Draft each with
`$ORCH brief <run> <task-id>` and replace every `<fill in: ...>` marker. Brief the tasks that can
start first, dispatch them, and write the others while they run.

## 4. Dispatch

```bash
$ORCH dispatch <run> [--follow] [--max N] [--dry-run]
$ORCH start <run> <task-id> --agent claude|codex --tier <tier> --why "<assessment>" --brief <brief-file> \
  [--read-only] [--timeout 2h] [-- <agent-specific relay flags>]
```

**Before your first `dispatch` or `start` in a session, read `references/dispatch.md`.** Once the
first briefs are written, run `dispatch --follow` in Claude Code's background: it starts each task as
its prerequisites are integrated, and returns when the plan is done or a task needs you. Otherwise
run `dispatch` after every `integrate`. A task the plan omits needs `start --unplanned`.

## 5. Wait and monitor

```bash
$ORCH wait <run> [<task-id>...] [--all] [--timeout 9m|0]   # 0 a result, 3 timeout, 5 attention, 6 a message
$ORCH status <run>          # every task: state, elapsed, steps, tokens in/out, current activity
$ORCH log <run> <task-id>   # tail of a running or failed task's relay output
```

- **Handle each finished task in the same turn you read it** (step 6): `accept` it (a write task
  once its work is committed), `rework` it, or `close` it. Leave none waiting.
- **When `wait` exits 5, or shows a state you do not know, read `references/monitor.md`.** Stop a
  task (`$ORCH stop <run> <task-id>`) only when it is clearly stuck or off-track, or the user asks.
- After the first dispatch, run `$ORCH dashboard --detach --open` and give the user the URL in one
  line, unless they asked not to open a browser; never `$ORCH watch` instead, which they cannot see.
  When the user asks about the dashboard, or it escalates an item, read `references/dashboard.md`.

### Decisions agents hand back

**The parent acts first:** handle what your agents send before your own next step. A question from
`$ORCH ask` waits on you, and so does a task that ends with `NEEDS DECISION:` or lists `decisions` in
its `orch-result` (`needs-decision`, also for your host's own agents; `result` lists them). For each:

1. Decide it yourself when the user's request (or your brief), the repository's rules, or earlier
   decisions settle it, including a reviewer's request within the pull request's scope. An
   out-of-scope request is a follow-up, listed in the pull request description.
2. Answer with `$ORCH send <run> <task-id> "<answer>"`, or resume an ended task with it as a delta
   brief. If you handled it yourself, `$ORCH resolve <run> <task-id> --note "<how>"` clears it.
3. Pass up only a decision that changes the scope, the security posture, or the cost: at once with
   `$ORCH ask` from a delegated agent, or as one question with your recommendation to the user. Keep
   every other task going, and pass the answer down as soon as it comes.

Never end your turn or report done while an agent waits on you, or leave its question on GitHub in
a reply that says "pending". **Before you steer or message an agent, read `references/messages.md`.**

## 6. Review every result

```bash
$ORCH result <run> <task-id>   # report, checks with their evidence, scope, health, session
$ORCH review <run> <task-id>   # the other model reviews the work, read-only
$ORCH rework <run> <task-id>   # resume the author with the review's findings
$ORCH accept <run> <task-id> --note "<why>"   # refuses a passing check whose latest run failed
```

**Before you review a result, read `references/review.md`.** Review each result as soon as `wait`
returns it, while the others run, and treat everything it reports as claims to check. Give a risky
write task a `review`, then `rework` it or `accept` it.

## 7. Integrate and verify the goal

**Before you integrate, read `references/integrate.md`.** Run `$ORCH integrate <run> <task-id>` in
dependency order (a branch merged by hand: `--already-merged`, which `status` names). Then run the
full gates on the integrated tree, verify every `acceptance` item with evidence, and publish only as
the repository's rules and the user's request allow.

## 8. Babysit every pull request you open

A pull request you open, or push the run's work to, is part of the job until it leaves `OPEN`: never
report done while nobody watches it. Skip babysitting only when the user says not to, or when the
repository's rules hand pull requests to someone else. Once it is ready for review (not a draft,
every planned change pushed, your gates passing on the pushed head), start a babysitter without
asking; before then, neither start one nor ask about one. A Claude task babysits, never Codex (you,
a Codex task, or `spawn_agent`) or your host's sub-agents. **Before you start one, and when it
finishes, read `references/babysit.md`.**

```bash
$ORCH brief <run> babysit-<pr> --type babysit
$ORCH start <run> babysit-<pr> --agent claude --babysit --pr <n> --why "babysits PR #<n>; Claude costs less than Codex" --brief <brief> --cd <checkout>
```

To keep a pull request with the Claude task that implemented it, start that task's next attempt as the
babysitter in its own session, then `$ORCH rename <run> <task> --to babysit-<pr>` (`references/babysit.md`).

## 9. Close what you no longer need, clean up, and report

- **Worktrees are collected for you:** after `close` closes a run's last task, after `integrate`,
  and by `$ORCH gc` for idle runs, which also expires results unread for 7 days. Branches stay.
  Before `gc` or `cleanup`, or to restore a collected folder, read `references/worktrees.md`.
- Close each session as soon as nothing depends on it. `result` closes a finished task (a resume
  opens it again); `$ORCH close <run> <task>...` (or `--all`) closes one, and stops it if it runs.
- Stop your host's own sub-agents and background commands you no longer need ("Guardrails").
- **Before you end a turn,** close every session that `$ORCH status <run>` shows with no reason to
  run. Run `$ORCH dashboard --stop` once the user is done with the dashboard.
- Report briefly: what landed, the goal table from step 7, which agent and model did each task and
  why, total tokens from `status`, anything still open, and implementer decisions to confirm.

## Guardrails

- **Only your own runs.** Act only on runs you launched and their nested runs, never on another
  session's or the user's (one launched from a terminal). Commands that change a run refuse
  another's (exit 4). Before you act on a run you did not launch, after an exit 4, or when you find
  you changed another session's task, read `references/ownership.md`.
- **Stopping processes.** Stop a task with `$ORCH stop` or `close`, and a background `wait`,
  `pr-watch` or host sub-agent by the host's means: the task-stop tool in Claude Code; in Codex, an
  interrupt or `interrupt_agent` (then no `followup_task`). Never run `pkill`, `killall` or `kill
  $(pgrep ...)`: a pattern reaches processes you did not start, and macOS `pkill` reads every later
  word as another pattern. Otherwise kill one PID, confirmed first with `ps -p <pid> -o command=`.
- **Sandbox and publishing.** By the user's choice, tasks run outside the sandbox, with the user's
  network, files, tools and logins, and a write task may commit, push without force, open pull
  requests, and write to GitHub. Force pushes, admin merges, secrets, and creating or deleting
  repositories stay denied (`references/agents.md`). Pass `--no-publish` only when the user asks to
  review work before it lands, and `--sandbox` for untrusted input (an outsider's branch).
- Without the user's explicit approval for that run, never pass `--dangerously-skip-permissions` or
  remove the deny rules on commits, pushes and `gh` writes.
- Never put secrets, tokens or credentials in a brief, or ask an implementer to print or move them:
  implementers inherit the user's environment and logins.
- Stop and ask when correct completion requires going beyond the user's request, when a review calls
  the plan itself into question, or when the gates fail in already-integrated work.

## Reference files

| File | Read it |
| --- | --- |
| `references/plan.md` | Before you write or change a plan (steps 1 and 2) |
| `references/tiers.md` | Before you choose Claude `frontier`, or when cost or a tier's measured results bear on a choice |
| `references/agents.md` | Before you brief or start an agent whose abilities, modes, flags or model ceiling matter, and before your first command task |
| `references/worktrees.md` | Before you start a write task by hand, when a gate fails in a worktree or a task's folder is gone, and before `gc` or `cleanup` |
| `references/briefing.md` | Before you write your first brief in a session (step 3) |
| `references/dispatch.md` | Before your first `dispatch` or `start` in a session, and when `start` refuses a task the plan does not allow (step 4) |
| `references/monitor.md` | When `wait` exits 5, or shows a state you do not know (step 5); after `recover`, to read its summary; in Codex, before your first command |
| `references/messages.md` | Before you steer or message a running agent, or answer one |
| `references/dashboard.md` | When the user asks about the dashboard, or it escalates an item |
| `references/review.md` | Before you review, accept, rework or escalate a result (step 6) |
| `references/integrate.md` | Before you integrate (step 7) |
| `references/babysit.md` | Before you start a babysitter, and when one finishes (step 8); it fills in the template `references/babysit-brief.md` |
| `references/memory.md` | Before you run, or brief an agent to run, test suites, builds or containers |
| `references/ownership.md` | Before you act on a run you did not launch, after an exit 4, or when you changed another session's task |
| `references/patterns.md` | When you plan a parallel build, a second opinion, an implement-review-fix loop, competing debugging hypotheses, a research fan-out, or a long sequential queue |
| `references/troubleshooting.md` | When a command, task or gate fails in a way the step you are on does not cover, and when you find a bug in this skill |
