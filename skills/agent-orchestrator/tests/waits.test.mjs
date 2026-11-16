import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';
// Pure: the texts appended to every brief, and the compact window a Claude relay gets.
import { decisionNote } from '../scripts/lib/briefs.mjs';
import { inboxNote } from '../scripts/lib/inbox.mjs';
import { compactWindow } from '../scripts/lib/commands/start.mjs';

const inTask = (run, id) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id, AGENT_ORCH_DEPTH: '1' });

test('inside a task, naps add up per attempt and nap refuses past the budget; outside a task and in a command task it does not', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'napper', { config: { hold: true } });
  await f.ready(task);
  const env = { ...inTask(run, 'napper'), AGENT_ORCH_NAP_BUDGET: '300ms' };
  await f.command(['nap', '200ms'], { env });
  assert.deepEqual(readJson(path.join(task.outDir, 'naps.json')), { ms: 200, naps: 1 });
  const refused = await f.command(['nap', '200ms'], { code: 2, env });
  assert.match(refused.stderr, /refusing: the naps of this attempt already add up to .*, and a nap of .* would pass its budget of .* \(AGENT_ORCH_NAP_BUDGET\)/);
  assert.match(refused.stderr, /park-until --every 2m -- <command that exits 0 once it is done>.*PARKED: waits for <what>/);
  assert.deepEqual(readJson(path.join(task.outDir, 'naps.json')), { ms: 200, naps: 1 }, 'a refused nap adds nothing');
  // What is left of the budget may still be napped.
  await f.command(['nap', '100ms'], { env });
  f.release(task);
  await f.finished(run, 'napper');

  // Outside a task nap is unchanged, whatever the budget.
  await f.command(['nap', '200ms'], { env: { AGENT_ORCH_NAP_BUDGET: '100ms' } });
  // A command task naps freely: no model waits.
  const cmd = JSON.parse((await f.command(['start', run.id, 'script', '--agent', 'command', '--why', 'Waits in a script', '--json', '--', process.execPath, '-e', 'setTimeout(() => {}, 20000)'])).stdout);
  await f.command(['nap', '200ms'], { env: { ...inTask(run, 'script'), AGENT_ORCH_NAP_BUDGET: '100ms' } });
  assert.equal(fs.existsSync(path.join(cmd.outDir, 'naps.json')), false);
  await f.command(['stop', run.id, 'script']);
});

test('every brief says to park instead of waiting in the session, and the decisions note gives the nap budget', () => {
  for (const agent of ['claude', 'codex']) {
    const note = inboxNote({ id: 'run' }, 'task', agent);
    assert.match(note, /Never wait in your session for more than a few minutes: no sleep, nap or polling loops/);
    assert.match(note, /park-until --every 2m -- <command that exits 0 once it is done>/);
    assert.match(note, /end your turn with a final message whose first line is `PARKED: waits for <what>`/);
    assert.match(note, /A babysitter keeps parking as its brief says/);
    assert.doesNotMatch(note, /nap 30s \|\| break/, 'no polling loop is suggested');
  }
  assert.match(decisionNote(false), /nap 5m`, which returns as soon as a message arrives \(an attempt's naps may add up to 10 minutes; past that, `nap` refuses/);
});

test('a Claude relay compacts at AGENT_ORCH_CLAUDE_COMPACT_WINDOW, 300k by default; a set CLAUDE_CODE_AUTO_COMPACT_WINDOW is kept', () => {
  assert.deepEqual(compactWindow({}), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, record: { value: '300000', from: 'default' } });
  for (const [setting, value] of [['200k', '200000'], ['1m', '1000000'], ['1M', '1000000'], ['100000', '100000'], ['450K', '450000']]) {
    assert.deepEqual(compactWindow({ AGENT_ORCH_CLAUDE_COMPACT_WINDOW: setting }), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: value }, record: { value, from: 'AGENT_ORCH_CLAUDE_COMPACT_WINDOW' } }, setting);
  }
  // Out of range or not a size: the default, with no failure.
  for (const bad of ['50k', '2m', '99999', 'lots', '-1', '']) {
    assert.deepEqual(compactWindow({ AGENT_ORCH_CLAUDE_COMPACT_WINDOW: bad }).record, { value: '300000', from: 'default' }, bad);
  }
  assert.deepEqual(compactWindow({ AGENT_ORCH_CLAUDE_COMPACT_WINDOW: 'off' }), { env: {}, record: { value: null, from: 'AGENT_ORCH_CLAUDE_COMPACT_WINDOW=off' } });
  assert.deepEqual(compactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k', AGENT_ORCH_CLAUDE_COMPACT_WINDOW: '200k' }), { env: {}, record: { value: '500k', from: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' } });
});

test('start gives every Claude relay its compact window, records it on the attempt, and result shows it; Codex gets none', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const claude = await f.start(run, 'claude-task');
  await f.finished(run, 'claude-task');
  assert.equal(readJson(path.join(claude.outDir, 'invocation.json')).compactWindow, '300000');
  assert.deepEqual(readJson(f.taskFile(run, 'claude-task')).compactWindows, { 1: { value: '300000', from: 'default' } });
  assert.match((await f.command(['result', run.id, 'claude-task'])).stdout, /^compact window: 300000 tokens \(the default of AGENT_ORCH_CLAUDE_COMPACT_WINDOW\)$/m);

  const off = await f.start(run, 'claude-off', { env: { AGENT_ORCH_CLAUDE_COMPACT_WINDOW: 'off' } });
  await f.finished(run, 'claude-off');
  assert.equal(readJson(path.join(off.outDir, 'invocation.json')).compactWindow, null);
  assert.match((await f.command(['result', run.id, 'claude-off'])).stdout, /^compact window: Claude Code's default \(AGENT_ORCH_CLAUDE_COMPACT_WINDOW=off\)$/m);

  const kept = await f.start(run, 'claude-kept', { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } });
  await f.finished(run, 'claude-kept');
  assert.equal(readJson(path.join(kept.outDir, 'invocation.json')).compactWindow, '700000');
  assert.deepEqual(readJson(f.taskFile(run, 'claude-kept')).compactWindows[1], { value: '700000', from: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' });

  const codex = await f.start(run, 'codex-task', { agent: 'codex' });
  await f.finished(run, 'codex-task');
  assert.equal(readJson(path.join(codex.outDir, 'invocation.json')).compactWindow, null);
  assert.equal(readJson(f.taskFile(run, 'codex-task')).compactWindows, undefined);
  assert.doesNotMatch((await f.command(['result', run.id, 'codex-task'])).stdout, /compact window/);
});
