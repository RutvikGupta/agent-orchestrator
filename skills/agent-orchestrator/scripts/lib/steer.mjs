// Steering: a message that must reach an agent now, not after its current command. Messages reach
// an agent when a tool call returns (the orch-inbox hook) or when it runs `inbox`, so a long
// command (a polling script, a test run) holds them back. Steering delivers the message now in
// every state of a running agent:
// - in a foreground shell command: it stops that command, so the call returns at once and the
//   message reaches the agent, which reruns the command if it still needs it;
// - mid-turn but not in a shell command (a model call, or another tool), or after it ended its turn
//   while its process stays alive on a background command of its own (`idle`, runs.mjs): it
//   interrupts the session, which stops it and resumes it in the same session with the unread
//   messages as its next prompt (see "Interrupts" below).

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_PATH, SKILL_ROOTS } from "./config.mjs";
import { claudeTurnEnded, subagentEvent } from "./claude.mjs";
import { commandRuns, openToolNow, summarizeEvents } from "./events.mjs";
import { watchForFinish } from "./finish-notice.mjs";
import { markRead, markSteered, readInbox, replyHint, senderLabel } from "./inbox.mjs";
import { parkEnv } from "./park.mjs";
import { COMMAND_AGENT } from "./policy.mjs";
import { describe, exists, loadTask, processStarted, relayAlive, resumeClaim, resumeFile, resumeHandoffFile, saveTask, shownName, taskDir, waitForExit } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";

// Commands that publish or rewrite history are never stopped part-way: the message waits.
const PROTECTED = /\b(git\s+(commit|push|rebase|merge|cherry-pick|am|tag|reset|checkout|switch|stash)|gt\s+(submit|sync|restack|modify|create|move|fold|split|squash)|gh\s+(pr\s+(create|merge|edit|ready|close|comment|review)|api\s+(-X|--method))|npm\s+publish|terraform\s+apply|alembic\s+upgrade)\b/;
const SHELL = /^\/bin\/(ba|z)?sh -l?c /;

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// Every command a Codex agent is running, oldest first: each command_execution item that started
// and has not completed, as { id, command, seconds: null }. A turn's end closes them all.
export function pendingCodexCommands(eventsFile) {
  const open = new Map();
  for (const line of (readText(eventsFile) || "").split("\n")) {
    if (!line.includes("command_execution") && !line.includes('"turn.')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn.completed" || e.type === "turn.failed") open.clear();
    if (e.item?.type !== "command_execution") continue;
    if (e.type === "item.started") open.set(e.item.id, e.item.command);
    else if (e.type === "item.completed") open.delete(e.item.id);
  }
  return [...open].filter(([, command]) => command).map(([id, command]) => ({ id, command: String(command), seconds: null }));
}

// Every foreground Bash call in the attempt's event stream that has no result yet, oldest first,
// whichever tool call came after it (parallel calls, a sub-agent's): { id, command, seconds }, with
// seconds from its latest progress heartbeat, if any. A Bash call that runs in the background gets
// its result at once. The session's `result` ends its turn, and every call of its own. A
// sub-agent's call stays: a sub-agent in the background runs on after the turn, so its command is
// kept, marked `ended` (the turn it started in is over). New child calls while the parent's turn
// is over are marked the same way, until an event of the parent's next turn arrives.
export function pendingCommands(eventsFile) {
  const open = new Map();
  let turnEnded = false;
  for (const line of (readText(eventsFile) || "").split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const sub = subagentEvent(e);
    turnEnded = claudeTurnEnded(turnEnded, e);
    if (e.type === "result" && !sub) {
      for (const [id, call] of open) {
        if (call.sub) call.ended = true;
        else open.delete(id);
      }
    }
    if (e.type === "system" && e.subtype === "permission_denied") open.delete(e.tool_use_id); // it never ran
    if (e.type === "tool_progress" && open.has(e.parent_tool_use_id)) open.get(e.parent_tool_use_id).seconds = e.elapsed_time_seconds ?? open.get(e.parent_tool_use_id).seconds;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_use" && c.name === "Bash" && !c.input?.run_in_background && c.input?.command) open.set(c.id, { id: c.id, command: String(c.input.command), seconds: null, ...(sub ? { sub: true, ...(turnEnded ? { ended: true } : {}) } : {}) });
      else if (c?.type === "tool_result") open.delete(c.tool_use_id);
    }
  }
  return [...open.values()];
}

// The latest of them, or null.
export const pendingCodexCommand = (eventsFile) => pendingCodexCommands(eventsFile).at(-1) || null;
export const pendingCommand = (eventsFile) => pendingCommands(eventsFile).at(-1) || null;

// Every process with its parent and command.
function processTable() {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const rows = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

// A shell's command line quotes and escapes the agent's command, so compare both without quoting,
// and without the shell wrapper: Codex records `/bin/bash -lc '<command>'` but runs
// `/bin/bash -c <command>`, and Claude's wrapper sources its shell snapshot first.
const bare = (s) => s.replace(/['"\\]/g, "").replace(/\s+/g, " ").trim();
const inner = (s) => bare(s).replace(/^\/bin\/(ba|z)?sh -l?c /, "");

// `orch.mjs heavy` forwards each terminating signal it receives to its command's whole group
// (heavy.mjs). A host that also signals the command directly would deliver that signal twice, and
// three times through a nested heavy call; Docker Compose and Pants treat a second signal as
// "force". So the wrapper is the only process of its branch that steering signals.
const NODE = /^node(js)?\d*(\.\d+)*$/;
// Node options that take their value as the next word. Any other word before the script is not
// a Node option, so the line is not a script run.
const NODE_VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--input-type", "--env-file", "--title"]);
// Options after which Node runs code from the line itself, so a later `orch.mjs` is only an argument.
const NODE_CODE_OPTIONS = /^(-[a-zA-Z]*[epci][a-zA-Z]*|--(eval|print|check|interactive))(=|$)/;

// The ways this skill's own CLI is named: the path this copy runs from, the skill roots' links to
// it, and the path the steering process was started with. ps joins a process's arguments with
// spaces, so these are matched as literal text, which keeps a path with spaces (a home folder or
// `Application Support`) in one piece. Another copy of the CLI is found by `isHeavyWrapper`.
function knownScripts() {
  const paths = new Set([CLI_PATH, ...SKILL_ROOTS.map((root) => path.join(root, "agent-orchestrator", "scripts", "orch.mjs"))]);
  if (path.basename(process.argv[1] || "") === "orch.mjs") paths.add(process.argv[1]);
  return [...paths];
}

// Words that start `node [options]`: the executable, then only Node options. The executable is a
// single word, or an absolute path with spaces in it: its later words do not start like a new path
// or an option, so `sudo -u me /usr/bin/node` and `/usr/bin/time /usr/bin/node` are not Node.
function nodeHead(words) {
  for (let k = 0; k < words.length; k++) {
    if (words.slice(1, k + 1).some((word) => /^[/.-]/.test(word))) break;
    const exe = words.slice(0, k + 1).join(" ").replace(/^(["'])(.*)\1$/, "$2");
    if (k > 0 && !exe.startsWith("/")) continue;
    if (exe !== process.execPath && !NODE.test(path.basename(exe))) continue;
    let ok = true;
    for (let i = k + 1; ok && i < words.length; i++) {
      if (NODE_CODE_OPTIONS.test(words[i]) || words[i] === "-") ok = false;
      else if (NODE_VALUE_OPTIONS.has(words[i])) i++;
      else ok = words[i].startsWith("-");
    }
    if (ok) return true;
  }
  return false;
}

// The words after `heavy`: only `--json` and `--label TEXT` (the text may hold spaces) up to the
// first `--`, which needs a command after it. The real command refuses anything else.
function heavyArguments(words) {
  let label = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--") return i + 1 < words.length;
    if (word === "--json") label = false;
    else if (word === "--label") {
      if (i + 1 >= words.length || words[i + 1] === "--") return false;
      label = true;
      i++;
    } else if (word.startsWith("--label=")) label = true;
    else if (!label || word.startsWith("--")) return false;
  }
  return false;
}

const wordsOf = (text) => text.trim().split(/\s+/).filter(Boolean);
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
// The script path after Node and its options is searched this many words deep, and Node's own
// options and executable are expected within the first words.
const PATH_WORDS = 16, HEAD_WORDS = 24;

// Whether a process's command line is a running `node .../orch.mjs heavy ... -- COMMAND`: Node and
// its options, then the CLI script, then `heavy` and its arguments. A shell, `grep` or `echo` that
// merely mentions these words does not start with Node, and neither does `node -e "..."` or
// `node other.js orch.mjs heavy`, whose script is something else.
//
// ps joins the arguments with spaces, so where the script path ends is a guess unless it is checked
// against something known. Three ways to tell, in order:
//   1. `scripts` (this skill's own CLI paths by default), matched as literal text.
//   2. A script path without spaces, which is one word.
//   3. A script path with spaces: the words after Node and its options are joined one at a time
//      until the text names an existing file (`exists`). That first file is the script, whatever
//      its name: a real `other.js` ends the search, and what follows it is its arguments.
// Anything else (a path with spaces to a file that is gone, say) does not match, which leaves its
// process signaled directly, as before.
export function isHeavyWrapper(commandLine, scripts = knownScripts(), exists = isFile) {
  const text = String(commandLine).trim();
  for (const needle of scripts.flatMap((script) => [script, `"${script}"`, `'${script}'`]).map((form) => ` ${form} heavy`)) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const tail = text.slice(at + needle.length);
      if ((tail === "" || /^\s/.test(tail)) && nodeHead(wordsOf(text.slice(0, at))) && heavyArguments(wordsOf(tail))) return true;
    }
  }
  const spans = [...text.matchAll(/\S+/g)], words = spans.map((span) => span[0]);
  if (words.some((word, i) => i > 0 && path.basename(word) === "orch.mjs" && words[i + 1] === "heavy" && nodeHead(words.slice(0, i)) && heavyArguments(words.slice(i + 2)))) return true;
  for (let s = 1; s < words.length && s < HEAD_WORDS; s++) {
    if (!words[s].startsWith("/") || !nodeHead(words.slice(0, s))) continue;
    for (let e = s; e < words.length && e < s + PATH_WORDS; e++) {
      const script = text.slice(spans[s].index, spans[e].index + words[e].length);
      if (!exists(script)) continue;
      if (path.basename(script) === "orch.mjs" && words[e + 1] === "heavy" && heavyArguments(words.slice(e + 2))) return true;
      break; // the first existing file is the script
    }
  }
  return false;
}

// The shell the agent's relay runs `command` in, and every process under it, deepest first. A
// heavy wrapper's descendants (its command, and any nested wrapper with its own command) are left
// out: the wrapper forwards the signal to them.
export function commandTree(relayPid, command, rows = processTable()) {
  if (!rows) return null;
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
  const under = (pid) => (children.get(pid) || []).flatMap((child) => [child, ...under(child.pid)]);
  const fragment = inner(command).slice(0, 80);
  const shell = fragment && under(relayPid).find((row) => SHELL.test(row.command) && bare(row.command).includes(fragment));
  if (!shell) return null;
  const tree = [shell, ...under(shell.pid)];
  const forwarded = new Set(tree.filter((row) => isHeavyWrapper(row.command)).flatMap((row) => under(row.pid).map((d) => d.pid)));
  return { shell, pids: tree.filter((row) => !forwarded.has(row.pid)).map((row) => row.pid).reverse() };
}

// What steering a running task would do now. `row` is its describe() row, for its idle state and
// session. One of:
//   { stop: { command, pids, seconds } }      stop its foreground shell commands (stopCommand);
//   { resume: { was, doing, session, background } }  interrupt its session (interrupt helper);
//   { wait: reason, refused? }                do nothing now: the message waits for the agent;
//                                             `refused` when an interrupt would do harm.
// Every shell command of the turn that has no result yet counts, whatever tool call came after it:
// an interrupt never ends a session while one of them runs. When one is a publishing command, the
// message waits for it; otherwise each of them is stopped, which returns its call. A sub-agent's
// command that runs while the parent is idle is background work: a publishing one still holds the
// interrupt back, and any other ends with the session, as a background command does.
export function planSteer(task, row = null) {
  const events = path.join(task.outDir || "", "events.jsonl");
  const all = task.agent === "codex" ? pendingCodexCommands(events) : pendingCommands(events);
  const kept = all.find((p) => PROTECTED.test(p.command));
  if (kept) return { wait: `the agent is running \`${shorten(kept.command)}\`, which is not stopped part-way` };
  const pending = all.filter((p) => !p.ended);
  if (!pending.length) return planResume(task, row);
  const found = pending.map((p) => ({ p, tree: commandTree(task.pid, p.command) })).filter((x) => x.tree);
  if (!found.length) return { wait: "the agent's command could not be matched to a process" };
  const last = found.at(-1).p;
  return { stop: { command: last.command, pids: [...new Set(found.flatMap((x) => x.tree.pids))], seconds: last.seconds } };
}

// Whether a task that is not in a shell command can be interrupted: { resume } or a refusal. `was`
// is "idle" (it ended its turn and waits on a background command of its own) or "mid-turn"; `doing`
// says what it was doing then.
export function planResume(task, row = null) {
  const refused = (why) => ({ wait: `${why}, so it is not interrupted; it reads the message after its current step`, refused: true });
  if (task.agent === COMMAND_AGENT) return { wait: "a command task has no session to resume and no agent to read the message", refused: true };
  if (task.babysit || task.plan?.type === "babysit") return refused("a babysitter's park watcher delivers its messages");
  if (!["claude", "codex"].includes(task.agent)) return refused(`a ${task.agent} task cannot be resumed`);
  // The Codex relay refuses --network-access on a resumed run unless the sandbox is named, and a
  // sandboxed Codex task with the network on starts without naming it: its session would be stopped
  // and could not resume.
  const argv = Array.isArray(task.argv) ? task.argv : [];
  if (task.agent === "codex" && argv.includes("--network-access") && !argv.includes("--sandbox") && !argv.includes("--read-only")) return refused("its Codex relay cannot resume a sandboxed session with the network on");
  const events = path.join(task.outDir || "", "events.jsonl");
  const summary = summarizeEvents(task.agent, events, task.cd);
  const session = row?.session || summary.sessionId || null;
  if (!session) return refused("its session id is not known yet");
  // Stopping the session also stops what it runs in the background: never a publishing command.
  const kept = task.agent === "claude" ? commandRuns("claude", events).find((r) => r.background && r.exitCode === null && PROTECTED.test(r.cmd)) : null;
  if (kept) return { wait: `the agent's background command \`${shorten(kept.cmd)}\` is not stopped part-way, so it is not interrupted; it reads the message after its current step`, refused: true };
  if (row?.idle) return { resume: { was: "idle", doing: `ended its turn and waited on its own background ${row.idle.background ? `command \`${shorten(row.idle.background)}\`` : "work"}`, session, background: row.idle.background || null } };
  const tool = task.agent === "claude" ? openToolNow(summary)?.name : null;
  return { resume: { was: "mid-turn", doing: tool ? `was in a ${tool} tool call, not in a shell command` : "was not in a shell command (in a model call, or between steps)", session, background: null } };
}

// Stop each process of the plan, deepest first, and report which ones were running.
export function stopCommand(plan) {
  const stopped = [];
  for (const pid of plan.stop.pids) {
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
      // Already gone.
    }
  }
  return stopped;
}

export function shorten(command, width = 80) {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
}

// Interrupts. An interrupt stops a task's session and resumes the same session, as `start ... --
// --session ID` does, with the unread messages as its next prompt. It keeps the task's agent, tier,
// mode, worktree and brief, and every relay option of the attempt it replaces; the new attempt's
// reason is `interrupt`, which is neither a counted failure nor a rework round (runs.mjs,
// attemptsOf; report.mjs, reportAttempts). Stopping the session also stops the background commands
// the agent started, and the resumed prompt says so.
//
// Every resume of a task claims the attempt it replaces first (runs.mjs, resumeClaim): a `start` by
// hand, a retry or a rework through startTask (resumeLock), and an interrupt here. So two of them
// never both start the next attempt: an interrupt that loses only adds its message, which the
// winner's resume, or the hook after its next tool call, delivers. The interrupt's sender (`send
// --steer`, `steer`, the dashboard) claims, then starts a detached helper, this file's `resume`, in
// the environment the task was started from (park.mjs, parkEnv), so the resumed attempt reports to
// the same parent at the same depth whoever interrupted it. The helper checks the resume first, with
// every check `start` makes, and stops nothing when one fails. Then it takes the attempt's finish
// notice (none goes out: the session goes on), stops the relay, and resumes the session through
// startTask with the claim. A `stop` or `close` meanwhile wins (stopResume): the helper and startTask
// start nothing once they see it. A resume that fails after the relay stopped releases the claim with
// its error and sends the stopped attempt's finish notice after all.

const SCRIPT = fileURLToPath(import.meta.url);
export const INTERRUPT_BRIEF = "interrupt-resume.md";
const INTERRUPT_LOG = "interrupt.log";
// How long a relay may take to exit after SIGTERM; both relays take about two seconds.
const EXIT_MS = 20000;

// Create `file` holding `value`, whole, only if no file has that name (as park.mjs does). False
// when the name is taken.
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

// Whether the relay a claim recorded ({ pid, started }) still runs: its PID, with the same start time.
function relayRunning(relay) {
  if (!relay?.pid || !exists(relay.pid)) return false;
  return !relay.started || processStarted(relay.pid) === relay.started;
}

// Stop a relay by its PID, with its process group.
function stopRelay(pid) {
  try {
    process.kill(-pid, "SIGTERM"); // detached: the relay leads its own process group
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

// Claim the attempt `task` is in for a resume of kind `kind` ("start", "retry" or "interrupt"):
// { generation, file, record } when this process won it; { busy } (the current claim) when a resume
// holds it or has saved the next attempt; { orphan: pid } when a resume died after starting a relay
// that still runs. The record names this process as its owner, the attempt it replaces, and the
// task's close and stop as it saw them (`since`), and holds `fields`.
export function claimResume(task, kind, fields = {}) {
  const dir = task.outDir;
  for (let tries = 0; tries < 5; tries++) {
    const current = resumeClaim(dir);
    if (current.state === "live" || current.state === "done") return { busy: current };
    if (current.state === "abandoned" && relayRunning(current.record?.relay)) return { orphan: current.record.relay.pid };
    const generation = current.generation + 1;
    const record = {
      kind, claimedAt: new Date().toISOString(), owner: { pid: process.pid, started: processStarted(process.pid) },
      replaces: task.attempt, since: { closedAt: task.closedAt || null, stoppedAt: task.stoppedAt || null }, ...fields,
    };
    const file = resumeFile(dir, generation);
    if (createExclusive(file, record)) return { generation, file, record };
  }
  return { busy: resumeClaim(dir) };
}

// What startTask uses a claim through (as a park claim): `since`; spawned(task), which records the
// relay as soon as it starts; release(error), which gives the claim back; done(task), which records
// the saved attempt.
function claimHandle(claim) {
  let record = claim.record;
  const save = (fields) => writeJson(claim.file, (record = { ...(readJson(claim.file) || record), ...fields }));
  return {
    since: record.since,
    save,
    get record() { return record; },
    // The planned task goes with the relay, so that a claimant after a crash can adopt it (adoptResume).
    spawned: (planned) => save({ relay: { pid: planned.pid, started: processStarted(planned.pid) }, task: planned }),
    release: (error = null) => save({ released: true, releasedAt: new Date().toISOString(), ...(error ? { error } : {}) }),
    done: (saved) => save({ attempt: saved.attempt, pid: saved.pid, resumedAt: saved.startedAt }),
  };
}

// A resume that ended (its owner is gone) after starting its relay and before saving the task leaves
// that relay running with no record. The next claimant (a start, an interrupt, `stop` or `close`)
// adopts it: it saves the attempt the resume had planned, with that relay, keeping a close or stop
// that came since, and starts its finish watcher. Then the relay is the task's attempt, which `stop`
// stops and `status` shows. Returns the saved task; null when there is nothing to adopt, or another
// claimant adopted it first.
export function adoptResume(run, task) {
  const dir = task?.outDir;
  const current = resumeClaim(dir);
  const planned = current.record?.task;
  if (current.state !== "abandoned" || !planned?.id || !relayRunning(current.record.relay)) return null;
  const file = resumeFile(dir, current.generation + 1);
  // The claim carries all that the next adopter needs, should this one end before it saves the task:
  // the relay, the planned task, and the close and stop the resume first saw.
  const since = current.record.since || {};
  const record = {
    kind: "adopt", claimedAt: new Date().toISOString(), owner: { pid: process.pid, started: processStarted(process.pid) },
    replaces: task.attempt, takesOver: current.generation, relay: current.record.relay, task: planned, since,
  };
  if (!createExclusive(file, record)) return null;
  const latest = loadTask(run, task.id);
  // An adopter that ended after it saved the task: the attempt is recorded already, so only the
  // claim is completed, and nothing saved since is overwritten.
  if (latest && latest.attempt >= planned.attempt) {
    writeJson(file, { ...record, attempt: latest.attempt, pid: latest.pid, resumedAt: latest.startedAt, adopted: true });
    return latest.attempt === planned.attempt ? latest : null;
  }
  const saved = {
    ...planned, pid: current.record.relay.pid,
    ...(latest?.closedAt && latest.closedAt !== since.closedAt ? { closedAt: latest.closedAt } : {}),
    ...(latest?.stoppedAt && latest.stoppedAt !== since.stoppedAt ? { stoppedAt: latest.stoppedAt } : {}),
  };
  saveTask(run, saved);
  writeJson(file, { ...record, attempt: saved.attempt, pid: saved.pid, resumedAt: saved.startedAt, adopted: true });
  if (saved.startedBy || saved.babysit) watchForFinish(run, saved);
  return saved;
}

// For startTask: claim the attempt `task` is in before a resume writes anything. Null when the task
// has no attempt folder; { refused } when another resume holds it, or when an earlier resume's
// relay was adopted instead; else the claim's handle.
export function resumeLock(run, task, kind = "start") {
  if (!task?.attempt || !task.outDir || !fs.existsSync(task.outDir)) return null;
  const claim = claimResume(task, kind);
  if (claim.orphan) {
    const adopted = adoptResume(run, task);
    return { refused: adopted
      ? `task ${shownName(task)}'s earlier resume ended after starting its relay (pid ${adopted.pid}), which still runs: it is now attempt ${adopted.attempt}, so nothing new was started`
      : `task ${shownName(task)}'s earlier resume ended after starting its relay (pid ${claim.orphan}), which another command is taking over right now; run \`status\` to see it` };
  }
  if (claim.busy) {
    const r = claim.busy.record;
    const who = r?.kind === "interrupt" ? "an interrupt is delivering a message" : r?.kind === "adopt" ? "another command is taking over the relay an earlier resume left" : `by \`${r?.kind || "start"}\``;
    return { refused: r?.attempt ? `task ${shownName(task)} was resumed meanwhile, in attempt ${r.attempt}; run \`status\` to see it` : `task ${shownName(task)} is being resumed right now (${who}); run \`status\` to see its new attempt` };
  }
  return claimHandle(claim);
}

// For `stop` and `close`: a resume that holds the task between its two relays. `mark` records the
// stop or close on the task first, so that a resume that has not started its relay starts nothing
// (startTask finds the mark) and one that has keeps it. Then this stops the relay the task still
// runs, if any, and the one the resume started, and waits up to 20 seconds for the resume to end.
// Null when no resume holds the task: the caller goes on as before. { task } when the resume saved
// an attempt whose relay runs, which the caller then stops; { text } when nothing runs any more.
export function stopResume(run, task, mark) {
  // A relay that a resume left running when it ended becomes the task's attempt, which the caller stops.
  const adopted = adoptResume(run, task);
  if (adopted) return { task: adopted };
  const held = resumeClaim(task.outDir);
  if (held.state === "done") {
    const latest = loadTask(run, task.id);
    return latest && latest.attempt !== task.attempt && relayAlive(latest.pid, null, latest.outDir) ? { task: latest } : null;
  }
  if (held.state !== "live") return null;
  mark();
  const stopped = [];
  if (relayAlive(task.pid, null, task.outDir)) {
    stopRelay(task.pid);
    stopped.push(task.pid);
  }
  const until = Date.now() + EXIT_MS;
  for (;;) {
    const claim = resumeClaim(task.outDir);
    const relay = claim.record?.relay;
    if (relay?.pid && !stopped.includes(relay.pid) && relayRunning(relay)) {
      stopRelay(relay.pid);
      stopped.push(relay.pid);
    }
    if (claim.state !== "live" || Date.now() >= until) {
      const latest = loadTask(run, task.id) || task;
      if (claim.record?.attempt && relayAlive(latest.pid, null, latest.outDir)) return { task: latest };
      const kind = claim.record?.kind;
      const what = kind === "interrupt" ? "an interrupt was resuming its session" : kind === "adopt" ? "another command was taking over its relay" : `\`${kind || "start"}\` was resuming it`;
      return { text: `stopped ${shownName(task)} while ${what}${stopped.length ? ` (pid ${stopped.join(", ")})` : ""}; it starts no new attempt${claim.state === "live" ? ", though that resume has not ended yet" : ""}` };
    }
    spawnSync("sleep", ["0.1"]);
  }
}

// Start the helper that resumes the claimed task, detached, logging to the attempt's interrupt.log.
// Releases the claim when it cannot start.
export function launchInterrupt(run, task, claim) {
  let log = null;
  try {
    log = fs.openSync(path.join(task.outDir, INTERRUPT_LOG), "a");
    const child = spawn(process.execPath, [SCRIPT, "resume", run.dir, task.id, String(task.attempt), String(claim.generation)], {
      cwd: run.dir,
      detached: true,
      stdio: ["ignore", log, log],
      env: parkEnv(task),
    });
    child.on("error", () => {});
    child.unref();
    if (!child.pid) throw new Error("the helper did not start");
    // The helper owns the claim from now on: when it ends without a word, the claim is abandoned
    // and the next sender takes it over, however long this process lives. The handoff goes in a
    // file of its own, written once (runs.mjs, resumeHandoffFile): from here only the helper writes
    // the claim's record, so neither process can overwrite what the other wrote.
    try {
      createExclusive(resumeHandoffFile(task.outDir, claim.generation), { pid: child.pid, started: processStarted(child.pid), at: new Date().toISOString() });
    } catch {
      // Without it the claim's owner is this process until the helper names itself in the record.
    }
    return child.pid;
  } catch (error) {
    writeJson(claim.file, { ...claim.record, released: true, releasedAt: new Date().toISOString(), error: `the interrupt could not start: ${error.message}` });
    return null;
  } finally {
    if (log !== null) fs.closeSync(log);
  }
}

// Wait up to `ms` for the resume claimed at `generation` in attempt folder `dir` to end: the claim
// record once the resumed attempt is saved or the claim was released, else null.
export function awaitInterrupt(dir, generation, ms = 45000) {
  const until = Date.now() + ms;
  for (;;) {
    const record = readJson(resumeFile(dir, generation));
    if (record?.attempt || record?.released) return record;
    if (resumeClaim(dir).state === "abandoned" || Date.now() >= until) return null;
    spawnSync("sleep", ["0.1"]);
  }
}

// The brief that resumes an interrupted session: why it was stopped and what that stopped. It holds
// no data: what the session was doing, and the messages, follow as data (interruptData).
export const interruptBrief = () => [
  "## You were interrupted to deliver a message",
  "",
  "Your session was stopped and resumed so that the messages sent to you, below, reach you now.",
  "",
  `- Stopping the session also stopped every command you had started in the background. Start again what you still need, in the background, and wait for it with \`node ${CLI_PATH} nap <duration>\`, \`wait\` or \`pr-watch\`, which return as soon as a message arrives.`,
  "- A tool call that was running when the session stopped was cut off: check what it did before you repeat it.",
  "- Your task and your brief are unchanged. Handle the messages first, then carry on where you left off, and finish as your brief says, with its final report.",
  "",
].join("\n");

// What the session was doing when it was stopped, and every message, in full. Passed to startTask as
// data, so no text of a message is ever taken for part of the brief.
export function interruptData(run, task, claim, messages) {
  const lines = [claim.was === "idle"
    ? `You had ended your turn and were waiting on your own background ${claim.background ? `command \`${shorten(claim.background, 200)}\`` : "work"}, so nothing would have reached you until that ended. It was stopped with the session.`
    : "You were not in a shell command (you were in a model call or another tool), so nothing would have reached you before your next tool call."];
  if (!messages.length) lines.push("", `No message is unread any more; check with \`node ${CLI_PATH} inbox ${run.id} ${task.id} --ack\`.`);
  messages.forEach((m, i) => {
    lines.push("", `### ${messages.length > 1 ? `${i + 1}. ` : ""}${senderLabel(m)} (${m.time}), message ${m.id}`, "", m.text.trim());
    if (m.from === "user") lines.push("", replyHint(run.id, task.id));
  });
  return lines.join("\n");
}

// The helper: resume the task whose attempt `n` the claim `generation` holds. Run in the task's own
// environment (launchInterrupt). Returns what it recorded in the claim.
export async function runInterrupt(runDir, id, n, generation) {
  const run = { ...readJson(path.join(runDir, "run.json")), dir: runDir };
  const task = loadTask(run, id);
  const dir = path.join(taskDir(run, id), `attempt-${n}`);
  const file = resumeFile(dir, generation);
  const first = readJson(file);
  if (!task || task.attempt !== n || first?.kind !== "interrupt" || first.released || first.attempt || resumeClaim(dir).generation !== generation) return null;
  // From here this process owns the claim, whether or not the sender lives on: the transfer is
  // written, then read back, and a helper that does not hold the claim does nothing.
  const claim = claimHandle({ file, record: first });
  claim.save({ owner: { pid: process.pid, started: processStarted(process.pid) }, helper: process.pid });
  const held = resumeClaim(dir);
  if (held.generation !== generation || held.record?.owner?.pid !== process.pid || held.record.helper !== process.pid || held.state !== "live") return null;
  const fail = (error, fields = {}) => (claim.save({ released: true, releasedAt: new Date().toISOString(), error, ...fields }), claim.record);
  // A stop or close that came since the claim (stopResume) wins.
  const ended = () => {
    const latest = loadTask(run, id);
    return !latest || latest.attempt !== n || (latest.stoppedAt || null) !== (first.since?.stoppedAt ?? null) || (latest.closedAt || null) !== (first.since?.closedAt ?? null);
  };
  const { NOTICE_FILE, sendFinishNotice } = await import("./finish-notice.mjs");
  const { StartRefused, startTask } = await import("./commands/start.mjs");
  const brief = path.join(dir, INTERRUPT_BRIEF);
  const args = (check, briefData = null) => ({
    _: [run.dir, id], agent: task.agent, brief, briefData, passthrough: ["--session", first.session],
    // The relay's options, kept; --force: the task holds its slot in the parallel limit already;
    // --no-escalate: an interrupt keeps the tier.
    relayFrom: Array.isArray(task.argv) ? task.argv : [], force: true, "no-escalate": true,
    ...(task.readOnly ? { "read-only": true } : {}), parkClaim: claim, check,
  });
  // Every check a start makes, before anything stops: a resume that cannot start stops nothing.
  try {
    fs.writeFileSync(brief, interruptBrief());
    startTask(args(true), { attemptReason: "interrupt" });
  } catch (error) {
    if (!(error instanceof StartRefused)) throw error;
    return fail(error.message, { stopped: false });
  }
  if (ended()) return fail("the task was stopped or closed before its session was stopped", { stopped: false });
  // The stopped attempt sends no finish notice: its session goes on in the next attempt. Taken
  // before the relay stops, so its finish watcher finds the notice taken. The claim names this helper
  // and its resume claim, so that the watcher waits for the helper to end, and sends the notice after
  // all when it ended before it started the next attempt (finish-notice.mjs, stranded).
  const notice = path.join(dir, NOTICE_FILE);
  const interrupt = { generation, pid: process.pid, started: claim.record.owner?.started ?? null };
  if (!createExclusive(notice, { attempt: n, claimedAt: new Date().toISOString(), skipped: "interrupted to deliver a message: the next attempt resumes the same session", interrupt })) {
    return fail("the attempt ended before it could be interrupted", { stopped: false });
  }
  // A resume that fails after the relay stopped: the attempt has ended, so its parent is told after all.
  const giveNotice = () => {
    fs.rmSync(notice, { force: true });
    if (!relayAlive(task.pid, null, task.outDir)) sendFinishNotice(run.dir, id, n, { pid: task.pid });
  };
  // An attempt that finished on its own meanwhile is not resumed: its result stands.
  if (!relayAlive(task.pid, null, task.outDir)) {
    fail("the attempt finished before it could be interrupted", { stopped: false });
    giveNotice();
    return claim.record;
  }
  // The last look before the session stops: a command that started since the sender planned the
  // interrupt counts too. A publishing command is never ended with the session, and another shell
  // command is stopped in its place, which delivers the messages as well. What remains is the
  // moment between this read and the signal, which nothing outside the agent can close: the agent
  // starts its commands without asking anyone.
  const now = planSteer(task, describe(run, task));
  if (!now.resume) {
    fs.rmSync(notice, { force: true }); // the attempt runs on: its finish notice goes out as usual
    if (!now.stop) return fail(now.wait, { stopped: false });
    markSteered(taskDir(run, id), readInbox(taskDir(run, id)).filter((m) => !m.read).map((m) => m.id), now.stop.command, first.by || null);
    stopCommand(now);
    claim.save({ released: true, releasedAt: new Date().toISOString(), stopped: false, command: shorten(now.stop.command), seconds: now.stop.seconds ?? null });
    return claim.record;
  }
  stopRelay(task.pid);
  claim.save({ stopped: true });
  if (!waitForExit(task.pid, EXIT_MS, task.outDir)) {
    fs.rmSync(notice, { force: true });
    return fail(`its relay (pid ${task.pid}) did not exit within ${EXIT_MS / 1000} seconds of SIGTERM`);
  }
  const inbox = taskDir(run, id);
  const messages = readInbox(inbox).filter((m) => !m.read);
  let started;
  try {
    if (ended()) throw new StartRefused(`task ${id} was stopped or closed while this resume was starting, so it started nothing`);
    // startTask takes the claim as a park resume's: it refuses when a stop or close came since the
    // claim, and records the relay as soon as it starts.
    ({ task: started } = startTask(args(false, interruptData(run, task, first, messages)), { attemptReason: "interrupt" }));
  } catch (error) {
    fail(error instanceof StartRefused ? error.message : `the resume failed: ${error.message}`);
    giveNotice();
    if (!(error instanceof StartRefused)) throw error;
    return claim.record;
  }
  // Only the messages the brief holds were delivered.
  markRead(inbox, messages.map((m) => m.id), { attempt: started.attempt });
  claim.save({ delivered: messages.map((m) => m.id) });
  return claim.record;
}

const real = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(SCRIPT)) {
  const [command, runDir, id, attempt, generation] = process.argv.slice(2);
  if (command !== "resume" || !runDir || !id || !(Number(attempt) > 0) || !(Number(generation) > 0)) {
    process.stderr.write("usage: steer.mjs resume RUN_DIR TASK ATTEMPT GENERATION\n");
    process.exit(2);
  }
  runInterrupt(path.resolve(runDir), id, Number(attempt), Number(generation)).then(
    (record) => {
      if (record?.error) process.stderr.write(`${new Date().toISOString()} interrupt: ${record.error}\n`);
    },
    (error) => {
      process.stderr.write(`${new Date().toISOString()} interrupt: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    },
  );
}
