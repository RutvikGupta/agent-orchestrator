// Structured agent reports, scope checks against the plan, and task health.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CACHE_PATH, CLI_PATH } from "./config.mjs";
import { commandRuns, stuckOf, summarizeEvents } from "./events.mjs";
import { formatElapsed } from "./format.mjs";
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
      // `parked`: a babysitter that ended its turn to wait for its pull request (park.mjs).
      outcome: ["done", "partial", "blocked", "parked"].includes(value.outcome) ? value.outcome : null,
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
      const probe = fs.existsSync(cwd) && spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5000 });
      checkout = probe && probe.status === 0 && probe.stdout.trim() === "true";
    }
    if (checkout) {
      // Porcelain status collapses untracked directories. NUL output preserves quoted/unusual
      // names; literal pathspecs prevent brackets and other filename characters acting as globs.
      const listed = spawnSync("git", ["--literal-pathspecs", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z", "--", file], { encoding: "utf8", timeout: 5000 });
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
  const head = dir && fs.existsSync(dir) ? spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }) : null;
  if (!head || head.status !== 0) return { commit: null, dirty: null };
  const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 });
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

// Tokenize shell words without executing expansions. Quotes around literal arguments do not
// change their identity; expansions retain their spelling so single-quoted variables stay distinct.
function shellTokens(text) {
  const tokens = [];
  let raw = "", word = "", quote = null;
  let heredoc = false;
  const heredocs = [];
  const end = () => {
    if (raw) {
      tokens.push({ word: /[$`]/.test(raw) && raw.includes("'") ? raw : word, value: word, raw });
      if (heredoc) { heredocs.push(word); heredoc = false; }
    }
    raw = ""; word = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "\n" && quote !== "'") { i++; continue; }
    if (quote) {
      raw += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(text[i + 1] || "")) { raw += text[++i]; word += text[i]; }
      else word += c;
    } else if (c === "\\" && i + 1 < text.length) {
      raw += c + text[++i]; word += text[i];
    } else if (c === "'" || c === '"') { quote = c; raw += c; }
    else if (c === "\n") {
      end(); tokens.push({ op: ";" });
      for (const delimiter of heredocs.splice(0)) {
        for (;;) {
          const eol = text.indexOf("\n", i + 1);
          const line = text.slice(i + 1, eol < 0 ? text.length : eol);
          i = eol < 0 ? text.length : eol;
          if (line.replace(/^\t+/, "") === delimiter || eol < 0) break;
        }
      }
    }
    else if (/\s/.test(c)) end();
    else if (/[|&;<>]/.test(c)) {
      // File descriptor numbers belong to the redirection, not the command's arguments.
      if (/[<>]/.test(c) && /^\d+$/.test(raw)) { raw = ""; word = ""; } else end();
      const op = /^(?:&&|\|\||<<-|<<|>>|>&|<&|[|&;<>])/.exec(text.slice(i))[0];
      tokens.push({ op }); i += op.length - 1;
      if (op === "<<" || op === "<<-") heredoc = true;
    } else { raw += c; word += c; }
  }
  end();
  return quote ? null : tokens;
}

// Shell wrappers carry command text as one argument, including multiline heredocs. Decode
// that argument without evaluation before splitting commands; never search quoted source text.
function unwrapEvidenceShell(command) {
  let text = String(command ?? "").trim();
  for (let depth = 0; depth < 8; depth++) {
    const tokens = shellTokens(text);
    if (tokens?.length !== 3 || !/^(?:ba|z)?sh$/.test(path.basename(tokens[0]?.word || "")) || !/^-[a-z]*c[a-z]*$/.test(tokens[1]?.word || "")) break;
    text = tokens[2].value;
  }
  return text;
}

// Resolve existing parents too, so a missing child of a symlink cannot escape the task tree.
function canonicalDirectory(directory) {
  let current = path.resolve(directory), suffix = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync(current), ...suffix.reverse()); } catch { /* Try its parent. */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(directory);
    suffix.push(path.basename(current)); current = parent;
  }
}
function insideTask(directory, cwd) {
  if (!cwd) return false;
  const relative = path.relative(canonicalDirectory(cwd), canonicalDirectory(directory));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Keep command identity separate from shell setup and output presentation. Only a literal cd
// prefix and pipes to the three display filters are removed; other shell control flow stays.
export function normalizeCommand(cmd, cwd = null) {
  const text = unwrapEvidenceShell(cmd);
  const tokens = shellTokens(text);
  if (!tokens) return collapseSpaces(text);
  let directory = cwd;
  while (tokens[0]?.word === "cd" && tokens[1]?.word && !/[$`~]/.test(tokens[1].word) && tokens[2]?.op === "&&") {
    const target = path.resolve(directory || ".", tokens[1].word);
    if (!insideTask(target, cwd)) break;
    directory = target; tokens.splice(0, 3);
  }
  for (;;) {
    while (/^[A-Za-z_][\w]*=/.test(tokens[0]?.word || "")) tokens.shift();
    if (tokens[0]?.word === "env") {
      tokens.shift();
      while (tokens.length) {
        if (["-u", "--unset"].includes(tokens[0]?.word) && tokens[1]?.word) tokens.splice(0, 2);
        else if (/^--unset=/.test(tokens[0]?.word || "") || tokens[0]?.word === "--") tokens.shift();
        else if (/^[A-Za-z_][\w]*=/.test(tokens[0]?.word || "")) tokens.shift();
        else break;
      }
    } else if (tokens[0]?.word === "timeout") {
      let i = 1;
      while (tokens[i]?.word?.startsWith("-")) i += ["-k", "-s", "--kill-after", "--signal"].includes(tokens[i].word) ? 2 : 1;
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]?.word || "")) break;
      tokens.splice(0, i + 1);
    } else if (path.basename(tokens[0]?.word || "") === "node" && path.basename(tokens[1]?.word || "") === "orch.mjs" && tokens[2]?.word === "heavy") {
      const separator = tokens.findIndex((t, i) => i > 2 && t.word === "--");
      if (separator < 0) break;
      tokens.splice(0, separator + 1);
    } else break;
  }
  const output = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ([">", ">>", ">&"].includes(token.op) && tokens[i + 1]?.word) { i++; continue; }
    if (token.op === "|" && ["grep", "tail", "head"].includes(path.basename(tokens[i + 1]?.word || ""))) {
      // Do not erase an unrelated command after the filter pipeline.
      const suffix = tokens.slice(i);
      if (!suffix.some((t) => [";", "&&", "||", "&"].includes(t.op))) break;
    }
    // Agents often append a status echo after redirecting a test run into a file.
    if (token.op === ";" && tokens[i + 1]?.word === "echo" && /^['"]?exit \$\?['"]?$/.test(tokens[i + 2]?.raw || "")) break;
    output.push(token.op ? { op: token.op } : { word: token.word });
  }
  return JSON.stringify(output);
}

const PROGRAM = /^(?:env|cd|bash|sh|zsh|node|npm|npx|pnpm|yarn|bun|deno|python\d*(?:\.\d+)?|pytest|uv|uvx|pip\d*|git|go|cargo|rustc|make|cmake|ctest|docker|podman|ruby|bundle|rake|java|mvn|gradle|dotnet|php|composer|perl|curl|wget|gh|rg|grep|sed|awk|test|echo|true|false|pre-commit|ruff|black|eslint|tsc|shellcheck|bq|gcloud|pants|gt|orch|cmp|diff|cat|ls|find|wc|jq)(?:\s|$)/;
function runnable(text) {
  return /^[\w.-]+\.sh(?:\s|$)/.test(text) || /^[A-Za-z_]\w*_\w+(?:\s|$)/.test(text) || /^[A-Za-z_][\w]*=\S+\s+/.test(text) || PROGRAM.test(text) || /^(?:\.?\.?\/|~\/|\/)[^\s]+/.test(text) || /^[\w.-]+\s+--?[\w]/.test(text);
}
// Reports can name a command in backticks or add a short outcome after it. Never use substring
// matching against the log: a prose description alone must not turn into command evidence.
function checkCommand(value) {
  const text = String(value ?? "").trim();
  for (const match of (runnable(text) ? [] : text.matchAll(/`([^`]+)`/g))) if (runnable(match[1].trim())) return match[1].trim();
  let command = text.replace(/^(?:ran|run|verified (?:with|using)|checked (?:with|using))\s*:?\s*/i, "");
  const colon = command.indexOf(": ");
  if (!runnable(command) && colon >= 0 && runnable(command.slice(colon + 2))) command = command.slice(colon + 2);
  command = command.replace(/\s+\([^)]*\)\s*$/, "");
  if (/^git\s+(?:status|rev-parse)\b/.test(command)) command = command.replace(/\s+(?:in|on)\s+(?:both|head|base|the)\b.*$/, "");
  command = command.replace(/\s+(?:—|–)\s+.*$/, "").replace(/\s+\((?:\d+\/\d+|passed|pass|all pass)[^)]*\)\s*$/i, "");
  return runnable(command) ? command : null;
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
  const dir = path.dirname(task.outDir);
  const logs = reportAttempts(task).map((n) => ({ agent: task.attemptAgents?.[n] || task.agent, file: path.join(dir, `attempt-${n}`, "events.jsonl") }));
  if (!logs.some((log) => fs.existsSync(log.file))) return null;
  const file = path.join(task.outDir, "evidence.json");
  const saved = savedEvidence(file);
  if (saved?.version === 5 && saved?.attempt === row.attempt && Array.isArray(saved.checks) && saved.checks.length === report.checks.length) return saved;
  if (!evidenceAllowed) return null;
  const runs = logs.flatMap((log) => commandRuns(log.agent, log.file)).map((run) => ({ ...run, key: normalizeCommand(run.cmd, row.cd) }));
  const checks = report.checks.map((check) => matchCheckEvidence(check, runs, row.cd));
  const checkout = saved?.attempt === row.attempt
    ? { readAt: saved.readAt, commit: saved.commit, dirty: saved.dirty }
    : { readAt: new Date().toISOString(), ...treeState(row.cd) };
  const evidence = { version: 5, attempt: row.attempt, ...checkout, checks };
  try {
    writeJson(file, evidence);
  } catch {
    // A read-only copy of a run still gets its evidence, computed again on each read.
  }
  return evidence;
}

// Simple commands in a shell call can back separate reported gates. Earlier commands in a
// sequence have unknown status unless an all-success && chain proves they succeeded. Heredocs
// and substitutions stay opaque so source code or quoted command text cannot become evidence.
function matchingRuns(run, cwd) {
  const text = unwrapEvidenceShell(run.cmd);
  const tokens = shellTokens(text);
  const exact = { ...run, key: normalizeCommand(text, cwd) };
  if (!tokens) return [exact];
  const parts = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && ![";", "&&", "||", "&", "|"].includes(tokens[i].op)) continue;
    const slice = tokens.slice(start, i);
    if (slice.length) parts.push({ tokens: slice, after: tokens[i]?.op });
    start = i + 1;
  }
  const chainPassed = run.exitCode === 0 && parts.slice(0, -1).every((p) => p.after === "&&");
  const stopped = parts.findIndex((p) => /^(?:exit|return|exec)$/.test(p.tokens[0]?.word || ""));
  const candidates = [];
  let directory = cwd;
  let directoryKnown = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (stopped >= 0 && i > stopped) break;
    const previous = parts[i - 1];
    if (previous?.tokens[0]?.word === "cd") {
      const target = previous.tokens[1]?.word || "";
      if (/[$`~]/.test(target) || (!directoryKnown && !path.isAbsolute(target))) directoryKnown = false;
      else { directory = path.resolve(directory || ".", target); directoryKnown = true; }
    }
    if (!directoryKnown || (directory && cwd && directory !== cwd && !insideTask(directory, cwd))) continue;
    // A successful && chain establishes each step's status. In a masked chain, record
    // the named step with unknown status; a literal false proves the next step was skipped.
    if (previous?.after === "&&" && previous.tokens[0]?.word === "false") continue;
    if (previous?.after === "||") continue;
    const piped = part.tokens.some((t) => t.op === "|");
    const masked = [";", "||", "&", "|"].includes(part.after) || piped;
    candidates.push({ ...run, cwd: directory,
      key: normalizeCommand(part.tokens.map((t) => t.op || t.raw).join(" "), directory),
      exitCode: masked || (previous?.after === "&&" && !chainPassed && previous.tokens[0]?.word !== "cd") ? null
        : i === parts.length - 1 || chainPassed ? run.exitCode : null,
    });
  }
  // Whole-shell status is usable only when it describes the whole reported command. Avoid
  // a normalized pipeline or status echo silently replacing an unknown component status.
  return [exact, ...candidates];
}

// Ignore neutral flags, but keep options that select work, validate it, or mutate it.
const PROOF_FLAGS = new Set(["--lf", "--last-failed", "--sw", "--stepwise", "--collect-only", "--co", "--no-run", "-check", "--cached", "--staged", "--all-files", "-run", "--lib", "--bin", "-k", "-m", "-c", "-e", "--keyword", "--markers", "--check", "--exit-code", "--fix", "--write", "--dry-run", "--ignore", "--ignore-glob", "--deselect", "--exclude", "--exclude-dir", "--include", "--config", "--test", "--test-name-pattern", "--test-skip-pattern", "--match", "--grep", "--filter", "--path", "--paths", "--file", "--files", "--repo", "-R", "--git-dir", "--work-tree", "-C", "-G", "-S", "--version"]);
const PYTEST_VALUES = new Set(["-k", "-m", "-c", "-p", "-n", "--keyword", "--markers", "--ignore", "--ignore-glob", "--deselect", "--exclude", "--include", "--config", "--tb", "--color", "--capture", "--maxfail", "--durations", "--log-level", "--junitxml", "--basetemp", "--rootdir", "--confcutdir"]);
const PROGRAM_VALUES = {
  node: new Set(["-e", "--eval", "-p", "--print", "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency"]),
  gh: new Set(["--jq", "-q", "--json", "--template", "--repo", "-R"]),
  git: new Set(["-C", "--git-dir", "--work-tree", "--grep", "-G", "-S"]),
  black: new Set(["--config", "--include", "--exclude"]),
  ruff: new Set(["--config", "--include", "--exclude", "--output-format"]),
};
function flagTakesValue(program, option) {
  if (/^(?:pytest|py_test|run_.*tests.*\.sh)$/.test(program)) return PYTEST_VALUES.has(option);
  if (/^python\d*(?:\.\d+)?$/.test(program)) return option === "-m" || option === "-c";
  return PROGRAM_VALUES[program]?.has(option) || false;
}
function identity(key) {
  let tokens;
  try { tokens = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(tokens) || tokens.some((t) => t.op)) return null;
  const words = tokens.map((t) => t.word), keep = [];
  const program = path.basename(words[0] === "uv" && words[1] === "run" ? words[2] || words[0] : words[0] || "");
  let positional = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--") { positional = true; continue; }
    if (!i || positional || !word.startsWith("-") || word === "-") { keep.push(word); continue; }
    let option = word.split("=", 1)[0];
    let attached = word.includes("=") ? word.slice(word.indexOf("=") + 1) : undefined;
    const short = word.slice(0, 2);
    if (attached === undefined && word.length > 2 && flagTakesValue(program, short) && (PROOF_FLAGS.has(short) || (program === "node" && short === "-p"))) {
      option = short; attached = word.slice(2);
    }
    const protectedFlag = PROOF_FLAGS.has(option)
      || (program === "git" && words[1] === "diff" && ["-q", "--quiet"].includes(option))
      || (program === "git" && words[1] === "apply" && option === "--stat")
      // gofmt's -l and -d only report, where -w rewrites: none of them stands in for another.
      || (program === "gofmt" && ["-w", "-l", "-d"].includes(option))
      || (program === "node" && (["-v", "-p", "--print", "--eval"].includes(option) || (!words.includes("--test") && option === "--test-reporter")));
    const value = attached !== undefined ? attached
      : flagTakesValue(program, option) && words[i + 1] !== undefined ? words[++i] : undefined;
    if (protectedFlag) keep.push(value === undefined ? word : `${option}\0${value}`);
  }
  return keep;
}
function compatibleCommand(left, right, cwd, runCwd) {
  const a = identity(left), b = identity(right);
  if (!a || !b || a.length !== b.length) return false;
  return a.every((word, i) => {
    if (word === b[i]) return true;
    if (!i && path.basename(word) === path.basename(b[i]) && (!word.includes(path.sep) || !b[i].includes(path.sep))) return true;
    if (word.startsWith("-") || b[i].startsWith("-") || !/[/.]/.test(word) || !/[/.]/.test(b[i]) || /[$`]/.test(word + b[i])) return false;
    const x = path.normalize(word), y = path.normalize(b[i]);
    const from = path.resolve(cwd || ".", x), to = path.resolve(runCwd || cwd || ".", y);
    if (from === to) return true;
    if (!cwd || !insideTask(from, cwd) || !insideTask(to, cwd) || (path.isAbsolute(x) && path.isAbsolute(y))) return false;
    // A report often uses the path relative to a test subdirectory rather than the task
    // root. Require the complete relative suffix, never just a shared filename.
    return (x.includes(path.sep) && y.endsWith(path.sep + x)) || (y.includes(path.sep) && x.endsWith(path.sep + y));
  });
}

// Pure matching also lets audits compare historical reports without writing into their state.
export function matchCheckEvidence(check, runs, cwd = null) {
  let command = checkCommand(check?.cmd);
  if (!command) {
    const text = String(check?.cmd ?? "").trim();
    const first = shellTokens(text)?.[0]?.word;
    // A tool need not be in a fixed vocabulary: an observed executable establishes that
    // a similarly named report entry is a command rather than a prose description.
    if (first && runs.some((run) => matchingRuns(run, cwd).some((candidate) => identity(candidate.key)?.[0] === first))) command = text;
  }
  if (!command) return { ran: false, notCommand: true };
  const key = normalizeCommand(command, cwd);
  const candidates = runs.flatMap((run) => matchingRuns(run, cwd));
  const find = (wanted) => {
    const last = candidates.findLast((run) => run.key === wanted || compatibleCommand(wanted, run.key, cwd, run.cwd));
    return last ? { ran: true, exitCode: last.exitCode, atMs: last.atMs } : null;
  };
  const direct = find(key);
  if (direct) return direct;
  const requirements = matchingRuns({ cmd: command, exitCode: 0, atMs: null }, cwd).slice(1)
    .filter((run) => identity(run.key)?.[0] !== "cd");
  if (requirements.length > 1) {
    const found = requirements.map((required) => find(required.key));
    if (found.every(Boolean)) {
      const failed = found.find((run) => run.exitCode != null && run.exitCode !== 0);
      return { ran: true, exitCode: failed?.exitCode ?? (found.some((run) => run.exitCode == null) ? null : 0), atMs: found.at(-1).atMs };
    }
  }
  return { ran: false };
}

// A check's evidence in words, for `result`: "ran, exit 0", or "NOT FOUND in the log".
export function evidenceText(evidence) {
  if (!evidence) return "no events log; evidence unavailable";
  if (evidence.notCommand) return "not a command";
  if (!evidence.ran) return "NOT FOUND in the log";
  return `ran, exit ${evidence.exitCode ?? "unknown"}`;
}

// A warning for a check reported as passing without a successful matching run, or null.
export function evidenceWarning(check) {
  const evidence = check?.evidence;
  if (check?.result !== "pass" || evidence?.exitCode === 0) return null;
  if (!evidence) return `check "${check.cmd || "(no command)"}" has no events log; evidence unavailable`;
  if (evidence.notCommand) return `check "${check.cmd || "(no command)"}" is reported pass, but is not a command`;
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
  if (row.state !== "running" || row.parked || !task.attempt || !run.dir) return null;
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
    const label = task.name || task.id; // a task's name (`rename`) shows in place of its id
    if (task.health === "dead") lines.push(`${label}: dead (relay exited without result.json); read the log: node ${quote(CLI_PATH)} log ${target}`);
    if (task.health === "silent") lines.push(`${label}: silent; quiet for ${formatElapsed(task.quietMs)}`);
    if (task.health === "transient-error") lines.push(`${label}: transient error; resume with: ${resumeCommand(run, task)}`);
    if (task.scopeViolations?.length) lines.push(`${label}: scope violations: ${task.scopeViolations.join(", ")}`);
    if (task.reportLines > 60) lines.push(`${label}: long report (${task.reportLines} lines)`);
    if (task.report?.invalid) lines.push(`${label}: invalid orch-result report: ${task.report.error}`);
  }
  return lines;
}
