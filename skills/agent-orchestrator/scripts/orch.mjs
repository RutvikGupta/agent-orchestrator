#!/usr/bin/env node
// Background dispatch and bookkeeping for delegate-skill relays.
//
// Each task runs one installed `<agent>-delegate/scripts/relay.mjs` as a detached process, so it
// survives the orchestrator's shell call, and records its state under a per-run directory.
// Claude Code and Codex orchestrators get the same start / status / wait / result loop, plus a
// live `watch` view of every launched session's progress and token usage. Node 18+, no
// dependencies.
//
// This file is the CLI entry point: its help text, each command's options, and the dispatch. The
// commands live in lib/commands/, the shared modules in lib/, and the dashboard page in dashboard/.

import { STATE_ROOT } from "./lib/config.mjs";
import { gateCommand } from "./lib/ownership.mjs";
import { checkSkill } from "./lib/skill-version.mjs";
import { die, parseArgs } from "./lib/util.mjs";
import { cmdGc } from "./lib/commands/gc.mjs";
import { cmdHeavy } from "./lib/commands/heavy.mjs";
import { cmdReclaim } from "./lib/commands/reclaim.mjs";
import { cmdAgents } from "./lib/commands/agents.mjs";
import { cmdAsk } from "./lib/commands/ask.mjs";
import { cmdBrief } from "./lib/commands/brief.mjs";
import { cmdInbox, cmdNap, cmdReply, cmdSend, cmdSteer } from "./lib/commands/inbox.mjs";
import { cmdLesson } from "./lib/commands/lessons.mjs";
import { cmdDashboard } from "./lib/commands/dashboard.mjs";
import { cmdAccept, cmdDispatch, cmdIntegrate, cmdPlan, cmdRecover, cmdResolve } from "./lib/commands/lifecycle.mjs";
import { cmdStatus, cmdWait, cmdWatch } from "./lib/commands/monitor.mjs";
import { cmdPrWatch } from "./lib/commands/pr-watch.mjs";
import { cmdQuestions } from "./lib/commands/questions.mjs";
import { cmdCleanup, cmdNew, cmdRuns, cmdWorktree } from "./lib/commands/run.mjs";
import { cmdSkill } from "./lib/commands/skill.mjs";
import { cmdStats } from "./lib/commands/stats.mjs";
import { cmdModel } from "./lib/commands/model.mjs";
import { cmdRename, resolveTaskNames } from "./lib/commands/rename.mjs";
import { cmdStart } from "./lib/commands/start.mjs";
import { cmdTell } from "./lib/commands/tell.mjs";
import { cmdClose, cmdLog, cmdResult, cmdStop } from "./lib/commands/task.mjs";
import { cmdVerdict, cmdVerify } from "./lib/commands/verify.mjs";
import { cmdReview, cmdRework, syncReviewVerdicts } from "./lib/commands/review.mjs";

// The commands before which a finished reviewer's verdict line is recorded as a review round of the
// task it reviewed (review.mjs): those that show review rounds or act on them.
const VERDICT_SYNC = new Set(["status", "wait", "result", "accept", "verdict", "start", "recover"]);

const USAGE = `agent-orchestrator · orch.mjs

Usage: node orch.mjs <command> [args] [--json]

  model --agent claude|codex [--tier TIER]
                                  Print --model and --effort arguments, lowered to the inherited
                                  ceiling. Without --tier use the ceiling, otherwise standard.
                                  Codex effort uses -c model_reasoning_effort="LEVEL".
  agents [--refresh]              Installed agent CLIs, their relays, login state, model policy
                                  with each tier's results over the last 30 days (finished tasks,
                                  share accepted first try, median first attempt, input tokens per
                                  accepted task: all the tier's input over the accepted ones;
                                  "too few tasks" under 5), and how much of each
                                  agent's usage limits is used. --refresh
                                  runs one tiny Claude turn to read Claude's current limits
  new [--repo DIR] [--name S] [--goal TEXT]
                                  Create a run (records the repo, base commit, and the
                                  Claude or Codex session that launched it); prints the run id
  worktree RUN TASK [--from REF] [--branch NAME] [--path DIR] [--no-prep]
                                  Create and prepare an isolated git worktree + branch for TASK.
                                  Recreates a collected folder from its retained branch; --from
                                  requires a new --branch when restoring a retained branch.
                                  A restored folder stays until a fresh explicit close, or fresh
                                  acceptance and integration.
  brief RUN TASK [--type implement|review|research|debug|babysit] [--read-only]
        [--out FILE] [--force]
                                  Write a draft brief for TASK from references/briefs/<type>.md,
                                  filled in from the run's plan.json, with the repository's
                                  AGENTS.md and CLAUDE.md files listed under "House rules" and
                                  "<fill in: ...>" markers where facts are needed. --type
                                  defaults to the plan's; reviews and research are read-only
                                  unless the plan says otherwise. Writes the plan's brief path
                                  (default <run-dir>/briefs/TASK.md) or --out, and refuses to
                                  overwrite it without --force
  start RUN TASK --agent claude|codex --why TEXT --brief FILE --tier TIER [--effort medium|high] [--cd DIR]
        [--read-only] [--sandbox] [--confine] [--offline] [--no-publish] [--timeout DUR] [--title TEXT]
        [--max-parallel N] [--force] [--unplanned] [--babysit --pr N] [-- RELAY_ARGS...]
                                  Launch the agent's relay in the background; returns at once.
                                  Tasks run outside the agents' sandboxes by default, with full
                                  network and user access, and a write task may commit, push
                                  without force, and write to GitHub. --no-publish (when the user
                                  wants to review first) denies commits, pushes and gh writes.
                                  --sandbox confines a task; --offline confines it and blocks the
                                  network. --babysit --pr N (Claude only) makes the task the
                                  babysitter of pull request N, which must be open and ready for
                                  review (not a draft): it may commit, push without force, and
                                  reply on GitHub; its timeout defaults to 24h.
                                  --why records the assessment behind the choice of agent and tier;
                                  it is required unless this attempt keeps the previous attempt's
                                  agent and tier, or start escalates it automatically.
                                  --tier picks the model from policy.json and is
                                  required for a new task: Claude light|standard|complex|frontier, Codex
                                  light|standard|strong|complex. Only frontier takes --effort (medium or high).
                                  Follow-ups keep their tier until two counted failures: start moves
                                  one tier up in the same session, then refuses after two more failures
                                  or at the top tier. --tier, a changed --agent, or --no-escalate overrides.
                                  Counted failures are failed, timeout or aborted attempts and review
                                  changes/reject; owner stops and usage-limit stops do not count.
                                  Legacy Claude tasks resume at complex, and --babysit
                                  implies complex, so it needs none. "agents" lists each tier's model and results.
                                  Run by a delegated agent, its own task gets an inbox message
                                  when this attempt ends: ready for review, needs decision, or failed
                                  In a run with a plan, the first start refuses a task whose prerequisites are
                                  not integrated yet, or that shares an owned path or resource with
                                  a running task: --force bypasses those checks. A task the plan
                                  does not name needs --unplanned, which --force does not imply.
                                  Later attempts skip plan checks; babysitters reserve no owned paths,
                                  parked tasks and command tasks hold no plan reservation.
  start RUN TASK --agent command --why TEXT [--max-tier TIER] [--done MARKER] [--timeout DUR] [--cd DIR] [--title TEXT]
        [--max-parallel N] [--force] [--unplanned] -- COMMAND [ARG...]
                                  --max-tier uses a Claude policy tier; defaults to the delegated
                                  caller's tier, otherwise none. Inherited ceilings may lower it.
                                  Exports AGENT_ORCH_MAX_* and CLI defaults for child agents.
                                  Explicit CLI choices can override defaults; the board warns
                                  when a known model exceeds the ceiling.
                                  Run a command as a task, with no model: for a script that starts
                                  its own agents, or any long command whose output you only check.
                                  The words after "--" run as an argument vector, with no shell (put
                                  variables in with: -- env VAR=value COMMAND ...), detached, in --cd,
                                  with a relay's AGENT_ORCH_* variables, so agents it starts belong
                                  to the task. It succeeds on exit 0 and, with --done, only if its
                                  output printed MARKER. Its log is the output, its activity the
                                  latest line, and its result the last 40 lines. It has no session:
                                  "start" again runs the command again (the same one, unless a new
                                  one follows "--"). stop, close, wait and the finish notice work as
                                  for an agent; accept takes it as a read-only task
  status RUN                     Every task: state, steps, current activity, tokens; also
                                  the sub-agents that the launching session started with its
                                  host's own tool (Claude Code's Agent tool, Codex's spawn_agent).
                                  With a plan, also each planned task, started or not: waiting
                                  (and on which tasks), ready, running, awaiting-review, accepted
                                  or integrated; recorded tasks outside the plan; and a warning
                                  for each task whose branch was already merged by hand
                                  (record it with integrate --already-merged). --json adds
                                  plannedTasks, unplannedTasks and manualMerges
  watch [RUN|--all] [--interval S] [--once]
                                  Live tree of runs → launched sessions, refreshed every S seconds
  dashboard [--detach] [--open [--new-tab]] [--port N] [--idle-exit DUR] [--stop]
                                  Same tree as a local web page (127.0.0.1), with each session's
                                  reason for its agent, final report, live event log, and both
                                  agents' usage limits. Reuses a dashboard that is already running.
                                  --open opens the default browser unless a tab already shows it,
                                  handing it the key that lets it message running tasks; --new-tab
                                  opens one anyway, to give a browser that lacks it the key.
                                  --detach runs it in the background until no task is running and
                                  no tab has shown it for --idle-exit (default 30m); --stop ends it.
                                  Without --detach it runs until Ctrl-C
  wait RUN [TASK...] [--all] [--timeout DUR] [--notes]
                                  Block until any running task finishes (exit 0), the timeout
                                  passes (exit 3), or a task newly needs attention (exit 5):
                                  decision, question, failure, dead or silent; also exit 5 when a
                                  finished task has waited AGENT_ORCH_REVIEW_REMIND (default 10m)
                                  without accept, verdict or close, once per interval per task.
                                  Exit 6 = a new unread message for this agent; read it, then run
                                  the same command again. In the session that launched the run, a
                                  note a task sent with tell needs no answer and does not end wait:
                                  wait prints every held note with its next exit, whatever ends it.
                                  --notes ends wait at the first new note instead (exit 6).
                                  Existing attention is listed
                                  but does not wake wait. --all waits until every task finishes
                                  (--any is the default and accepted). DUR like 90s, 10m, 2h; 0
                                  waits forever. Default 9m.
  plan RUN FILE [--check]         Validate the run's task plan (JSON: ids, goals, agents and tiers,
                                  briefs, dependencies without cycles, and no owned path or resource
                                  shared by tasks that can run at once) and record it as plan.json.
                                  --check only validates. A new plan replaces the old one; started
                                  tasks keep their records, and a running task cannot be dropped
  dispatch RUN [--max N] [--dry-run] [--follow [--timeout DUR]]
                                  Start, in plan order and up to the free slots (and N), every
                                  planned task whose prerequisites are integrated: a write task in a
                                  new worktree (from the base commit, or, once it has prerequisites,
                                  from the head of the branch they were integrated into, which
                                  integrate records; it must contain every prerequisite's merge),
                                  a read-only one in the run's repo.
                                  Lists the tasks still blocked. --dry-run starts nothing.
                                  --follow stays after that first wave: it waits for the running
                                  tasks and starts each next wave as its prerequisites land, until
                                  the whole plan is complete or a new task problem needs you (ready for review,
                                  to accept or integrate, a decision handed back, or a failure).
                                  --timeout DUR (with --follow) stops the stay after DUR with exit 3,
                                  as wait does; run it again to keep following. 0 or none stays.
                                  Existing problems are listed without interrupting running work;
                                  transient failures retry and parked watchers revive as in wait.
                                  With --follow, --max N caps planned tasks running at once.
                                  A ready babysitter is listed but does not interrupt running tasks.
  verify RUN TASK [--timeout DUR] -- COMMAND...
                                  Rerun a gate in a finished task's working directory (default
                                  timeout 30m) and record it in the task's verifications.jsonl,
                                  with the commit and output tail. Exit 0 = passed, 1 = failed,
                                  2 = refused (the task is still running)
  verdict RUN TASK clean|changes|reject [--note TEXT] [--reviewer TASK|coordinator]
                                  Record a review round of the task's current attempt in
                                  reviews.jsonl, with the verifications since the last round.
                                  changes: the next attempt is a rework; reject: close the task
                                  as rejected
  review RUN TASK [--tier TIER] [--focus TEXT]
                                  Start the other model (Codex on Claude's work, Claude on
                                  Codex's) as a read-only reviewer of a finished task, named
                                  review-TASK (review-TASK-2 and on for later rounds), with a brief
                                  built from the task's brief, its diff since its work started
                                  (uncommitted changes and new files included) and its final report.
                                  A Codex reviewer also gets the git diff command to run. The diff
                                  sets the tier: up to 150 changed lines in up to 3 files, none of
                                  them a module that other files import (new or not), is standard;
                                  more is complex. --tier overrides it; --why records the judgment.
                                  A diff too large for the brief (about 200 KB) is cut at file
                                  boundaries, and the brief names each file left out or cut short,
                                  with its size and how to read it.
                                  --focus tells the reviewer what to look at hardest. The reviewer
                                  ends with VERDICT: clean or changes, recorded as a review round of
                                  TASK (as by verdict) when status, wait, result, accept, verdict or
                                  start next runs on the run
  rework RUN TASK [--from REVIEW_TASK] [--note TEXT] [--tier TIER [--why TEXT]]
                                  Resume TASK's own session with the findings of its latest review
                                  (or REVIEW_TASK's, which may be a reviewer started by hand): its
                                  prose and the findings of its orch-result block, with TASK's scope
                                  and gates restated, as a rework attempt; records the review round
                                  first. --note adds your decisions on which findings to fix. --tier
                                  passes to start; --why defaults to a line naming the review and
                                  both tiers. Refuses when the review found nothing: accept TASK instead
  accept RUN TASK [--commit SHA] [--note TEXT] [--unverified REASON]
                                  After reviewing a completed task and committing its work, record
                                  it as accepted (its checkout must be clean); SHA defaults to HEAD.
                                  When evidence is available, write tasks with passing checks require
                                  no matched failed runs; other issues warn. --unverified
                                  records why the result is accepted anyway.
                                  --note records why; notes when no clean verdict is recorded
  resolve RUN TASK --note TEXT    Mark a handed-back decision as handled, when you answered it
                                  without resuming the agent
  integrate RUN TASK [--into BRANCH] [--dry-run] [--already-merged]
                                  Merge an accepted task's branch into the run's base branch (or
                                  BRANCH), which must be checked out and clean in the run's repo.
                                  Checks for conflicts first and changes nothing if there are any.
                                  --dry-run only runs the check. --already-merged records an
                                  accepted task whose branch was merged earlier (by hand, say) as
                                  integrated, without merging again; status warns about such tasks
  recover [RUN] [--all]           Read-only summary of the runs this session launched (--all: every
                                  run active in the last 24h): tasks by phase, blocked tasks, dirty
                                  worktrees, dead processes, and the next command for each
  result RUN TASK                 Final report, touched files, session id, artifact paths; each
                                  reported check with its evidence from the agent's log, the
                                  review rounds and the verifications
  send RUN TASK (MESSAGE | --file FILE) [--steer]
                                  Send a message to a running agent, which it reads at its next step
                                  (an idle agent, waiting on its own background command, only once
                                  that ends); --steer delivers it now: it stops the agent's shell
                                  command (never a commit, push, rebase, merge or other publishing
                                  command), or, when the agent is not in one, stops its session and
                                  resumes the same session with the message (a new attempt; refused
                                  for a babysitter, a parked or command task, an unknown session, or
                                  a sandboxed Codex task with the network on)
  steer RUN TASK                  Deliver a task's queued messages now, as send --steer does
  heavy [--label TEXT] -- COMMAND [ARG...]
                                  Queue a heavy command until memory is available; exit 6 on a message
  reclaim [--dry-run] [--json]     Stop orphan build daemons and report their resident memory
  nap DUR                         Sleep like \`sleep\`, but return at once (exit 6) when a message
                                  arrives for the agent running it; agents wait with this
  inbox RUN TASK [--ack] [--all]  A task's unread messages (--all: every one), with when the agent
                                  reads them; --ack marks them read
  questions RUN [TASK] [--all]    Every open question that the run's agents (or TASK) asked with ask,
                                  in full: its id, the task and attempt that asked, when, to whom,
                                  the whole text, every option and the recommendation, and how to
                                  answer it. --all also lists the answered ones, each with when and
                                  by which message, and those whose attempt ended unanswered. With
                                  no open question it says so; exit 0 either way
  reply RUN TASK (TEXT | --file FILE) [--to ID]
                                  The agent answers the user's message (default: the latest it read);
                                  the dashboard shows the answer under it and in the agent's log
  ask QUESTION [--options "a|b|c"] [--recommend a] [--user]
                                  A delegated agent asks whoever started it, and keeps working: into
                                  the parent task's inbox, or, in a top-level run, as a "question"
                                  for the launching session that wakes its wait on the run (exit 5).
                                  The user gets it with --user, when the parent cannot take it, or
                                  once that session is gone. The answer arrives in the asker's inbox
                                  (the parent runs send); wait for it with nap
  tell (TEXT | --file FILE)       A delegated agent sends whoever started it a one-way note, such as
                                  a status update: into the parent task's inbox, or, in a top-level
                                  run, to the launching session's wait on the run, which prints it
                                  with its next exit (and ends at it with exit 6 only with --notes).
                                  Never shown to the user; use ask for a decision
  lesson (RUN | --repo DIR) [TEXT] [--evidence TEXT] [--list]
                                  Record a verified lesson for the repository, which every later
                                  brief includes; --list prints them
  log RUN TASK [--lines N]        Tail of the relay's combined output
  stop RUN TASK                   Terminate a running task (its relay records "aborted")
  close RUN TASK... | close RUN --all
                                  Stop any of these tasks that still run, and mark them closed.
                                  Views keep closed sessions, dimmed and below the open ones; "result"
                                  closes a finished task, and resuming a task opens it again
  rename RUN TASK --to NAME       Give a task a name that status, wait, result, recover, stop, the
                                  Stop hook, finish notices and the dashboard show in place of its
                                  id; result and the
                                  dashboard's details also show the id and earlier names. Every
                                  command that takes a task takes the name too, in that run; an id
                                  always wins over a name. NAME must be a valid task id, and not the
                                  id or name of another task of the run or a task of its plan.
                                  The id stays the key of the task's folder, inbox, worktree,
                                  branch, nested runs and AGENT_ORCH_TASK. Works on a running,
                                  parked, finished or closed task and restarts nothing. Each name is
                                  recorded with when and who set it; --to the task's own id removes
                                  the name. The run's owner may rename any of its tasks, and a task's
                                  own agent itself, which the owner is told of as of a change by the
                                  user. One rename at a time checks and saves a name in a run (a
                                  lock in its folder). For example, an implementer kept as its pull
                                  request's babysitter (start RUN TASK --babysit --pr N -- --session
                                  ID) is renamed babysit-N
  cleanup RUN                    Remove only explicitly closed (or accepted and integrated),
                                  clean worktrees; only untracked gate caches are ignored.
                                  Commits stay on kept branches; running or parked users protect
                                  their worktrees across all runs. Never deletes branches.
  gc [--dry-run] [--older-than DUR] [--json]
                                  Collect owned runs with no running task and no activity for
                                  24h (override with --older-than, e.g. 7d). Any closed task qualifies
                                  for gc, including collected results and older closures.
                                  Dry runs change nothing.
                                  Unread, unaccepted finished tasks expire after AGENT_ORCH_EXPIRE
                                  (default 7d); dead relays expire from their latest attempt activity.
                                  Reports removed/kept worktrees, teardown failures and disk freed.
                                  close cleans after the last open task; integrate cleans its task.
  runs                            List runs, newest first
  stats [RUN] [--since DUR]        Task outcomes by agent/model and type (default: last 30d),
                                  with input tokens per accepted task (all the group's input over
                                  its accepted tasks)
  skill [--loaded]                Whether the skill's instructions (SKILL.md, references/, policy.json)
                                  changed since this session or task first ran an orch.mjs command:
                                  the fingerprint recorded for the caller, the current one, and the
                                  files and commits that differ. --loaded records the current one,
                                  after you have read the skill again, and prints it. Every other
                                  command prints a notice on stderr until then (see Skill changes)
  pr-watch PR... [--repo DIR] [--timeout DUR] [--interval DUR] [--once]
                                  Watch pull requests (number, URL, or branch) with gh until one
                                  needs you: a check failed, all checks finished, a new review or
                                  comment, a changed review decision, a conflict, a moved base,
                                  removal from the merge queue, or it left OPEN. Run by a
                                  babysitter it polls once and returns: its parked watcher waits,
                                  with no model, and absorbs checks that pass with nothing else open.
                                  A parked babysitter whose last call sent more than
                                  AGENT_ORCH_BABYSIT_HANDOFF_TOKENS (default 150000) resumes in a
                                  fresh session from its handoff note, when that note is current.
                                  Exit 0 = needs you, 3 = timed out (default 9m; 0 waits forever),
                                  4 = the checkout has commits the pull request lacks: push first.
                                  Exit 6 = a new unread message for this agent; read it, then watch again.
                                  Polls every --interval (default 60s); uses no model tokens.
                                  --once prints the current state and marks nothing as seen

RUN may be a run id, a run directory, or "latest". State lives in ${STATE_ROOT}.
Text after "--" is passed to the relay unchanged (for example: -- --session <id>); for
--agent command, it is the command.

Ownership: every command that changes a run acts only on runs the calling session launched, or
their nested runs; reading (status, wait, result, log, recover, inbox, questions, send without
--steer, and dry runs) is open to anyone. Another session's run is refused (exit 4, nothing
changed): ask its owner. A run launched from a terminal is the user's. The user at a terminal and
the dashboard may act on any run, and the owner is told. When every owner of a run has gone and it
has been unused for AGENT_ORCH_ADOPT_AFTER (default 30m), --adopt takes it over.

Skill changes: the first orch.mjs command of a Claude Code or Codex session, or of a delegated task
(--help included), records a fingerprint of SKILL.md, references/ and policy.json. When they differ on
a later command, a notice on stderr (stdout and --json are untouched) names the changed files, the
commits since (at most 5, in a git checkout) and the file to read again, and the command still runs.
The notice repeats until \`skill --loaded\`. A session is named by the session id of the Claude Code or
Codex process that runs the command, never by one it inherited from another host. A caller with no
session or task identity (a plain terminal) gets none, and records older than 30 days are removed.
AGENT_ORCH_SKILL_NOTICE=0 turns it off; it is off while AGENT_ORCH_SKILLS_DIR is set (tests) unless
AGENT_ORCH_SKILL_NOTICE=1.`;

const [command, ...rest] = process.argv.slice(2);
const specs = {
  model: { value: ["agent", "tier"] },
  agents: { bool: ["refresh"] },
  new: { value: ["repo", "name", "goal"] },
  worktree: { value: ["from", "branch", "path"], bool: ["no-prep", "adopt"] },
  start: { value: ["agent", "why", "brief", "tier", "effort", "cd", "timeout", "model", "title", "max-parallel", "pr", "done", "max-tier"], bool: ["read-only", "offline", "sandbox", "confine", "babysit", "github", "force", "allow-nested", "no-publish", "no-escalate", "unplanned", "adopt"] },
  status: {},
  watch: { value: ["interval"], bool: ["all", "once"] },
  dashboard: { value: ["port", "host", "idle-exit"], bool: ["open", "new-tab", "detach", "stop"] },
  wait: { value: ["timeout"], bool: ["any", "all", "notes"] },
  result: {},
  log: { value: ["lines"] },
  stop: { bool: ["adopt"] },
  close: { bool: ["all", "adopt"] },
  rename: { value: ["to"], bool: ["adopt"] },
  gc: { value: ["older-than"], bool: ["dry-run"] },
  cleanup: { bool: ["force", "delete-branches", "adopt"] },
  runs: {},
  stats: { value: ["since"] },
  skill: { bool: ["loaded"] },
  "pr-watch": { value: ["repo", "timeout", "interval"], bool: ["once"] },
  brief: { value: ["type", "out"], bool: ["force", "read-only", "adopt"] },
  send: { value: ["file"], bool: ["steer", "adopt"] },
  nap: {},
  heavy: { value: ["label"] },
  reclaim: { bool: ["dry-run"] },
  steer: { bool: ["adopt"] },
  inbox: { bool: ["ack", "all"] },
  questions: { bool: ["all"] },
  reply: { value: ["to", "file"] },
  ask: { value: ["options", "recommend"], bool: ["user"] },
  tell: { value: ["file"] },
  lesson: { value: ["repo", "evidence"], bool: ["list"] },
  plan: { bool: ["check", "adopt"] },
  dispatch: { value: ["max", "timeout"], bool: ["dry-run", "follow", "adopt"] },
  accept: { value: ["commit", "note", "unverified"], bool: ["adopt"] },
  verify: { value: ["timeout"], bool: ["adopt"] },
  verdict: { value: ["note", "reviewer"], bool: ["adopt"] },
  review: { value: ["tier", "focus"], bool: ["adopt"] },
  rework: { value: ["from", "note", "tier", "why"], bool: ["adopt"] },
  resolve: { value: ["note"], bool: ["adopt"] },
  integrate: { value: ["into"], bool: ["dry-run", "already-merged", "adopt"] },
  recover: { bool: ["all"] },
};
const handlers = {
  model: cmdModel,
  agents: cmdAgents,
  new: cmdNew,
  worktree: cmdWorktree,
  start: cmdStart,
  status: cmdStatus,
  watch: cmdWatch,
  dashboard: cmdDashboard,
  wait: cmdWait,
  result: cmdResult,
  log: cmdLog,
  stop: cmdStop,
  close: cmdClose,
  rename: cmdRename,
  cleanup: cmdCleanup,
  gc: cmdGc,
  runs: cmdRuns,
  stats: cmdStats,
  skill: cmdSkill,
  "pr-watch": cmdPrWatch,
  brief: cmdBrief,
  send: cmdSend,
  inbox: cmdInbox,
  questions: cmdQuestions,
  reply: cmdReply,
  ask: cmdAsk,
  tell: cmdTell,
  nap: cmdNap,
  heavy: cmdHeavy,
  reclaim: cmdReclaim,
  steer: cmdSteer,
  lesson: cmdLesson,
  plan: cmdPlan,
  dispatch: cmdDispatch,
  accept: cmdAccept,
  verify: cmdVerify,
  verdict: cmdVerdict,
  review: cmdReview,
  rework: cmdRework,
  resolve: cmdResolve,
  integrate: cmdIntegrate,
  recover: cmdRecover,
};

// A changed skill is reported on stderr before anything else is printed, the help text included, and
// a caller's first command records its fingerprint whatever that command is (lib/skill-version.mjs).
checkSkill(command);

if (command === "wait" && rest.includes("--help")) {
  process.stdout.write(`${USAGE.slice(USAGE.indexOf("  wait RUN"), USAGE.indexOf("  plan RUN"))}`);
} else if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${USAGE}\n`);
} else if (!handlers[command]) {
  die(`unknown command "${command}"\n\n${USAGE}`, 2);
} else {
  // A task's name (`rename`) becomes its id before anything reads the arguments, ownership included.
  const args = resolveTaskNames(command, parseArgs(rest, specs[command]));
  // Every command but the open ones runs only for the run's owner (lib/ownership.mjs).
  gateCommand(command, args);
  if (VERDICT_SYNC.has(command)) {
    try {
      syncReviewVerdicts(args._[0]);
    } catch (error) {
      process.stderr.write(`orch: could not record a reviewer's verdict: ${error.message}\n`);
    }
  }
  await handlers[command](args);
}
