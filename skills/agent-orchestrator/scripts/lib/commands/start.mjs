// `start`: launch a task's relay in the background, with the policy's model and the task's permissions.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENTS, CLI_PATH, DEPTH, MAX_NEST_DEPTH, SKILL_DIR, SKILL_ROOTS, parallelAt } from "../config.mjs";
import { decisionNote, nestingNote, publishHoldNote } from "../briefs.mjs";
import { runById, startedByCaller, watchForFinish } from "../finish-notice.mjs";
import { inboxNote } from "../inbox.mjs";
import { claimParked, keptEnd, reviveParked } from "../park.mjs";
import { reviewRoundsOf, verificationsOf } from "../lifecycle.mjs";
import { ghJson } from "../github.mjs";
import { guard, recordChange } from "../ownership.mjs";
import { gitHttpsEnv, relaySafetyArgs } from "../permissions.mjs";
import { CLAUDE_DEFAULT_TIER, COMMAND_AGENT, ModelRefused, lowerEffort, callerCeiling, ceilingEnv, ceilingFor, lowerCeiling, modelFor, strongerThan, tierOrder, tierText } from "../policy.mjs";
import { attemptAgent, commandText, describe, listTasks, loadRun, loadTask, relayAlive, saveTask, taskDir, validTask } from "../runs.mjs";
import { die, emit, findRelay } from "../util.mjs";

// A refused start. `dispatch` reports it and goes on with its other tasks; `start` exits with it.
export class StartRefused extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function refuse(message, code) {
  throw new StartRefused(message, code);
}

// Whether a task's latest attempt failed its review or its gates: its last review round says
// `changes` or `reject`, the coordinator's last `verify` run of a gate failed, or the agent
// reported a failing check.
function attemptFailed(run, task) {
  const n = task.attempt;
  const rounds = reviewRoundsOf(run, task.id).filter((r) => r.attempt === n);
  if (["changes", "reject"].includes(rounds.at(-1)?.verdict)) return true;
  const lastRun = new Map();
  for (const v of verificationsOf(run, task.id)) if (v.attempt === n) lastRun.set(v.cmd, v);
  if ([...lastRun.values()].some((v) => v.passed === false)) return true;
  return Boolean(describe(run, task).report?.checks?.some((check) => check?.result === "fail"));
}

// A lighter-tier result that failed is redone one tier up, never at the same tier (SKILL.md,
// "Choose the agent and model"). A hint naming the next tier, when this start does not go above
// the failed attempt's tier; otherwise null.
function escalationNote(run, prev, key, prevTier, tier) {
  if (!prevTier) return null;
  const order = tierOrder(key);
  const at = order.indexOf(prevTier);
  if (at < 0 || at === order.length - 1 || order.indexOf(tier) > at || !attemptFailed(run, prev)) return null;
  return `attempt ${prev.attempt} at the ${prevTier} tier failed its review or gates; redo it one tier up, with --tier ${order[at + 1]} and a new --why`;
}

// `start` from the command line, where only the run's owner may start or resume its tasks; the park
// watcher and `wait`'s retries resume a task through startTask() itself.
export function cmdStart(args) {
  try {
    const run = loadRun(args._[0]);
    const prev = args._[1] ? loadTask(run, validTask(args._[1])) : null;
    const resume = Boolean(prev?.attempt);
    const g = guard(run, resume ? `resume task ${prev.id} of run ${run.id}` : `start a task in run ${run.id}`, { adopt: args.adopt, refused: prev ? [prev.id] : [] });
    const { task, text } = startTask(args, resume ? { resumedBy: g.actor } : {});
    if (resume) recordChange(run, g, { task: task.id, attempt: task.attempt, action: "resumed" });
    emit(args, task, text);
  } catch (error) {
    if (error instanceof StartRefused) die(error.message, error.code);
    throw error;
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
// tier is fixed by policy, so only an inherited ceiling is checked for it.
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

// Start one task from parsed `start` arguments; `dispatch` calls it too. `extra` holds fields to
// record in the task, such as its plan entry. Returns the saved task and the text `start` prints.
export function startTask(args, extra = {}) {
  if (DEPTH >= MAX_NEST_DEPTH && !args["allow-nested"]) {
    refuse(`refusing to dispatch: this agent is ${DEPTH} levels below the user's session, the most allowed (AGENT_ORCH_MAX_DEPTH=${MAX_NEST_DEPTH}); do the work yourself`);
  }
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const key = args.agent || refuse("--agent is required (see: node orch.mjs agents)", 2);
  if (key === COMMAND_AGENT) return startCommand(run, id, args, extra);
  if (!AGENTS[key]) refuse(`unsupported agent "${key}" (choose: ${Object.keys(AGENTS).join(", ")}, or ${COMMAND_AGENT} to run a command with no model)`, 2);
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
  const relay = findRelay(key) || refuse(`no ${key}-delegate relay found in: ${SKILL_ROOTS.join(", ")}`);

  const prev = loadTask(run, id) || { id, createdAt: new Date().toISOString() };
  const sameAgent = Boolean(prev.attempt && prev.agent === key);
  const babysit = Boolean(args.babysit || (sameAgent && prev.babysit));
  // A new task needs --tier (modelFor refuses it without). A Claude follow-up keeps the earlier
  // attempt's tier unless --tier is given; Claude tasks recorded before Claude had tiers ran
  // `complex`. A babysitter always runs `complex`, and --babysit implies it.
  const prevTier = sameAgent ? prev.tier || (key === "claude" ? CLAUDE_DEFAULT_TIER : null) : null;
  const tierArgs = babysit && key === "claude" ? { ...args, tier: args.tier || CLAUDE_DEFAULT_TIER } : args;
  let choice;
  try {
    choice = modelFor(key, tierArgs, babysit ? null : prevTier);
  } catch (error) {
    // A refused start, not an exit: `dispatch` goes on with its other tasks.
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
  const { tier, model, effort } = choice;
  refuseStronger(key, tier, babysit);
  if (relayAlive(prev.pid)) refuse(`task ${id} is already running (pid ${prev.pid})`);
  const cd = path.resolve(args.cd || prev.cd || run.repo);
  if (!fs.existsSync(cd)) refuse(`--cd does not exist: ${cd}`);
  // The orchestrator chooses the agent and tier by assessing the task; record why. A follow-up
  // attempt with the same agent and tier keeps the earlier reason unless a new one is given.
  const keepsChoice = sameAgent && prevTier === tier;
  // --offline carries over to follow-up attempts by the same agent.
  const offline = Boolean(args.offline || (sameAgent && prev.offline));
  if (babysit && key !== "claude") refuse("pull-request babysitting runs on Claude, which costs less of the user's limits than Codex (SKILL.md step 8)", 2);
  if (babysit && tier !== CLAUDE_DEFAULT_TIER) refuse(`a babysitter always runs the ${CLAUDE_DEFAULT_TIER} tier, since it fixes review feedback and CI on a live pull request; drop --tier ${tier}`, 2);
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
  const net = relaySafetyArgs({ key, relay, cd, readOnly: Boolean(args["read-only"]), offline, sandbox, confine, babysit, publish: !noPublish });
  const why =
    String(args.why ?? "").replace(/\s+/g, " ").trim() ||
    (keepsChoice ? prev.why : null) ||
    refuse(`--why is required: one line on why your assessment of this task picked ${key}${tier ? ` at the ${tier} tier` : ""} (see SKILL.md, "Choose the agent and model")`, 2);
  const sharesRepo = !prev.worktree && path.resolve(cd) === path.resolve(run.repo);

  checkSlots(run, id, args, cd, { writes: !args["read-only"] });
  const agentEnv = readAgentEnv();

  // Resuming a parked babysitter ends its park, and exactly one resume (its watcher's, which brings
  // its claim, or this one) may: claim it before writing anything, so a resume that loses changes nothing.
  const parkClaim = args.parkClaim || claimParked(run, prev, "start");
  if (parkClaim?.refused) refuse(parkClaim.refused);

  const attempt = (prev.attempt || 0) + 1;
  // Why this attempt starts: `retry` comes from retry.mjs; a `changes` verdict on the previous
  // attempt makes this one a rework.
  const lastRound = prev.attempt ? reviewRoundsOf(run, id).at(-1) : null;
  const attemptReason = extra.attemptReason
    || (!prev.attempt ? "first" : lastRound?.verdict === "changes" && lastRound.attempt === prev.attempt ? "rework" : "resume");
  // An automatic retry continues a turn cut off by a transient error: not a failed result.
  const escalation = attemptReason === "retry" ? null : escalationNote(run, prev, key, prevTier, tier);
  const outDir = path.join(taskDir(run, id), `attempt-${attempt}`);
  const brief = path.join(outDir, "orch-brief.md");
  // A task that can start agents (it writes, reaches the network, and runs outside the sandbox) is
  // told to hand slow side work to them. That includes babysitters, which run tests and fixes.
  const childDepth = DEPTH + 1;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(briefSource, brief);
    if (!args["read-only"] && !offline && !sandbox && childDepth < MAX_NEST_DEPTH) {
      fs.appendFileSync(brief, nestingNote(childDepth));
    }
    if (noPublish && !args["read-only"]) fs.appendFileSync(brief, publishHoldNote());
    fs.appendFileSync(brief, decisionNote(babysit) + inboxNote(run, id, key));
    // Files the brief points to, such as the messages a parked task's watcher delivers in full.
    for (const [name, text] of Object.entries(args.attemptFiles || {})) fs.writeFileSync(path.join(outDir, path.basename(name)), text);
  } catch (error) {
    parkClaim?.release();
    throw error;
  }

  const relayArgs = ["--brief", brief, "--cd", cd, "--out-dir", outDir];
  if (args["read-only"]) relayArgs.push("--read-only");
  if (args.timeout || babysit) relayArgs.push("--timeout", args.timeout || "24h");
  // A tier without an effort runs at the CLI's default for its model.
  relayArgs.push("--model", model, ...(effort ? ["--effort", effort] : []));
  relayArgs.push(...net.args);
  relayArgs.push(...args.passthrough);

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
    sandboxed: net.sandboxed,
    pr,
    closedAt: null,
    stoppedAt: null, // a start by hand opens a closed or stopped task again; a park resume keeps both
    network: net.network,
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
    ...extra,
  };
  // A close or stop that came while this resume was starting wins: start nothing.
  if (parkClaim) {
    const latest = loadTask(run, id);
    if (latest?.closedAt || latest?.stoppedAt) {
      parkClaim.release();
      fs.rmSync(outDir, { recursive: true, force: true });
      refuse(`task ${id} was ${latest.closedAt ? "closed" : "stopped"} while this resume was starting, so it started nothing`);
    }
  }
  let child;
  try {
    child = spawnRelay(run, id, relay, relayArgs, outDir, cd, { ...agentEnv, ...(net.httpsGit ? gitHttpsEnv(process.env) : {}) });
  } catch (error) {
    parkClaim?.release();
    throw error;
  }
  task.pid = child.pid;
  // First of all, record the relay: a resume that dies now leaves it for the next claimant to adopt.
  parkClaim?.spawned?.(task);
  // A resume never clears a close or stop that came while it started.
  if (parkClaim) Object.assign(task, keptEnd(loadTask(run, id)));
  saveTask(run, task);
  parkClaim?.done(task);
  // Started once the record is saved, so the watcher always reads this attempt. A babysitter always
  // gets one: when its attempt ends parked, the watcher starts its park watcher (park.mjs).
  if (startedBy || babysit) watchForFinish(run, task);
  const warn =
    sharesRepo && !args["read-only"] ? "\nnote: writing in the main checkout; use a worktree when other tasks write in parallel" : "";
  return {
    task,
    text: `started ${id} → ${key} ${model} (${effort ? `effort ${effort}` : "default effort"}${tier ? `, ${tier} tier` : ""}, ${task.readOnly ? "read-only" : "write"}${babysit ? ", babysitter: may commit and push" : task.readOnly ? "" : noPublish || net.sandboxed ? ", does not publish" : ", may commit and push"}${task.readOnly ? "" : net.sandboxed ? (net.network === "on" ? ", sandboxed, network on" : ", sandboxed, offline") : ", no sandbox"}) pid ${child.pid}, attempt ${attempt}\n  why: ${why}\n  cd:  ${cd}\n  out: ${outDir}${warn}${net.note ? `\nnote: ${net.note}` : ""}${escalation ? `\nnote: ${escalation}` : ""}\nnext: node ${path.join(SKILL_DIR, "scripts", "orch.mjs")} wait ${run.id}`,
  };
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

// The user's extra environment for agents (agent-env.json), read before creating attempt
// artifacts. A broken optional file must not prevent work, and it cannot change the
// orchestrator's identity or execution setup.
function readAgentEnv() {
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

// Start a relay detached, in its own process group, writing its output to the attempt's relay.log,
// with the variables that link what it runs to the task. Returns the child process.
function spawnRelay(run, id, relay, relayArgs, outDir, cd, env) {
  const log = fs.openSync(path.join(outDir, "relay.log"), "a");
  try {
    const child = spawn(process.execPath, [relay, ...relayArgs], {
      cwd: cd,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ...env,
        AGENT_ORCH_HEAVY_ACTIVE: undefined, // A new agent needs its own heavy admissions.
        AGENT_ORCH_DEPTH: String(DEPTH + 1),
        AGENT_ORCH_RUN: run.id,
        AGENT_ORCH_TASK: id,
      },
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
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
  let maxTier, defaults;
  try {
    const own = callerTier();
    maxTier = lowerCeiling(args["max-tier"] ?? prev.maxTier, process.env.AGENT_ORCH_MAX_TIER, callerCeiling(own));
    defaults = ceilingEnv(maxTier);
    if (own?.effort) defaults = ceilingEnv(maxTier, {
      ...process.env,
      AGENT_ORCH_MAX_EFFORT: lowerEffort(defaults.AGENT_ORCH_MAX_EFFORT, own.effort),
    });
  } catch (error) {
    if (error instanceof ModelRefused) refuse(error.message, error.code);
    throw error;
  }
  const { argv, done, timeout, reused } = commandOf(args, prev);
  if (relayAlive(prev.pid)) refuse(`task ${id} is already running (pid ${prev.pid})`);
  const cd = path.resolve(args.cd || prev.cd || run.repo);
  if (!fs.existsSync(cd)) refuse(`--cd does not exist: ${cd}`);
  const sameAgent = Boolean(prev.attempt && prev.agent === COMMAND_AGENT);
  const line = commandText(argv);
  const why =
    String(args.why ?? "").replace(/\s+/g, " ").trim() ||
    (sameAgent ? prev.why : null) ||
    refuse("--why is required: one line on why this work runs as a command with no model watching it (see SKILL.md, \"Choose the agent and model\")", 2);
  checkSlots(run, id, args, cd, { writes: false });
  const agentEnv = readAgentEnv();

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
  const child = spawnRelay(run, id, COMMAND_RELAY, relayArgs, outDir, cd, { ...agentEnv, ...defaults });
  task.pid = child.pid;
  saveTask(run, task);
  if (startedBy) watchForFinish(run, task);
  const opts = [done !== null ? `done marker ${JSON.stringify(done)}` : null, timeout !== null ? `timeout ${timeout}` : null].filter(Boolean);
  return {
    task,
    text: `started ${id} → command (no model${opts.length ? `, ${opts.join(", ")}` : ""}) pid ${child.pid}, attempt ${attempt}\n  run: ${line}\n  why: ${why}\n  cd:  ${cd}\n  out: ${outDir}\nnext: node ${path.join(SKILL_DIR, "scripts", "orch.mjs")} wait ${run.id}`,
  };
}
