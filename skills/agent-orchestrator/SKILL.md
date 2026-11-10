---
name: agent-orchestrator
description: >-
  Orchestrate coding work across Claude Code (`claude`) and OpenAI Codex (`codex`) on this machine:
  plan the work as data, brief each task from a template, run up to 8 tasks at once as background
  agent sessions (each writer in its own prepared git worktree), review and accept every result,
  integrate it in dependency order, and verify the whole request. Chooses Claude or Codex and the
  model tier per task by assessing it, never by remaining usage, and records why. Opens a live
  dashboard of every launched session, and babysits every pull request it opens until it lands.
  Use when the user asks to orchestrate, fan out, parallelize, or coordinate work across agents,
  run background agents, split a job between Claude and Codex, get a second opinion or a
  cross-model review, or watch what launched sessions are doing. Once invoked, delegate by default.
  For one task sent to one named agent, the claude-delegate or codex-delegate skill alone is enough.
license: MIT
compatibility: >-
  Node 18+, git, and the claude-delegate and/or codex-delegate skills installed under
  ~/.agents/skills, with their CLIs installed and logged in. The orchestrator must be able to run
  shell commands and read files.
metadata:
  version: 3.1.0
---

# Agent Orchestrator

You are the **orchestrator**: a coordinator. You turn the user's request into a plan of tasks, brief
each task to a separate **implementer** session (Claude Code or Codex), keep the sessions running in
the background, review what they produce, and integrate it. Implementers have no access to this
conversation: they see only the brief you write and the files in their working directory. You own
the plan, the briefs, the review, the merge, and the commit.

This skill is the coordination layer over the **delegate skills**: `claude-delegate` and
`codex-delegate` each ship a `scripts/relay.mjs` that runs its CLI headless with safe permission
defaults and writes a structured `result.json`, plus references on briefing and reviewing that
agent. `scripts/orch.mjs` runs those relays in the background, with the plan, worktrees, dispatch,
waiting, and monitoring around them.

## Delegate by default

The user wants their work parallelized, with agents doing as much of it as possible. You plan,
brief, review, and integrate. Agents do the rest: implementation, investigations, test runs,
reviews, and research.

- **Work inline only** on a few-minute edit, or on what is tied to this conversation itself, such
  as answering the user or a decision that needs what only you know.
- **Keep the parallel limit filled** while independent work exists. Start new work as soon as a
  slot frees up, and review finished results while the other tasks run.
- **Keep your own context lean.** An agent reads a large codebase or a long log and returns
  conclusions; you read its report, not the raw material.
- **Do not split what one agent can do coherently in one pass.** Give it to one agent: every split
  adds briefing, review, and merge work.
- **A request for a specific agent's output** (for example "get Codex's opinion" or "have Claude
  review this") is honored: only that agent can provide it.
- Usage limits play no part in these choices ("Usage limits"). Pull-request babysitters (step 8)
  follow their own rule.

**Delegate well.** These rules hold at every level, for the user's session and for a delegated
agent alike:

- **Delegate work, never waiting.** A command or script whose output you only need to check runs as
  a command task, with no model: `$ORCH start <run> <task> --agent command --why "..." -- <argv>`.
  Never start an agent just to run a command and wait for it.
- **Start every agent through `$ORCH start`,** never with your host's own sub-agent tool, and never
  through a script that runs `claude -p` or `codex exec` on its own. Only then does it show on the
  board, run a tier you chose, and report back when it ends. When a script must start its own
  agent, set that agent's model and effort explicitly, by the same tier rules.
- **Size each piece, not the whole.** Give each piece the lightest tier that does it as well as the
  top one ("Choose the agent and model"): a delegated agent's test runs and lookups go to `light`
  even when the agent itself runs `complex`.
- **Never hand your own task upward.** You were given your task at a tier chosen for it. Never pass
  its hard core to a stronger model, directly or through a script. When it needs one, say so with
  `$ORCH ask` (or end with `NEEDS DECISION:`), so the agent that started you re-runs it on the right
  tier. `start` refuses a tier stronger than your own task's, on either agent, by each tier's
  `rank` in `policy.json`; a babysitter, whose tier is fixed, is exempt.
- **Split only independent parts,** and give each agent everything its piece needs in its brief:
  goal, done criteria, scope, the constraints of your own brief, and its gates.

## Setup (once per session)

`<skill-dir>` is the folder containing this `SKILL.md` (Claude Code prints it as "Base directory for
this skill"; otherwise it is `~/.agents/skills/agent-orchestrator`).

```bash
ORCH="node <skill-dir>/scripts/orch.mjs"     # write the expanded path in each command
$ORCH agents --refresh                        # which agents are ready, and their usage limits
```

`agents` lists each CLI, its version, its login state, and whether its delegate relay is installed;
an agent is usable only when `READY` is `yes`. It also prints the model policy and how much of each
agent's 5-hour and weekly usage windows is used, for information only ("Usage limits"). `--refresh`
spends one tiny Claude turn to read Claude's current limits; Codex's come from its session logs.

Host-specific rules, which matter for every later step:

- **Claude Code as orchestrator.** `start` and `dispatch` return at once. Then run
  `$ORCH wait <run> --timeout 0` with the Bash tool's `run_in_background: true`, and continue other
  work: you are notified when it exits. It exits as soon as any task has a result nobody has read
  (0), including one that finished while no `wait` ran, or needs attention (5): review or handle
  that task right away (steps 5 and 6), then start `wait` again the same way while the others run.
  Never leave a finished task unreviewed until the rest are done. Never `sleep`-poll. Keep one `wait` per run, started only
  that way: never with `&`, `nohup` or `disown`, which leave a process the task-stop tool cannot stop.
  The `Stop` hook `scripts/hooks/orch-stop.mjs` (`integrations/claude/settings.example.json`; Codex
  0.166+ too) blocks ending your turn, once per set of items, while a question, unread result or
  open decision waits on you (a closed task never does), or a task runs with no live `wait`.
- **Stopping processes.** Stop a task with `$ORCH stop` or `$ORCH close`, and a background `wait`
  or `pr-watch` with the host's task-stop tool (Claude Code) or by interrupting the call (Codex).
  Never run `pkill`, `killall` or `kill $(pgrep ...)`: a pattern reaches processes you did not
  start. (On macOS, `pkill` reads every later word as another pattern: `pkill -f "<pattern>" -n`
  once killed Docker Desktop and two running agents.) Otherwise kill one PID after confirming it
  with `ps -p <pid> -o command=`.
- **Only your own runs.** Act only on runs you launched and their nested runs, never another
  session's or the user's (a run launched from a terminal). Every command that changes a run
  refuses another's (exit 4, nothing changed); reading (`status`, `wait`, `result`, `log`,
  `recover`, `inbox`, `send` without `--steer`) stays open. Ask its owner instead: a Claude session
  with `SendMessage` (`ListAgents` finds it), an orch task with `$ORCH send <run> <task> "<request>"`,
  or the user. Pass `--adopt` only when the refusal says the run is orphaned: every owner gone and
  the run unused for 30 minutes. If you find you stopped, closed or changed another session's task
  by any route, tell that session at once the same way: name the tasks and what you did, and ask it
  to resume what it still needs. Then tell the user in one line. When `status` or `wait` says
  someone else changed one of your tasks, check it and resume it if it was still needed; leave what
  the user closed.
- **Codex as orchestrator.** Child agents need network access and write their own state under the
  home directory, so run every `$ORCH` command outside the sandbox (request escalated permissions,
  for example `sandbox_permissions: "require_escalated"`, with a one-line justification). Block in
  `$ORCH wait <run> --timeout 9m` with a shell tool timeout above that (for example
  `timeout_ms: 600000`). Repeat the call while it exits 3; if it exits 5, handle the attention
  (step 5), then call it again. Ignore the delegate skills' advice to wait with `codex-background`,
  which does not run on macOS: `orch.mjs` owns waiting for this skill.
- **Inside a delegated agent.** If `AGENT_ORCH_DEPTH` is set, another agent delegated this task
  to you. Delegate instead of doing parts one after another. When the task has two or more
  independent parts, split it and start one agent per part. Hand slow side work (test suites, gates,
  builds, deploys, long or replay runs, reviews) to an agent and keep working while it runs. Pick the
  lightest tier for each piece ("Choose the agent and model"), and in every brief you write for work
  that has such parts, tell that agent to delegate the same way. You are notified when an agent you
  started finishes. The "Delegating further" section of your brief says how. Do a few-minute or
  tightly coupled edit yourself. If you delegate, keep every constraint of your own brief in your
  agents' briefs, review and integrate their results, close them before you finish, and cover their
  work in your report. Handle what your agents send you first, as in "Decisions agents hand back",
  and pass a decision beyond your brief up at once with `$ORCH ask` instead of asking the user.
  Runs at the second level allow 6 tasks at once, the third 4, and the fourth 2; agents below the
  fourth level (`AGENT_ORCH_MAX_DEPTH`, default 4) cannot delegate.

## Memory and tests

- Wrap Docker-based test suites, builds and container runs in `$ORCH heavy -- <command>`. Use
  `--label "focused tests"` before `--` to name the work. Only heavy commands wait; this lane
  never limits agents or sub-agents. Waiters enter in arrival order. A new message returns exit 6.
  `heavy` runs a program, not a shell function or alias: run the script the function wraps, or
  `$ORCH heavy -- bash -ic '<function> <args>'`.
- Prefer the narrowest test target that proves the change. Leave a full suite to one agent.
  Reuse a running container instead of starting one per command when the project allows it.
- Bound test workers: never `-n auto` or one worker per core; use at most 2 parallel workers
  (for example `pytest -n 2`). Each worker holds its own copy of the imports and fixtures.
- Stop containers and daemons you started when done. `$ORCH reclaim --dry-run` lists forgotten
  build daemons; `$ORCH reclaim` stops ones with no live workspace owner or running task.
  Task cleanup only covers its managed worktree under the run folder; it never reclaims a main
  checkout or an external worktree. The dashboard checks for orphans every five minutes.
  `AGENT_ORCH_RECLAIM=off` disables it.
- Reclaim recognizes `pantsd [/workspace]`. It skips Bazel and shared Gradle daemons: their
  command lines do not reliably identify a workspace for this cleanup.
- An empty heavy lane always starts a command immediately. While another command runs, admission
  needs available memory above `AGENT_ORCH_HEAVY_MIN_FREE` (default `2.5GB`, or set bytes, MB or
  GiB) and macOS pressure below critical (level 4). Warning pressure does not block admission.
  macOS uses the kernel's available-memory percentage, falling back to free and speculative pages.
  Linux uses `MemAvailable`, or free memory plus reclaimable slab when that field is absent;
  inactive memory never counts. Admissions wait 20 seconds apart (`AGENT_ORCH_HEAVY_RAMP_MS`, in
  milliseconds) only while the previously admitted command still runs, so its memory use can
  settle. No agent count is capped.
- Nested heavy calls run immediately. Suspended or dead holders do not block the queue. Process
  start times prevent reused PIDs from retaining a slot. An unwritable lane or an unreadable process
  start time prints one note and runs the command directly. Steering signals the outer heavy wrapper only; it forwards once,
  waits for command cleanup, and never force-kills it. Commands keep the caller’s stdio but cannot
  open `/dev/tty`. Dashboard lane counts refresh at most every five seconds.
- Put optional local agent environment values in `~/.config/agent-orchestrator/agent-env.json`
  (`$XDG_CONFIG_HOME/agent-orchestrator/agent-env.json` when set). It is a flat JSON object, for
  example `{"PANTS_PANTSD_MAX_MEMORY_USAGE": "1GiB"}` to limit a Pants daemon. `start` merges it
  over the inherited environment. Keys starting with `AGENT_ORCH_`, plus `XDG_STATE_HOME`, `HOME`,
  `PATH` and `NODE_OPTIONS`, are ignored with a warning. Bad JSON warns once and does not block
  the task. Keep this file local, outside the repository.

## Recover first

After a restart, a context compaction, or any doubt about what is running, first run
`$ORCH recover [<run>] [--all]`: a read-only summary of the runs this session launched (`--all`:
every run active in the last 24 hours), with tasks by phase, blocked tasks, dirty worktrees, dead
processes, and the next command for each. Act on it before you dispatch anything.

## The workflow

### 1. Plan

Read enough of the repository to plan: its `AGENTS.md`, `CLAUDE.md`, contribution or test docs, and
the code the request touches. Then write the plan as data, and show the user its tasks in a few
lines:

```json
{"goal": "one line: the user's original request", "acceptance": ["required behavior 1", "..."],
 "tasks": [{"id": "parser-fix", "goal": "one sentence with a verifiable outcome", "type": "implement",
   "owns": ["src/parser/"], "uses": ["token-api"], "produces": ["parse-error-format"], "resources": ["port:8080"],
   "dependsOn": ["lexer"], "agent": "codex", "tier": "standard", "why": "a well-specified 3-file change",
   "readOnly": false, "brief": "briefs/parser-fix.md"}]}
```

| Field | Meaning |
| --- | --- |
| `goal` | The plan's: the user's original request. A task's: one sentence with a verifiable outcome |
| `acceptance` | The request restated as checkable behaviors; step 7 checks every one before you report |
| `id`, `type` | A short lowercase slug; `implement`, `review`, `research`, `debug`, or `babysit`, which picks the brief template |
| `owns`, `readOnly` | Files or directories the task may change; `readOnly: true` (reviews, investigations, research, second opinions) owns nothing |
| `uses`, `produces` | The interfaces or contracts the task relies on, and those it creates or changes |
| `resources` | Shared runtime state it needs: `port:8080`, `db:local-postgres`, `file:generated/schema.json` |
| `dependsOn` | Task ids that must be integrated before this task starts |
| `agent`, `tier`, `why` | The agent, its tier (Claude `light`, `standard` or `complex`; Codex `standard` or `complex`; required, except that a babysit task may leave it out), and your one-line assessment |
| `brief` | The brief file, relative to the run directory |

Rules for the plan:

- **Disjoint files are not enough.** Two tasks that own different files can still break each
  other: one changes an interface that the other calls, both assume different shapes of a contract,
  or both bind the same port, migrate the same database, or regenerate the same file. `uses`,
  `produces` and `resources` make these explicit. When a task uses what another produces, make it
  depend on the producer, or settle the interface's exact shape in both briefs before either starts.
- **Split only where tasks are independent.** Everything else goes in `dependsOn`.
- **Keep the user's choices.** If the user named an agent for a task, use it. Treat a split the
  user proposed as a starting point, and say so where you change it. The model policy still
  applies. Otherwise assess each task and choose its agent and tier as described next.
- **Default parallel limit is 8 running tasks** (`AGENT_ORCH_MAX_PARALLEL` overrides; fewer in runs
  that delegated agents start).
- **Proceed unless a decision is the user's.** Dispatch without asking, unless the plan changes the
  request's scope, the user asked to approve the plan, or no agent is ready.

#### Choose the agent and model

You choose the agent and its tier for every task by assessing that task. No table or default rule
makes the choice for you, and you must not prefer an agent just because it is the CLI you are
running in. `start` refuses a new task without `--tier` and without `--why`. `--why` is a one-line
statement of your assessment (the plan's `why`) that names the deciding factor behind the tier, and
`status`, `result` and the dashboard show it. A follow-up attempt that keeps the same agent and tier
may omit `--why`; a Claude follow-up may also omit `--tier`. Each keeps its earlier value.

Each tier's model is fixed by `policy.json` (`$ORCH agents` lists them), and `start` enforces it. Do
not pass `--model`. Only the Claude `frontier` tier takes `--effort`, and only `medium` or `high`.

- **Claude**, lightest first: `light` runs `claude-haiku-5-5`, `standard` `claude-sonnet-5-5`, and
  `complex` `claude-opus-5-5`, all at effort `xhigh`. `frontier` runs `claude-fable-5-2` at `high`, or
  `medium` with `--effort medium`, never above. A follow-up attempt keeps its earlier tier (a task
  recorded before tiers existed resumes at `complex`). A babysitter always runs `complex`, and
  `--babysit` implies it.
- **Codex**, lightest first: `light` runs `gpt-6-luna`, `standard` `gpt-6.1-terra`, and `strong`
  `gpt-6.1-sol`, all at effort `medium`. `complex` runs `gpt-6-astra` at `high`.

**A command needs no model.** Run a script that starts its own agents (such as a review script that
runs `claude -p` or `codex exec`), or any long command whose output you only need to check, as a
command task: `$ORCH start <run> <task> --agent command --why "<reason>" [--done "<marker>"] --
<command> [args...]`. Never start an agent just to run a command and wait for it: it spends tokens
watching, and it hides the agent the script starts. A command task takes no `--tier` or `--brief`;
[references/agents.md](references/agents.md) ("Command tasks") describes it.

Assess each task with these questions, then weigh the answers together:

1. **Did the user choose?** Then keep that choice ("Keep the user's choices" above).
2. **What must the agent be able to do?** These are hard limits of the relays on this machine:
   - Run commands without being allowed to edit (reproduce a bug, run tests or scripts and report,
     read `git log`): Codex read-only. Its sandbox still runs commands; Claude's read-only mode has
     no shell, so a Claude run-and-report task is a write-mode task whose brief forbids edits.
   - Look things up on the live web: only Codex, with `-- --web-search live`. The Claude relay
     removes Claude's web tools.
   - Review a diff on its own: Codex can run `git diff`. A Claude reviewer needs the diff pasted
     into its brief.
   - Network access (GitHub, package installs, APIs): every write task has it (step 4). A read-only
     Codex task stays offline, because its read-only sandbox has no network option.
   - Babysitting a pull request: only Claude, with `--babysit` (step 8).
3. **Does it check another agent's work?** Give a review, verification, or second opinion to the
   agent that did not write the work, so that a different model looks at it.
4. **How hard and how risky is it?** Take the lightest tier that will do the task as well as the
   top one (below), not a bigger model for comfort.
5. **What has this run already shown?** If an agent failed this task twice, or a similar task, give
   the next attempt to the other agent; rework that is converging stays in the same session.
   `$ORCH stats [<run>] [--since DUR]` (default: the last 30 days) adds evidence from earlier runs:
   first-attempt acceptance, failures, transient errors, and time taken, per agent and model and
   per task type. It measures outcomes, never usage limits: limit hits are no reason to avoid an agent.

When the answers do not favor Codex, choose Claude. Re-assess after each failure and whenever you
change the plan, not only at the start.

**Match the model to the task.** Cheap, fast models do simple work as well as big ones; difficult
work goes to the strongest models.

- **Nothing to judge** (run tests or gates and report, lookups, inventories, summaries, reproducing a
  bug from given steps, mechanical edits): Claude `light` or Codex `light`.
- **Small judgment calls** (a change or test from a clear spec in 1 to 5 files, lint or type fixes,
  docs and config edits, reviews of small diffs): Claude `standard` or Codex `standard`.
- **Bounded but needing more judgment** (live web research, reviews of medium diffs, debugging in a
  known area): Codex `strong`, or Claude `standard`.
- **Complex**: choose Claude `complex` or Codex `complex` if **any** of these is true:
  - The change spans several modules or more than about 5 files, or changes an interface that other
    code depends on.
  - The approach is not settled: the brief leaves design choices open, or the cause of a bug is not
    yet known.
  - Mistakes would be costly or subtle: concurrency, security or authentication, data migrations or
    schemas, billing, performance-critical paths, or integration between systems.
  - Doing it right requires understanding a large, unfamiliar subsystem.
  - It reviews a large or high-risk diff, or babysits a pull request.
  - A lighter-tier attempt at this task already failed review or its gates.
- **Difficult and long** (long-horizon or unattended multi-step work, a large refactor or migration,
  hard root-cause analysis across systems, a long audit or review, a `complex` attempt that failed):
  Claude `frontier`. Fable 5.2 beats Opus 5.5 and Codex astra on agentic coding (FrontierSWE v2:
  69.9% against 62.3% and 65.5%), keeps going until a long job is done, and at `high` matches
  Opus's best at about half the cost per task. Use `--effort medium` for long but less hard work.
  It costs about twice Opus per token, so never send it bounded or routine work.

Reviews and verification of another agent's work run at `standard` or above, on the other agent.

Judge cost per accepted task, not per token: a cheap attempt that fails review costs a rework
attempt and another review. Measure on this work, not on public benchmarks: when `$ORCH stats`
shows a tier's first-attempt acceptance is low for a task type, start that type one tier up.

When unsure between two tiers, take the lower one if a failure would be caught by the gates or
review and is cheap to redo. Take the higher one only when a mistake would be costly or subtle.

**Quality guard.** A lighter tier must not lower the quality of the result, and the workflow checks
it: every task has gates (step 3), and you review every result (step 6). A lighter-tier result that
fails review or its gates is redone one tier up, never retried at the same tier (Rework in step 6);
`start` prints the next tier when you try.

**Pass the habit on.** When the work you brief has two or more independent parts or slow side work
(test suites, gates, builds, deploys, long runs, reviews), say in that brief that the agent should
delegate them, each at the lightest tier that fits. The "Delegating further" note that `start`
appends tells it how.

Write the deciding factor in the plan's `why`, for example `"light: runs the test suite and reports
failures; nothing to judge"`, `"standard: a specified 2-file fix with tests"` or `"complex: changes the
lock protocol used by three modules"`. Per-agent behavior (sandboxes, read-only limits, flags) is in
[references/agents.md](references/agents.md).

#### Usage limits

Do not weigh either agent's usage when you decide what to delegate, choose an agent or tier, or
schedule work. Never defer a task, move it to the other agent, or do it yourself because a window
is nearly used up, and do not mention usage in `--why`.

Act only when a limit is reached, which means a task stopped with a usage-limit error (`wait` and
`result` say `USAGE LIMIT`). What `agents` shows is never enough on its own, even a window at 100%
or a limit status: the user's team plans add usage beyond those windows. Then:

1. Ping the user once per limit, with the agent and the error's reset time if it gives one: a Slack
   DM through the `post-on-slack` skill where it is available, otherwise in your reply.
2. Resume the affected work on the other agent if it is ready (a fresh session with a full brief
   and a `--why` that names the reached limit), so nothing waits for the reset. If both agents are
   limited, say so in the ping and retry once one of them works again.

### 2. Create the run and record the plan

```bash
$ORCH new --repo /abs/path/to/repo --name short-name --goal "one line"   # prints the run id and dir
$ORCH plan <run> <run-dir>/plan-draft.json [--check]   # validates; records it as <run-dir>/plan.json
```

- `new` records the repository root, current branch, `HEAD` commit, and which session launched the
  run (the orchestrator's Claude session id when available).
- Write the plan file outside the repository, for example as `<run-dir>/plan-draft.json`. `plan`
  validates it, including conflicts between tasks that can run at once: overlapping owned paths or
  a shared resource. Fix what it reports (add a dependency, split the path or resource, or merge
  the tasks), and record every later change the same way. `--check` only validates. The briefs
  need not exist yet: `plan` lists the ones still to write, and `brief` drafts them from it.

**Worktrees.** Each write task that runs alongside other writers works in its own git worktree,
`<run-dir>/worktrees/<task-id>`, on a new branch `orch/<run>/<task-id>`. `dispatch` creates them;
for a task you start by hand, run `$ORCH worktree <run> <task-id> [--from <ref>]` (`--from` to
start from integrated work), and `start` defaults to it. A single writer, or a sequential queue,
may use the main checkout when it is clean, and read-only tasks may share any checkout. `start`
refuses a second writer in the same directory unless you pass `--force`.

**Worktree preparation.** A worktree holds tracked files only. So `worktree` (unless `--no-prep`)
and `dispatch` copy the ignored files that the repository's `.worktreeinclude` lists (gitignore
patterns, such as `.env`), then apply the user's **recipe** for the repository: the first
`~/.agents/orch-recipes/*.json` (`AGENT_ORCH_RECIPES_DIR` moves the folder) whose `match` is the
repository's path, else its folder name. Name in the brief any gate that does not work in a
worktree, so the implementer reports it as not run, and run it yourself during review.

| Recipe field | Meaning |
| --- | --- |
| `copy` | More gitignore patterns of ignored files to copy |
| `symlink` | Ignored files or folders to link from the main checkout, such as `node_modules/`; the links stay out of commits |
| `setup`, `teardown` | Shell commands run in a new worktree (up to 10 minutes each), and by `cleanup` before it removes one. They get `ORCH_WORKTREE`, `ORCH_REPO`, `ORCH_RUN` and `ORCH_TASK` |
| `port` | `true` gives each worktree its own free port, as `ORCH_PORT` |
| `notes` | Printed after preparation, for example which gates work in a worktree |
| `testing` | Testing-skill pins, `[{"skill": "<name>", "when": ["<path prefix or glob>"], "note": "how to use it here"}]`. `brief` marks a pin's skill required when the task's owned paths match `when`, or always when it has none (step 3) |

### 3. Write one brief per task

```bash
$ORCH brief <run> <task-id> [--type implement|review|research|debug|babysit] [--read-only] [--out FILE] [--force]
```

`brief` writes a draft from `references/briefs/<type>.md` to the plan's `brief` path (by default
`<run-dir>/briefs/<task-id>.md`), or to `--out`, and prints the path. It refuses to overwrite a
brief without `--force`. `--type` defaults to the plan's type.

- It fills in what `plan.json` says about the task: the goal, the owned paths (and what other tasks
  own), `uses`, `produces`, `resources`, and the tasks it builds on. The role line follows the type
  and the read-only mode (the plan's `readOnly`, `--read-only`, or else reviews and research).
- Under "House rules", it lists every `AGENTS.md` and `CLAUDE.md` at the root, in the owned paths,
  and in their parent folders, each with its section headings.
- Under "Testing skills", it lists the repository's skills for testing a change with synthetic data
  or an end-to-end run (in `.claude/skills/` and `.agents/skills/`): the recipe's matching
  `testing` pins first, marked **Required**, then the most relevant to the task. The agent must run
  the one that applies and report it as a check, or say in one line why none applies or can run
  here. A review brief asks the reviewer to check that; research and babysitter briefs omit it.
- It leaves a `<fill in: ...>` marker wherever a fact is needed, and prints how many. Replace every
  marker, copy in the house rules that matter, and delete the file list before you dispatch.
- Brief the tasks that can start first, dispatch them, and write the other briefs while they run.

Also follow the agent's `~/.agents/skills/<agent>-delegate/references/writing-the-brief.md`. Every
brief must stand alone. The templates give it this shape: a **role line** ("You are a delegated
implementer ... Commit your work on this branch as you go ...; push it, or open a pull request, when
your task calls for it"; a write task may delegate, as the "Delegating further" note that `start`
appends says, while a read-only one may not); the **goal** and
testable done criteria; the **context** the agent cannot discover quickly (relevant files,
decisions already made, the agreed shape of each interface in `uses` and `produces`); the
**scope**; the **house rules**, copied in, because Claude loads only `CLAUDE.md` and Codex only
`AGENTS.md`; the **gates**, the project's real test, lint, and build commands plus the applicable
testing skill; and the **report contract**.

`start` appends two sections to every brief. "Decisions" tells the agent never to wait idle or
leave a point "pending a decision": it decides what the brief covers, reports a blocker at once (a
gate that cannot run, a missing credential or service, or a failure that survived two fixes), asks
about anything beyond the brief with `ask` while it keeps working, and ends with `NEEDS DECISION:`
only when nothing else is left (step 5). "Structured result" asks for an `orch-result` block, which `result`
parses: outcome, changed files, checks (including the testing-skill check, or why none ran),
decisions handed back, and what is unresolved. It also caps the final message at about 25 lines,
with long evidence in a file; `wait` flags a longer report. Put the decisions you already made in
the brief.

**Lessons.** `brief` adds a "Known traps in this repository" section from the user's verified
lessons for that repository (`~/.agents/orch-recipes/lessons/<key>.md`). When a failure or review
shows a trap that is likely to recur, record it once it is verified:
`$ORCH lesson <run> "<the trap and how to avoid it>" --evidence "<how you verified it>"`
(`--repo DIR` instead of a run; `--list` prints them). Keep the list short and true.

### 4. Dispatch

```bash
$ORCH dispatch <run> [--max N] [--dry-run]
```

- `dispatch` starts every planned task whose `dependsOn` tasks are all integrated (a read-only one
  once its result is collected), up to the parallel limit (`--max` lowers it), with the plan's
  agent, tier, `why`, read-only mode, and brief, each write task in a prepared worktree. It refuses
  a task whose brief is missing or still has a `<fill in: ...>` marker, starts the others, and
  exits 1. `--dry-run` lists what it would start.
- Run it once the first briefs are written, again after every `integrate`, and whenever `wait`
  names tasks that are ready. Work starts as soon as its prerequisites land; there are no waves.
- Start these by hand with `start`: ad-hoc tasks outside the plan, rework, reviews of a finished
  task, babysitters, and tasks that need relay flags, such as research with live web search.

```bash
$ORCH start <run> <task-id> --agent claude --tier light|standard|complex|frontier --why "<assessment>" \
  --brief <brief-file> [--read-only] [--timeout 2h]
$ORCH start <run> <task-id> --agent codex --tier light|standard|strong|complex --why "<assessment>" --brief <brief-file> \
  [--read-only] [--timeout 2h] [-- <agent-specific relay flags>]
```

- `--tier` is required for a new task. Exceptions: a Claude follow-up attempt keeps its earlier tier
  (a task recorded before tiers existed resumes at `complex`), and `--babysit` implies `complex`.
- `start` runs the agent's `<agent>-delegate/scripts/relay.mjs` as a detached background process
  and returns at once. It looks for the relay in the folder that holds this skill, then
  `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`; `AGENT_ORCH_SKILLS_DIR` replaces
  that search path. The task's artifacts go to `<run-dir>/tasks/<task-id>/attempt-<n>/`.
- **Tasks run outside the sandbox by default** (the user's choice), with the network and the
  user's own files, tools, and logins, and **a write task may publish by default** (the user's
  choice too): it may commit, push without force, open pull requests, and write to GitHub, as a
  `--babysit` task does (step 8). Force pushes, admin merges, secrets and creating or deleting
  repositories stay denied. Pass `--no-publish` only when the user asks to review a task's work
  before it lands; that denies commits, pushes and `gh` writes again. Claude file tools can read
  and write the home directory and the agent's `$TMPDIR` by default; read-only tasks can read them
  even with `--sandbox` or `--offline`. Read, Edit and Write deny credential stores, including
  configured Claude/Codex directories and the resolved dashboard token. An unsandboxed shell can
  still read those files. `--confine` keeps file tools in the
  working directory. `--sandbox` and `--offline` retain write-task file confinement; the latter also blocks
  the network. `--read-only` maps to
  Codex's `read-only` sandbox and Claude's `plan` mode ([references/agents.md](references/agents.md)).
- Other flags after `--` go to the relay unchanged; `relay.mjs --help` lists them. Common ones:
  Codex `--network-access`, `--web-search live`; Claude `--max-turns 60`, `--max-budget-usd 10`.
- Launch every agent for this work with `dispatch` or `start`, not with your host's own sub-agent
  tool (Codex's `spawn_agent`, Claude Code's Agent tool), which skips the model policy, `--why`,
  the parallel limit, and worktree isolation. A Codex `spawn_agent` with `fork_turns: "all"` also
  copies your whole conversation into a session on your own model.
- After the first dispatch of the run, open the live dashboard for the user (step 5).

### 5. Wait and monitor

```bash
$ORCH wait <run> [<task-id>...] [--all] [--timeout 9m|0]   # exit 0 a task finished, 3 timed out, 5 attention
$ORCH status <run>          # every task: state, elapsed, steps, tokens in/out, current activity
$ORCH log <run> <task-id>   # tail of a running or failed task's relay output
```

- `wait` exits 0 as soon as any task it watches has an unread result, and names it, so you review
  each result while the rest run (`--all` waits until every task has finished), and 3 when the
  timeout passes; it exits 6 when this agent gets a new unread message during the call, or, in your
  own session, when a task sent you a note with `tell` (printed): read it, then run the same
  command again. A result is unread until you run `result` on it, `close` the task, `accept` it, or
  `resolve` its decision; a task that finished while no `wait` ran wakes the next `wait` at once.
  `result` on a task that handed back a decision marks the decision seen, and `close` on it marks
  the decision resolved. It exits 5 as soon as a task newly needs **attention**: a decision, a
  question, a failure, a dead or silent task, or a transient error with no retries left. A question
  for you wakes every `wait` until you answer it with `send`, even one asked before the `wait`. It
  also exits 5 when a finished task has waited `AGENT_ORCH_REVIEW_REMIND` (default 10m) with no
  `accept`, `verdict` or `close`, once per interval per task, and prints the commands. Handle it,
  then wait again; other attention that was there when `wait` started is listed, but does not wake it.
  `wait` also names the tasks ready to dispatch or awaiting review.
- **Handle each finished task in the same turn you read it:** `accept` a write task once its work
  is committed, record `verdict changes` and resume it, or `close` it. Never leave one awaiting
  review. Answer questions with `send`. Agents report status with `tell`, and use `ask` only for
  decisions.
- On POSIX with a Node version that supports `process.execve`, `wait` and `nap` spend idle
  time in a small shell. It checks watched PIDs and message/result files every second, then
  returns to Node on a change, at the deadline, or after `AGENT_ORCH_PARK_MAX` (default `30s`).
  Other attention, such as a task becoming silent, is checked at that maximum interval.
- **Automatic retry.** When a task fails with a transient provider or network error, `wait` resumes
  it once in the same session (`AGENT_ORCH_MAX_RETRIES`, default 1) and prints `retried <task> …`.
  A deliberate stop, a timeout and a usage limit are never retried.
- A task is finished when its relay process has exited. Its state is the relay's `result.json`
  status: `completed`, `failed`, `timeout`, `aborted`, or `<cli>_unavailable`. `aborted` with no
  result means the relay died early; read `log`.
- Every task also has a **phase**: `prepared`, `running`, `needs-decision`, `failed` (any
  unsuccessful end, including a usage limit), `awaiting-review` (completed and not accepted yet),
  `accepted`, or `integrated`. Its **health** is `ok`; `silent` (running with no events for longer
  than its expected quiet time; a babysitter's `pr-watch` wait is expected); `dead` (its process is
  gone without a result); or `transient-error` (a provider overload or network failure).
- `status` reads each session's event stream. Tokens add up across attempts, a `~` marks partial
  counts, and no cost is shown, because Codex reports none. `quiet 6m · ...` means no events for 6m.
- `$ORCH stop <run> <task-id>` terminates a task. Do this only when the task is clearly stuck or
  off-track, or when the user asks.

#### Decisions agents hand back

**The parent acts first**: it handles what its agents send before its next step on its own work.

- **Finish notice.** When an orch task started a task, it gets one inbox message from
  `agent:<run>/<task>` when each attempt ends: ready for review, needs a decision (with the
  questions), or failed (with the error's first line), and the `result` command. `nap`, `wait` and
  `pr-watch` wake on it (exit 6). The user's session gets none; its `wait` wakes on the result.
- **Questions and notes.** A running agent asks with `$ORCH ask "<question>" [--options "a|b|c"]
  [--recommend a]` and keeps working. The question reaches the parent task's inbox, or, in a
  top-level run, the launching session as a `question` that wakes its `wait` (exit 5). It goes to
  the user only with `--user`, when the parent will not read it, or once that agent is gone. Answer
  with `$ORCH send <run> <task-id> "<answer>"`: a question clears once its own addressee answers,
  the session with `send` or the user from the dashboard's box, and never by the other's message.
  A session's question shown to the user, because that session is gone, clears on the user's reply. `$ORCH tell "<text>"` sends the parent a one-way note instead, such
  as "pushed #123": into its inbox, or printed by the session's next `wait` (exit 6). It needs no
  answer and never reaches the user.

A task whose final message starts with `NEEDS DECISION:`, or whose `orch-result` block lists
`decisions`, shows as `needs-decision` in `wait`, `status`, and the dashboard, and `result` lists
its questions. It is waiting on you, not done. For it, and for a question:

1. Decide it yourself when the user's request (or your brief), the repository's rules, or decisions
   already made settle it. That includes a reviewer's request: make it when it is within the pull
   request's scope; otherwise it is a follow-up, listed in the pull request description.
2. Answer a question with `send`; resume a task that ended with the answer as a short delta brief
   (step 6, "Rework"). If you handled it without the agent, run
   `$ORCH resolve <run> <task-id> --note "<how it was handled>"` instead: the task stops waiting on
   a decision, moves to awaiting review, and can be accepted.
3. Pass up only a decision that changes the scope, the security posture, or the cost: at once with
   `$ORCH ask` from a delegated agent, or as one question with your recommendation to the user.
   Keep every other task going, and pass the answer down as soon as it comes.

Never leave an agent waiting on your review or decision, never end your turn or report the work as
done while one does, and never let an agent's question sit unanswered on GitHub in a reply that
says "pending". Agents started with your host's own tool are marked the same way when they end
with `NEEDS DECISION:`.

**Steer a running agent** instead of stopping it, for example to pass on a constraint that
another agent just found: `$ORCH send <run> <task-id> "<message>"` (or `--file`). Add `--steer` when
it must act now: that stops the agent's current shell command (never a commit, push, rebase, merge
or other publishing command) so the message reaches it at once, and the agent reruns the command if
it still needs it. Every brief tells agents to wait with `$ORCH nap <duration>`, `wait` or
`pr-watch`, which return as soon as a message arrives. A Claude agent
gets it as context after its next tool call, through the user's `PostToolUse` hook; a Codex agent
reads it with `$ORCH inbox <run> <task-id> --ack` at each gate, as its brief tells it. `inbox
<run> <task-id> --all` shows what was sent and read; the dashboard marks unread messages. Send only
what the agent needs; a change of goal or scope still goes through a resume with a delta brief.
The user can message a running task too, from the box under its details panel on the dashboard.
The agent sees those as from the user and answers each with `$ORCH reply <run> <task-id> "<answer>"`,
which the dashboard highlights under the message and in the agent's log. `inbox --all` lists the
messages and the answers: check them when you review its result, since they can change what it did. Only a tab opened by `dashboard
--open` gets the key that sending needs; `dashboard --open --new-tab` gives it to a browser
whose tab was opened another way.

**For the user to watch the sessions you launched:**

- After the first dispatch, run `$ORCH dashboard --detach --open` and give the user the URL in one
  line, unless the user asked not to open a browser. It starts a web server on `127.0.0.1:4777`, or
  reuses the running one, opens it unless a tab already shows it, and exits by itself once no task
  is running and no tab has shown it for 30 minutes.
- The dashboard shows one section per launching session, holding all of its runs, and each child
  session: agent, model, why that agent was chosen, state, steps, tokens, session id, and current
  activity. Clicking a session shows its final report and its live event log, which opens at the
  newest events and follows new output while the reader is at the bottom. For a task, the panel
  also shows its receipts: its brief, one line per attempt (clicking one shows that attempt's log),
  each check's saved evidence, and your `verify` runs, `verdict` rounds and acceptance. The header
  shows both agents' usage limits. A main session's state comes from `claude agents --json` when Claude Code
  reports that session (`stateSource` on the row), and from its transcript otherwise; Codex's app
  server is read only with `AGENT_ORCH_CODEX_APP_SERVER=1`, because a standalone server cannot see
  threads another Codex process runs.
- Its **attention lane** lists what needs someone: questions from running agents, decisions,
  failures, results awaiting review, and silent tasks. An item for the agent that must act (the orch
  task that started the task, or the session that launched a top-level run) shows muted, "for
  <agent>", and never counts in the header's "N need attention". The user's items are usage limits,
  `ask --user`, runs started from a terminal, and items whose agent is gone: an orch task that no
  longer runs, or a session whose process ended or with no live `wait` on the run (parked ones
  count) for `AGENT_ORCH_AGENT_GRACE` (default 15m, at least twice `AGENT_ORCH_PARK_MAX`). A
  decision handed back in a top-level run goes to its session first. A babysitter never awaits
  review. A review left waiting longer than `AGENT_ORCH_REVIEW_STALE` (default 24h) leaves the
  lane; `recover` still lists it.
- A running task is **stuck** when one shell command failed its last 3 runs
  (`AGENT_ORCH_STUCK_REPEATS`) with only read-only inspection, such as `cat`, `grep` or `git diff`,
  in between. Any edit, other command or success ends it. It shows in the lane, `status` and `watch`,
  and wakes `wait`; nothing acts on the agent. Read its log, then `send` a hint, `steer` or stop it.
- A task whose own shell starts headless agents (a wrapper script that runs `claude -p` or `codex
  exec`, such as a review script) gets one row per agent, nested under the task like a delegated
  task. The row shows the agent's own kind, model, state, steps, tokens and activity, and its details
  show its events, read from its transcript. Its tokens count in the section's totals, not in the
  task's own cell. After a resume, the row says which attempt started it. A finished agent stays
  listed while its task shows. The agent's own Agent-tool sub-agents, and any run it launches, nest
  under its row. The task's details list its agents in one line, each linking to its row.
- **Escalation.** A user's item that stays unhandled for `AGENT_ORCH_ESCALATE_AFTER`
  (default 10m), or a decision or question for `AGENT_ORCH_DECISION_ESCALATE_AFTER` (default 2m,
  or the first when that is shorter; checked every tenth of the shorter, from 1 to 10 seconds),
  goes to the user once, while the dashboard runs, even with no tab open: a macOS notification
  (`AGENT_ORCH_NOTIFY=off` turns it off), a browser notification, and the command in `notify.json`
  under the state root (`~/.local/state/agent-orchestrator`, or `AGENT_ORCH_HOME`), if that file
  exists: `{"command": ["/absolute/program", "arg"]}`, which gets the item as JSON on stdin. An
  item for an orch task goes to that task instead, once, as an inbox message with what to do; one
  for a session sends nothing, since its `wait` wakes on it. Once that agent is gone, or cannot take
  the message, the item goes to the user and says so ("orchestrator session 425c2bc2 is gone (…);
  review-me has waited 25m for review"). So review
  results as `wait` returns them, and handle attention as soon as `wait` exits 5.
- It also lists, as `native`, the sub-agents that the launching session or its tasks started with
  their host's own tool, and sums Codex's automatic approval reviews into one row per parent, as
  `status` and `watch` do. Other Claude Code sessions whose sub-agents ran recently get a section
  too: a personal `SubagentStart` hook starts the dashboard and opens it unless a tab shows it.
- It also lists, as `external`, the headless Codex and Claude Opus agents (`codex exec`, `claude
  -p`) that a skill's script started from a session, outside the orchestrator, such as a review
  script's `codex exec review`. Each goes under the session that ran the script, named after the
  script (`codex-review`), and stays listed after it exits. One started from a task's shell is not
  a row: the task's row stands for it, and its details show the agent (above). Such an agent takes no
  messages and skips the model policy, so start agents through `$ORCH start` when they can take a
  brief; a script that must run its own `codex exec` or `claude -p` needs no runner task to be seen.
- A run or session leaves the dashboard once nothing in it has run for `AGENT_ORCH_BOARD_IDLE`
  (default 2h); `status` and `result` still read it. Rows quiet for `AGENT_ORCH_ROW_IDLE`
  (default 1h) fold behind "show N older".
- `$ORCH watch` shows the same tree in a terminal, for a user who asks for it. Do not run `watch`
  yourself in place of the dashboard: the user cannot see your shell's output.

### 6. Review every result

```bash
$ORCH result <run> <task-id>   # report, orch-result, scope violations, health, tokens, files, session
git -C <task-cwd> status --porcelain && git -C <task-cwd> diff
```

Review each result as soon as `wait` returns it, while the other tasks run. `result` shows the
agent's final message, its structured report (the `orch-result` block), its **scope violations**
(changed files outside the plan's `owns`), and its health. Treat all of it as claims to check.
Follow the agent's `~/.agents/skills/<agent>-delegate/references/review-and-land.md`, and at minimum:

- Read the whole diff against the brief, including untracked files. Reject scope creep: undo a
  scope violation, or keep it only for a reason you can state.
- Check any edits to existing tests before trusting a green gate.
- `result` marks each reported check `ran, exit N` or `NOT FOUND in the log`, from the agent's log,
  and warns when a `pass` failed or never ran. Still rerun the key gates with `$ORCH verify <run>
  <task-id> -- <command>`, which records the exit code, commit and output tail. Check that the agent
  ran the testing skill that applies (its brief's "Testing skills"), or said why none could run.
- Record each round with `$ORCH verdict <run> <task-id> clean|changes|reject --note "<why>"`:
  `changes` makes the next attempt a rework, and `reject` closes the task.
- For a read-only task, check `readOnlyViolation` in `result --json` (Claude reports it; Codex's
  sandbox enforces read-only). The touched files are the whole `git status`, earlier changes too.
- **A risky write task gets a read-only review by the other agent by default** (`brief --type
  review`): one that changes an interface, spans many files, or touches a risk from the `complex`
  tier list. Ask for concrete defects only, and verify each one. For a consequential change, let
  one reviewer see the requirements and the diff without the implementer's explanation first.

**Accept.** Implementers commit on their task's branch by default (`start --no-publish` keeps them
from it, when the user wants to review first). Review their commits (`git -C <worktree> log` and
the diff from the base); if an agent left changes uncommitted, commit them on the task's branch
yourself, following the repository's commit-message rules. Then record it, with your reason:

```bash
git -C <worktree> add <files> && git -C <worktree> commit -m "<message>"
$ORCH accept <run> <task-id> --note "<why>" [--commit <sha>]   # default: HEAD of its working directory
```

**Rework** stays in the same agent session: write a short delta brief that names what to fix, then
run `$ORCH start <run> <task-id> --agent <same> [--tier <same>] --brief <delta> -- --session <id>`,
using the session id that `result` printed. The task keeps its working directory, and the attempt
number goes up.

**Escalating a task** one tier up (Claude `light` to `standard` to `complex`, Codex `standard` to
`complex`): resume with `--tier <next>`, a new `--why` that names what failed, and the same
`--session`, so the stronger model keeps the context; when the earlier attempt went far off track,
start fresh (no `--session`) with a corrected full brief. Never retry a failed lighter-tier result
at the same tier. After two failed attempts, give the task to the other agent (a fresh session with
a full brief and a new `--why`), do the fix yourself, or re-plan; do not loop.

### 7. Integrate and verify the goal

```bash
$ORCH integrate <run> <task-id> [--into <branch>] [--dry-run]
```

- `integrate` merges an accepted task's branch into the run's base branch (or `--into` another)
  with `--no-ff`, after checking for conflicts; `--dry-run` only checks. That branch must be
  checked out and clean in the run's repository; `integrate` never switches, stashes, or resets it.
  It refuses while a merge, rebase, cherry-pick or revert is in progress there, and when the merge
  would overwrite an ignored or untracked file, such as a `.env`.
- Integrate in dependency order, and **run `dispatch` again after each one**.
- **On a conflict,** merge the base branch into the task's branch inside its worktree
  (`git -C <worktree> merge <base>`), or resume the task's agent with a delta brief to do it.
  Re-run the gates there, commit, then `accept` and `integrate` again. If a conflict shows that the
  plan was wrong, stop and tell the user.
- When every task is integrated, run the full gates once on the integrated tree.

**Verify the goal before you publish or report.** Finishing every task does not prove that the
request is met: each task can pass while the whole quietly does less than was asked. Fill a short
table with one row for every item of the plan's `acceptance` list:

| Required behavior | Implementation | How it connects to its callers | Evidence |
| --- | --- | --- | --- |
| Trailing commas are rejected with a clear error | `parse_list` in `src/parser/list.py` | `parse_value` calls it, and the CLI's `check` command calls that | `pytest tests/test_parser.py` passes; `check bad.json` prints the error |

A row without evidence, or code that nothing calls, is not done: dispatch a task for it or do it.
Then push, or open a pull request, only as the repository's rules and the user's request allow.
Babysit every pull request you open or push to (step 8).

### 8. Babysit every pull request you open

A pull request you open, or push the run's work to, is part of the job until it leaves `OPEN`.
Skip babysitting only when the user says not to, or when the repository's rules hand pull requests
to someone else. Never report the work as done while its pull request is open and nobody watches it.

**Start babysitting only when the pull request is ready for review**: not a draft, every change
you planned for it pushed, and your gates passing on the pushed head. Until then, do not start a
babysitter or ask the user about one; once it is ready, start it without asking. `start --babysit`
refuses a pull request that is a draft or no longer open.

**A Claude babysitter task does the babysitting.** It runs on Claude Opus, which costs much less of
the user's limits than Codex. Do not babysit with Codex, whether that is you, a Codex task, or a
`spawn_agent` sub-agent. Do not babysit with your host's built-in sub-agents either.

1. Draft its brief with `$ORCH brief <run> babysit-<pr> --type babysit`, which copies
   [references/babysit-brief.md](references/babysit-brief.md). Fill in the pull request's URL,
   branch, base, and checkout; the repository's babysitting skill, if it has one (for example
   `babysit-pr` under `.claude/skills/` or `.agents/skills/`), which the babysitter reads and
   follows; and the repository's rules for commit messages, reviewer replies, review threads, CI
   logs, and gates.
2. Dispatch it:
   `$ORCH start <run> babysit-<pr> --agent claude --babysit --pr <n> --why "babysits PR #<n>; Claude costs less than Codex" --brief <brief> --cd <checkout>`.
   A babysitter may commit, push without force, and reply on GitHub; outside the sandbox, Graphite,
   commit hooks, and SSH work as they do for the user. Force pushes, admin merges, closing the pull
   request, and repository settings stay denied. Its timeout defaults to `24h`, and it waits with
   `orch.mjs pr-watch`, which spends no tokens while waiting and exits 0 when a PR needs attention,
   3 when nothing is new, 4 for unpushed commits, or 6 for a new unread message to this agent.
   Its checkout must have the branch checked out: prefer the run's worktree for it, where no other
   task may then write.
   - **Parking.** When a watch finds nothing new, the babysitter parks: it ends its turn with a
     final message whose first line is `PARKED: PR #<n> waits for <what>`, and its agent exits. A
     watcher of about 3 MB (a shell loop) then checks the pull request every minute and the task's
     inbox every few seconds, and resumes the same session, at the same tier, on the first event.
     `status` and the dashboard show the task as parked, with what it waits for; `wait` treats it
     as running; it takes no parallel slot but keeps its checkout. A message you `send` wakes it.
     `stop` and `close` end the watcher. `status`, `start` and the dashboard restart a watcher that
     died, for example after a reboot.
3. Do not stay active only to watch it.
   - In Claude Code, run `$ORCH wait <run> babysit-<pr> --timeout 0` in the background.
   - In Codex, do not loop on `wait`, because every wake-up spends Codex usage. Tell the user that
     the babysitter is running and that the dashboard shows it, then end your turn or continue
     other work.
4. When it finishes, read its report with `$ORCH result`, verify the claimed final state with
   `$ORCH pr-watch <pr> --once`, and pass on to the user anything it left for them. If it stopped
   on a decision, handle it as in "Decisions agents hand back" and resume it at once. If it stopped
   on a repeated failure, fix it or ask the user. If it stopped on a publishing blocker, fix the
   cause when it is in the setup and resume it. If only you can publish, review its commit, re-run
   the gates, publish it with the repository's normal command (for Graphite,
   `gt submit --update-only --no-edit --no-interactive`), and resume it to keep watching.

Keep the pull request's worktree and branch until it lands; clean up only after that.

### 9. Close what you no longer need, clean up, and report

Close every session as soon as nothing depends on it, so that nothing holds a slot it no longer needs:

- **Tasks:** `$ORCH result` closes a finished task once you collect its report, and resuming it
  opens it again. Run `$ORCH close <run> <task>...` (or `--all`) for a task you no longer need,
  such as one superseded by a new plan or a failure you will not retry; it stops a running task.
- **Your host's own sub-agents:** in Codex, interrupt one you no longer need with `interrupt_agent`,
  and give a finished one no further `followup_task`. In Claude Code, stop background agents and
  commands you no longer need, such as a replaced `wait` or `pr-watch`, with the task-stop tool.
- **Before you end a turn**, check `$ORCH status <run>`. Every session that is still running, in
  either table, must have a reason to keep running; close the rest.
- Run `$ORCH dashboard --stop` when the user is done with the dashboard, before it exits by itself.

```bash
$ORCH cleanup <run> [--delete-branches]     # removes worktrees with no uncommitted work
```

`cleanup` runs each worktree's recipe `teardown`, ignores tool caches (`__pycache__`,
`node_modules`, ...) and prep links, keeps any worktree with other uncommitted changes and lists
them, and only discards them with `--force`. `--delete-branches` deletes only merged branches.

Report to the user, briefly: what landed (commits or branches), the goal table from step 7, which
agent and model did each task and why, total tokens from `status`, anything still open, and any
implementer decision the user should confirm.

## Patterns

- **Parallel build:** one write task per independent area, each in its own worktree, then a
  cross-agent read-only review of the combined diff before the final merge.
- **Second opinion:** the same read-only brief to both agents in the main checkout. Compare their
  findings, verify each claimed defect yourself, and report only those that survive.
- **Implement, then review, then fix:** agent A implements; agent B reviews read-only; agent A
  resumes its session with B's verified findings as the delta brief.
- **Competing hypotheses (debugging):** when a bug has several plausible causes, start one
  investigator per candidate cause (`brief --type debug`), each with an experiment that tells its
  cause apart from the others, and each reporting `confirmed`, `falsified`, or `inconclusive` with
  its evidence. Then fix the confirmed cause in one write task.
- **Research fan-out:** split broad research into independent areas, one task per area, all at
  once. Research agents run on Codex with live web search (`brief --type research`, then
  `start <run> <id> --agent codex --tier strong --read-only --why "..." --brief <file> -- --web-search live`).
  Merge their answers yourself, and check the claims that matter against their sources.
- **Long sequential queue:** one task at a time, each one landed before the next is dispatched. See
  `~/.agents/skills/codex-delegate/references/multi-task-queues.md`.

## Guardrails

- Never put secrets, tokens, or credentials in a brief. Implementers inherit the user's environment
  and logins; do not ask them to print or move credentials.
- Tasks run outside the sandbox by default because the user chose that. Go no further without the
  user's explicit approval for that run: no `--dangerously-skip-permissions`, and no removing the
  deny rules on commits, pushes, and `gh` writes. Pass `--sandbox` for untrusted input, such as an
  outside contributor's branch.
- Stop and ask when correct completion requires going beyond the user's request, when a review calls
  the plan itself into question, or when the gates fail in already-integrated work.
- Implementers can be wrong in confident prose. Nothing is done until you have read the diff,
  re-run the gates, and checked every item of the acceptance list.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `start` says that no relay was found | Install the delegate skill: `npx skills add amElnagdy/delegate-skills -g -s claude-delegate` (or `codex-delegate`); check that `AGENT_ORCH_SKILLS_DIR` is not set to another folder |
| `<cli>_unavailable` | The CLI is not on `PATH`: install it, or fix `PATH` for non-interactive shells |
| `failed`, with auth errors in the log | Ask the user to log in: `claude auth login` or `codex login` |
| `USAGE LIMIT` in `wait` or `result` | The agent's usage window is used up: ping the user and resume on the other agent ("Usage limits") |
| You lost track of what runs (restart, compaction) | `$ORCH recover`, then act on what it lists ("Recover first") |
| Claude reports that it is logged out when the orchestrator is Codex | Codex's sandbox blocks the macOS Keychain; re-run the `$ORCH` command with escalated permissions |
| A read-only Codex task cannot run network-dependent commands | Its read-only sandbox has no network; run it as a write task with a brief that forbids edits |
| A `--sandbox` Claude task reports `deny network-outbound <host> (user denied)` | The task ran with `--offline`, or the relay patch is missing (`start` printed a note, and `agents` warns). Re-apply the patch with the command that the note prints, then resume the task |
| A `--sandbox` Claude task's `git fetch`, `git push`, or `gt submit` fails with `policy_refusal` or `ssh_dispatch_run_fatal` | The sandbox refuses SSH. Sandboxed tasks started by this version of `orch.mjs` reach GitHub over HTTPS automatically; resume an older task so that it starts with the rewrite, or run it without `--sandbox` |
| `pr-watch` cannot read the pull request | Run it outside any sandbox; check `gh auth status`; pass `--repo` with a checkout of the pull request's repository, or the pull request URL |
| `start --babysit` says that the relay has no `--allow-publish` option | An update of `claude-delegate` replaced the local relay patch; re-apply it with the `patch` command that the error prints |
| `timeout`, `dead`, `silent`, `quiet` for a long time, or a transient error after `retried <task>` | Check `log`, then resume the session (`wait` prints the command) with a narrower delta brief, split the task, or start it fresh |
| A gate needs Docker or other host services that a `--sandbox` task cannot reach | Tell the implementer to skip that gate, and run it yourself during review |
| Worktree gates fail on missing dependencies or ignored files | List the files in the repository's `.worktreeinclude`, or add them or the setup to the user's recipe (step 2), so the next worktree gets them. For this one, install them in the worktree, or name the gate in the brief as one it cannot run |
