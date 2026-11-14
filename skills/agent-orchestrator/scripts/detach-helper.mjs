// The helper a one-off launchd job runs (lib/detach.mjs): start the process its spec file describes,
// detached. launchd starts it outside the terminal application, so the process it starts is outside
// it too, and stays so after this helper exits and the job is removed.
//
// Usage: node detach-helper.mjs SPEC_FILE
//
// The spec (JSON) holds { command, args, cwd, env, stdout, stderr, umask }. It holds the environment
// the process needs, credentials included, so the helper deletes it as soon as it has read it. The
// helper does not start the command itself: it starts /bin/sh with CLAIM_SCRIPT, which writes its
// own PID as the job's answer (result.json, beside the spec) with an exclusive link and only then
// becomes the command (through /usr/bin/env when the environment has DYLD_* variables, which macOS
// takes from the shell). So the answer exists before any work starts, and a caller that has already
// answered for itself (it stopped waiting) makes the shell start nothing. The helper answers itself,
// the same exclusive way, only when it cannot start the shell: { error, code, start }, where `start`
// marks an error that a direct start would hit as well.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLAIM_SCRIPT, claimWords, startProblem } from "./lib/detach.mjs";

const specFile = process.argv[2] || "";
const resultFile = path.join(path.dirname(specFile), "result.json");

// Answer, whole and only if no answer exists: written to a file of its own, then linked to the
// answer's name, which fails when the caller (or anyone) answered first. Then this answer is dropped.
function answer(value) {
  const tmp = `${resultFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.linkSync(tmp, resultFile);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Take the spec: read it and delete it. Null when it is gone: the caller gave up on this job.
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
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  if (path.basename(specFile) !== "spec.json") {
    process.stderr.write("usage: detach-helper.mjs SPEC_FILE (a job's spec.json)\n");
    return 2;
  }
  let spec;
  try {
    const text = take();
    if (text === null) return 0;
    spec = JSON.parse(text);
  } catch (error) {
    answer({ error: `the spec could not be read: ${error.message}` });
    return 1;
  }
  const { command, args = [], cwd, env, stdout, stderr = stdout, umask } = spec;
  if (Number.isInteger(umask)) process.umask(umask);
  // The checks and the output files of a direct start, in the same order, so a failure is the same.
  const fds = [];
  try {
    const problem = startProblem(command, cwd, env);
    if (problem) throw problem;
    fds.push(fs.openSync(stdout, "a"));
    if (stderr !== stdout) fds.push(fs.openSync(stderr, "a"));
  } catch (error) {
    for (const fd of fds) fs.closeSync(fd);
    answer({ error: error.message, code: error.code || null, start: true });
    return 1;
  }
  try {
    // The shell loses the DYLD_* variables on macOS; these words give them back to the command.
    const words = claimWords(command, args, env);
    if (!words) {
      answer({ error: `launchd cannot pass DYLD_* variables to a program whose path holds "=": ${command}` });
      return 1;
    }
    const shell = spawn("/bin/sh", ["-c", CLAIM_SCRIPT, "detach-start", resultFile, ...words], {
      cwd, env, detached: true, stdio: ["ignore", fds[0], fds.at(-1)],
    });
    shell.on("error", () => {});
    shell.unref();
    if (!shell.pid) answer({ error: "/bin/sh did not start" });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
  return 0;
}

process.exitCode = main();
