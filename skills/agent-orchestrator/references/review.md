# Reviewing, accepting and reworking a result (step 6)

Read this before you review a result. Also follow the agent's
`~/.agents/skills/<agent>-delegate/references/review-and-land.md`.

## The review loop

```bash
$ORCH result <run> <task-id>   # the report, its checks, and the evidence for them
$ORCH review <run> <task-id>   # the other model reviews the work, read-only
$ORCH rework <run> <task-id>   # the review found defects: the author fixes them
$ORCH accept <run> <task-id> --note "<why>"   # the review found none
```

- Start with `result`, and check the work yourself ("Check it").
- A risky write task also gets `review`. Start it right after `result`, so that it runs while you
  check. A task is risky when it changes an interface, spans many files, or touches a risk from the
  `complex` tier list (`SKILL.md`, "Choose the agent and model"). For any other task, your own check
  can be enough: go to `accept`.
- When the review is done, `rework` if it found defects and `accept` if it found none. After a
  rework the task finishes again: start over at `result`.

## Read the result

```bash
$ORCH result <run> <task-id>   # report, orch-result, scope violations, health, tokens, files, session
git -C <task-cwd> status --porcelain && git -C <task-cwd> diff
```

`result` shows the agent's final message, its structured report (the `orch-result` block), its
**scope violations** (changed files outside the plan's `owns`), and its health. Treat all of it as
claims to check.

## Check it

- Read the whole diff against the brief, including untracked files.
- Reject scope creep: undo a scope violation, or keep it only for a reason you can state.
- Check any edits to existing tests before you trust a green gate.
- Check each reported check against its evidence. `result` and `accept` match each check's `cmd` to
  the commands the agent ran, taken from its event log. `result` prints beside the check:
  - `ran, exit N`: the latest matching run and its exit code (`ran, exit unknown` when the log has
    no exit code for it);
  - `NOT FOUND in the log`: no matching run;
  - `not a command`: the `cmd` is a description, not a command;
  - `no events log; evidence unavailable`.

  A check reported `pass` whose evidence is not `ran, exit 0` also prints a `WARNING`.
- The latest matching run decides: a gate that failed and then passed is a pass. Only the current
  attempt's log counts, plus the attempts that an automatic retry continued.
- A run matches a reported command when the two are the same command, ignoring whitespace outside
  quotes, a leading `cd` into the task's folder, `VAR=value` prefixes, `env` and `timeout`
  wrappers, output redirects, and a final pipe to `grep`, `tail` or `head`. Options that choose what
  runs or change what it checks (`-k`, `--lf`, `--check`, `--fix`, `--dry-run`) must be equal;
  other options are ignored. One command of an agent's `a && b` or `a; b` can match too, but its
  exit code may be unknown.
- `verify` runs are not part of this match. `result` lists them apart, under "Verifications".
- Still rerun the key gates with `$ORCH verify <run> <task-id> -- <command>`, which records the exit
  code, the commit and the output's tail.
- Check that the agent ran the testing skill that applies (its brief's "Testing skills"), or said
  why none could run.
- Check the messages the user sent it (`references/messages.md`), since they can change what it did.
- For a read-only task, check `readOnlyViolation` in `result --json`. Claude reports it; Codex's
  sandbox enforces read-only. The touched files are the whole `git status`, earlier changes too.

Record your own round of review:

```bash
$ORCH verdict <run> <task-id> clean|changes|reject --note "<why>" [--reviewer <review-task>]
```

`changes` makes the next attempt a rework, and `reject` closes the task. `--reviewer` names a
reviewer you started by hand; without it, the reviewer is you. `review` records its own reviewer's
round (next section).

## Review with the other model

```bash
$ORCH review <run> <task-id> [--tier <tier>] [--focus "<what to look at hardest>"]
```

`review` starts the other model (Codex on Claude's work, Claude on Codex's) as a read-only reviewer
of a finished task. It builds the reviewer's brief itself. When `wait` names the reviewer, read it
with `result <run> review-<task-id>`, and verify each defect it reports before you act on it.

- **Name.** `review-<task-id>`, then `review-<task-id>-2`, `-3` and on for later rounds. It works in
  the author's checkout, or in the run's repository once that checkout is gone.
- **Brief.** The author's brief, the diff of all the author's work since it started (commits,
  uncommitted changes and new files), then the author's final report, which the reviewer must check
  and not trust. It also gets the repository's testing skills and lessons, and the report to
  write: only defects it reproduced or can show from the code, each with its file and line,
  severity, a failing input and a fix.
- **Tier.** The diff sets it. `standard` is for at most 150 changed lines (added plus removed) in at
  most 3 files, none of them a module that other files import. Anything more is `complex`. Only
  relative imports of JavaScript and TypeScript files and the imports of Python files are read: a
  file in another language never counts as imported. `--tier` overrides the choice. `review` takes
  no `--why`: it records the size and the other-model reason as the reviewer's `--why`, and adds
  `--tier X given` when you overrode the choice.
- **A delegated agent** cannot start a reviewer stronger than its own task (`SKILL.md`, "Delegate
  well"). When the diff's tier is above it, `review` refuses and says so: pass a lower `--tier`.
- **A large diff.** The brief holds about 200 KB of diff, in whole files, in git's order. Each file
  that does not fit is left out (or the first is cut short when none fits whole), and the top of
  the brief names each one with its size and how the reviewer can read it.
- **`--focus TEXT`** adds a section telling the reviewer what to look at hardest. The usual checks
  still apply.
- **Refusals.** `review` starts nothing when the task still runs, has no changes since its work
  started, or already has a reviewer running. It also refuses a read-only task, a command task, a
  babysitter, and a task that is itself a review.

The reviewer ends with `VERDICT: changes` (it reports at least one defect) or `VERDICT: clean` on a
line of its own, then its `orch-result` block with one defect per line under `unresolved`.

- When a reviewer that `review` started has completed with a verdict line, `status`, `wait`,
  `result`, `accept`, `verdict`, `start` or `recover` records it once as a review round of the
  author's attempt that it reviewed (the round `verdict` records, with the reviewer's name), and
  prints `orch: recorded ...` on stderr. Only commands of the run's owner record it.
- A `changes` round keeps the findings, in short, as its note. The last verdict line wins.
- Only `clean` and `changes` are recorded this way. Record `reject` yourself with `verdict`. A
  reviewer that ended with no verdict line records no round: read its result, and record yours.

### A reviewer started by hand

`review` always uses the other model, its own brief and its own checklist. For another agent, or a
brief of your own, write the brief with `brief --type review` (`references/briefing.md`) and start
the reviewer read-only through `start`. Ask it to end as above, with the `VERDICT:` line and the
`unresolved` list. Then pass its task to `rework --from`, or record its verdict yourself with
`verdict --reviewer`. `review` never records a hand-started reviewer's verdict.

## Rework

```bash
$ORCH rework <run> <task-id> [--from <review-task>] [--note "<decisions>"] [--tier <tier> [--why "<why>"]]
```

`rework` resumes the task's own session, in its own working directory, with the findings of its
latest review, as a rework attempt (the attempt number goes up). It records the review's round
first. Write no delta brief.

- **What the author gets.** The reviewer's prose without its verdict line, and the findings of its
  `orch-result` block: `unresolved`, and any `findings`, `defects`, `issues`, `problems` or `bugs`.
  It also gets the scope, gates and house rules of its first brief. It is told to check each
  finding against the code first, add a test for each fix, and report what it did for each finding.
- **`--from REVIEW_TASK`** names the reviewer when it is not the latest `review-<task-id>`, such as
  one started by hand. `rework` treats a hand-started reviewer as having reviewed the task's
  latest attempt. A review of an earlier attempt is refused: review again.
- **`--note TEXT`** is your decision on which findings to fix, and how. The author follows it where
  it differs from the findings. Without it, the author fixes all of them, after checking each.
- **`--tier TIER`** and **`--why TEXT`** go to `start` ("Escalate a tier"). When the tier
  changes and you give no `--why`, `rework` writes one that names the review and both tiers.
  Without `--tier`, the task keeps its tier, or escalates by itself.
- **It refuses when the review found nothing:** `VERDICT: clean`, or no verdict line and no
  findings, and tells you to `accept` instead. On `VERDICT: clean` it makes sure the clean round is
  recorded; with no verdict line it records none.
- **It also refuses** when the task or the reviewer still runs, the reviewer ended without a result,
  the task has no review yet (start one with `review`) or no recorded session, or `--from` names a
  reviewer of another task. It refuses the tasks that `review` refuses.

A change of goal or scope, or findings of your own, are not a review's findings. Write a short
delta brief that names what to fix, record `verdict changes` so that the attempt counts as a
rework, and resume:

```bash
$ORCH start <run> <task-id> --agent <same> --brief <delta> -- --session <id>
```

Use the session id that `result` printed. The task keeps its working directory, and the attempt
number goes up. Leave out `--tier`, so that automatic escalation still applies ("Escalate a tier").

## Escalate a tier

A follow-up is any later attempt of a task: a rework, a resume, or a new attempt after a failure.
`SKILL.md`, "Choose the agent and model", says how to choose the agent and the tier.

- A follow-up of either agent may omit `--tier`: it keeps the tier of the task's last attempt. A
  Claude task recorded before tiers existed resumes at `complex`. A Codex task recorded before tiers
  existed needs `--tier`.
- It may omit `--why` when it keeps its agent and tier, or when `start` escalates it (the reason is
  then the earlier one, plus the escalation).
- **Two counted failures** at the task's tier: `start` moves the next attempt one tier up, in the
  task's last session when it has one, and prints a `note:` that says so.
- **Two more failures** at that higher tier, or two at the top tier: `start` refuses. It names the
  other agent and the tier to start there: the same rank, or the closest lower one. Start it with a
  fresh brief and a new `--why`.
- **Overrides.** `--tier` picks the tier itself, with no automatic move. A changed `--agent` starts
  a new count for that agent, and needs `--tier` and `--why`. `--no-escalate` keeps the tier and
  skips the refusal. A babysitter never escalates: its tier is fixed.
- **What counts as a failure:** an attempt that ended `failed`, `timeout` or `aborted`, and an
  attempt whose review round is `changes` or `reject`, whether `review` or `verdict` recorded it.
  Each attempt counts once.
- **What does not count:** an attempt that was stopped (`stop`, or `close` on a running task), an
  attempt that stopped on a usage limit, and one that an automatic retry (after a transient error)
  continued.
- A failed `verify` gate or a reported check that failed does not count either. After a failed
  attempt, a failed gate or a failed reported check, `start` prints a `note:` that advises
  redoing the work one tier up, and goes on. It prints none at the top tier, when you change agent,
  or when you already chose a higher tier.
- `result` and `status` show each task's count and the tier of each attempt.
- A delegated agent's escalation is refused when it lands above its own task's tier (`SKILL.md`,
  "Delegate well").
- To start over in a fresh session (an attempt that went far off track), pass `--tier` yourself,
  no `--session`, and a corrected full brief. An automatic escalation continues the last session.

## Accept

Implementers commit on their task's branch, unless they were started with `--no-publish`. Review
their commits (`git -C <worktree> log` and the diff from the base). If an agent left changes
uncommitted, commit them on the task's branch yourself, following the repository's commit-message
rules. Then record it, with your reason:

```bash
git -C <worktree> add <files> && git -C <worktree> commit -m "<message>"
$ORCH accept <run> <task-id> --note "<why>" [--commit <sha>] [--unverified "<reason>"]   # default: HEAD of its working directory
```

`accept` also reads the evidence for the reported checks ("Check it"):

- It refuses a write task when a check reported `pass` has a latest matching run that failed
  (`a passing check matched a failed run`).
- `--unverified REASON` accepts it anyway, and records REASON with the acceptance. Give it only
  after you reran the gate with `verify`, or read why the run failed. It needs a reason.
- In every other case it only warns on stderr, and accepts: a `pass` with no matching run, a `cmd`
  that is not a command, a matching run with no exit code, no event log, an invalid `orch-result`
  block, or a report with no passing check. It never refuses a read-only task for its evidence.
- A warning means the log does not back the claim, not that the gate fails: rerun the gate with
  `verify`.
- `accept` records the `verify` runs since the last review round with the acceptance, but never
  matches them to reported checks: look at them in `result`.
- It prints a note when no clean review round is recorded for the attempt.

## Lessons

When a failure or review shows a trap that is likely to recur, record it once it is verified:

```bash
$ORCH lesson <run> "<the trap and how to avoid it>" --evidence "<how you verified it>"
```

`--repo DIR` names the repository instead of a run, and `--list` prints the lessons. `brief` adds
them to later briefs for that repository (`references/briefing.md`). Keep the list short and true.
