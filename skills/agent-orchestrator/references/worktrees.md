# Worktrees, preparation and cleanup

Read this before you start a write task by hand, when a gate fails in a worktree, and before you
run `cleanup`.

## Who gets a worktree

- Each write task that runs alongside other writers works in its own git worktree,
  `<run-dir>/worktrees/<task-id>`, on a new branch `orch/<run>/<task-id>`.
- `dispatch` creates them. For a task you start by hand, run
  `$ORCH worktree <run> <task-id> [--from <ref>]`; `start` then defaults to it. Use `--from` to
  start from integrated work.
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
| `setup`, `teardown` | Shell commands run in a new worktree (up to 10 minutes each), and by `cleanup` before it removes one. They get `ORCH_WORKTREE`, `ORCH_REPO`, `ORCH_RUN` and `ORCH_TASK` |
| `port` | `true` gives each worktree its own free port, as `ORCH_PORT` |
| `notes` | Printed after preparation, for example which gates work in a worktree |
| `testing` | Testing-skill pins, `[{"skill": "<name>", "when": ["<path prefix or glob>"], "note": "how to use it here"}]`. `brief` marks a pin's skill required when the task's owned paths match `when`, or always when it has none (`references/briefing.md`) |

When worktree gates fail on missing dependencies or ignored files, list the files in the
repository's `.worktreeinclude`, or add them or the setup to the user's recipe, so the next worktree
gets them. For this one, install them in the worktree, or name the gate in the brief as one it
cannot run.

## Cleanup

```bash
$ORCH cleanup <run> [--delete-branches]     # removes worktrees with no uncommitted work
```

- `cleanup` runs each worktree's recipe `teardown` first.
- It ignores tool caches (`__pycache__`, `node_modules`, ...) and prep links.
- It keeps any worktree with other uncommitted changes and lists them. Only `--force` discards them.
- `--delete-branches` deletes only merged branches.
- Keep a pull request's worktree and branch until it lands; clean up only after that.
