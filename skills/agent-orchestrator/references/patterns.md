# Patterns

Read this when you plan one of these shapes of work. Each one starts more than one agent, so each
must pass the break-even in `references/tiers.md` ("Return on cost") before you use it; the
conditions below say when it usually does.

- **Parallel build:** one write task per independent area, each in its own worktree, then a
  cross-agent read-only review of the combined diff before the final merge. `review` covers one
  task's diff, so brief this review by hand (`brief --type review`).
- **Second opinion:** the same read-only brief to both agents in the main checkout. Compare their
  findings, verify each claimed defect yourself, and report only those that survive.
- **Implement, then review, then fix:** one agent implements; `$ORCH review` has the other model
  review it read-only; `$ORCH rework` resumes the implementer with the findings you kept
  (`references/review.md`).
- **Competing hypotheses (debugging):** when a bug has several plausible causes, start one
  investigator per candidate cause (`brief --type debug`). Give each an experiment that tells its
  cause apart from the others, and have each report `confirmed`, `falsified`, or `inconclusive`
  with its evidence. Then fix the confirmed cause in one write task.
- **Research fan-out:** split broad research into independent areas, one task per area, all at
  once. Research agents run on Codex with live web search (`brief --type research`, then
  `start <run> <id> --agent codex --tier strong --read-only --why "..." --brief <file> -- --web-search live`).
  Merge their answers yourself, and check the claims that matter against their sources.
- **Long sequential queue:** one task at a time, each one landed before the next is dispatched. See
  `~/.agents/skills/codex-delegate/references/multi-task-queues.md`.
- **Best of N, on a cheap tier:** the same write brief to 2 or 3 agents of a cheap tier, each in its
  own worktree, and a test that picks the winner. Use it in place of moving the task up a tier, and
  only when all of these hold:
  - A command can tell a right result from a wrong one, such as a failing test that must pass or an
    eval with a threshold, and every attempt runs it. Without one, choosing among attempts costs a
    review each and gains little: use one attempt one tier up instead.
  - The N attempts together cost less than one attempt at the tier above, by each tier's median cost
    per task (`$ORCH cost`). In November 2026 three Codex `standard` attempts cost about $0.45 against
    about $5.30 for one Opus attempt, and pass; three Sonnet attempts (about $5.25) save nothing over
    one Opus attempt, and do not.
  - The task is hard enough that one attempt often fails: its tier's first-try acceptance for this
    kind of task is under about 60%. A task one attempt usually gets right needs one attempt.

  Start N at most 3. As `wait` returns each result, run the test on it, accept the
  first that passes, and stop the others at once (`$ORCH stop`): attempts still running after a winner
  are pure cost. When none passes, do not start another round of N: move the task up one tier.
- **Team of reviewers, for a large or risky diff:** 2 or 3 read-only reviewers in parallel, each
  with one focus (for example correctness, security, data handling), in place of one generalist.
  Reviewers that each look for one kind of mistake find more than the same number sharing one
  checklist. Use it only for a diff over about 500 changed lines, or one touching security,
  authentication, data migrations, billing or money; any other diff gets one reviewer (`$ORCH
  review`). Run each at the cheapest tier that reviews its focus well: in November 2026 a reviewed
  diff cost about $0.24 on Codex `standard`, $0.93 on `strong` and $3.68 on Claude `complex`, so a
  team of three Codex `standard` reviewers costs less than one Opus review. `review` starts one
  reviewer per task, so start the team by hand (`references/review.md`, "A reviewer started by
  hand"): one `brief --type review` per focus, the focus first in each brief. Merge their findings,
  verify each yourself, drop duplicates, and record one verdict (`verdict --reviewer` with the
  reviewer whose findings decided it).
