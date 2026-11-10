# Writing briefs (step 3)

Read this before you write your first brief in a session. Also follow the agent's
`~/.agents/skills/<agent>-delegate/references/writing-the-brief.md`.

## What `brief` does

```bash
$ORCH brief <run> <task-id> [--type implement|review|research|debug|babysit] [--read-only] [--out FILE] [--force]
```

- It writes a draft from `references/briefs/<type>.md` to the plan's `brief` path (by default
  `<run-dir>/briefs/<task-id>.md`), or to `--out`, and prints the path.
- It refuses to overwrite a brief without `--force`. `--type` defaults to the plan's type.
- It fills in what `plan.json` says about the task: the goal, the owned paths (and what other tasks
  own), `uses`, `produces`, `resources`, and the tasks it builds on.
- The role line follows the type and the read-only mode: the plan's `readOnly`, `--read-only`, or
  else reviews and research.
- Under "House rules", it lists every `AGENTS.md` and `CLAUDE.md` at the root, in the owned paths,
  and in their parent folders, each with its section headings.
- Under "Known traps in this repository", it adds the user's verified lessons for the repository
  (`~/.agents/orch-recipes/lessons/<key>.md`; `references/review.md`, "Lessons").
- It leaves a `<fill in: ...>` marker wherever a fact is needed, and prints how many.

Before you dispatch, also copy in the house rules that matter, and delete the file list.

## Testing skills

Under "Testing skills", `brief` lists the repository's skills for testing a change with synthetic
data or an end-to-end run (in `.claude/skills/` and `.agents/skills/`):

- first the recipe's matching `testing` pins, marked **Required** (`references/worktrees.md`);
- then the most relevant others for the task.

The agent must run the one that applies and report it as a check, or say in one line why none
applies or can run here. A review brief asks the reviewer to check that. Research and babysitter
briefs omit the section.

## The shape of a brief

Every brief must stand alone. The templates give it this shape:

- a **role line**: "You are a delegated implementer ... Commit your work on this branch as you go
  ...; push it, or open a pull request, when your task calls for it". A write task may delegate,
  as the "Delegating further" note that `start` appends says; a read-only one may not.
- the **goal** and testable done criteria;
- the **context** the agent cannot discover quickly: relevant files, decisions already made, and the
  agreed shape of each interface in `uses` and `produces`;
- the **scope**;
- the **house rules**, copied in, because Claude loads only `CLAUDE.md` and Codex only `AGENTS.md`;
- the **gates**: the project's real test, lint and build commands, plus the applicable testing
  skill;
- the **report contract**.

Put the decisions you already made in the brief.

## What `start` appends

- **"Decisions"** tells the agent never to wait idle or leave a point "pending a decision". It
  decides what the brief covers. It reports a blocker at once: a gate that cannot run, a missing
  credential or service, or a failure that survived two fixes. It asks about anything beyond the
  brief with `ask` while it keeps working. It ends with `NEEDS DECISION:` only when nothing else is
  left (`SKILL.md`, "Decisions agents hand back").
- **"Structured result"** asks for an `orch-result` block, which `result` parses: outcome, changed
  files, checks (including the testing-skill check, or why none ran), decisions handed back, and
  what is unresolved. It caps the final message at about 25 lines, with long evidence in a file;
  `wait` flags a longer report.
- **"Delegating further"** tells the agent how to delegate its own pieces. Only a write task that is
  neither sandboxed nor offline gets it, and only above the last level of nesting
  (`AGENT_ORCH_MAX_DEPTH`).
