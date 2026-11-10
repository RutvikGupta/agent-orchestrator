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
import { die, parseArgs } from "./lib/util.mjs";
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
import { cmdCleanup, cmdNew, cmdRuns, cmdWorktree } from "./lib/commands/run.mjs";
import { cmdStats } from "./lib/commands/stats.mjs";
import { cmdModel } from "./lib/commands/model.mjs";
import { cmdStart } from "./lib/commands/start.mjs";
import { cmdTell } from "./lib/commands/tell.mjs";
import { cmdClose, cmdLog, cmdResult, cmdStop } from "./lib/commands/task.mjs";
import { cmdVerdict, cmdVerify } from "./lib/commands/verify.mjs";

const USAGE = `agent-orchestrator · orch.mjs

Usage: node orch.mjs <command> [args] [--json]

  model --agent claude|codex [--tier TIER]
                                  Print --model and --effort arguments, lowered to the inherited
                                  ceiling. Without --tier use the ceiling, otherwise standard.
                                  Codex effort uses -c model_reasoning_effort="LEVEL".
  agents [--refresh]              Installed agent CLIs, their relays, login state, model policy,
                                  and how much of each agent's usage limits is used. --refresh
                                  runs one tiny Claude turn to read Claude's current limits
  new [--repo DIR] [--name S] [--goal TEXT]
                                  Create a run (records the repo, base commit, and the
                                  Claude or Codex session that launched it); prints the run id
  worktree RUN TASK [--from REF] [--branch NAME] [--path DIR] [--no-prep]
                                  Create and prepare an isolated git worktree + branch for TASK
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
        [--max-parallel N] [--force] [--babysit --pr N] [-- RELAY_ARGS...]
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
                                  agent and tier. --tier picks the model from policy.json and is
                                  required for a new task: Claude light|standard|complex|frontier, Codex
                                  light|standard|strong|complex. Only frontier takes --effort (medium or high).
                                  A Claude follow-up keeps its earlier tier (a task recorded before
                                  tiers resumes at complex), and --babysit
                                  implies complex, so it needs none. "agents" lists each tier's model.
                                  Run by a delegated agent, its own task gets an inbox message
                                  when this attempt ends: ready for review, needs decision, or failed
  start RUN TASK --agent command --why TEXT [--max-tier TIER] [--done MARKER] [--timeout DUR] [--cd DIR] [--title TEXT]
        [--max-parallel N] [--force] -- COMMAND [ARG...]
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
                                  host's own tool (Claude Code's Agent tool, Codex's spawn_agent)
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
  wait RUN [TASK...] [--all] [--timeout DUR]
                                  Block until any running task finishes (exit 0), the timeout
                                  passes (exit 3), or a task newly needs attention (exit 5):
                                  decision, question, failure, dead or silent; also exit 5 when a
                                  finished task has waited AGENT_ORCH_REVIEW_REMIND (default 10m)
                                  without accept, verdict or close, once per interval per task.
                                  Exit 6 = a new unread message for this agent, or, in the session
                                  that launched the run, a note a task sent with tell (printed);
                                  read it, then run the same command again.
                                  Existing attention is listed
                                  but does not wake wait. --all waits until every task finishes
                                  (--any is the default and accepted). DUR like 90s, 10m, 2h; 0
                                  waits forever. Default 9m.
  plan RUN FILE [--check]         Validate the run's task plan (JSON: ids, goals, agents and tiers,
                                  briefs, dependencies without cycles, and no owned path or resource
                                  shared by tasks that can run at once) and record it as plan.json.
                                  --check only validates. A new plan replaces the old one; started
                                  tasks keep their records, and a running task cannot be dropped
  dispatch RUN [--max N] [--dry-run]
                                  Start, in plan order and up to the free slots (and N), every
                                  planned task whose prerequisites are integrated: a write task in a
                                  new worktree (from the base commit, or the base branch's head
                                  once it has prerequisites), a read-only one in the run's repo.
                                  Lists the tasks still blocked. --dry-run starts nothing
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
  accept RUN TASK [--commit SHA] [--note TEXT]
                                  After reviewing a completed task and committing its work, record
                                  it as accepted (its checkout must be clean); SHA defaults to HEAD.
                                  --note records why; notes when no clean verdict is recorded
  resolve RUN TASK --note TEXT    Mark a handed-back decision as handled, when you answered it
                                  without resuming the agent
  integrate RUN TASK [--into BRANCH] [--dry-run]
                                  Merge an accepted task's branch into the run's base branch (or
                                  BRANCH), which must be checked out and clean in the run's repo.
                                  Checks for conflicts first and changes nothing if there are any.
                                  --dry-run only runs the check
  recover [RUN] [--all]           Read-only summary of the runs this session launched (--all: every
                                  run active in the last 24h): tasks by phase, blocked tasks, dirty
                                  worktrees, dead processes, and the next command for each
  result RUN TASK                 Final report, touched files, session id, artifact paths; each
                                  reported check with its evidence from the agent's log, the
                                  review rounds and the verifications
  send RUN TASK (MESSAGE | --file FILE) [--steer]
                                  Send a message to a running agent, which it reads at its next step;
                                  --steer stops its current shell command so it reads it now (never
                                  a commit, push, rebase, merge or other publishing command)
  steer RUN TASK                  Push a task's queued messages through now: stop its current shell
                                  command (never a publishing one) so it reads them
  heavy [--label TEXT] -- COMMAND [ARG...]
                                  Queue a heavy command until memory is available; exit 6 on a message
  reclaim [--dry-run] [--json]     Stop orphan build daemons and report their resident memory
  nap DUR                         Sleep like \`sleep\`, but return at once (exit 6) when a message
                                  arrives for the agent running it; agents wait with this
  inbox RUN TASK [--ack] [--all]  A task's unread messages (--all: every one); --ack marks them read
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
                                  run, to the launching session's next wait on the run (exit 6).
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
  cleanup RUN [--force] [--delete-branches]
                                  Remove the run's worktrees (dirty ones only with --force)
  runs                            List runs, newest first
  stats [RUN] [--since DUR]        Task outcomes by agent/model and type (default: last 30d)
  pr-watch PR... [--repo DIR] [--timeout DUR] [--interval DUR] [--once]
                                  Watch pull requests (number, URL, or branch) with gh until one
                                  needs you: a check failed, all checks finished, a new review or
                                  comment, a changed review decision, a conflict, or it left OPEN.
                                  Exit 0 = needs you, 3 = timed out (default 9m; 0 waits forever),
                                  4 = the checkout has commits the pull request lacks: push first.
                                  Exit 6 = a new unread message for this agent; read it, then watch again.
                                  Polls every --interval (default 60s); uses no model tokens.
                                  --once prints the current state and marks nothing as seen

RUN may be a run id, a run directory, or "latest". State lives in ${STATE_ROOT}.
Text after "--" is passed to the relay unchanged (for example: -- --session <id>); for
--agent command, it is the command.

Ownership: every command that changes a run acts only on runs the calling session launched, or
their nested runs; reading (status, wait, result, log, recover, inbox, send without --steer, and
dry runs) is open to anyone. Another session's run is refused (exit 4, nothing changed): ask its
owner. A run launched from a terminal is the user's. The user at a terminal and the dashboard may
act on any run, and the owner is told. When every owner of a run has gone and it has been unused
for AGENT_ORCH_ADOPT_AFTER (default 30m), --adopt takes it over.`;

const [command, ...rest] = process.argv.slice(2);
const specs = {
  model: { value: ["agent", "tier"] },
  agents: { bool: ["refresh"] },
  new: { value: ["repo", "name", "goal"] },
  worktree: { value: ["from", "branch", "path"], bool: ["no-prep", "adopt"] },
  start: { value: ["agent", "why", "brief", "tier", "effort", "cd", "timeout", "model", "title", "max-parallel", "pr", "done", "max-tier"], bool: ["read-only", "offline", "sandbox", "confine", "babysit", "github", "force", "allow-nested", "no-publish", "adopt"] },
  status: {},
  watch: { value: ["interval"], bool: ["all", "once"] },
  dashboard: { value: ["port", "host", "idle-exit"], bool: ["open", "new-tab", "detach", "stop"] },
  wait: { value: ["timeout"], bool: ["any", "all"] },
  result: {},
  log: { value: ["lines"] },
  stop: { bool: ["adopt"] },
  close: { bool: ["all", "adopt"] },
  cleanup: { bool: ["force", "delete-branches", "adopt"] },
  runs: {},
  stats: { value: ["since"] },
  "pr-watch": { value: ["repo", "timeout", "interval"], bool: ["once"] },
  brief: { value: ["type", "out"], bool: ["force", "read-only", "adopt"] },
  send: { value: ["file"], bool: ["steer", "adopt"] },
  nap: {},
  heavy: { value: ["label"] },
  reclaim: { bool: ["dry-run"] },
  steer: { bool: ["adopt"] },
  inbox: { bool: ["ack", "all"] },
  reply: { value: ["to", "file"] },
  ask: { value: ["options", "recommend"], bool: ["user"] },
  tell: { value: ["file"] },
  lesson: { value: ["repo", "evidence"], bool: ["list"] },
  plan: { bool: ["check", "adopt"] },
  dispatch: { value: ["max"], bool: ["dry-run", "adopt"] },
  accept: { value: ["commit", "note"], bool: ["adopt"] },
  verify: { value: ["timeout"], bool: ["adopt"] },
  verdict: { value: ["note", "reviewer"], bool: ["adopt"] },
  resolve: { value: ["note"], bool: ["adopt"] },
  integrate: { value: ["into"], bool: ["dry-run", "adopt"] },
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
  cleanup: cmdCleanup,
  runs: cmdRuns,
  stats: cmdStats,
  "pr-watch": cmdPrWatch,
  brief: cmdBrief,
  send: cmdSend,
  inbox: cmdInbox,
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
  resolve: cmdResolve,
  integrate: cmdIntegrate,
  recover: cmdRecover,
};

if (command === "wait" && rest.includes("--help")) {
  process.stdout.write(`${USAGE.slice(USAGE.indexOf("  wait RUN"), USAGE.indexOf("  plan RUN"))}`);
} else if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${USAGE}\n`);
} else if (!handlers[command]) {
  die(`unknown command "${command}"\n\n${USAGE}`, 2);
} else {
  const args = parseArgs(rest, specs[command]);
  // Every command but the open ones runs only for the run's owner (lib/ownership.mjs).
  gateCommand(command, args);
  await handlers[command](args);
}
