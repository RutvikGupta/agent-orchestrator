#!/usr/bin/env bash
# SubagentStart hook — makes sure the agent-orchestrator dashboard
# (http://127.0.0.1:4777/) is running whenever a Claude Code session starts a
# sub-agent, so the sub-agent shows on it even when the session never used the
# agent-orchestrator skill. Starts it in the background (or reuses a running
# one) and opens it in the browser unless a tab already shows it. Prints
# nothing and always exits 0, so the sub-agent starts regardless.
#
# Registered in ~/.claude/settings.json:
#   hooks.SubagentStart → bash orch-dashboard.sh   (async)

cat >/dev/null 2>&1 # the hook input is not needed

ORCH="$HOME/.agents/skills/agent-orchestrator/scripts/orch.mjs"
NODE=$(command -v node || echo /opt/homebrew/bin/node)
if [[ -f "$ORCH" && -x "$NODE" ]]; then
  "$NODE" "$ORCH" dashboard --detach --open >/dev/null 2>&1
fi
exit 0
