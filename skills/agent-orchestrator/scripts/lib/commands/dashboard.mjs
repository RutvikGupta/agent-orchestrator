// `dashboard`: reuse a running dashboard, start one in the background or the foreground, or stop it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, DASHBOARD_FILE, STATE_ROOT } from "../config.mjs";
import { keyedUrl, openBrowser, serveDashboard } from "../dashboard-server.mjs";
import { die, emit, readJson } from "../util.mjs";

const PAGE_OPEN_MS = 10000; // the page polls every 2 s, so a request this recent means a tab shows it
// Each open tab also holds an event stream (/api/presence) for as long as it is open. Chrome
// throttles a background tab's polling to about once a minute, but not an open connection.

// How long `dashboard --detach` waits for the server it started to record itself.
const DETACH_WAIT_MS = 60_000;

// The address of the dashboard with process `pid`, found by its health check on the ports it tries
// (the asked one and the next ten), or null.
async function serverUrl(host, port, pid) {
  for (let p = port; p <= port + 10; p++) {
    const url = `http://${host}:${p}/`;
    if ((await dashboardHealth(url))?.pid === pid) return url;
  }
  return null;
}

// The dashboard answering at URL, or null when none does.
async function dashboardHealth(url) {
  const get = (p) => fetch(new URL(p, url), { signal: AbortSignal.timeout(1500) });
  try {
    const r = await get("api/health");
    if (r.ok) return await r.json();
    const s = await get("api/state"); // a dashboard from an older orch.mjs has no health endpoint
    return s.ok && Array.isArray(await s.json()) ? { pid: null, pageAgoMs: null } : null;
  } catch {
    return null;
  }
}

// Whether the dashboard answering at `url` is one this account runs. Any account can listen on a
// loopback port, and a page served there could read the send key from the address that --open
// opens, so the key goes only to a server whose process belongs to this user, runs orch.mjs
// dashboard, and itself listens on that port.
function ownDashboard(health, url) {
  const pid = Number(health?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const ps = spawnSync("ps", ["-ww", "-o", "uid=,command=", "-p", String(pid)], { encoding: "utf8" });
  const m = /^\s*(\d+)\s+(.*)$/.exec((ps.stdout || "").trim());
  if (!m || Number(m[1]) !== process.getuid?.() || !/orch\.mjs\s+dashboard\b/.test(m[2])) return false;
  const port = new URL(url).port || "80";
  const lsof = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return lsof.status === 0 && lsof.stdout.trim().split("\n").includes(String(pid));
}

export async function cmdDashboard(args) {
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || 4777);
  const record = readJson(DASHBOARD_FILE);
  const self = CLI_PATH;

  if (args.stop) {
    if (!record?.pid) return emit(args, { stopped: false }, "no detached dashboard is running");
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    fs.rmSync(DASHBOARD_FILE, { force: true });
    return emit(args, { stopped: true, ...record }, `stopped the dashboard at ${record.url} (pid ${record.pid})`);
  }

  // Reuse a dashboard that is already serving, and open a browser tab only if none shows it.
  for (const url of [...new Set([record?.url, `http://${host}:${port}/`].filter(Boolean))]) {
    const health = await dashboardHealth(url);
    // Something else on the port (another account's server, or an orch.mjs too old to say its pid)
    // is never reused: a new dashboard starts on the next free port instead.
    if (!health || !ownDashboard(health, url)) continue;
    const tabOpen = health.tabs > 0 || (health.pageAgoMs != null && health.pageAgoMs < PAGE_OPEN_MS);
    // --new-tab opens one even when a tab shows it, to hand this browser the send key.
    const opening = args.open && (!tabOpen || args["new-tab"]);
    if (opening) openBrowser(keyedUrl(url));
    const note = opening ? "opened in the browser" : tabOpen ? "a browser tab already shows it" : "not opened";
    return emit(args, { url, reused: true, ...health }, `dashboard: ${url}  (already running${health.pid ? `, pid ${health.pid}` : ""}; ${note})`);
  }

  // A recorded dashboard whose process still runs is busy (a first build over many large
  // transcripts can take a while), not gone: starting another would only add a second server
  // doing the same work. Hooks call this on every sub-agent start, so they would pile up.
  if (record?.pid && record.pid !== process.pid) {
    let alive = false;
    try {
      process.kill(record.pid, 0);
      alive = /orch\.mjs dashboard/.test(spawnSync("ps", ["-ww", "-o", "command=", "-p", String(record.pid)], { encoding: "utf8" }).stdout || "");
    } catch {}
    if (alive) return emit(args, { url: record.url, busy: true, pid: record.pid }, `dashboard: ${record.url}  (already running, pid ${record.pid}; busy, not answering yet)`);
  }

  if (args.detach) {
    const idle = args["idle-exit"] || "30m";
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    const logPath = path.join(STATE_ROOT, "dashboard.log");
    const log = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [self, "dashboard", "--host", host, "--port", String(port), "--idle-exit", idle], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    fs.closeSync(log);
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const stopHint = `  exits once no task is running and no browser tab has shown it for ${idle}; stop now with: node ${self} dashboard --stop`;
    // The server records itself once its first board is built. Wait a minute for that, while it lives.
    const deadline = Date.now() + DETACH_WAIT_MS;
    while (!exited() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rec = readJson(DASHBOARD_FILE);
      if (rec?.pid !== child.pid) continue;
      if (args.open) openBrowser(keyedUrl(rec.url));
      return emit(args, rec, `dashboard: ${rec.url}  (background pid ${rec.pid}${args.open ? ", opened in the browser" : ""})\n${stopHint}`);
    }
    // A first build on a busy machine can take minutes (AGENT_ORCH_FIRST_BUILD_TIMEOUT, 5m). A server
    // that still lives answers its health check meanwhile: it is starting, not failed, and a tab
    // opened now shows the board as soon as it is built.
    const url = exited() ? null : await serverUrl(host, port, child.pid);
    if (url) {
      if (args.open) openBrowser(keyedUrl(url));
      return emit(args, { url, pid: child.pid, building: true },
        `dashboard: ${url}  (background pid ${child.pid}, still building its first board${args.open ? "; opened in the browser" : ""})\n${stopHint}`);
    }
    die(`the background dashboard did not start; see ${logPath}`);
  }

  await serveDashboard({ host, port, args });
}
