// Small helpers: errors, JSON files, commands on PATH, git, relays, arguments, output, and file tails.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, SKILL_ROOTS, relayFolder } from "./config.mjs";

export function die(message, code = 1) {
  process.stderr.write(`orch: ${message}\n`);
  process.exit(code);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function which(bin) {
  const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    if (allowFail) return null;
    die(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || "").trim()}`);
  }
  return r.stdout.trim();
}

export function findRelay(key) {
  for (const root of SKILL_ROOTS) {
    const relay = path.join(root, relayFolder(key), "scripts", "relay.mjs");
    if (fs.existsSync(relay)) return fs.realpathSync(relay);
  }
  return null;
}

// Whether an agent's CLI (at `binPath`) is logged in: "ok", "logged-out", or "unknown" for an agent
// with no login check. A CLI whose check gives JSON (authJson: Cursor's) is logged in only when it
// says isAuthenticated; output that is not that JSON, as from a CLI too old for the option, counts as
// logged out. `agents`, and the usage-limit hand-over of `result` and `wait`, all ask this.
export function agentLogin(key, binPath) {
  const meta = AGENTS[key];
  if (!meta?.authCmd) return "unknown";
  const r = spawnSync(binPath, meta.authCmd, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  if (meta.authJson) {
    try { return JSON.parse(r.stdout).isAuthenticated === true ? "ok" : "logged-out"; } catch { return "logged-out"; }
  }
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  return r.status === 0 && !/"loggedIn"\s*:\s*false|not logged in/i.test(text) ? "ok" : "logged-out";
}

// Where a task stopped by a usage limit of `limited` (one agent key or several) can go on: "resume it
// on another agent that is ready: codex or gemini". An agent is ready when its CLI and its relay are
// installed and its CLI is logged in, as `agents` reports.
export function handOverText(limited) {
  const skip = new Set([limited].flat());
  const others = Object.keys(AGENTS).filter((key) => !skip.has(key));
  const ready = others.filter((key) => {
    const bin = which(AGENTS[key].bin);
    return bin && findRelay(key) && agentLogin(key, bin) !== "logged-out";
  });
  if (ready.length) return `resume it on another agent that is ready: ${ready.join(" or ")}`;
  return others.length ? `resume it on another agent once one is ready (${others.join(", ")}: none is installed and logged in)` : "resume it once its usage window resets";
}

export function parseDuration(text) {
  if (text === undefined) return null;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) die(`bad duration "${text}" (use e.g. 90s, 10m, 2h)`, 2);
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"];
  return Number(m[1]) * unit;
}

export function parseArgs(argv, spec) {
  const out = { _: [], passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.passthrough = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "json" || (spec.bool || []).includes(name)) {
      out[name] = true;
    } else if ((spec.value || []).includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) die(`--${name} needs a value`, 2);
      out[name] = value;
    } else if ((spec.multi || []).includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) die(`--${name} needs a value`, 2);
      (out[name] ??= []).push(value);
    } else {
      die(`unknown option --${name}`, 2);
    }
  }
  return out;
}

export function emit(args, value, text) {
  process.stdout.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

export function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").slice(-lines - 1).join("\n").trimEnd();
  } catch {
    return "";
  }
}

export function tailBytes(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// The last `bytes` of a JSONL file, starting at a line boundary; 2 MB is enough for a live log.
export function tailText(file, bytes = 2_000_000) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  }
}
