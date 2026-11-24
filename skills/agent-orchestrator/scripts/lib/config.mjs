// Settings shared by every module: where the CLI, the skill, and the state live (and the
// environment variables that move them), the nesting limits, and the supported agents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

// The Node binary that the processes the CLI starts run: relays, finish and park watchers, the
// idle shell of `wait` and `nap`, interrupt helpers, the dashboard. process.execPath is the resolved
// binary, which for Homebrew is a versioned Cellar path that an upgrade or a switch of versions
// deletes; every watcher started with it then fails to run Node, and a parked task never wakes. So
// prefer a `node` on PATH that is a link to the same binary (Homebrew's /opt/homebrew/bin/node
// follows each upgrade), else process.execPath while it exists, else the first `node` on PATH.
// The shell scripts that hold this path for a long time fall back to PATH as well (NODE_FALLBACK).
export function nodeBin(env = process.env) {
  const own = process.execPath;
  const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  let real = null;
  try { real = fs.realpathSync(own); } catch {}
  const name = process.platform === "win32" ? "node.exe" : "node";
  const onPath = String(env.PATH || "").split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir)).map((dir) => path.join(dir, name));
  if (real) {
    for (const candidate of onPath) {
      if (candidate === real) continue;
      try { if (fs.realpathSync(candidate) === real) return candidate; } catch {}
    }
    return own;
  }
  return onPath.find(exists) || own;
}

// Shell code that replaces the Node binary in "$1" with the first `node` on PATH when "$1" is an
// absolute path that is no longer an executable file: a watcher started before an upgrade still runs
// Node after it. A command named without a path (as tests do with `echo`) is left alone.
export const NODE_FALLBACK = 'case "$1" in /*) [ -x "$1" ] || { _n=$(command -v node 2>/dev/null) && [ -n "$_n" ] && shift && set -- "$_n" "$@"; };; esac;';
// The CLI that briefs, hints, and `dashboard --detach` name: scripts/orch.mjs, next to lib/.
export const CLI_PATH = fileURLToPath(new URL("../orch.mjs", import.meta.url));
export const SKILL_DIR = path.dirname(path.dirname(CLI_PATH));
export const STATE_ROOT =
  process.env.AGENT_ORCH_HOME ||
  path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "agent-orchestrator");
export const RUNS_DIR = path.join(STATE_ROOT, "runs");
// AGENT_ORCH_SKILLS_DIR replaces the search path rather than adding to it, so tests (and anyone
// pinning relays) can never fall through to the real relays installed for the user.
export const SKILL_ROOTS = process.env.AGENT_ORCH_SKILLS_DIR
  ? [process.env.AGENT_ORCH_SKILLS_DIR]
  : [path.dirname(SKILL_DIR), path.join(HOME, ".agents", "skills"), path.join(HOME, ".claude", "skills"), path.join(HOME, ".codex", "skills")];
export const DEFAULT_MAX_PARALLEL = Number(process.env.AGENT_ORCH_MAX_PARALLEL || 8);
export const DEPTH = Number(process.env.AGENT_ORCH_DEPTH || 0);
// Tests can poll promptly without changing the normal three-second wait cadence.
const configuredWaitPollMs = Number(process.env.AGENT_ORCH_WAIT_POLL_MS);
export const WAIT_POLL_MS = Number.isFinite(configuredWaitPollMs) && configuredWaitPollMs > 0 ? configuredWaitPollMs : 3000;
// A delegated agent may delegate in turn, down to this many levels of agents below the user's
// session. Deeper levels run fewer tasks at once, since every level multiplies the agents:
// the user's session 8 (AGENT_ORCH_MAX_PARALLEL), an agent it started 6, then 4, then 2.
export const MAX_NEST_DEPTH = Number(process.env.AGENT_ORCH_MAX_DEPTH || 4);
export const parallelAt = (depth) => [DEFAULT_MAX_PARALLEL, 6, 4, 2][depth] ?? 1;
export const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const QUIET_AFTER_MS = 5 * 60000; // a running task with no new events for this long is flagged
// A session or sub-agent (Claude or Codex) whose transcript is silent this long, longer than a
// tool call normally blocks, with its turn still open was cut off: its process was killed.
export const TURN_SILENT_MS = 30 * 60000;
export const CACHE_PATH = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules|\.DS_Store)(\/|$)/;

// How long an agent's naps may add up to in one attempt before `nap` refuses and tells it to park:
// AGENT_ORCH_NAP_BUDGET (90s, 10m, ...), default 10 minutes. A bad value falls back to the default.
export function napBudgetMs(value = process.env.AGENT_ORCH_NAP_BUDGET) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"] : 10 * 60000;
}

// Supported implementers. `relay` names the delegate skill that runs the agent, `<relay>-delegate`
// (relayFolder); it defaults to the key. Gemini models run through Cursor's `agent` CLI, so the
// gemini key runs the cursor-delegate relay.
export const AGENTS = {
  claude: { bin: "claude", vendor: "Anthropic", authCmd: ["auth", "status"] },
  codex: { bin: "codex", vendor: "OpenAI", authCmd: ["login", "status"] },
  // Cursor's status in JSON says isAuthenticated, which is false for a partial login (a missing
  // refresh token) although the command exits 0 (util.mjs, agentLogin).
  gemini: { bin: "agent", relay: "cursor", vendor: "Google via Cursor", authCmd: ["status", "--format", "json"], authJson: true },
};

// The delegate skill folder whose scripts/relay.mjs runs an agent: claude-delegate, cursor-delegate.
export const relayFolder = (key) => `${(Object.hasOwn(AGENTS, key) && AGENTS[key].relay) || key}-delegate`;
// An agent's display name: "Claude", "Codex", "Gemini".
export const agentName = (key) => String(key).charAt(0).toUpperCase() + String(key).slice(1);

// The hosts' own files: Claude Code's transcripts, and Codex's session logs (rollouts).
export const CLAUDE_PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects");
// Claude Code writes <pid>.json here for each running session, headless ones included.
export const CLAUDE_SESSIONS = path.join(path.dirname(CLAUDE_PROJECTS), "sessions");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");

// Files under the skill and the state root.
export const POLICY_PATH = path.join(SKILL_DIR, "policy.json");
// Model prices for cost estimates (cost.mjs), apart from the policy: `describe` reads them for every
// task, and must not read the policy for a task whose tier is known.
export const PRICES_PATH = path.join(SKILL_DIR, "prices.json");
export const USAGE_CACHE = path.join(STATE_ROOT, "usage.json");
export const EXTERNAL_FILE = path.join(STATE_ROOT, "external.jsonl"); // agents started outside the orchestrator (external.mjs)
export const DASHBOARD_FILE = path.join(STATE_ROOT, "dashboard.json"); // pid and URL of the running dashboard
export const DASHBOARD_TOKEN_FILE = path.join(STATE_ROOT, "dashboard-token"); // the page's send key; only the user can read it
export const DASHBOARD_DIR = path.join(path.dirname(CLI_PATH), "dashboard"); // the page's static files
