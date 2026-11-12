// Event streams: progress, current activity, and token usage per attempt
//
// The relays save each agent's raw JSONL stream as events.jsonl. Claude (`--output-format
// stream-json`) reports usage on every assistant message and exact totals plus an estimated cost
// in its final `result` event; until then the output count is a lower bound. Codex (`exec
// --json`) reports usage once per completed turn and no cost.
//
// Every stream is read incrementally: each file keeps its read offset and summary in eventCache,
// so a refresh parses only the lines appended since the last one. For a large file the offset and
// summary are also saved under <state root>/cache/summaries, so a new process (a restarted
// dashboard, `status`) continues from there instead of parsing hundreds of megabytes again.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { STATE_ROOT } from "./config.mjs";
import { applyClaudeEvent, claudeActionEvent, claudeCommandEvent, claudeLineShortcut } from "./claude.mjs";
import { applyCodexEvent, applyCodexRolloutEvent, codexActionEvent, codexCommandEvent } from "./codex.mjs";
import { unwrapShell } from "./format.mjs";
import { rememberClaudeLimits } from "./limits.mjs";

const eventCache = new Map(); // events path -> { offset, rest, summary }; reused by `watch`

export function newSummary() {
  return {
    sessionId: null,
    model: null,
    steps: 0,
    activity: "",
    error: null,
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: null,
    exact: false,
    limits: null,
    seen: new Set(),
    messages: new Map(),
    // Stuck detection (below): lines read so far, the last RING actions, the tool calls still
    // waiting for their result, and each key's open streak of failures.
    lines: 0,
    actions: [],
    pendingTools: {},
    streaks: {},
    // Where the session is in its turn (claude.mjs, codex.mjs): whether a Claude relay's last turn
    // ended, its latest tool call without a result, and a Codex relay's open shell commands.
    turnEnded: false,
    openTool: null,
    openCommands: {},
  };
}

// The foreground shell command the session is in now, from its summary, or null: a Claude Bash
// call without a result that does not run in the background, or a Codex command that has not
// completed (the latest one).
export function shellNow(agent, s) {
  if (agent === "codex") return Object.values(s?.openCommands || {}).at(-1) ?? null;
  const tool = s?.openTool;
  return tool?.name === "Bash" && !tool.background && tool.command ? tool.command : null;
}

// Feed each complete line appended to `file` since the last call to `onLine`, reading in chunks
// so that a transcript of hundreds of megabytes never sits in memory whole.
function readNewLines(entry, file, onLine) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size <= entry.offset) return;
  entry.decoder ||= new StringDecoder("utf8");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(Math.min(16 << 20, size - entry.offset));
    while (entry.offset < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - entry.offset), entry.offset);
      if (n <= 0) break;
      entry.offset += n;
      const lines = (entry.rest + entry.decoder.write(chunk.subarray(0, n))).split("\n");
      entry.rest = lines.pop();
      for (const line of lines) if (line) onLine(line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Saved summaries of large files. Sets and Maps in a summary are kept as tagged arrays. A saved
// offset always sits at a line boundary, so reading resumes with a fresh decoder. The saved copy is
// refreshed after every 8 MB read or 60 seconds, for files over 1 MB, and used only for the same file (inode) at least
// as long as it, and only when saved with this summary version (a summary from older code lacks
// fields that a resumed parse would then miss).
const PERSIST_MIN = 1 << 20;
const SUMMARY_VERSION = 3;
const summaryDir = () => path.join(STATE_ROOT, "cache", "summaries");
const summaryPath = (file, kind) => path.join(summaryDir(), `${createHash("sha1").update(`${kind}:${file}`).digest("hex")}.json`);
const toJson = (key, value) => (value instanceof Set ? { $set: [...value] } : value instanceof Map ? { $map: [...value] } : value);
const fromJson = (key, value) => (value && typeof value === "object" && !Array.isArray(value) ? (value.$set ? new Set(value.$set) : value.$map ? new Map(value.$map) : value) : value);

function loadSaved(file, kind) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < PERSIST_MIN) return null;
    const saved = JSON.parse(fs.readFileSync(summaryPath(file, kind), "utf8"), fromJson);
    if (saved.version !== SUMMARY_VERSION || saved.file !== file || saved.ino !== stat.ino || !(saved.offset <= stat.size)) return null;
    return { offset: saved.offset, rest: "", summary: saved.summary, ino: stat.ino, savedOffset: saved.offset, savedAt: Date.now() };
  } catch {
    return null;
  }
}

function maybeSave(file, kind, entry) {
  if (entry.offset < PERSIST_MIN) return;
  const boundary = entry.offset - Buffer.byteLength(entry.rest || "");
  if (boundary - (entry.savedOffset || 0) < 8 << 20 && Date.now() - (entry.savedAt || 0) < 60_000) return;
  if (boundary === entry.savedOffset) return;
  try {
    const ino = entry.ino ?? fs.statSync(file).ino;
    const target = summaryPath(file, kind);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: SUMMARY_VERSION, file, ino, offset: boundary, summary: entry.summary }, toJson));
    fs.renameSync(tmp, target);
    Object.assign(entry, { ino, savedOffset: boundary, savedAt: Date.now() });
  } catch {
    // A read-only or full disk only costs the next process a full parse.
  }
}

export function summarizeEvents(agent, file, cwd) {
  let entry = eventCache.get(file);
  if (!entry) {
    entry = loadSaved(file, `events:${agent}`) || { offset: 0, rest: "", summary: newSummary() };
    eventCache.set(file, entry);
  }
  const apply = agent === "codex" ? applyCodexEvent : applyClaudeEvent;
  const act = agent === "codex" ? codexActionEvent : claudeActionEvent;
  const s = entry.summary;
  const tracker = actionTracker(s);
  const limitsBefore = s.limits;
  readNewLines(entry, file, (line) => {
    s.lines += 1; // every line counts, so an action's index is its line's ordinal in any process
    if (agent === "claude" && claudeLineShortcut(s, line)) return;
    try {
      const event = JSON.parse(line);
      apply(s, event, cwd);
      act(event, tracker);
    } catch {
      // Ignore a malformed line; the relay keeps writing the rest.
    }
  });
  if (s.limits && s.limits !== limitsBefore) {
    rememberClaudeLimits(s.limits, new Date(fs.statSync(file).mtimeMs).toISOString(), file);
  }
  maybeSave(file, `events:${agent}`, entry);
  return s;
}

// The stuck episode of the attempt whose events are in `file`, or null. describe() has just brought
// that file's summary up to date, so this reads nothing; it parses the file only when nothing in
// this process has read it yet.
export function stuckOf(agent, file, cwd) {
  return stuckIn(eventCache.get(file)?.summary ?? summarizeEvents(agent, file, cwd));
}

// Stuck detection. A summary keeps a ring of its last RING actions, oldest first: each shell
// command the agent ran, as { index, ms, key, readOnly, outcome }, and each edit, as { index, ms,
// edit: true }. `index` is the ordinal of the line that completed it and `ms` its timestamp, if any.
// An outcome is "fail", "ok" or "unknown". A task is stuck when one key failed its last N runs
// (AGENT_ORCH_STUCK_REPEATS, default 3) and every action since the first of them is one of those
// runs, a run of the same key with an unknown outcome, or a read-only inspection command. Any edit,
// any other command and a success end the streak. Each key's open streak is kept beside the ring
// (advanceStreaks). Both change only as lines are appended.
const RING = 200;
const PENDING = 32; // tool calls kept waiting for a result; a call that never gets one is dropped

export function stuckRepeats() {
  const n = Number(process.env.AGENT_ORCH_STUCK_REPEATS || 3);
  return Number.isInteger(n) && n >= 2 ? n : 3;
}

// The callbacks claudeActionEvent and codexActionEvent report through. Pending calls are keyed
// with a prefix, so no tool id can collide with an object's own properties.
function actionTracker(s) {
  return {
    start(id, call) {
      const pending = s.pendingTools;
      delete pending[`#${id}`];
      pending[`#${id}`] = call;
      const ids = Object.keys(pending);
      if (ids.length > PENDING) delete pending[ids[0]];
    },
    finish(id) {
      const call = s.pendingTools[`#${id}`];
      delete s.pendingTools[`#${id}`];
      return call;
    },
    seen: (id) => s.actions.some((a) => a.id === id),
    act: (raw) => addAction(s, raw),
  };
}

// `raw` is { edit: true } or { command, exitCode, failed, ok, interrupted, output, sub }, with an
// `id` and `ms`. A sub-agent's commands never count as failures; one that is not read-only may have
// changed files, so it ends a streak like an edit.
function addAction(s, raw) {
  const action = { index: s.lines, ms: raw.ms ?? null, ...(raw.id != null ? { id: raw.id } : {}) };
  if (raw.edit) action.edit = true;
  else {
    const shape = commandShape(raw.command);
    if (!shape || (raw.sub && shape.readOnly)) return;
    if (raw.sub) action.edit = true;
    else Object.assign(action, { key: shape.key, readOnly: shape.readOnly, outcome: outcomeOf(shape, raw) });
  }
  s.actions.push(action);
  advanceStreaks(s.streaks, action);
  // A streak is kept only for a key the ring still holds, which bounds the streaks to the ring.
  while (s.actions.length > RING) {
    const { key } = s.actions.shift();
    if (key && !s.actions.some((a) => a.key === key)) delete s.streaks[`#${key}`];
  }
}

// A failure is a non-zero exit other than an interrupt (130, or 143 from `steer`), or, without an
// exit code, a run reported failed. A command piped into tail, head or grep exits with that filter's
// status (or reports none), so it fails only when its output shows a failure, and is unknown
// otherwise. An interrupted run, or one still running in the background, is unknown.
const FAILURE_OUTPUT = /^[ \t]*FAIL(?:ED)?\b|\b[1-9]\d* failed\b|^[ \t]*not ok \d+|Traceback \(most recent call last\)|\bAssertionError\b/m;
function outcomeOf(shape, { exitCode, failed, ok, interrupted, output }) {
  if (interrupted || exitCode === 130 || exitCode === 143) return "unknown";
  let outcome;
  if (shape.piped) outcome = FAILURE_OUTPUT.test(String(output ?? "")) ? "fail" : "unknown";
  else if (typeof exitCode === "number") outcome = exitCode === 0 ? "ok" : "fail";
  else outcome = failed ? "fail" : ok ? "ok" : "unknown";
  return outcome === "fail" && shape.never ? "unknown" : outcome;
}

// Each key's open streak, kept in `s.streaks` as "#<key>" -> { firstIndex, firstMs, count,
// lastIndex, lastMs } from its first failure since the streak last ended, so an episode keeps its
// start however far the ring has moved. An edit ends every streak; a command that is not read-only
// ends every other key's; a success ends its own key's. A run of the key with an unknown outcome,
// and a read-only command of another key, leave a streak as it is.
function advanceStreaks(streaks, a) {
  const id = a.key ? `#${a.key}` : null;
  if (!a.key || !a.readOnly) for (const other of Object.keys(streaks)) if (other !== id) delete streaks[other];
  if (!a.key) return;
  if (a.outcome === "ok") delete streaks[id];
  else if (a.outcome === "fail") {
    const streak = (streaks[id] ||= { firstIndex: a.index, firstMs: a.ms, count: 0, lastIndex: a.index, lastMs: a.ms });
    Object.assign(streak, { count: streak.count + 1, lastIndex: a.index, lastMs: a.ms });
  }
}

const stuckMemo = new WeakMap(); // summary -> { lines, repeats, value }
export function stuckIn(s) {
  const repeats = stuckRepeats();
  const memo = stuckMemo.get(s);
  if (memo && memo.lines === s.lines && memo.repeats === repeats) return memo.value;
  const value = findStuck(s.streaks || {}, repeats);
  stuckMemo.set(s, { lines: s.lines, repeats, value });
  return value;
}

// The stuck episode: a streak of at least `repeats` failures. When several read-only commands
// qualify at once, the one stuck longest wins, so the episode shown stays the same as they alternate.
function findStuck(streaks, repeats) {
  let best = null;
  for (const [id, streak] of Object.entries(streaks)) {
    if (streak.count >= repeats && (!best || streak.firstIndex < best.firstIndex)) {
      best = { command: id.slice(1), failures: streak.count, firstMs: streak.firstMs ?? null, lastMs: streak.lastMs ?? null, firstIndex: streak.firstIndex };
    }
  }
  return best;
}

// A command's key, and what the stuck rule needs to know about it. The key is the command without
// its shell, `timeout N` or `bash -c '…'` wrapper, with whitespace outside quotes collapsed; pipes,
// redirects and a leading `cd <dir> &&` stay in it. A very long key keeps its start and a hash.
// A command is never read-only when its text holds something this lexer does not follow: ANSI-C
// quoting ($'…'), command or process substitution ($(…), backticks, <(…), >(…)), including in a
// heredoc's body.
const OPAQUE = /\$'|\$\(|`|<\(|>\(/;
function commandShape(command) {
  const full = collapseSpaces(unwrapCommand(collapseSpaces(command)));
  if (!full) return null;
  const key = full.length > 300 ? `${full.slice(0, 240)}… #${createHash("sha1").update(full).digest("hex").slice(0, 12)}` : full;
  const text = unwrapCommand(command);
  const shell = parseShell(text);
  const commands = shell.commands.map((c) => ({ ...c, words: commandWords(c.words), lead: c.words }));
  return {
    key,
    readOnly: !shell.writes && !shell.opaque && !OPAQUE.test(text) && commands.length > 0 && commands.every(readOnlyCommand),
    never: commands.some(neverFails),
    piped: commands.some((c) => c.piped && ["tail", "head", "grep"].includes(path.basename(c.words[0] || ""))),
  };
}

function unwrapCommand(command) {
  let text = String(command ?? "").trim();
  for (;;) {
    let next = unwrapShell(text).trim();
    if (next === text) {
      const quoted = /^\S*?(?:ba|z)?sh\s+-l?c\s+"([^"\\$`]*)"$/.exec(text);
      const timed = /^timeout\s+(?:(?:-[ks]\s+\S+|--?[A-Za-z-]+(?:=\S+)?)\s+)*\d+(?:\.\d+)?[smhd]?\s+(\S[\s\S]*)$/.exec(text);
      next = (quoted || timed)?.[1].trim() ?? text;
    }
    if (next === text) return text;
    text = next;
  }
}

// Each run of whitespace outside quotes as one space, trimmed; quoted and escaped text keeps its own.
function collapseSpaces(text) {
  let out = "";
  let quote = null;
  let space = false;
  text = String(text ?? "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quote && /\s/.test(c)) {
      space = true;
      continue;
    }
    if (space && out) out += " ";
    space = false;
    out += c;
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === "\\" && i + 1 < text.length) {
      out += text[++i];
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return out;
}

// A small shell lexer, never an evaluator: the simple commands in `text` as word lists, split at
// pipes, &&, ||, ;, &, newlines and parentheses (`piped` when a pipe feeds one); whether a redirect
// writes a file other than /dev/null; and whether a quote is left open, which makes the text opaque
// here. Heredoc bodies are skipped (commandShape checks their text for substitutions).
function parseShell(text) {
  const commands = [];
  const heredocs = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  let piped = false;
  let target = null; // what the next word is: a redirect's file ("write" or "read") or a heredoc's end
  let writes = false;
  let opaque = false;
  const endWord = () => {
    if (!inWord) return;
    if (target === "write" && word !== "/dev/null") writes = true;
    else if (target?.startsWith("heredoc")) heredocs.push({ end: word, tabs: target === "heredoc-" });
    else if (!target) words.push(word);
    target = null;
    word = "";
    inWord = false;
  };
  const endCommand = (pipe) => {
    endWord();
    if (words.length) commands.push({ words, piped });
    words = [];
    piped = pipe;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "\\") {
      if (next !== undefined && next !== "\n") {
        word += next;
        inWord = true;
      }
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "\n") {
      endCommand(false);
      for (const { end, tabs } of heredocs.splice(0)) {
        for (;;) {
          const eol = text.indexOf("\n", i + 1);
          const line = text.slice(i + 1, eol === -1 ? text.length : eol);
          i = eol === -1 ? text.length : eol;
          if (eol === -1 || (tabs ? line.replace(/^\t+/, "") : line) === end) break;
        }
      }
    } else if (c === "|") {
      if (next === "|" || next === "&") i++;
      endCommand(next !== "|");
    } else if (c === "&" && next === ">") {
      endWord();
      i += text[i + 2] === ">" ? 2 : 1;
      target = "write";
    } else if (c === "&" || c === ";" || c === "(" || c === ")") {
      if (c === "&" && next === "&") i++;
      endCommand(false);
    } else if (c === ">" || c === "<") {
      if (inWord && /^\d+$/.test(word)) {
        word = ""; // a file descriptor number, as in 2>
        inWord = false;
      } else endWord();
      const op = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||>|<)/.exec(text.slice(i))[0];
      i += op.length - 1;
      const dup = op.endsWith("&") ? /^\s*(?:\d+-?|-)(?![^\s;&|<>()])/.exec(text.slice(i + 1)) : null;
      if (dup) i += dup[0].length; // 2>&1, >&2 or <&-: a descriptor copied or closed, no file
      else target = op === "<<" ? "heredoc" : op === "<<-" ? "heredoc-" : op.startsWith(">") || op === "<>" ? "write" : "read";
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) opaque = true;
  endCommand(false);
  return { commands, writes, opaque };
}

// A simple command's words from the program on: without variable assignments, `env`, `timeout N`,
// and the shell words that only lead into a command (if, then, do, !, and the like).
const LEADING = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time", "command", "builtin", "exec", "nohup"]);
function commandWords(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (LEADING.has(w) || /^[A-Za-z_]\w*=/.test(w)) i++;
    else if (w === "env") for (i++; words[i]?.startsWith("-"); ) i += /^-[uSC]$/.test(words[i]) ? 2 : 1;
    else if (w === "timeout") {
      for (i++; words[i]?.startsWith("-"); ) i += /^-[ks]$/.test(words[i]) ? 2 : 1;
      i++; // the duration
    } else break;
  }
  return words.slice(i);
}

// The arguments after `orch.mjs` when a command runs this CLI, directly or through node; else null.
function orchArgs([program, ...args]) {
  const name = path.basename(program || "");
  if (name === "orch.mjs") return args;
  if (!/^(?:node|nodejs|bun)$/.test(name)) return null;
  const script = args.findIndex((a) => !a.startsWith("-"));
  return script >= 0 && path.basename(args[script]) === "orch.mjs" ? args.slice(script + 1) : null;
}

// gh's command words, such as "pr checks": its first two words that are not flags. -R, --repo and
// --hostname take a value, which may come before the command.
function ghCommand(args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    if (/^(?:-R|--repo|--hostname)$/.test(args[i])) i++;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  return words.join(" ");
}

// Waiting, polling and probing commands exit non-zero by design; a run of one is never a failure.
// Its run still ends a streak, as any command that is not read-only does.
const PROBES = new Set(["sleep", "curl", "wget", "nc", "test", "[", "[[", "pgrep", "ps"]);
function neverFails({ words }) {
  const [program, ...args] = words;
  const name = path.basename(program || "");
  return PROBES.has(name) || orchArgs(words) !== null || (name === "gh" && ["pr checks", "run watch"].includes(ghCommand(args)));
}

// The read-only inspection commands: a small explicit allowlist. Shell words that run nothing by
// themselves (done, fi, a `for` header, true) are allowed around them; `cd` changes no file. A
// variable assignment or `env` before a command can make an allowed program run another (a pager,
// LESSOPEN, an external diff), so a command led by one is not read-only; nor are `git -c` and
// `rg --pre`, for the same reason.
const INSPECT = new Set(["cat", "head", "tail", "less", "grep", "rg", "ls", "wc", "stat", "file", "jq", "pwd", "echo", "cd"]);
const INERT = new Set(["done", "fi", "}", "for", "true", "false", ":"]);
function readOnlyCommand({ words, lead }) {
  if (lead.slice(0, lead.length - words.length).some((w) => w === "env" || /^[A-Za-z_]\w*=/.test(w))) return false;
  if (!words.length) return true;
  const [program, ...args] = words;
  const name = path.basename(program);
  if (name === "rg" && args.some((a) => /^--pre(?:=|$)/.test(a))) return false;
  if (INERT.has(program) || INSPECT.has(name)) return true;
  if (name === "find") return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (name === "sed") return sedReadOnly(args);
  if (name === "awk") return !args.some((a) => /[>|]|\bsystem\s*\(/.test(a));
  if (name === "git") {
    let i = 0;
    while (args[i]?.startsWith("-")) {
      if (/^(?:-c|--config-env|--exec-path)/.test(args[i])) return false;
      i += args[i] === "-C" ? 2 : 1;
    }
    return ["status", "diff", "log", "show", "blame", "grep"].includes(args[i]) && !args.slice(i + 1).some((a) => /^(?:--output|-O|--open-files-in-pager|--ext-diff)/.test(a));
  }
  const orch = orchArgs(words);
  return orch !== null && ["status", "log", "result", "inbox"].includes(orch[0]);
}

// sed is read-only only with -n (it prints nothing by itself), without -i, -f, --in-place or an
// option this does not know, and with scripts that have no w, W, e, r or R command (sedRuns).
const SED_SAFE_FLAGS = "nErsuz"; // -n, extended regexps, separate files, unbuffered, NUL lines
const SED_SAFE_LONG = new Set(["--quiet", "--silent", "--regexp-extended", "--posix", "--separate", "--unbuffered", "--null-data", "--zero-terminated", "--debug", "--sandbox"]);
function sedReadOnly(args) {
  let quiet = false;
  const scripts = [];
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (name === "--quiet" || name === "--silent") quiet = true;
      if (name === "--expression") scripts.push(eq < 0 ? args[++i] : a.slice(eq + 1));
      else if (!SED_SAFE_LONG.has(name)) return false;
    } else if (a.length > 1 && a.startsWith("-")) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === "e") {
          scripts.push(j + 1 < a.length ? a.slice(j + 1) : args[++i]);
          break;
        }
        if (!SED_SAFE_FLAGS.includes(a[j])) return false;
        if (a[j] === "n") quiet = true;
      }
    } else operands.push(a);
  }
  if (!scripts.length) scripts.push(operands[0]);
  return quiet && scripts.every((script) => typeof script === "string" && !sedRuns(script));
}

// Whether a sed script can write a file, read one in or run a command: a w, W, e, r or R command,
// or an s command with a w or e flag. A script this cannot follow counts as one that can.
function sedRuns(script) {
  const n = script.length;
  let i = 0;
  // Past the next unescaped `d`, from just after an opening delimiter; false if there is none.
  const part = (d) => {
    for (; i < n; i++) {
      if (script[i] === "\\") i++;
      else if (script[i] === d) {
        i++;
        return true;
      }
    }
    return false;
  };
  const skip = (re) => {
    while (i < n && re.test(script[i])) i++;
  };
  // One address: a line number, first~step, $, /regex/ or \cregexc (with I or M after it).
  const address = () => {
    const c = script[i];
    if (c === "/" || c === "\\") {
      const d = c === "/" ? "/" : script[++i];
      i++;
      if (!d || !part(d)) return false;
      skip(/[IM]/);
    } else if (c === "$") i++;
    else skip(/[\d~]/);
    return true;
  };
  for (;;) {
    skip(/[\s;]/);
    if (i >= n) return false;
    if (script[i] === "#") {
      while (i < n && script[i] !== "\n") i++;
      continue;
    }
    if (script[i] === "}") {
      i++;
      continue;
    }
    if (!address()) return true;
    if (script[i] === ",") {
      i++;
      if (script[i] === "+" || script[i] === "~") {
        i++;
        skip(/\d/);
      } else if (!address()) return true;
    }
    skip(/[ \t!]/);
    const cmd = script[i++];
    if (cmd === undefined) return true;
    if (cmd === "{") continue;
    if (cmd === "s" || cmd === "y") {
      const d = script[i++];
      if (!d || d === "\\" || d === "\n" || !part(d) || !part(d)) return true;
      if (cmd === "y") continue;
      // The s flags: w writes a file and e runs the pattern space; any other unknown flag counts too.
      for (; i < n && !/[;\n}]/.test(script[i]); i++) if (!/[gpiImM\d \t]/.test(script[i])) return true;
    } else if ("aic".includes(cmd)) {
      skip(/[^\n]/); // its text runs to the end of the line
    } else if (":btTv".includes(cmd)) {
      skip(/[^\n;]/); // a label runs to the end of the line or a semicolon
    } else if ("qQlL".includes(cmd)) {
      skip(/[ \t\d]/);
    } else if (!"=dDgGhHxnNpPzF".includes(cmd)) {
      return true; // w, W, e, r, R, or a command this does not know
    }
  }
}

// Incremental parse of a Codex rollout, reusing the event cache that `summarizeEvents` keeps.
export function summarizeRollout(file) {
  let entry = eventCache.get(file);
  if (!entry) {
    entry = loadSaved(file, "rollout") || { offset: 0, rest: "", summary: { ...newSummary(), busy: false, lastMessage: null, lastAt: null, effort: null } };
    eventCache.set(file, entry);
  }
  // Each rollout line starts with its timestamp and type; skip the conversation copies.
  readNewLines(entry, file, (line) => {
    const type = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([^"]+)"/.exec(line)?.[1];
    if (type && type !== "event_msg" && type !== "turn_context") return;
    try {
      applyCodexRolloutEvent(entry.summary, JSON.parse(line));
    } catch {
      // Skip a malformed line.
    }
  });
  maybeSave(file, "rollout", entry);
  return entry.summary;
}

// The shell commands an attempt ran, from its relay event stream, oldest first: [{ cmd, atMs,
// exitCode }], where exitCode is null while unknown. Read incrementally, like summarizeEvents. A
// command the agent's permissions denied never ran, so it is left out.
const commandCache = new Map(); // events path -> { offset, rest, state }
const COMMAND_LINE = /"tool_use"|"tool_result"|permission_denied|task_notification|command_execution/;
export function commandRuns(agent, file) {
  let entry = commandCache.get(file);
  if (!entry) {
    entry = { offset: 0, rest: "", state: { runs: [], byId: new Map() } };
    commandCache.set(file, entry);
  }
  const apply = agent === "codex" ? codexCommandEvent : claudeCommandEvent;
  readNewLines(entry, file, (line) => {
    if (!COMMAND_LINE.test(line)) return;
    try {
      apply(entry.state, JSON.parse(line));
    } catch {
      // Ignore a malformed line.
    }
  });
  return entry.state.runs.filter((run) => !run.denied);
}
