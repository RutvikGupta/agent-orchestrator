// Structured agent reports, scope checks against the plan, and task health.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CACHE_PATH, CLI_PATH } from "./config.mjs";
import { commandRuns, stuckOf, summarizeEvents } from "./events.mjs";
import { formatElapsed, unwrapShell } from "./format.mjs";
import { attemptReasonOf } from "./lifecycle.mjs";
import { readJson, tailText, writeJson } from "./util.mjs";

const QUIET_MS = 15 * 60 * 1000;
// A 5xx status counts only as a status: alone on its line, after HTTP/status/error/code, or before
// its reason phrase. A bare number such as "512 tests" is not one.
const TRANSIENT_RE = /overloaded_error|\b(?:provider|server|service|api)\b[^\n]{0,40}\boverload(?:ed)?\b|\boverload(?:ed)?\b[^\n]{0,40}\b(?:provider|server|service|api)\b|^\s*5\d\d\s*$|\b(?:HTTP|status|error|code)[:\s]+5\d\d\b|\b5\d\d\s+(?:Internal|Bad Gateway|Service Unavailable|Gateway Timeout)|\b5xx\b|ECONNRESET|ETIMEDOUT|socket hang up|stream disconnected|internal server error/im;
// Final reports describe the task's own failures too. Only provider-formatted errors in that
// channel justify restarting the agent; ordinary mentions of HTTP/network errors do not.
const PROVIDER_MESSAGE_RE = /^\s*(?:API Error:\s*(?:5\d\d|5xx)\b|(?:Error:\s*)?(?:overloaded_error|api_error)\b)|"type"\s*:\s*"(?:overloaded_error|api_error)"/im;
const STOP_RE = /\b(?:SIGTERM|SIGINT|SIGKILL|SIGHUP|cancelled|canceled|interrupted)\b|\bstop (?:request|requested)\b|\b(?:killed|terminated) by\b/i;
const PR_WATCH_RE = /(?:^|[\s/"'])orch\.mjs["']?\s+pr-watch(?:\s|$)/;

function parseReport(message) {
  const blocks = String(message || "").matchAll(/^[\t ]*```orch-result[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*(?=\r?$)/gm);
  let last;
  for (const block of blocks) last = block[1];
  if (last === undefined) return null;
  try {
    const value = JSON.parse(last.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("orch-result must contain a JSON object");
    return {
      outcome: ["done", "partial", "blocked"].includes(value.outcome) ? value.outcome : null,
      ...Object.fromEntries(["changed", "checks", "decisions", "unresolved"].map((key) => [key, Array.isArray(value[key]) ? value[key] : []])),
    };
  } catch (error) {
    return { invalid: true, error: error.message };
  }
}

// Git quotes unusual names using C escapes (including octal UTF-8 bytes).
function unquote(file) {
  if (!file.startsWith('"') || !file.endsWith('"')) return file;
  const escapes = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };
  const parts = [];
  for (const token of file.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
    parts.push(token[2] !== undefined ? Buffer.from(token[2])
      : /^[0-7]+$/.test(token[1]) ? Buffer.from([parseInt(token[1], 8)])
        : Buffer.from(escapes[token[1]] ?? token[1]));
  }
  return Buffer.concat(parts).toString("utf8");
}

function statusPaths(entry) {
  if (typeof entry !== "string") return [];
  const status = /^[ MADRCU?!T]{2} /.exec(entry);
  const file = status ? entry.slice(3) : entry;
  // Both sides of a rename/copy matter: moving an unowned file is a scope violation too.
  if (status && /[RC]/.test(status[0])) {
    let quoted = false;
    for (let i = 0; i < file.length; i++) {
      if (file[i] === "\\" && quoted) { i++; continue; }
      if (file[i] === '"') quoted = !quoted;
      if (!quoted && file.startsWith(" -> ", i)) return [unquote(file.slice(0, i)), unquote(file.slice(i + 4))];
    }
  }
  return [unquote(file)];
}

function scopeViolations(run, task, row, report) {
  if (!Array.isArray(task.plan?.owns)) return [];
  const cwd = task.cd || task.worktree?.path || run.repo || "/";
  const normalize = (file) => path.relative(cwd, path.resolve(cwd, file));
  const owned = task.plan.owns.filter((file) => typeof file === "string" && file.length).map(normalize);
  const files = [...(report?.changed || []), ...(Array.isArray(row.result?.touchedFiles) ? row.result.touchedFiles.flatMap(statusPaths) : [])];
  let checkout;
  const expanded = files.filter((file) => typeof file === "string" && file.length).flatMap((file) => {
    if (!file.endsWith("/")) return [normalize(file)];
    if (checkout === undefined) {
      const probe = fs.existsSync(cwd) && spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
      checkout = probe && probe.status === 0 && probe.stdout.trim() === "true";
    }
    if (checkout) {
      // Porcelain status collapses untracked directories. NUL output preserves quoted/unusual
      // names; literal pathspecs prevent brackets and other filename characters acting as globs.
      const listed = spawnSync("git", ["--literal-pathspecs", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z", "--", file], { encoding: "utf8" });
      if (listed.status === 0) return listed.stdout.split("\0").filter(Boolean).map(normalize);
      // An existing checkout whose inspection fails must not silently hide possible violations.
      return [normalize(file)];
    }
    const dir = normalize(file);
    // With a removed checkout, a collapsed folder is not evidence of changes beyond the owned
    // files within it. Explicit file paths still undergo the ordinary scope check below.
    return owned.some((owner) => dir === "" || owner.startsWith(`${dir}/`)) ? [] : [dir];
  });
  return [...new Set(expanded)]
    .filter((file) => !CACHE_PATH.test(file) && !owned.some((owner) => file === owner || (owner === "" ? file !== ".." && !file.startsWith("../") : file.startsWith(`${owner}/`))));
}

// A checkout's HEAD commit, and whether it holds uncommitted changes beyond the tool caches that
// gate runs leave behind; both null outside a git checkout.
export function treeState(dir) {
  const head = dir && fs.existsSync(dir) ? spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }) : null;
  if (!head || head.status !== 0) return { commit: null, dirty: null };
  const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
  const dirty = status.status === 0 ? status.stdout.split("\n").some((l) => l.trim() && !CACHE_PATH.test(l.slice(3))) : null;
  return { commit: head.stdout.trim(), dirty };
}

// Each run of whitespace outside quotes as one space, trimmed. Text in single or double quotes, or
// escaped with a backslash, keeps its spacing: `test 'a  b' = x` and `test 'a b' = x` differ.
function collapseSpaces(cmd) {
  let out = "";
  let quoted = null;
  let space = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (!quoted && /\s/.test(c)) {
      space = true;
      continue;
    }
    if (space && out) out += " ";
    space = false;
    out += c;
    if (quoted === "'") {
      if (c === "'") quoted = null;
    } else if (c === "\\" && i + 1 < cmd.length) {
      out += cmd[++i];
    } else if (quoted === '"') {
      if (c === '"') quoted = null;
    } else if (c === "'" || c === '"') {
      quoted = c;
    }
  }
  return out;
}

// A leading `cd <dir> && ` whose directory is the task's working directory: `.`, that path, or a
// path that resolves to it. A directory with shell expansions in it is never taken as one.
const CD_PREFIX = /^cd (?:'([^']+)'|"([^"\\$`]+)"|([^\s'"\\$`~&;|<>()*?[\]{}]+)) && /;
function sameDir(dir, cwd) {
  const target = path.resolve(cwd, dir);
  if (target === path.resolve(cwd)) return true;
  try {
    return fs.realpathSync(target) === fs.realpathSync(cwd);
  } catch {
    return false;
  }
}

// A command as the matching compares it: without its shell wrapper, with whitespace outside quotes
// collapsed, and without a leading `cd` into the task's working directory `cwd`.
export function normalizeCommand(cmd, cwd = null) {
  let text = collapseSpaces(unwrapShell(collapseSpaces(String(cmd ?? ""))));
  for (let m; cwd && (m = CD_PREFIX.exec(text)) && sameDir(m[1] ?? m[2] ?? m[3], cwd); ) text = text.slice(m[0].length);
  return text;
}

// The attempts whose commands back the current attempt's report: the current one, and those an
// automatic retry continued, since a retry picks up where the failed turn left off.
function reportAttempts(task) {
  const attempts = [task.attempt || 0];
  while (attempts[0] > 1 && attemptReasonOf(task, attempts[0]) === "retry") attempts.unshift(attempts[0] - 1);
  return attempts;
}

// Evidence for each reported check: the last run of the same command in the agent's event stream,
// as { ran: true, exitCode, atMs } or { ran: false }. Recorded once in <attempt>/evidence.json,
// with the checkout's HEAD and whether it was dirty when orch.mjs first read the finished result.
// Only describe() rows get it: `stats` rebuilds archived rows without an outDir. Working it out
// runs git and reads whole event logs, so only `result` and `accept` do it (computeEvidence());
// the dashboard, `status` and `wait` show what those commands saved, and never block on git.
let evidenceAllowed = false;
// evidence.json read once per change: every dashboard build asks for every task's.
const evidenceCache = new Map(); // file -> { mtimeMs, value }
function savedEvidence(file) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    evidenceCache.delete(file);
    return null;
  }
  const hit = evidenceCache.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.value;
  const value = readJson(file);
  evidenceCache.set(file, { mtimeMs, value });
  return value;
}
export function computeEvidence() {
  evidenceAllowed = true;
}
function checkEvidence(task, row, report) {
  if (!report || report.invalid || !row.outDir || !task.outDir || ["running", "prepared"].includes(row.state)) return null;
  const file = path.join(task.outDir, "evidence.json");
  const saved = savedEvidence(file);
  if (saved?.attempt === row.attempt && Array.isArray(saved.checks) && saved.checks.length === report.checks.length) return saved;
  if (!evidenceAllowed) return null;
  const dir = path.dirname(task.outDir);
  const logs = reportAttempts(task).map((n) => ({ agent: task.attemptAgents?.[n] || task.agent, file: path.join(dir, `attempt-${n}`, "events.jsonl") }));
  const logged = logs.some((log) => fs.existsSync(log.file));
  const runs = logs.flatMap((log) => commandRuns(log.agent, log.file)).map((run) => ({ ...run, key: normalizeCommand(run.cmd, row.cd) }));
  const checks = report.checks.map((check) => {
    if (!logged) return null;
    const cmd = normalizeCommand(check?.cmd, row.cd);
    const last = cmd ? runs.findLast((run) => run.key === cmd) : null;
    return last ? { ran: true, exitCode: last.exitCode, atMs: last.atMs } : { ran: false };
  });
  const evidence = { attempt: row.attempt, readAt: new Date().toISOString(), ...treeState(row.cd), checks };
  try {
    writeJson(file, evidence);
  } catch {
    // A read-only copy of a run still gets its evidence, computed again on each read.
  }
  return evidence;
}

// A check's evidence in words, for `result`: "ran, exit 0", or "NOT FOUND in the log".
export function evidenceText(evidence) {
  if (!evidence) return "";
  if (!evidence.ran) return "NOT FOUND in the log";
  return `ran, exit ${evidence.exitCode ?? "unknown"}`;
}

// A warning for a check reported as passing without a successful matching run, or null.
export function evidenceWarning(check) {
  const evidence = check?.evidence;
  if (check?.result !== "pass" || !evidence || evidence.exitCode === 0) return null;
  const cmd = check.cmd || "(no command)";
  if (!evidence.ran) return `check "${cmd}" is reported pass, but no matching run is in the log`;
  return evidence.exitCode === null
    ? `check "${cmd}" is reported pass, but the log has no exit code for its last run`
    : `check "${cmd}" is reported pass, but its last run exited ${evidence.exitCode}`;
}

function expectedQuiet(task, row) {
  if (!task.babysit && task.plan?.type !== "babysit") return false;
  // Activity labels truncate long paths before "pr-watch". Read the most recent activity from
  // a bounded event tail in that case, and do not mistake an already returned call for a wait.
  const events = task.outDir ? tailText(path.join(task.outDir, "events.jsonl")) : null;
  for (const line of (events || "").split("\n").reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== "object") continue;
    if (event.type === "api-request" || event.type === "result" || event.type === "turn.completed") return false;
    if (event.type === "user" && event.message?.content?.some?.((block) => block.type === "tool_result")) return false;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of [...event.message.content].reverse()) {
        if (block.type === "tool_use") return block.name === "Bash" && PR_WATCH_RE.test(block.input?.command || "");
        if (block.type === "thinking" || (block.type === "text" && block.text?.trim())) return false;
      }
    }
    if (event.type?.startsWith("item.") && event.item) {
      if (event.item.type === "command_execution") return event.type !== "item.completed" && PR_WATCH_RE.test(event.item.command || "");
      if (["file_change", "agent_message", "reasoning", "web_search", "mcp_tool_call", "todo_list"].includes(event.item.type)) return false;
    }
  }
  const activity = String(row.now || "").replace(/^quiet .*? · /, "");
  return activity.startsWith("$ ") && PR_WATCH_RE.test(activity.slice(2));
}

function health(task, row) {
  if (task.pid && row.state !== "running" && !row.result && !(task.outDir && fs.existsSync(path.join(task.outDir, "result.json")))) return "dead";
  if (row.state === "running") return row.quietMs > QUIET_MS && !expectedQuiet(task, row) ? "silent" : "ok";
  if (!row.limitHit && !["prepared", "completed", "needs-decision", "stopped", "timeout"].includes(row.state)) {
    const eventError = task.outDir ? summarizeEvents(task.agent, path.join(task.outDir, "events.jsonl"), task.cd).error : null;
    const errors = [row.result?.error, row.result?.stderrTail, eventError]
      .map((error) => typeof error === "string" ? error : JSON.stringify(error)).filter(Boolean).join("\n");
    if (row.state === "aborted" && STOP_RE.test(`${row.result?.signal || ""}\n${errors}`)) return "ok";
    if (TRANSIENT_RE.test(errors) || PROVIDER_MESSAGE_RE.test(row.result?.finalMessage || "")) return "transient-error";
  }
  return "ok";
}

// A running task's stuck episode, from its current attempt's events (events.mjs, stuckIn): { command,
// failures, firstMs, lastMs, firstIndex }, or null. A finished task is never stuck. The file is
// named as describe() names it (runs.mjs, attemptDirs), so its summary is the one just updated.
function stuck(run, task, row) {
  if (row.state !== "running" || !task.attempt || !run.dir) return null;
  const file = path.join(run.dir, "tasks", task.id, `attempt-${task.attempt}`, "events.jsonl");
  return stuckOf(task.attemptAgents?.[task.attempt] || task.agent, file, task.cd);
}

// Extra fields for one task row from describe(); `row` is the row built so far.
export function reportFields(run, task, row) {
  let report = parseReport(row.result?.finalMessage);
  const evidence = checkEvidence(task, row, report);
  if (evidence) {
    report = {
      ...report,
      checks: report.checks.map((check, i) => (check && typeof check === "object" && evidence.checks[i] ? { ...check, evidence: evidence.checks[i] } : check)),
      commit: evidence.commit,
      dirty: evidence.dirty,
      readAt: evidence.readAt,
    };
  }
  const prose = String(row.result?.finalMessage || "").split(/^[\t ]*```orch-result[\t ]*\r?$/m)[0];
  const reportLines = prose ? prose.split(/\r?\n/).length - (prose.endsWith("\n") ? 1 : 0) : 0;
  const fields = { reportLines, report, scopeViolations: scopeViolations(run, task, row, report), health: health(task, row), stuck: stuck(run, task, row) };
  if (report?.decisions?.length && ["completed", "needs-decision"].includes(row.state)) {
    fields.state = "needs-decision";
    fields.decisions = report.decisions.map((decision) => {
      if (typeof decision === "string") return decision;
      return `${decision?.question || "(no question given; read the final message)"}${decision?.recommendation ? ` Recommendation: ${decision.recommendation}` : ""}`;
    });
    // describe() computes these before applying the report hook; keep the derived row coherent.
    fields.closed = Boolean(task.closedAt);
    fields.phase = "needs-decision";
    fields.awaitingReviewMs = null;
  }
  return fields;
}

const quote = (value) => /^[\w./:-]+$/.test(String(value)) ? String(value) : `'${String(value).replaceAll("'", "'\\''")}'`;

// The command that resumes a task row's session with a delta brief, keeping its agent, its Codex
// tier and its read-only mode, which `start` does not carry over by itself.
export function resumeCommand(run, task) {
  return `node ${quote(CLI_PATH)} start ${quote(run.id)} ${quote(task.id)} --agent ${quote(task.agent)}${task.agent === "codex" && task.tier ? ` --tier ${quote(task.tier)}` : ""}${task.mode?.split("+")[0] === "read-only" ? " --read-only" : ""} --brief <delta> -- --session ${task.session ? quote(task.session) : "<id>"}`;
}

// Extra lines that `wait` prints for these task rows, for example a dead or silent task.
export function reportHints(run, tasks) {
  const lines = [];
  for (const task of tasks) {
    const target = `${quote(run.id)} ${quote(task.id)}`;
    if (task.health === "dead") lines.push(`${task.id}: dead (relay exited without result.json); read the log: node ${quote(CLI_PATH)} log ${target}`);
    if (task.health === "silent") lines.push(`${task.id}: silent; quiet for ${formatElapsed(task.quietMs)}`);
    if (task.health === "transient-error") lines.push(`${task.id}: transient error; resume with: ${resumeCommand(run, task)}`);
    if (task.scopeViolations?.length) lines.push(`${task.id}: scope violations: ${task.scopeViolations.join(", ")}`);
    if (task.reportLines > 60) lines.push(`${task.id}: long report (${task.reportLines} lines)`);
    if (task.report?.invalid) lines.push(`${task.id}: invalid orch-result report: ${task.report.error}`);
  }
  return lines;
}
