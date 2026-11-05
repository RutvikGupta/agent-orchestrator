// `agents`: installed agent CLIs, their relays and login state, the model policy, and usage limits.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { AGENTS, HOME, POLICY_PATH, SKILL_ROOTS, STATE_ROOT, USAGE_CACHE } from "../config.mjs";
import { table } from "../format.mjs";
import { codexLimits, limitsText, probeClaudeLimits } from "../limits.mjs";
import { relayHasNetworkPatch } from "../permissions.mjs";
import { loadPolicy } from "../policy.mjs";
import { emit, findRelay, readJson, which } from "../util.mjs";

export function cmdAgents(args) {
  const rows = [];
  for (const [key, meta] of Object.entries(AGENTS)) {
    const binPath = which(meta.bin);
    const relay = findRelay(key);
    if (!binPath && !relay) continue;
    let version = null;
    let auth = binPath ? "unknown" : "-";
    if (binPath) {
      const v = spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      version = `${v.stdout || ""}${v.stderr || ""}`.trim().split("\n")[0] || null;
      if (meta.authCmd) {
        const r = spawnSync(binPath, meta.authCmd, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
        const text = `${r.stdout || ""}${r.stderr || ""}`;
        auth = r.status === 0 && !/"loggedIn"\s*:\s*false|not logged in/i.test(text) ? "ok" : "logged-out";
      }
    }
    const missing = [!binPath && `install ${meta.bin}`, !relay && `install ${key}-delegate`, auth === "logged-out" && "log in"]
      .filter(Boolean)
      .join(", ");
    rows.push({
      key,
      vendor: meta.vendor || "-",
      bin: binPath || "-",
      version: version || "-",
      relay: relay || "-",
      auth,
      ready: binPath && relay && auth !== "logged-out" ? "yes" : `no (${missing})`,
    });
  }
  const policy = loadPolicy();
  const known = new Set((readJson(path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "models_cache.json"))?.models || []).map((m) => m.slug));
  const flag = (m) => (known.size && !known.has(m) ? "  (not in this account's Codex model list!)" : "");
  const lines = [
    `claude → ${policy.claude.model}, effort ${policy.claude.effort} (always)`,
    ...Object.entries(policy.codex.tiers).map(([t, v]) => `codex --tier ${t.padEnd(8)} → ${v.model}, effort ${v.effort}: ${v.use || ""}${flag(v.model)}`),
  ];

  const installed = new Set(rows.filter((r) => r.bin !== "-").map((r) => r.key));
  let refreshNote = "";
  if (args.refresh && installed.has("claude") && !probeClaudeLimits(which("claude"))) {
    refreshNote = " (refresh failed: Claude reported no limits)";
  }
  const usage = {
    claude: installed.has("claude") ? readJson(USAGE_CACHE)?.claude || null : null,
    codex: installed.has("codex") ? codexLimits() : null,
  };
  const usageLines = [...installed].map((key) => {
    const text = limitsText(usage[key]);
    const hint = key === "claude" ? "run: agents --refresh" : "no recent Codex session logs";
    return `${key.padEnd(6)} ${text || `unknown (${hint})`}${key === "claude" ? refreshNote : ""}`;
  });
  const claudeRelay = findRelay("claude");
  const networkReady = relayHasNetworkPatch(claudeRelay);
  const githubNote =
    claudeRelay && !networkReady ? `\n\nnote: Claude tasks run without network until references/claude-delegate-network.patch is re-applied to ${claudeRelay}` : "";
  emit(
    args,
    { agents: rows, policy, policyPath: POLICY_PATH, usage, claudeNetwork: networkReady, skillRoots: SKILL_ROOTS, stateRoot: STATE_ROOT },
    `${table(rows, ["key", "vendor", "version", "auth", "ready"])}\n\nmodels (${POLICY_PATH}):\n  ${lines.join("\n  ")}` +
      `\n\nusage limits (share of each rolling window used; for information only: do not weigh them when choosing an agent; even 100% is not a reached limit, only a task stopped by a usage-limit error is):\n  ${usageLines.join("\n  ")}${githubNote}`,
  );
}
