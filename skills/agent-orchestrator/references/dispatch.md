# Dispatching and starting tasks (step 4)

Read this before your first `dispatch` or `start` in a session. Per-agent modes and flags are in
`references/agents.md`; the sandbox and publishing defaults are in `SKILL.md`, "Guardrails".

## `dispatch`

```bash
$ORCH dispatch <run> [--max N] [--dry-run]
```

- It starts every planned task whose `dependsOn` tasks are all integrated (a read-only dependency
  counts once its result is collected), up to the parallel limit. `--max` lowers the limit.
- Each task gets the plan's agent, tier, `why`, read-only mode and brief, and each write task a
  prepared worktree (`references/worktrees.md`).
- It refuses a task whose brief is missing or still has a `<fill in: ...>` marker, starts the
  others, and exits 1.
- `--dry-run` lists what it would start.
- Work starts as soon as its prerequisites land; there are no waves.

## `start`

`SKILL.md` step 4 says which tasks to start by hand; research with live web search is one that needs
relay flags.

- `start` runs the agent's `<agent>-delegate/scripts/relay.mjs` as a detached background process
  and returns at once.
- It looks for the relay in the folder that holds this skill, then `~/.agents/skills`,
  `~/.claude/skills` and `~/.codex/skills`. `AGENT_ORCH_SKILLS_DIR` replaces that search path.
- The task's artifacts go to `<run-dir>/tasks/<task-id>/attempt-<n>/`.
- `--timeout` bounds the task (`references/agents.md`, "Cost and limits", gives sizes).
- Flags after `--` go to the relay unchanged; `relay.mjs --help` lists them. Common ones: Codex
  `--network-access` and `--web-search live`; Claude `--max-turns 60` and `--max-budget-usd 10`.

## Why never your host's own sub-agent tool

Codex's `spawn_agent` and Claude Code's Agent tool skip the model policy, `--why`, the parallel
limit, and worktree isolation. A Codex `spawn_agent` with `fork_turns: "all"` also copies your whole
conversation into a session on your own model.
