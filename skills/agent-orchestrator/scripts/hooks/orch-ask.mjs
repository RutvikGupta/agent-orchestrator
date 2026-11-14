#!/usr/bin/env node
// Claude Code PreToolUse hook for the AskUserQuestion tool, the dialog that asks the user to choose
// an option. Registered in the user's settings as `node <skill>/scripts/hooks/orch-ask.mjs`, with the
// matcher AskUserQuestion; Codex has no such dialog. The input on stdin is Claude Code's event:
// {session_id, tool_name, tool_input, cwd, ...}. For any other tool it prints nothing.
//
// While the dialog is open, Claude Code delivers nothing to the session: a background `wait` that
// exits stays queued, scheduled prompts do not fire, the Stop hook does not run (the turn never
// ends), and messages wait. So the hook refuses the dialog:
//
// - inside an orch task (AGENT_ORCH_TASK), always: nobody answers a dialog there;
// - in a main session, while the session has work in flight in the runs it launched: a task that
//   runs or is parked, an unread result, or an open question or unresolved decision addressed to it.
//   This is the set the Stop hook (orch-stop.mjs) reads, from lib/session-work.mjs.
//
// To refuse, it prints one JSON object on stdout, {"hookSpecificOutput": {"hookEventName":
// "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}, which stops the
// tool call and shows the reason to the model. To allow, it prints nothing. It always exits 0.
//
// It never wedges a session: any error, a malformed or empty input, or more than about 1.8 seconds of
// work allows the dialog. AGENT_ORCH_ASK_HOOK=off turns it off. It reads files and runs at most one
// `ps`: no network and no board build.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a session id, never a path (as session-work.mjs checks)
const TOOL = "AskUserQuestion";
const BUDGET_MS = 1800; // Claude Code gives the hook a few seconds; stop early rather than risk it
const MAX_NAMED = 3; // tasks named in each part of the reason, then "and N more"
const started = Date.now();

const TASK_REASON = "Nobody answers a question dialog in a delegated task. Decide what your brief covers; hand back anything else with `orch.mjs ask` while you keep working, or end with NEEDS DECISION:.";
const mainReason = (inFlight) => `A question dialog stops this session until it is answered: task results, messages and scheduled prompts do not reach you while it is open, and ${inFlight}. Do not stop your work to wait for the user. Ask without a dialog: put the question, the options and your recommendation in your reply, and message the user if they may be away; go on with your recommended option, or with work that does not depend on the answer; keep \`wait\` running.`;

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
    return input && typeof input === "object" && !Array.isArray(input) ? input : {};
  } catch {
    return {};
  }
}

// "a", "a and b", "a, b and c".
const list = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

// The labels of a part, each once: at most MAX_NAMED, then "and N more": "(run/a, run/b, run/c and
// 2 more)".
function names(labels) {
  const unique = [...new Set(labels)];
  const more = unique.length - MAX_NAMED;
  return `(${unique.slice(0, MAX_NAMED).join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
}

// What the session has in flight, as one phrase, or "" when nothing is: "3 of your tasks are running
// (run/a, run/b, run/c) and 1 result is unread (run/d)".
function inFlightText(work) {
  const running = work.runs.flatMap((r) => r.running);
  const live = running.filter((t) => !t.parked).map((t) => t.label);
  const parked = running.filter((t) => t.parked).map((t) => t.label);
  const of = (kind) => work.items.filter((i) => i.kind === kind).map((i) => i.label);
  const parts = [];
  const add = (labels, one, many) => {
    if (labels.length) parts.push(`${labels.length === 1 ? one : many.replace("N", labels.length)} ${names(labels)}`);
  };
  add(live, "1 of your tasks is running", "N of your tasks are running");
  add(parked, "1 of your tasks is parked", "N of your tasks are parked");
  add(of("result"), "1 result is unread", "N results are unread");
  add(of("question"), "1 question from your tasks waits for your answer", "N questions from your tasks wait for your answer");
  add(of("decision"), "1 decision you read is unresolved", "N decisions you read are unresolved");
  return list(parts);
}

const deny = (reason) => {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
};

async function ask() {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  const input = await readInput();
  if (input.tool_name !== TOOL) return;
  if (process.env.AGENT_ORCH_TASK) return deny(TASK_REASON);
  // Claude Code sends session_id; the environment names the session when the input does not.
  const sessionId = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || "");
  if (!NAME.test(sessionId)) return;
  const { sessionWork } = await import("../lib/session-work.mjs");
  const work = sessionWork(sessionId, { deadline: started + BUDGET_MS });
  if (!work || Date.now() - started > BUDGET_MS) return;
  const inFlight = inFlightText(work);
  if (inFlight) deny(mainReason(inFlight));
}

if (process.env.AGENT_ORCH_ASK_HOOK !== "off") {
  setTimeout(() => process.exit(0), 1900).unref(); // a hook must never wedge a session
  try {
    await ask();
  } catch {}
}
process.exitCode = 0;
