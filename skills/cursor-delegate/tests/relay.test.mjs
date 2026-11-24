import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const relay = fileURLToPath(new URL("../scripts/relay.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const fake = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2026.11.22-fake");
} else {
  const brief = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.FAKE_INVOCATION, JSON.stringify({ args, brief, config: process.env.CURSOR_CONFIG_DIR }));
  const mode = process.env.FAKE_MODE;
  if (mode === "hold") {
    process.on("SIGTERM", () => {
      console.error("fake got SIGTERM");
      process.exit(143);
    });
    fs.writeFileSync(process.env.FAKE_INVOCATION + ".ready", "");
    setInterval(() => {}, 1000);
  } else if (mode === "fail") {
    console.error("first diagnostic\\nHTTP 429: quota exhausted");
    process.exitCode = 7;
  } else {
    if (mode === "edit") fs.writeFileSync(process.env.FAKE_EDIT_PATH || "changed.txt", "changed");
    if (mode === "index-only") require("node:child_process").execFileSync("git", [
      "update-index", "--cacheinfo", "100644," + process.env.FAKE_INDEX_BLOB + "," + process.env.FAKE_EDIT_PATH,
    ]);
    const name = process.env.FAKE_FIXTURE || "simple-text";
    let raw = fs.readFileSync(path.join(process.env.FAKE_FIXTURES, name + ".jsonl"), "utf8");
    if (mode === "shell-error") raw = raw.replace('"exitCode":0', '"exitCode":3');
    if (mode === "turn-error") raw = raw.replace('"is_error":false', '"is_error":true')
      .replace('"result":"pong"', () => '"result":' + JSON.stringify(process.env.FAKE_ERROR || "Resource exhausted"));
    if (mode === "no-result") raw = raw.split("\\n").filter((line) => !line.includes('"type":"result"')).join("\\n");
    if (mode === "custom-tools") {
      const events = raw.trimEnd().split("\\n");
      const result = events.pop();
      for (const [callId, key, entry] of [
        ["call-1", "lookup", { args: { term: "example" } }],
        ["call-2", "function", { name: "list_items", arguments: '{"limit":3}' }],
      ]) {
        events.push(JSON.stringify({ type: "tool_call", subtype: "started", call_id: callId, tool_call: { [key]: entry } }));
        events.push(JSON.stringify({ type: "tool_call", subtype: "completed", call_id: callId, tool_call: { [key]: { ...entry, result: { success: { content: "ok" } } } } }));
      }
      raw = [...events, result, ""].join("\\n");
    }
    process.stdout.write(raw);
  }
}
`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-relay-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const userConfig = path.join(root, "config");
  const out = path.join(root, "out");
  const invocation = path.join(root, "invocation.json");
  const briefFile = path.join(root, "brief.txt");
  for (const dir of [cwd, bin, userConfig]) fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", cwd]);
  const agent = path.join(bin, "agent");
  fs.writeFileSync(agent, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
  fs.writeFileSync(briefFile, "file brief\n");
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CURSOR_CONFIG_DIR: userConfig, AGENT_ORCH_SKILLS_DIR: path.join(root, "unused-fake-skills"),
    FAKE_INVOCATION: invocation, FAKE_FIXTURES: fixtures,
  };
  const args = (...extra) => [relay, "--out-dir", out, "--cd", cwd, ...extra];
  const run = (extra = [], options = {}) => spawnSync(process.execPath, args(...extra), {
    env: { ...env, ...options.env }, input: options.input ?? "synthetic brief\n", encoding: "utf8", timeout: 10000,
  });
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const artifact = (file) => fs.readFileSync(path.join(out, file), "utf8");
  return {
    args, run, agent, bin, briefFile, cwd, env, out, userConfig, invocation, artifact,
    result: () => readJson(path.join(out, "result.json")),
    invocationData: () => readJson(invocation),
    events: () => artifact("events.jsonl").trim().split("\n").map(JSON.parse),
  };
}

test("help lists the flags and an unknown flag never launches agent or writes a result", (t) => {
  const f = fixture(t);
  for (const helpFlag of ["--help", "-h"]) {
    const help = f.run([helpFlag]);
    assert.equal(help.status, 0);
    for (const flag of ["--brief", "--cd", "--out-dir", "--model", "--effort", "--read-only", "--sandbox", "--allow", "--deny", "--session", "--timeout", "--help", "-h"]) {
      assert.ok(help.stdout.includes(flag), flag);
    }
  }
  for (const flags of [["--network-access"], ["--web-search", "live"], ["--subagent-model", "foo"], ["--help", "--unknown"], ["--model", "--sandbox"], ["--sandbox", "bad"], ["--timeout", "forever"]]) {
    assert.equal(f.run(flags).status, 2, flags.join(" "));
  }
  assert.equal(f.run([], { input: "\n" }).status, 2);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(fs.existsSync(f.invocation), false);
});

test("rejects unknown permission types and empty rules before launching Cursor", (t) => {
  const f = fixture(t);
  for (const [flag, rule] of [["--deny", "Bash(git push *)"], ["--allow", "Edit(file.txt)"], ["--deny", "Read( )"], ["--allow", "Shell"]]) {
    const run = f.run([flag, rule]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /requires a Cursor rule/);
  }
  assert.equal(fs.existsSync(f.out), false);
  const run = f.run(["--allow", "WebFetch(example.org)", "--deny", "Mcp(*:*)"]);
  assert.equal(run.status, 0, run.stderr);
});

test("dispatches the selected model and writes the raw stream and success artifacts", (t) => {
  const f = fixture(t);
  const run = f.run(["--model", "gemini-4-hydrogen", "--effort", "low", "--sandbox", "disabled", "--brief", f.briefFile]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(f.invocationData().args, ["-p", "--output-format", "stream-json", "--trust", "--workspace", f.cwd,
    "--model", "gemini-4-hydrogen-low", "--sandbox", "disabled", "--force", "--disable-project-configs"]);
  assert.equal(f.invocationData().brief, "file brief\n");
  const result = f.result();
  assert.equal(result.status, "completed");
  assert.equal(result.model, "gemini-4-hydrogen");
  assert.equal(result.cursorModel, "gemini-4-hydrogen-low");
  assert.equal(result.effort, "low");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.agentVersion, "2026.11.22-fake");
  assert.equal(result.finalMessage, "pong");
  assert.deepEqual(result.touchedFiles, []);
  assert.deepEqual(result.usage, { inputTokens: 10030, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(f.events()[0], { type: "system", subtype: "init", session_id: result.sessionId, model: result.cursorModel });
  assert.equal(f.events()[1].message.content[0].text, "pong");
  assert.equal(f.artifact("cursor-events.jsonl"), fs.readFileSync(path.join(fixtures, "simple-text.jsonl"), "utf8"));
  assert.equal(f.artifact("final.txt"), "pong");
  assert.equal(f.artifact("stderr.txt"), "");
  for (const [key, name] of Object.entries({ eventsPath: "events.jsonl", cursorEventsPath: "cursor-events.jsonl", finalPath: "final.txt", stderrPath: "stderr.txt" })) {
    assert.equal(result[key], path.join(f.out, name));
  }
  assert.match(run.stdout, /--- cursor final report ---\npong\n--- end report ---/);
  assert.equal(fs.readdirSync(f.out).some((name) => name.endsWith(".tmp")), false);
});

test("normalizes read, edit, shell and denied calls plus Cursor's separate cache counters", (t) => {
  for (const name of ["read-edit-shell", "permission-denied"]) {
    const f = fixture(t);
    assert.equal(f.run([], { env: { FAKE_FIXTURE: name } }).status, 0);
    const events = f.events();
    const uses = events.flatMap((e) => e.message?.content || []).filter((b) => b.type === "tool_use");
    const replies = events.flatMap((e) => e.message?.content || []).filter((b) => b.type === "tool_result");
    assert.deepEqual(uses.map((b) => b.name), name === "read-edit-shell" ? ["Read", "Edit", "Bash"] : ["Read", "Bash"]);
    assert.deepEqual(replies.map((b) => b.tool_use_id), uses.map((b) => b.id));
    assert.equal(uses[0].input.file_path, uses[0].input.path);
    assert.ok(uses.at(-1).input.command);
    const final = events.at(-1);
    assert.equal(final.type, "result");
    assert.equal(final.session_id, f.result().sessionId);
    assert.equal(final.is_error, false);
    assert.equal("total_cost_usd" in final, false);
    if (name === "read-edit-shell") {
      assert.equal(uses[1].input.file_path, "/private/tmp/cursor-probe/b.txt");
      assert.equal(replies[0].content, "hello\n");
      assert.match(replies[2].content, /b\.txt/);
      assert.deepEqual(final.usage, { input_tokens: 17261, output_tokens: 228, cache_read_input_tokens: 26428, cache_creation_input_tokens: 0 });
    } else {
      assert.deepEqual(replies.map((b) => b.is_error), [true, true]);
      assert.match(replies[0].content, /Permission denied/i);
      assert.match(replies[1].content, /blocked by permissions/i);
    }
  }
  const f = fixture(t);
  assert.equal(f.run([], { env: { FAKE_FIXTURE: "read-edit-shell", FAKE_MODE: "shell-error" } }).status, 0);
  const bashReply = f.events().filter((e) => e.type === "user").at(-1).message.content[0];
  assert.equal(bashReply.is_error, true);
  assert.match(bashReply.content, /^Exit code 3\n/);
});

test("continues via --resume and merges only permissions into a private config with a shared chats link", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.userConfig, "cli-config.json"), JSON.stringify({
    version: 1, editor: { vimMode: true }, permissions: { allow: ["Read(docs/**)"], deny: ["Write(outside.txt)"] },
  }));
  const session = "c78bd7fd-0026-4ae5-9ecd-4c97615042fc";
  const run = f.run(["--session", session, "--model", "model[effort=high]", "--read-only",
    "--allow", "Shell(git diff *)", "--allow", "Read(test.txt)",
    "--deny", "Read(private/**)", "--deny", "Shell(git push *)"], { input: "continue with only this brief" });
  assert.equal(run.status, 0, run.stderr);
  const invoked = f.invocationData();
  assert.equal(invoked.brief, "continue with only this brief");
  assert.deepEqual(invoked.args.slice(6), ["--model", "model[effort=high]", "--resume", session, "--mode", "plan", "--disable-project-configs"]);
  assert.equal(f.result().sessionId, session);
  assert.equal(f.result().resumed, true);
  assert.equal(f.result().readOnlyViolation, false);
  assert.equal(path.dirname(invoked.config), f.out);
  assert.equal(fs.statSync(invoked.config).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(invoked.config, "cli-config.json"), "utf8")), {
    version: 1,
    permissions: { allow: ["Read(docs/**)", "Shell(git diff *)", "Read(test.txt)"],
      deny: ["Write(outside.txt)", "Read(private/**)", "Shell(git push *)", "Write(**)", "Write(**/*)"] },
  });
  assert.equal(fs.readlinkSync(path.join(invoked.config, "chats")), path.join(f.userConfig, "chats"));
});

test("keeps named and function-shaped tools in the normalized stream", (t) => {
  const f = fixture(t);
  assert.equal(f.run([], { env: { FAKE_MODE: "custom-tools" } }).status, 0);
  const blocks = f.events().flatMap((event) => event.message?.content ?? []);
  assert.deepEqual(blocks.filter((block) => block.type === "tool_use"), [
    { type: "tool_use", id: "call-1", name: "lookup", input: { term: "example" } },
    { type: "tool_use", id: "call-2", name: "list_items", input: { limit: 3 } },
  ]);
  assert.deepEqual(blocks.filter((block) => block.type === "tool_result"), [
    { type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false },
    { type: "tool_result", tool_use_id: "call-2", content: "ok", is_error: false },
  ]);
});

test("a reused output directory gets a fresh private config and current result", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["--deny", "Read(first.txt)"]).status, 0);
  const first = f.invocationData().config;
  const secondRun = f.run(["--deny", "Read(second.txt)"], { env: { FAKE_FIXTURE: "read-edit-shell" } });
  assert.equal(secondRun.status, 0, secondRun.stderr);
  const second = f.invocationData().config;
  assert.notEqual(second, first);
  assert.equal(fs.statSync(second).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second, "cli-config.json"), "utf8")).permissions.deny, ["Read(second.txt)"]);
  assert.equal(fs.readlinkSync(path.join(second, "chats")), path.join(f.userConfig, "chats"));
  assert.equal(f.result().status, "completed");
  assert.match(f.artifact("final.txt"), /b\.txt/);
});

test("preserves both project and relay rules when Cursor is launched from a project subdirectory", (t) => {
  const f = fixture(t);
  const child = path.join(f.cwd, "outer", "inner");
  const rootConfig = path.join(f.cwd, ".cursor", "cli.json");
  const parentConfig = path.join(f.cwd, "outer", ".cursor", "cli.json");
  fs.mkdirSync(child, { recursive: true });
  for (const [file, permissions] of [
    [rootConfig, { allow: ["Shell(git status)"], deny: ["Read(root-private.txt)"] }],
    [parentConfig, { allow: [], deny: ["Write(parent-private.txt)"] }],
  ]) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ permissions, editor: { vimMode: true } }));
  }
  const run = f.run(["--cd", child, "--deny", "Shell(git push *)"]);
  assert.equal(run.status, 0, run.stderr);
  const invocation = f.invocationData();
  assert.ok(invocation.args.includes("--disable-project-configs"));
  assert.deepEqual(f.result().projectConfigPaths, [rootConfig, parentConfig]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(invocation.config, "cli-config.json"), "utf8")), {
    version: 1,
    permissions: { allow: ["Shell(git status)"], deny: ["Read(root-private.txt)", "Write(parent-private.txt)", "Shell(git push *)"] },
  });
});

test("fails before launching agent on malformed or unreadable project config", (t) => {
  for (const [contents, diagnostic] of [
    ["{", /could not read or parse project Cursor config/],
    ['{"permissions":{"deny":[]}}', /invalid Cursor permissions.allow/],
    ['{"permissions":{"allow":[],"deny":[false]}}', /invalid Cursor permissions.deny/],
    [null, /could not read or parse project Cursor config/],
  ]) {
    const f = fixture(t);
    const dir = path.join(f.cwd, ".cursor");
    fs.mkdirSync(dir);
    const file = path.join(dir, "cli.json");
    if (contents === null) fs.symlinkSync("missing.json", file);
    else fs.writeFileSync(file, contents);
    assert.equal(f.run().status, 1);
    const result = f.result();
    assert.equal(result.status, "failed");
    assert.match(result.error, diagnostic);
    assert.match(result.error, /\.cursor\/cli\.json/);
    assert.equal(result.agentVersion, null);
    assert.equal(fs.existsSync(f.invocation), false);
  }
});

test("read-only tripwire sees worktree changes without counting relay artifacts", (t) => {
  for (const mode of ["edit", ""]) {
    const f = fixture(t);
    const nestedOut = path.join(f.cwd, "nested", "relay-out");
    const run = f.run(["--read-only", "--out-dir", nestedOut], { env: { FAKE_MODE: mode } });
    assert.equal(run.status, mode === "edit" ? 1 : 0, run.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(nestedOut, "result.json"), "utf8"));
    assert.equal(result.readOnlyViolation, mode === "edit");
    assert.equal(result.status, mode === "edit" ? "failed" : "completed");
    assert.deepEqual(result.touchedFiles, mode === "edit" ? ["?? changed.txt"] : []);
  }
});

test("the read-only tripwire detects dirty, ignored and index-only edits with unchanged porcelain", (t) => {
  for (const kind of ["dirty", "ignored", "index"]) {
    const f = fixture(t);
    const name = kind === "ignored" ? "cache/file.txt" : "tracked.txt";
    const target = path.join(f.cwd, name);
    fs.writeFileSync(path.join(f.cwd, ".gitignore"), "cache/\n");
    fs.writeFileSync(path.join(f.cwd, "tracked.txt"), "original");
    const git = (...args) => execFileSync("git", ["-C", f.cwd, ...args], { encoding: "utf8" });
    git("add", ".");
    git("-c", "user.name=Relay Test", "-c", "user.email=test@example.org", "commit", "-qm", "Set up fixture");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "dirty");
    let FAKE_INDEX_BLOB = "";
    if (kind === "index") {
      git("add", name);
      fs.writeFileSync(target, "second version");
      FAKE_INDEX_BLOB = git("hash-object", "-w", name).trim();
      fs.writeFileSync(target, "third version");
    }
    const originalStatus = git("status", "--porcelain", "--ignored=traditional", "-uall");
    const mode = kind === "index" ? "index-only" : "edit";
    const run = f.run(["--read-only"], { env: { FAKE_MODE: mode, FAKE_EDIT_PATH: name, FAKE_INDEX_BLOB } });
    assert.equal(git("status", "--porcelain", "--ignored=traditional", "-uall"), originalStatus);
    assert.equal(run.status, 1, kind);
    assert.equal(f.result().readOnlyViolation, true, kind);
    assert.equal(f.result().status, "failed");
  }
});

test("the read-only tripwire reports unknown for an embedded untracked repository", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, "nested"));
  execFileSync("git", ["-C", path.join(f.cwd, "nested"), "init", "-q"]);
  assert.equal(f.run(["--read-only"]).status, 0);
  assert.equal(f.result().readOnlyViolation, null);
});

test("preserves failure exit codes and records usage-limit errors in both result formats", (t) => {
  const f = fixture(t);
  const run = f.run([], { env: { FAKE_MODE: "fail" } });
  assert.equal(run.status, 7);
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().exitCode, 7);
  assert.match(f.result().error, /Cursor usage limit/);
  assert.match(f.events().at(-1).result, /Cursor usage limit/);
  assert.equal(f.events().at(-1).is_error, true);
  assert.deepEqual(f.result().stderrTail, ["first diagnostic", "HTTP 429: quota exhausted"]);
  assert.equal(f.artifact("stderr.txt"), "first diagnostic\nHTTP 429: quota exhausted\n");
});

test("a Cursor error result marks the relay failed even when the CLI exits zero", (t) => {
  const f = fixture(t);
  for (const FAKE_ERROR of ["Resource exhausted", "rate limits exceeded", "rate limited", "quotas exhausted"]) {
    assert.equal(f.run([], { env: { FAKE_MODE: "turn-error", FAKE_ERROR } }).status, 1);
    assert.equal(f.result().status, "failed");
    assert.equal(f.result().exitCode, 1);
    assert.equal(f.result().finalMessage, FAKE_ERROR);
    assert.match(f.result().error, /Cursor usage limit/);
    assert.equal(f.events().at(-1).is_error, true);
  }
});

test("a zero exit without a Cursor result fails with exit code 1", (t) => {
  const f = fixture(t);
  assert.equal(f.run([], { env: { FAKE_MODE: "no-result" } }).status, 1);
  assert.equal(f.result().status, "failed");
  assert.equal(f.result().exitCode, 1);
  assert.match(f.result().error, /without a successful result/);
});

test("watchdog stops the agent and produces a timeout result", (t) => {
  const f = fixture(t);
  const run = f.run(["--timeout", "1s"], { env: { FAKE_MODE: "hold" } });
  assert.equal(run.status, 143, run.stderr);
  assert.equal(f.result().status, "timeout");
  assert.equal(f.result().exitCode, 143);
  assert.match(f.result().error, /timed out after 1s/);
  assert.match(f.artifact("stderr.txt"), /fake got SIGTERM/);
});

test("SIGTERM to the relay reaches agent and produces an aborted result", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, f.args(), {
    env: { ...f.env, FAKE_MODE: "hold" }, stdio: ["pipe", "ignore", "ignore"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  child.stdin.end("synthetic brief");
  for (let i = 0; i < 100 && !fs.existsSync(f.invocation + ".ready"); i++) await delay(20);
  assert.ok(fs.existsSync(f.invocation + ".ready"), "agent never became ready");
  child.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.equal(f.result().status, "aborted");
  assert.equal(f.result().signal, "SIGTERM");
  assert.match(f.artifact("stderr.txt"), /fake got SIGTERM/);
});

test("missing agent exits 127 and still publishes artifacts", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.agent);
  const run = f.run([], { env: { PATH: f.bin } });
  assert.equal(run.status, 127, run.stderr);
  assert.equal(f.result().status, "agent_unavailable");
  assert.equal(f.result().exitCode, 127);
  assert.equal(f.result().touchedFiles, null);
  assert.equal(f.events().at(-1).is_error, true);
});
