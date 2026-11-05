#!/usr/bin/env node
// Seeds a self-contained demo board for screenshots of the Agent Orchestrator dashboard.
//
//   node docs/demo/seed.mjs --port <port> [--stop-file FILE]
//
// It builds a fictional project's runs (example-org/example-shop, story.mjs) in a new temporary
// folder, with AGENT_ORCH_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME pointing inside it, then starts
// this repository's dashboard on that state and prints its address with the send key. The real CLI
// does the work (`new`, `worktree`, `start`, `result`, `accept`, `reply`, the dashboard's own send
// endpoint), with a scripted relay (relay.mjs) in place of the agents. Files are written directly
// only for what the CLI cannot produce: the hosts' own transcripts (Claude Code, Codex), and aged
// timestamps, so the board shows sessions that have run for a while.
//
// The "running" agents stay alive until the stop file exists or Ctrl-C. Then it stops the
// processes it started, by PID, and deletes the temporary folder.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { limits, repoFiles, repoHistory, story } from "./story.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "..", "skills", "agent-orchestrator", "scripts", "orch.mjs");
const LIVE_PORT = 4777;
const NOW = Date.now();
const MIN = 60000;
const at = (min) => NOW - min * MIN;
const iso = (min) => new Date(at(min)).toISOString();
// When the user's two messages to cart-totals were sent, read and answered (minutes ago).
const INBOX_TIMES = { sent: 15, read: 14.6, replied: 14.2, queued: 2 };

const USAGE = "usage: node docs/demo/seed.mjs --port <port> [--stop-file FILE]";
function die(message) {
  process.stderr.write(`seed: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (name === "--help" || name === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (name !== "--port" && name !== "--stop-file") die(`unknown option ${argv[i]}\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined) die(`${name} needs a value`);
    args[name.slice(2)] = value;
  }
  if (!args.port) die(`--port is required\n${USAGE}`);
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) die("--port must be a number from 1024 to 65535");
  if (port === LIVE_PORT) die(`port ${LIVE_PORT} is the live dashboard's; choose another`);
  return { port, stopFile: args["stop-file"] ? path.resolve(args["stop-file"]) : null };
}

// The dashboard moves to the next free port, or reuses one of the user's dashboards that answers
// there, so the port must be free before it starts.
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const p2 = (n) => String(n).padStart(2, "0");
// orch.mjs's run-id stamp, in local time.
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
// A time-ordered id, as Codex gives its threads and turns.
function uuid7(ms) {
  const hex = Math.floor(ms).toString(16).padStart(12, "0");
  const r = createHash("sha256").update(`${ms}-${randomUUID()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${r.slice(0, 3)}-${"89ab"[parseInt(r[3], 16) % 4]}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
// macOS moves a file's birth time back when its modification time is set earlier, which is how
// the hosts' transcripts get their start times. The second call sets the latest write.
function age(file, startedMs, lastMs) {
  const now = new Date();
  fs.utimesSync(file, now, new Date(startedMs));
  fs.utimesSync(file, now, new Date(lastMs));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- The temporary world --------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-demo-")));
const dirs = {
  home: path.join(root, "home"),
  state: path.join(root, "state"),
  claude: path.join(root, "claude"),
  codex: path.join(root, "codex"),
  skills: path.join(root, "skills"),
  bin: path.join(root, "bin"),
  tmp: path.join(root, "tmp"),
  briefs: path.join(root, "briefs"),
  scripts: path.join(root, "scripts"),
  recipes: path.join(root, "recipes"),
};
const repo = path.join(dirs.home, "src", "example-shop");
const stopFile = opts.stopFile || path.join(root, "stop");

// An allowlist, as the tests use: no inherited nesting, session ids, git settings or credentials
// reach the CLI, the relays or the dashboard. The fake `gh` comes first on PATH, so nothing here
// can reach GitHub.
const env = {
  PATH: `${dirs.bin}${path.delimiter}${process.env.PATH}`,
  HOME: dirs.home,
  TMPDIR: dirs.tmp,
  LANG: process.env.LANG || "C",
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  AGENT_ORCH_HOME: dirs.state,
  AGENT_ORCH_SKILLS_DIR: dirs.skills,
  AGENT_ORCH_RECIPES_DIR: dirs.recipes,
  CLAUDE_CONFIG_DIR: dirs.claude,
  CODEX_HOME: dirs.codex,
  AGENT_ORCH_CLAUDE_BIN: "false", // never ask the user's `claude agents`; rows come from transcripts
  AGENT_ORCH_NOTIFY: "off", // no macOS notifications for the demo's attention items
  AGENT_ORCH_ESCALATE_AFTER: "24h",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(dirs.home, ".gitconfig"),
  GIT_AUTHOR_NAME: "Example Developer",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Example Developer",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  DEMO_ORCH_CLI: CLI,
  DEMO_SEED_PID: String(process.pid),
};
// What a terminal needs to read the demo with the CLI.
const viewEnv = `AGENT_ORCH_HOME=${dirs.state} CLAUDE_CONFIG_DIR=${dirs.claude} CODEX_HOME=${dirs.codex} AGENT_ORCH_CLAUDE_BIN=false`;

function orch(args, { env: extra = {}, passthrough = null, json = true } = {}) {
  const argv = [CLI, ...args, ...(json ? ["--json"] : []), ...(passthrough ? ["--", ...passthrough] : [])];
  const r = spawnSync(process.execPath, argv, { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`orch.mjs ${args.join(" ")} exited ${r.status ?? r.signal}\n${r.stdout}${r.stderr}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}
function git(args, cwd = repo, extra = {}) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildWorld() {
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  for (const agent of ["claude", "codex"]) {
    const target = path.join(dirs.skills, `${agent}-delegate`, "scripts", "relay.mjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(HERE, "relay.mjs"), target);
  }
  // `start --babysit` reads the pull request with `gh pr view`; this stand-in answers that alone.
  const gh = path.join(dirs.bin, "gh");
  fs.writeFileSync(gh, `#!/bin/sh
# Demo stand-in for the GitHub CLI: it answers the one question the demo asks and reaches nothing.
if [ "$1 $2" = "pr view" ]; then
  echo '{"number":212,"url":"https://github.com/example-org/example-shop/pull/212","state":"OPEN","isDraft":false,"title":"Checkout: saved-address API"}'
  exit 0
fi
echo "gh: not available in the demo" >&2
exit 1
`, { mode: 0o755 });
  // Claude Code's settings with the orch-inbox hook, so the dashboard says how messages reach Claude.
  writeJson(path.join(dirs.claude, "settings.json"), { hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node ~/.agents/skills/agent-orchestrator/scripts/hooks/orch-inbox.mjs" }] }] } });
  fs.mkdirSync(path.join(dirs.claude, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dirs.codex, "sessions"), { recursive: true });

  // The fictional repository, with a short history.
  for (const [file, text] of Object.entries(repoFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git(["init", "-q", "--initial-branch=main"]);
  git(["remote", "add", "origin", "git@github.com:example-org/example-shop.git"]);
  for (const [i, c] of repoHistory.entries()) {
    fs.appendFileSync(path.join(repo, "CHANGELOG.md"), `${i ? "" : "# Changelog\n\n"}- ${c.message}\n`);
    git(["add", "-A"]);
    const date = new Date(NOW - c.daysAgo * 24 * 60 * MIN).toISOString();
    git(["commit", "-qm", c.message], repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
}

// ---- The hosts' own transcripts -------------------------------------------------------------

// Token use that grows like a real session's: each model call re-reads the conversation so far.
function usageModel(seedText, base = 24000) {
  let seed = createHash("sha256").update(seedText).digest().readUInt32LE(0) || 1;
  const rand = (lo, hi) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return lo + (seed % (hi - lo + 1));
  };
  let context = base;
  return () => {
    const grow = rand(900, 4800);
    const u = { input_tokens: rand(2, 40), cache_creation_input_tokens: grow, cache_read_input_tokens: context, output_tokens: rand(90, 1600) };
    context += grow;
    return u;
  };
}

const claudeProject = path.join(dirs.claude, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));

// A Claude Code transcript (a session's, or one of its sub-agents'), written from story entries.
// A tool call marked `pending` gets its result when the next entry is added, as in a live session.
function claudeWriter(file, { sessionId, model = "claude-opus-5-5", effort = "xhigh", agentId = null }) {
  // A main session has read far more than a sub-agent by the time it orchestrates.
  const usage = usageModel(file, agentId ? 24000 : 60000);
  const lines = [];
  let parent = null;
  let pending = null;
  const line = (when, type, extra) => {
    const uuid = randomUUID();
    lines.push({ parentUuid: parent, isSidechain: Boolean(agentId), userType: "external", cwd: repo, sessionId, version: "2.3.4", gitBranch: "main",
      ...(agentId ? { agentId } : {}), type, ...extra, uuid, timestamp: iso(when) });
    parent = uuid;
  };
  const assistant = (when, block, stop) => line(when, "assistant", { message: { id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model, content: [block], stop_reason: stop, stop_sequence: null, usage: usage() }, requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`, ...(effort ? { effort } : {}) });
  // Claude Code records absolute paths; the story writes the demo's state root and home as `~/...`.
  const STATE = "~/.local/state/agent-orchestrator/";
  const abs = (f) => (f.startsWith(STATE) ? path.join(dirs.state, f.slice(STATE.length)) : f.startsWith("~/") ? path.join(dirs.home, f.slice(2)) : path.resolve(repo, f));
  const result = (when, id, e) => {
    const out = e.out ?? (e.t === "write" ? `File created successfully at: ${e.file}` : e.t === "edit" ? `The file ${e.file} has been updated.` : "");
    line(when, "user", { message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: out }] } });
  };
  // Adds entry `e` at `when` (minutes ago); a finished tool call's result comes at `resultWhen`.
  const add = (e, when, resultWhen = when) => {
    if (pending) {
      result(when, pending.id, pending.e);
      pending = null;
    }
    if (e.t === "user") return line(when, "user", { message: { role: "user", content: e.text } });
    if (e.t === "say" || e.t === "final") return assistant(when, { type: "text", text: e.text }, e.t === "final" ? "end_turn" : null);
    if (e.t === "think") return assistant(when, { type: "thinking", thinking: e.text, signature: "" }, null);
    const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const tool = e.t === "agent" ? { name: "Agent", input: { description: e.description, subagent_type: e.type, prompt: e.prompt, ...(e.background ? { run_in_background: true } : {}) } }
      : e.t === "read" ? { name: "Read", input: { file_path: abs(e.file) } }
      : e.t === "write" ? { name: "Write", input: { file_path: abs(e.file), content: "" } }
      : e.t === "edit" ? { name: "Edit", input: { file_path: abs(e.file), old_string: "", new_string: "" } }
      : e.t === "grep" ? { name: "Grep", input: { pattern: e.pattern, path: abs(e.path || "src") } }
      : e.t === "glob" ? { name: "Glob", input: { pattern: e.pattern } }
      : { name: "Bash", input: { command: e.cmd, description: "Run a command" } };
    assistant(when, { type: "tool_use", id, ...tool }, "tool_use");
    if (e.pending) pending = { id, e };
    else result(resultWhen, id, e);
  };
  return {
    add,
    lines,
    // One more step of a live session, now: the pending call returns and this one starts.
    step(e) {
      add({ ...e, pending: true }, (NOW - Date.now()) / MIN);
      fs.appendFileSync(file, lines.splice(0).map((l) => JSON.stringify(l)).join("\n") + "\n");
    },
  };
}

// Writes the entries; one without its own time (`at`) comes `step` minutes after the one before,
// and a sub-agent's are spread evenly from its start to its end (`endMin`). Returns the writer and
// the last entry's time.
function claudeTranscript(file, { entries, startedMin, endMin = null, title = null, ...who }) {
  const w = claudeWriter(file, who);
  const floor = endMin ?? 0;
  const step = endMin != null ? Math.max(0.02, (startedMin - endMin) / Math.max(1, entries.length)) : 0.3;
  let t = startedMin + step;
  for (const e of entries) {
    t = e.at ?? Math.max(floor, t - step);
    w.add(e, t, Math.max(floor, t - Math.min(0.2, step / 2)));
  }
  if (title) w.lines.push({ type: "ai-title", aiTitle: title, sessionId: who.sessionId });
  writeLines(file, w.lines.splice(0));
  return { writer: w, lastMin: t };
}

// Claude Code sessions: the main one, and the sub-agents it started with its Agent tool.
const touched = []; // running sub-agents' transcripts: their last write dates them
const live = []; // running main sessions, which take a step from their `cycle` every few minutes
function writeClaudeSession(s) {
  const file = path.join(claudeProject, `${s.sessionId}.jsonl`);
  const running = s.entries.at(-1).pending;
  const { writer, lastMin } = claudeTranscript(file, { sessionId: s.sessionId, entries: s.entries, startedMin: s.startedMin, title: s.title });
  age(file, at(s.startedMin), running ? NOW : at(lastMin));
  if (running && s.cycle?.length) live.push({ writer, cycle: s.cycle, next: 0 });
  for (const n of s.natives || []) {
    const agentId = randomUUID().replace(/-/g, "").slice(0, 17);
    const sub = path.join(claudeProject, s.sessionId, "subagents", `agent-${agentId}.jsonl`);
    const entries = [{ at: n.startedMin, t: "user", text: n.prompt }, ...n.steps, ...(n.running ? [] : [{ t: "final", text: n.final }])];
    claudeTranscript(sub, { sessionId: s.sessionId, entries, startedMin: n.startedMin, endMin: n.running ? 0 : n.endedMin, model: n.model, effort: n.effort, agentId });
    writeJson(sub.replace(/\.jsonl$/, ".meta.json"), { agentType: n.type, description: n.description });
    age(sub, at(n.startedMin), n.running ? NOW : at(n.endedMin));
    if (n.running) touched.push(sub);
  }
}

// A Codex session's rollout, as Codex writes it under CODEX_HOME/sessions/YYYY/MM/DD.
function writeCodexSession(s) {
  const started = at(s.startedMin);
  const d = new Date(started);
  const file = path.join(dirs.codex, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()),
    `rollout-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${s.sessionId}.jsonl`);
  const lines = [];
  const add = (min, type, payload) => lines.push({ timestamp: iso(min), type, payload });
  add(s.startedMin, "session_meta", { id: s.sessionId, timestamp: iso(s.startedMin), cwd: repo, originator: "codex_cli_rs", cli_version: "0.98.0", source: "cli", model_provider: "openai" });
  const usage = usageModel(s.sessionId, 30000);
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const l = limits.codex;
  for (const turn of s.turns) {
    let t = turn.at;
    const step = 0.4;
    const turnId = uuid7(at(turn.at) + 1000);
    add(t, "turn_context", { turn_id: turnId, cwd: repo, model: s.model, effort: s.effort, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } });
    add(t, "event_msg", { type: "task_started", turn_id: turnId, model_context_window: 400000 });
    add(t, "event_msg", { type: "item_completed", item: { type: "UserMessage", id: uuid7(at(t)), content: [{ type: "input_text", text: turn.user }] } });
    for (const item of turn.items) {
      t = item.at ?? Math.max(turn.endMin, t - step);
      for (let i = 0; i < 3; i++) {
        const u = usage();
        total.input_tokens += u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
        total.cached_input_tokens += u.cache_read_input_tokens;
        total.output_tokens += u.output_tokens;
      }
      if (item.t === "say") {
        add(t, "event_msg", { type: "item_completed", item: { type: "AgentMessage", id: uuid7(at(t)), content: [{ type: "output_text", text: item.text }] } });
      } else {
        const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        add(t, "event_msg", { type: "item_completed", item: { type: "CommandExecution", id: uuid7(at(t)), command: ["/bin/zsh", "-lc", item.cmd], exit_code: item.exit || 0 } });
        add(t, "response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify({ output: item.out || "", exit_code: item.exit || 0 }) });
      }
    }
    add(turn.endMin, "event_msg", { type: "token_count", info: { total_token_usage: { ...total, total_tokens: total.input_tokens + total.output_tokens }, model_context_window: 400000 },
      rate_limits: { primary: { used_percent: l.fiveHour, window_minutes: 300, resets_at: Math.round(at(l.fiveHourResetsMin) / 1000) }, secondary: { used_percent: l.week, window_minutes: 10080, resets_at: Math.round(at(l.weekResetsMin) / 1000) } } });
    add(turn.endMin, "event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: turn.items.filter((i) => i.t === "say").at(-1)?.text || null });
  }
  writeLines(file, lines);
  age(file, started, at(s.turns.at(-1).endMin));
}

// ---- Runs and tasks, through the CLI --------------------------------------------------------

function brief(run, t) {
  const role = t.babysit
    ? `You are the babysitter of pull request #${t.pr} in example-org/example-shop. Keep it moving until it merges: fix failing checks, answer review threads, and keep it mergeable. You may commit and push (never force).`
    : t.readOnly
      ? "You are a delegated reviewer working read-only in example-org/example-shop. Do not change any file."
      : "You are a delegated implementer working in a worktree of example-org/example-shop. Commit your work on this branch as you go.";
  return `${role}

## Goal

${t.goal}

## Context

- Run: ${run.goal}
- Money is integer cents (\`Money\`); never floats. The mobile app imports from \`src/cart\` and \`src/api\`: keep their exports stable.
- House rules: AGENTS.md at the repository root.

## Gates

- \`npm test\` for the files you touch, \`npx tsc --noEmit\`, \`npm run lint\`.
- The repository's testing skill \`e2e-seeded-shop\` for anything the checkout page shows.

## Report contract

At most 15 lines: what changed and why, the gates you ran with their results, and anything unresolved. Finish with the \`orch-result\` block.
`;
}

function relayScript(t, sessionId) {
  const end = { ...t.end, ...(t.end.finishedMin != null ? { finishedAt: iso(t.end.finishedMin) } : {}) };
  const c = limits.claude, x = limits.codex;
  return {
    session: sessionId,
    turnId: uuid7(at(t.startedMin) + 1500),
    startedAt: iso(t.startedMin),
    steps: t.steps,
    usage: t.usage,
    quiet: Boolean(t.quietMin),
    repeat: t.repeatMin ? { firstMs: (t.repeatMin - (t.quietMin || 0)) * MIN, everyMs: t.repeatMin * MIN } : null,
    commit: t.commit || null,
    inbox: t.inbox ? { before: t.inbox.before, reply: t.inbox.reply, after: t.inbox.after } : null,
    rateLimits: t.rateLimits ? { fiveHour: c.fiveHour, week: c.week, fiveHourResets: iso(c.fiveHourResetsMin), weekResets: iso(c.weekResetsMin) } : null,
    rollout: t.agent === "codex" ? { fiveHour: x.fiveHour, week: x.week, fiveHourResets: iso(x.fiveHourResetsMin), weekResets: iso(x.weekResetsMin), readAt: end.finishedAt || iso(0.5) } : null,
    end,
  };
}

const seeded = { runs: {}, tasks: [] }; // run key -> { id, dir, spec }; every started task

function seedRuns(spec, sessions) {
  for (const r of spec.runs) {
    const parent = r.parent ? { AGENT_ORCH_DEPTH: "1", AGENT_ORCH_RUN: seeded.runs[r.parent.run].id, AGENT_ORCH_TASK: r.parent.task } : {};
    const parentCd = r.parent ? readJson(path.join(seeded.runs[r.parent.run].dir, "tasks", r.parent.task, "task.json")).cd : null;
    const made = orch(["new", "--repo", parentCd || repo, "--name", r.name, "--goal", r.goal], { env: parent });
    // Age the run: its id and creation time say when it began, and the session that launched it
    // is the demo's (detecting it from this process's ancestors would find whatever runs the seed).
    const id = `${stamp(at(r.createdMin))}-${r.name}`;
    const dir = path.join(dirs.state, "runs", id);
    fs.renameSync(made.dir, dir);
    const record = readJson(path.join(dir, "run.json"));
    const session = r.session && sessions[r.session];
    writeJson(path.join(dir, "run.json"), { ...record, id, createdAt: iso(r.createdMin), ...(session ? { orchestrator: { agent: session.agent, sessionId: session.sessionId } } : {}) });
    seeded.runs[r.key] = { id, dir, spec: r, env: parent };

    for (const t of r.tasks) {
      if (t.worktree || t.branch) orch(["worktree", id, t.id, ...(t.branch ? ["--branch", t.branch] : [])], { env: parent });
      const briefFile = path.join(dirs.briefs, `${id}-${t.id}.md`);
      fs.writeFileSync(briefFile, brief(r, t));
      const sessionId = t.agent === "claude" ? randomUUID() : uuid7(at(t.startedMin));
      const scriptFile = path.join(dirs.scripts, `${id}-${t.id}.json`);
      writeJson(scriptFile, relayScript(t, sessionId));
      const cd = t.cdOf ? readJson(path.join(seeded.runs[r.parent.run].dir, "tasks", t.cdOf, "task.json")).cd : null;
      orch(["start", id, t.id, "--agent", t.agent, ...(t.tier ? ["--tier", t.tier] : []), "--why", t.why, "--brief", briefFile,
        ...(t.readOnly ? ["--read-only"] : []), ...(t.babysit ? ["--babysit", "--pr", String(t.pr)] : []), ...(cd ? ["--cd", cd] : [])],
      { env: parent, passthrough: [...(t.relayArgs || []), "--demo-script", scriptFile] });
      // The task began earlier than now: its record and its relay's result say when.
      const taskFile = path.join(dir, "tasks", t.id, "task.json");
      const task = readJson(taskFile);
      writeJson(taskFile, { ...task, createdAt: iso(t.startedMin + 0.5), startedAt: iso(t.startedMin) });
      seeded.tasks.push({ run: seeded.runs[r.key], spec: t, outDir: task.outDir, pid: task.pid });
    }
  }
}

async function settleTasks() {
  for (const t of seeded.tasks) {
    const done = t.spec.end.status !== "running";
    await until(() => fs.existsSync(path.join(t.outDir, done ? "result.json" : "ready")), `${t.spec.id} to ${done ? "finish" : "start"}`);
    if (t.spec.after === "result") orch(["result", t.run.id, t.spec.id], { env: t.run.env });
    if (t.spec.after === "accept") orch(["accept", t.run.id, t.spec.id], { env: t.run.env });
    // A babysitter waiting in pr-watch is quiet by design; its stream last moved a few minutes ago.
    if (t.spec.quietMin) fs.utimesSync(path.join(t.outDir, "events.jsonl"), new Date(), new Date(at(t.spec.quietMin)));
  }
}

// ---- The dashboard, and the user's messages to a running task --------------------------------

let dashboard = null;
async function startDashboard(port) {
  dashboard = spawn(process.execPath, [CLI, "dashboard", "--host", "127.0.0.1", "--port", String(port)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  dashboard.stdout.on("data", (chunk) => { output += chunk; });
  dashboard.stderr.on("data", (chunk) => { output += chunk; });
  const recordFile = path.join(dirs.state, "dashboard.json");
  try {
    const record = await until(() => {
      if (dashboard.exitCode !== null) throw new Error(`the dashboard exited: ${output}`);
      if (!fs.existsSync(recordFile)) return null;
      const r = readJson(recordFile);
      return r.pid === dashboard.pid ? r : null;
    }, "the dashboard to start", 30000);
    const token = fs.readFileSync(path.join(dirs.state, "dashboard-token"), "utf8").trim();
    return { url: record.url, token };
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  }
}

// Sends a message as the user does, from the dashboard's own page: its endpoint, origin and key.
function sendAsUser(url, token, run, task, text) {
  const u = new URL("api/send", url);
  const body = JSON.stringify({ run, task, text, steer: false });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: {
      host: u.host, origin: `http://${u.host}`, "content-type": "application/json", "x-orch-token": token, "content-length": Buffer.byteLength(body),
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`send to ${task}: HTTP ${res.statusCode} ${text}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function seedInbox(url, token) {
  const t = seeded.tasks.find((x) => x.spec.inbox);
  if (!t) return;
  const taskDir = path.dirname(t.outDir);
  const first = await sendAsUser(url, token, t.run.id, t.spec.id, t.spec.inbox.message);
  // The relay plays the agent: the inbox hook hands it the message, and it answers with `reply`.
  await until(() => fs.existsSync(path.join(t.outDir, "demo-inbox-done")), `${t.spec.id} to answer the user`);
  const queued = await sendAsUser(url, token, t.run.id, t.spec.id, t.spec.inbox.queued);
  // Then date them as they would have been sent and answered over the last quarter hour.
  const rewrite = (name, change) => {
    const file = path.join(taskDir, name);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => change(JSON.parse(l)));
    fs.writeFileSync(`${file}.tmp`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.renameSync(`${file}.tmp`, file);
  };
  rewrite("inbox.jsonl", (m) => ({ ...m, time: iso(m.id === first.id ? INBOX_TIMES.sent : m.id === queued.id ? INBOX_TIMES.queued : INBOX_TIMES.sent) }));
  rewrite("inbox-read.jsonl", (r) => ({ ...r, time: iso(INBOX_TIMES.read) }));
  rewrite("replies.jsonl", (r) => ({ ...r, time: iso(INBOX_TIMES.replied) }));
}

// ---- Stopping -------------------------------------------------------------------------------

const commandOf = (pid) => spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.trim();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// The relays this seed started are the PIDs in its own task records; each is checked to still be
// a relay under this demo's folder before it is signalled, so a reused PID is never touched.
function demoRelays() {
  const pids = [];
  const runs = path.join(dirs.state, "runs");
  for (const run of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    const tasks = path.join(runs, run, "tasks");
    for (const id of fs.existsSync(tasks) ? fs.readdirSync(tasks) : []) {
      try {
        const pid = readJson(path.join(tasks, id, "task.json")).pid;
        if (pid && alive(pid) && commandOf(pid).includes(`${root}/skills/`)) pids.push(pid);
      } catch {}
    }
  }
  return pids;
}

let stopping = null;
function stop(code) {
  if (stopping) return stopping;
  stopping = (async () => {
    const relays = demoRelays();
    for (const pid of relays) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    if (dashboard && dashboard.exitCode === null && dashboard.signalCode === null) dashboard.kill("SIGTERM");
    const left = () => [...relays.filter(alive), ...(dashboard && dashboard.exitCode === null && dashboard.signalCode === null ? [dashboard.pid] : [])];
    const end = Date.now() + 5000;
    while (left().length && Date.now() < end) await sleep(100);
    for (const pid of left()) {
      if (pid === dashboard?.pid || commandOf(pid).includes(`${root}/skills/`)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
    process.stdout.write(`stopped ${relays.length} relay${relays.length === 1 ? "" : "s"} and the dashboard; removed ${root}\n`);
    process.exit(code);
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(0));

// ---- Main -----------------------------------------------------------------------------------

async function main() {
  const refuse = (message) => {
    fs.rmSync(root, { recursive: true, force: true });
    die(message);
  };
  if (!(await portFree(opts.port))) refuse(`port ${opts.port} is in use; choose a free one`);
  if (opts.stopFile && fs.existsSync(opts.stopFile)) refuse(`the stop file already exists: ${opts.stopFile}`);
  buildWorld();

  const sessions = {
    checkout: { agent: "claude", sessionId: randomUUID() },
    search: { agent: "codex", sessionId: null },
    uploads: { agent: "claude", sessionId: randomUUID() },
  };
  const draft = story({});
  sessions.search.sessionId = uuid7(at(draft.sessions.find((s) => s.key === "search").startedMin));
  const ids = Object.fromEntries(draft.runs.map((r) => [r.key, `${stamp(at(r.createdMin))}-${r.name}`]));
  const spec = story(ids);
  for (const s of spec.sessions) {
    const session = { ...s, ...sessions[s.key] };
    if (s.agent === "codex") writeCodexSession(session);
    else writeClaudeSession(session);
  }

  seedRuns(spec, sessions);
  await settleTasks();
  const { url, token } = await startDashboard(opts.port);
  await seedInbox(url, token);

  const main = seeded.runs.checkout.id;
  process.stdout.write([
    "Demo board for example-org/example-shop is ready.",
    `  open:  ${url}#token=${token}`,
    `  runs:  ${Object.values(seeded.runs).map((r) => r.id).join(", ")}`,
    `  CLI:   env ${viewEnv} node ${CLI} status ${main}`,
    `  stop:  touch ${stopFile}   (or press Ctrl-C)`,
    `  state: ${root}`,
    "",
  ].join("\n"));

  // Keep the running sessions working, as live ones do, until told to stop: sub-agents' transcripts
  // stay fresh, and each running main session takes its next step every 2.5 minutes.
  let beat = 0;
  while (!fs.existsSync(stopFile)) {
    if (dashboard.exitCode !== null) throw new Error(`the dashboard exited (${dashboard.exitCode})`);
    beat += 1;
    if (beat % 40 === 0) {
      const now = new Date();
      for (const file of touched) {
        try {
          fs.utimesSync(file, now, now);
        } catch {}
      }
    }
    if (beat % 300 === 0) {
      for (const s of live) {
        s.writer.step(s.cycle[s.next]);
        s.next = (s.next + 1) % s.cycle.length;
      }
    }
    await sleep(500);
  }
  await stop(0);
}

main().catch((error) => {
  process.stderr.write(`seed: ${error.stack || error.message}\n`);
  stop(1);
});
