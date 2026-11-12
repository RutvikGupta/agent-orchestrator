# Babysitting a pull request (step 8)

Read this before you start a babysitter, and when one finishes. `SKILL.md` step 8 says when to start
one.

## Brief it

`$ORCH brief <run> babysit-<pr> --type babysit` copies `references/babysit-brief.md`. Fill in:

- the pull request's URL, branch, base, and checkout;
- the repository's babysitting skill, if it has one (for example `babysit-pr` under
  `.claude/skills/` or `.agents/skills/`), which the babysitter reads and follows;
- the repository's rules for commit messages, reviewer replies, review threads, CI logs, and gates.

## Start it

```bash
$ORCH start <run> babysit-<pr> --agent claude --babysit --pr <n> --why "babysits PR #<n>; Claude costs less than Codex" --brief <brief> --cd <checkout>
```

- It runs on Claude Opus, which costs much less of the user's limits than Codex.
- `start --babysit` refuses a pull request that is a draft or no longer open.
- The checkout must have the branch checked out. Prefer the run's worktree for it; no other task may
  then write there.
- A babysitter may commit, push without force, and reply on GitHub. Outside the sandbox, Graphite,
  commit hooks, and SSH work as they do for the user. Force pushes, admin merges, closing the pull
  request, and repository settings stay denied.
- Its timeout defaults to `24h`.

## Keep it with its implementer

When a Claude task of the run implemented the pull request, that task keeps it: make it the
babysitter instead of starting a new task. Its session already holds the pull request's context,
and the run keeps one task for it, whose row, attempts and token totals go on adding up.

1. Once the task has finished (it is not running), write the babysitter brief to a file of its own
   (`$ORCH brief <run> <task> --type babysit --out <file>`), and fill it in as above.
2. Start the task's next attempt as the babysitter, in its own session (`$ORCH result <run> <task>`
   prints the session id):

   ```bash
   $ORCH start <run> <task> --agent claude --babysit --pr <n> --brief <file> -- --session <id>
   ```

   It is then a babysitter like any other: it runs `complex`, with the same permissions and timeout,
   and parks and resumes as below. `start` checks the pull request as it does for a new babysitter.
3. Rename it, so that its name shows it babysits that pull request:
   `$ORCH rename <run> <task> --to babysit-<n>`.

A Codex implementer cannot keep its pull request this way: a babysitter runs on Claude, which cannot
continue a Codex session. Start a new babysitter for it.

**Make it a babysitter; never tell it by message to babysit.** An implementer that a message tells
to watch its pull request stays an implementer. It waits on its own timers or background scripts:
it does not park, no watcher wakes it, and it reads no message until its own wait ends (it is
`idle`, `references/messages.md`). It also holds a parallel slot the whole time. To hand a running
implementer its pull request, stop it once it has pushed (`$ORCH stop <run> <task>`), then start its
next attempt as the babysitter in the same session, as in step 2 above:
`$ORCH start <run> <task> --agent claude --babysit --pr <n> --brief <file> -- --session <id>`.

### Names

`$ORCH rename <run> <task> --to <name>` gives a task a name. `status`, `wait`, `result`, `recover`,
`stop`, the Stop hook, finish notices and the dashboard show the name in place of the task's id;
`result` and the dashboard's details also show the id and earlier names. Every command that takes a
task takes the name too, in that run, and an id always wins over a name.

- The id stays the key of everything the task has: its folder, inbox, worktree, branch, nested runs,
  park watcher, and `AGENT_ORCH_TASK` in its shell. A rename restarts nothing, on a running, parked,
  finished or closed task.
- A name must be a valid task id, and not the id or name of another task of the run, or a task of
  its plan.
- The task records each name with when and who set it. `rename` again changes it, and `--to` the
  task's own id removes it.
- The run's owner renames any of its tasks. A task's own agent may rename itself, and the owner
  gets a notice of it, as of a change by the user.

## How it waits

It waits with `orch.mjs pr-watch`, which spends no tokens while waiting. `pr-watch` exits:

- 0 when the pull request needs attention;
- 3 when nothing is new;
- 4 when the checkout has commits the pull request lacks;
- 6 when a new unread message reaches this agent.

**Parking.** When a watch finds nothing new, the babysitter parks:

- It ends its turn with a final message whose first line is `PARKED: PR #<n> waits for <what>`, and
  its agent exits.
- A watcher of about 3 MB (a shell loop) then checks the pull request every minute and the task's
  inbox every few seconds. On the first event it resumes the same session, at the same tier.
- `status` and the dashboard show the task as parked, with what it waits for. `wait` treats it as
  running. It takes no parallel slot but keeps its checkout.
- A message you `send` wakes it. `stop` and `close` end the watcher.
- `status`, `start` and the dashboard restart a watcher that died, for example after a reboot.

## While it runs

Do not stay active only to watch it.

- In Claude Code, run `$ORCH wait <run> babysit-<pr> --timeout 0` in the background.
- In Codex, do not loop on `wait`, because every wake-up spends Codex usage. Tell the user that the
  babysitter runs and that the dashboard shows it, then end your turn or continue other work.

## When it finishes

1. Read its report with `$ORCH result`.
2. Verify the claimed final state with `$ORCH pr-watch <pr> --once`.
3. Pass on to the user anything it left for them.

Then, by why it stopped:

- **A decision:** handle it as in `SKILL.md`, "Decisions agents hand back", and resume it at once.
- **A repeated failure:** fix it, or ask the user.
- **A publishing blocker:** fix the cause when it is in the setup, and resume it.
- **Only you can publish:** review its commit, re-run the gates, and publish it with the repository's
  normal command (for Graphite, `gt submit --update-only --no-edit --no-interactive`). Then resume it
  to keep watching.
