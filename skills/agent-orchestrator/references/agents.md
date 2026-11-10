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
| Session id (for `-- --session`) | `sessionId`; a follow-up attempt keeps its tier unless `--tier` switches it | `threadId`; a resumed thread may switch tier |
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
  user does. `--sandbox` confines a task again; `--offline` confines it and blocks the network. In Claude's sandbox the relay's own sandbox
  settings replace any in the user's or the project's Claude settings, and its proxy refuses SSH,
  so `start` rewrites GitHub SSH remotes to HTTPS (environment `GIT_CONFIG_*`) for sandboxed
  Claude tasks.
- **Local relay patch:** `--no-sandbox`, `--allow-domain`, `--allow-go-tls`, `--deny`, `--allow-write`,
  and `--allow-publish` are a local addition to the upstream `claude-delegate` relay, saved as
  `claude-delegate-network.patch` beside this file. `npx skills update` would remove it.
  `$ORCH agents` and `start` report when it is missing.
- **Tool directories (`--sandbox` only):** a sandboxed Claude write task may also write `~/.cache`,
  `~/Library/Caches`, and `~/.local/share/uv`, so that uv, pre-commit, and similar gates can run.
  A sandboxed babysitter also gets Graphite's state directories.
- **Same-CLI delegation** is fine when you want parallel hands rather than a different
  perspective, for example Claude orchestrating three Claude implementers.

## Command tasks

`start <run> <task> --agent command --why "<reason>" [--max-tier TIER] [--done "<marker>"]
[--timeout DUR] [--cd DIR] -- <command> [args...]` runs a command as a task, with no model and no
brief.
`scripts/command-relay.mjs` runs it in place of a delegate relay.

- **How it runs.** The words after `--` run as an argument vector, with no shell. Put variables in
  with `-- env VAR=value <command> ...`, and shell syntax with `-- sh -c '...'`. It runs detached, in
  `--cd`, in its own process group, with the environment a relay's agent gets (`AGENT_ORCH_RUN`,
  `AGENT_ORCH_TASK`, `AGENT_ORCH_DEPTH`, and `agent-env.json`). So an agent it starts, such as a
  review script's `claude -p` or `codex exec`, is linked to the task, and the board shows it there.
- **When it succeeds.** It exits 0 and, with `--done`, a line of its output contains the marker.
  Otherwise it fails. `--timeout` stops it after DUR, with the status `timeout`.
- **What it records.** `relay.log` holds its full stdout and stderr together. `events.jsonl` holds
  a `command.started` event, then the output in events of at most 200 lines or 64 KB, which the
  dashboard's event log shows. A line over 4 KB is cut there and marked truncated. `result.json`
  holds `status`, `exitCode`, `error`, the last 40 lines of output as `finalMessage`, and
  `leftover`. The activity column shows the latest output line, `steps` counts output lines, and
  the model column shows `-`.
- **Its process group.** The command leads its own process group, recorded in the attempt's
  `command-group.json`. When the command exits, the relay ends whatever is left in that group:
  SIGTERM, then SIGKILL after 5 seconds, checking each process's PID and start time just before it
  signals it. `leftover` counts those processes.
- **Its lifecycle** is an agent task's: `status`, `wait`, `result`, `log`, `close`, the finish
  notice to the parent, and the ownership guard work the same way. `stop` sends SIGTERM to the
  relay, which ends the command's process group and records `aborted`. When the relay has gone
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

A command task's `--max-tier` names a Claude tier (`light`, `standard`, `complex` or `frontier`).
For Codex, the cap is the strongest Codex tier whose `rank` in `policy.json` is at or below that
tier's.

- **Default.** A command that a delegated task starts is capped at that task's own tier. One that a
  main session starts has no cap.
- **Inherited caps only go down.** A ceiling inherited from a parent can lower `--max-tier`, never
  raise it.
- **What the command gets.** Its environment holds the limits as `AGENT_ORCH_MAX_TIER`,
  `AGENT_ORCH_MAX_MODEL_CLAUDE`, `AGENT_ORCH_MAX_MODEL_CODEX` and `AGENT_ORCH_MAX_EFFORT`. It also
  sets Claude Code's own defaults (`ANTHROPIC_MODEL`, the `ANTHROPIC_DEFAULT_*_MODEL` aliases,
  `CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, and
  `CLAUDE_CODE_EFFORT_LEVEL`), so a Claude agent's nested Agent-tool and Workflow sub-agents stay
  within the cap.
- **For a script's own agent,** `$ORCH model --agent claude|codex [--tier TIER]` prints the model and
  effort arguments, lowered to the inherited ceiling. Without `--tier` it uses the ceiling, or
  `standard` when there is none. For Codex it prints the effort as `-c model_reasoning_effort="LEVEL"`,
  not `--effort`.
- **Codex has no environment variable** that selects its model or effort, so a script that runs
  `codex exec` must pass what `$ORCH model` prints.
- **These are defaults, not a lock.** An explicit `--model` on a top-level `claude` command, or a
  changed environment, bypasses them. The dashboard warns when a known model above the cap runs.

## Native sub-agents

`orch.mjs` also finds sub-agents that a session started with its host's own tool, so that the
views show everything a session launched:

- **Claude Code** writes each Agent-tool sub-agent to
  `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`, with a `.meta.json` beside it
  (description, and whether it finished). Its token counts are approximate.
- **Codex** writes each sub-agent as its own session log under `~/.codex/sessions/`; its
  `session_meta` names the parent thread, with `thread_source: "subagent"` for `spawn_agent` and
  `"guardian_review"` for the automatic approval reviews that Codex runs on its own. A sub-agent is
  `idle`, not finished, between turns, because its parent can message it again.

## Agents started outside the orchestrator

The dashboard server also finds headless `claude -p` and `codex exec` processes that no relay and
no `orch.mjs` command started (`scripts/lib/external.mjs`), every 2 seconds while it runs:

- **Who started it** comes from the variables the process inherited: `AGENT_ORCH_RUN` and
  `AGENT_ORCH_TASK` (a task's shell), `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (a session's
  shell; the nearest Claude Code or Codex process above it decides between the two).
- **Its transcript** is Claude Code's `~/.claude/sessions/<pid>.json` session id, or the Codex
  rollout under `CODEX_HOME` that the process holds open. Interactive sessions are skipped.
- **The board lists** only Codex and Claude Opus agents that a script under `~/.agents/`,
  `~/.claude/` or a skills folder started from a session, without their own sub-agents (a Codex
  agent's sub-threads count in its tokens). One started from a task's shell (any script, any model)
  is a row under that task instead, with its own tokens, state and events. It stays there while the
  task shows, past the board's idle window too. Its Agent-tool sub-agents and the runs it launches
  nest under that row, and its session gets no section of its own.
- Each agent is recorded in `external.jsonl` under the state root, so it stays listed after it
  exits. One that starts and ends while no dashboard runs is not seen.

## Cost and limits

- **`$ORCH agents`** lists each CLI, its version, its login state, whether its delegate relay is
  installed, and the model policy.
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
