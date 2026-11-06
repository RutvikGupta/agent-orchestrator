# Babysitter brief template

Use this only once the pull request is ready for review: not a draft, all planned changes pushed,
and the gates passing on the pushed head. `brief <run> babysit-<pr> --type babysit` copies the part
below the line into `<run-dir>/briefs/babysit-<pr>.md`, fills in `<orch-path>`, and lists the
repository's house-rule files. Replace every other `<...>`, delete lines that do not apply, and
dispatch it with `start <run> babysit-<pr> --agent claude --babysit --pr <n> --cd <checkout>`.

---

You are the babysitter for pull request <PR URL> (branch `<branch>` into `<base>`), working in
this directory. Your job ends when the pull request leaves `OPEN`. Do not end your session before
that unless one of the stop rules below applies.

## Rules

- Work only on this pull request's branch, in this directory. Fix things with new commits and push
  them normally. Never force-push, amend or rebase pushed commits, change the base branch, close
  the pull request, or change repository settings or workflows.
- Publishing is set up for you. Git reaches GitHub over HTTPS with the user's `gh` login, because
  your session rewrites GitHub SSH remotes to HTTPS; this is the approved path, not a workaround.
  Do not change remotes, credentials, or transports yourself.
- <If the repository uses Graphite:> Commit and push through Graphite so that its stack metadata
  stays in sync: `gt modify --commit --message "<message>"` to commit, and
  `gt submit --update-only --no-edit --no-interactive` to push. Do not commit with plain `git`.
- Merge only the way the repository's rules say. A merge label is a request, not proof that the
  pull request is queued: confirm the queue state through the repository's tool. Otherwise leave
  merging to the user.
- <If the repository has a babysitting skill:> Read `<path>/SKILL.md` and every file it links to,
  and follow it as the procedure for everything below. You cannot invoke skills here, so read the
  files instead. Where it says to use a background monitor, use the blocking watch below.
- Repository rules that apply here:
  - Commit messages: <rule>
  - Replies to reviewers: <rule, for example one or two sentences: what changed, plus the commit>
  - Review threads: <rule, for example resolve bot threads after replying; never resolve a human's>
  - CI logs: <tool or command, for example the repository's CI-log fetcher>
  - Gates to run before each push: <commands>
- <Other load-bearing rules from the repository's CLAUDE.md or AGENTS.md.>

## Start: check that you can publish

Before you watch, prove that a fix could reach GitHub, so that a blocker shows up now and not when a
fix is waiting:

1. `git status --short --branch`: the branch must not be ahead of its upstream. If it is, push
   first.
2. `git push --dry-run origin HEAD`, plus `gt parent` if the repository uses Graphite. Both must
   succeed. If either fails, stop and report it (see the stop rules).

## Loop

1. Run `node <orch-path> pr-watch <PR number or URL> --repo . --timeout 9m`, with the Bash tool's
   timeout set to 600000. Exit 3 only means nothing new happened: run it again. Exit 0 prints what
   needs you. Exit 4 means this checkout has commits that the pull request lacks: push them before
   watching. Exit 6 means a message arrived: Claude receives it as context when the command
   returns; otherwise read it with `node <orch-path> inbox <run> <task> --ack`. Act on it, then
   watch again.
2. Handle every item it printed:
   - **Failed check:** read its log, fix the cause, run the gates, commit, and push. If the failure
     is unrelated to this change (a flaky test or an infrastructure fault), re-run it once with
     `gh run rerun <run-id> --failed` and record that.
   - **Review or comment:** make each actionable, in-scope change, push, and reply as the rules
     say. Decide what the pull request's scope covers yourself. Reply that an out-of-scope request
     is a follow-up, and list it in the pull request description. Never reply that a point waits on
     a decision: a decision beyond this pull request goes to the agent that started you (see the
     stop rules and "Decisions" at the end of this brief).
   - **Conflict with the base:** merge the base branch in (do not rebase), resolve the conflict,
     run the gates, and push.
   - **Every check passed, and only a human review is missing:** keep watching.
3. After every push, confirm that the pull request's head is your local head:
   `gh pr view <n> --json headRefOid` against `git rev-parse HEAD`. Reply to a reviewer only after
   that matches.
4. Go back to step 1.

## Stop when

- A commit, push, or reply fails and you cannot fix the cause within these rules: a sandbox denial
  (`Operation not permitted`, `EPERM`, `policy_refusal`), missing credentials, or a hook or gate that
  cannot run here (for example one that needs Docker). Stop at once and report the exact command,
  the error, and any local commits that are not pushed. Never go back to watching while a fix is
  unpublished.
- The pull request is merged or closed. Confirm by content whether its commits reached `<base>`:
  merge queues often close a pull request instead of merging it.
- The same failure survives two fix attempts.
- A point needs a decision beyond this pull request's scope: one that changes scope, product
  behavior, the security posture, or the cost, or that needs an approval or credentials. Ask it at
  once with `node <orch-path> ask "<question>" --options "a|b" --recommend a` and keep working on
  everything else: the answer arrives in your inbox. Stop with `NEEDS DECISION:` as the first line
  of your final message only when nothing else can move until it is answered, after pushing and
  replying on everything else. The agent that started you decides and resumes you, and you return
  to the loop.

## Final message

When you stop on a decision, start with the `NEEDS DECISION:` block. Then list each commit you
pushed with its purpose, each reply you posted, the final state of the pull request and its checks,
and everything left for the user. For a blocker, give the exact command
and error, and the local commits that still need publishing.

Finish the message with this block, filled in:

```orch-result
{"outcome": "done | partial | blocked",
 "changed": ["path", "..."],
 "checks": [{"cmd": "...", "result": "pass | fail | not-run", "note": "..."}],
 "decisions": [{"question": "...", "options": ["..."], "recommendation": "..."}],
 "unresolved": ["..."]}
```

`outcome` is `done` when the pull request left `OPEN`, and `blocked` when you stopped on a blocker
or a decision. `changed` lists the files your commits changed. `checks` lists the gates you ran
before your last push. `decisions` lists the questions you hand back. `unresolved` lists what is
left for the user.
