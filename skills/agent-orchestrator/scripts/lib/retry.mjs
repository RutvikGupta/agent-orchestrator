// Resume a transiently failed turn in its existing session, within a per-task retry budget.
import fs from "node:fs";
import path from "node:path";
import { summarizeEvents } from "./events.mjs";
import { loadTask, taskDir } from "./runs.mjs";
import { startTask, StartRefused } from "./commands/start.mjs";

export function retryLimit(value = process.env.AGENT_ORCH_MAX_RETRIES) {
  return /^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value)) ? Number(value) : 1;
}

export function retryTask(run, row, limit = retryLimit()) {
  if (row.health !== "transient-error" || row.limitHit || row.closed || !row.session || ["running", "prepared"].includes(row.state)) return null;
  const task = loadTask(run, row.id);
  if (!task || task.closedAt || task.attempt !== row.attempt || (task.retries || 0) >= limit) return null;
  const eventError = task.outDir ? summarizeEvents(task.agent, path.join(task.outDir, "events.jsonl"), task.cd).error : null;
  const error = [row.result?.error, row.result?.stderrTail, eventError, row.result?.finalMessage]
    .find((value) => value && (typeof value !== "string" || value.trim())) || "Transient provider or network error";
  const errorLine = (typeof error === "string" ? error : JSON.stringify(error)).split(/\r?\n/)[0];
  const retries = (task.retries || 0) + 1;
  const brief = path.join(taskDir(run, row.id), `retry-${retries}.md`);
  // The brief is also the claim: concurrent wait and dispatch callers cannot launch the same retry.
  try {
    fs.writeFileSync(brief, `Your previous turn ended with a transient provider or network error: ${errorLine}. Continue the task from where you left off; do not redo work that is already done. End with the same final report.\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  try {
    startTask({
      _: [run.dir, row.id], agent: row.agent, tier: row.tier, why: row.why, brief,
      "read-only": Boolean(task.readOnly),
      passthrough: ["--session", row.session],
    }, {
      attemptReason: "retry",
      retries,
      retryLog: [...(task.retryLog || []), { time: new Date().toISOString(), attempt: (task.attempt || 0) + 1, error: errorLine }],
    });
  } catch (error) {
    // Keep the normal resume hint if safety checks (for example parallel writers) refuse it.
    if (error instanceof StartRefused) {
      fs.unlinkSync(brief);
      return null;
    }
    throw error;
  }
  return `retried ${row.id} after a transient error (${retries}/${limit})`;
}
