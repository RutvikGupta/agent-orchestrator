// Finds the process that still runs a Claude or Codex session, so that no second process is started
// on it. Two processes on one session write one transcript and leave the dashboard showing the
// wrong state. Used by the resume-guard hook (hooks/orch-resume-guard.mjs) and by `start --session`.
//
// Every lookup fails open: a CLI that fails or times out, output that does not parse, or an id that
// is malformed or ambiguous finds nothing, so a legitimate resume of a finished session never waits
// on a guess.

import { spawnSync } from "node:child_process";
import path from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"; // the shape of a session id (a UUID)

// An id as typed, as the lowercase hex digits it names with the dashes removed, or null when it is
// not an id. An id is a UUID or a prefix of one: at least 8 hex digits, with the dashes of a UUID in
// their places, or none.
export function sessionIdPrefix(word) {
  const id = String(word ?? "").toLowerCase();
  const shaped = id.includes("-")
    ? id.length <= TEMPLATE.length && [...id].every((c, i) => (TEMPLATE[i] === "-" ? c === "-" : /[0-9a-f]/.test(c)))
    : /^[0-9a-f]{8,32}$/.test(id);
  const bare = id.replace(/-/g, "");
  return shaped && bare.length >= 8 ? bare : null;
}

const bare = (id) => String(id).toLowerCase().replace(/-/g, "");

// A shell command splits into the commands it runs at these. Quotes do not split: a command in
// quotes, as `tmux new-session '...'` or `bash -c "..."` takes, is read in place.
const SEPARATOR = /&&|\|\||\$\(|[;&|\n\r`()]/;
const BOUNDARY = String.raw`(?:^|[\s'"\\])`;
const END = String.raw`(?=$|[\s'"\\])`;
const CLAUDE = new RegExp(String.raw`(?:^|[\s'"=/])claude(?:-code)?${END}`);
const CODEX = new RegExp(String.raw`(?:^|[\s'"=/])codex${END}`);
const CLAUDE_RESUME = new RegExp(String.raw`${BOUNDARY}(?:--resume|-r)(?:=|\s+)[\\'"]*([0-9a-fA-F-]+)${END}`, "g");
const FORK = new RegExp(`${BOUNDARY}--fork-session${END}`);
const CODEX_RESUME = new RegExp(`${BOUNDARY}resume${END}`);

// The sessions a shell command resumes, as [{ agent, id }] with `id` the hex digits of the id typed
// (see sessionIdPrefix): `claude --resume <id>`, `claude -r <id>`, `claude --resume=<id>`, `codex
// resume <id>` and `codex exec resume <id>`, also inside quotes. `claude --resume <id> --fork-session`
// starts a new session that copies the old one, so it is not a second process on the old one.
// Without an id (`--resume` alone, `codex resume --last`) or with a name in its place it finds nothing.
export function resumeInvocations(command) {
  const found = [];
  for (const part of String(command ?? "").split(SEPARATOR)) {
    if (CLAUDE.test(part) && !FORK.test(part)) {
      for (const match of part.matchAll(CLAUDE_RESUME)) {
        const id = sessionIdPrefix(match[1]);
        if (id) found.push({ agent: "claude", id });
      }
    }
    if (CODEX.test(part)) {
      const at = part.search(CODEX_RESUME);
      if (at >= 0) {
        const id = part.slice(at).split(/[\s'"\\]+/).slice(1).map(sessionIdPrefix).find(Boolean);
        if (id) found.push({ agent: "codex", id });
      }
    }
  }
  return found.filter((a, i) => found.findIndex((b) => b.agent === a.agent && b.id === a.id) === i);
}

// Whether a process exists. A process that another user owns (EPERM) exists too.
export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The live process of the Claude session that `id` names (an id from sessionIdPrefix), from
// `claude agents --json`: { sessionId, name, pid }, or null. A session is live while a row of it has
// a process that exists and is not a finished background job. A prefix that several live sessions
// share names none of them. Rows for `skip` (a session id) are left out: the caller's own session.
// `timeoutMs` bounds the listing.
export function liveClaudeSession(id, { timeoutMs = 4000, skip = null } = {}) {
  const result = spawnSync(process.env.AGENT_ORCH_CLAUDE_BIN || "claude", ["agents", "--json"], {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const live = rows.filter((row) => row && typeof row.sessionId === "string" && bare(row.sessionId).startsWith(id)
    && row.state !== "done" && processExists(row.pid) && (!skip || bare(row.sessionId) !== bare(skip)));
  if (new Set(live.map((row) => bare(row.sessionId))).size !== 1) return null;
  const row = live[0];
  return { sessionId: row.sessionId, name: typeof row.name === "string" && row.name ? row.name : null, pid: row.pid };
}

// Whether a command line is a Codex process: the program is `codex`, or a script named `codex` that
// `node` (or another runtime) runs. A shell, `tail` or `grep` whose arguments only mention a
// Codex session's file or command is not one.
function codexProcess(command) {
  const words = command.trim().split(/\s+/);
  const program = path.basename(words[0] ?? "");
  if (/^codex/.test(program)) return true;
  if (!/^(?:node|nodejs|bun|deno)$/.test(program)) return false;
  const script = words.slice(1).find((word) => !word.startsWith("-"));
  return Boolean(script) && /^codex/.test(path.basename(script));
}

// The live process of the Codex session that `id` names (an id from sessionIdPrefix): { sessionId,
// name: null, pid }, or null. Codex has no listing like Claude's, so this reads the process table
// once, and takes the first Codex process whose command line holds the id. `sessionId` is the full
// id when the command line has one. The caller's own process and its parent (a hook runs under them)
// are never taken.
export function liveCodexSession(id, { timeoutMs = 2000 } = {}) {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === process.ppid) continue;
    if (!codexProcess(match[2]) || !bare(match[2]).includes(id)) continue;
    const full = (match[2].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).find((uuid) => bare(uuid).startsWith(id));
    return { sessionId: full || id, name: null, pid };
  }
  return null;
}

// Why a second process on a running session is refused, and what to do instead. `live` is a result
// of liveClaudeSession or liveCodexSession; `agent` is "claude" or "codex". Only a Claude session
// has a name to message it by.
export function liveSessionReason(live, agent = "claude") {
  const named = live.name ? ` as "${live.name}"` : "";
  const how = agent !== "claude"
    ? "if it is an orch task, use orch.mjs send; otherwise ask the user, or message it from the terminal it runs in."
    : `SendMessage to ${live.name ? `"${live.name}"` : "it"} (names change when a session restarts: find it by its session id in ListAgents or claude agents --json). If it is an orch task, use orch.mjs send.`;
  return `Session ${live.sessionId} is still running${named} (pid ${live.pid}). Starting a second process on it makes two processes write one session. Message it instead: ${how}`;
}
