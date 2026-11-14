#!/usr/bin/env node
// Claude Code and Codex Stop hook: keeps a main session from ending its turn while items wait on it,
// or while nothing will wake it. Registered in the user's settings as `node <skill>/scripts/hooks/orch-stop.mjs`
// for every session. It does nothing inside an orch task (AGENT_ORCH_TASK) and when
// AGENT_ORCH_STOP_HOOK=off. The input on stdin is Claude Code's Stop event: {session_id,
// stop_hook_active, transcript_path, cwd}.
//
// It finds the runs this session launched (run.json's orchestrator.sessionId is the session's id) and
// blocks the stop, with {"decision":"block","reason":"..."} on stdout, in two cases:
//
// 1. Items address the session. Only tasks it started itself count (no `startedBy`): an open
//    question for it, an unread result, and a decision it read but has not resolved. A closed task
//    never counts, whether or not it was accepted, nor does one whose attempt a stop ended.
// 2. Nothing will wake it: a task of the run runs, or is parked, and no `orch.mjs wait` is live.
//
// It never loops. STATE_ROOT/stop-hook/<session>.json keeps a hash of the last blocked set; the same
// set is allowed through, and an empty set clears the record. It reads files and runs one `ps`: no
// network and no board build. Any error allows the stop, so the hook never wedges a session. It exits 0.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a run, task or session id, never a path
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
  const { spawnSync } = await import("node:child_process");
  const { CLI_PATH, RUNS_DIR, STATE_ROOT } = await import("../lib/config.mjs");
  const { ORCHESTRATOR, waitLive } = await import("../lib/addressee.mjs");
  const { decisionsIn } = await import("../lib/briefs.mjs");
  const { openQuestions, readInbox, readQuestions } = await import("../lib/inbox.mjs");
  const { acceptedNow } = await import("../lib/lifecycle.mjs");
  const { endedByStop, isParked } = await import("../lib/runs.mjs");
  const { readJson } = await import("../lib/util.mjs");

  const recordFile = path.join(STATE_ROOT, "stop-hook", `${sessionId}.json`);
  const allow = () => { fs.rmSync(recordFile, { force: true }); };

  // The runs this session launched.
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS_DIR);
  } catch {}
  const runs = [];
  for (const id of ids) {
    if (!NAME.test(id)) continue;
    const dir = path.join(RUNS_DIR, id);
    const run = readJson(path.join(dir, "run.json"));
    if (run?.orchestrator?.sessionId === sessionId) runs.push({ ...run, id: run.id || id, dir });
  }
  if (!runs.length) return allow();

  // One snapshot of the process table, taken before any result is read: a relay that is gone here
  // wrote its result before it exited, so a result read afterwards is never missing.
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 1000 });
  if (ps.status !== 0) return;
  const table = new Map();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), m[2]);
  }
  // As relayAlive() in runs.mjs: the process must still be a relay, or a fresh fork of one.
  const relayAlive = (pid, startedAt, outDir) => {
    const command = pid ? table.get(Number(pid)) : undefined;
    if (command === undefined) return false;
    // This task's own relay: one for another attempt folder is a later process with the same PID.
    if (command.includes("relay.mjs")) return !outDir || `${command} `.includes(`--out-dir ${outDir} `);
    const age = startedAt ? Date.now() - Date.parse(startedAt) : Infinity;
    return age >= 0 && age < 10000;
  };

  const cli = (words) => `node ${CLI_PATH} ${words}`;
  const quote = (text, max = 160) => {
    const one = String(text).replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };
  const items = []; // { key, text }
  const idle = []; // runs with a running task and no wait

  for (const run of runs) {
    if (Date.now() - started > BUDGET_MS) return;
    let taskIds = [];
    try {
      taskIds = fs.readdirSync(path.join(run.dir, "tasks"));
    } catch {}
    const running = [];
    for (const id of taskIds) {
      const dir = path.join(run.dir, "tasks", id);
      const task = readJson(path.join(dir, "task.json"));
      // A task another task started reports to that task, not to this session.
      if (!task || task.startedBy || !NAME.test(id)) continue;
      const attempt = task.attempt || 0;
      if (!attempt || !task.pid) continue;
      // A named task (`rename`) is shown, and named in each command, by its name; the keys keep its id.
      const ref = task.name && NAME.test(task.name) ? task.name : id;
      const label = `${run.id}/${ref}`;
      const alive = relayAlive(task.pid, task.startedAt, task.outDir);
      const parked = !alive && isParked(run, task);
      if (alive || parked) {
        running.push(ref);
        for (const q of openQuestions(readQuestions(dir), readInbox(dir), attempt)) {
          if (q.to !== ORCHESTRATOR) continue;
          items.push({
            key: [run.id, id, attempt, "question", q.id].join(":"),
            text: `${label} asked a question and keeps working: "${quote(q.question)}". Answer it with \`${cli(`send ${run.id} ${ref} "<answer>"`)}\`.`,
          });
        }
        continue;
      }
      const result = task.outDir ? readJson(path.join(task.outDir, "result.json")) : null;
      // An attempt that a stop ended (`stopped`) has no result to read: whoever stopped it knows.
      if (!result || endedByStop(task, result)) continue;
      const decisions = result.status === "completed" ? decisionsIn(result.finalMessage) : null;
      const resolved = task.decisionResolvedAttempt === attempt;
      if (decisions) {
        if (task.closedAt || resolved) continue;
        if (task.decisionSeenAttempt !== attempt) {
          items.push({
            key: [run.id, id, attempt, "result"].join(":"),
            text: `${label} handed back a decision and nobody has read its result. Read it with \`${cli(`result ${run.id} ${ref}`)}\`.`,
          });
          continue;
        }
        const agent = task.attemptAgents?.[attempt] || task.agent || "claude";
        const session = result.sessionId || result.threadId || "<session id from result>";
        items.push({
          key: [run.id, id, attempt, "decision"].join(":"),
          text: `${label} handed back a decision that you read and have not resolved: "${quote(decisions[0])}". Decide what the request covers, then resume it with \`${cli(`start ${run.id} ${ref} --agent ${agent} --brief <answer-file> -- --session ${session}`)}\`, or run \`${cli(`resolve ${run.id} ${ref} --note "<how>"`)}\` if you handled it another way, or \`${cli(`close ${run.id} ${ref}`)}\`.`,
        });
        continue;
      }
      // A closed task never blocks, accepted or not: `close` retired it, and `result`, which closes
      // a finished task as it hands its report over, cannot be told apart from `close`.
      if (!task.closedAt && !acceptedNow(task) && !resolved) {
        items.push({
          key: [run.id, id, attempt, "result"].join(":"),
          text: `${label} finished (${result.status || "unknown"}) and nobody has read its result. Read it with \`${cli(`result ${run.id} ${ref}`)}\`, then accept it, send it back with \`verdict ... changes\`, or close it; or run \`${cli(`close ${run.id} ${ref}`)}\` if you handled it another way.`,
        });
      }
    }
    if (!running.length) continue;
    // A live wait on the run: the Node process, the shell it parks in, or the Node process that
    // shell resumes; or the process that main-wait.json names, when it still runs a wait.
    if (!waitLive(run, table)) idle.push({ run, running });
  }

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
