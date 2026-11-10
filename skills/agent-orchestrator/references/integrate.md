# Integrating and verifying the goal (step 7)

Read this before you integrate.

## `integrate`

```bash
$ORCH integrate <run> <task-id> [--into <branch>] [--dry-run]
```

- It merges an accepted task's branch into the run's base branch (or `--into` another) with
  `--no-ff`, after checking for conflicts. `--dry-run` only checks.
- That branch must be checked out and clean in the run's repository. `integrate` never switches,
  stashes, or resets it.
- It refuses while a merge, rebase, cherry-pick or revert is in progress there.
- It refuses when the merge would overwrite an ignored or untracked file, such as a `.env`.

## On a conflict

1. Merge the base branch into the task's branch inside its worktree
   (`git -C <worktree> merge <base>`), or resume the task's agent with a delta brief to do it.
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
