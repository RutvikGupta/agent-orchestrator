# Working on this repository

This repository holds the Agent Orchestrator: a skill and CLI that runs Claude Code and Codex
sessions as background agents, its live dashboard, the two delegate skills it launches agents
through, and the hooks and settings that wire it into Claude Code and Codex.

It is installed live: `~/.agents/skills/<skill>` and the hook files under `~/.claude/` are
symlinks into this checkout (`~/agent-orchestrator`), so a change here reaches every session at once.

## Layout

- `skills/agent-orchestrator/`: the orchestrator skill and CLI. Its own `AGENTS.md` describes its
  layout and test rules; read it before changing anything there.
- `skills/claude-delegate/` and `skills/codex-delegate/`: the relays that run one agent session
  each (`scripts/relay.mjs`).
- `integrations/`: hooks, a browser agent, an MCP server definition, and example settings for
  Claude Code and Codex.
- `docs/`: screenshots and the demo board used to make them.
- `install.sh`: links the skills and hooks into place.
- `tools/check-public.sh`: the pre-push check for internal names.

## Rules

- **Commit and push every change.** Commit coherent units of work on `main`, or on a branch merged
  into `main` with `--no-ff`, and push `main` to `origin` right after each commit or merge. Do not
  leave a change uncommitted or unpushed at the end of a task. Never force-push.
- Use the repository's own identity for commits (set in `.git/config`); never a work email.
- **The repository is public.** Before every push, run `bash tools/check-public.sh` and push only after it
  passes. It checks the tracked files and the unpushed commit messages against a private denylist kept
  outside the repository. Never commit that denylist.
- Keep the repository free of anything internal to an employer or customer: no company, customer
  or internal system names, hostnames, IP addresses, repository URLs, emails or Slack IDs. Use
  neutral examples such as `example-org/example-repo`.
- No secrets or tokens, in files or in commit messages.
- Test the orchestrator with
  `cd skills/agent-orchestrator && env -u AGENT_ORCH_DEPTH -u AGENT_ORCH_RUN -u AGENT_ORCH_TASK node --test tests/`
  before each push that changes it.
- No dependencies beyond Node's standard library.
