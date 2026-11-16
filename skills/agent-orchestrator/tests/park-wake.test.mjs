import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Pure: what a resume brief may quote of a condition's output.
import { redactSecrets } from '../scripts/lib/park.mjs';

const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine
const PARKED = (what) => [
  `PARKED: waits for ${what}`,
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const inTask = (run, id) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id, AGENT_ORCH_DEPTH: '1' });
const attemptDir = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
const attempt = (f, run, id, n) => eventually(() => {
  const task = readJson(f.taskFile(run, id));
  return task.attempt === n ? task : null;
}, `${id}'s attempt ${n} did not start`, SLOW);
const briefOf = (task) => fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const readQuiet = (file) => {
  try {
    return readJson(file);
  } catch {
    return null;
  }
};
// Rewrite a recorded condition: --every refuses less than 30s, so tests edit the record.
function recordEdit(task, changes) {
  const file = path.join(task.outDir, 'park-until.json');
  writeJson(file, { ...readJson(file), ...changes });
}

test('redactSecrets hides obvious secrets and keeps the rest', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const text = [
    `GITHUB_TOKEN=${token}`, 'DB_PASSWORD=correct horse battery', 'state: done', 'HOME=/home/someone',
    `"API_KEY":"abc123def456"`, 'Authorization: Bearer abcdefghijklmnop.qrstu', `pushed with ${token} today`,
    '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----', 'GIT_AUTHOR_NAME=Test',
  ].join('\n');
  const out = redactSecrets(text);
  for (const kept of ['state: done', 'HOME=/home/someone', 'GIT_AUTHOR_NAME=Test', 'GITHUB_TOKEN=[redacted]', 'DB_PASSWORD=[redacted]', '"API_KEY":"[redacted]"', 'pushed with [redacted] today', '[redacted private key]']) {
    assert.ok(out.includes(kept), `${kept} missing from:\n${out}`);
  }
  for (const gone of [token, 'correct horse', 'abc123def456', 'abcdefghijklmnop', 'MIIEowIBAAKCAQEA']) assert.ok(!out.includes(gone), `${gone} left in:\n${out}`);
});

test('a Codex --clean-env task\'s condition gets only what that task was given, and the brief quotes no secret', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Done.' });
  const run = await f.newRun();
  // The caller's environment holds a value the clean task was not given, and one it keeps.
  const caller = { INTERNAL_ENDPOINT: 'internal-value-123', KEPT_SETTING: 'kept-value' };
  const started = await f.command(['start', run.id, 'clean', '--agent', 'codex', '--tier', 'standard', '--why', 'A clean-env fixture',
    '--brief', f.brief('clean', { hold: true, finalMessage: PARKED('the deploy') }), '--json', '--', '--clean-env', '--keep-env', 'KEPT_SETTING'], { env: caller });
  const task = JSON.parse(started.stdout);
  await f.ready(task);
  // `env` exits 0, so the watcher's first check wakes the task with its output.
  await f.command(['park-until', '--', 'env'], { env: { ...inTask(run, 'clean'), ...caller } });
  f.release(task);
  const second = await attempt(f, run, 'clean', 2);
  await f.ready(second);
  const log = fs.readFileSync(path.join(attemptDir(run, 'clean', 1), 'park-condition.log'), 'utf8');
  assert.ok(!log.includes('internal-value-123'), 'the condition saw a variable the clean task was not given');
  assert.match(log, /^KEPT_SETTING=kept-value$/m);
  assert.match(log, /^AGENT_ORCH_TASK=clean$/m);
  assert.ok(!briefOf(second).includes('internal-value-123'));
  assert.match(briefOf(second), /- Your wake condition `env` exited 0/);
  f.release(second);
  await f.finished(run, 'clean');

  // Any task: what the brief quotes of the output has its secrets redacted.
  const token = `ghp_${'b'.repeat(36)}`;
  const leaky = await f.start(run, 'leaky', { config: { hold: true, finalMessage: PARKED('the deploy') }, flags: ['--force'] });
  await f.ready(leaky);
  await f.command(['park-until', '--', process.execPath, '-e', `console.log('GITHUB_TOKEN=${token}'); console.log('state: done')`], { env: inTask(run, 'leaky') });
  f.release(leaky);
  const woke = await attempt(f, run, 'leaky', 2);
  await f.ready(woke);
  assert.ok(!briefOf(woke).includes(token), 'the brief quotes a token');
  assert.match(briefOf(woke), / {4}GITHUB_TOKEN=\[redacted\]\n {4}state: done/);
  f.release(woke);
  await f.finished(run, 'leaky');
});

test('a sandboxed Codex task with the network on resumes with its sandbox named, which the relay needs for --network-access', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Done.' });
  const run = await f.newRun();
  const boxed = await f.start(run, 'boxed', { agent: 'codex', config: { hold: true, finalMessage: PARKED('the deploy') }, flags: ['--sandbox'] });
  await f.ready(boxed);
  const first = readJson(path.join(boxed.outDir, 'invocation.json')).argv;
  assert.ok(first.includes('--network-access') && !first.includes('--sandbox'), first.join(' '));
  await f.command(['park-until', '--', 'true'], { env: inTask(run, 'boxed') });
  f.release(boxed);
  const second = await attempt(f, run, 'boxed', 2);
  await f.ready(second);
  const argv = readJson(path.join(second.outDir, 'invocation.json')).argv;
  assert.equal(argv[argv.indexOf('--session') + 1], 'fixture-codex');
  assert.ok(argv.includes('--network-access'), argv.join(' '));
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write', argv.join(' '));
  f.release(second);
  await f.finished(run, 'boxed');
});

test('the deadline is checked every interval, and a run that hangs is cut at the time left, whatever --every says', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Done.' });
  const run = await f.newRun();
  const task = await f.start(run, 'slow', { config: { hold: true, finalMessage: PARKED('a job') } });
  await f.ready(task);
  // A condition that would hang for a minute, checked once a day, with a 3-second deadline.
  await f.command(['park-until', '--every', '24h', '--', process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { env: inTask(run, 'slow') });
  recordEdit(task, { for: 3000, until: new Date(Date.now() + 3000).toISOString() });
  f.release(task);
  const second = await attempt(f, run, 'slow', 2);
  await f.ready(second);
  const brief = briefOf(second);
  assert.match(brief, /was not met within the longest wait you gave it \(3s, until .*\): its last run \(.*\) was stopped after \d+s, the most it could take\./);
  f.release(second);
  await f.finished(run, 'slow');
});

test('a condition that exits 0 while the resume is refused stays the wake event until a resume delivers it', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Deployed.' });
  const run = await f.newRun();
  const flag = path.join(f.root, 'ready-once');
  // Exits 0 once, while the flag exists, and removes it; then 1.
  const once = `const fs=require('fs');const f=${JSON.stringify(flag)};if(fs.existsSync(f)){fs.rmSync(f);console.log('ready');process.exit(0)}console.log('not yet');process.exit(1)`;
  const task = await f.start(run, 'deployer', { config: { hold: true, finalMessage: PARKED('the deploy') } });
  await f.ready(task);
  // One slot per run: while the blocker runs, the deployer's resume is refused.
  f.env.AGENT_ORCH_MAX_PARALLEL = '1';
  await f.command(['park-until', '--', process.execPath, '-e', once], { env: inTask(run, 'deployer') });
  recordEdit(task, { every: 1000 });
  const blocker = await f.start(run, 'blocker', { config: { hold: true }, flags: ['--read-only', '--force'] });
  await f.ready(blocker);
  fs.writeFileSync(flag, '');
  f.release(task);
  const check = path.join(attemptDir(run, 'deployer', 1), 'park-check.json');
  const refused = await eventually(() => {
    const c = readQuiet(check);
    return c?.waiting && c.condition?.code === 0 ? c : null;
  }, 'the resume was not refused after the condition was met', SLOW);
  assert.match(refused.waiting, /tasks already running \(limit 1\)/);
  // Later checks keep the event, and do not run the condition again.
  await eventually(() => {
    const c = readQuiet(check);
    return c && c.at !== refused.at && c.waiting ? c : null;
  }, 'the watcher did not check again', SLOW);
  const later = readQuiet(check);
  assert.deepEqual([later.condition.code, later.condition.ranAt], [0, refused.condition.ranAt], 'a later check ran the condition again');
  // Room again: the resume goes through, and says the condition exited 0.
  f.release(blocker);
  await f.finished(run, 'blocker');
  const second = await attempt(f, run, 'deployer', 2);
  await f.ready(second);
  assert.match(briefOf(second), /- Your wake condition `.*` exited 0 \(/);
  assert.match(briefOf(second), / {4}ready/);
  f.release(second);
  await f.finished(run, 'deployer');
});

test('a child that ends after its parent decided to park, before the parent\'s result, still wakes the parent', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Integrated the child.' });
  const run = await f.newRun();
  const lead = await f.start(run, 'lead', { config: { hold: true, finalMessage: PARKED('my child task') } });
  await f.ready(lead);
  const env = inTask(run, 'lead');
  const nested = await f.newRun('nested', env);
  const child = await f.start(nested, 'child', { config: { hold: true }, env });
  await f.ready(child);
  // The child ends while the lead still runs: its notice reaches the lead, unread.
  f.release(child);
  await f.finished(nested, 'child');
  await eventually(() => readQuiet(path.join(child.outDir, 'parent-notice.json'))?.sentAt, 'the child\'s notice was not sent', SLOW);
  // The lead's result comes after the child's: it parks on the unread notice, which wakes it at once.
  f.release(lead);
  const second = await attempt(f, run, 'lead', 2);
  await f.ready(second);
  assert.match(briefOf(second), /- A task you started has finished: its notice is among the messages below/);
  f.release(second);
  await f.finished(run, 'lead');
});

test('redactSecrets hides a quoted value whole, spaces included', () => {
  const out = redactSecrets('{"DB_PASSWORD":"correct horse battery","user":"someone"}\nAPI_KEY: \'two words\'\nSECRET_TOKEN = "a b c" and more');
  for (const gone of ['correct', 'horse', 'battery', 'two words', 'a b c']) assert.ok(!out.includes(gone), `${gone} left in:\n${out}`);
  assert.match(out, /"DB_PASSWORD":"\[redacted\]","user":"someone"/);
  assert.match(out, /API_KEY: '\[redacted\]'/);
});

test('a key block longer than the quoted lines is redacted whole, though its first line falls outside them', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Done.' });
  const run = await f.newRun();
  const task = await f.start(run, 'keyed', { config: { hold: true, finalMessage: PARKED('the deploy') } });
  await f.ready(task);
  // 62 lines of key, then one more: the brief quotes the last 40.
  const print = `console.log('-----BEGIN RSA PRIVATE KEY-----'); for (let i = 0; i < 60; i++) console.log('MIIEowIBAAKCAQEA' + i); console.log('-----END RSA PRIVATE KEY-----'); console.log('deployed')`;
  await f.command(['park-until', '--', process.execPath, '-e', print], { env: inTask(run, 'keyed') });
  f.release(task);
  const second = await attempt(f, run, 'keyed', 2);
  await f.ready(second);
  const brief = briefOf(second);
  assert.ok(!brief.includes('MIIEowIBAAKCAQEA'), 'the brief quotes part of a key');
  assert.match(brief, / {4}\[redacted private key\]\n {4}deployed/);
  f.release(second);
  await f.finished(run, 'keyed');
});

test('the deadline is checked after a fast run that exits non-zero, whatever --every says', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Done.' });
  const run = await f.newRun();
  const task = await f.start(run, 'quick', { config: { hold: true, finalMessage: PARKED('a job') } });
  await f.ready(task);
  await f.command(['park-until', '--every', '24h', '--', process.execPath, '-e', 'process.exit(1)'], { env: inTask(run, 'quick') });
  recordEdit(task, { for: 3000, until: new Date(Date.now() + 3000).toISOString() });
  f.release(task);
  const second = await attempt(f, run, 'quick', 2);
  await f.ready(second);
  assert.match(briefOf(second), /was not met within the longest wait you gave it \(3s, until .*\): its last run \(.*\) exited 1\./);
  f.release(second);
  await f.finished(run, 'quick');
});

test('a parent keeps waiting for a child\'s late notice, and its watcher writes a notice that never comes', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Integrated the child.' });
  const run = await f.newRun();
  const lead = await f.start(run, 'lead', { config: { hold: true, finalMessage: PARKED('my child task') } });
  await f.ready(lead);
  // A child whose finish watcher is gone: started with none, then recorded as the lead's.
  const nested = await f.newRun('nested');
  const child = await f.start(nested, 'child', { config: { hold: true } });
  await f.ready(child);
  const by = { run: run.id, task: 'lead' };
  writeJson(f.taskFile(nested, 'child'), { ...readJson(f.taskFile(nested, 'child')), startedBy: by, attemptStartedBy: { 1: by } });
  fs.appendFileSync(path.join(run.dir, 'tasks', 'lead', 'children.jsonl'), `${JSON.stringify({ run: nested.id, task: 'child', attempt: 1, at: new Date().toISOString() })}\n`);
  f.release(lead);
  await eventually(async () => (await rowOf(f, run, 'lead'))?.phase === 'parked', 'the lead did not park', SLOW);
  // The child ends, and no notice is written for it; as if that were ten minutes ago.
  f.release(child);
  await f.finished(nested, 'child');
  const result = path.join(child.outDir, 'result.json');
  writeJson(result, { ...readJson(result), finishedAt: new Date(Date.now() - 10 * 60000).toISOString() });
  // The lead never ends completed: its watcher writes the late notice, which wakes it.
  const second = await eventually(async () => {
    const row = await rowOf(f, run, 'lead');
    assert.notEqual(row.state, 'completed', 'the lead ended completed while its child\'s notice was late');
    const record = readJson(f.taskFile(run, 'lead'));
    return record.attempt === 2 ? record : null;
  }, 'the late notice did not wake the lead', SLOW);
  await f.ready(second);
  assert.match(briefOf(second), /- A task you started has finished: its notice is among the messages below/);
  assert.ok(readJson(path.join(child.outDir, 'parent-notice.json')).sentAt);
  f.release(second);
  await f.finished(run, 'lead');
});
