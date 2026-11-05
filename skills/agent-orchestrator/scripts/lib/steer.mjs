// Steering: a message that must reach an agent now, not after its current command. Messages reach
// an agent when a tool call returns (the orch-inbox hook) or when it runs `inbox`, so a long
// command (a polling script, a test run) holds them back. Steering stops the agent's pending
// foreground shell command, so the call returns at once and the message reaches the agent, which
// reruns the command if it still needs it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

// The shell the agent's relay runs `command` in, and every process under it, deepest first.
export function commandTree(relayPid, command, rows = processTable()) {
  if (!rows) return null;
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
  const under = (pid) => (children.get(pid) || []).flatMap((child) => [child, ...under(child.pid)]);
  const fragment = inner(command).slice(0, 80);
  const shell = fragment && under(relayPid).find((row) => SHELL.test(row.command) && bare(row.command).includes(fragment));
  if (!shell) return null;
  const tree = [shell, ...under(shell.pid)];
  return { shell, pids: tree.map((row) => row.pid).reverse() };
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
