// Start a long-lived process detached, so that it outlives the command that starts it and, on macOS,
// the terminal application that command runs in. Every relay, watcher and helper that the
// orchestrator leaves running starts here (startDetached).
//
// macOS groups every process an application starts with that application, however the process
// detaches (its own session and process group), and quitting the application ends the whole group.
// A process that launchd starts on request is not in that group, and neither is anything it starts.
// So on macOS each start goes through a one-off launchd job:
//
// 1. The caller makes a folder for the job, <label>, in a folder under the state root that only the
//    user can read (0700), and writes two files into it (each 0600): the job file, a property list
//    naming only Node, the helper (scripts/detach-helper.mjs) and the spec file; and the spec, which
//    holds the command, its arguments, working directory, environment and output files. The
//    environment holds credentials, so it never goes into the job file, which launchd reads and keeps.
// 2. `launchctl bootstrap gui/<uid> <job file>` loads the job, which launchd runs at once
//    (`user/<uid>` when that fails, as when there is no gui domain in an SSH login). Its label,
//    agent-orch.<random>, is new for every start.
// 3. The helper takes the spec (reads and deletes it) and starts /bin/sh, detached, with the spec's
//    folder, environment and output files. The shell (CLAIM_SCRIPT) writes its own PID into the
//    job's answer file, result.json, with an exclusive link, and only then becomes the command.
// 4. The caller waits for the answer (AGENT_ORCH_LAUNCHD_WAIT, default 10s, at most 30s). When none
//    comes, it writes its own, "cancelled", with an exclusive create, and starts the process directly. Then it
//    removes the job's folder, runs `launchctl bootout` for the label, and checks that the job is
//    gone; a job still loaded leaves a record of its label only, which sweepJobs retries.
//
// One rule decides every race between the caller and a helper or shell that runs late: exactly one
// of them creates the answer file, and no work starts before it exists. The shell runs the command
// only when its link created the answer, so its PID is the command's. The caller starts directly only
// when its own create did. The folder goes by a rename, so a helper or shell that runs after that
// finds neither its spec nor a place to answer, and starts nothing. Nothing is ever taken from `ps`.
// A caller that finds the folder gone cannot know what the job did, so it fails and starts nothing;
// the sweep keeps a folder while the caller that made it, or the process it answered with, still runs.
//
// A start error that a direct start would hit as well (a working directory or program that does not
// exist, an output file that cannot be opened) is thrown, the same on either path, and is never
// retried directly. Any other failure of the launchd path falls back to a direct start, as it was
// before; such a fallback is never an error for the caller.
//
// What launchd starts gets AGENT_ORCH_OUTSIDE=1 in its environment: it, and everything it starts,
// is already outside the terminal, so a start from there goes directly. Elsewhere (Linux, and macOS
// with AGENT_ORCH_LAUNCHD=off) every start is direct. Either way the process leads its own session
// and process group, in the same folder, with the same environment and output files, so `stop`,
// `close`, `status` and the liveness checks treat it the same.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_ROOT } from "./config.mjs";

export const DETACH_HELPER = fileURLToPath(new URL("../detach-helper.mjs", import.meta.url));
// The jobs' folder. Only this user may read it: a spec holds an environment.
export const JOBS_DIR = path.join(STATE_ROOT, "launchd");
const LABEL = /^agent-orch\.[0-9a-f]+$/;
const LAUNCHCTL_MS = 10_000; // a bound on each launchctl call of a start
// The sweep's bounds: all of it, and each launchctl call in it.
const SWEEP_MS = 5000;
const SWEEP_CALL_MS = 3000;
// A spec this old belongs to a caller that died: no live start keeps one this long.
const SPEC_MS = 60_000;
// A job's folder this old, or anything else of ours, belongs to a caller that died.
const STALE_MS = 5 * 60_000;
// How often the sweep tries again to remove a job that is still loaded.
const RETRY_MS = 60_000;
// The longest a start waits for its answer. With the two bootstraps before it (LAUNCHCTL_MS each), a
// live start needs its spec for under SPEC_MS, so a spec older than that is always abandoned.
const MAX_WAIT_MS = 30_000;
// A folder kept for a caller that still runs is removed after this long whatever the PID says.
const KEEP_MS = 24 * 60 * 60_000;
// Characters that XML 1.0, and so a property list, cannot hold.
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

// The shell the helper starts. $1 is the answer file, the command and its arguments follow, as
// positional parameters, never in this text. It writes its PID to a file of its own, links that file
// to the answer (the link fails when an answer exists, or when the job's folder is gone), and only
// then replaces itself with the command, which keeps its PID. Without the link it runs nothing. `--`
// ends exec's own options, so a command whose name starts with a dash is still a command.
export const CLAIM_SCRIPT = 'r=$1; shift; t="$r.$$.tmp"; { printf \'{"pid":%s}\\n\' "$$" > "$t"; } 2>/dev/null || exit 70; if /bin/ln "$t" "$r" 2>/dev/null; then /bin/rm -f "$t"; exec -- "$@"; fi; /bin/rm -f "$t"; exit 75';

// The words the claiming shell runs for `command` and `args` with environment `env`. macOS removes
// every DYLD_* variable from the environment of a system program such as /bin/sh, so the command
// would lose them: then /usr/bin/env sets them again, from its own arguments, and becomes the
// command, with the same PID. Null when that cannot be done: env reads a word with "=" as a variable.
export function claimWords(command, args, env = {}) {
  const lost = Object.entries(env || {}).filter(([name, value]) => name.startsWith("DYLD_") && value !== undefined);
  if (!lost.length) return [command, ...args];
  if (String(command).includes("=")) return null;
  return ["/usr/bin/env", ...lost.map(([name, value]) => `${name}=${value}`), command, ...args];
}

// How long a start waits for the helper's answer: AGENT_ORCH_LAUNCHD_WAIT (300ms, 10s, ...), default
// 10s, at most 30s: a longer wait would need a spec for longer than the sweep lets one live. A bad
// value falls back to the default rather than failing a start.
export function launchdWait(value = process.env.AGENT_ORCH_LAUNCHD_WAIT) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value ?? "").trim());
  return Math.min(MAX_WAIT_MS, m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2] || "s"] : 10_000);
}

// The folder macOS guards that `file` is in, as the user knows it ("~/Documents"), or null. macOS
// asks once for each application before a process reads Desktop, Documents, Downloads, iCloud Drive,
// other cloud storage or another volume (Privacy & Security, Files and Folders). A process started
// under the terminal application uses the terminal's answer. One that launchd starts has none: its
// first read there waits until the user answers a prompt that names the program launchd ran, node.
export function guardedFolder(file, home = os.homedir()) {
  // The real path of the longest part that exists, then the rest: a folder that is not there yet,
  // or no longer, is still judged by the links above it.
  const real = (p) => {
    const rest = [];
    for (let at = path.resolve(String(p)); ; ) {
      try {
        return path.join(fs.realpathSync(at), ...rest);
      } catch {
        const up = path.dirname(at);
        if (up === at) return path.resolve(String(p));
        rest.unshift(path.basename(at));
        at = up;
      }
    }
  };
  const at = real(file);
  const base = real(home);
  for (const name of ["Desktop", "Documents", "Downloads", "Library/Mobile Documents", "Library/CloudStorage"]) {
    const dir = path.join(base, name);
    if (at === dir || at.startsWith(dir + path.sep)) return `~/${name}`;
  }
  // The start-up volume's own name under /Volumes is a link to "/", which the real path follows.
  return /^\/Volumes\/[^/]+/.exec(at)?.[0] || null;
}

// How a start goes from a process with environment `env`: { how: "launchd" }, or { how: "direct",
// reason, outside }, where `outside` says that this process already runs outside the terminal
// application, so what it starts directly does too. `near` lists the folders the process works in
// (its own, its repository): when macOS guards one of them, the start is direct, so that the process
// keeps the terminal's access instead of waiting for a privacy prompt nobody may see.
// AGENT_ORCH_LAUNCHD=on starts through launchd there too, for a user who has allowed node.
export function launchPlan(env = process.env, platform = process.platform, near = []) {
  if (platform !== "darwin") return { how: "direct", reason: "not macOS", outside: false };
  if (env.AGENT_ORCH_OUTSIDE === "1") return { how: "direct", reason: "already outside the terminal application (AGENT_ORCH_OUTSIDE=1)", outside: true };
  if (env.AGENT_ORCH_LAUNCHD === "off") return { how: "direct", reason: "AGENT_ORCH_LAUNCHD=off", outside: false };
  if (env.AGENT_ORCH_LAUNCHD !== "on") {
    const folder = near.filter(Boolean).map((file) => guardedFolder(file, env.HOME || os.homedir())).find(Boolean);
    if (folder) return { how: "direct", reason: `${folder} is a folder macOS guards, where a process started through launchd waits for a privacy prompt; AGENT_ORCH_LAUNCHD=on starts through launchd anyway`, outside: false };
  }
  return { how: "launchd" };
}

// Whether agents started from this process run outside the terminal application, for `agents`:
// { outside: true | false | null, how, text }. It loads no job: launchctl only has to be on PATH.
// `near` is as for launchPlan: the answer is for agents that work in those folders.
export function outsideTerminal(env = process.env, platform = process.platform, near = []) {
  const plan = launchPlan(env, platform, near);
  if (plan.how === "launchd") {
    return onPath("launchctl", env.PATH)
      ? { outside: true, how: "launchd", text: "yes: each agent starts through a one-off launchd job, so quitting the terminal application does not end it (a task that works in a folder macOS guards, such as Documents, starts directly)" }
      : { outside: false, how: "direct", text: "no: launchctl was not found, so agents start directly and quitting the terminal application ends them" };
  }
  if (plan.outside) return { outside: true, how: "direct", text: "yes: this command already runs outside the terminal application, and so does what it starts" };
  if (platform !== "darwin") return { outside: null, how: "direct", text: `not applicable on ${platform}: agents start directly, in their own session` };
  return { outside: false, how: "direct", text: `no: ${plan.reason}, so agents start directly and quitting the terminal application ends them` };
}

const startError = (command, why, code) => Object.assign(new Error(`cannot start ${command}: ${why}`), { code });

// Why `command` cannot start in `cwd`, as an Error with a code, or null: what a spawn would fail on,
// checked first so that the failure is an error at once, worded the same for a direct start and for
// the helper.
export function startProblem(command, cwd, env = process.env) {
  try {
    if (!fs.statSync(cwd).isDirectory()) return startError(command, `its working directory is not a folder: ${cwd}`, "ENOTDIR");
  } catch {
    return startError(command, `its working directory does not exist: ${cwd}`, "ENOENT");
  }
  // A name without a slash is looked up on PATH, as a spawn does; a folder is no program.
  const file = String(command).includes("/") ? path.resolve(cwd, command) : findOnPath(command, env?.PATH ?? process.env.PATH);
  if (!file) return startError(command, "no such program on PATH", "ENOENT");
  try {
    if (!fs.statSync(file).isFile()) return startError(command, "it is not a program file", "EACCES");
    fs.accessSync(file, fs.constants.X_OK);
    return null;
  } catch (error) {
    return error.code === "ENOENT" ? startError(command, "no such program", "ENOENT") : startError(command, "it is not executable", "EACCES");
  }
}

// Start `command` with `args`, detached: it leads its own session and process group, runs in `cwd`
// with environment `env` (undefined values left out) and standard input from /dev/null, and appends
// its output to the files `stdout` and `stderr` (by default the same file). Returns { pid, launch }:
// its PID, and how it started, { how: "launchd", label } or { how: "direct", reason }. Throws when it
// cannot start, the same error whichever way it went: it never returns without a PID.
export function startDetached({ command, args = [], cwd = process.cwd(), env = process.env, stdout, stderr = stdout, near = [] }) {
  const spec = { command, args: args.map(String), cwd, stdout, stderr };
  const plan = launchPlan(process.env, process.platform, [cwd, ...near]);
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
  const problem = startProblem(command, cwd, env);
  if (problem) throw problem;
  const fds = [];
  try {
    fds.push(fs.openSync(stdout, "a"));
    if (stderr !== stdout) fds.push(fs.openSync(stderr, "a"));
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fds[0], fds.at(-1)] });
    child.on("error", () => {}); // the missing PID below reports it
    child.unref();
    if (!child.pid) throw startError(command, "the process did not start", "ESPAWN");
    return child.pid;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

// A job's folder and its files.
const jobOf = (label) => {
  const dir = path.join(JOBS_DIR, label);
  return { label, dir, plist: path.join(dir, "job.plist"), spec: path.join(dir, "spec.json"), result: path.join(dir, "result.json"), log: path.join(dir, "helper.log"), caller: path.join(dir, "caller") };
};
const domains = () => [`gui/${process.getuid()}`, `user/${process.getuid()}`];

// Start `spec` through a one-off launchd job. Returns { pid, label } when the job started it, or
// { reason } for a direct start, and then nothing of the job runs or will run. Throws a start error.
function throughLaunchd(spec) {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(JOBS_DIR);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error(`${JOBS_DIR} must be a folder that only this user can read (mode 0700)`);
  } catch (error) {
    return { reason: `the job folder cannot be used: ${error.message}` };
  }
  const job = jobOf(`agent-orch.${randomBytes(6).toString("hex")}`);
  const bad = [process.execPath, DETACH_HELPER, job.spec, job.log].find((p) => NOT_XML.test(p));
  if (bad) return { reason: `a path holds a character a property list cannot: ${JSON.stringify(bad)}` };
  const loaded = []; // the domains asked to load the job
  try {
    try {
      fs.mkdirSync(job.dir, { mode: 0o700 });
      // Who waits for this job's answer: the sweep keeps the folder while this process runs.
      fs.writeFileSync(job.caller, String(process.pid), { mode: 0o600, flag: "wx" });
      fs.writeFileSync(job.spec, JSON.stringify(spec), { mode: 0o600, flag: "wx" });
      fs.writeFileSync(job.plist, jobFile(job), { mode: 0o600, flag: "wx" });
    } catch (error) {
      return { reason: `the job files could not be written: ${error.message}` };
    }
    let failure = null;
    for (const domain of domains()) {
      const r = launchctl(["bootstrap", domain, job.plist], LAUNCHCTL_MS);
      if (r.error?.code === "ENOENT") {
        failure = "launchctl was not found";
        break;
      }
      loaded.push(domain);
      failure = r.status === 0 ? null : `launchctl bootstrap ${domain} failed: ${said(r)}`;
      if (!failure) break;
    }
    const wait = launchdWait();
    if (!failure) waitForResult(job, wait);
    return { label: job.label, ...decide(job, spec, failure || `launchd gave no answer within ${wait} ms`) };
  } finally {
    finishJob(job, loaded);
  }
}

// What a launchd start came to: { pid } or { reason } for a direct start; throws a start error. When
// no answer has come, the caller answers itself, exclusively: if it can, no shell of this job can
// link its own any more, so nothing of the job runs; if an answer came first, that one decides. When
// it can do neither, because the job's folder is gone (this caller was held up for long, and the
// folder was removed meanwhile), the job may have answered and run the command already: what
// happened is not known, so the caller starts nothing and says so.
function decide(job, spec, failure) {
  let result = readResult(job.result);
  if (!result) {
    if (cancel(job.result, spec.command)) return { reason: `${failure}${helperSaid(job)}` };
    result = readResult(job.result);
  }
  if (Number.isInteger(result?.pid) && result.pid > 0) return { pid: result.pid };
  // What a direct start would hit too: fail, as it would.
  if (result?.start) throw Object.assign(new Error(result.error), { code: result.code || "ESPAWN" });
  // The helper answered that it started nothing: a direct start goes instead.
  if (result?.error) return { reason: `the launchd helper could not start it: ${result.error}` };
  throw startError(spec.command, "the launchd job answered without a PID", "ESPAWN");
}

// The caller's own answer: true when it created it, so that nothing of the job can start; false when
// an answer exists. Anything else, a folder that is gone above all, leaves the outcome unknown: it
// throws, marked `unknown`, and never lets a direct start go.
function cancel(file, command) {
  try {
    fs.writeFileSync(file, `${JSON.stringify({ cancelled: true, by: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    const why = error.code === "ENOENT" ? "its launchd job's folder is gone, and its answer with it" : `its launchd job's answer cannot be read or written (${error.code || error.message})`;
    throw Object.assign(new Error(`it is not known whether ${command} started: ${why}. It may be running: check \`status\` before you start it again`), { code: "EUNKNOWN", unknown: true });
  }
}

// Remove a job once its start is decided. The folder goes first, by a rename, so a helper or shell
// of the job that still runs can neither take the spec nor answer. Then each domain asked to load the
// job is asked to remove it, and checked: a job still loaded, or whose state is not known, keeps a
// record of its label alone, which sweepJobs tries again.
function finishJob(job, loaded) {
  retire(job.dir);
  for (const domain of loaded) launchctl(["bootout", `${domain}/${job.label}`], LAUNCHCTL_MS);
  const left = loaded.filter((domain) => stillLoaded(domain, job.label, LAUNCHCTL_MS));
  if (left.length) keepRecord(job.label, left);
}

// Move a folder out of the way at once, then delete it. A folder that cannot be moved is deleted
// where it is; whatever is left, the sweep removes later. It never throws.
function retire(dir) {
  const gone = `${dir}.${process.pid}.gone`;
  try {
    fs.renameSync(dir, gone);
  } catch (error) {
    if (error.code !== "ENOENT") quietRm(dir);
    return;
  }
  quietRm(gone);
}

function quietRm(file) {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {}
}

const recordFile = (label) => path.join(JOBS_DIR, `${label}.loaded`);
// The record of a job that may still be loaded: its label and domains, nothing else.
function keepRecord(label, left) {
  try {
    fs.writeFileSync(recordFile(label), `${JSON.stringify({ label, domains: left })}\n`, { mode: 0o600 });
  } catch {}
}

// Whether a job is still loaded in `domain`: true also when launchctl cannot tell in time.
function stillLoaded(domain, label, ms) {
  const r = launchctl(["print", `${domain}/${label}`], ms);
  if (r.error) return r.error.code !== "ENOENT"; // without launchctl nothing is loaded
  return r.status === 0;
}

// Clean the jobs' folder for callers that died: delete every spec older than a minute (it holds an
// environment), remove the folders of jobs older than five minutes, and try again to remove from
// launchd the jobs that were still loaded. A folder stays while the caller that made it still runs
// (it may only be held up, and will read the answer), or while the process its answer names does,
// checked by its start time, and never for more than a day.
// orch.mjs runs this before every command, so the dashboard's chores run it too. It returns at once
// when the folder is missing or empty, never throws, and spends at most five seconds, file work
// included, each launchctl call at most three: what it did not reach waits for the next.
export function sweepJobs({ budgetMs = SWEEP_MS, callMs = SWEEP_CALL_MS } = {}) {
  try {
    let names;
    try {
      names = fs.readdirSync(JOBS_DIR);
    } catch {
      return;
    }
    if (!names.length) return;
    const now = Date.now();
    const deadline = now + budgetMs;
    const age = (file) => {
      try {
        return now - fs.statSync(file).mtimeMs;
      } catch {
        return -1;
      }
    };
    const retries = [];
    for (const name of names) {
      if (Date.now() >= deadline) return;
      const file = path.join(JOBS_DIR, name);
      if (LABEL.test(name)) {
        if (age(path.join(file, "spec.json")) > SPEC_MS) quietRm(path.join(file, "spec.json"));
        // Its caller is gone or held up, perhaps with the job loaded: record the job for a check,
        // once, and remove the folder unless someone still needs its answer.
        const old = age(file);
        if (old > STALE_MS) {
          const noted = path.join(file, "recorded");
          if (!fs.existsSync(noted)) {
            keepRecord(name, domains());
            try {
              fs.writeFileSync(noted, "", { mode: 0o600 });
            } catch {}
          }
          if (!needed(file)) retire(file);
        }
      } else if (/\.gone$/.test(name)) {
        quietRm(file);
      } else if (name.endsWith(".loaded") && LABEL.test(name.slice(0, -".loaded".length))) {
        if (age(file) > RETRY_MS) retries.push({ label: name.slice(0, -".loaded".length), file });
      } else if (name.startsWith("agent-orch.") && age(file) > STALE_MS) {
        quietRm(file);
      }
    }
    // Only where starts go through launchd: with AGENT_ORCH_LAUNCHD=off, nothing calls launchctl.
    if (launchPlan().how !== "launchd") return;
    for (const { label, file } of retries) {
      if (Date.now() >= deadline) break;
      let listed;
      try {
        listed = JSON.parse(fs.readFileSync(file, "utf8")).domains;
      } catch {}
      const left = [];
      for (const domain of Array.isArray(listed) && listed.length ? listed : domains()) {
        const bound = () => Math.min(callMs, deadline - Date.now());
        if (bound() <= 0) {
          left.push(domain);
          continue;
        }
        launchctl(["bootout", `${domain}/${label}`], bound());
        if (bound() <= 0 || stillLoaded(domain, label, bound())) left.push(domain);
      }
      if (left.length) keepRecord(label, left); // written again: its next try waits a minute
      else quietRm(file);
    }
  } catch {}
}

const runs = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Whether a stale job's folder must stay: the process its answer names still runs, or the caller
// that made it does. Either way for a day at most, since a PID may pass to another process.
function needed(dir) {
  try {
    if (answeredRuns(dir)) return true;
  } catch {}
  try {
    const caller = path.join(dir, "caller");
    return Date.now() - fs.statSync(caller).mtimeMs < KEEP_MS && runs(Number(fs.readFileSync(caller, "utf8")));
  } catch {
    return false;
  }
}

// Whether the process that a job's answer names still runs: one with that PID and that process's
// start time, and an answer less than a day old. The process wrote the answer itself, so on the
// first look a process that started after the answer was written is another one, which got the PID
// later. That look stores the start time in the folder (`process`), and every later look asks for
// the same one. When `ps` cannot give a start time, the PID alone counts, within the day.
function answeredRuns(dir) {
  const file = path.join(dir, "result.json");
  const pid = readResult(file)?.pid;
  if (!runs(pid)) return false;
  const written = fs.statSync(file).mtimeMs;
  if (Date.now() - written >= KEEP_MS) return false;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: SWEEP_CALL_MS });
  const started = r.error ? "" : String(r.stdout || "").replace(/\s+/g, " ").trim();
  if (!started) return runs(pid);
  const noted = path.join(dir, "process");
  const known = readResult(noted);
  if (known?.pid === pid && known.started) return known.started === started;
  // `ps` gives the start time to the second.
  const at = Date.parse(started);
  if (!Number.isNaN(at) && at > written + 1000) return false;
  try {
    fs.writeFileSync(noted, `${JSON.stringify({ pid, started })}\n`, { mode: 0o600 });
  } catch {}
  return true;
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The job: run the helper once, now, with the spec file as its only argument. It holds no
// environment. The helper's own output (only an error) goes to the job's log. The job's process
// group may be left behind, and the job runs as an app does, without the throttling launchd applies
// to a job by default, which what it starts would inherit.
function jobFile(job) {
  const args = [process.execPath, DETACH_HELPER, job.spec].map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(job.label)}</string>
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
\t<string>${xml(job.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(job.log)}</string>
</dict>
</plist>
`;
}

function launchctl(args, ms) {
  return spawnSync("launchctl", args, { encoding: "utf8", timeout: Math.max(1, Math.round(ms)), stdio: ["ignore", "pipe", "pipe"] });
}

// What a failed launchctl call said, in one line.
function said(r) {
  if (r.error) return r.error.code === "ETIMEDOUT" ? "no answer in time" : r.error.message;
  const line = `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").map((l) => l.trim()).find(Boolean);
  return (line || `exit ${r.status ?? r.signal}`).slice(0, 200);
}

// The helper's own output, which is only ever an error, as a note for a fallback's reason.
function helperSaid(job) {
  try {
    const line = fs.readFileSync(job.log, "utf8").split("\n").map((l) => l.trim()).find(Boolean);
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
// Wait up to `ms` for the job's answer; stop early once the helper has written to its log, which it
// does only when it fails. Returns the answer, or null.
function waitForResult(job, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const result = readResult(job.result);
    if (result || Date.now() >= until) return result;
    try {
      if (fs.statSync(job.log).size > 0) return readResult(job.result);
    } catch {}
    Atomics.wait(pause, 0, 0, 20);
  }
}

function findOnPath(bin, searchPath = "") {
  for (const dir of String(searchPath || "").split(path.delimiter).filter(Boolean)) {
    try {
      if (!fs.statSync(path.join(dir, bin)).isFile()) continue;
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return path.join(dir, bin);
    } catch {}
  }
  return null;
}
const onPath = (bin, searchPath) => Boolean(findOnPath(bin, searchPath));
