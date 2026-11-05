// Usage limits: the share of each agent's rolling usage windows already used. They are shown for
// information and do not feed the choice of agent; only a limit that is reached matters. Every
// headless Claude session reports its limits (rate_limit_event); the newest reading is cached in
// USAGE_CACHE. Codex writes its limits into its own session logs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME, STATE_ROOT, USAGE_CACHE } from "./config.mjs";
import { agoText } from "./format.mjs";
import { CLAUDE_DEFAULT_TIER, loadPolicy } from "./policy.mjs";
import { readJson, tailBytes, writeJson } from "./util.mjs";

function windowName(minutes) {
  if (minutes >= 10080) return "week";
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function claudeLimits(info) {
  if (!info) return null;
  const at = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
  const windows = [
    ["five_hour", "5h"],
    ["seven_day", "week"],
  ]
    .filter(([key]) => typeof info.unifiedWindows?.[key]?.utilization === "number")
    .map(([key, name]) => ({
      name,
      usedPct: Math.round(info.unifiedWindows[key].utilization * 100),
      resetsAt: at(info.unifiedWindows[key].resetsAt),
    }));
  if (!windows.length && typeof info.utilization === "number") {
    windows.push({ name: info.rateLimitType === "seven_day" ? "week" : "5h", usedPct: Math.round(info.utilization * 100), resetsAt: at(info.resetsAt) });
  }
  return { status: info.status || null, overage: Boolean(info.isUsingOverage), windows };
}

export function rememberClaudeLimits(limits, observedAt, source) {
  const cache = readJson(USAGE_CACHE) || {};
  if (cache.claude?.observedAt && cache.claude.observedAt >= observedAt) return;
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  writeJson(USAGE_CACHE, { ...cache, claude: { ...limits, observedAt, source } });
}

// One minimal Claude turn (no tools, not saved as a session) to read Claude's current limits.
export function probeClaudeLimits(bin) {
  const { model, effort } = loadPolicy().claude.tiers[CLAUDE_DEFAULT_TIER];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const r = spawnSync(
    bin,
    ["-p", "Reply with the single word ok.", "--output-format", "stream-json", "--verbose", "--model", model,
      ...(effort ? ["--effort", effort] : []), "--tools", "", "--max-turns", "1", "--no-session-persistence"],
    { cwd: STATE_ROOT, env, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const limits = claudeLimits(JSON.parse(line).rate_limit_info);
      if (limits) {
        rememberClaudeLimits(limits, new Date().toISOString(), "agents --refresh");
        return true;
      }
    } catch {
      // Keep scanning.
    }
  }
  return false;
}

// The newest rate-limit record in the most recently written Codex session logs
// (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl), from any Codex session on this machine.
export function codexLimits() {
  const root = path.join(CODEX_HOME, "sessions");
  const sub = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  const days = [];
  for (const y of sub(root)) for (const m of sub(path.join(root, y))) for (const d of sub(path.join(root, y, m))) days.push(path.join(root, y, m, d));
  const files = days
    .slice(0, 10)
    .flatMap((dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n)))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5);
  for (const { file, mtime } of files) {
    const lines = tailBytes(file, 512 * 1024).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits":{')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const r = e.payload?.rate_limits;
        if (!r) continue;
        const windows = [r.primary, r.secondary]
          .filter((w) => typeof w?.used_percent === "number")
          .map((w) => ({
            name: windowName(w.window_minutes),
            usedPct: Math.round(w.used_percent),
            resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
          }));
        const status = r.rate_limit_reached_type ? `limit reached (${r.rate_limit_reached_type})` : "allowed";
        return { status, overage: false, windows, observedAt: e.timestamp || new Date(mtime).toISOString(), source: file };
      } catch {
        // A partial first line, or another record shape: keep looking.
      }
    }
  }
  return null;
}

export function limitsText(limits) {
  if (!limits?.windows?.length) return null;
  const now = Date.now();
  const when = (ms) =>
    new Date(ms).toLocaleString([], ms - now < 20 * 3600000 ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const parts = limits.windows.map((w) => {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : null;
    if (reset && reset <= now) return `${w.name} window reset since this reading`;
    return `${w.name} ${w.usedPct}% used${reset ? ` (resets ${when(reset)})` : ""}`;
  });
  if (limits.status && limits.status !== "allowed") parts.push(`status ${limits.status}`);
  if (limits.overage) parts.push("using overage");
  if (limits.observedAt) parts.push(`read ${agoText(now - Date.parse(limits.observedAt))} ago`);
  return parts.join(" · ");
}
