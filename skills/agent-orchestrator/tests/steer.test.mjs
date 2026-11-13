import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, writeJson } from './helpers.mjs';

const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const claudeCall = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } });
const codexCall = (command) => ({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command, status: 'in_progress' } });

// A held task with a real shell under its relay, and the event of the tool call that runs it.
async function busy(f, run, id, { agent = 'claude', command = 'sleep 61; echo done' } = {}) {
  // As the real agents do: Codex records `/bin/bash -lc '<command>'` but runs `/bin/bash -c <command>`.
  const shell = ['/bin/bash', '-c', command];
  const event = agent === 'codex' ? codexCall(`/bin/bash -lc '${command}'`) : claudeCall(command);
  const task = await f.start(run, id, { agent, config: { hold: true, shell, extraEvents: [event] } });
  await f.ready(task);
  const pid = Number(await eventually(() => fs.existsSync(path.join(task.outDir, 'shell.pid')) && fs.readFileSync(path.join(task.outDir, 'shell.pid'), 'utf8'), 'the shell did not start'));
  return { task, pid };
}

for (const agent of ['claude', 'codex']) {
  test(`send --steer stops a ${agent} agent's pending command so the message reaches it now`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const { task, pid } = await busy(f, run, 'busy', { agent });
    assert.ok(alive(pid));
    const sent = await f.json(['send', run.id, 'busy', 'Stop polling; the run is done.', '--steer']);
    assert.match(sent.steer.stopped, /sleep 61; echo done/);
    await eventually(() => !alive(pid), 'the pending command is still running');
    const [stored] = fs.readFileSync(path.join(run.dir, 'tasks', 'busy', 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(stored.steered, /sleep 61; echo done/);
    const inbox = await f.command(['inbox', run.id, 'busy']);
    assert.match(inbox.stdout, /Your command `[^`]*sleep 61; echo done[^`]*` was stopped so this message reaches you now/);
    f.release(task);
    await f.finished(run, 'busy');
  });
}

test('send --steer never stops a publishing command, and says why', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { task, pid } = await busy(f, run, 'pushing', { command: 'sleep 61; git push origin topic' });
  const sent = await f.json(['send', run.id, 'pushing', 'hello', '--steer']);
  assert.equal(sent.steer.stopped, undefined);
  assert.match(sent.steer.waiting, /not stopped part-way/);
  assert.ok(alive(pid));
  process.kill(pid, 'SIGTERM');
  f.release(task);
  await f.finished(run, 'pushing');
});

test('send without --steer leaves the command running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { task, pid } = await busy(f, run, 'quiet');
  const sent = await f.json(['send', run.id, 'quiet', 'hello']);
  assert.equal(sent.steer, undefined);
  assert.ok(alive(pid));
  process.kill(pid, 'SIGTERM');
  f.release(task);
  await f.finished(run, 'quiet');
});

test('the hook answers a failed tool call too, and tells the agent its command was stopped', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { task } = await busy(f, run, 'busy');
  await f.command(['send', run.id, 'busy', 'Stop polling.', '--steer']);
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, 'PostToolUseFailure'], { cwd: f.repo, env: { ...f.env, AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'busy' } });
    let text = '';
    child.stdout.on('data', (s) => { text += s; });
    child.on('close', () => resolve(JSON.parse(text)));
    child.stdin.end('{}');
  });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /^Message from your orchestrator \([^)]+\): Stop polling\.\nYour command `sleep 61; echo done` was stopped so this message reaches you now\./);
  f.release(task);
  await f.finished(run, 'busy');
});

test('nap returns when its time is up, or at once when a message arrives', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'napper', { config: { hold: true } });
  await f.ready(task);
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'napper' };
  const started = Date.now();
  await f.command(['nap', '1s'], { env });
  assert.ok(Date.now() - started >= 1000);
  const napping = f.command(['nap', '61s'], { env, code: 6 });
  // Send only once the nap has started: a message already waiting when it starts does not wake it.
  await eventually(() => spawnSync('ps', ['-axww', '-o', 'command=']).stdout.toString().includes('orch.mjs nap 61s'), 'nap did not start');
  const sentAt = Date.now();
  await f.command(['send', run.id, 'napper', 'Wake up']);
  const woke = await napping;
  assert.ok(Date.now() - sentAt < 5000, 'woke within seconds');
  assert.match(woke.stdout, /message waiting .*Wake up/);
  await f.command(['nap', 'soon'], { code: 2 });
  f.release(task);
  await f.finished(run, 'napper');
});

// "Send now": a message already queued is pushed through by stopping the agent's command.
test('steer pushes queued messages through, and the agent is told its command was stopped', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { task, pid } = await busy(f, run, 'busy');
  const refused = await f.command(['steer', run.id, 'busy'], { code: 2 });
  assert.match(refused.stderr, /no queued messages/);
  await f.command(['send', run.id, 'busy', 'Check the DAG run.']);
  assert.ok(alive(pid), 'a plain send leaves the command running');
  const steered = await f.json(['steer', run.id, 'busy']);
  assert.equal(steered.queued, 1);
  assert.match(steered.steer.stopped, /sleep 61; echo done/);
  await eventually(() => !alive(pid), 'the pending command is still running');
  const inbox = await f.command(['inbox', run.id, 'busy']);
  assert.match(inbox.stdout, /Check the DAG run\.\nYour command `sleep 61; echo done` was stopped so this message reaches you now/);
  f.release(task);
  await f.finished(run, 'busy');
});

test('the dashboard pushes queued messages through only from its own page', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { task, pid } = await busy(f, run, 'busy');
  await f.command(['send', run.id, 'busy', 'Check the DAG run.']);
  const dash = await f.dashboard();
  const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
  const origin = new URL(dash.url).origin;
  const post = (headers) => fetch(new URL('api/steer', dash.url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ run: run.id, task: 'busy' }) });
  assert.equal((await post({ origin, 'x-orch-token': 'f'.repeat(48) })).status, 403);
  assert.ok(alive(pid));
  const ok = await post({ origin, 'x-orch-token': token });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).steer.stopped, /sleep 61/);
  await eventually(() => !alive(pid), 'the pending command is still running');
  f.release(task);
  await f.finished(run, 'busy');
});

test('a task in a shell command reads its messages when the command ends: status and inbox say so, and how to interrupt it', async (t) => {
  const f = await fixture(t);
  writeJson(path.join(f.claude, 'settings.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node orch-inbox.mjs' }] }] } });
  const run = await f.newRun();
  const { task, pid } = await busy(f, run, 'busy');
  const sent = await f.json(['send', run.id, 'busy', 'Later is fine.']);
  assert.equal(sent.delivery, "the orch-inbox hook adds it to Claude's context after its next tool call");
  const row = (await f.json(['status', run.id])).tasks.find((r) => r.id === 'busy');
  assert.equal(row.shell, 'sleep 61; echo done');
  assert.equal(row.idle, undefined);
  assert.deepEqual([row.inbox.delivery.how, row.inbox.delivery.text], ['shell', 'It reads them when its current shell command ends (`sleep 61; echo done`). Interrupt it to deliver them now.']);
  assert.match(row.inbox.delivery.steer, new RegExp(`orch\\.mjs steer ${run.id} busy$`));
  const inbox = await f.command(['inbox', run.id, 'busy']);
  assert.match(inbox.stdout, /^1 unread message for busy:\nIt reads them when its current shell command ends \(`sleep 61; echo done`\)\. Interrupt it to deliver them now\.\ninterrupt: node \S+ steer \S+ busy\n\n\[/);
  assert.ok(alive(pid), 'reading the queue changes nothing');
  process.kill(pid, 'SIGTERM');
  f.release(task);
  await f.finished(run, 'busy');
});
