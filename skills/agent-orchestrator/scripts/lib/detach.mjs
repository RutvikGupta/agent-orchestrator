// Start a long-lived process detached, so that it outlives the command that starts it and, on macOS,
// the terminal application that command runs in. Every relay, watcher and helper that the
// orchestrator leaves running starts here (startDetached).
//
// macOS groups every process an application starts with that application, however the process
// detaches (its own session and process group), and quitting the application ends the whole group.
// A process that launchd starts on request is not in that group, and neither is anything it starts.
// So on macOS each start goes through a one-off launchd job:
//
// 1. The caller writes two files into a folder under the state root that only the user can read
//    (0700; each file 0600): the job file, a property list naming only Node, the helper
//    (scripts/detach-helper.mjs) and the spec file; and the spec, which holds the command, its
//    arguments, working directory, environment and output files. The environment holds credentials,
//    so it never goes into the job file, which launchd reads and keeps.
// 2. `launchctl bootstrap gui/<uid> <job file>` loads the job, which launchd runs at once
//    (`user/<uid>` when that fails, as when there is no gui domain in an SSH login). Its label,
//    agent-orch.<random>, is new for every start.
// 3. The helper takes the spec (deletes it), starts the process detached, and writes the process's
//    PID to the result file with a rename, so a reader never sees half of it.
// 4. The caller waits for the result (AGENT_ORCH_LAUNCHD_WAIT, default 10s), runs `launchctl bootout`
//    for the label, and deletes every file it made, whether or not the start worked.
// 5. When a step fails or no result comes in time, it starts the process directly instead, as it
//    did before. A fallback is never an error for the caller.
//
// What launchd starts gets AGENT_ORCH_OUTSIDE=1 in its environment: it, and everything it starts,
// is already outside the terminal, so a start from there goes directly. Elsewhere (Linux, and macOS
// with AGENT_ORCH_LAUNCHD=off) every start is direct. Either way the process leads its own session
// and process group, in the same folder, with the same environment and output files, so `stop`,
// `close`, `status` and the liveness checks treat it the same.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_ROOT } from "./config.mjs";

export const DETACH_HELPER = fileURLToPath(new URL("../detach-helper.mjs", import.meta.url));
// The job files' folder. Only this user may read it: the spec holds the environment.
export const JOBS_DIR = path.join(STATE_ROOT, "launchd");
const LABEL_PREFIX = "agent-orch.";
const LAUNCHCTL_MS = 10_000; // a bound on each launchctl call
// After a bootout, how long the caller still waits for the answer of a helper that took the spec.
const ANSWER_GRACE_MS = 2000;
// Job files this old belong to a caller that died while it waited; they are removed.
const STALE_MS = 5 * 60_000;
// Characters that XML 1.0, and so a property list, cannot hold.
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

// How long a start waits for the helper's answer: AGENT_ORCH_LAUNCHD_WAIT (300ms, 10s, ...), default
// 10s. A bad value falls back to the default rather than failing a start.
export function launchdWait(value = process.env.AGENT_ORCH_LAUNCHD_WAIT) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2] || "s"] : 10_000;
}

// How a start goes from a process with environment `env`: { how: "launchd" }, or { how: "direct",
// reason, outside }, where `outside` says that this process already runs outside the terminal
// application, so what it starts directly does too.
export function launchPlan(env = process.env, platform = process.platform) {
  if (platform !== "darwin") return { how: "direct", reason: "not macOS", outside: false };
  if (env.AGENT_ORCH_OUTSIDE === "1") return { how: "direct", reason: "already outside the terminal application (AGENT_ORCH_OUTSIDE=1)", outside: true };
  if (env.AGENT_ORCH_LAUNCHD === "off") return { how: "direct", reason: "AGENT_ORCH_LAUNCHD=off", outside: false };
  return { how: "launchd" };
}

// Whether agents started from this process run outside the terminal application, for `agents`:
// { outside: true | false | null, how, text }. It loads no job: launchctl only has to be on PATH.
export function outsideTerminal(env = process.env, platform = process.platform) {
  const plan = launchPlan(env, platform);
  if (plan.how === "launchd") {
    return onPath("launchctl", env.PATH)
      ? { outside: true, how: "launchd", text: "yes: each agent starts through a one-off launchd job, so quitting the terminal application does not end it" }
      : { outside: false, how: "direct", text: "no: launchctl was not found, so agents start directly and quitting the terminal application ends them" };
  }
  if (plan.outside) return { outside: true, how: "direct", text: "yes: this command already runs outside the terminal application, and so does what it starts" };
  if (platform !== "darwin") return { outside: null, how: "direct", text: `not applicable on ${platform}: agents start directly, in their own session` };
  return { outside: false, how: "direct", text: `no: ${plan.reason}, so agents start directly and quitting the terminal application ends them` };
}

// Start `command` with `args`, detached: it leads its own session and process group, runs in `cwd`
// with environment `env` (undefined values left out) and standard input from /dev/null, and appends
// its output to the files `stdout` and `stderr` (by default the same file). Returns { pid, launch }:
// its PID, null when it could not start (as a direct spawn's), and how it started, { how: "launchd",
// label } or { how: "direct", reason }.
export function startDetached({ command, args = [], cwd = process.cwd(), env = process.env, stdout, stderr = stdout }) {
  const spec = { command, args: args.map(String), cwd, stdout, stderr };
  const plan = launchPlan();
  if (plan.how === "launchd") {
    const job = throughLaunchd({ ...spec, env: { ...env, AGENT_ORCH_OUTSIDE: "1" }, umask: process.umask() });
    if (job.pid) return { pid: job.pid, launch: { how: "launchd", label: job.label } };
    return { pid: startDirect({ ...spec, env }), launch: { how: "direct", reason: job.reason } };
  }
  const own = plan.outside ? { ...env, AGENT_ORCH_OUTSIDE: "1" } : env;
  return { pid: startDirect({ ...spec, env: own }), launch: { how: "direct", reason: plan.reason } };
}

// The start every caller made before launchd: a detached spawn, with the output files opened for
// append and closed again once the child has them.
function startDirect({ command, args, cwd, env, stdout, stderr }) {
  const fds = [];
  try {
    fds.push(fs.openSync(stdout, "a"));
    if (stderr !== stdout) fds.push(fs.openSync(stderr, "a"));
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fds[0], fds.at(-1)] });
    child.on("error", () => {}); // a failed spawn has no PID, which the caller sees
    child.unref();
    return child.pid ?? null;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

// Start `spec` through a one-off launchd job. Returns { pid, label } when the helper started it, or
// { reason } for a direct start: then nothing of it runs.
function throughLaunchd(spec) {
  let dir;
  try {
    dir = jobsDir();
  } catch (error) {
    return { reason: `the job folder cannot be used: ${error.message}` };
  }
  const label = `${LABEL_PREFIX}${randomBytes(6).toString("hex")}`;
  const files = jobFiles(dir, label);
  const bad = [process.execPath, DETACH_HELPER, files.spec, files.log].find((p) => NOT_XML.test(p));
  if (bad) return { reason: `a path holds a character a property list cannot: ${JSON.stringify(bad)}` };
  const since = Date.now();
  const loaded = []; // the domains asked to load the job; each is asked to remove it again
  try {
    try {
      fs.writeFileSync(files.spec, JSON.stringify(spec), { mode: 0o600, flag: "wx" });
      fs.writeFileSync(files.job, jobFile(label, files), { mode: 0o600, flag: "wx" });
    } catch (error) {
      return { reason: `the job files could not be written: ${error.message}` };
    }
    let failure = null;
    for (const domain of [`gui/${process.getuid()}`, `user/${process.getuid()}`]) {
      const r = launchctl(["bootstrap", domain, files.job]);
      if (r.error?.code === "ENOENT") {
        failure = "launchctl was not found";
        break;
      }
      loaded.push(domain);
      failure = r.status === 0 ? null : `launchctl bootstrap ${domain} failed: ${said(r)}`;
      if (!failure) break;
    }
    const wait = launchdWait();
    if (!failure) waitForResult(files, wait);
    for (const domain of loaded.splice(0)) launchctl(["bootout", `${domain}/${label}`]);
    return { label, ...decide(files, spec, since, failure || `launchd gave no answer within ${wait} ms`) };
  } catch (error) {
    // Only an unexpected error lands here. The spec is removed below, so no helper can still take it.
    return { reason: `the launchd start failed: ${error.message}` };
  } finally {
    for (const domain of loaded) launchctl(["bootout", `${domain}/${label}`]);
    removeJob(files);
  }
}

// What a launchd start came to, once its job has been booted out: { pid } or { reason }.
//
// How the race between a caller that stopped waiting and a helper that answers late is closed:
// whoever deletes the spec file owns the start. The helper deletes it before it starts anything, and
// starts nothing when it cannot; the caller deletes it here before it falls back. A helper that took
// the spec does all its work synchronously, so the bootout's SIGTERM reaches it only after it has
// started the process and written the result: the result file read after the bootout is its answer.
// Should the bootout return before the helper has exited, the caller waits a moment more for that
// answer. Only a helper killed outright between its start and its report leaves none; launchd has
// adopted the process it started by then, so the caller looks for it by its command line before it
// falls back.
function decide(files, spec, since, failure) {
  let result = readResult(files.result);
  if (!result && !takeSpec(files.spec)) {
    result = waitForResult(files, Math.min(ANSWER_GRACE_MS, launchdWait()));
    if (!result) {
      const pid = adopted(spec, since);
      if (pid) return { pid };
      return { reason: `the launchd helper ended without an answer${helperSaid(files)}` };
    }
  }
  if (Number.isInteger(result?.pid) && result.pid > 0) return { pid: result.pid };
  if (result?.error) return { reason: `the launchd helper could not start it: ${result.error}` };
  return { reason: `${failure}${helperSaid(files)}` };
}

// Delete the spec: true when this caller now owns the start, false when the helper took it first.
function takeSpec(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

// The process that a helper killed between its start and its report had started: launchd adopted
// it (its parent is PID 1), its command line is the one asked for, and it started at `since` or
// later. Null when there is none.
function adopted(spec, since) {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const want = [spec.command, ...spec.args].join(" ").trim();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/.exec(line);
    // `ps` gives the start time to the second.
    if (m && m[2] === "1" && m[4].trim() === want && Date.parse(m[3]) >= since - 1000) return Number(m[1]);
  }
  return null;
}

// The job folder, made private to this user, with stale files of dead callers removed.
function jobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(JOBS_DIR);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error(`${JOBS_DIR} must be a folder that only this user can read (mode 0700)`);
  }
  for (const name of fs.readdirSync(JOBS_DIR)) {
    const m = /^(agent-orch\.[0-9a-f]+)\.plist$/.exec(name);
    if (!m) continue;
    try {
      if (Date.now() - fs.statSync(path.join(JOBS_DIR, name)).mtimeMs < STALE_MS) continue;
    } catch {
      continue;
    }
    for (const domain of [`gui/${process.getuid()}`, `user/${process.getuid()}`]) launchctl(["bootout", `${domain}/${m[1]}`]);
    removeJob(jobFiles(JOBS_DIR, m[1]));
  }
  return JOBS_DIR;
}

const jobFiles = (dir, label) => ({
  job: path.join(dir, `${label}.plist`),
  spec: path.join(dir, `${label}.spec.json`),
  result: path.join(dir, `${label}.result.json`),
  log: path.join(dir, `${label}.log`),
});

function removeJob(files) {
  for (const file of [...Object.values(files), `${files.result}.tmp`]) fs.rmSync(file, { force: true });
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The job: run the helper once, now, with the spec file as its only argument. It holds no
// environment. The helper's own output (only an error) goes to the job's log. The job's process
// group may be left behind, and the job runs as an app does, without the throttling launchd applies
// to a job by default, which what it starts would inherit.
function jobFile(label, files) {
  const args = [process.execPath, DETACH_HELPER, files.spec].map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>ExitTimeOut</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(files.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(files.log)}</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8", timeout: LAUNCHCTL_MS, stdio: ["ignore", "pipe", "pipe"] });
}

// What a failed launchctl call said, in one line.
function said(r) {
  if (r.error) return r.error.code === "ETIMEDOUT" ? `no answer in ${LAUNCHCTL_MS / 1000}s` : r.error.message;
  const line = `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").map((l) => l.trim()).find(Boolean);
  return (line || `exit ${r.status ?? r.signal}`).slice(0, 200);
}

// The helper's own output, which is only ever an error, as a note for a fallback's reason.
function helperSaid(files) {
  try {
    const line = fs.readFileSync(files.log, "utf8").split("\n").map((l) => l.trim()).find(Boolean);
    return line ? `; the helper said: ${line.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

function readResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));
// Wait up to `ms` for the helper's result; stop early once the helper has written an error to its
// log, which it does only when it fails. Returns the result, or null.
function waitForResult(files, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const result = readResult(files.result);
    if (result || Date.now() >= until) return result;
    try {
      if (fs.statSync(files.log).size > 0) return readResult(files.result);
    } catch {}
    Atomics.wait(pause, 0, 0, 20);
  }
}

function onPath(bin, searchPath = "") {
  return String(searchPath).split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
