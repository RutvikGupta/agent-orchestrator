#!/bin/bash
# Pass files explicitly: the tests/ directory entry point imports them serially.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
caller_dir=$PWD
cd "$repo_root/skills/agent-orchestrator"

# Delegated sessions share the host with other workers. Allow an explicit bound
# for measurements or a smaller machine, before clearing the session identity.
workers=${AGENT_ORCH_TEST_CONCURRENCY:-}
if [[ -z $workers ]]; then
  if [[ -n ${AGENT_ORCH_TASK:-} ]]; then workers=2; else workers=4; fi
fi
if [[ ! $workers =~ ^[1-9][0-9]*$ ]]; then
  echo 'AGENT_ORCH_TEST_CONCURRENCY must be a positive integer' >&2
  exit 2
fi

files=()
if [[ ${1:-} == --quick ]]; then
  shift
  if [[ $# != 0 ]]; then
    echo 'usage: tools/test.sh [--quick | <file>...]' >&2
    exit 2
  fi
  # These files exercise browser handlers in memory and short CLI commands only.
  # Keep the list explicit so a new integration file cannot silently enter this lane.
  files=(tests/dashboard-send-ui.test.mjs tests/lessons.test.mjs tests/regression-dashboard.test.mjs)
elif [[ $# == 0 ]]; then
  # memory.test.mjs imports its two companion files; run that group once.
  for file in tests/*.test.mjs; do
    case $file in tests/memory-heavy.test.mjs|tests/memory-reclaim.test.mjs) continue ;; esac
    files+=("$file")
  done
else
  for file in "$@"; do
    if [[ $file == -* ]]; then
      echo 'usage: tools/test.sh [--quick | <file>...]' >&2
      exit 2
    elif [[ $file == /* ]]; then
      files+=("$file")
    elif [[ -f "$caller_dir/$file" ]]; then
      files+=("$caller_dir/$file")
    elif [[ -f $file ]]; then
      files+=("$file")
    else
      files+=("tests/$file")
    fi
  done
fi

exec env -u AGENT_ORCH_DEPTH -u AGENT_ORCH_RUN -u AGENT_ORCH_TASK \
  -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  node --test "--test-concurrency=$workers" --test-reporter=spec --test-reporter-destination=stdout "${files[@]}"
