// `start`: launch a task's relay in the background, with the policy's model and the task's permissions.

import { admissionReason, admissionEnabled, admissionSettingsError, AdmissionRevoked, withAdmissionLock } from "../admission.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENTS, CLI_PATH, DEPTH, MAX_NEST_DEPTH, SKILL_DIR, SKILL_ROOTS, parallelAt, relayFolder } from "../config.mjs";
import { HANDOFF_RULES, costNote, decisionNote, handoffNote, nestingNote, publishHoldNote, waitingChildrenNote, watchTierNote } from "../briefs.mjs";
import { priceOf } from "../cost.mjs";
import { startDetached } from "../detach.mjs";
import { ensureFinishWatcher, runById, startedByCaller, watchForFinish } from "../finish-notice.mjs";
import { inboxNote, inboxWake } from "../inbox.mjs";
import { BABYSIT_BRIEF_FILE, HANDOFF_FILE, claimParked, coldResume, handoffBrief, handoffCheck, handoffOf, handoffRecord, handoffWhy, reviveParked } from "../park.mjs";
import { liveClaudeSession, liveSessionReason, processExists, sessionIdPrefix } from "../session-guard.mjs";
import { resumeLock } from "../steer.mjs";
import { phaseMap, reviewRoundsOf, verificationsOf } from "../lifecycle.mjs";
import { escalationFor, failureHint } from "../escalation.mjs";
import { readPlan, runningConflicts } from "../plan.mjs";
import { ghJson } from "../github.mjs";
import { guard, recordChange } from "../ownership.mjs";
import { gitHttpsEnv, relaySafetyArgs, unsupportedMode } from "../permissions.mjs";
import { BABYSIT_FIX_TIER, BABYSIT_WATCH_TIER, CLAUDE_DEFAULT_TIER, COMMAND_AGENT, ModelRefused, lowerEffort, callerCeiling, ceilingEnv, ceilingFor, lowerCeiling, modelFor, readPolicy, strongerThan, tierOrder, tierText } from "../policy.mjs";
import { CHILDREN_FILE, attemptAgent, childrenWaitingOn, commandText, describe, listTasks, loadRun, loadTask, recordChild, relayAlive, saveTask, taskDir, validTask } from "../runs.mjs";
import { die, emit, findRelay, parseDuration, readJson } from "../util.mjs";

// A refused start. `dispatch` reports it and goes on with its other tasks; `start` exits with it.
// A model task whose --why says it waits: waiting needs no model. A word match cannot tell "waits
// for a sync" from "fix the script that waits", so `start` notes it rather than refusing.
const WAITING_WHY = /\b(?:wait(?:s|ing)?\s+(?:for|until|on)|poll(?:s|ing)?\b|keeps?\s+(?:checking|watching|polling)|monitor(?:s|ing)?\b|sleeps?\s+until)/i;
export const waitingWhy = (why) => WAITING_WHY.test(String(why ?? ""));
export const waitingNote = (runId, taskId) => `note: this --why describes waiting, which needs no model. A wait then fixed commands is one command task (--agent command --timeout DUR -- sh -c 'until <check>; do sleep 30; done; <commands>'); an agent that must judge after a wait parks (park-until). If that fits, stop this task: node ${CLI_PATH} stop ${runId} ${taskId}`;

export class StartRefused extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function refuse(message, code) {
  throw new StartRefused(message, code);
}

// `start` from the command line, where only the run's owner may start or resume its tasks; the park
// watcher and `wait`'s retries resume a task through startTask() itself. It validates the request
// once; `--wait` then repeats only the machine admission and the launch.
export async function cmdStart(args) {
  if (args.agent !== COMMAND_AGENT) {
    const bad = admissionSettingsError();
    if (bad) die(bad, 2);
  }
  const duration = args.wait === undefined ? null : parseDuration(args.wait);
  const until = duration === null ? null : Date.now() + duration;
  let reported = false;
  const wake = until === null ? null : inboxWake();
  const cancel = () => { const message = wake?.check(); if (message) refuse(message.hint, 6); };
  let prepared = null;
  for (;;) {
    try {
      cancel();
      if (!prepared) {
        const run = loadRun(args._[0]);
        const prev = args._[1] ? loadTask(run, validTask(args._[1])) : null;
        const resume = Boolean(prev?.attempt);
        const g = guard(run, resume ? `resume task ${prev.id} of run ${run.id}` : `start a task in run ${run.id}`, { adopt: args.adopt, refused: prev ? [prev.id] : [] });
        prepared = { run, g, resume, launch: prepareStart({ ...args, admissionDeadline: until, admissionCancel: cancel }, resume ? { resumedBy: g.actor } : {}) };
      }
      const { task, text } = prepared.launch();
      if (prepared.resume) recordChange(prepared.run, prepared.g, { task: task.id, attempt: task.attempt, action: "resumed" });
      emit(args, task, text);
      return;
    } catch (error) {
      // A start stopped while it held the machine lock lost it: validate again, as startTask does.
      if (error instanceof AdmissionRevoked) { prepared = null; continue; }
      if (error instanceof StartRefused && error.code === 7 && until !== null && Date.now() < until) {
        if (!reported) { process.stderr.write(`waiting: ${error.message}\n`); reported = true; }
        await new Promise((resolve) => setTimeout(resolve, Math.min(3000, until - Date.now())));
        continue;
      }
      if (error instanceof StartRefused) die(error.message, error.code);
      throw error;
    }
  }
}

// The relay of a command task: it runs the command with no model (scripts/command-relay.mjs).
const COMMAND_RELAY = path.join(SKILL_DIR, "scripts", "command-relay.mjs");
// The options a command task has no use for: it has no brief, sandbox or pull request. The model
// policy refuses --tier, --model and --effort for it (policy.mjs).
const NOT_FOR_COMMANDS = ["brief", "babysit", "pr", "sandbox", "confine", "offline", "no-publish"];
const DURATION = /^\d+(?:\.\d+)?(?:ms|s|m|h)?$/;

// A command task's command and its options, checked: { argv, done, timeout, reused }. Started
// again without a command after `--`, it re-runs the previous attempt's command, with that
// attempt's --done and --timeout unless new ones are given.
function commandOf(args, prev) {
  const given = NOT_FOR_COMMANDS.filter((name) => args[name] !== undefined && args[name] !== false);
  if (given.length) refuse(`a command task has no brief, sandbox or pull request: drop ${given.map((name) => `--${name}`).join(", ")}`, 2);
  const reused = !args.passthrough.length;
  const argv = reused ? (prev.agent === COMMAND_AGENT && Array.isArray(prev.command) ? prev.command : null) : args.passthrough;
  if (!argv?.length || !argv[0]) refuse("give the command after --: start RUN TASK --agent command --why TEXT -- COMMAND [ARG...]", 2);
  const done = args.done ?? (reused ? prev.doneMarker ?? null : null);
  if (done !== null && !String(done).trim()) refuse("--done needs a marker: text the command prints when it has done its work", 2);
  const timeout = args.timeout ?? (reused ? prev.commandTimeout ?? null : null);
  if (timeout !== null && !DURATION.test(String(timeout).trim())) refuse(`bad --timeout "${timeout}" (use e.g. 90s, 10m, 2h)`, 2);
  return { argv, done, timeout, reused };
}

// The tier of the task whose shell runs this command ({ run, task, agent, tier }), from AGENT_ORCH_RUN
// and AGENT_ORCH_TASK; null for a session that no task started, and for a command task, which has no
// tier. A Claude task recorded before Claude had tiers ran `complex`.
function callerTier() {
  const runId = process.env.AGENT_ORCH_RUN;
  const taskId = process.env.AGENT_ORCH_TASK;
  if (!runId || !taskId) return null;
  const run = runById(runId);
  const record = run && loadTask(run, taskId);
  if (!record) return null;
  const agent = attemptAgent(record, record.attempt) || record.agent;
  const tier = record.tier || (agent === "claude" ? CLAUDE_DEFAULT_TIER : null);
  return agent === COMMAND_AGENT || !tier ? null : { run: runId, task: taskId, agent, tier, effort: record.effort || null };
}

// A delegated agent never starts a stronger model than its own: it was given its task at a tier
// chosen for that task, and handing the work to a stronger model defeats that choice. A babysitter's
// default watch tier and its fix tier are policy (a fix attempt is started by the orchestrator, not
// by an agent), so only an inherited ceiling is checked for them; a --tier given for it is checked
// against the caller too.
function refuseStronger(key, tier, ignoreCaller = false) {
  try {
    const own = ignoreCaller ? null : callerTier();
    if (own) callerCeiling(own); // A stale caller must not turn the guard off.
    const inherited = process.env.AGENT_ORCH_MAX_TIER;
    const cap = inherited === undefined ? null : ceilingFor(inherited);
    const bounds = [own, cap && {
      agent: "claude", tier: cap.tier,
      run: process.env.AGENT_ORCH_RUN || "environment",
      task: process.env.AGENT_ORCH_TASK || "ceiling",
    }].filter(Boolean);
    for (const bound of bounds) {
      if (!strongerThan({ agent: key, tier }, bound)) continue;
      refuse(`refusing: this command runs in task ${bound.run}/${bound.task}, on ${tierText(bound.agent, bound.tier)}, and ${tierText(key, tier)} is stronger. A delegated agent never starts a stronger model than its own. Do the work at your tier, split it into pieces at your tier or lighter, or ask your orchestrator with \`node ${CLI_PATH} ask "<why it needs a stronger model>"\` (or end with NEEDS DECISION:) so it chooses.`, 2);
    }
  } catch (error) {
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
}

// The close and stop that came after `since` (the task as a resume first saw it): what a resume that
// is starting must keep, and why it must start nothing. Null when none came.
function endedSince(since, latest) {
  const ended = {
    ...(latest?.closedAt && latest.closedAt !== since?.closedAt ? { closedAt: latest.closedAt } : {}),
    ...(latest?.stoppedAt && latest.stoppedAt !== since?.stoppedAt ? { stoppedAt: latest.stoppedAt } : {}),
  };
  return Object.keys(ended).length ? ended : null;
}

// The relay arguments of an attempt that resumes the attempt whose arguments were `argv`: the same
// ones, with this attempt's brief and folder, and without the session it resumed (the caller adds
// the one to resume). Every other option is kept as it was: model, effort, timeout, sandbox,
// network, permission rules, and what was passed after `--`.
const VALUE_FLAGS = new Set(["--brief", "--cd", "--lane", "--out-dir", "--timeout", "--model", "--effort", "--max-turns", "--max-budget-usd", "--autocompact", "--session", "--allow-domain", "--deny", "--allow-write", "--subagent-model", "--subagent-effort", "--web-search", "--sandbox", "--keep-env"]);
function rebaseRelayArgs(argv, brief, outDir) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--resume-last" || word.startsWith("--session=")) continue;
    if (!VALUE_FLAGS.has(word)) {
      out.push(word);
      continue;
    }
    const value = argv[++i];
    if (word === "--session") continue;
    out.push(word, word === "--brief" ? brief : word === "--out-dir" ? outDir : value);
  }
  return out;
}

// Why a task cannot start in `cd`, which is gone. A worktree that cleanup collected after its task
// was closed or integrated keeps its branch, so the message says how to bring the folder back.
function missingDirectory(run, id, prev, cd) {
  const collected = prev?.removedWorktree;
  if (collected && path.resolve(collected.path || "") === cd) {
    return `task ${id}'s worktree was collected after the task was closed or integrated; its branch ${collected.branch} is kept. Restore the folder with \`node ${CLI_PATH} worktree ${run.id} ${id}\`, then start again`;
  }
  return `--cd does not exist: ${cd}`;
}

// Start one task from parsed `start` arguments; `dispatch` calls it too. `extra` holds fields to
// record in the task, such as its plan entry. Returns the saved task and the text `start` prints.
// A resume of a task that has an attempt claims that attempt first (steer.mjs, resumeLock), so two
// resumes never both start the next attempt; `args.parkClaim` brings a claim the caller holds (a
// park watcher's or an interrupt's), whose `since` is the task as it first saw it. Arguments only
// callers pass: `relayFrom`, the relay arguments of the attempt this one resumes, kept but for the
// brief, the folder and the session; `briefData`, text the brief carries after the brief file, such
// as messages, which is never checked for template markers; `check`, which runs every check of a
// start without starting anything, also while the task's relay still runs (the caller stops it).
export function startTask(args, extra = {}) {
  for (;;) {
    try { return prepareStart(args, extra)(); }
    catch (error) { if (!(error instanceof AdmissionRevoked)) throw error; }
  }
}

// The plan's checks on a task's first start, against the tasks that run now: it must be in the plan
// (or --unplanned), its dependencies integrated, and it must not share an owned path or a resource
// with a running task; --force skips the last two. Run when a start is validated and again at each
// launch attempt, since a start that waits for the machine sees the run change meanwhile. Returns the
// plan fields to record in the task.
function planChecks(run, id, args, previous, { note = false } = {}) {
  const plan = readPlan(run.dir);
  const entry = plan?.tasks.find((task) => task.id === id);
  if (plan && !previous?.attempt) {
    const rows = listTasks(run);
    if (!entry && !args.unplanned && !previous?.unplanned) {
      refuse(`task ${id} is not in the plan; add it with plan, or pass --unplanned to record the exception`);
    }
    const readOnly = Boolean(args["read-only"] || args.agent === COMMAND_AGENT);
    const reservation = { ...(entry || { id, owns: readOnly ? [] : ["."] }), agent: args.agent, readOnly, babysit: Boolean(args.babysit || entry?.type === "babysit") };
    const phases = phaseMap(run, rows, plan);
    const waiting = (entry?.dependsOn || []).filter((dep) => phases.get(dep) !== "integrated");
    const held = rows.filter((row) => row.id !== id && row.state === "running" && row.phase !== "parked").map((row) => {
      const record = loadTask(run, row.id);
      const current = plan.tasks.find((task) => task.id === row.id);
      const original = record?.plan || current || { id: row.id, owns: record?.readOnly ? [] : ["."] };
      return { ...original, agent: record?.agent || original.agent, readOnly: Boolean(record?.readOnly || record?.agent === COMMAND_AGENT), babysit: Boolean(record?.babysit),
        owns: [...new Set([...(original.owns || []), ...(current?.owns || [])])],
        resources: [...new Set([...(original.resources || []), ...(current?.resources || [])])] };
    });
    const conflicts = runningConflicts(reservation, held);
    if (!args.force && (waiting.length || conflicts.length)) {
      const reasons = [
        waiting.length ? `waits on ${waiting.join(", ")} (not integrated)` : null,
        ...conflicts.map((c) => `conflicts with running task ${c.b}: ${[...c.paths, ...c.resources].join(", ")}`),
      ].filter(Boolean);
      refuse(`cannot start ${id}: ${reasons.join("; ")}; --force overrides the plan checks`);
    }
    return entry ? { plan: entry } : { unplanned: true, unplannedAt: previous?.unplannedAt || new Date().toISOString() };
  }
  if (note && !plan && !previous?.attempt && listTasks(run).filter((row) => row.attempt).length === 2) {
    process.stderr.write(`note: this run is reaching its third task without a plan; use node ${CLI_PATH} plan ${run.id} FILE to coordinate dependencies and owned paths\n`);
  }
  return {};
}

// Every check of a start that does not depend on the machine, done once. Returns the function that
// takes the machine lock, checks admission and launches; `start --wait` calls it again while the
// machine is full, so a slow check such as the pull-request read runs only once.
function prepareStart(args, extra = {}) {
  if (DEPTH >= MAX_NEST_DEPTH && !args["allow-nested"]) {
    refuse(`refusing to dispatch: this agent is ${DEPTH} levels below the user's session, the most allowed (AGENT_ORCH_MAX_DEPTH=${MAX_NEST_DEPTH}); do the work yourself`);
  }
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const previous = loadTask(run, id);
  extra = { ...extra, ...planChecks(run, id, args, previous, { note: true }) };
  const key = args.agent || refuse("--agent is required (see: node orch.mjs agents)", 2);
  if (key === COMMAND_AGENT) return () => startCommand(run, id, args, extra);
  if (!Object.hasOwn(AGENTS, key)) refuse(`unsupported agent "${key}" (choose: ${Object.keys(AGENTS).join(", ")}, or ${COMMAND_AGENT} to run a command with no model)`, 2);
  if (args["max-tier"] !== undefined) refuse("--max-tier applies to --agent command only", 2);
  if (args.done !== undefined) refuse("--done applies to --agent command only", 2);
  if (!args.brief) refuse("--brief FILE is required", 2);
  const briefSource = path.resolve(args.brief);
  if (!fs.existsSync(briefSource) || !fs.readFileSync(briefSource, "utf8").trim()) refuse(`brief is missing or empty: ${briefSource}`, 2);
  const briefText = fs.readFileSync(briefSource, "utf8");
  // A marker is the whole "<fill in: ...>" form on one line; prose that only mentions "<fill in:" is not one.
  const MARKER = /<fill in:[^<>\n]*>/g;
  // Text inside `code spans` only mentions the syntax; template markers are never quoted.
  const unquoted = briefText.replace(/`[^`\n]*`/g, "");
  const markers = unquoted.match(MARKER) || [];
  if (markers.length) {
    const line = unquoted.split(/\r?\n/).find((line) => line.match(MARKER));
    refuse(`brief contains ${markers.length} unfilled marker${markers.length === 1 ? "" : "s"}: ${line.trim()}`, 2);
  }
  const relay = findRelay(key) || refuse(`no ${relayFolder(key)} relay found in: ${SKILL_ROOTS.join(", ")}`);

  const prev = loadTask(run, id) || { id, createdAt: new Date().toISOString() };
  const previousRow = prev.attempt ? describe(run, prev) : null;
  const previousAttempts = (previousRow?.attempts || []).slice().reverse();
  const sameAgent = Boolean(prev.attempt && prev.agent === key);
  const babysit = Boolean(args.babysit || (sameAgent && prev.babysit));
  // A new task needs --tier (modelFor refuses it without). A Claude follow-up keeps the earlier
  // attempt's tier until repeated failures escalate it; Claude tasks recorded before tiers ran
  // `complex`. A babysitter watches at its watch tier: --tier when given, else the one it recorded,
  // else BABYSIT_WATCH_TIER; a babysitter recorded before watch tiers watches at that default too.
  // Its fix attempts (attemptReason "fix", started by finish-notice.mjs) run BABYSIT_FIX_TIER and
  // keep the watch tier for the wakes after them.
  const fixAttempt = babysit && extra.attemptReason === "fix";
  const watchTier = babysit && key === "claude"
    ? (fixAttempt ? prev.watchTier : args.tier || (sameAgent && prev.babysit ? prev.watchTier : null)) || BABYSIT_WATCH_TIER
    : null;
  const prevTier = sameAgent ? prev.tier || (key === "claude" ? CLAUDE_DEFAULT_TIER : null) : null;
  const automatic = !babysit && sameAgent && !args.tier && !args["no-escalate"]
    ? escalationFor(prev, previousAttempts) : null;
  if (automatic?.refusal) refuse(automatic.refusal, 2);
  let escalation = automatic?.note || null;
  const effectiveArgs = automatic?.tier ? { ...args, tier: automatic.tier } : args;
  const tierArgs = watchTier ? { ...args, tier: fixAttempt ? BABYSIT_FIX_TIER : watchTier } : effectiveArgs;
  let choice;
  try {
    choice = modelFor(key, !tierArgs.tier && prevTier ? { ...tierArgs, tier: prevTier } : tierArgs, babysit ? null : prevTier);
    if (process.env.AGENT_ORCH_MAX_EFFORT !== undefined) {
      choice.effort = lowerEffort(choice.effort, process.env.AGENT_ORCH_MAX_EFFORT);
    }
  } catch (error) {
    // A refused start, not an exit: `dispatch` goes on with its other tasks.
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
  const { tier } = choice;
  // A resume that keeps the relay's arguments keeps the model and effort they name.
  const keep = Array.isArray(args.relayFrom) && args.relayFrom.includes("--brief") && args.relayFrom.includes("--out-dir") && sameAgent;
  const { model, effort } = keep ? { model: prev.model ?? choice.model, effort: prev.effort ?? null } : choice;
  if (!escalation && extra.attemptReason !== "retry") escalation = failureHint(prev, previousAttempts, key, tier);
  if (watchTier && strongerThan({ agent: "claude", tier: watchTier }, { agent: "claude", tier: BABYSIT_FIX_TIER })) {
    refuse(`a babysitter watches at the light, ${BABYSIT_WATCH_TIER} (the default) or ${BABYSIT_FIX_TIER} tier, and its fix attempts run ${BABYSIT_FIX_TIER}; drop --tier ${watchTier}`, 2);
  }
  refuseStronger(key, tier, babysit && (fixAttempt || !args.tier));
  const ownRelayRuns = relayAlive(prev.pid, null, prev.outDir);
  if (!args.check && ownRelayRuns) refuse(`task ${id} is already running (pid ${prev.pid})`);
  if (key === "claude" && !ownRelayRuns) refuseRunningSession(id, args.passthrough);
  const cd = path.resolve(args.cd || prev.cd || run.repo);
  if (!fs.existsSync(cd)) refuse(missingDirectory(run, id, prev, cd));
  // The orchestrator chooses the agent and tier by assessing the task; record why. A follow-up
  // attempt with the same agent and tier keeps the earlier reason unless a new one is given, and so
  // does a babysitter, whose tier moves between watching and fixing by policy.
  const keepsChoice = sameAgent && (prevTier === tier || babysit);
  // --offline carries over to follow-up attempts by the same agent.
  const offline = Boolean(args.offline || (sameAgent && prev.offline));
  if (babysit && key !== "claude") refuse("pull-request babysitting runs on Claude: a babysitter (--babysit) parks and resumes the same Claude session, watching at the standard tier and fixing at complex (SKILL.md step 8). A Codex or Gemini implementer hands its pull request to a Claude babysitter through its handoff note (references/babysit.md)", 2);
  if (babysit && (args["read-only"] || offline)) refuse("a babysitter needs write mode and the network", 2);
  // Babysitting starts only once the pull request is ready for review: open, and not a draft.
  let pr = babysit ? prev.pr || null : null;
  if (babysit && (args.pr || !pr)) {
    if (!args.pr) refuse("--babysit needs --pr <number|url>: the pull request to babysit", 2);
    const view = ghJson(cd, ["pr", "view", args.pr, "--json", "number,url,state,isDraft"]);
    if (view.error) refuse(`cannot read pull request ${args.pr}: ${view.error}`);
    const v = view.value;
    if (v.state !== "OPEN") refuse(`pull request #${v.number} is ${v.state.toLowerCase()}; there is nothing to babysit`, 2);
    if (v.isDraft) refuse(`pull request #${v.number} is still a draft; start its babysitter once it is ready for review (gh pr ready ${v.number})`, 2);
    pr = { number: v.number, url: v.url };
  }
  // --sandbox carries over to follow-up attempts by the same agent.
  const sandbox = Boolean(args.sandbox || (sameAgent && prev.sandboxRequested));
  const confine = Boolean(args.confine || (sameAgent && prev.confine));
  // A write task publishes (commits, pushes, writes to GitHub) unless the user said to review its
  // work first: --no-publish, which carries over to follow-up attempts.
  const noPublish = Boolean(args["no-publish"] || (prev.attempt && prev.noPublish));
  const unsupported = unsupportedMode({ key, offline, confine, passthrough: args.passthrough });
  if (unsupported) refuse(unsupported, 2);
  const why =
    String(args.why ?? "").replace(/\s+/g, " ").trim() ||
    (automatic?.tier ? `${prev.why || "Follow-up"}; ${escalation}` : keepsChoice ? prev.why : null) ||
    refuse(`--why is required: one line on why your assessment of this task picked ${key}${tier ? ` at the ${tier} tier` : ""} (see SKILL.md, "Choose the agent and model")`, 2);
  const sharesRepo = !prev.worktree && path.resolve(cd) === path.resolve(run.repo);
  // An implementer kept as its pull request's babysitter (`start --babysit ... -- --session <id>`):
  // its session's latest call may be large, and the switch to the watch tier's model reads no
  // prompt cache. Above the handoff limit (the cold one for a switch of model or a long wait), with
  // a handoff note written since its last attempt started, the babysitter starts a fresh session
  // from this brief and the note instead (park.mjs). Without a current note it continues the
  // session, and its brief tells it to write one: memory is never dropped without a note.
  const sessionGiven = args.passthrough.some((a) => a === "--session" || a.startsWith("--session=") || a === "--resume-last");
  const implementer = babysit && key === "claude" && sameAgent && !prev.babysit && sessionGiven && !args.parkClaim && !fixAttempt && prev.outDir
    ? (() => {
      const ended = readJson(path.join(prev.outDir, "result.json"))?.finishedAt;
      const { cold, why } = coldResume(ended, prev.model, model);
      return handoffOf(run, prev, prev.outDir, { cold, coldWhy: why, original: briefText });
    })()
    : null;
  const passthrough = implementer?.fresh ? withoutSession(args.passthrough) : args.passthrough;

  checkSlots(run, id, args, cd, { writes: !args["read-only"] });
  const agentEnv = readAgentEnv();
  // Claude's effort environment overrides --effort, including values from agent-env.json.
  // Lower those overrides too, so the relay's bounded choice remains effective.
  if (process.env.AGENT_ORCH_MAX_EFFORT !== undefined) {
    for (const name of ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_EFFORT"]) {
      const inherited = agentEnv[name] ?? process.env[name];
      if (inherited) {
        const bounded = lowerEffort(inherited, process.env.AGENT_ORCH_MAX_EFFORT);
        if (bounded !== inherited) agentEnv[name] = bounded;
      }
    }
  }
  // The relay's rules protect the credential folders of the environment it runs in, which
  // agent-env.json can change, as well as the orchestrator's own.
  const net = relaySafetyArgs({ key, relay, cd, readOnly: Boolean(args["read-only"]), offline, sandbox, confine, babysit, publish: !noPublish, env: { ...process.env, ...agentEnv } });

  // The context window at which Claude Code compacts the session (compactWindow).
  const compact = key === "claude" ? compactWindow({ ...process.env, ...agentEnv }) : null;

  // The agent this start replaces already held a place: a parked babysitter's watcher, a retry and an
  // interrupt bring their claim on its attempt or retry it. They skip the count, and only they may run
  // without the machine lock when it stays busy.
  const replacement = Boolean(prev.attempt && prev.agent !== COMMAND_AGENT && (args.parkClaim || ["retry", "fix"].includes(extra.attemptReason)));
  // Validate before acquiring the machine lock, including any slow pull-request lookup.
  const launch = (owner = () => {}, locked = false) => {
    // Other starts may have changed the run while this one waited for the machine lock.
    const current = loadTask(run, id) || prev;
    if (!args.check && relayAlive(current.pid, current.startedAt, current.outDir)) refuse(`task ${id} is already running`);
    // Another start that began and ended meanwhile: this one was validated against the attempt before.
    if ((current.attempt || 0) !== (prev.attempt || 0)) refuse(`task ${id} was started meanwhile, in attempt ${current.attempt}, so this start started nothing; run \`status\` to see it`);
    // The plan's constraints and the run's limits as they are now, not as validation saw them.
    const fields = { ...extra, ...planChecks(run, id, args, previous) };
    checkSlots(run, id, args, cd, { writes: !args["read-only"] });
    if (admissionEnabled()) {
      const reason = admissionReason(undefined, { replacement: replacement || !locked });
      owner();
      if (reason) refuse(reason, 7);
    }
    owner();
    // Every check has passed: a check run starts nothing.
    if (args.check) return { task: null, text: `${id} can start` };

    // Resuming a parked babysitter ends its park, and exactly one resume (its watcher's, which brings
    // its claim, or this one) may: claim it before writing anything, so a resume that loses changes nothing.
    // Any other resume claims the attempt it replaces, for the same reason.
    const parkClaim = args.parkClaim || claimParked(run, prev, "start") || resumeLock(run, prev, extra.attemptReason === "retry" ? "retry" : "start");
    if (parkClaim?.refused) refuse(parkClaim.refused);
    // A claim the caller brought stays the caller's: it releases it when the start fails, and a start
    // whose admission was revoked runs again with it. Only a claim taken here is given back here.
    const giveBack = () => { if (parkClaim !== args.parkClaim) parkClaim?.release(); };

    const attempt = (prev.attempt || 0) + 1;
    // Why this attempt starts: `retry` comes from retry.mjs; a `changes` verdict on the previous
    // attempt makes this one a rework.
    const lastRound = prev.attempt ? reviewRoundsOf(run, id).at(-1) : null;
    const attemptReason = extra.attemptReason
      || (!prev.attempt ? "first" : lastRound?.verdict === "changes" && lastRound.attempt === prev.attempt ? "rework" : "resume");
    const outDir = path.join(taskDir(run, id), `attempt-${attempt}`);
    const brief = path.join(outDir, "orch-brief.md");
    // A task that can start agents (it writes, reaches the network, and runs outside the sandbox) is
    // told to hand slow side work to them. That includes babysitters, which run tests and fixes.
    const childDepth = DEPTH + 1;
    try {
      owner();
      fs.mkdirSync(outDir, { recursive: true });
      if (implementer?.fresh) fs.writeFileSync(brief, handoffBrief(implementer, "## Start\n\nDo the start checks of your brief, then begin its loop.\n", { from: "implementer" }));
      else fs.copyFileSync(briefSource, brief);
      // Data the brief carries, such as messages, is passed on as it is: never checked for markers.
      if (args.briefData) fs.appendFileSync(brief, `\n${String(args.briefData).trim()}\n`);
      if (!args["read-only"] && !offline && !sandbox && childDepth < MAX_NEST_DEPTH) {
        fs.appendFileSync(brief, nestingNote(childDepth));
      }
      // Gemini's relay enforces --no-publish with deny rules, so its brief needs no note about it.
      if (noPublish && !args["read-only"] && key !== "gemini") fs.appendFileSync(brief, publishHoldNote());
      if (babysit) {
        fs.appendFileSync(brief, handoffNote(path.join(taskDir(run, id), HANDOFF_FILE)));
        // A large implementer session kept without a current note: it writes one before it parks.
        if (implementer && !implementer.fresh && implementer.tokens > implementer.limit) fs.appendFileSync(brief, implementerNoteLine(implementer));
        // An attempt that watches below the fix tier hands every code fix to a fix attempt.
        if (!fixAttempt && watchTier && strongerThan({ agent: "claude", tier: BABYSIT_FIX_TIER }, { agent: "claude", tier })) fs.appendFileSync(brief, watchTierNote(tier, BABYSIT_FIX_TIER));
        // Keep the brief a babysitter's session starts from, as it was given: a fresh session that
        // takes over from a handoff note starts from it again. A brief that continues a babysitter's
        // session, or the one the watcher composes for that fresh session, is not it. The brief that
        // makes a finished task (its implementer) the babysitter, in that task's session, is.
        if (!args.fromHandoff && (!args.passthrough.includes("--session") || !prev.babysit)) fs.copyFileSync(briefSource, path.join(taskDir(run, id), BABYSIT_BRIEF_FILE));
      }
      // What this model costs, and the tier's default budget. The measured budget comes from `cost`:
      // a start never reads the tier summary, which goes through every finished task.
      let defaultBudget = null;
      try { defaultBudget = tier ? readPolicy()[key]?.tiers?.[tier]?.budget ?? null : null; } catch { defaultBudget = null; }
      const costText = model ? costNote({ agent: key, tier: tier || "no tier", model, price: priceOf(model), defaultBudget }) : "";
      // The inbox note stays last: agents and tests find it at the end of the brief.
      fs.appendFileSync(brief, decisionNote(babysit) + costText + waitingChildrenNote(childrenWaitingOn(run, id)) + inboxNote(run, id, key));
      // Files the brief points to, such as the messages a parked task's watcher delivers in full.
      for (const [name, text] of Object.entries(args.attemptFiles || {})) fs.writeFileSync(path.join(outDir, path.basename(name)), text);
    } catch (error) {
      giveBack();
      throw error;
    }

    const relayArgs = keep ? rebaseRelayArgs(args.relayFrom, brief, outDir) : ["--brief", brief, "--cd", cd, "--out-dir", outDir];
    if (!keep) {
      if (args["read-only"]) relayArgs.push("--read-only");
      if (args.timeout || babysit) relayArgs.push("--timeout", args.timeout || "24h");
      // A tier without an effort runs at the CLI's default for its model.
      relayArgs.push("--model", model, ...(effort ? ["--effort", effort] : []));
      relayArgs.push(...net.args);
    }
    if (automatic?.tier && !args.passthrough.some((arg) => arg === "--session" || arg.startsWith("--session=") || arg === "--resume-last")) {
      const session = previousRow?.session;
      if (session) relayArgs.push("--session", session);
    }
    relayArgs.push(...passthrough);
    if (automatic?.tier) {
      const sessionAt = relayArgs.indexOf("--session");
      const hasSession = relayArgs.includes("--resume-last") || (sessionAt >= 0 && Boolean(relayArgs[sessionAt + 1])) || relayArgs.some((a) => a.startsWith("--session=") && a.length > "--session=".length);
      escalation += hasSession ? "; continuing the same session" : "; this attempt starts a fresh session";
    }

    // The orch task that runs this `start` is the parent this attempt reports to (finish-notice.mjs).
    // The record is ready before the relay starts, so that a resume can record both at once.
    const startedBy = startedByCaller(run, id);
    const task = {
      ...prev,
      agent: key,
      tier,
      model,
      effort,
      why,
      attemptAgents: { ...(prev.attemptAgents || {}), [attempt]: key },
      attemptTiers: { ...Object.fromEntries(previousAttempts.map((a) => [a.n, a.tier])), [attempt]: tier },
      attemptStops: { ...(prev.attemptStops || {}), ...(prev.stoppedAt ? { [prev.attempt]: prev.stoppedAt } : {}) },
      automaticEscalations: { ...(prev.automaticEscalations || {}), ...(automatic?.tier ? { [attempt]: { from: prevTier, to: tier } } : {}) },
      ...(watchTier ? { watchTier } : {}),
      ...(implementer?.fresh ? { handoffs: { ...(prev.handoffs || {}), [attempt]: handoffRecord(implementer, prev.attempt, new Date().toISOString(), { from: "implementer" }) } } : {}),
      ...(implementer ? { handoffChecks: { ...(prev.handoffChecks || {}), [attempt]: handoffCheck(implementer) } } : {}),
      ...(compact ? { compactWindows: { ...(prev.compactWindows || {}), [attempt]: compact.record } } : {}),
      // The ceiling this attempt starts under (AGENT_ORCH_MAX_TIER, AGENT_ORCH_MAX_EFFORT): whoever
      // later starts its park watcher restores it (park.mjs, withCeiling), so no resume or fix
      // attempt of the task goes above it, even when an uncapped process such as the dashboard
      // revives the watcher.
      inheritedCeiling: process.env.AGENT_ORCH_MAX_TIER || process.env.AGENT_ORCH_MAX_EFFORT
        ? { maxTier: process.env.AGENT_ORCH_MAX_TIER || null, maxEffort: process.env.AGENT_ORCH_MAX_EFFORT || null }
        : null,
      attemptReason,
      attemptReasons: { ...(prev.attemptReasons || {}), [attempt]: attemptReason },
      title: args.title ?? prev.title ?? null,
      relay,
      cd,
      readOnly: Boolean(args["read-only"]),
      offline,
      babysit,
      sandboxRequested: sandbox,
      confine,
      noPublish,
      sandboxed: keep ? prev.sandboxed : net.sandboxed,
      pr,
      closedAt: null,
      stoppedAt: null, // a start by hand opens a closed or stopped task again; a stop or close since its claim is kept below
      network: keep ? prev.network : net.network,
      attempt,
      outDir,
      pid: null, // set once the relay starts
      argv: relayArgs,
      startedAt: new Date().toISOString(),
      startDepth: DEPTH,
      startedBy,
      // Each attempt reports to the task that started it, even after a later attempt starts.
      attemptStartedBy: { ...(prev.attemptStartedBy || {}), [attempt]: startedBy },
      resumedBy: null, // who resumed this attempt by hand (cmdStart passes it), not a park or retry resume
      ...fields,
    };
    // A close or stop that came while this resume was starting (since its claim's holder first saw
    // the task) wins: start nothing.
    const since = parkClaim?.since || prev;
    if (parkClaim) {
      const ended = endedSince(since, loadTask(run, id));
      if (ended) {
        giveBack();
        fs.rmSync(outDir, { recursive: true, force: true });
        refuse(`task ${id} was ${ended.closedAt ? "closed" : "stopped"} while this resume was starting, so it started nothing`);
      }
    }
    let started;
    try {
      // The last revocation check. A start that the system pauses after it and before the relay is
      // spawned can be revoked by another start, which then takes the place, and still spawn when it
      // continues: one agent over the limit. The limit controls load and is not a hard guarantee;
      // waiting on a stopped holder instead would let one paused process block every start.
      owner();
      started = spawnRelay(run, id, relay, relayArgs, outDir, cd, { ...agentEnv, ...(net.httpsGit ? gitHttpsEnv(process.env) : {}), ...(compact?.env || {}) });
    } catch (error) {
      giveBack();
      if (error instanceof AdmissionRevoked) throw error;
      failedStart(id, outDir, error);
    }
    task.pid = started.pid;
    task.launch = started.launch;
    // First of all, record the relay: a resume that dies now leaves it for the next claimant to adopt.
    parkClaim?.spawned?.(task);
    // A resume never clears a close or stop that came while it started.
    if (parkClaim) Object.assign(task, endedSince(since, loadTask(run, id)) || {});
    saveTask(run, task);
    parkClaim?.done(task);
    // Started once the record is saved, so the watcher always reads this attempt. A babysitter always
    // gets one, and so does a task that started tasks: when its attempt ends parked, the watcher
    // starts its park watcher (park.mjs), and a babysitter's NEEDS FIX starts its fix attempt.
    if (startedBy || babysit || fs.existsSync(path.join(taskDir(run, id), CHILDREN_FILE))) watchForFinish(run, task);
    if (startedBy) noteChild(run, id, attempt, startedBy);
    const warn =
      (sharesRepo && !args["read-only"] ? "\nnote: writing in the main checkout; use a worktree when other tasks write in parallel" : "") +
      (!babysit && waitingWhy(args.why) ? `\n${waitingNote(run.id, id)}` : "");
    return {
      task,
      text: `started ${id} → ${key} ${model} (${effort ? `effort ${effort}` : "default effort"}${tier ? `, ${tier} tier` : ""}, ${task.readOnly ? "read-only" : "write"}${babysit ? ", babysitter: may commit and push" : task.readOnly ? "" : noPublish || net.sandboxed ? ", does not publish" : ", may commit and push"}${task.readOnly ? "" : net.sandboxed ? (net.network === "on" ? ", sandboxed, network on" : ", sandboxed, offline") : ", no sandbox"}) pid ${started.pid}, attempt ${attempt}\n  why: ${why}\n  cd:  ${cd}\n  out: ${outDir}${warn}${net.note ? `\nnote: ${net.note}` : ""}${escalation ? `\nnote: ${escalation}` : ""}${babysitLine(watchTier, fixAttempt, tier)}${implementer?.fresh ? `\nnote: started a fresh session from the babysit brief and the handoff note instead of continuing session ${sessionOf(args.passthrough) || "(the latest)"}: ${handoffWhy(implementer)} (limit ${implementer.limit}, ${implementer.cold ? "cold" : "warm"})` : ""}\nnext: node ${path.join(SKILL_DIR, "scripts", "orch.mjs")} wait ${run.id}`,
    };
  };
  // A new start never runs uncounted because another start holds the lock: it waits up to 30 seconds,
  // or with --wait until its deadline (trying once more there), then refuses with exit 7. A
  // replacement waits three seconds and then starts without the lock.
  const busy = (reason) => {
    const error = new StartRefused(reason, 7);
    error.admissionKinds = ["lock"];
    throw error;
  };
  return () => admissionEnabled() ? withAdmissionLock(launch, replacement
    ? { deadline: Date.now() + 3000, cancel: args.admissionCancel }
    : { deadline: args.admissionDeadline ?? Date.now() + 30_000, cancel: args.admissionCancel, busy }) : launch();
}

// Refuse a start when the run has no free slot, or when `writes` and another task already writes
// in `cd`; --force overrides both.
function checkSlots(run, id, args, cd, { writes }) {
  let rows = listTasks(run);
  // A revive may adopt a relay that a dead resume left running: then look again before counting.
  if (reviveParked(run, rows.filter((t) => t.id !== id)).length) rows = listTasks(run);
  // A parked babysitter holds no agent, so it leaves its slot free; it still owns its checkout,
  // where only its own resume may write.
  const running = rows.filter((t) => t.state === "running" && t.phase !== "parked");
  const limit = Number(args["max-parallel"] || parallelAt(DEPTH));
  if (running.length >= limit && !args.force) {
    refuse(`${running.length} tasks already running (limit ${limit}); wait for one, or pass --force`);
  }
  const writersHere = rows.filter((t) => t.state === "running" && t.id !== id && (t.mode.startsWith("write") || t.mode.startsWith("babysit")) && path.resolve(t.cd || "") === cd);
  if (writes && writersHere.length && !args.force) {
    refuse(`task ${writersHere[0].id} is already writing in ${cd}; give this task its own worktree, or pass --force`);
  }
}

// The context window at which Claude Code auto-compacts a Claude agent's session. Left alone, a
// session with a 1M window compacts only near its end, so every call of a long session re-sends
// up to that much. AGENT_ORCH_CLAUDE_COMPACT_WINDOW sets it: 100k to 1M tokens (300000, 300k,
// 1m), default 300k; `off` leaves Claude Code's own default, and a bad value falls back to the
// default. A CLAUDE_CODE_AUTO_COMPACT_WINDOW the caller's environment (or agent-env.json) already
// sets is kept. Returns { env, record }: the variable for the relay, and what the attempt records.
export const COMPACT_DEFAULT = 300000;
export function compactWindow(env = process.env) {
  const own = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (own !== undefined && String(own).trim()) return { env: {}, record: { value: String(own).trim(), from: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" } };
  const setting = String(env.AGENT_ORCH_CLAUDE_COMPACT_WINDOW ?? "").trim();
  if (/^off$/i.test(setting)) return { env: {}, record: { value: null, from: "AGENT_ORCH_CLAUDE_COMPACT_WINDOW=off" } };
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(setting);
  const tokens = m ? Math.round(Number(m[1]) * ({ k: 1000, m: 1000000 }[(m[2] || "").toLowerCase()] || 1)) : null;
  const valid = tokens !== null && tokens >= 100000 && tokens <= 1000000;
  const value = String(valid ? tokens : COMPACT_DEFAULT);
  return { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: value }, record: { value, from: valid ? "AGENT_ORCH_CLAUDE_COMPACT_WINDOW" : "default" } };
}

// Relay arguments without the session they would resume.
function withoutSession(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume-last" || argv[i].startsWith("--session=")) continue;
    if (argv[i] === "--session") {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

// Refuses a start whose `--session` is a Claude session that a process still runs: a second process
// on it makes two processes write one session. The caller skips this while the task's own relay
// runs: the process on the session may be that relay's, and a start then is refused as "already
// running" anyway (a `--check` passes). It asks `claude agents --json`, and any
// failure of that, or an id that is not a session id (a name, a path), lets the start go on. A
// process that was told to end a moment ago, as an interrupt does, gets two seconds to go.
function refuseRunningSession(id, passthrough) {
  const wanted = sessionIdPrefix(sessionOf(passthrough));
  if (!wanted) return;
  let live = null;
  try {
    live = liveClaudeSession(wanted, { timeoutMs: 1900 });
    for (let waited = 0; live && waited < 2000 && processExists(live.pid); waited += 200) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    if (live && !processExists(live.pid)) live = null;
  } catch {
    live = null;
  }
  if (live) refuse(`cannot start ${id}: ${liveSessionReason(live)}`);
}

// The session id that relay arguments resume, or null.
function sessionOf(argv) {
  const at = argv.indexOf("--session");
  if (at >= 0) return argv[at + 1] || null;
  return argv.find((a) => a.startsWith("--session="))?.slice("--session=".length) || null;
}

// Appended to the brief of an implementer kept as babysitter whose large session continues because
// it has no current handoff note.
function implementerNoteLine(h) {
  return `\nYour session's latest call sent ${h.tokens} tokens, and every call re-sends all of it. Write your handoff note at \`${h.file}\` now, before you park: once it is written, your wakes may start a fresh session from your brief and that note. ${HANDOFF_RULES}\n`;
}

// The line `start` prints about a babysitter's tiers.
function babysitLine(watchTier, fixAttempt, tier) {
  if (!watchTier) return "";
  if (fixAttempt) return `\nnote: this is the babysitter's fix attempt; its next wake resumes at its watch tier, ${watchTier}`;
  return strongerThan({ agent: "claude", tier: BABYSIT_FIX_TIER }, { agent: "claude", tier })
    ? `\nnote: the babysitter watches at the ${watchTier} tier; a wake that needs a code fix ends with NEEDS FIX:, and its fix attempt runs at once at the ${BABYSIT_FIX_TIER} tier in the same session`
    : "";
}

// Record that the calling task started task `id` (attempt `attempt`) of `run`, so that it may park
// while that task runs (runs.mjs, parkBasis), and make sure its own finish watcher runs, which starts
// its park watcher then. Never fails the start.
function noteChild(run, id, attempt, startedBy) {
  try {
    const parentRun = runById(startedBy.run);
    const parent = parentRun && loadTask(parentRun, startedBy.task);
    if (!parent) return;
    recordChild(parentRun, parent.id, run, id, attempt);
    ensureFinishWatcher(parentRun, parent);
  } catch {}
}

// The user's extra environment for agents (agent-env.json), read before creating attempt
// artifacts. A broken optional file must not prevent work, and it cannot change the
// orchestrator's identity or execution setup.
export function readAgentEnv() {
  const envFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-orchestrator", "agent-env.json");
  const agentEnv = {};
  try {
    const values = JSON.parse(fs.readFileSync(envFile, "utf8"));
    if (!values || Array.isArray(values) || typeof values !== "object" || Object.entries(values).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !["string", "number", "boolean"].includes(typeof value) || String(value).includes("\0"))) throw new Error("expected a flat object of environment values");
    const reserved = new Set(["XDG_STATE_HOME", "HOME", "PATH", "NODE_OPTIONS"]);
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith("AGENT_ORCH_") || reserved.has(key)) process.stderr.write(`orch: ignoring reserved agent environment key ${key}\n`);
      else agentEnv[key] = String(value);
    }
    return agentEnv;
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`orch: ignoring agent environment ${envFile}: ${error instanceof SyntaxError ? "invalid JSON" : error.message}\n`);
    return {};
  }
}

// Refuse a start whose relay did not start, by either way (detach.mjs): nothing is recorded as
// started. When it is not known whether the relay started (`unknown`), the attempt's folder stays,
// since a relay that did start writes there.
function failedStart(id, outDir, error) {
  if (error.unknown) refuse(`task ${id}: ${error.message}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  refuse(`task ${id} did not start: ${error.message}`);
}

// Start a relay detached, in its own process group (on macOS through launchd, outside the terminal
// application; detach.mjs), writing its output to the attempt's relay.log, with the variables that
// link what it runs to the task. Returns { pid, launch }: its PID, and how it started, which the
// task records for its attempt. Throws when it could not start.
function spawnRelay(run, id, relay, relayArgs, outDir, cd, env) {
  const log = path.join(outDir, "relay.log");
  return startDetached({
    command: process.execPath,
    args: [relay, ...relayArgs],
    cwd: cd,
    near: [run.repo],
    stdout: log,
    env: {
      ...process.env,
      ...env,
      AGENT_ORCH_HEAVY_ACTIVE: undefined, // A new agent needs its own heavy admissions.
      AGENT_ORCH_DEPTH: String(DEPTH + 1),
      AGENT_ORCH_RUN: run.id,
      AGENT_ORCH_TASK: id,
    },
  });
}

// Start a command task: COMMAND_RELAY runs the words after `--` as an argument vector, with no
// shell and no model, and writes the files a delegate relay writes (relay.log, events.jsonl,
// result.json). It has no session: each start runs the command again, as a new attempt. It counts
// as read-only, since its work is never committed: `accept` takes it as it is, and it does not
// claim its folder as a writer. Its environment links any agent it starts to the task.
function startCommand(run, id, args, extra) {
  const prev = loadTask(run, id) || { id, createdAt: new Date().toISOString() };
  try {
    modelFor(COMMAND_AGENT, args); // refuses --tier, --model and --effort
  } catch (error) {
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
  const agentEnv = readAgentEnv();
  const inheritedEnv = { ...process.env, ...agentEnv };
  let maxTier, defaults;
  try {
    const own = callerTier();
    maxTier = lowerCeiling(args["max-tier"] ?? prev.maxTier, process.env.AGENT_ORCH_MAX_TIER, callerCeiling(own));
    defaults = ceilingEnv(maxTier, inheritedEnv);
    if (own?.effort) defaults = ceilingEnv(maxTier, {
      ...inheritedEnv,
      AGENT_ORCH_MAX_EFFORT: lowerEffort(defaults.AGENT_ORCH_MAX_EFFORT, own.effort),
    });
  } catch (error) {
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
  const { argv, done, timeout, reused } = commandOf(args, prev);
  if (relayAlive(prev.pid, null, prev.outDir)) refuse(`task ${id} is already running (pid ${prev.pid})`);
  const cd = path.resolve(args.cd || prev.cd || run.repo);
  if (!fs.existsSync(cd)) refuse(missingDirectory(run, id, prev, cd));
  const sameAgent = Boolean(prev.attempt && prev.agent === COMMAND_AGENT);
  const line = commandText(argv);
  const why =
    String(args.why ?? "").replace(/\s+/g, " ").trim() ||
    (sameAgent ? prev.why : null) ||
    refuse("--why is required: one line on why this work runs as a command with no model watching it (see SKILL.md, \"Choose the agent and model\")", 2);
  checkSlots(run, id, args, cd, { writes: false });
  // Running it again claims what startTask claims, so two starts never both run: the park of a
  // parked task, whose watcher may be resuming it, or else the attempt it replaces.
  const claim = args.parkClaim || claimParked(run, prev, "start") || resumeLock(run, prev, extra.attemptReason === "retry" ? "retry" : "start");
  if (claim?.refused) refuse(claim.refused);
  const since = claim?.since || prev;
  const attempt = (prev.attempt || 0) + 1;
  const lastRound = prev.attempt ? reviewRoundsOf(run, id).at(-1) : null;
  const attemptReason = extra.attemptReason
    || (!prev.attempt ? "first" : lastRound?.verdict === "changes" && lastRound.attempt === prev.attempt ? "rework" : "resume");
  const outDir = path.join(taskDir(run, id), `attempt-${attempt}`);
  fs.mkdirSync(outDir, { recursive: true });
  const relayArgs = ["--out-dir", outDir, "--cd", cd, ...(done !== null ? ["--done", done] : []), ...(timeout !== null ? ["--timeout", timeout] : []), "--", ...argv];

  const startedBy = startedByCaller(run, id);
  const task = {
    ...prev,
    agent: COMMAND_AGENT,
    tier: null,
    model: null,
    effort: null,
    why,
    attemptAgents: { ...(prev.attemptAgents || {}), [attempt]: COMMAND_AGENT },
    attemptReason,
    attemptReasons: { ...(prev.attemptReasons || {}), [attempt]: attemptReason },
    // The row's title is the command, unless --title names it.
    title: args.title ?? (sameAgent && reused ? prev.title : null) ?? line,
    command: argv,
    maxTier,
    doneMarker: done,
    commandTimeout: timeout,
    relay: COMMAND_RELAY,
    cd,
    readOnly: true,
    offline: false,
    babysit: false,
    sandboxRequested: false,
    confine: false,
    noPublish: false,
    sandboxed: false,
    pr: null,
    closedAt: null,
    stoppedAt: null, // a start by hand opens a closed or stopped task again
    network: "on",
    attempt,
    outDir,
    pid: null, // set once the relay starts
    argv: relayArgs,
    startedAt: new Date().toISOString(),
    startDepth: DEPTH,
    startedBy,
    attemptStartedBy: { ...(prev.attemptStartedBy || {}), [attempt]: startedBy },
    resumedBy: null,
    ...extra,
  };
  const ended = claim ? endedSince(since, loadTask(run, id)) : null;
  if (ended) {
    claim.release();
    fs.rmSync(outDir, { recursive: true, force: true });
    refuse(`task ${id} was ${ended.closedAt ? "closed" : "stopped"} while it was starting again, so it started nothing`);
  }
  let started;
  try {
    started = spawnRelay(run, id, COMMAND_RELAY, relayArgs, outDir, cd, { ...agentEnv, ...defaults });
  } catch (error) {
    claim?.release();
    failedStart(id, outDir, error);
  }
  task.pid = started.pid;
  task.launch = started.launch;
  claim?.spawned?.(task);
  if (claim) Object.assign(task, endedSince(since, loadTask(run, id)) || {});
  saveTask(run, task);
  claim?.done(task);
  if (startedBy) watchForFinish(run, task);
  if (startedBy) noteChild(run, id, attempt, startedBy);
  const opts = [done !== null ? `done marker ${JSON.stringify(done)}` : null, timeout !== null ? `timeout ${timeout}` : null].filter(Boolean);
  return {
    task,
    text: `started ${id} → command (no model${opts.length ? `, ${opts.join(", ")}` : ""}) pid ${started.pid}, attempt ${attempt}\n  run: ${line}\n  why: ${why}\n  cd:  ${cd}\n  out: ${outDir}\nnext: node ${path.join(SKILL_DIR, "scripts", "orch.mjs")} wait ${run.id}`,
  };
}
