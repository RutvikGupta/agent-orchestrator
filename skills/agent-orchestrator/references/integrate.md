# Integrating and verifying the goal (step 7)

Read this before you integrate.

## `integrate`

```bash
$ORCH integrate <run> <task-id> [--into <branch>] [--dry-run] [--already-merged]
```

- It merges an accepted task's branch into the run's base branch (or `--into` another) with
  `--no-ff`, after checking for conflicts. `--dry-run` only checks.
- That branch must be checked out and clean in the run's repository. `integrate` never switches,
  stashes, or resets it.
- It refuses while a merge, rebase, cherry-pick or revert is in progress there.
- It refuses when the merge would overwrite an ignored or untracked file, such as a `.env`.
- It refuses a task whose `dependsOn` tasks are not all integrated.
- It refuses when the task's branch has moved past the commit you accepted. Review the new commits
  and `accept` again.
- It records the branch it merged into. `dispatch` starts a task's dependents from the head of
  that branch, so integrate all of a task's prerequisites into one branch. When they went to
  different branches, merge those branches together first.
- Afterwards it collects the task's worktree (`references/worktrees.md`, "Cleanup") and lists the
  planned tasks that are now ready to dispatch.

## A branch merged by hand

A task whose branch someone merged without `integrate` is not integrated, and its dependents stay
blocked. `status` and `recover` warn about it (`references/monitor.md`, "What `status` shows").
Accept the task, then record it:

```bash
$ORCH integrate <run> <task-id> [--into <branch>] --already-merged
```

- It records the task as integrated at the head of the target, and merges nothing.
- The task must be accepted, and the target must already contain the accepted commit. Otherwise
  it refuses.
- It needs neither the target checked out nor clean.

## On a conflict

1. Merge the base branch into the task's branch inside its worktree
   (`git -C <worktree> merge <base>`), or resume the task's agent with a delta brief to do it.
   When the folder was collected, restore it first (`references/worktrees.md`, "Restoring a
   collected worktree").
2. Re-run the gates there, and commit.
3. `accept` and `integrate` again.

If a conflict shows that the plan was wrong, stop and tell the user.

## Verify the goal

Finishing every task does not prove that the request is met: each task can pass while the whole
quietly does less than was asked. Before you publish or report, fill a short table with one row for
every item of the plan's `acceptance` list:

| Required behavior | Implementation | How it connects to its callers | Evidence |
| --- | --- | --- | --- |
| Trailing commas are rejected with a clear error | `parse_list` in `src/parser/list.py` | `parse_value` calls it, and the CLI's `check` command calls that | `pytest tests/test_parser.py` passes; `check bad.json` prints the error |

A row without evidence, or code that nothing calls, is not done: dispatch a task for it, or do it.
