#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool. Registered in the user's settings as
// `node <skill>/scripts/hooks/orch-resume-guard.mjs`, with the matcher Bash. The input on stdin is
// Claude Code's event: {session_id, tool_name, tool_input: {command}, cwd, ...}.
//
// It refuses a command that resumes a session a process still runs. A second `claude --resume <id>`
// (in tmux, nohup, `bash -c`, screen, ...) or `codex resume <id>` makes two processes write one
// session, and the original keeps running unseen: a session whose cross-session name changed on a
// restart looks unreachable, and an agent that took that for an ended session resumed it.
//
// It finds each resume in the command (lib/session-guard.mjs): `claude --resume <id>`, `claude -r <id>`,
// `claude --resume=<id>`, `codex resume <id>` and `codex exec resume <id>`, with an id that is a UUID
// or a prefix of 8 or more hex digits. A Claude session is running when `claude agents --json` lists
// it with a live process that is not a finished job; a Codex session, when a live Codex process has
// its id in its command line. To refuse, it prints one JSON object on stdout, {"hookSpecificOutput":
// {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}},
// which stops the call and tells the model to message the session. To allow, it prints nothing. It
// always exits 0.
//
// It never blocks a legitimate resume of a finished session: a session that is not running, an id
// that is malformed or ambiguous, a failing or slow `claude`, or any error allows the command. The
// session's own resume of itself (the event's session_id) is allowed. It does its work only for a
// command that contains a resume, so other Bash calls cost nothing. AGENT_ORCH_RESUME_GUARD=off turns
// it off. AGENT_ORCH_CLAUDE_BIN names the `claude` program, as elsewhere in the skill.
//
// Unlike the dialog hook, it may take a few seconds: `claude agents --json` starts the CLI. The
// `timeout` of its entry in the settings (10 seconds in integrations/claude/settings.example.json)
// bounds the whole hook, since Claude Code lets a call through when its hook overruns.

const BUDGET_MS = 5000; // for every lookup of one command; the settings' timeout is 10 seconds

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

const deny = (reason) => {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
};

async function guard() {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  const input = await readInput();
  if (input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return;
  const { resumeInvocations, liveClaudeSession, liveCodexSession, liveSessionReason } = await import("../lib/session-guard.mjs");
  const own = typeof input.session_id === "string" ? input.session_id : null;
  const deadline = Date.now() + BUDGET_MS;
  for (const { agent, id } of resumeInvocations(command)) {
    const left = deadline - Date.now();
    if (left < 300) return; // out of time: allow
    const live = agent === "claude" ? liveClaudeSession(id, { timeoutMs: left, skip: own }) : liveCodexSession(id, { timeoutMs: left });
    if (live) return deny(liveSessionReason(live, agent));
  }
}

if (process.env.AGENT_ORCH_RESUME_GUARD !== "off") {
  try {
    await guard();
  } catch {}
}
process.exitCode = 0;
