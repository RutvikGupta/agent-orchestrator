# Patterns

Read this when you plan one of these shapes of work.

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
