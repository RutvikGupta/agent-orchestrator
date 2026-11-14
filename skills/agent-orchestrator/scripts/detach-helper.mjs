// The helper a one-off launchd job runs (lib/detach.mjs): start the process its spec file describes,
// detached, and report the process's PID. launchd starts it outside the terminal application, so the
// process it starts is outside it too, and stays so after this helper exits and the job is removed.
//
// Usage: node detach-helper.mjs SPEC_FILE
//
// The spec (JSON) holds { command, args, cwd, env, stdout, stderr, umask }. It holds the environment
// the process needs, credentials included, so the helper deletes it as soon as it has read it. The
// answer goes to the result file beside it (<label>.result.json): { pid } or { error }.

import { spawn } from "node:child_process";
import fs from "node:fs";

// `launchctl bootout` stops the job with SIGTERM. With a listener, Node acts on the signal only
// between turns of its event loop, and everything below runs in one synchronous turn: a helper that
// has taken the spec always starts the process and writes its answer before it exits. One that is
// still loading dies at once, having taken nothing.
process.on("SIGTERM", () => process.exit(0));

const specFile = process.argv[2] || "";
const resultFile = specFile.replace(/\.spec\.json$/, ".result.json");

// Write the answer whole: to a temporary file, then renamed into place.
function answer(value) {
  const tmp = `${resultFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, resultFile);
}

// Take the spec: read it and delete it. Whoever deletes it owns the start, so null, when the caller
// deleted it first (it stopped waiting and starts the process itself), means start nothing.
function take() {
  let fd;
  try {
    fd = fs.openSync(specFile, "r");
  } catch {
    return null;
  }
  try {
    try {
      fs.unlinkSync(specFile);
    } catch {
      return null;
    }
    return { spec: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

// Start the process as a direct start does: its own session and process group, standard input from
// /dev/null, its output appended to the given files, the caller's umask.
function start({ command, args = [], cwd, env, stdout, stderr = stdout, umask }) {
  if (Number.isInteger(umask)) process.umask(umask);
  const fds = [fs.openSync(stdout, "a")];
  try {
    if (stderr !== stdout) fds.push(fs.openSync(stderr, "a"));
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fds[0], fds.at(-1)] });
    child.on("error", () => {});
    child.unref();
    if (!child.pid) throw new Error(cwd && !fs.existsSync(cwd) ? `its folder does not exist: ${cwd}` : `${command} did not start`);
    return child.pid;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

function main() {
  if (!specFile.endsWith(".spec.json")) {
    process.stderr.write("usage: detach-helper.mjs SPEC_FILE (a .spec.json file)\n");
    return 2;
  }
  let pid;
  try {
    const taken = take();
    if (!taken) return 0;
    pid = start(JSON.parse(taken.spec));
  } catch (error) {
    answer({ error: error.message });
    return 1;
  }
  try {
    answer({ pid });
  } catch (error) {
    // The caller cannot learn of a process this helper did not report, and starts its own: end this
    // one, so that one runs.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    process.stderr.write(`detach helper: could not report pid ${pid}, so it was stopped: ${error.message}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
