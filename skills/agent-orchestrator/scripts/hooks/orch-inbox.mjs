#!/usr/bin/env node
// Claude Code PostToolUse hook: hands an orchestrated agent the messages its orchestrator sent with
// `orch.mjs send`, as context after its tool call, and marks them read. Registered in the user's
// settings as `node <skill>/scripts/hooks/orch-inbox.mjs`, so it runs after every tool call of
// every Claude session. A session that `start` did not launch has no AGENT_ORCH_RUN and
// AGENT_ORCH_TASK, and the hook exits before loading anything else. The hook input on stdin is
// not needed, so it is never read. The hook never fails the tool call: it always exits 0.

const runId = process.env.AGENT_ORCH_RUN;
const taskId = process.env.AGENT_ORCH_TASK;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a run or task id, never a path

async function deliver() {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  const { default: path } = await import("node:path");
  const { RUNS_DIR } = await import("../lib/config.mjs");
  const { USER_FIRST, markRead, readInbox, replyHint, senderLabel, steeredNote } = await import("../lib/inbox.mjs");
  const dir = path.join(RUNS_DIR, runId, "tasks", taskId);
  const unread = readInbox(dir).filter((m) => !m.read);
  if (!unread.length) return;
  const additionalContext = unread.map((m) => `${senderLabel(m)} (${m.time}): ${m.text}${m.steered ? `\n${steeredNote(m.steered)}` : ""}${m.from === "user" ? `\n${USER_FIRST} ${replyHint(runId, taskId)}` : ""}`).join("\n");
  // Registered for PostToolUse and, so that a stopped command delivers too, PostToolUseFailure.
  const hookEventName = process.argv[2] === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`);
  markRead(dir, unread.map((m) => m.id), { attempt: Math.max(...unread.map((m) => m.attempt || 1)) });
}

if (runId && taskId && NAME.test(runId) && NAME.test(taskId)) {
  try {
    await deliver();
  } catch {}
}
process.exitCode = 0;
