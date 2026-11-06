// `start`: launch a task's relay in the background, with the policy's model and the task's permissions.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, DEPTH, MAX_NEST_DEPTH, SKILL_DIR, SKILL_ROOTS, parallelAt } from "../config.mjs";
import { decisionNote, nestingNote, publishHoldNote } from "../briefs.mjs";
import { inboxNote } from "../inbox.mjs";
import { reviewRoundsOf, verificationsOf } from "../lifecycle.mjs";
import { ghJson } from "../github.mjs";
import { gitHttpsEnv, relaySafetyArgs } from "../permissions.mjs";
import { CLAUDE_DEFAULT_TIER, ModelRefused, modelFor, tierOrder } from "../policy.mjs";
import { describe, listTasks, loadRun, loadTask, relayAlive, saveTask, taskDir, validTask } from "../runs.mjs";
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

export function cmdStart(args) {
  try {
    const { task, text } = startTask(args);
    emit(args, task, text);
  } catch (error) {
    if (error instanceof StartRefused) die(error.message, error.code);
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
  if (!AGENTS[key]) refuse(`unsupported agent "${key}" (choose: ${Object.keys(AGENTS).join(", ")})`, 2);
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
  // A write task publishes (commits, pushes, writes to GitHub) unless the user said to review its
  // work first: --no-publish, which carries over to follow-up attempts.
  const noPublish = Boolean(args["no-publish"] || (prev.attempt && prev.noPublish));
  const net = relaySafetyArgs({ key, relay, cd, readOnly: Boolean(args["read-only"]), offline, sandbox, babysit, publish: !noPublish });
  const why =
    String(args.why ?? "").replace(/\s+/g, " ").trim() ||
    (keepsChoice ? prev.why : null) ||
    refuse(`--why is required: one line on why your assessment of this task picked ${key}${tier ? ` at the ${tier} tier` : ""} (see SKILL.md, "Choose the agent and model")`, 2);
  const sharesRepo = !prev.worktree && path.resolve(cd) === path.resolve(run.repo);

  const running = listTasks(run).filter((t) => t.state === "running");
  const limit = Number(args["max-parallel"] || parallelAt(DEPTH));
  if (running.length >= limit && !args.force) {
    refuse(`${running.length} tasks already running (limit ${limit}); wait for one, or pass --force`);
  }
  const writersHere = running.filter((t) => (t.mode.startsWith("write") || t.mode.startsWith("babysit")) && path.resolve(t.cd || "") === cd);
  if (!args["read-only"] && writersHere.length && !args.force) {
    refuse(`task ${writersHere[0].id} is already writing in ${cd}; give this task its own worktree, or pass --force`);
  }

  const attempt = (prev.attempt || 0) + 1;
  // Why this attempt starts: `retry` comes from retry.mjs; a `changes` verdict on the previous
  // attempt makes this one a rework.
  const lastRound = prev.attempt ? reviewRoundsOf(run, id).at(-1) : null;
  const attemptReason = extra.attemptReason
    || (!prev.attempt ? "first" : lastRound?.verdict === "changes" && lastRound.attempt === prev.attempt ? "rework" : "resume");
  // An automatic retry continues a turn cut off by a transient error: not a failed result.
  const escalation = attemptReason === "retry" ? null : escalationNote(run, prev, key, prevTier, tier);
  const outDir = path.join(taskDir(run, id), `attempt-${attempt}`);
  fs.mkdirSync(outDir, { recursive: true });
  const brief = path.join(outDir, "orch-brief.md");
  fs.copyFileSync(briefSource, brief);
  // A task that can start agents (it writes, reaches the network, and runs outside the sandbox) is
  // told to hand slow side work to them. That includes babysitters, which run tests and fixes.
  const childDepth = DEPTH + 1;
  if (!args["read-only"] && !offline && !sandbox && childDepth < MAX_NEST_DEPTH) {
    fs.appendFileSync(brief, nestingNote(childDepth));
  }
  if (noPublish && !args["read-only"]) fs.appendFileSync(brief, publishHoldNote());
  fs.appendFileSync(brief, decisionNote(babysit) + inboxNote(run, id, key));

  const relayArgs = ["--brief", brief, "--cd", cd, "--out-dir", outDir];
  if (args["read-only"]) relayArgs.push("--read-only");
  if (args.timeout || babysit) relayArgs.push("--timeout", args.timeout || "24h");
  // A tier without an effort runs at the CLI's default for its model.
  relayArgs.push("--model", model, ...(effort ? ["--effort", effort] : []));
  relayArgs.push(...net.args);
  relayArgs.push(...args.passthrough);

  const logPath = path.join(outDir, "relay.log");
  const log = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [relay, ...relayArgs], {
    cwd: cd,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      ...(net.httpsGit ? gitHttpsEnv(process.env) : {}),
      AGENT_ORCH_DEPTH: String(DEPTH + 1),
      AGENT_ORCH_RUN: run.id,
      AGENT_ORCH_TASK: id,
    },
  });
  child.unref();
  fs.closeSync(log);

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
    noPublish,
    sandboxed: net.sandboxed,
    pr,
    closedAt: null,
    network: net.network,
    attempt,
    outDir,
    pid: child.pid,
    argv: relayArgs,
    startedAt: new Date().toISOString(),
    ...extra,
  };
  saveTask(run, task);
  const warn =
    sharesRepo && !args["read-only"] ? "\nnote: writing in the main checkout; use a worktree when other tasks write in parallel" : "";
  return {
    task,
    text: `started ${id} → ${key} ${model} (${effort ? `effort ${effort}` : "default effort"}${tier ? `, ${tier} tier` : ""}, ${task.readOnly ? "read-only" : "write"}${babysit ? ", babysitter: may commit and push" : task.readOnly ? "" : noPublish || net.sandboxed ? ", does not publish" : ", may commit and push"}${task.readOnly ? "" : net.sandboxed ? (net.network === "on" ? ", sandboxed, network on" : ", sandboxed, offline") : ", no sandbox"}) pid ${child.pid}, attempt ${attempt}\n  why: ${why}\n  cd:  ${cd}\n  out: ${outDir}${warn}${net.note ? `\nnote: ${net.note}` : ""}${escalation ? `\nnote: ${escalation}` : ""}\nnext: node ${path.join(SKILL_DIR, "scripts", "orch.mjs")} wait ${run.id}`,
  };
}
