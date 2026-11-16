// Parking: a task with nothing to do but wait ends its turn "parked" (its final message starts with
// `PARKED:`; runs.mjs, parkedOf), so its relay and agent exit and free their memory. A small
// detached watcher then keeps an eye on what it waits for and on the task's inbox, and resumes the
// same session with a short brief on the first actionable event. A pull-request babysitter waits
// for its pull request. Any other Claude or Codex task waits for the wake condition it recorded with
// `park-until` (park-until.json in the attempt's folder: a command the watcher runs every interval,
// in the task's folder and environment, until it exits 0, cannot run, or the longest wait passes),
// or for the tasks it started, whose finish notices reach its inbox.
//
// The watcher is a /bin/sh loop (PARK_SCRIPT): it costs a shell and a `sleep`, about 3 MB. Every few
// seconds it compares the size of the task's inbox with the last size it saw; when the inbox grows,
// and otherwise once per interval (AGENT_ORCH_PARK_INTERVAL, default 60s), it runs this file's
// `check`, a short Node process (about 50 MB for a second or two) that reads the pull request with
// the same snapshot and comparison as `pr-watch`, reads the unread messages, and resumes the task
// when either has something. All the waiting is done here, with no model: the babysitter's own
// `pr-watch` returns at once, and a change that needs no judgment (the checks went green and nothing
// else is open; pr-watch.mjs, quietItems) is recorded as seen without waking anyone. A resume's
// brief states what changed and the pull request's state now, and the watcher records that state as
// seen, so the resumed session acts on the items without reading the pull request again. The
// A session's whole context is sent again on every call, so a babysitter that has fixed several
// review rounds pays for all of them on each later call. When the parked session's latest call was
// larger than AGENT_ORCH_BABYSIT_HANDOFF_TOKENS (default 150000) and the babysitter updated its
// handoff note (handoff.md in the task's folder) in the attempt that parked, the resume starts a
// fresh session instead: the brief the babysitter first got, then the note, then what changed.
// When the resume's first call cannot read the prompt cache, the lower AGENT_ORCH_COLD_HANDOFF_TOKENS
// (default 60000) applies: the parked attempt ended longer ago than the cache lives
// (AGENT_ORCH_CACHE_TTL, default 1h, less 5 minutes), or the resume runs another model (a
// babysitter watches at its watch tier and fixes at complex, and each model has its own cache), so
// the whole context would be written to the cache again. Without a current note the same session
// resumes, told to write one: memory is never dropped without a note. The
// messages go, whole, into park-messages.md in the new attempt's folder (the brief quotes short
// ones), and only those are marked read.
//
// The finish watcher that runs beside a babysitter's relay, a delegated task's, and the relay of a
// task that recorded a wake condition or started tasks (finish-notice.mjs) starts the first
// watcher once the relay ends parked. Each parked attempt's folder keeps its watchers'
// records, park-watcher-<k>.json: the highest k is the current watcher, a new one is created only
// with an exclusive create, and a watcher that finds a newer one exits, so two watchers never act
// for one task. A park ends with a claim, park-claim-<k>.json, created whole and exclusively with
// the next k, naming its owner (PID and start time): exactly one resume (the watcher's or a `start`
// by hand), `stop` or `close` wins it, before writing anything else. A resume records the relay it
// starts in its claim at once. A claim whose owner died before saving the next attempt is abandoned:
// the next claimant adopts its relay when that still runs, and otherwise takes the park over.
// `stop` and `close` always win: they mark the task first, a resume checks for that just before it
// starts its relay and keeps it when it saves, and they stop a relay a resume started. A parked
// task whose watcher has died, after a reboot say, is restarted by `status`, `start` and the
// dashboard (reviveParked), cheaply enough to run on every poll of `wait`.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HANDOFF_RULES } from "./briefs.mjs";
import { CLI_PATH } from "./config.mjs";
import { startDetached } from "./detach.mjs";
import { durationText, shortText } from "./format.mjs";
import { INBOX_FILE, fromAgent, markRead, readInbox, replyHint, senderLabel } from "./inbox.mjs";
import { sendFinishNotice, watchForFinish } from "./finish-notice.mjs";
import { BABYSIT_WATCH_TIER, lowerCeiling, lowerEffort, readPolicy } from "./policy.mjs";
import { PARK_CHECK_FILE, PARK_UNTIL_FILE, attemptAgent, commandText, exists, isBabysitter, isParked, lateNotices, loadTask, parkClaim, parkClaimFile, parkProcessTable, parkWatcher, parkWatcherAlive, parkWatcherFile, parkedOf, processStarted, relayAlive, saveTask, taskDir } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";
import { aheadOfPr, quietItems, readSeen, recordSeen, rememberQueue, stateLine, watchAttention, watchSnapshot } from "./commands/pr-watch.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const LOG = "park-watcher.log";
// The messages a resume delivers, in full, in the new attempt's folder.
export const PARK_MESSAGES_FILE = "park-messages.md";
// A babysitter's handoff note, and the brief its first session was given, both in the task's folder.
export const HANDOFF_FILE = "handoff.md";
export const BABYSIT_BRIEF_FILE = "babysit-brief.md";
// Messages up to this long are also quoted in the resume brief.
const INLINE_CHARS = 1500;
// What `check` exits with to end the watcher's loop: the park is over (resumed, stopped, closed,
// replaced by a newer watcher, or the task is gone). 0 means keep watching.
const DONE = 3;

// The shell loop. $1 is Node, $2 this file, $3 the parked attempt's folder, $4 the watcher's
// generation, $5 the task's inbox file, $6 the seconds between checks, $7 the seconds per step.
// It runs `check` at once, whenever the inbox grows, and every $6 seconds; `check` exiting 3 (or
// Node missing) ends it, and 30 failed checks in a row end it too.
export const PARK_SCRIPT = 'n=0; size=-; fails=0; while :; do now=$(wc -c 2>/dev/null < "$5"); if [ "$n" -le 0 ] || [ "$now" != "$size" ]; then size=$now; "$1" "$2" check "$3" "$4"; rc=$?; case $rc in 0) fails=0 ;; 3|126|127) exit 0 ;; *) fails=$((fails+1)); [ "$fails" -lt 30 ] || exit 1 ;; esac; n=$6; fi; sleep "$7"; n=$((n-$7)); done';

// Seconds between the watcher's checks: AGENT_ORCH_PARK_INTERVAL (90s, 2m, ...), default 60s, at
// least 1s. A bad value falls back to the default rather than stopping the caller (the dashboard).
export function parkInterval(value = process.env.AGENT_ORCH_PARK_INTERVAL) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? "").trim());
  const ms = m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"] : 60000;
  return Math.max(1, Math.round(ms / 1000));
}

// The context size above which a parked babysitter resumes in a fresh session:
// AGENT_ORCH_BABYSIT_HANDOFF_TOKENS, a whole number of tokens, default 150000.
export function handoffLimit(value = process.env.AGENT_ORCH_BABYSIT_HANDOFF_TOKENS) {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : 150000;
}

// The same limit when the resume's first call cannot read the prompt cache (coldResume):
// AGENT_ORCH_COLD_HANDOFF_TOKENS, default 60000. That call writes the whole context to the cache
// again, which costs more than reading it, so a smaller session is worth handing off.
export function coldHandoffLimit(value = process.env.AGENT_ORCH_COLD_HANDOFF_TOKENS) {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : 60000;
}

// How long a session's prompt cache lives, less a margin: AGENT_ORCH_CACHE_TTL (90m, 1h, ...),
// default 1h, less 5 minutes. A bad value falls back to the default.
export function cacheWarmMs(value = process.env.AGENT_ORCH_CACHE_TTL) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? "").trim());
  const ttl = m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"] : 3600000;
  return Math.max(0, ttl - 5 * 60000);
}

// Whether resuming a session whose attempt ended at `endedAt` (ISO time), on `fromModel`, with
// `toModel` reads no prompt cache: { cold, why }, where why is "idle" (it ended longer ago than the
// cache lives), "model" (another model, which has its own cache), or null for a warm resume.
export function coldResume(endedAt, fromModel, toModel, now = Date.now()) {
  if (fromModel && toModel && fromModel !== toModel) return { cold: true, why: "model" };
  if (now - (Date.parse(endedAt) || now) > cacheWarmMs()) return { cold: true, why: "idle" };
  return { cold: false, why: null };
}

// The size of the latest model call of the session whose events are in `dir`: its input tokens,
// cached ones included, which is the context every further call would send again. Calls of
// sub-agents are not the session's. Null when the events show none.
export function lastCallTokens(dir) {
  let text;
  try {
    const file = path.join(dir, "events.jsonl");
    const size = fs.statSync(file).size;
    const tail = Math.min(size, 4 * 1024 * 1024); // the latest call is near the end
    const buffer = Buffer.alloc(tail);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, tail, size - tail);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const usage = event.type === "assistant" && !event.parent_tool_use_id ? event.message?.usage : null;
    if (usage) return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  }
  return null;
}

// The brief a babysitter's first session was given: the copy `start` kept, or, for a task started
// before `start` kept one, its first attempt's whole brief. That one ends with the notes `start`
// appended, which the fresh session's brief then holds twice: a repeated note costs little, and
// cutting them off could cut an instruction of the brief itself.
export function originalBrief(dir) {
  for (const file of [path.join(dir, BABYSIT_BRIEF_FILE), path.join(dir, "attempt-1", "orch-brief.md")]) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {}
  }
  return "";
}

// A task's handoff note: { file, text, note: "current" | "stale" | "missing" }. Current when it
// was written or updated since `since` (the start of the attempt that ended), and nonempty.
export function handoffNoteOf(run, task, since = task.startedAt) {
  const file = path.join(taskDir(run, task.id), HANDOFF_FILE);
  let text = "", note = "missing";
  try {
    text = fs.readFileSync(file, "utf8");
    if (text.trim()) note = fs.statSync(file).mtimeMs >= Date.parse(since) ? "current" : "stale";
  } catch {}
  return { file, text, note };
}

// Whether a parked attempt (folder `dir`) should resume in a fresh session: { file, tokens, limit,
// cold, coldWhy, note: "current" | "stale" | "missing", fresh, original, text }. Fresh only when
// the session's latest call was above the limit (the cold one when `cold`, coldResume), the note
// was written or updated since the parked attempt started, and the brief the babysitter first got
// was kept (or `original` is given); `original` and `text` hold that brief and the note then.
export function handoffOf(run, task, dir, { cold = false, coldWhy = null, original: given = null } = {}) {
  const { file, text, note } = handoffNoteOf(run, task);
  const tokens = lastCallTokens(dir);
  const limit = cold ? coldHandoffLimit() : handoffLimit();
  const original = given ?? originalBrief(taskDir(run, task.id));
  // A note that holds an unfilled brief marker would make `start` refuse the brief.
  const fresh = tokens !== null && tokens > limit && note === "current" && Boolean(original.trim()) && !/<fill in:/.test(text);
  return { file, tokens, limit, cold, coldWhy: cold ? coldWhy : null, note, fresh, original: fresh ? original : null, text: fresh ? text : null };
}

// What a task's record keeps about an attempt that began a fresh session from a handoff note:
// which attempt it took over from, the context size and the limit that applied (warm or cold, and
// why it was cold), and when.
export const handoffRecord = (handoff, fromAttempt, at, extra = {}) => ({
  fromAttempt, contextTokens: handoff.tokens, limit: handoff.limit, limitKind: handoff.cold ? "cold" : "warm",
  ...(handoff.coldWhy ? { coldWhy: handoff.coldWhy } : {}), at, ...extra,
});

// What a task's record keeps about every handoff decision (handoffChecks), fresh or not: the size of
// the session's latest call, the limit that applied (warm or cold, and why cold), the note's state,
// and whether a fresh session started.
export const handoffCheck = (handoff) => ({
  contextTokens: handoff.tokens, limit: handoff.limit, limitKind: handoff.cold ? "cold" : "warm",
  ...(handoff.coldWhy ? { coldWhy: handoff.coldWhy } : {}), note: handoff.note, fresh: Boolean(handoff.fresh),
});

// Why a fresh session started, in a few words, for its brief and for `result`.
export function handoffWhy(handoff) {
  const size = `its context had grown to ${handoff.tokens} tokens`;
  if (!handoff.cold) return `${size}, which every further call would have sent again`;
  return `${size}, and ${handoff.coldWhy === "model" ? "it would have resumed on another model, whose prompt cache holds none of it" : "it had waited longer than its prompt cache lives"}, so its first call would have written all of it to the cache again`;
}

// The brief of a fresh session that takes over from a parked one: the brief the babysitter first
// got, then its handoff note, then what changed (resumeBrief's text for a fresh session). `from`
// says whose session it takes over: an earlier babysitter session (`babysitter`, it parked), or the
// task's implementer that becomes the babysitter (`implementer`).
export function handoffBrief(handoff, changed, { from = "babysitter" } = {}) {
  const who = from === "implementer"
    ? "You take over this pull request, as its babysitter, from the session that implemented it:"
    : from === "watch"
      ? "You are the fix attempt of this babysitter, and take over from its watch session:"
      : "You take over from an earlier session of this babysitter. It parked;";
  return [
    handoff.original.trimEnd(),
    "",
    "---",
    "",
    "## Handoff note from your previous session",
    "",
    `${who} ${handoffWhy(handoff)}, so you start fresh. It left the note below: trust it for everything that happened so far, and keep it current at \`${handoff.file}\` as your brief says.`,
    "",
    handoff.text.trim(),
    "",
    "---",
    "",
    changed,
  ].join("\n");
}

const attemptDir = (run, id, n) => path.join(taskDir(run, id), `attempt-${n}`);

// The environment the watcher, and the attempt it resumes, run in: the caller's, with the nesting
// variables of whoever started the parked attempt, so that the resumed attempt reports to the same
// parent at the same depth whether the finish watcher, `status` or the dashboard started the watcher.
export function parkEnv(task, base = process.env) {
  const env = { ...base };
  for (const key of ["AGENT_ORCH_DEPTH", "AGENT_ORCH_RUN", "AGENT_ORCH_TASK"]) delete env[key];
  const map = task.attemptStartedBy;
  const parent = map && Object.hasOwn(map, task.attempt) ? map[task.attempt] : task.startedBy || null;
  if (parent?.run && parent?.task) Object.assign(env, { AGENT_ORCH_RUN: parent.run, AGENT_ORCH_TASK: parent.task });
  const depth = Number.isInteger(task.startDepth) ? task.startDepth : parent ? 1 : 0;
  if (depth > 0) env.AGENT_ORCH_DEPTH = String(depth);
  return withCeiling(task, env);
}

// `env` with the model ceiling the task's attempt was started under (`start` records it as
// inheritedCeiling), so that whoever starts its watcher, the dashboard included, starts nothing
// above it: a fix attempt or a resume. A ceiling `env` holds already stays when it is lower.
export function withCeiling(task, env) {
  const kept = task?.inheritedCeiling;
  if (!kept?.maxTier && !kept?.maxEffort) return env;
  const out = { ...env };
  if (kept.maxTier) {
    try {
      out.AGENT_ORCH_MAX_TIER = lowerCeiling(kept.maxTier, env.AGENT_ORCH_MAX_TIER || null) || kept.maxTier;
    } catch {
      out.AGENT_ORCH_MAX_TIER = kept.maxTier; // an unreadable policy: keep the recorded ceiling
    }
  }
  if (kept.maxEffort) {
    try {
      out.AGENT_ORCH_MAX_EFFORT = env.AGENT_ORCH_MAX_EFFORT ? lowerEffort(env.AGENT_ORCH_MAX_EFFORT, kept.maxEffort) : kept.maxEffort;
    } catch {
      out.AGENT_ORCH_MAX_EFFORT = kept.maxEffort;
    }
  }
  return out;
}

// Start a watcher for the task's current attempt, which is parked, unless one is alive or starting.
// Returns { pid, generation }, or null when another caller started one first or the spawn failed.
export function spawnParkWatcher(run, task, { by = "park", table = null } = {}) {
  const dir = attemptDir(run, task.id, task.attempt);
  const current = parkWatcher(dir, table);
  if (current.state === "alive" || current.state === "starting") return null;
  const generation = current.generation + 1;
  const file = parkWatcherFile(dir, generation);
  const record = { generation, by, createdAt: new Date().toISOString() };
  try {
    if (!createExclusive(file, record)) return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    // Every interval (AGENT_ORCH_PARK_INTERVAL) the check reads the pull request and the wake
    // condition's deadline; it runs the condition itself only every --every (checkPark), and more
    // often when --every is shorter than the interval.
    const condition = readJson(path.join(dir, PARK_UNTIL_FILE));
    const every = Number(condition?.every) > 0 ? Math.max(1, Math.round(condition.every / 1000)) : null;
    const seconds = Math.min(parkInterval(), every || Infinity);
    const inbox = path.join(taskDir(run, task.id), INBOX_FILE);
    // Detached, and on macOS started through launchd, outside the terminal application (detach.mjs).
    const { pid } = startDetached({
      command: "/bin/sh",
      args: ["-c", PARK_SCRIPT, "park-watch", process.execPath, SCRIPT, dir, String(generation), inbox, String(seconds), String(Math.min(5, seconds))],
      cwd: dir,
      near: [run.repo, task.cd],
      env: parkEnv(task),
      stdout: path.join(dir, LOG),
    });
    writeJson(file, { ...record, pid: pid ?? null });
    return pid ? { pid, generation } : null;
  } catch {
    return null;
  }
}

// Restart the watcher of every parked task whose watcher is not running, taking over a claim that
// its owner abandoned. `rows` are describe() rows, from which only those in phase `parked` count;
// without them, every task of the run whose records say parked. Cheap enough for every poll of a
// wait: when the rows show every watcher alive it does nothing at all, and otherwise it makes one
// `ps` call for all the tasks, and writes and starts nothing unless a watcher is missing. Returns
// [{ id, pid, generation }] for each watcher started, and [{ id, adopted: attempt, pid }] for each
// relay adopted, after which the task runs.
export function reviveParked(run, rows = null) {
  let ids;
  if (rows) {
    const parked = rows.filter((row) => row.phase === "parked" && row.parked);
    if (parked.every((row) => ["alive", "starting"].includes(row.parked.watcher) && row.parked.claim !== "abandoned")) return [];
    ids = parked.map((row) => row.id);
  } else {
    try {
      ids = fs.readdirSync(path.join(run.dir, "tasks"));
    } catch {
      ids = [];
    }
  }
  const revived = [];
  let table;
  for (const id of ids) {
    const task = loadTask(run, id);
    if (!task || !isParked(run, task)) continue;
    // One `ps` for every task; without it, a watcher's liveness cannot be confirmed, so start none.
    table ??= parkProcessTable();
    if (!table) break;
    const dir = attemptDir(run, id, task.attempt);
    const claim = parkClaim(dir, table);
    if (claim.state === "live" || claim.state === "done") continue;
    if (claim.state === "abandoned") {
      // A resume that died after starting its relay: that relay is the task's new attempt.
      const adopted = adoptRelay(run, dir, claim, "revive", table);
      if (adopted) {
        revived.push({ id, adopted: adopted.attempt, pid: adopted.pid });
        continue;
      }
      releaseClaim(dir, claim, "revive", table);
    }
    const watcher = parkWatcher(dir, table);
    if (watcher.state === "alive" || watcher.state === "starting") continue;
    const started = spawnParkWatcher(run, task, { by: "revive", table });
    if (started) revived.push({ id, ...started });
  }
  return revived;
}

// Stop every live watcher of a parked attempt's folder, each by its PID once its command line is
// confirmed. Returns their PIDs.
function stopWatchers(dir) {
  const stopped = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const name of names) {
    const m = /^park-watcher-(\d+)\.json$/.exec(name);
    const pid = m ? readJson(path.join(dir, name))?.pid : null;
    if (!pid || parkWatcherAlive(dir, Number(m[1]), pid) !== true) continue;
    try {
      process.kill(-pid, "SIGTERM"); // detached: the shell leads its own process group, with its sleep
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    stopped.push(pid);
  }
  return stopped;
}

// Create `file` holding `value`, whole, only if no file has that name: the JSON goes to a temporary
// file in the same folder, which is linked to the name (the link fails when it is taken) and then
// removed. A crash leaves at most a stray temporary file, never an empty claim. False when taken.
function createExclusive(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// This process, as a claim's owner: its PID and start time, read once.
let self = null;
const owner = (table = null) => (self ??= { pid: process.pid, started: table?.get(process.pid)?.started || processStarted(process.pid) });

// Whether the relay a claim recorded ({ pid, started }) still runs: its PID, with the same start time.
function relayRunning(relay, table = null) {
  if (!relay?.pid || !relay.started || !exists(relay.pid)) return false;
  return (table ? table.get(relay.pid)?.started : processStarted(relay.pid)) === relay.started;
}

// What a resume keeps from the task's latest record when it saves its attempt: a close or stop that
// came while it started always wins.
export const keptEnd = (latest) => ({ ...(latest?.closedAt ? { closedAt: latest.closedAt } : {}), ...(latest?.stoppedAt ? { stoppedAt: latest.stoppedAt } : {}) });

// Take over an abandoned claim without ending the park: the next claim says it is released.
function releaseClaim(dir, claim, by, table = null) {
  createExclusive(parkClaimFile(dir, claim.generation + 1), { released: true, by, at: new Date().toISOString(), owner: owner(table), supersedes: claim.generation });
}

// Take over an abandoned claim whose resume died after starting its relay, while that relay still
// runs: save the attempt the resume had planned, with that relay's PID (keeping a close or stop that
// came since), start its finish watcher, and start no other relay. Returns the saved task, or null
// when no relay of the claim runs or another claimant took over first.
function adoptRelay(run, dir, current, by, table = null) {
  const planned = current.record?.task;
  if (!planned?.id || !relayRunning(current.record.relay, table)) return null;
  const file = parkClaimFile(dir, current.generation + 1);
  const record = { by, claimedAt: new Date().toISOString(), owner: owner(table), takesOver: current.generation, relay: current.record.relay, task: planned };
  if (!createExclusive(file, record)) return null;
  const task = { ...planned, pid: current.record.relay.pid, ...keptEnd(loadTask(run, planned.id)) };
  saveTask(run, task);
  writeJson(file, { ...record, attempt: task.attempt, pid: task.pid, resumedAt: task.startedAt, adopted: true });
  if (task.startedBy || task.babysit) watchForFinish(run, task);
  return task;
}

// Claim a parked attempt's park for `by`: { generation, record, file } when this process won it,
// taking over an abandoned claim if need be; { adopted: task } when the abandoned claim's relay
// still runs and became the task's attempt; { holder } when a resume, stop or close holds it.
// `since` is the task's close and stop as the claimant saw them, which a resume's claim records.
function takeClaim(run, dir, by, since = null) {
  for (let tries = 0; tries < 5; tries++) {
    const current = parkClaim(dir);
    if (current.state === "live" || current.state === "done") return { holder: current.record?.by || "another command" };
    if (current.state === "abandoned") {
      const adopted = adoptRelay(run, dir, current, by);
      if (adopted) return { adopted };
    }
    const generation = current.generation + 1;
    const record = { by, claimedAt: new Date().toISOString(), owner: owner(), ...(since ? { since } : {}), ...(current.state === "abandoned" ? { takesOver: current.generation } : {}) };
    const file = parkClaimFile(dir, generation);
    if (createExclusive(file, record)) return { generation, record, file };
  }
  return { holder: "another command" };
}

// For `start` and the watcher: claim a parked task's park before writing anything of the next
// attempt, so that exactly one resume ends it and a resume that loses changes nothing. Null when the
// task is not parked; { refused } when a resume, stop or close holds the claim, or when an earlier
// resume's relay was adopted instead (then also { adopted }). Otherwise: `since`, the task's close
// and stop as the claimant saw them when it claimed, so that a stop or close that comes after the
// claim always wins (startTask); spawned(task), to call right after the relay starts, which records
// it so that a takeover can adopt it; release(), to give the claim back if the start fails; and
// done(task) once the new attempt is saved, which records it and stops the watcher (unless the
// watcher is the one resuming).
export function claimParked(run, task, by = "start") {
  if (!isParked(run, task)) return null;
  const dir = attemptDir(run, task.id, task.attempt);
  const since = { closedAt: task.closedAt || null, stoppedAt: task.stoppedAt || null };
  const won = takeClaim(run, dir, by, since);
  if (won.adopted) {
    return { adopted: won.adopted, refused: `task ${task.id}'s earlier resume died after starting its relay (pid ${won.adopted.pid}), which still runs: it is now attempt ${won.adopted.attempt}, so nothing new was started` };
  }
  if (!won.generation) {
    return { refused: `task ${task.id} is parked, and ${won.holder === "watcher" ? "its watcher is resuming it" : `\`${won.holder}\` already ended its park`} right now; run \`status\` to see its new attempt` };
  }
  return {
    since,
    spawned: (planned) => writeJson(won.file, { ...won.record, relay: { pid: planned.pid, started: processStarted(planned.pid) }, task: planned }),
    release: () => writeJson(won.file, { ...won.record, released: true, releasedAt: new Date().toISOString() }),
    done: (started) => {
      writeJson(won.file, { ...(readJson(won.file) || won.record), attempt: started.attempt, pid: started.pid, resumedAt: started.startedAt });
      if (by !== "watcher") stopWatchers(dir);
    },
  };
}

// For `stop` and `close`, which mark the task stopped or closed first: end a parked task's park and
// stop its watcher. Never throws. Null when the task is not parked; { stopped: [pids], ended() } once
// this call holds the park (ended() records that the caller is done); { resumed: attempt } when a
// resume saved its attempt (or its relay was adopted), which the caller then stops; { busy: holder,
// relayStopped } when a resume holds the claim, after stopping the relay it started, if any, which
// it waits up to 10 seconds for; { error } when something failed.
export function endPark(run, task, by) {
  try {
    if (!isParked(run, task)) return null;
    const dir = attemptDir(run, task.id, task.attempt);
    const until = Date.now() + 10000;
    for (;;) {
      const won = takeClaim(run, dir, by);
      if (won.adopted) return { resumed: won.adopted.attempt, stopped: [] };
      if (won.generation) {
        return { stopped: stopWatchers(dir), ended: () => writeJson(won.file, { ...won.record, ended: true, endedAt: new Date().toISOString() }) };
      }
      const claim = parkClaim(dir);
      if (claim.record?.attempt) return { resumed: claim.record.attempt, stopped: [] };
      // A resume that started its relay and has not saved it yet: its save keeps the close or stop,
      // so stopping that relay is all that is left.
      if (relayRunning(claim.record?.relay)) return { busy: won.holder, relayStopped: stopRelay(claim.record.relay.pid), stopped: [] };
      if (claim.state === "done" || Date.now() >= until) return { busy: won.holder, stopped: [] };
      if (claim.state === "live") spawnSync("sleep", ["0.2"]);
    }
  } catch (error) {
    return { error: error.message, stopped: [] };
  }
}

// Stop a relay by its PID (its identity already confirmed), with its process group. Returns the PID.
function stopRelay(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  return pid;
}

// A wake condition's output, which the watcher writes on each run, and how much of it a resume shows.
export const CONDITION_LOG = "park-condition.log";
const CONDITION_LINES = 40;

// How long one run of a wake condition may take: its interval, at least 10 seconds and at most 10
// minutes. A run cut off at the limit counts as not met: a condition must check and exit, not wait.
export const conditionTimeout = (every) => Math.max(10000, Math.min(Number(every) || 0, 10 * 60000));

// The last `n` lines of a file, or "".
function tailLines(file, n, bytes = 256 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8").replace(/\n$/, "").split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

// The variables the Codex relay's --clean-env passes to Codex, besides each --keep-env name
// (codex-delegate's relay.mjs, cleanEnvironment). A task started with it never saw the rest.
const CLEAN_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "CODEX_HOME",
  "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC"];

// The environment a wake condition runs with: the task's own, as its agent's shell had it. That is
// the watcher's (the environment of whoever started the attempt) with the user's extra agent
// environment and the PATH the agent had; for a Codex task started with --clean-env, only what
// that option keeps. The task's AGENT_ORCH_* identity is added, so that `orch.mjs` commands in the
// condition act as the task.
export function conditionEnv(run, task, condition, base = process.env, agentEnv = {}) {
  const full = { ...base, ...agentEnv, ...(condition.path ? { PATH: condition.path } : {}) };
  const argv = Array.isArray(task.argv) ? task.argv : [];
  const clean = attemptAgent(task, task.attempt) === "codex" && argv.includes("--clean-env");
  const keep = clean ? [...CLEAN_ENV, ...argv.flatMap((a, i) => (a === "--keep-env" && argv[i + 1] ? [argv[i + 1]] : []))] : null;
  const env = keep ? Object.fromEntries(keep.filter((key) => full[key] !== undefined).map((key) => [key, full[key]])) : full;
  return { ...env, AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: task.id, AGENT_ORCH_DEPTH: String((Number.isInteger(task.startDepth) ? task.startDepth : 0) + 1) };
}

// Names of variables whose values are secrets, and shapes of tokens that give themselves away.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|SESSION_?KEY|AUTHORIZATION)/i;
const SECRET_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g;

// Text from a command's output with obvious secrets replaced by [redacted]: the value of a variable
// whose name says it holds one (NAME=value lines, and NAME: value or "NAME":"value" pairs), tokens
// of known shapes, bearer credentials and private key blocks. What a resume brief quotes passes
// through this; the condition itself runs without what its task was not given (conditionEnv).
export function redactSecrets(text) {
  return String(text ?? "")
    // A whole key block, and the end of one whose first lines were cut off before this text.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/^(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/, "[redacted private key]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]")
    .replace(SECRET_SHAPE, "[redacted]")
    .replace(/^([A-Za-z_][A-Za-z0-9_]*)=.*$/gm, (line, name) => (SECRET_NAME.test(name) ? `${name}=[redacted]` : line))
    // A quoted value whole, spaces included: "NAME":"value", NAME: 'value', NAME="value".
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["'])((?:\\.|(?!\3)[^\\\n])*)\3/g, (pair, name, sep, quote, value) => (SECRET_NAME.test(name) && value !== "[redacted]" ? `${name}${sep}${quote}[redacted]${quote}` : pair))
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/g, (pair, name, sep, value) => (SECRET_NAME.test(name) && value !== "[redacted]" ? `${name}${sep}[redacted]` : pair));
}

// The last lines of a condition's output, as a resume brief may quote them: up to the last MB of it
// is redacted first, so that a secret that starts above the kept lines (the first line of a key
// block, say) is still recognized, and only then cut to the last lines.
const shownOutput = (log) => redactSecrets(tailLines(log, Infinity, 1024 * 1024)).split("\n").slice(-CONDITION_LINES).join("\n");

// Run a parked attempt's wake condition once, in the folder `park-until` ran in, with the task's
// own environment (conditionEnv). Its output goes to CONDITION_LOG in the attempt's folder `dir`.
// One run takes at most its interval (conditionTimeout), and never past the condition's deadline.
// Returns { ranAt, code, signal, timedOut, timeoutMs, output }, with the output's secrets redacted,
// or { ranAt, error } when it cannot run at all (its folder is gone, its program is missing), which
// wakes the task rather than trying forever.
export function runCondition(run, task, dir, condition, agentEnv = {}) {
  const ranAt = new Date().toISOString();
  const [program, ...args] = condition.command;
  const cwd = condition.cwd || task.cd || run.repo;
  if (!cwd || !fs.existsSync(cwd)) return { ranAt, error: `its folder ${cwd} is gone` };
  const log = path.join(dir, CONDITION_LOG);
  const left = Date.parse(condition.until) - Date.now();
  const timeoutMs = Math.max(1000, Math.min(conditionTimeout(condition.every), Number.isFinite(left) ? left : Infinity));
  let r;
  const fd = fs.openSync(log, "w");
  try {
    r = spawnSync(program, args, { cwd, env: conditionEnv(run, task, condition, process.env, agentEnv), stdio: ["ignore", fd, fd], timeout: timeoutMs, killSignal: "SIGKILL" });
  } finally {
    fs.closeSync(fd);
  }
  const output = shownOutput(log);
  if (r.error?.code === "ETIMEDOUT") return { ranAt, code: null, signal: r.signal || null, timedOut: true, timeoutMs, output };
  if (r.error) return { ranAt, error: r.error.code === "ENOENT" ? `\`${program}\` was not found` : r.error.message, output };
  return { ranAt, code: r.status, signal: r.signal || null, output };
}

// One line on a wake condition's last run, for the resume brief.
function runText(c) {
  if (!c.ranAt) return "it has not run yet";
  if (c.error) return `it could not run (${c.ranAt}): ${c.error}`;
  if (c.timedOut) return `its last run (${c.ranAt}) was stopped after ${durationText(c.timeoutMs || conditionTimeout(c.every))}, the most it could take`;
  return `its last run (${c.ranAt}) exited ${c.code ?? `on signal ${c.signal}`}`;
}

// The resume brief's lines on the wake condition (`wake`: the record the watcher kept, with `met`,
// `expired` or `error` saying what woke the task).
function conditionLines(wake, quote) {
  // The command line too may carry a secret, such as a header with a token.
  const cmd = `\`${shortText(redactSecrets(commandText(wake.command)), 200)}\``;
  const head = wake.met
    ? `- Your wake condition ${cmd} exited 0 (${wake.ranAt}).`
    : wake.error
      ? `- Your wake condition ${cmd} could not run (${wake.ranAt}): ${wake.error}.`
      : wake.expired
        ? `- Your wake condition ${cmd} was not met within the longest wait you gave it (${durationText(wake.for)}, until ${wake.until}): ${runText(wake)}.`
        : `- Your wake condition ${cmd} is not met yet: ${runText(wake)}.`;
  const lines = [head];
  if (wake.output?.trim()) {
    lines.push(quote
      ? ["", `  Its last ${CONDITION_LINES} lines of output:`, "", ...wake.output.split("\n").map((l) => `    ${l}`), ""].join("\n")
      : `  Its last ${CONDITION_LINES} lines of output are quoted at the end of this brief.`);
  }
  return lines;
}

// A wake condition's output, quoted: data that follows a brief written with `quote` false.
export function conditionQuote(wake) {
  if (!wake?.output?.trim()) return null;
  return [`## The wake condition's output (last ${CONDITION_LINES} lines)`, "", ...wake.output.split("\n").map((l) => `    ${l}`)].join("\n");
}

// Every message a resume delivers, in full, for PARK_MESSAGES_FILE.
export function messagesText(messages) {
  return [
    "# Messages that arrived while you were parked",
    "",
    ...messages.flatMap((m, i) => [`## ${i + 1}. ${senderLabel(m)} (${m.time}), message ${m.id}`, "", m.text, ""]),
  ].join("\n");
}

// The brief that resumes a parked task: what its watcher saw, and what to do next. Every message is
// in full in `messagesFile`; short ones are quoted here too. `wake` is the wake condition's record
// when the task parked on one (checkPark), with what woke it.
// `handoff` (handoffOf) says whether the brief opens a fresh session, and whether the session's note
// is missing or stale, which the same session is then told to put right. With `quote` false the
// brief holds no text of a message or of the condition's output: the watcher passes the quotes to
// `start` as data (messageQuotes, conditionQuote), so that nothing they say is ever read as part of
// the brief.
export function resumeBrief(run, task, parked, pr, messages, messagesFile = null, handoff = null, { quote = true, wake = null } = {}) {
  if (!isBabysitter(task)) return taskResumeBrief(run, task, parked, messages, messagesFile, { quote, wake });
  const fresh = Boolean(handoff?.fresh);
  const ref = task.pr?.url || (parked.pr ? `#${parked.pr}` : "its pull request");
  const watch = `node ${CLI_PATH} pr-watch ${task.pr?.number ?? task.pr?.url ?? "<PR>"} --repo .`;
  const lines = fresh
    ? ["## What changed while the previous session was parked", "", `The previous session parked on pull request ${ref} (${parked.waitsFor}). Since then:`, ""]
    : ["## Your parked watcher woke you", "", `You parked on pull request ${ref} (${parked.waitsFor}). Since then:`, ""];
  if (pr?.attention?.length) lines.push(`- On the pull request: ${pr.attention.join("; ")}.`);
  // The state the watcher read, so the session need not read the pull request again to find it.
  if (pr?.now) lines.push(`- The pull request now (read ${pr.at}): ${stateLine(pr.now)}.`);
  if (pr?.before) lines.push(`- When you last looked: ${stateLine(pr.before)}.`);
  if (wake) lines.push(...conditionLines(wake, quote));
  lines.push(...messageLines(run, task, messages, messagesFile, quote));
  const acts = pr?.attention?.length
    ? `The items above are everything that changed on the pull request, and they are recorded as seen: do not run a watch or read the pull request's state again to find them. ${fresh ? 'Do the start checks of your brief, then go straight to step 2 of its loop' : 'Go straight to step 2 of your loop ("Loop" in the babysitter brief you started with)'} and handle each one, reading only what an item needs (a failed check's log, the new comments).`
    : `Nothing changed on the pull request, so do not read its state again.`;
  lines.push(
    "",
    `${acts} Handle every ${messages.length ? "item and every message" : "item"}, push, and reply as your rules say. ${messages.length ? "The messages are marked read once this brief starts. " : ""}Then run \`${watch}\`, which returns at once, and park again when it finds nothing new, nothing is unpushed, and every item is handled.`,
  );
  // Memory is never dropped without a note: a session that left none, or an old one, is kept.
  if (handoff && !fresh && handoff.note !== "current") {
    lines.push(
      "",
      `Your handoff note at \`${handoff.file}\` ${handoff.note === "missing" ? "does not exist" : "was not updated in your last attempt"}. Write it before you park again, and update it before every park. Every call you make re-sends your whole context${handoff.tokens ? ` (${handoff.tokens} tokens at your last call)` : ""}; once that is above ${handoff.limit} tokens your watcher resumes you in a fresh session that knows only your brief, that note and what changed, but only when the note was updated in the attempt that parked. ${HANDOFF_RULES}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// The messages part of a resume brief: the line that points to the file, then one entry per message.
function messageLines(run, task, messages, messagesFile, quote) {
  if (!messages.length) return [];
  const lines = [`- ${messages.length === 1 ? "A message arrived" : `${messages.length} messages arrived`}. Read ${messages.length === 1 ? "it" : "every one"} in full in \`${messagesFile}\` before anything else.`, ""];
  for (const m of messages) {
    const short = m.text.length <= INLINE_CHARS;
    lines.push(`  - ${senderLabel(m)} (${m.time})${short ? (quote ? ":" : ", message " + m.id + ": quoted at the end of this brief.") : `: a long message (${m.text.length} characters), only in the file.`}`);
    if (short && quote) lines.push("", ...m.text.split("\n").map((l) => `    > ${l}`), "");
    if (m.from === "user") lines.push(`    ${replyHint(run.id, task.id)}`, "");
  }
  return lines;
}

// The brief that resumes a parked task that is not a babysitter: what woke it (its wake condition,
// the tasks it started, a message), and that the watcher has just checked the condition.
function taskResumeBrief(run, task, parked, messages, messagesFile, { quote, wake }) {
  const lines = ["## Your parked watcher woke you", "", `You parked (${parked.waitsFor}). Since then:`, ""];
  if (wake) lines.push(...conditionLines(wake, quote));
  const finished = messages.filter((m) => fromAgent(m) && m.kind === "finished").length;
  if (finished) lines.push(`- ${finished === 1 ? "A task you started has finished" : `${finished} tasks you started have finished`}: ${finished === 1 ? "its notice is" : "their notices are"} among the messages below.`);
  lines.push(...messageLines(run, task, messages, messagesFile, quote));
  const checked = wake ? "Your watcher has just run your wake condition, so do not run it again to check. " : "";
  lines.push(
    "",
    `${checked}Act on what woke you${messages.length ? ", and handle every message (they are marked read once this brief starts)" : ""}. To wait again, record a wake condition with \`node ${CLI_PATH} park-until ...\` (or rely on the tasks you started that still run), then end your turn with \`PARKED: waits for <what>\`. Never wait in your session with sleep, nap or a polling loop.`,
  );
  return `${lines.join("\n")}\n`;
}

// The short messages of a resume, quoted: the data that follows a brief written with `quote` false.
export function messageQuotes(messages) {
  const short = messages.filter((m) => m.text.length <= INLINE_CHARS);
  if (!short.length) return null;
  return ["## The messages, quoted", "", ...short.flatMap((m) => [`- ${senderLabel(m)} (${m.time}), message ${m.id}:`, "", ...m.text.split("\n").map((l) => `    > ${l}`), ""])].join("\n");
}

// One check of a parked attempt's folder `dir` by watcher `generation`: resume the task when its
// pull request or its inbox has something. Returns the exit code: 0 to keep watching, DONE to stop.
export async function checkPark(dir, generation) {
  const n = Number(/attempt-(\d+)$/.exec(dir)?.[1]);
  const id = path.basename(path.dirname(dir));
  const runDir = path.dirname(path.dirname(path.dirname(dir)));
  const runRecord = readJson(path.join(runDir, "run.json"));
  if (!runRecord || !(n > 0)) return DONE;
  const run = { ...runRecord, dir: runDir };
  const task = loadTask(run, id);
  if (!task || task.attempt !== n || parkWatcher(dir).generation !== generation) return DONE;
  const held = parkClaim(dir);
  if (["live", "done"].includes(held.state) || relayAlive(task.pid, task.startedAt, task.outDir)) return DONE;
  // A resume that died after starting its relay: that relay is the task's new attempt.
  if (held.state === "abandoned" && adoptRelay(run, dir, held, "watcher")) return DONE;
  const result = readJson(path.join(dir, "result.json"));
  const parked = parkedOf(run, task, result);
  if (!parked) return DONE;

  const babysit = isBabysitter(task);
  const file = path.join(dir, PARK_CHECK_FILE);
  const previous = readJson(file);
  const record = { at: new Date().toISOString(), generation };
  // A task it started that ended long ago with no notice written (its finish watcher is gone):
  // write that notice now, into this task's inbox, where it wakes the task below.
  if (parked.children?.length) {
    const late = lateNotices(run, task);
    if (late.length) {
      const start = await import("./commands/start.mjs");
      for (const child of late) {
        try {
          sendFinishNotice(child.runDir, child.task, child.attempt, { start });
        } catch {}
      }
      record.lateNotices = late.map((c) => `${path.basename(c.runDir)}/${c.task}`);
    }
  }
  const messages = readInbox(taskDir(run, id)).filter((m) => !m.read);
  let pr = null;
  const ref = babysit ? task.pr?.url || (task.pr?.number ? String(task.pr.number) : null) : null;
  if (ref) {
    const cwd = task.cd && fs.existsSync(task.cd) ? task.cd : run.repo;
    const s = watchSnapshot(cwd, ref);
    if (s.error) record.error = s.error;
    else {
      const seen = readSeen(s);
      let attention = watchAttention(s, seen);
      if (!seen && !attention.length) recordSeen(s);
      // Entering the merge queue is no event, but it is remembered, so that leaving it is one.
      if (!attention.length) rememberQueue(s, seen);
      // A change that needs no judgment wakes no model: record it as seen and keep waiting. With a
      // message to deliver the babysitter wakes anyway, and is told about it.
      if (!messages.length && quietItems(s, attention)) {
        recordSeen(s);
        record.quiet = attention;
        attention = [];
      }
      if (aheadOfPr(cwd, s)) attention.push("this checkout has commits the pull request lacks: push them");
      pr = { number: s.number, state: s.state, attention, now: s, before: seen, at: record.at };
    }
  }
  // The wake condition: run it when its interval has passed since its last run (at once on the
  // first check), and wake the task when it exits 0, cannot run, or its longest wait has passed.
  // Every check looks at the deadline, whatever the interval. A run that exited 0, or could not
  // run, stays the event (latched in the check's record) until a resume delivers it: a resume the
  // machine refuses now is tried again at the next check, without running the condition again.
  let wake = null;
  const conditionEvents = [];
  const condition = readJson(path.join(dir, PARK_UNTIL_FILE));
  if (Array.isArray(condition?.command) && condition.command.length) {
    const last = previous?.condition || null;
    const latched = last?.met || last?.error ? last : null;
    const expired = Date.now() >= Date.parse(condition.until);
    const due = !last?.ranAt || Date.now() - Date.parse(last.ranAt) >= condition.every;
    let ran = null;
    if (!latched && !expired && due) {
      const { readAgentEnv } = await import("./commands/start.mjs");
      ran = runCondition(run, task, dir, condition, readAgentEnv());
    }
    const latest = ran || last || {};
    // The output of a run before this check is in its log; the check's record keeps none of it.
    const output = ran ? ran.output : latest.ranAt ? shownOutput(path.join(dir, CONDITION_LOG)) : "";
    wake = { command: condition.command, every: condition.every, for: condition.for, until: condition.until, why: condition.why || null, ...latest, output };
    if (latched) {
      conditionEvents.push(latched.met ? "the wake condition exited 0" : `the wake condition could not run: ${latched.error}`);
    } else if (ran?.error) {
      wake.error = ran.error;
      conditionEvents.push(`the wake condition could not run: ${ran.error}`);
    } else if (ran && ran.code === 0) {
      wake.met = true;
      conditionEvents.push("the wake condition exited 0");
    } else if (expired || Date.now() >= Date.parse(condition.until)) {
      wake.expired = true;
      conditionEvents.push("the wake condition's longest wait has passed");
    }
    const { output: shown, ...kept } = latest;
    record.condition = { ...kept, ...(wake.met ? { met: true } : {}), ...(wake.error ? { error: wake.error } : {}) };
  }
  record.events = [...(pr?.attention || []), ...conditionEvents, ...messages.map((m) => `message ${m.id}`)];
  if (!record.events.length) {
    writeJson(file, record);
    return 0;
  }
  // A babysitter resumes at its watch tier. Its first call reads no prompt cache when it switches
  // model or waited past the cache's life, and then a smaller session is worth handing off.
  let handoff = null;
  if (babysit) {
    const toModel = tierModel("claude", task.watchTier || BABYSIT_WATCH_TIER);
    const { cold, why } = coldResume(result.finishedAt, task.model, toModel);
    handoff = handoffOf(run, task, dir, { cold, coldWhy: why });
  }
  const fresh = Boolean(handoff?.fresh);
  const session = result.sessionId || result.threadId;
  if (!session && !fresh) {
    writeJson(file, { ...record, error: "its result has no session id to resume" });
    return 0;
  }
  // Claim first: a resume that loses to another (or to a stop) writes nothing.
  const claim = claimParked(run, task, "watcher");
  if (!claim || claim.refused) return DONE;
  const { StartRefused, startTask } = await import("./commands/start.mjs");
  const messagesFile = messages.length ? path.join(taskDir(run, id), `attempt-${n + 1}`, PARK_MESSAGES_FILE) : null;
  const brief = path.join(dir, "park-resume.md");
  let started;
  try {
    const changed = resumeBrief(run, task, parked, pr, messages, messagesFile, handoff, { quote: false, wake });
    fs.writeFileSync(brief, fresh ? handoffBrief(handoff, changed) : changed);
    const data = [messageQuotes(messages), conditionQuote(wake)].filter(Boolean).join("\n\n") || null;
    // A task that is not a babysitter keeps its relay's options (model, effort, sandbox, network,
    // read-only) and its tier, as an interrupt does; a babysitter's start sets its own.
    const keep = babysit ? {} : { relayFrom: Array.isArray(task.argv) ? task.argv : [], "no-escalate": true, ...(task.readOnly ? { "read-only": true } : {}) };
    ({ task: started } = startTask({
      _: [run.dir, id], agent: task.agent, brief, briefData: data, passthrough: fresh ? [] : [...resumeSandbox(task), "--session", session], parkClaim: claim,
      fromHandoff: fresh, ...keep,
      attemptFiles: messages.length ? { [PARK_MESSAGES_FILE]: messagesText(messages) } : {},
      // The record that this attempt began a fresh session from a handoff, and at what context size.
    }, {
      ...(fresh ? { handoffs: { ...(task.handoffs || {}), [n + 1]: handoffRecord(handoff, n, record.at) } } : {}),
      ...(handoff ? { handoffChecks: { ...(task.handoffChecks || {}), [n + 1]: handoffCheck(handoff) } } : {}),
    }));
  } catch (error) {
    claim.release();
    if (!(error instanceof StartRefused)) throw error;
    writeJson(file, { ...record, waiting: error.message });
    return 0;
  }
  // The brief told the session what changed, so that state is now the last one reported.
  if (pr?.attention.length) recordSeen(pr.now);
  // Only the messages written in full into the new attempt's folder were delivered.
  markRead(taskDir(run, id), messages.map((m) => m.id), { attempt: started.attempt });
  writeJson(file, { ...record, resumed: started.attempt, ...(fresh ? { freshSession: true, contextTokens: handoff.tokens, limitKind: handoff.cold ? "cold" : "warm" } : {}) });
  return DONE;
}

// What a resumed Codex session must be told about its sandbox. The Codex relay refuses
// --network-access on a resumed run unless the sandbox is named (Codex does not carry it over), and
// a sandboxed Codex task with the network on starts in the relay's default sandbox, workspace-write,
// without naming it. A task that named its sandbox, or runs in a lane, keeps that.
export function resumeSandbox(task) {
  const argv = Array.isArray(task.argv) ? task.argv : [];
  if (attemptAgent(task, task.attempt) !== "codex" || !argv.includes("--network-access")) return [];
  return argv.some((a) => a === "--sandbox" || a.startsWith("--sandbox=") || a === "--read-only" || a === "--lane" || a.startsWith("--lane=")) ? [] : ["--sandbox", "workspace-write"];
}

// The model of an agent's tier, from the policy, or null when it cannot be read.
export function tierModel(agent, tier) {
  try {
    return readPolicy()[agent]?.tiers?.[tier]?.model || null;
  } catch {
    return null;
  }
}

const real = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(SCRIPT)) {
  const [command, dir, generation] = process.argv.slice(2);
  if (command !== "check" || !dir || !(Number(generation) > 0)) {
    process.stderr.write("usage: park.mjs check ATTEMPT_DIR GENERATION\n");
    process.exit(2);
  }
  checkPark(path.resolve(dir), Number(generation)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${new Date().toISOString()} park check: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    },
  );
}
