#!/usr/bin/env bash
# SessionStart hook — makes the agent-orchestrator skill the default way of working in every new,
# cleared, resumed, or compacted Claude Code session, by telling the model to load it before its
# first reply. Delegated agents (AGENT_ORCH_DEPTH is set) skip it: their brief already tells them
# how to delegate, and loading the whole skill would only cost them context.
#
# Registered in ~/.claude/settings.json:
#   hooks.SessionStart (matcher startup|resume|clear|compact) → bash orch-skill-session.sh

cat >/dev/null 2>&1 # the hook input is not needed
[[ -n "${AGENT_ORCH_DEPTH:-}" ]] && exit 0
[[ -f "$HOME/.agents/skills/agent-orchestrator/SKILL.md" ]] || exit 0

MSG='This session uses the agent-orchestrator skill by default. Before your first reply, if its instructions are not already in your context, load it with the Skill tool (skill: "agent-orchestrator") and work as it says: delegate by default, plan as data, keep up to 8 agents busy, and review, accept and integrate their results. For a quick question or a few-minute edit, answer directly without starting a run.'

jq -n --arg ctx "$MSG" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
