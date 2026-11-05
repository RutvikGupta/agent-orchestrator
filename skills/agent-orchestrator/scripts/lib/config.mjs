// Settings shared by every module: where the CLI, the skill, and the state live (and the
// environment variables that move them), the nesting limits, and the supported agents.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();
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

// Supported implementers. Keys match the delegate-skills naming: `<key>-delegate`.
export const AGENTS = {
  claude: { bin: "claude", vendor: "Anthropic", authCmd: ["auth", "status"] },
  codex: { bin: "codex", vendor: "OpenAI", authCmd: ["login", "status"] },
};

// The hosts' own files: Claude Code's transcripts, and Codex's session logs (rollouts).
export const CLAUDE_PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects");
// Claude Code writes <pid>.json here for each running session, headless ones included.
export const CLAUDE_SESSIONS = path.join(path.dirname(CLAUDE_PROJECTS), "sessions");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");

// Files under the skill and the state root.
export const POLICY_PATH = path.join(SKILL_DIR, "policy.json");
export const USAGE_CACHE = path.join(STATE_ROOT, "usage.json");
export const PR_DIR = path.join(STATE_ROOT, "prs");
export const EXTERNAL_FILE = path.join(STATE_ROOT, "external.jsonl"); // agents started outside the orchestrator (external.mjs)
export const DASHBOARD_FILE = path.join(STATE_ROOT, "dashboard.json"); // pid and URL of the running dashboard
export const DASHBOARD_TOKEN_FILE = path.join(STATE_ROOT, "dashboard-token"); // the page's send key; only the user can read it
export const DASHBOARD_DIR = path.join(path.dirname(CLI_PATH), "dashboard"); // the page's static files
