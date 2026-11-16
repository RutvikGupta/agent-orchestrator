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
$ORCH start <run> babysit-<pr> --agent claude --babysit --pr <n> --why "babysits PR #<n>; watching needs no strong model" --brief <brief> --cd <checkout>
```

- It runs on Claude. It needs no `--tier`: it watches at `standard` (Sonnet) by default. That is its **watch tier**. `--tier light` or
  `--tier complex` sets another one, for a user who asks; `--tier frontier` is refused.
- The task records its watch tier (`watchTier`), and every later wake resumes at it. A babysitter
  recorded before watch tiers existed also watches at `standard` from its next wake on.
- It fixes at `complex` (Opus), in a separate attempt ("Watching and fixing", below).
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
and the run keeps one task for it, whose row, attempts and token totals go on adding up. A Codex
implementer hands its pull request over instead ("Hand it over from a Codex implementer", below).

1. Once the task has finished (it is not running), write the babysitter brief to a file of its own
   (`$ORCH brief <run> <task> --type babysit --out <file>`), and fill it in as above.
2. Start the task's next attempt as the babysitter, in its own session (`$ORCH result <run> <task>`
   prints the session id):

   ```bash
   $ORCH start <run> <task> --agent claude --babysit --pr <n> --brief <file> -- --session <id>
   ```

   It is then a babysitter like any other: it runs at the watch tier, with the same permissions and
   timeout, and parks and resumes as below. `start` checks the pull request as it does for a new
   babysitter.

   The babysitter keeps a **handoff note**, a file of at most 60 lines in the task's folder
   (`handoff.md`) that says what a fresh session needs to know. The session of an implementer can be
   large, and a large session costs a lot to continue:
   - When that session's latest call is above the handoff limit ("How it waits") and the task has a
     current handoff note (written since the implementer's last attempt started), `start` starts a
     fresh session from the babysit brief and the note instead of continuing that session. It prints
     a `note:` line that says so.
   - Without a current note it continues the session, and its brief tells it to write the note
     before it parks. Memory is never dropped without a note.
3. Rename it, so that its name shows it babysits that pull request:
   `$ORCH rename <run> <task> --to babysit-<n>`.

### Hand it over from a Codex implementer

Claude cannot continue a Codex session, so a pull request that a Codex task implemented goes to a new
babysitter task. That task starts from the babysit brief and the implementer's handoff note:

1. The implement brief (`references/briefs/implement.md`, "Handoff note") asks every implementer
   whose work becomes a pull request to write a handoff note before it finishes: the pull request
   and its branch, what it built, the decisions it took and why, the review items still open, and
   the gates it ran. It writes the note to a file and names that file in its final report.
2. Read the report with `$ORCH result <run> <task>`, and find the note's path there.
3. Write the babysit brief as in "Brief it", and add the note's text at its end, under a heading
   "Handoff note from the implementer".
4. Start the babysitter as in "Start it". It watches at `standard` like any other.

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
  The line also parks as the last line of the message's text; a `PARKED:` line in the middle,
  quoted or indented does not, and the task then ends as completed with nobody watching.
- A watcher of about 3 MB (a shell loop) then checks the pull request every minute and the task's
  inbox every few seconds. On the first event it resumes the same session, at the watch tier.
- `status` and the dashboard show the task as parked, with what it waits for. `wait` treats it as
  running. It takes no parallel slot but keeps its checkout.
- A message you `send` wakes it. `stop` and `close` end the watcher.
- `status`, `start` and the dashboard restart a watcher that died, for example after a reboot.

**Cold resumes hand off sooner.** Every call of a session sends its whole context again, so a large
session is costly to keep. A parked babysitter resumes in a fresh session from its brief and handoff
note, instead of in the same session, when its session's latest call was above the handoff limit and
the note is current (written since the parked attempt started). The limit is:

- `AGENT_ORCH_BABYSIT_HANDOFF_TOKENS` (default 150000) while the prompt cache is warm;
- `AGENT_ORCH_COLD_HANDOFF_TOKENS` (default 60000) when the resume's first call would read no prompt
  cache and write the whole context again. That is so when the parked attempt ended more than
  `AGENT_ORCH_CACHE_TTL` (default `1h`) less 5 minutes before, or when the resume runs another
  model: a wake after a fix attempt switches from Opus to the watch tier's model, and a fix attempt
  switches the other way.

The attempt records which limit applied, and `result` says so on its `fresh session:` line. Without
a current note the same session resumes, and its brief tells it to write one.

## Watching and fixing

A babysitter's wakes are mostly routine, so a watch attempt below `complex` does only the routine
upkeep itself: re-run a flaky check after reading its log, re-add a label, re-request a review, send
the repository's Slack pings, rebase or restack when there is no conflict, post a one-line skip note
on a bot's nit, and verify a merge. `start` appends a "Watch tier" section to the brief of every
watch attempt below `complex` that says so.

- **It does not change code or write substantive review replies.** When a wake needs a code change,
  a reply that explains or defends code, or a rebase with conflicts, it gathers the facts: failing
  check names, log excerpts from the repository's CI-log tool, thread URLs with comment text, and
  what it ruled out. It updates its handoff note, then ends with a final message whose first line is
  `NEEDS FIX: PR #<n> <one line>` and an `orch-result` outcome `partial`. The line follows the rules
  of the `PARKED:` line: as the first line, or the last line of text before the `orch-result` block,
  and not quoted, not indented, not in the middle.
- **The fix attempt starts at once.** When a watch attempt ends with `NEEDS FIX:`, its finish watcher
  starts the task's next attempt in the same session, at `complex` (Opus). Its attempt reason is
  `fix`: `status` and `result` show `(fix)` after its tier in the attempts line, and the dashboard
  shows the reason `fix`. Its brief says that it is the fix attempt for the reason given, and quotes
  the watch attempt's message. It fixes, runs the gates, commits, pushes, replies as the
  babysitter's rules say, updates the handoff note, and parks with `PARKED:`. The next wake resumes
  at the watch tier.
- **Its session.** The switch of model reads no prompt cache, so the cold limit applies to it. With a
  current note and a last call above that limit, it starts fresh from the brief, the note and the
  `NEEDS FIX:` text. Without a current note it keeps the session.
- **The start is the orchestrator's policy**, so the caller's own tier does not block it. An
  inherited ceiling (`AGENT_ORCH_MAX_TIER`) still applies: the task records the ceiling each
  attempt starts under, and its watcher keeps it whoever starts that watcher, the dashboard
  included.
- **It holds the watch attempt while it waits.** When the machine has no room, the fix start tries
  again for up to 10 minutes. Meanwhile any other start of the task is refused, and `stop` or `close`
  ends the wait with nothing started. A `stop` that comes before the fix start has begun keeps it
  from starting too.
- **When no fix starts**, the task shows as `needs-decision`, with the `NEEDS FIX:` text and why no
  fix started (`wait` exits 5; `result` prints it). This happens when the ceiling forbids `complex`,
  when the attempt that said `NEEDS FIX:` already ran at `complex`, and when no fix attempt has
  started 15 minutes after the watch attempt ended. Decide it as in `SKILL.md`, "Decisions agents
  hand back", and resume it by hand.
- Until the fix attempt starts, the task shows as running, with `needs a fix · <reason> · starting
  its fix attempt at the complex tier`.

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
