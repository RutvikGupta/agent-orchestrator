#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readOnlyVerdict, snapshotReadOnly } from "./tripwire.mjs";
import { createUsageEstimator } from "./usage-estimate.mjs";

const HELP = `Usage: node relay.mjs [options]

  --brief FILE                   Read the brief from FILE (default: stdin).
  --cd DIR                       Set the workspace (default: current directory).
  --out-dir DIR                  Write artifacts here (default: fresh temp directory).
  --model ID                     Select a Cursor model.
  --effort LEVEL                 Append -LEVEL to the model ID when both are supplied.
  --session ID                   Resume a Cursor session with the new brief.
  --read-only                    Use plan mode, deny file writes and check git status.
  --sandbox enabled|disabled     Set Cursor's shell sandbox mode.
  --allow RULE                   Add a Cursor permission allow rule (repeatable).
  --deny RULE                    Add a Cursor permission deny rule (repeatable).
  --timeout DUR                  Stop the run after a duration such as 1h30m or 45s.
  -h, --help                     Show this help.
`;

function parseArgs(argv) {
  const opts = { cd: process.cwd(), allow: [], deny: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "-h":
      case "--help": opts.help = true; break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = path.resolve(next()); break;
      case "--out-dir": opts.outDir = path.resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--session": opts.session = next(); break;
      case "--read-only": opts.readOnly = true; break;
      case "--sandbox": opts.sandbox = next(); break;
      case "--allow": opts.allow.push(next()); break;
      case "--deny": opts.deny.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (opts.sandbox && !["enabled", "disabled"].includes(opts.sandbox)) {
    throw new Error("--sandbox must be enabled or disabled");
  }
  if (opts.model && !/^[\w][\w.:/@,=\[\]-]*$/.test(opts.model)) throw new Error("invalid --model");
  if (opts.effort && !/^[\w][\w-]*$/.test(opts.effort)) throw new Error("invalid --effort");
  if (opts.session && !/^[\w][\w.:-]*$/.test(opts.session)) throw new Error("invalid --session");
  for (const [flag, rules] of [["--allow", opts.allow], ["--deny", opts.deny]]) {
    for (const rule of rules) {
      const match = /^(?:Shell|Read|Write|WebFetch|Mcp)\(([^\r\n\0]*)\)$/.exec(rule);
      if (match?.[0] !== rule || !match[1].trim()) {
        throw new Error(`${flag} requires a Cursor rule: Shell(...), Read(...), Write(...), WebFetch(...) or Mcp(...)`);
      }
    }
  }
  if (opts.timeout) {
    const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(opts.timeout);
    const [, hours, minutes, seconds, millis] = match || [];
    opts.timeoutMs = Number(hours || 0) * 3600000 + Number(minutes || 0) * 60000
      + Number(seconds || 0) * 1000 + Number(millis || 0);
    if (opts.timeoutMs < 1 || opts.timeoutMs > 2147483647) {
      throw new Error("invalid --timeout (use a positive h/m/s duration up to about 24 days)");
    }
  }
  return opts;
}

function readConfig(file, label) {
  try {
    if (!fs.statSync(file).isFile()) throw new Error("expected a regular file");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("expected an object");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") {
      // Treat a dangling config symlink as an unreadable file, not a missing config.
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
    }
    // A JSON syntax error can include private config values.
    throw new Error(`could not read or parse ${label} Cursor config at ${file}`);
  }
}

function permissionRules(config, file, requireBoth) {
  if (!config || !Object.hasOwn(config, "permissions")) return { allow: [], deny: [] };
  const { permissions } = config;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error(`invalid Cursor permissions in ${file} (expected allow and deny arrays)`);
  }
  if (requireBoth && Object.keys(permissions).some((key) => key !== "allow" && key !== "deny")) {
    throw new Error(`invalid Cursor permissions in ${file} (expected only allow and deny arrays)`);
  }
  const rules = (key) => {
    const list = !requireBoth && !Object.hasOwn(permissions, key) ? [] : permissions[key];
    if (!Array.isArray(list) || !list.every((rule) => typeof rule === "string")) {
      throw new Error(`invalid Cursor permissions.${key} in ${file} (expected an array of strings)`);
    }
    return list;
  };
  return { allow: rules("allow"), deny: rules("deny") };
}

function gitRoot(cwd) {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], gitOptions(cwd));
  return root.status === 0 ? root.stdout.trimEnd() : null;
}

function projectConfigs(cwd, root) {
  const workdir = fs.realpathSync(cwd);
  const boundary = root ? fs.realpathSync(root) : workdir;
  const relative = path.relative(boundary, workdir);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    return [path.join(workdir, ".cursor", "cli.json")];
  }
  const configs = [];
  for (let dir = workdir; ; dir = path.dirname(dir)) {
    configs.unshift(path.join(dir, ".cursor", "cli.json"));
    if (dir === boundary || dir === path.dirname(dir)) return configs;
  }
}

function prepareConfig(dir, opts, root, mergedFiles) {
  const userDir = path.resolve(process.env.CURSOR_CONFIG_DIR || path.join(homedir(), ".cursor"));
  const userFile = path.join(userDir, "cli-config.json");
  const merged = permissionRules(readConfig(userFile, "user"), userFile, false);
  for (const file of projectConfigs(opts.cd, root)) {
    const config = readConfig(file, "project");
    if (!config) continue;
    const rules = permissionRules(config, file, true);
    merged.allow.push(...rules.allow);
    merged.deny.push(...rules.deny);
    mergedFiles.push(file);
  }
  const allow = [...new Set([...merged.allow, ...opts.allow])];
  // Cursor uses Write for both Write and StrReplace. Its glob matcher needs **/* for absolute paths.
  const deny = [...new Set([...merged.deny, ...opts.deny, ...(opts.readOnly ? ["Write(**)", "Write(**/*)"] : [])])];
  fs.writeFileSync(path.join(dir, "cli-config.json"), JSON.stringify({ version: 1, permissions: { allow, deny } }) + "\n", { mode: 0o600 });
  const chats = path.join(userDir, "chats");
  fs.mkdirSync(chats, { recursive: true, mode: 0o700 });
  fs.symlinkSync(chats, path.join(dir, "chats"), "junction");
  return { ...process.env, CURSOR_CONFIG_DIR: dir };
}

function gitOptions(cwd) {
  return { cwd, encoding: "utf8", timeout: 5000, windowsHide: true };
}

function gitExcludes(root, artifacts) {
  if (!root) return [];
  // Git may canonicalize the checkout (for example, /var to /private/var on macOS).
  const realDir = fs.realpathSync(path.dirname(artifacts[0]));
  return artifacts
    .map((file) => path.relative(root, path.join(realDir, path.basename(file))))
    .filter((file) => file && file !== ".." && !file.startsWith(".." + path.sep) && !path.isAbsolute(file))
    .map((file) => `:(top,exclude,literal)${file}`);
}

function gitStatus(cwd, root, excludes) {
  if (!root) return null;
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...excludes], gitOptions(cwd));
  return status.status === 0 ? status.stdout.split("\n").filter(Boolean) : null;
}

const TOOL_NAMES = {
  shellToolCall: "Bash", readToolCall: "Read", editToolCall: "Edit", writeToolCall: "Write",
  grepToolCall: "Grep", globToolCall: "Glob", lsToolCall: "LS",
  listDirToolCall: "LS", listDirectoryToolCall: "LS",
};

function toolEvent(event) {
  const tools = Object.entries(event.tool_call || {});
  const [key, tool] = tools.find(([key]) => key.endsWith("ToolCall")) || tools[0] || [];
  if (!tool || !event.call_id) return null;
  const name = Object.hasOwn(TOOL_NAMES, key) ? TOOL_NAMES[key] : key === "function" ? tool.name || key : key;
  const timestamp = new Date(event.timestamp_ms);
  const metadata = { session_id: event.session_id, timestamp: Number.isFinite(+timestamp) ? timestamp.toISOString() : undefined };
  if (event.subtype === "started") {
    let args = tool.args ?? tool.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = { arguments: args }; }
    }
    const input = { ...args };
    if (["Read", "Edit", "Write"].includes(name)) input.file_path = input.path || input.file_path;
    if (name === "Bash" && input.isBackground) input.run_in_background = true;
    const content = [{ type: "tool_use", id: event.call_id, name, input }];
    return { type: "assistant", ...metadata, message: { role: "assistant", content } };
  }
  if (event.subtype !== "completed") return null;
  const result = tool.result || {};
  const denied = result.permissionDenied ?? result.readPermissionDenied ?? result.writePermissionDenied;
  const failure = denied ?? result.error ?? result.rejected ?? result.failure ?? result.fileNotFound;
  const details = failure ?? result.success ?? result;
  const exitCode = name === "Bash" ? details.exitCode : null;
  const isError = failure != null || (typeof exitCode === "number" && exitCode !== 0) || Boolean(details.signal);
  let text = details.interleavedOutput || [details.stdout, details.stderr].filter(Boolean).join("\n")
    || details.content || details.errorMessage || details.error || details.reason || details.message || JSON.stringify(details);
  if (denied) text = `Permission to use ${name} has been denied\n${text}`;
  else if (typeof exitCode === "number" && exitCode !== 0) text = `Exit code ${exitCode}\n${text}`;
  const content = [{ type: "tool_result", tool_use_id: event.call_id, content: text, is_error: isError }];
  return {
    type: "user", ...metadata, message: { role: "user", content },
    ...(name === "Bash" && result.isBackground && { tool_use_result: { backgroundTaskId: event.call_id } }),
  };
}

function scanLines(onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    },
    finish() {
      pending += decoder.end();
      if (pending) onLine(pending);
    },
  };
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runAgent(args, { cwd, env, input, stdout, stderr, timeout, onTimeout, setStop }) {
  const child = spawn("agent", args, {
    cwd, env, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  return new Promise((resolve) => {
    let hardKill;
    let drain;
    let spawnError;
    const closePipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = (signal) => {
      killGroup(child, signal);
      if (hardKill) return;
      hardKill = setTimeout(() => {
        killGroup(child, "SIGKILL");
        closePipes();
      }, 1500);
    };
    const timer = timeout ? setTimeout(() => {
      onTimeout();
      stop("SIGTERM");
    }, timeout) : null;
    setStop(stop);
    child.stdout.on("data", stdout);
    child.stderr.on("data", stderr);
    child.stdin.on("error", () => {}); // A child may exit before reading all of its stdin.
    child.on("error", (error) => { spawnError = error; });
    child.once("exit", () => {
      // An inherited pipe from a background command can otherwise keep 'close' from firing.
      clearTimeout(timer);
      drain = setTimeout(closePipes, 250);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(drain);
      if (hardKill) {
        clearTimeout(hardKill);
        killGroup(child, "SIGKILL");
      }
      setStop(null);
      resolve({ code, signal, spawnError });
    });
    child.stdin.end(input);
  });
}

function failureText(message) {
  if (/quota|rate[ _-]?limit|resource[ _]exhausted|too many requests|\b429\b/i.test(message)) {
    return `Cursor usage limit: ${message}`;
  }
  return message;
}

async function relay(opts, brief) {
  const dir = opts.outDir || fs.mkdtempSync(path.join(tmpdir(), "cursor-relay-"));
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    eventsPath: path.join(dir, "events.jsonl"),
    cursorEventsPath: path.join(dir, "cursor-events.jsonl"),
    finalPath: path.join(dir, "final.txt"),
    stderrPath: path.join(dir, "stderr.txt"),
  };
  const resultPath = path.join(dir, "result.json");
  const tempResult = `${resultPath}.${process.pid}.tmp`;
  const configDir = fs.mkdtempSync(path.join(dir, "cursor-config-"));
  const artifacts = [...Object.values(files), resultPath, tempResult, configDir];
  fs.rmSync(resultPath, { force: true });
  for (const file of Object.values(files)) fs.writeFileSync(file, "", { mode: 0o600 });

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const cursorModel = opts.model && opts.effort ? `${opts.model}-${opts.effort}` : opts.model;
  // Cursor reports usage only in its final event: estimate it per model call until then.
  const estimator = createUsageEstimator({ model: opts.model ?? null, briefChars: brief.length });
  let eventModel = cursorModel ?? null;
  const result = {
    schema: "delegate-relay.result.v1",
    tool: "cursor", workdir: opts.cd, startedAt, model: opts.model ?? null, cursorModel: cursorModel ?? null, effort: opts.effort ?? null,
    session: opts.session ?? null, resumed: Boolean(opts.session), sessionId: opts.session ?? null,
    agentVersion: null, finalMessage: "", usage: null, usageEstimate: null, projectConfigPaths: [], ...files,
  };
  const appendEvent = (event) => fs.appendFileSync(files.eventsPath, JSON.stringify(event) + "\n");
  let vendorResult;
  let stopChild;
  let interruption;
  let sawInit = false;
  let sawMessage = false; // an assistant message with text arrived
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((signal) => () => {
    if (interruption?.status === "aborted") return;
    interruption = { status: "aborted", signal, error: `the relay received ${signal}` };
    stopChild?.(signal);
  });
  signals.forEach((signal, i) => process.on(signal, handlers[i]));
  const setStop = (stop) => { stopChild = stop; };

  const root = gitRoot(opts.cd);
  const excludes = gitExcludes(root, artifacts);
  const before = opts.readOnly ? gitStatus(opts.cd, root, excludes) : null;
  const beforeSnapshot = opts.readOnly ? snapshotReadOnly(root, excludes) : null;
  let stderrTail = Buffer.alloc(0);
  const recordStderr = (chunk) => {
    fs.appendFileSync(files.stderrPath, chunk);
    process.stderr.write(chunk);
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-16384);
  };
  const scanner = scanLines((line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "system" && event.subtype === "init") {
      sawInit = true;
      result.sessionId = event.session_id || result.sessionId;
      eventModel = cursorModel || event.model || null;
      result.cursorModel ??= eventModel;
      appendEvent({ type: "system", subtype: "init", session_id: result.sessionId, model: eventModel });
    } else if (event.type === "thinking" && event.subtype === "delta") {
      estimator.thinking(event.text);
    } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const content = event.message.content.filter((block) => block.type === "text");
      if (content.length) {
        result.finalMessage = content.map((block) => block.text).join("\n");
        sawMessage = true;
        const { id, usage } = estimator.text(result.finalMessage);
        appendEvent({ type: "assistant", session_id: result.sessionId, message: { id, role: "assistant", model: eventModel, content, usage } });
      }
    } else if (event.type === "tool_call") {
      const tools = Object.entries(event.tool_call || {});
      const [, tool] = tools.find(([key]) => key.endsWith("ToolCall")) || tools[0] || [];
      const { id, usage } = estimator.toolCall(event, tool);
      const mapped = toolEvent(event);
      // A started call is the model's message: it carries the running estimate of that model call.
      if (mapped?.type === "assistant") Object.assign(mapped.message, { id, model: eventModel, usage });
      if (mapped) appendEvent(mapped);
    } else if (event.type === "result") {
      vendorResult = event;
    }
  });

  let status = "failed";
  let exitCode = 1;
  let signal = null;
  let error;
  try {
    const env = prepareConfig(configDir, opts, root, result.projectConfigPaths);
    // The native project loader replaces permission arrays. Use the merged profile instead.
    const useMergedConfig = "--disable-project-configs";
    const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", opts.cd];
    if (cursorModel) args.push("--model", cursorModel);
    if (opts.session) args.push("--resume", opts.session);
    if (opts.sandbox) args.push("--sandbox", opts.sandbox);
    args.push(...(opts.readOnly ? ["--mode", "plan"] : ["--force"]));
    args.push(useMergedConfig);

    const timeout = (error) => { interruption ??= { status: "timeout", error }; };
    let version = "";
    const probe = await runAgent(["--version", useMergedConfig], {
      cwd: opts.cd, env, setStop, timeout: 10000, onTimeout: () => timeout("agent --version timed out"),
      stdout: (chunk) => { version += chunk.toString(); }, stderr: recordStderr,
    });
    if (probe.spawnError?.code === "ENOENT") {
      status = "agent_unavailable";
      exitCode = 127;
      error = "agent was not found on PATH";
    } else if (!interruption && (probe.spawnError || probe.code !== 0)) {
      signal = probe.signal;
      exitCode = probe.code ?? (signal ? 128 + constants.signals[signal] : 1);
      error = probe.spawnError?.message || stderrTail.toString().trim() || "agent --version failed";
    } else if (!interruption) {
      result.agentVersion = version.trim() || null;
      const child = await runAgent(args, {
        cwd: opts.cd, env, input: brief, stderr: recordStderr, setStop, timeout: opts.timeoutMs,
        onTimeout: () => timeout(`agent timed out after ${opts.timeout}`),
        stdout(chunk) {
          fs.appendFileSync(files.cursorEventsPath, chunk);
          scanner.push(chunk);
        },
      });
      scanner.finish();
      signal = child.signal;
      exitCode = child.code ?? (signal ? 128 + constants.signals[signal] : 1);
      if (child.spawnError?.code === "ENOENT") {
        status = "agent_unavailable";
        exitCode = 127;
        error = "agent was not found on PATH";
      } else if (exitCode === 0 && vendorResult && !vendorResult.is_error) {
        status = "completed";
      } else {
        error = child.spawnError?.message
          || (vendorResult?.is_error && (vendorResult.result || vendorResult.error))
          || stderrTail.toString().trim()
          || (signal ? `agent terminated by ${signal}` : `agent exited ${exitCode} without a successful result`);
      }
    }
  } catch (caught) {
    error = caught.message;
  }

  if (vendorResult) {
    result.sessionId = vendorResult.session_id || result.sessionId;
    // Cursor's result text joins every message of the run with no separator between them, so a
    // model that wrote two closing messages leaves its report and its PARKED: line in the middle of
    // one run-on text. The final message is the last message, as Claude's is. The result text is
    // used when no message came, and for an error result, whose text is the error.
    if (typeof vendorResult.result === "string" && (!sawMessage || vendorResult.is_error)) result.finalMessage = vendorResult.result;
    if (vendorResult.usage) {
      const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = vendorResult.usage;
      result.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
      estimator.calibrate(result.usage);
    }
  }
  // What the running estimate came to, kept beside the exact usage (null when Cursor gave none).
  result.usageEstimate = estimator.totals();
  if (interruption) {
    status = interruption.status;
    error = interruption.error;
    signal = interruption.signal || signal;
    if (signal) exitCode = 128 + constants.signals[signal];
    else if (exitCode === 0 || !result.agentVersion) exitCode = 124;
  }
  const after = gitStatus(opts.cd, root, excludes);
  if (opts.readOnly) {
    result.readOnlyViolation = readOnlyVerdict(beforeSnapshot, snapshotReadOnly(root, excludes), before, after);
    if (result.readOnlyViolation && status === "completed") {
      status = "failed";
      error = "read-only violation: the worktree or index changed during the Cursor run";
    }
  }
  if (status !== "completed" && exitCode === 0) exitCode = 1;
  Object.assign(result, {
    status, exitCode, signal, touchedFiles: after, finishedAt: new Date().toISOString(),
  });
  if (status !== "completed") {
    result.error = failureText(String(error || "agent failed"));
    result.stderrTail = stderrTail.toString().trimEnd().split(/\r?\n/).filter(Boolean).slice(-20);
  }
  if (!sawInit && result.sessionId) appendEvent({ type: "system", subtype: "init", session_id: result.sessionId, model: eventModel });
  const usage = result.usage;
  appendEvent({
    type: "result", subtype: status === "completed" ? "success" : "error_during_execution",
    session_id: result.sessionId, is_error: status !== "completed",
    result: result.error ?? result.finalMessage, duration_ms: vendorResult?.duration_ms ?? Date.now() - started,
    ...(usage && { usage: {
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWriteTokens,
    } }),
  });
  fs.writeFileSync(files.finalPath, result.finalMessage);
  fs.writeFileSync(tempResult, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tempResult, resultPath);
  signals.forEach((name, i) => process.off(name, handlers[i]));
  process.stdout.write([
    "--- cursor final report ---", result.finalMessage || "(no final message captured)", "--- end report ---", "",
    `relay: ${status} (exit ${exitCode}${signal ? `, ${signal}` : ""}) · cursor ${result.agentVersion ?? "?"}`,
    ...(result.sessionId ? [`session id (resume with --session): ${result.sessionId}`] : []),
    ...(result.error ? [result.error] : []), `result: ${resultPath}`, "",
  ].join("\n"));
  return exitCode;
}

let opts;
let brief;
try {
  opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  brief = fs.readFileSync(opts.brief ?? 0, "utf8");
  if (!brief.trim()) throw new Error("empty brief (pass --brief FILE or pipe the brief on stdin)");
} catch (error) {
  console.error(`cursor relay: ${error.message}`);
  process.exit(2);
}

try {
  process.exitCode = await relay(opts, brief);
} catch (error) {
  console.error(`cursor relay: ${error.message}`);
  process.exitCode = 1;
}
