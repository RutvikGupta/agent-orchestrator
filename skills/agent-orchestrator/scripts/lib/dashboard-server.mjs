// The dashboard's local web server: serves the page in scripts/dashboard/ and its JSON API, and
// pushes a "change" event to open tabs as soon as an agent writes.

import { heavyStatus } from "./heavy.mjs";
import { CLI_PATH } from "./config.mjs";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS, CODEX_HOME, DASHBOARD_DIR, DASHBOARD_FILE, DASHBOARD_TOKEN_FILE, RUNS_DIR, STATE_ROOT, TASK_ID, USAGE_CACHE } from "./config.mjs";
import { anyTaskRunning, boardIds, dashboardState } from "./dashboard-state.mjs";
import { eventLog, transcriptLog } from "./event-log.mjs";
import { createEscalator, escalationCheckMs } from "./escalate.mjs";
import { codexLimits, limitsText } from "./limits.mjs";
import { SendError, deliverMessage, steerQueued } from "./commands/inbox.mjs";
import { DASHBOARD_CALLER } from "./ownership.mjs";
import { watchExternalAgents } from "./external.mjs";
import { loadTask, readProcessesInBackground } from "./runs.mjs";
import { readVendorStatusInBackground } from "./vendor-status.mjs";
import { die, parseDuration, readJson, writeJson } from "./util.mjs";

// The page's static files by path. They are read once, when the server starts, so a tab always
// gets the page of the server it talks to (and reloads when the server changes: x-orch-server).
const PAGE_FILES = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.css", "app.css", "text/css; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/logo.svg", "logo.svg", "image/svg+xml"],
];

function loadPage() {
  const page = new Map();
  for (const [route, name, type] of PAGE_FILES) {
    const file = path.join(DASHBOARD_DIR, name);
    try {
      page.set(route, { type, body: fs.readFileSync(file, "utf8") });
    } catch (error) {
      die(`cannot read the dashboard page file ${file}: ${error.message}`);
    }
  }
  return page;
}

// The key the page needs to send messages. Any local account can reach a loopback port, so the key
// is not served over HTTP: it lives in a file only the user can read, and reaches a tab only in
// the URL fragment that `dashboard --open` opens. The page keeps it in this browser's storage.
export function dashboardToken() {
  const valid = (text) => (/^[0-9a-f]{48}$/.test(text) ? text : null);
  const read = () => {
    try {
      return valid(fs.readFileSync(DASHBOARD_TOKEN_FILE, "utf8").trim());
    } catch {
      return null;
    }
  };
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  let token = read();
  if (!token) {
    try {
      fs.writeFileSync(DASHBOARD_TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    token = read();
    if (!token) {
      // A damaged file: replace it.
      fs.writeFileSync(DASHBOARD_TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
      token = read();
    }
  }
  fs.chmodSync(DASHBOARD_TOKEN_FILE, 0o600);
  return token;
}

// The dashboard's address with the send key in its fragment, which browsers never send to servers.
export const keyedUrl = (url) => `${url}#token=${dashboardToken()}`;

export function openBrowser(url) {
  // The send key in the fragment must never show in the process list, where other accounts could
  // read it. On macOS, AppleScript reads the address from stdin; elsewhere the browser opens a
  // file only this user can read, which forwards to the address.
  let target = url;
  if (process.platform !== "darwin" && url.includes("#token=")) {
    target = path.join(STATE_ROOT, "dashboard-open.html");
    fs.writeFileSync(target, `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(url).replaceAll("<", "\\u003c")})</script>\n`, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
  const [cmd, ...argv] =
    process.platform === "darwin" ? ["osascript", "-"] : process.platform === "win32" ? ["cmd", "/c", "start", "", target] : ["xdg-open", target];
  const child = spawn(cmd, argv, { stdio: [process.platform === "darwin" ? "pipe" : "ignore", "ignore", "ignore"], detached: true });
  child.on("error", () => process.stderr.write("orch: could not open a browser; run `dashboard --open` again, or open the dashboard's address yourself\n"));
  if (process.platform === "darwin") {
    child.stdin.on("error", () => {});
    child.stdin.end(`open location ${JSON.stringify(url)}\n`);
  }
  child.unref();
}

// A message's text, and up to MAX_IMAGES images of MAX_IMAGE_BYTES each, sent as base64 in JSON.
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES = Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3) + 4 * MAX_TEXT_CHARS + 64 * 1024;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

// The Host header names this server: a loopback name, or the address it was told to listen on.
// Any other name is a DNS-rebinding page posing as this origin, so it gets nothing. A server told
// to listen on every interface answers any name for reading, as it always has. Sending needs a
// loopback name whatever the address (`loopbackOnly`), so no other computer can send.
export function servesHost(header, host, port, { loopbackOnly = false } = {}) {
  if (typeof header !== "string") return false;
  if (WILDCARD_HOSTS.has(host) && !loopbackOnly) return true;
  const names = ["127.0.0.1", "localhost", "[::1]"];
  if (!loopbackOnly && !WILDCARD_HOSTS.has(host)) names.push(host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
  return names.some((name) => header.toLowerCase() === `${name}:${port}`);
}

// An attempt number in a query: a positive integer.
const ATTEMPT = /^[1-9]\d{0,5}$/;
// The details panel shows at most this much of a brief.
const BRIEF_BYTES = 200 * 1024;
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

// An attempt's brief for /api/brief, as { status, body }: { text, bytes }, with at most BRIEF_BYTES
// of the text and a note at its end when cut. Only the attempt's own orch-brief.md is read: its real
// path must be exactly <run>/tasks/<task>/attempt-<n>/orch-brief.md, so no link (of the file or of
// a folder above it) points the route at another file. It opens without following a link and
// without waiting on a pipe, must be a regular file, and is read asynchronously and capped, so no
// file can hold up the server.
async function readBrief(runDir, taskId, attempt) {
  const missing = { status: 404, body: { error: "no brief for that attempt" } };
  const real = (f) => fs.promises.realpath(f).catch(() => null);
  const root = await real(runDir);
  if (!root) return missing;
  const file = path.join(root, "tasks", taskId, `attempt-${attempt}`, "orch-brief.md");
  const target = await real(file);
  if (!target) return missing;
  if (target !== file) return { status: 403, body: { error: "not a brief of this run" } };
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    // A link swapped in after the check above refuses to open (ELOOP).
    return error.code === "ELOOP" ? { status: 403, body: { error: "not a brief of this run" } } : missing;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return missing;
    const buf = Buffer.alloc(Math.min(st.size, BRIEF_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    const cut = st.size > bytesRead;
    // A cut through a multi-byte character leaves a replacement character at the end; drop it.
    if (cut) text = `${text.replace(/\uFFFD+$/, "")}\n\n… (truncated: the first ${kb(bytesRead)} of ${kb(st.size)} are shown)`;
    return { status: 200, body: { text, bytes: st.size, ...(cut ? { truncated: true } : {}) } };
  } finally {
    await handle.close();
  }
}

// Serve the dashboard on host:port (or the next free port) until the process exits.
export async function serveDashboard({ host, port, args }) {
  const http = await import("node:http");
  readVendorStatusInBackground();
  readProcessesInBackground();
  watchExternalAgents();
  const page = loadPage();
  const startedAt = new Date().toISOString();
  let lastPage = null;
  let address = null;
  const tabs = new Set(); // presence streams of the open tabs
  // Tabs and change events can request state many times a second. Share one lane
  // snapshot between endpoints so process inspection runs at most every five seconds.
  let cachedHeavy = null, heavyCheckedAt = 0;
  const dashboardHeavy = () => {
    const now = Date.now();
    if (cachedHeavy === null || now - heavyCheckedAt >= 5000) {
      cachedHeavy = heavyStatus();
      heavyCheckedAt = now;
    }
    return cachedHeavy;
  };
  // Tell open tabs to refresh as soon as an agent writes, not on their next poll: the skill's own
  // run state, and the Claude and Codex files of sessions on the board (or newly created files,
  // such as a new sub-agent's). Bursts are combined into at most one notice every 500 ms.
  let pushTimer = null;
  let lastPush = 0;
  const notify = () => {
    if (pushTimer || !tabs.size) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      lastPush = Date.now();
      for (const t of tabs) t.write("event: change\ndata: \n\n");
    }, Math.max(0, lastPush + 500 - Date.now()));
  };
  const relevant = (kind, file) => kind === "rename" || !file || [...boardIds()].some((id) => String(file).includes(id));
  for (const [dir, all] of [[RUNS_DIR, true], [CLAUDE_PROJECTS, false], [path.join(CODEX_HOME, "sessions"), false]]) {
    try {
      fs.watch(dir, { recursive: true }, (kind, file) => (all || relevant(kind, file)) && notify()).on("error", () => {});
    } catch {
      // A missing directory just means that host is not used here; polling still covers it.
    }
  }
  // Sending a message steers an agent that runs with the user's own access, so only this server's
  // own page, opened by the user, may do it: it needs the send key (see dashboardToken), an Origin
  // naming this server on a loopback address, and a JSON body, which a page elsewhere can only send
  // after a CORS preflight that this server never answers.
  const token = dashboardToken();
  const tokenOk = (value) => {
    const given = Buffer.from(String(value || "")), expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  // Only this dashboard's own page, opened by the user on this computer, may steer an agent. True
  // when the request was refused (and answered), so the caller stops.
  const rejected = (req, reply) => {
    const refuse = (code, body) => (reply(code, body), true);
    if (req.method !== "POST") return refuse(405, { error: "use POST" });
    const origin = req.headers.origin;
    if (!servesHost(req.headers.host, host, port, { loopbackOnly: true }) || !origin || origin !== `http://${req.headers.host}`) {
      return refuse(403, { error: "messages can be sent only from this dashboard's own page, on this computer" });
    }
    if (!tokenOk(req.headers["x-orch-token"])) return refuse(403, { error: "this browser has no valid send key", key: "rejected" });
    if (!/^application\/json(;|$)/i.test(req.headers["content-type"] || "")) return refuse(415, { error: "send JSON" });
    return false;
  };
  // "Send now": push a task's queued messages through by stopping its current command.
  const steerNow = (req, res, reply) => {
    if (rejected(req, reply)) return;
    let text = "";
    req.on("data", (chunk) => { if (text.length < 4096) text += chunk; });
    req.on("error", () => {});
    req.on("end", () => {
      try {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return reply(400, { error: "the body is not JSON" });
        }
        const { run: runId, task: taskId } = body && typeof body === "object" ? body : {};
        if (typeof runId !== "string" || typeof taskId !== "string" || !/^\w[\w.-]*$/.test(runId) || !TASK_ID.test(taskId)) return reply(400, { error: "bad run or task" });
        const dir = path.join(RUNS_DIR, runId);
        if (!fs.existsSync(path.join(dir, "run.json"))) return reply(404, { error: "unknown run" });
        // The user's click: the user may steer any session's task (ownership.mjs).
        const result = steerQueued({ ...readJson(path.join(dir, "run.json")), dir }, taskId, { caller: DASHBOARD_CALLER });
        notify();
        return reply(200, result);
      } catch (error) {
        if (error instanceof SendError) return reply(error.status, { error: error.message });
        return reply(500, { error: String(error?.message || error) });
      }
    });
  };
  const receiveMessage = (req, res, reply) => {
    if (rejected(req, reply)) return;
    const chunks = [];
    let size = 0, refused = false;
    req.on("data", (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        refused = true;
        reply(413, { error: `a message with its images is limited to ${Math.round(MAX_MESSAGE_BYTES / 1024 / 1024)} MB` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (refused) return;
      try {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return reply(400, { error: "the body is not JSON" });
        }
        const { run: runId, task: taskId, text } = body && typeof body === "object" ? body : {};
        if (typeof runId !== "string" || typeof taskId !== "string" || !/^\w[\w.-]*$/.test(runId) || !TASK_ID.test(taskId)) {
          return reply(400, { error: "bad run or task" });
        }
        if (typeof text !== "string") return reply(400, { error: "the message must be text" });
        if (text.length > MAX_TEXT_CHARS) return reply(413, { error: `the text is limited to ${MAX_TEXT_CHARS / 1024}K characters` });
        const attached = body.images ?? [];
        if (!Array.isArray(attached) || attached.length > MAX_IMAGES) return reply(400, { error: `attach at most ${MAX_IMAGES} images` });
        const images = [];
        for (const image of attached) {
          if (typeof image?.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return reply(400, { error: "an image is not base64" });
          const data = Buffer.from(image.data, "base64");
          if (data.length > MAX_IMAGE_BYTES) return reply(413, { error: `images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB each` });
          images.push(data);
        }
        const dir = path.join(RUNS_DIR, runId);
        if (!fs.existsSync(path.join(dir, "run.json"))) return reply(404, { error: "unknown run" });
        const { message, delivery, reaches, steer } = deliverMessage({ ...readJson(path.join(dir, "run.json")), dir }, taskId, text, { from: "user", images, steer: body.steer === true, caller: DASHBOARD_CALLER });
        notify();
        return reply(200, { id: message.id, time: message.time, attempt: message.attempt, images: message.images || [], delivery, reaches, steer });
      } catch (error) {
        if (error instanceof SendError) return reply(error.status, { error: error.message });
        return reply(500, { error: String(error?.message || error) });
      }
    });
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const send = (code, type, body, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-orch-server": startedAt, ...headers });
      res.end(body);
    };
    const reply = (code, value) => send(code, "application/json", JSON.stringify(value));
    if (!servesHost(req.headers.host, host, port)) return send(403, "text/plain", "this dashboard answers only to its own address");
    if (url.pathname === "/api/send") return receiveMessage(req, res, reply);
    if (url.pathname === "/api/steer") return steerNow(req, res, reply);
    try {
      const asset = page.get(url.pathname);
      if (asset) return send(200, asset.type, asset.body);
      if (url.pathname === "/api/health") {
        return send(200, "application/json", JSON.stringify({ pid: process.pid, url: address, startedAt, pageAgoMs: lastPage ? Date.now() - lastPage : null, tabs: tabs.size }));
      }
      if (url.pathname === "/api/presence") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-orch-server": startedAt });
        res.write(": open\n\n");
        tabs.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
          clearInterval(ping);
          tabs.delete(res);
          lastPage = Date.now();
        });
        return;
      }
      if (url.pathname === "/api/heavy") return reply(200, dashboardHeavy());
      if (url.pathname === "/api/state") {
        lastPage = Date.now();
        return send(200, "application/json", JSON.stringify(dashboardState()), { "x-orch-heavy": JSON.stringify(dashboardHeavy()) });
      }
      if (url.pathname === "/api/usage") {
        const view = (l) => {
          if (!l?.windows?.length) return null;
          const live = l.windows.map((w) => ({ ...w, reset: w.resetsAt && Date.parse(w.resetsAt) <= Date.now() }));
          return {
            short: live.map((w) => `${w.name} ${w.reset ? "reset" : `${w.usedPct}%`}`).join(" · "),
            max: Math.max(...live.map((w) => (w.reset ? 0 : w.usedPct))),
            full: limitsText(l),
          };
        };
        const usage = { claude: view(readJson(USAGE_CACHE)?.claude), codex: view(codexLimits()) };
        return send(200, "application/json", JSON.stringify(usage));
      }
      if (url.pathname === "/api/events") {
        const runId = url.searchParams.get("run") || "";
        const taskId = url.searchParams.get("task") || "";
        if (!/^\w[\w.-]*$/.test(runId) || !TASK_ID.test(taskId)) return send(400, "application/json", '{"error":"bad run or task"}');
        // An attempt, when given, is a positive integer; without one the log is the current attempt's.
        const asked = url.searchParams.get("attempt");
        if (asked !== null && !ATTEMPT.test(asked)) return send(400, "application/json", '{"error":"bad attempt"}');
        const dir = path.join(RUNS_DIR, runId);
        if (!fs.existsSync(path.join(dir, "run.json"))) return send(404, "application/json", '{"error":"unknown run"}');
        const run = { ...readJson(path.join(dir, "run.json")), dir };
        const task = loadTask(run, taskId);
        if (!task?.attempt) return send(200, "application/json", '{"events":[]}');
        const attempt = Math.min(Number(asked || task.attempt), task.attempt);
        return send(200, "application/json", JSON.stringify({ events: eventLog(run, task, attempt, 400) }));
      }
      if (url.pathname === "/api/brief") {
        const runId = url.searchParams.get("run") || "";
        const taskId = url.searchParams.get("task") || "";
        if (!/^\w[\w.-]*$/.test(runId) || !TASK_ID.test(taskId)) return send(400, "application/json", '{"error":"bad run or task"}');
        const asked = url.searchParams.get("attempt") || "";
        if (!ATTEMPT.test(asked)) return send(400, "application/json", '{"error":"bad attempt"}');
        const dir = path.join(RUNS_DIR, runId);
        if (!fs.existsSync(path.join(dir, "run.json"))) return send(404, "application/json", '{"error":"unknown run"}');
        readBrief(dir, taskId, asked).then(
          (brief) => send(brief.status, "application/json", JSON.stringify(brief.body)),
          (error) => send(500, "text/plain", String(error?.message || error)),
        );
        return;
      }
      if (url.pathname === "/api/transcript") {
        const real = (f) => {
          try {
            return fs.realpathSync(f);
          } catch {
            return null;
          }
        };
        const file = real(url.searchParams.get("file") || "");
        if (!file) return send(404, "application/json", '{"error":"no such transcript"}');
        const under = (root) => Boolean(root) && file.startsWith(root + path.sep);
        const codex = under(real(path.join(CODEX_HOME, "sessions")));
        if (!file.endsWith(".jsonl") || !(codex || under(real(CLAUDE_PROJECTS)))) return send(403, "application/json", '{"error":"not a session transcript"}');
        return send(200, "application/json", JSON.stringify({ events: transcriptLog(file, codex, 400) }));
      }
      return send(404, "text/plain", "not found");
    } catch (error) {
      return send(500, "text/plain", String(error?.message || error));
    }
  });
  for (let tries = 0; ; tries++) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || tries >= 10) die(`cannot listen on ${host}:${port}: ${error.message}`);
      port += 1;
    }
  }
  address = `http://${host}:${port}/`;
  // The first build reads every transcript on the board; do it before announcing the dashboard,
  // so a tab that --open starts gets the board at once instead of a blank page.
  try {
    dashboardState();
  } catch {
    // The page's own request reports the error.
  }
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  writeJson(DASHBOARD_FILE, { pid: process.pid, url: address, startedAt });
  const forget = () => {
    if (readJson(DASHBOARD_FILE)?.pid === process.pid) fs.rmSync(DASHBOARD_FILE, { force: true });
  };
  process.on("exit", forget);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));

  // Escalation runs even with no open tabs: the macOS notice and optional command are push
  // channels for a user who is not looking at the dashboard.
  try {
    const escalate = createEscalator({ url: address, broadcast: (message) => {
      for (const tab of tabs) tab.write(`event: escalation\ndata: ${JSON.stringify(message)}\n\n`);
    } });
    const checkAttention = () => {
      try { escalate(dashboardState()); }
      catch (error) { process.stderr.write(`orch: escalation check failed: ${error.message}\n`); }
    };
    checkAttention();
    setInterval(checkAttention, escalationCheckMs());
  } catch (error) {
    process.stderr.write(`orch: cannot track escalations: ${error.message}\n`);
  }

  // Reclaim in a child so lsof and the termination grace do not block HTTP requests.
  // Do not wait for other sessions: the reclaim command checks each workspace's owners.
  let reclaimer = null;
  if (process.env.AGENT_ORCH_RECLAIM !== "off") {
    const timer = setInterval(() => {
      if (reclaimer) return;
      reclaimer = spawn(process.execPath, [CLI_PATH, "reclaim"], { stdio: ["ignore", "inherit", "inherit"] });
      reclaimer.on("error", (error) => { process.stderr.write(`orch: reclaim failed: ${error.message}\n`); });
      reclaimer.on("close", () => { reclaimer = null; });
    }, 5 * 60000);
    timer.unref();
    process.on("exit", () => { clearInterval(timer); reclaimer?.kill("SIGTERM"); });
  }

  // In the background, exit once nothing is running and no browser tab has polled for a while.
  if (args["idle-exit"]) {
    const idleMs = parseDuration(args["idle-exit"]);
    const started = Date.now();
    setInterval(() => {
      if (!tabs.size && Date.now() - (lastPage || started) > idleMs && !anyTaskRunning()) process.exit(0);
    }, 60000);
  }
  process.stdout.write(`dashboard: ${address}  (reads ${RUNS_DIR}; Ctrl-C to stop)\n`);
  if (args.open) openBrowser(keyedUrl(address));
}
