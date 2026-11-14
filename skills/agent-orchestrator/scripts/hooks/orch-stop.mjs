#!/usr/bin/env node
// Claude Code and Codex Stop hook: keeps a main session from ending its turn while items wait on it,
// or while nothing will wake it. Registered in the user's settings as `node <skill>/scripts/hooks/orch-stop.mjs`
// for every session. It does nothing inside an orch task (AGENT_ORCH_TASK) and when
// AGENT_ORCH_STOP_HOOK=off. The input on stdin is Claude Code's Stop event: {session_id,
// stop_hook_active, transcript_path, cwd}.
//
// It finds the runs this session launched (run.json's orchestrator.sessionId is the session's id) and
// blocks the stop, with {"decision":"block","reason":"..."} on stdout, in two cases (both read by
// lib/session-work.mjs, which the question-dialog hook, orch-ask.mjs, shares):
//
// 1. Items address the session. Only tasks it started itself count (no `startedBy`): an open
//    question for it, an unread result, and a decision it read but has not resolved. A closed task
//    never counts, whether or not it was accepted, nor does one whose attempt a stop ended.
// 2. Nothing will wake it: a task of the run runs, or is parked, and no `orch.mjs wait` is live.
//
// It never loops. STATE_ROOT/stop-hook/<session>.json keeps a hash of the last blocked set; the same
// set is allowed through, and an empty set clears the record. It reads files and runs one `ps`: no
// network and no board build. Any error allows the stop, so the hook never wedges a session. It exits 0.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a session id, never a path (as session-work.mjs checks)
const BUDGET_MS = 1800; // Claude Code gives the hook a few seconds; stop early rather than risk it
const started = Date.now();

async function readInput() {
  if (process.stdin.isTTY) return {};
  const text = await new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, 1000);
    process.stdin.setEncoding("utf8").on("data", (chunk) => { data += chunk; }).on("end", done).on("error", done);
  });
  try {
    const input = JSON.parse(text);
    return input && typeof input === "object" ? input : {};
  } catch {
    return {};
  }
}

async function stop() {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  const input = await readInput();
  // Claude and Codex both send session_id; the environment names the session when the input does not.
  const sessionId = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || "");
  if (!NAME.test(sessionId)) return;

  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { CLI_PATH, STATE_ROOT } = await import("../lib/config.mjs");
  const { sessionWork } = await import("../lib/session-work.mjs");
  const { readJson } = await import("../lib/util.mjs");

  const recordFile = path.join(STATE_ROOT, "stop-hook", `${sessionId}.json`);
  const allow = () => { fs.rmSync(recordFile, { force: true }); };

  // The items that address this session, and its runs with a running task and no wait.
  const work = sessionWork(sessionId, { deadline: started + BUDGET_MS });
  if (!work) return;
  const cli = (words) => `node ${CLI_PATH} ${words}`;
  const items = work.items;
  const idle = work.runs.filter((r) => r.running.length && !r.waiting).map((r) => ({ run: r.run, running: r.running.map((t) => t.ref) }));

  const keys = [...items.map((i) => i.key), ...idle.map((i) => `${i.run.id}:no-wait`)].sort();
  if (!keys.length) return allow();
  const hash = createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
  // The same set was blocked before (a Stop that follows our own block has stop_hook_active set):
  // let the turn end. A different set blocks once more.
  if (readJson(recordFile)?.hash === hash) return;

  const lines = [];
  if (items.length) {
    lines.push("These items wait on this session. Handle them now, before ending the turn:");
    for (const item of items) lines.push(`- ${item.text}`);
  }
  for (const { run, running } of idle) {
    lines.push(`${items.length ? "\n" : ""}Nothing will wake this session: run ${run.id} has ${running.join(", ")} running, and no \`wait\` is live on it. Before ending the turn, start \`${cli(`wait ${run.id} --timeout 0`)}\` with the Bash tool's \`run_in_background: true\`.`);
  }
  lines.push("\nThis hook blocks once for each set of items. If you end the turn again without a change, it lets you.");
  const reason = lines.join("\n");
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify({ hash, at: new Date().toISOString(), keys })}\n`);
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

if (!process.env.AGENT_ORCH_TASK && process.env.AGENT_ORCH_STOP_HOOK !== "off") {
  setTimeout(() => process.exit(0), 1900).unref(); // a hook must never wedge a session
  try {
    await stop();
  } catch {}
}
process.exitCode = 0;
