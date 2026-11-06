#!/usr/bin/env node
// Opt-in live check: node tests/manual/claude-file-permissions.mjs
// Uses synthetic credential files, never real credential contents. Artifacts stay in temp.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (spawnSync('claude', ['--version'], { timeout: 15000 }).error?.code === 'ENOENT') {
  console.log('SKIP: claude is unavailable');
  process.exit(0);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-permissions-')));
const cwd = path.join(root, 'cwd');
const bin = path.join(root, 'bin');
for (const dir of [cwd, bin, path.join(root, 'state'), path.join(root, 'claude'), path.join(root, 'codex')]) fs.mkdirSync(dir);
const moved = {
  AGENT_ORCH_HOME: path.join(root, 'state'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_HOME: path.join(root, 'codex'),
};
const previous = Object.fromEntries(Object.keys(moved).map((key) => [key, process.env[key]]));
Object.assign(process.env, moved);
const { relaySafetyArgs } = await import('../../scripts/lib/permissions.mjs');
const relay = fileURLToPath(new URL('../../../claude-delegate/scripts/relay.mjs', import.meta.url));
const safety = relaySafetyArgs({ key: 'claude', relay, cd: cwd, readOnly: false, publish: false });
for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const files = [path.join(moved.AGENT_ORCH_HOME, 'dashboard-token'),
  path.join(moved.CLAUDE_CONFIG_DIR, '.credentials-fixture.json'), path.join(moved.CODEX_HOME, 'auth.json')];
for (const file of files) fs.writeFileSync(file, 'synthetic-private-marker\n');
fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "fixture-gh-status-ok\\n"\n', { mode: 0o755 });
const skill = fileURLToPath(new URL('../../../claude-delegate/SKILL.md', import.meta.url));
const cat = `cat ${JSON.stringify(skill)}`;
const recursive = `node ${JSON.stringify(relay)} --help`;
const prompt = `This is an authorized permission-rule test using synthetic fixtures only. Perform every numbered action exactly once, even after denials. Do not substitute tools or combine Bash commands. Do not inspect real credentials.\n`
  + files.map((file, i) => `${i + 1}. Use Read on ${JSON.stringify(file)}.`).join('\n')
  + `\n4. Use Edit on ${JSON.stringify(files[0])}, replacing synthetic-private-marker with changed.\n5. Use Write on ${JSON.stringify(files[0])} with contents changed.\n6. Use Bash with command ${JSON.stringify(cat)}.\n7. Use Bash with command ${JSON.stringify(recursive)}.\n8. Use Bash with command "gh auth status".\nThen briefly report results. Do not retry or work around denied tools.`;
const out = path.join(root, 'out');
const env = { ...process.env, AGENT_ORCH_HOME: moved.AGENT_ORCH_HOME, TMPDIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_SESSION_ID;
const child = spawnSync(process.execPath, [relay, '--cd', cwd, '--out-dir', out, '--model', 'claude-haiku-5-5',
  '--max-turns', '20', '--timeout', '180s', ...safety.args], {
  input: prompt, encoding: 'utf8', env, timeout: 200000, maxBuffer: 10 * 1024 * 1024,
});
console.log(`artifacts: ${root}`);
assert.equal(child.status, 0, `${child.error || ''}\n${child.stderr}\n${child.stdout}`);
const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const result = events.findLast((event) => event.type === 'result');
const denials = result.permission_denials || [];
for (const file of files) assert.ok(denials.some((d) => d.tool_name === 'Read' && d.tool_input.file_path === file), `Read denied: ${file}`);
for (const tool of ['Edit', 'Write']) assert.ok(denials.some((d) => d.tool_name === tool && d.tool_input.file_path === files[0]), `${tool} denied`);
assert.ok(denials.some((d) => d.tool_name === 'Bash' && d.tool_input.command === recursive), 'recursive node relay denied');
assert.ok(!denials.some((d) => d.tool_name === 'Bash' && [cat, 'gh auth status'].includes(d.tool_input.command)), 'plain reads and auth status allowed');
const contents = events.flatMap((event) => Array.isArray(event.message?.content) ? event.message.content : []);
const outputs = contents.filter((item) => item.type === 'tool_result' && !item.is_error).map((item) => JSON.stringify(item.content)).join('\n');
assert.ok(outputs.includes('fixture-gh-status-ok'), 'fake gh status executed');
assert.ok(outputs.includes('Claude Delegate'), 'cat skill executed');
for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-private-marker\n');
const summary = { absoluteReadDenials: 3, absoluteEditDenials: 1, absoluteWriteDenials: 1, recursiveRelayDenied: true, skillCatAllowed: true, ghAuthStatusAllowed: true };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
