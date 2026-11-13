# Worktrees, preparation and cleanup

Read this before you start a write task by hand, when a gate fails in a worktree, when a task's
folder is gone, when a worktree is refused for lack of disk space, and before you run `gc` or
`cleanup`.

**Remove every worktree you make by hand as soon as you are done with it**
(`git -C <repo> worktree remove <path>`), for example one made for a review. Each one can take
hundreds of megabytes, and nothing collects it for you: the orchestrator collects only the
worktrees under a run's folder. A disk filled with forgotten worktrees can crash the machine.

## Who gets a worktree

- Each write task that runs alongside other writers works in its own git worktree, on its own
  branch. By default the folder is `<run-dir>/worktrees/<task-id>` and the branch is
  `orch/<run>/<task-id>`.
- `dispatch` creates them. For a task you start by hand, run
  `$ORCH worktree <run> <task-id> [--from <ref>] [--branch <name>] [--path <dir>] [--no-prep]`;
  `start` then defaults to it.
  - `--from` starts the branch at a commit, by default the run's base commit. Use it to start from
    integrated work. A branch name is fixed to the commit it points at when you run `worktree`.
  - `--branch` names the new branch. `--path` puts the folder somewhere else.
  - It refuses a task that already has a worktree, and a `--path` that already exists.
  - It refuses when the disk is too full ("Free disk space" below).
- A single writer, or a sequential queue, may use the main checkout when it is clean.
- Read-only tasks may share any checkout.
- `start` refuses a second writer in the same directory unless you pass `--force`.

## Preparation

A worktree holds tracked files only. So `worktree` (unless `--no-prep`) and `dispatch`:

1. copy the ignored files that the repository's `.worktreeinclude` lists (gitignore patterns, such
   as `.env`);
2. apply the user's **recipe** for the repository: the first `~/.agents/orch-recipes/*.json` whose
   `match` is the repository's path, else its folder name. `AGENT_ORCH_RECIPES_DIR` moves the
   folder.

Name in the brief any gate that does not work in a worktree, so the implementer reports it as not
run, and run it yourself during review.

| Recipe field | Meaning |
| --- | --- |
| `copy` | More gitignore patterns of ignored files to copy |
| `symlink` | Ignored files or folders to link from the main checkout, such as `node_modules/`; the links stay out of commits |
| `setup`, `teardown` | Shell commands (up to 10 minutes each). `setup` runs in a new worktree. `teardown` runs in a worktree just before it is removed, by whatever collects it ("Cleanup"). They get `ORCH_WORKTREE`, `ORCH_REPO`, `ORCH_RUN` and `ORCH_TASK` |
| `port` | `true` gives each worktree its own free port, as `ORCH_PORT` |
| `notes` | Printed after preparation, for example which gates work in a worktree |
| `testing` | Testing-skill pins, `[{"skill": "<name>", "when": ["<path prefix or glob>"], "note": "how to use it here"}]`. `brief` marks a pin's skill required when the task's owned paths match `when`, or always when it has none (`references/briefing.md`) |

When worktree gates fail on missing dependencies or ignored files, list the files in the
repository's `.worktreeinclude`, or add them or the setup to the user's recipe, so the next worktree
gets them. For this one, install them in the worktree, or name the gate in the brief as one it
cannot run.

## Free disk space

Every worktree is created after one check of the free space on the volume that will hold it:
`worktree`, `dispatch`, and restoring a collected worktree all go through it.

- The minimum is `AGENT_ORCH_MIN_FREE_DISK`, by default `15GB`. It takes bytes or a size such as
  `500MB`, `15GB` or `20GiB` (`MB` and `GB` count in thousands, `MiB` and `GiB` in 1024s). `0`
  turns the check off.
- Below the minimum, the command first runs the automatic collection ("Automatic collection"
  below, with the 1-hour age), then reads the disk again. If it is still below the minimum, it
  refuses with exit code 1 and creates nothing: no folder, no branch. The message gives the free
  space, the minimum, and the commands that free space: `gc --dry-run`, `gc`,
  `close RUN TASK...`, and `git worktree remove` for a worktree made by hand. `dispatch` reports it
  as that task's refusal.
- No option bypasses the check. Only the setting changes it.
- The disk counts as low below twice the minimum. The dashboard's header then shows the free space
  as a warning, and the automatic collection collects sooner (`references/dashboard.md`).

## Cleanup

Worktrees are collected automatically, so you rarely run anything. Collecting removes the folder
only: the task's branch and commits stay. No command deletes a branch; delete one yourself after
its work has landed.

When it happens:

- `close` collects the run's worktrees once every task in the run is closed. A task prepared
  with `worktree` but never started then shows as `closed`, with "closed before it started".
  Until every task is closed, `close` says it keeps that prepared folder because other tasks
  remain open. The same safety checks apply to prepared folders. A folder already removed by
  hand counts as removed even while other tasks remain open; its task still closes and its branch stays.
  Preparing a closed, never-started task again reopens it, even with a new branch or after the
  kept branch was deleted. It shows as `prepared` until started or closed again.
  Plain `wait <run>` leaves closed preparations out. Naming one with `wait <run> <task>` reports
  "closed before it started" and exits 0.
- `integrate` collects the integrated task's worktree right after the merge.
- `gc` collects what is left in idle runs (below). The dashboard runs it on its own every five
  minutes ("Automatic collection").
- `cleanup <run>` collects the run's worktrees now, by the same rules as `close` and `integrate`.
  Its `--force` and `--delete-branches` options do nothing: it prints a notice and goes on.

A worktree is removed only when all of these hold. Otherwise it is kept, and the command lists it
with the reason:

- Its task is not running, and no running or parked task in any run uses the folder. A pull
  request's worktree therefore stays while its babysitter works in it.
- Its task's latest attempt was closed with `close`, or the task was accepted and integrated.
  Reading a finished write task's result with `result` also closes it, but only `gc` counts that.
- It has no uncommitted changes: a modified, staged, deleted or renamed tracked file, or an
  untracked file other than a tool cache (`__pycache__`, `.pytest_cache`, `.mypy_cache`,
  `.ruff_cache`, `node_modules`, `.DS_Store`), keeps it. No option discards changes.
- Its commits, and the task's accepted commit, are reachable from its branch or the run's base
  branch.
- It is a worktree of the run's repository, and not the repository's own checkout.

Before it removes a worktree, it runs the recipe's `teardown` there. A failed `teardown` is
reported and does not keep the worktree. A `teardown` that leaves tracked changes does.

### `gc`

```bash
$ORCH gc [--dry-run] [--older-than DUR] [--auto] [--json]
```

- It takes no run. It looks at the runs the caller may act on (`references/ownership.md`): at a
  terminal, any run; in a session or a delegated agent, the runs it launched and their nested
  runs; with no identity, none.
- It also collects, for any caller with an identity, a run whose launching session has ended:
  the session's process is gone, and for a nested run, every launcher up its chain is gone too.
  Nobody else is left to collect it. The report says "its session has ended" for such a run. A run whose session
  is alive stays that session's to collect. A run launched from a terminal never counts as ended.
  Other commands, such as `cleanup` or `close`, still refuse such a run without `--adopt`.
- A run is collected only when no task in it runs or is parked and it has had no activity for 24
  hours. `--older-than DUR` changes that (`12h`, `7d`). For any other run `gc` keeps every
  worktree and says why: `ownership refused`, `run has running tasks` or `run is too recent`.
- In a run it collects, a finished task that nobody has read with `result`, accepted or closed
  expires once its result is older than `AGENT_ORCH_EXPIRE` (default `7d`). `gc` closes it, as
  expired, so its worktree can go. Its result and branch stay. A task whose relay died with no
  result expires from its last activity.
- It then removes worktrees by the rules above, except that any close counts, including one made
  by reading the result.
- `--dry-run` changes nothing. It prints `would expire`, `would remove` and `would free`.
- The report has, per run, the expired tasks, the removed worktrees (each with the command that
  recreates it), the kept ones with their reasons, any `teardown` failures, and the disk freed.
  `--json` gives the same as data, with totals: removed, kept, kept by reason, expired, bytes
  freed.

### Automatic collection

`gc --auto` is the collection that runs without anyone asking. The dashboard runs it every five
minutes, after it reclaims orphaned build daemons, for as long as it runs. `AGENT_ORCH_AUTO_GC=off`
turns that off. Worktree creation also runs it on a disk below the minimum ("Free disk space").

- It follows every rule of `gc` above: only worktrees of closed or integrated tasks, nothing
  uncommitted, commits kept on a branch, and never a run with a running task.
- It collects only the caller's own runs and the runs whose session has ended, never a live
  session's run, even for the user. The dashboard runs it as the user at a terminal, whoever
  started the dashboard, so it collects the user's own runs and the runs of ended sessions.
- It collects a run once it has had no activity for 24 hours, or for 1 hour while the disk is low
  (below twice `AGENT_ORCH_MIN_FREE_DISK`). `--older-than DUR` sets another age.
- It prints one line per worktree removed and per task expired, then the space freed and the free
  space left, and nothing when it changed nothing. The dashboard's log
  (`<state root>/dashboard.log` for a background dashboard) keeps these lines.
- The owner of each run it changed gets a notice that "automatic worktree collection" made the
  change.

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_ORCH_MIN_FREE_DISK` | `15GB` | The least free space for creating a worktree; `0` turns the check off. Low means below twice this |
| `AGENT_ORCH_AUTO_GC` | on | `off` stops the dashboard's automatic collection |
| `AGENT_ORCH_EXPIRE` | `7d` | When an unread finished task expires, in `gc` and `gc --auto` |

## Restoring a collected worktree

`$ORCH worktree <run> <task-id>` recreates a collected folder from its kept branch, at its old path
(or `--path`), and prepares it again. Use it to resume the task, or to read or fix its work. `start`
on a task whose folder was collected refuses and prints this command.

- The branch keeps its original start point, so `--from` is refused. To start somewhere else, pass
  `--from` with a new `--branch`: that makes a new branch and restores nothing.
- `accept` on a restored task clears an earlier integration record, so `integrate` merges the new
  work.
- A restored folder stays until the task is closed again, or accepted and integrated again, after
  the restore. An earlier close or integration does not count. `gc` also counts a close made by
  reading the result.
