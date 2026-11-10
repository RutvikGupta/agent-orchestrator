# Dispatching and starting tasks (step 4)

Read this before your first `dispatch` or `start` in a session. Per-agent modes and flags are in
`references/agents.md`; the sandbox and publishing defaults are in `SKILL.md`, "Guardrails".

## `dispatch`

```bash
$ORCH dispatch <run> [--max N] [--dry-run] [--follow [--timeout DUR]]
```

- It starts, in plan order, every planned task whose `dependsOn` tasks are all integrated (a
  read-only dependency counts once its result is collected), up to the free slots under the
  parallel limit (`references/plan.md`, "Parallel limit"). `--max N` starts at most N.
- Each task gets the plan's agent, tier, `why`, read-only mode and brief, and each write task a
  prepared worktree (`references/worktrees.md`).
- A write task's worktree starts from the run's base commit. Once the task has prerequisites, it
  starts from the head of the branch they were integrated into, which must contain every
  prerequisite's merge. When no branch does, `dispatch` refuses the task and tells you to merge
  their branches together.
- A task that already has a worktree keeps it, and is refused when that worktree lacks a
  prerequisite's work.
- It refuses a task whose brief is missing or still has a `<fill in: ...>` marker, or whose plan
  entry has no valid tier. It starts the others and exits 1.
- A ready task that shares an owned path or a resource with a running task waits. It is listed,
  not refused, and starts on a later `dispatch`.
- It lists the tasks still blocked and what each waits on. It never starts a planned babysitter,
  which needs a pull request number: it lists the `start` command instead (`SKILL.md`, step 8).
- `--dry-run` lists what it would start.
- Work starts as soon as its prerequisites land; there are no waves.

### `dispatch --follow`

`--follow` stays after the first start. It waits for the running planned tasks and starts each
next task as its prerequisites are integrated. It blocks, so in Claude Code run it in the
background as you run `wait` (`SKILL.md`, "Setup"). The `Stop` hook still wants a live `wait` on
the run. A Codex orchestrator, whose shell calls time out, runs `dispatch --follow --timeout 9m`
and repeats the call while it exits 3, as it does with `wait`.

- It returns when one of these happens:
  - the plan is complete: every planned task is integrated;
  - a task newly needs you: it is ready for review, or accepted and waiting to integrate, it handed
    back a decision, it failed, or it needs other attention as in `wait`
    (`references/monitor.md`, "What wakes `wait`");
  - a planned task could not be started (brief, tier or start point), which exits 1;
  - nothing runs and nothing it can start is left;
  - `--timeout DUR` passed, which exits 3 with tasks still running: run it again to keep following
    (`0` or no `--timeout` stays);
  - in a delegated agent, a finish notice about one of the run's tasks reaches its inbox.
- It prints each task that needs you with the command to run next. A failure exits 1.
- Problems that were there when it began are listed, but do not stop it while work runs.
- It does not review, accept or integrate. Handle what it names, then run it again. When you
  integrate a task while it runs, it starts that task's dependents without a restart.
- Like `wait`, it retries transient failures (`references/monitor.md`, "Automatic retry") and
  restarts the watcher of a parked babysitter that has died.
- `--max N` caps how many planned tasks run at once, a retried task included, instead of how many
  one call starts. Other tasks still count against the parallel limit.
- A planned babysitter is listed and never interrupts it.
- With `--dry-run`, `--follow` does nothing extra.

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

### Plan checks

In a run with a plan, the first start of a task is checked against it. `start` refuses a task that:

- waits on a `dependsOn` task that is not integrated;
- shares an owned path or a resource with a running task, by the rule `plan` uses. A write task
  that the plan does not name owns the whole repository; a read-only one owns nothing;
- is not in the plan.

Pass `--force` to skip the first two checks. For the third, pass `--unplanned`, which records the
task as an exception. `--force` does not imply it. A babysitter or a command task that the plan
does not name needs `--unplanned` too.

- Later attempts of a task (a resume, a rework, a retry) skip these checks.
- A babysitter reserves no owned paths, and a parked task or a command task reserves nothing.

## Why never your host's own sub-agent tool

Codex's `spawn_agent` and Claude Code's Agent tool skip the model policy, `--why`, the parallel
limit, and worktree isolation. A Codex `spawn_agent` with `fork_turns: "all"` also copies your whole
conversation into a session on your own model.
