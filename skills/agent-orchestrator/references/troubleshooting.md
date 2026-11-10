# Troubleshooting

Read this when a command, task or gate fails in a way the step you are on does not cover.

| Symptom | Action |
| --- | --- |
| `start` says that no relay was found | Install the delegate skill: `npx skills add amElnagdy/delegate-skills -g -s claude-delegate` (or `codex-delegate`); check that `AGENT_ORCH_SKILLS_DIR` is not set to another folder |
| `<cli>_unavailable` | The CLI is not on `PATH`: install it, or fix `PATH` for non-interactive shells |
| `failed`, with auth errors in the log | Ask the user to log in: `claude auth login` or `codex login` |
| `USAGE LIMIT` in `wait` or `result` | The agent's usage window is used up: ping the user and resume on the other agent (`SKILL.md`, "Usage limits") |
| You lost track of what runs (restart, compaction) | `$ORCH recover`, then act on what it lists (`SKILL.md`, "Setup") |
| Claude reports that it is logged out when the orchestrator is Codex | Codex's sandbox blocks the macOS Keychain; re-run the `$ORCH` command with escalated permissions |
| A read-only Codex task cannot run network-dependent commands | Its read-only sandbox has no network; run it as a write task with a brief that forbids edits |
| A `--sandbox` Claude task reports `deny network-outbound <host> (user denied)` | The task ran with `--offline`, or the relay patch is missing (`start` printed a note, and `agents` warns). Re-apply the patch with the command that the note prints, then resume the task |
| A `--sandbox` Claude task's `git fetch`, `git push`, or `gt submit` fails with `policy_refusal` or `ssh_dispatch_run_fatal` | The sandbox refuses SSH. Sandboxed tasks started by this version of `orch.mjs` reach GitHub over HTTPS automatically; resume an older task so that it starts with the rewrite, or run it without `--sandbox` |
| `pr-watch` cannot read the pull request | Run it outside any sandbox; check `gh auth status`; pass `--repo` with a checkout of the pull request's repository, or the pull request URL |
| `start --babysit` says that the relay has no `--allow-publish` option | An update of `claude-delegate` replaced the local relay patch; re-apply it with the `patch` command that the error prints |
| `timeout`, `dead`, `silent`, `quiet` for a long time, or a transient error after `retried <task>` | Check `log`, then resume the session (`wait` prints the command) with a narrower delta brief, split the task, or start it fresh |
| A gate needs Docker, a database or other host services that a sandboxed task (Claude `--sandbox`, or a Codex sandbox) cannot reach | Tell the implementer to skip that gate, and run it yourself during review |
| Worktree gates fail on missing dependencies or ignored files | See `references/worktrees.md`, "Preparation" |
| `start` refuses with `counted failures at <agent> <tier>` | Start the agent and tier that it names, with a fresh brief and a new `--why` (`references/review.md`, "Escalate a tier") |
| `start` refuses a task that is `not in the plan`, `waits on` another, or `conflicts with running task` | See `references/dispatch.md`, "Plan checks" |
| `start` refuses because a task's folder was collected | Run the `worktree` command that it prints (`references/worktrees.md`, "Restoring a collected worktree") |
| `accept` refuses with `a passing check matched a failed run` | Rerun the gate with `verify`, then fix the work or record why with `--unverified` (`references/review.md`, "Accept") |
| The board shows `⚠ ... exceeds the <tier> ceiling` | See `references/dashboard.md`, "Model ceiling warnings" |
| Every command prints `orch: the skill changed since this session loaded it` | See `references/monitor.md`, "Skill changes" |
