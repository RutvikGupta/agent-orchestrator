#!/usr/bin/env bash
# PreToolUse hook (Claude Code and Codex) — refuses shell commands that kill processes by
# pattern: `pkill`, `killall`, `kill $(pgrep ...)`, and `pgrep ... | xargs kill`. A pattern
# reaches processes the agent did not start; on macOS `pkill -f "<pattern>" -n` also treats `-n`
# as a second pattern, which once killed Docker Desktop, caffeinate and other sessions.
# Agents must stop what they started the way they started it, or kill one confirmed PID.
#
# Registered in ~/.claude/settings.json (hooks.PreToolUse, matcher Bash) and ~/.codex/hooks.json.
# Exit 2 blocks the call and shows the message to the agent; anything unparsable is allowed.

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .tool_input.cmd // empty | if type == "array" then join(" ") else . end' 2>/dev/null)
[[ -z "$CMD" ]] && exit 0

# A word in command position: line start, after ; & | ( ` $( or a quote, after a wrapper such as
# sudo/xargs/env, or as the script of `bash -c` / `sh -lc`.
Q="[\"']"
ASSIGN="[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*"
WRAP="(sudo|xargs|env|exec|command|nohup|time)([[:space:]]+(-[^[:space:]]+|${ASSIGN}))*[[:space:]]"
SHC="(ba|z)?sh[[:space:]]+-[a-z]*c[[:space:]]+${Q}?"
LEAD="(^|[;&|(\`]|${Q}|\\\$\(|(^|[[:space:];&|(\`])${WRAP}|(^|[[:space:]/])${SHC}|(^|[;&|][[:space:]]*)(${ASSIGN}[[:space:]]+)+)[[:space:]]*"
reason=""
if printf '%s\n' "$CMD" | grep -Eq "${LEAD}(/usr/bin/|/bin/)?(pkill|killall)([[:space:]]|$)"; then
  reason="pkill/killall"
elif printf '%s\n' "$CMD" | grep -Eq "${LEAD}kill([[:space:]][^;&|]*)?(\\\$\(|\`)[[:space:]]*(/usr/bin/)?pgrep"; then
  reason="kill \$(pgrep ...)"
elif printf '%s\n' "$CMD" | grep -Eq "pgrep[^;]*\|[[:space:]]*xargs([[:space:]]+-[^[:space:]]+)*[[:space:]]+kill"; then
  reason="pgrep | xargs kill"
fi
[[ -z "$reason" ]] && exit 0

MSG="Blocked: $reason kills processes by pattern, which can reach processes you did not start. Stop what you started the way you started it (the host's task-stop tool for a background command, orch.mjs stop or close for an orchestrated task), or kill one PID after confirming it with: ps -p <pid> -o command="
printf '%s\n' "$MSG" >&2
exit 2
