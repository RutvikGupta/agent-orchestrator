# Agents: how each implementer behaves

Read this before you brief or start an agent whose abilities, modes, flags or model ceiling matter,
and before your first command task. Facts come from each delegate skill's relay
(`~/.agents/skills/<agent>-delegate/`). Its `SKILL.md` and `references/dispatch-and-poll.md` remain
the authority on flags; check `relay.mjs --help` for the installed version. Which agent and tier to
use is decided in `SKILL.md` ("Choose the agent and model"); the models live in `../policy.json`.

## What each agent can do

These are hard limits of the relays on this machine:

- **Run commands without editing** (reproduce a bug, run tests or scripts and report, read
  `git log`): Codex `--read-only`. On Claude, use a write task whose brief forbids edits (see
  `--read-only` below).
- **Look things up on the live web:** only Codex, with `-- --web-search live`. The Claude relay
  removes Claude's web tools.
- **Review a diff on its own:** Codex can run `git diff`. A Claude reviewer needs the diff pasted
  into its brief.
- **Network access** (GitHub, package installs, APIs): every write task has it; a read-only Codex
  task does not (see "Unavailable in the child" below).

## Modes and flags

| | Claude Code (`claude`) | Codex (`codex`) |
| --- | --- | --- |
| Model and effort | `--tier` picks them (`SKILL.md`, "Choose the agent and model") | `--tier` picks them (`SKILL.md`, "Choose the agent and model") |
| Loads project instructions | `CLAUDE.md` (not `AGENTS.md`) | `AGENTS.md` (not `CLAUDE.md`) |
| Write mode (default) | `acceptEdits`; file tools can read and write home and the agent's `$TMPDIR`; only Read, Glob, Grep, Edit, Write, and shell tools; no shell sandbox, shell pre-approved; publishes as `SKILL.md` ("Guardrails") allows, and nested `claude` is denied; `--no-publish` denies `git commit`, `git push` and `gh` writes | `danger-full-access`: no sandbox, full network; nothing denied beyond the brief |
| `--read-only` | `plan` mode with Read, Glob, and Grep across home and the agent's `$TMPDIR` (no shell), including with `--offline` or `--sandbox`; reports `readOnlyViolation` | `read-only` sandbox, enforced by Codex; shell commands such as `git diff` and tests still run |
| Session id (for `-- --session`; a follow-up's tier: `references/review.md`, "Escalate a tier") | `sessionId` | `threadId` |
| Token usage | Per message while running; exact totals at the end (also an estimated cost, which the views do not show) | Totals per completed turn; no cost |
| Useful relay flags | `--max-turns N`, `--max-budget-usd N`, `--autocompact 400k` (network and babysitter flags are set by `start`) | `--network-access`, `--web-search live`, `--ignore-user-config` |
| `--confine` | File tools stay in the working directory; shell access is unchanged | Unchanged |
| Credential file tools | Read, Edit and Write deny `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.claude/.credentials*`, `~/.codex/auth.json`, `~/.config/gh`, `~/.config/graphite`, `~/.config/github-copilot`, `~/.boto`, `~/.kube`, `~/.fly`, `~/.gnupg`, `~/.npmrc`, `~/.claude.json`, and the resolved orchestrator dashboard token; configured Claude/Codex paths are also denied. An unsandboxed shell can still read these files | Unchanged |
| `--sandbox` | Write-task file tools stay in the working directory. Shell sandbox: writes only in the working directory and tool caches; network to every host; GitHub over HTTPS | `workspace-write` sandbox with network access |
| `--babysit` | May publish to its pull request (`references/babysit.md`, "Start it") | Not supported: babysitting runs on Claude |
| Unavailable in the child | MCP servers, skill invocation (it reads a skill's `SKILL.md` instead, as briefs ask for testing skills), slash commands, subagents, web tools | MCP servers it is not configured with; with `--sandbox` or `--read-only`, the network |
| Login | `claude auth status` / `claude auth login` | `codex login status` / `codex login` |

## Practical notes

- **Sandboxing a task:** outside the sandbox, a task reaches SSH, the keychain and tool state as the
  user does. `--sandbox` confines a task again; `--offline` confines it and blocks the network.
  In Claude's sandbox the relay's own sandbox settings replace any in the user's or the project's
  Claude settings, and its proxy refuses SSH, so `start` rewrites GitHub SSH remotes to HTTPS
  (environment `GIT_CONFIG_*`) for sandboxed Claude tasks.
- **Local relay patch:** `--no-sandbox`, `--allow-domain`, `--allow-go-tls`, `--deny`, `--allow-write`,
  and `--allow-publish` are a local addition to the upstream `claude-delegate` relay, saved as
  `claude-delegate-network.patch` beside this file. `npx skills update` would remove it.
  `$ORCH agents` and `start` report when it is missing.
- **Tool directories (`--sandbox` only):** a sandboxed Claude write task may also write `~/.cache`,
  `~/Library/Caches`, and `~/.local/share/uv`, so that uv, pre-commit, and similar gates can run.
  A sandboxed babysitter also gets Graphite's state directories.
- **Same-CLI delegation** is fine when you want parallel hands rather than a different
  perspective, for example Claude orchestrating three Claude implementers.

## Stopping a task

`stop <run> <task>` ends a task on purpose, for example to free memory.

- **What it stops.** It stops the named task first and waits for its relay to exit, so that the
  agent cannot start more sub-agents or react to theirs ending. Then it stops the tasks below it:
  every running task of each run that the task created (a nested run), then every running task of
  the runs those tasks created, and so on down, one level at a time. A run records the task that
  created it, and `status` lists it under "nested runs".
- **How each is stopped.** Each task is stopped as `stop` stops the named one: it is marked stopped
  (`stoppedAt`, `stoppedBy`), its relay's process group gets SIGTERM, a parked babysitter's park
  ends, and what a command task left running in its process group is ended.
- **Output.** After the line about the named task, one line lists what else was stopped, by run and
  task: `also stopped 3 tasks below it: <run>/a, <run>/b, <run>/c`. When the named task is not
  running, `stop` still stops the tasks below it; with nothing to stop, it fails as before.
- **Ownership.** Owning the named task's run is enough: the runs below it exist only through it.
- **`close`.** Closing a task that still runs stops it, then stops the tasks below it the same way.
  It closes only the tasks you named; the ones below are stopped, not closed. Closing a task that
  has already finished stops nothing below it.
- **What does not reach below.** An interrupt's resume (`send --steer`, `steer`), a park, a retry
  and a handoff stop only the task's own relay. Its sub-agents keep running.
- **How a stopped task reads.** A task whose current attempt a stop ended reads `stopped`, not
  `aborted` (the state the relay records on SIGTERM), in `status`, `result`, `wait` and the
  dashboard. It did not fail: it raises no attention item, counts as no failure, and is not a
  result waiting to be read (`references/monitor.md`, "States, phases and health"). `start` resumes
  it as before and clears the stop.

## Command tasks

`start <run> <task> --agent command --why "<reason>" [--max-tier TIER] [--done "<marker>"]
[--timeout DUR] [--cd DIR] -- <command> [args...]` runs a command as a task, with no model and no
brief.
`scripts/command-relay.mjs` runs it in place of a delegate relay.

- **How it runs.** The words after `--` run as an argument vector, with no shell. Put variables in
  with `-- env VAR=value <command> ...`, and shell syntax with `-- sh -c '...'`. It runs detached, in
  `--cd`, in its own process group, with the environment a relay's agent gets (`AGENT_ORCH_RUN`,
  `AGENT_ORCH_TASK`, `AGENT_ORCH_DEPTH`, and `agent-env.json`). So an agent it starts, such as a
  review script's `claude -p` or `codex exec`, is linked to the task, and the board shows it in the
  task's own row (`references/dashboard.md`, "Agents it finds on its own").
- **When it succeeds.** It exits 0 and, with `--done`, a line of its output contains the marker.
  Otherwise it fails. `--timeout` stops it after DUR, with the status `timeout`.
- **What it records.** `relay.log` holds its full stdout and stderr together. `events.jsonl` holds
  a `command.started` event, then the output in events of at most 200 lines or 64 KB, which the
  dashboard's event log shows. A line over 4 KB is cut there and marked truncated. `result.json`
  holds `status`, `exitCode`, `error`, the last 40 lines of output as `finalMessage`, and
  `leftover`. The activity column shows the latest output line, `steps` counts output lines, and
  the model column shows `-`, until the board finds an agent that the command runs.
- **Its agents are recorded.** The relay records each headless Claude (`claude -p` or `--print`)
  and Codex (`codex exec`) agent that its command starts, with the task as its parent. It does so
  with or without a dashboard running, and a dashboard opened later shows them. It finds an agent
  two ways:
  - It checks the command's process group about every half second. It sees any agent that stays in
    the group that long, whatever folder it works in.
  - It also reads the agent session files that changed while the command ran, while it runs and
    once more when it exits. This finds a short agent, or one that left the group, when its session
    ran in `--cd`, in a folder below it, or in the folder of an agent that the relay saw.
- **What the relay does not record.**
  - Interactive Claude or Codex sessions, and any other CLI.
  - An agent that left the command's group and ran outside `--cd` and the folders below it. When
    `--cd` is the home folder or `/`, only an agent seen running in the group counts.
  - An agent that is still running outside the command's group: the relay never takes it for its
    own, even in the same folder.
  - A match by folder and time is a guess. A headless agent that someone else ran in the same
    folder while the command ran, and that has exited, may be listed under the task.
  - When recording fails, the task still ends with its result, and `relay.log` gets a line that
    starts `command-relay:`.
- **Its process group.** The command leads its own process group, recorded in the attempt's
  `command-group.json`. When the command exits, the relay ends whatever is left in that group:
  SIGTERM, then SIGKILL after 5 seconds, checking each process's PID and start time just before it
  signals it. `leftover` counts those processes.
- **Its lifecycle** is an agent task's: `status`, `wait`, `result`, `log`, `close`, the finish
  notice to the parent, and the ownership guard work the same way. `stop` sends SIGTERM to the
  relay, which ends the command's process group and records `aborted`; the task reads `stopped`
  ("Stopping a task"). When the relay has gone
  without ending the group (it was killed), `stop` and `close` end the recorded group themselves,
  even after the command that led it has exited.
- **No session.** `start` again runs the command again, as a new attempt: the same command, with
  its `--done` and `--timeout`, unless a new command follows `--`.
- **Read-only for review.** Its work is never committed, so `accept` takes it as a read-only task,
  and it does not hold its folder as a writer. It is not sandboxed, though. It refuses `--brief`,
  `--tier`, `--model`, `--effort`, `--sandbox`, `--confine`, `--offline`, `--no-publish` and
  `--babysit`.
- **Never silent.** A script often prints nothing while the agent it started works, so a command
  task is never flagged silent. Give one that may hang a `--timeout`.
- **Model ceiling.** `--max-tier <tier>` caps the agents the command starts ("Model ceilings").

## Model ceilings

A ceiling limits the model and effort of the agents that a command task's command starts. Only a
command task has one.

- **Set it** with `--max-tier <tier>`, a Claude tier (`light`, `standard`, `complex` or
  `frontier`). `start` refuses any other name, and refuses `--max-tier` on an agent task. For Codex,
  the cap is the strongest Codex tier whose `rank` in `policy.json` is at or below that tier's.
- **Default.** A command that a delegated task starts is capped at that task's own tier, rounded
  down to a Claude tier by `rank`. One that a main session starts has no cap, so the ceiling sets
  none of the variables below.
- **The lowest cap wins.** The ceiling is the lowest of `--max-tier`, the default, and the one that
  the command inherited in `AGENT_ORCH_MAX_TIER` from a parent command. `--max-tier` can lower the
  others, never raise them. A new attempt keeps the earlier attempt's ceiling unless `--max-tier`
  names another.
- **What the command gets.** The ceiling reads the environment as the command will see it,
  including `agent-env.json` (`references/memory.md`), and sets or lowers these:
  - `AGENT_ORCH_MAX_TIER`, `AGENT_ORCH_MAX_MODEL_CLAUDE` and `AGENT_ORCH_MAX_MODEL_CODEX`: the
    ceiling, and the strongest model it allows each agent.
  - `AGENT_ORCH_MAX_EFFORT`: the highest effort. It is the ceiling tier's own effort, lowered to
    the effort of the delegated task that started the command and to an inherited
    `AGENT_ORCH_MAX_EFFORT`. Efforts rise `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; a
    level not in that list is replaced by the cap.
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `..._SONNET_MODEL`, `..._OPUS_MODEL` and `..._FABLE_MODEL`,
    one for each tier in `policy.json`: what the aliases `haiku`, `sonnet`, `opus` and `fable` run
    in the command's Claude agents and their Agent-tool sub-agents. Each runs its tier's model, or
    the ceiling's model when its tier is above the ceiling. A pin by the user to a model in
    `policy.json` at or below the ceiling is kept.
  - `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
    `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_EFFORT` are never set. When the user's own
    value is above the ceiling, it is lowered: a model that `policy.json` lists to the ceiling's
    Claude model, an effort to `AGENT_ORCH_MAX_EFFORT`.
- **`$ORCH start` inside the command** obeys the ceiling too: it refuses a tier stronger than the
  ceiling, and caps its effort at `AGENT_ORCH_MAX_EFFORT`.
- **For a script's own agent,** `$ORCH model --agent claude|codex [--tier TIER]` prints the words to
  add to the `claude` or `codex` command line. A script passes them as separate arguments:

  ```
  --model MODEL --effort LEVEL                      (claude)
  --model MODEL -c model_reasoning_effort="LEVEL"   (codex)
  ```

  - With no effort to print, it prints `--model MODEL` alone.
  - `--agent` is required (`orch: --agent must be claude or codex`, exit 2). An unknown tier is
    refused, also with exit 2, and the tiers are listed.
  - Without `--tier` it uses the ceiling's tier for that agent, or `standard` when there is no
    ceiling.
  - It lowers the tier only when `AGENT_ORCH_MAX_TIER` is in the environment, as it is under a
    command task with a ceiling: a tier above the ceiling becomes the ceiling's tier for that agent.
    A tier at or below it, or any tier when the variable is not set, prints as asked.
  - It caps the effort at `AGENT_ORCH_MAX_EFFORT` whenever that is set, with or without a tier
    ceiling.
- **Codex has no environment variable** that selects its model or effort, so a script that runs
  `codex exec` must pass what `$ORCH model` prints.
- **These are defaults, not a lock.** The alias variables cap a sub-agent that picks an alias. A
  sub-agent that names a full model id above the ceiling is not stopped, nor is an explicit
  `--model` or `--effort` flag on the command's own `claude` or `codex`, nor a script that changes
  its environment. The board warns about a model above the ceiling
  (`references/dashboard.md`, "Model ceiling warnings").

## Native sub-agents

`orch.mjs` also finds sub-agents that a session started with its host's own tool, so that the
views show everything a session launched:

- **Claude Code** writes each Agent-tool sub-agent to
  `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`, with a `.meta.json` beside it
  (description, and whether it finished). Its token counts are approximate. The agents that a Claude
  Code Workflow starts are kept one folder down, under `subagents/workflows/`, which is not read:
  they get no rows, and the model-ceiling warning does not check them.
- **Codex** writes each sub-agent as its own session log under `~/.codex/sessions/`; its
  `session_meta` names the parent thread, with `thread_source: "subagent"` for `spawn_agent` and
  `"guardian_review"` for the automatic approval reviews that Codex runs on its own. A sub-agent is
  `idle`, not finished, between turns, because its parent can message it again.

## Agents started outside the orchestrator

Headless `claude -p` and `codex exec` processes that no relay and no `orch.mjs` command started,
such as a review script that a session runs, are recorded in `external.jsonl` under the state root,
so that one stays listed after it exits. Two things record them:

- **The dashboard server** scans for them every 2 seconds while it runs
  (`scripts/lib/external.mjs`).
- **A command task's relay** records the agents of its own command ("Command tasks", above). Any
  other agent that starts and ends while no dashboard runs is not seen, including one that a Claude
  or Codex task's shell starts.
- **Who started it** comes from the variables the process inherited: `AGENT_ORCH_RUN` and
  `AGENT_ORCH_TASK` (a task's shell), `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (a session's
  shell; the nearest Claude Code or Codex process above it decides between the two).
- **Its transcript** is Claude Code's `~/.claude/sessions/<pid>.json` session id, or the Codex
  rollout under `CODEX_HOME` that the process holds open. Interactive sessions are skipped.
- **What the board shows** of them is in `references/dashboard.md`, "Agents it finds on its own".

## Cost and limits

- **`$ORCH agents`** lists each CLI, its version, its login state, whether its delegate relay is
  installed, and the model policy. Beside each tier it shows that tier's results on this machine
  over the last 30 days; `references/tiers.md` says what the figures mean.
- **Usage limits.** Both subscriptions meter use in a 5-hour window and a weekly window.
  `$ORCH agents` shows the share of each window that is used, and the dashboard header shows the same.
  The reading is for information only, even a window at 100% or a limit status (`SKILL.md`, "Usage
  limits").
  - Claude reports its limits in every headless session's stream (`rate_limit_event`). `orch.mjs`
    caches the newest reading it sees, and `agents --refresh` takes a fresh one with a minimal turn.
  - Codex writes its limits into its session logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`),
    so the reading reflects the most recent Codex session on this machine, interactive or
    delegated. A window whose reset time has passed is shown as reset.
- Every task is a full agent session on the user's subscription or API key. Give every write task
  a `--timeout` (`1h` to `2h` for implementation, `20m` for a review).
- Claude's `--max-budget-usd` and `--max-turns` cap a runaway session. Codex has no budget flag; use
  `--timeout`, and the tier that the task's complexity calls for.
- A resumed Codex thread re-reads its whole history on every turn, so long rework loops on Codex
  grow its input tokens quickly.
