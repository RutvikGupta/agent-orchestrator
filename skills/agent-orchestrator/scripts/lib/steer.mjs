// Steering: a message that must reach an agent now, not after its current command. Messages reach
// an agent when a tool call returns (the orch-inbox hook) or when it runs `inbox`, so a long
// command (a polling script, a test run) holds them back. Steering stops the agent's pending
// foreground shell command, so the call returns at once and the message reaches the agent, which
// reruns the command if it still needs it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, SKILL_ROOTS } from "./config.mjs";

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

// What steering a task would do now: { stop: { command, pids, seconds } } or { wait: reason }.
export function planSteer(task) {
  const events = path.join(task.outDir || "", "events.jsonl");
  const pending = task.agent === "codex" ? pendingCodexCommand(events) : pendingCommand(events);
  if (!pending) return { wait: "the agent is not in a shell command, so it reads the message after its current step" };
  if (PROTECTED.test(pending.command)) return { wait: `the agent is running \`${shorten(pending.command)}\`, which is not stopped part-way` };
  const tree = commandTree(task.pid, pending.command);
  if (!tree) return { wait: "the agent's command could not be matched to a process" };
  return { stop: { command: pending.command, pids: tree.pids, seconds: pending.seconds } };
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
