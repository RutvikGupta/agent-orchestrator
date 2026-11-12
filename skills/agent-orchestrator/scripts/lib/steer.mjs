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
import { summarizeEvents } from "./events.mjs";
import { markRead, readInbox, replyHint, senderLabel } from "./inbox.mjs";
import { parkEnv } from "./park.mjs";
import { COMMAND_AGENT } from "./policy.mjs";
import { interruptFile, interruptState, loadTask, processStarted, relayAlive, taskDir, waitForExit } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";

// Commands that publish or rewrite history are never stopped part-way: the message waits.
const PROTECTED = /\b(git\s+(commit|push|rebase|merge|cherry-pick|am|tag|reset|checkout|switch|stash)|gt\s+(submit|sync|restack|modify|create|move|fold|split|squash)|gh\s+(pr\s+(create|merge|edit|ready|close|comment|review)|api\s+(-X|--method))|npm\s+publish|terraform\s+apply|alembic\s+upgrade)\b/;
const SHELL = /^\/bin\/(ba|z)?sh -l?c /;

// The command a Codex agent is running: a command_execution item that started and has not completed.
export function pendingCodexCommand(eventsFile) {
  let text;
  try {
    text = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return null;
  }
  const open = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes("command_execution")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.item?.type !== "command_execution") continue;
    if (e.type === "item.started") open.set(e.item.id, e.item.command);
    else if (e.type === "item.completed") open.delete(e.item.id);
  }
  const [id, command] = [...open].at(-1) || [];
  return command ? { id, command: String(command), seconds: null } : null;
}

// The last Bash call in the attempt's event stream that has no result yet, if it runs in the
// foreground: { id, command, seconds } (seconds from its latest progress heartbeat, if any).
export function pendingCommand(eventsFile) {
  let text;
  try {
    text = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return null;
  }
  let pending = null;
  const done = new Set();
  let seconds = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"tool_progress"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "tool_progress" && pending && e.parent_tool_use_id === pending.id) seconds = e.elapsed_time_seconds ?? seconds;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_use") {
        pending = c;
        seconds = null;
      } else if (c?.type === "tool_result") done.add(c.tool_use_id);
    }
  }
  if (!pending || done.has(pending.id) || pending.name !== "Bash" || pending.input?.run_in_background) return null;
  const command = String(pending.input?.command || "");
  return command ? { id: pending.id, command, seconds } : null;
}

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
//   { stop: { command, pids, seconds } }      stop its foreground shell command (stopCommand);
//   { resume: { was, doing, session, background } }  interrupt its session (startInterrupt);
//   { wait: reason, refused? }                do nothing now: the message waits for the agent;
//                                             `refused` when an interrupt would do harm.
export function planSteer(task, row = null) {
  const events = path.join(task.outDir || "", "events.jsonl");
  const pending = task.agent === "codex" ? pendingCodexCommand(events) : pendingCommand(events);
  if (!pending) return planResume(task, row);
  if (PROTECTED.test(pending.command)) return { wait: `the agent is running \`${shorten(pending.command)}\`, which is not stopped part-way` };
  const tree = commandTree(task.pid, pending.command);
  if (!tree) return { wait: "the agent's command could not be matched to a process" };
  return { stop: { command: pending.command, pids: tree.pids, seconds: pending.seconds } };
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
  const summary = summarizeEvents(task.agent, path.join(task.outDir || "", "events.jsonl"), task.cd);
  const session = row?.session || summary.sessionId || null;
  if (!session) return refused("its session id is not known yet");
  if (row?.idle) return { resume: { was: "idle", doing: `ended its turn and waited on its own background ${row.idle.background ? `command \`${shorten(row.idle.background)}\`` : "work"}`, session, background: row.idle.background || null } };
  const tool = task.agent === "claude" ? summary.openTool?.name : null;
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
// mode, worktree and brief; the new attempt's reason is `interrupt`, which is neither a counted
// failure nor a rework round (runs.mjs, attemptsOf; report.mjs, reportAttempts). Stopping the session
// also stops the background commands the agent started, and the resumed prompt says so.
//
// The sender (`send --steer`, `steer`, the dashboard) claims the interrupted attempt's folder first
// (claimInterrupt; runs.mjs, interruptState), so two senders never start two sessions: the one that
// loses only adds its message, which the winner's resume, or the hook after its next tool call,
// delivers. The winner starts a detached helper, this file's `resume`, in the environment the task
// was started from (park.mjs, parkEnv), so the resumed attempt reports to the same parent at the
// same depth whoever interrupted it. The helper takes the attempt's finish notice first (none goes
// out: the session goes on), stops the relay, writes the brief, and resumes the session through
// startTask with the claim, which refuses when a `stop` or `close` came meanwhile. A resume that fails
// releases the claim with its error and sends the stopped attempt's finish notice after all.

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
  }
  finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Claim the task's current attempt for an interrupt: { generation, file, record } when this process
// won it, or { busy: true } when another interrupt holds it. `fields` are recorded in the claim.
export function claimInterrupt(task, fields = {}) {
  const dir = task.outDir;
  for (let tries = 0; tries < 5; tries++) {
    const current = interruptState(dir);
    if (current.state === "live" || current.state === "done") return { busy: true };
    const generation = current.generation + 1;
    const record = { claimedAt: new Date().toISOString(), owner: { pid: process.pid, started: processStarted(process.pid) }, interrupted: task.attempt, ...fields };
    const file = interruptFile(dir, generation);
    if (createExclusive(file, record)) return { generation, file, record };
  }
  return { busy: true };
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
    return child.pid;
  } catch (error) {
    writeJson(claim.file, { ...claim.record, released: true, releasedAt: new Date().toISOString(), error: `the interrupt could not start: ${error.message}` });
    return null;
  } finally {
    if (log !== null) fs.closeSync(log);
  }
}

// Wait up to `ms` for the interrupt claimed at `generation` in attempt folder `dir` to end: the claim
// record once the resumed attempt is saved or the claim was released, else null.
export function awaitInterrupt(dir, generation, ms = 45000) {
  const until = Date.now() + ms;
  for (;;) {
    const record = readJson(interruptFile(dir, generation));
    if (record?.attempt || record?.released) return record;
    if (interruptState(dir).state === "abandoned" || Date.now() >= until) return null;
    spawnSync("sleep", ["0.1"]);
  }
}

// The brief that resumes an interrupted session: why it was stopped, what that stopped, and every
// message, in full.
export function interruptBrief(run, task, claim, messages) {
  const was = claim.was === "idle"
    ? `You had ended your turn and were waiting on your own background ${claim.background ? `command \`${shorten(claim.background, 200)}\`` : "work"}, so nothing would have reached you until that ended.`
    : "You were not in a shell command (you were in a model call or another tool), so nothing would have reached you before your next tool call.";
  const lines = [
    "## You were interrupted to deliver a message",
    "",
    `Your session was stopped and resumed so that ${messages.length === 1 ? "the message below reaches" : "the messages below reach"} you now. ${was}`,
    "",
    `- Stopping the session also stopped every command you had started in the background${claim.background ? `, including \`${shorten(claim.background, 200)}\`` : ""}. Start again what you still need, in the background, and wait for it with \`node ${CLI_PATH} nap <duration>\`, \`wait\` or \`pr-watch\`, which return as soon as a message arrives.`,
    "- A tool call that was running when the session stopped was cut off: check what it did before you repeat it.",
    "- Your task and your brief are unchanged. Handle the message first, then carry on where you left off, and finish as your brief says, with its final report.",
  ];
  if (!messages.length) lines.push("", `No message is unread any more; check with \`node ${CLI_PATH} inbox ${run.id} ${task.id} --ack\`.`);
  messages.forEach((m, i) => {
    lines.push("", `### ${messages.length > 1 ? `${i + 1}. ` : ""}${senderLabel(m)} (${m.time}), message ${m.id}`, "", m.text.trim());
    if (m.from === "user") lines.push("", replyHint(run.id, task.id));
  });
  return `${lines.join("\n")}\n`;
}

// The helper: resume the task whose attempt `n` the claim `generation` holds. Run in the task's own
// environment (launchInterrupt). Returns what it recorded in the claim.
export async function runInterrupt(runDir, id, n, generation) {
  const run = { ...readJson(path.join(runDir, "run.json")), dir: runDir };
  const task = loadTask(run, id);
  const dir = path.join(taskDir(run, id), `attempt-${n}`);
  const file = interruptFile(dir, generation);
  let record = readJson(file);
  if (!task || task.attempt !== n || !record || record.released || record.attempt || interruptState(dir).generation !== generation) return null;
  // From here this process owns the claim: the sender may exit.
  record = { ...record, owner: { pid: process.pid, started: processStarted(process.pid) }, helper: process.pid };
  writeJson(file, record);
  const save = (fields) => writeJson(file, (record = { ...(readJson(file) || record), ...fields }));
  const fail = (error) => (save({ released: true, releasedAt: new Date().toISOString(), error }), record);
  const { NOTICE_FILE, sendFinishNotice } = await import("./finish-notice.mjs");
  // The stopped attempt sends no finish notice: its session goes on in the next attempt. Taken
  // before the relay stops, so its finish watcher finds the notice taken.
  const notice = path.join(dir, NOTICE_FILE);
  try {
    fs.writeFileSync(notice, `${JSON.stringify({ attempt: n, claimedAt: new Date().toISOString(), skipped: "interrupted to deliver a message: the next attempt resumes the same session" })}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return fail("the attempt ended before it could be interrupted");
  }
  // A resume that fails after the relay stopped: the attempt has ended, so its parent is told after all.
  const giveNotice = () => {
    fs.rmSync(notice, { force: true });
    if (!relayAlive(task.pid, null, task.outDir)) sendFinishNotice(run.dir, id, n, { pid: task.pid });
  };
  // An attempt that finished on its own meanwhile is not resumed: its result stands.
  if (!relayAlive(task.pid, null, task.outDir)) {
    fail("the attempt finished before it could be interrupted");
    giveNotice();
    return record;
  }
  try {
    process.kill(-task.pid, "SIGTERM"); // detached: the relay leads its own process group
  } catch {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {}
  }
  if (!waitForExit(task.pid, EXIT_MS, task.outDir)) {
    fs.rmSync(notice, { force: true });
    return fail(`its relay (pid ${task.pid}) did not exit within ${EXIT_MS / 1000} seconds of SIGTERM`);
  }
  const inbox = taskDir(run, id);
  const messages = readInbox(inbox).filter((m) => !m.read);
  const brief = path.join(dir, INTERRUPT_BRIEF);
  const { StartRefused, startTask } = await import("./commands/start.mjs");
  const timeoutAt = Array.isArray(task.argv) ? task.argv.indexOf("--timeout") : -1;
  let started;
  try {
    fs.writeFileSync(brief, interruptBrief(run, task, record, messages));
    // startTask takes the claim as a park resume's: it refuses when a stop or close came meanwhile,
    // and records the relay as soon as it starts. --force: the task holds its slot in the parallel
    // limit already. --no-escalate: an interrupt keeps the tier.
    ({ task: started } = startTask({
      _: [run.dir, id], agent: task.agent, brief, passthrough: ["--session", record.session],
      force: true, "no-escalate": true,
      ...(task.readOnly ? { "read-only": true } : {}),
      ...(timeoutAt >= 0 && task.argv[timeoutAt + 1] ? { timeout: task.argv[timeoutAt + 1] } : {}),
      parkClaim: {
        spawned: (planned) => save({ relay: { pid: planned.pid, started: processStarted(planned.pid) } }),
        release: () => {},
        done: (saved) => save({ attempt: saved.attempt, pid: saved.pid, resumedAt: saved.startedAt }),
      },
    }, { attemptReason: "interrupt" }));
  } catch (error) {
    fail(error instanceof StartRefused ? error.message : `the resume failed: ${error.message}`);
    giveNotice();
    if (!(error instanceof StartRefused)) throw error;
    return record;
  }
  // Only the messages the brief holds were delivered.
  markRead(inbox, messages.map((m) => m.id), { attempt: started.attempt });
  save({ delivered: messages.map((m) => m.id) });
  return record;
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
