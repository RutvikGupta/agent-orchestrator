#!/usr/bin/env bash
# Run before every push: this repository is public. Checks every tracked file and the messages of
# commits not yet on origin/main against a private denylist kept outside the repository, one term
# per line (case-insensitive, whole words; lines starting with # are comments):
#   ${AGENT_ORCH_DENYLIST:-~/.config/agent-orchestrator/denylist.txt}
# Exits 1 and lists every match; exits 2 if the denylist is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
list="${AGENT_ORCH_DENYLIST:-$HOME/.config/agent-orchestrator/denylist.txt}"
[[ -f "$list" ]] || { echo "check-public: no denylist at $list" >&2; exit 2; }
terms=$(grep -vE '^\s*(#|$)' "$list" | sed 's/[][\.*^$/]/\\&/g' | paste -sd'|' -)
[[ -n "$terms" ]] || { echo "check-public: the denylist is empty" >&2; exit 2; }
found=0
if git ls-files -z | xargs -0 grep -InwiE "$terms" -- 2>/dev/null; then found=1; fi
range="origin/main..HEAD"
git rev-parse -q --verify origin/main >/dev/null || range="HEAD"
if git log --format='%H %an <%ae> %s%n%b' "$range" | grep -nwiE "$terms"; then found=1; fi
if [[ $found -eq 1 ]]; then echo "check-public: FAILED, remove the matches above before pushing" >&2; exit 1; fi
echo "check-public: passed"
