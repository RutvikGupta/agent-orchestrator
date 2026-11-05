# Agents: how each implementer behaves

Facts come from each delegate skill's relay (`~/.agents/skills/<agent>-delegate/`). Its `SKILL.md`
and `references/dispatch-and-poll.md` remain the authority on flags; check `relay.mjs --help` for
the installed version. Which agent and Codex tier to use is decided in `SKILL.md` ("Choose the
agent and model"); the models themselves live in `../policy.json`.

| | Claude Code (`claude`) | Codex (`codex`) |
| --- | --- | --- |
| Model and effort | Always `claude-opus-5-5`, effort `xhigh` | `--tier standard`: `gpt-6.1-sol`, `medium`; `--tier complex`: `gpt-6-astra`, `high` |
| Loads project instructions | `CLAUDE.md` (not `AGENTS.md`) | `AGENTS.md` (not `CLAUDE.md`) |
| Write mode (default) | `acceptEdits`; only Read, Glob, Grep, Edit, Write, and shell tools; no shell sandbox, shell pre-approved; may commit, push without force, and write to GitHub (force pushes, admin merges, secrets, repository creation and deletion, and nested `claude` denied); `--no-publish` denies `git commit`, `git push` and `gh` writes | `danger-full-access`: no sandbox, full network; nothing denied beyond the brief |
| `--read-only` | `plan` mode with Read, Glob, and Grep only (no shell); reports `readOnlyViolation` | `read-only` sandbox, enforced by Codex; shell commands such as `git diff` and tests still run |
| Session id (for `-- --session`) | `sessionId` | `threadId`; a resumed thread may switch tier |
| Token usage | Per message while running; exact totals at the end (also an estimated cost, which the views do not show) | Totals per completed turn; no cost |
| Useful relay flags | `--max-turns N`, `--max-budget-usd N`, `--autocompact 400k` (network and babysitter flags are set by `start`) | `--network-access`, `--web-search live`, `--ignore-user-config` |
| `--sandbox` | Shell sandbox: writes only in the working directory and tool caches; network to every host; GitHub over HTTPS | `workspace-write` sandbox with network access |
| `--babysit` | Commits and non-force pushes allowed; `gh` replies allowed; force push, admin merge, closing, and repository settings denied | Not supported: babysitting runs on Claude |
| Unavailable in the child | MCP servers, skill invocation (it reads a skill's `SKILL.md` instead, as briefs ask for testing skills), slash commands, subagents, web tools | MCP servers it is not configured with; with `--sandbox` or `--read-only`, the network |
| Login | `claude auth status` / `claude auth login` | `codex login status` / `codex login` |

## Practical notes

- **No sandbox by default:** the user chose to run tasks outside the sandbox, so they reach the
  network, SSH, the keychain, and tool state as the user does. `--sandbox` confines a task again;
  `--offline` confines it and blocks the network. In Claude's sandbox the relay's own sandbox
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
- **Host services:** gates that need Docker, a database, or other host services may be blocked by
  either sandbox. Have the implementer skip them, and run them yourself during review.
- **House rules:** each agent loads only its own instructions file, so restate the load-bearing
  rules from both `CLAUDE.md` and `AGENTS.md` in every brief.
- **Same-CLI delegation** is fine when you want parallel hands rather than a different
  perspective, for example Claude orchestrating three Claude implementers.

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
  agent's sub-threads count in its tokens). One started from a task's shell is not listed: the
  task's row stands for it.
- Each agent is recorded in `external.jsonl` under the state root, so it stays listed after it
  exits. One that starts and ends while no dashboard runs is not seen.

## Cost and limits

- **Usage limits.** Both subscriptions meter use in a 5-hour window and a weekly window.
  `$ORCH agents` shows the share of each window that is used, and the dashboard header shows the same.
  The reading is for information: no choice of agent weighs it, and even a window at 100% is not a
  reached limit, because the team plans add usage beyond it. Only a task stopped by a usage-limit
  error counts (SKILL.md, "Usage limits").
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
