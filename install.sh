#!/usr/bin/env bash
# Links this checkout into place, so every Claude Code and Codex session runs it:
#   ~/.agents/skills/<skill>  and  ~/.claude/skills/<skill>  -> skills/<skill>
#   ~/.claude/hooks/<hook>.sh, ~/.claude/agents/browser.md, ~/.claude/mcp/chrome-devtools.json
# An existing file or folder in the way is moved to ~/.agents/backups/<timestamp>/ first.
# It does not edit settings: merge integrations/claude/settings.example.json into
# ~/.claude/settings.json and integrations/codex/hooks.example.json into ~/.codex/hooks.json.
set -euo pipefail
repo=$(cd "$(dirname "$0")" && pwd)
backup="$HOME/.agents/backups/$(date +%Y%m%d-%H%M%S)"

link() { # link <target in repo> <path to create>
  local target=$1 path=$2
  if [[ -L "$path" && "$(readlink "$path")" == "$target" ]]; then return; fi
  mkdir -p "$(dirname "$path")"
  if [[ -e "$path" || -L "$path" ]]; then
    mkdir -p "$backup"
    mv "$path" "$backup/$(basename "$path")"
    echo "moved the old $path to $backup/"
  fi
  ln -s "$target" "$path"
  echo "linked $path -> $target"
}

for skill in agent-orchestrator claude-delegate codex-delegate; do
  link "$repo/skills/$skill" "$HOME/.agents/skills/$skill"
  [[ -L "$HOME/.claude/skills/$skill" ]] || link "$HOME/.agents/skills/$skill" "$HOME/.claude/skills/$skill"
done
for hook in "$repo"/integrations/claude/hooks/*.sh; do
  link "$hook" "$HOME/.claude/hooks/$(basename "$hook")"
done
link "$repo/integrations/claude/agents/browser.md" "$HOME/.claude/agents/browser.md"
link "$repo/integrations/claude/mcp/chrome-devtools.json" "$HOME/.claude/mcp/chrome-devtools.json"
echo "done; merge the example settings under integrations/ into your Claude Code and Codex settings"
