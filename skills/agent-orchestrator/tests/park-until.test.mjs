import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine
const PARKED = (what) => [
  `PARKED: waits for ${what}`,
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const inTask = (run, id) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id, AGENT_ORCH_DEPTH: '1' });
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const attemptDir = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
const watchers = (run, id, n) => spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes(' park-watch ') && line.includes(` ${attemptDir(run, id, n)} `)).length;
const parkedRow = (f, run, id, attempt = 1) => eventually(async () => {
  const row = await rowOf(f, run, id);
  return row?.phase === 'parked' && row.attempt === attempt && row.parked.watcher === 'alive' ? row : null;
}, `${id} did not park with a live watcher`, SLOW);
const attempt = (f, run, id, n) => eventually(() => {
  const task = readJson(f.taskFile(run, id));
  return task.attempt === n ? task : null;
}, `${id}'s attempt ${n} did not start`, SLOW);
// A condition the watcher runs: prints two lines, and exits 0 once `file` exists, else 1.
const condition = (file) => [process.execPath, '-e', `console.log('checked the deploy'); console.log('state: ' + (require('fs').existsSync(${JSON.stringify(file)}) ? 'done' : 'running')); process.exit(require('fs').existsSync(${JSON.stringify(file)}) ? 0 : 1)`];
// Check a recorded condition every second: --every refuses less than 30s, so the test edits it.
function everySecond(task) {
  const file = path.join(task.outDir, 'park-until.json');
  writeJson(file, { ...readJson(file), every: 1000 });
}

test('park-until refuses outside a task, in a command task, and with bad options; inside a task it records the condition and says what to do', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const outside = await f.command(['park-until', '--', 'true'], { code: 2 });
  assert.match(outside.stderr, /park-until runs inside a task/);
  const task = await f.start(run, 'deployer', { config: { hold: true } });
  await f.ready(task);
  const env = inTask(run, 'deployer');
  assert.match((await f.command(['park-until'], { code: 2, env })).stderr, /give the command to check after --/);
  assert.match((await f.command(['park-until', '--every', '10s', '--', 'true'], { code: 2, env })).stderr, /--every must be at least 30s/);
  assert.match((await f.command(['park-until', '--for', '25h', '--', 'true'], { code: 2, env })).stderr, /--for must be more than 0 and at most 24h/);
  assert.match((await f.command(['park-until', '--', 'no-such-program-here'], { code: 2, env })).stderr, /cannot run `no-such-program-here`/);
  assert.equal(fs.existsSync(path.join(task.outDir, 'park-until.json')), false);

  const out = await f.command(['park-until', '--why', 'the deploy', '--', 'true', 'arg'], { env });
  assert.match(out.stdout, /recorded a wake condition for attempt 1 of deployer: `true arg` in .*, every 2m, for at most 6h/);
  assert.match(out.stdout, /next: end your turn now, with a final message whose first line is `PARKED: waits for the deploy`.*Do not run the command yourself, and do not sleep, nap or poll/);
  const record = readJson(path.join(task.outDir, 'park-until.json'));
  assert.deepEqual([record.command, record.every, record.for, record.why, record.cwd, record.attempt], [['true', 'arg'], 120000, 6 * 3600000, 'the deploy', f.repo, 1]);
  assert.equal(Date.parse(record.until) - Date.parse(record.at), 6 * 3600000);
  // A later call replaces it; and the task, which nothing started, now has a finish watcher.
  assert.match((await f.command(['park-until', '--every', '30s', '--', 'true'], { env })).stdout, /^replaced the wake condition/);
  assert.ok(fs.existsSync(path.join(task.outDir, 'finish-watcher.json')));
  f.release(task);
  await f.finished(run, 'deployer');

  const cmd = JSON.parse((await f.command(['start', run.id, 'script', '--agent', 'command', '--why', 'A script', '--json', '--', process.execPath, '-e', 'setTimeout(() => {}, 20000)'])).stdout);
  assert.match((await f.command(['park-until', '--', 'true'], { code: 2, env: inTask(run, 'script') })).stderr, /a command task never parks/);
  assert.equal(fs.existsSync(path.join(cmd.outDir, 'park-until.json')), false);
  await f.command(['stop', run.id, 'script']);
});

test('a task parked on a wake condition shows as parked, holds no slot, and resumes its session once the condition exits 0', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Deployed and checked.' });
  const run = await f.newRun();
  const done = path.join(f.root, 'deploy-done');
  const task = await f.start(run, 'deployer', { config: { hold: true, finalMessage: PARKED('the deploy') }, flags: ['--timeout', '45m'] });
  await f.ready(task);
  await f.command(['park-until', '--why', 'the deploy', '--', ...condition(done)], { env: inTask(run, 'deployer') });
  everySecond(task);
  f.release(task);
  const row = await parkedRow(f, run, 'deployer');
  assert.equal(row.state, 'running');
  assert.equal(row.parked.waitsFor, 'waits for the deploy');
  assert.equal(row.parked.condition.why, 'the deploy');
  assert.match((await f.command(['status', run.id])).stdout, /^deployer .*parked.*parked · waits for the deploy/m);
  await f.command(['wait', run.id, 'deployer', '--timeout', '1ms'], { code: 3 });
  // It holds no parallel slot: a task starts beside it with a limit of one.
  const reader = await f.json(['start', run.id, 'reader', '--agent', 'claude', '--tier', 'light', '--why', 'Reads alongside', '--read-only', '--max-parallel', '1', '--brief', f.brief('reader')]);
  await f.finished(run, 'reader');
  assert.ok(reader.pid);

  // The condition runs and fails: the task stays parked, and the check records the exit code.
  const check = await eventually(() => {
    try {
      const c = readJson(path.join(attemptDir(run, 'deployer', 1), 'park-check.json'));
      return c.condition?.code === 1 ? c : null;
    } catch {
      return null;
    }
  }, 'the watcher did not run the condition', SLOW);
  assert.deepEqual(check.events, []);
  assert.equal(readJson(f.taskFile(run, 'deployer')).attempt, 1);

  // It exits 0: the same session resumes, with the relay's options, and a brief that says so.
  fs.writeFileSync(done, '');
  const second = await attempt(f, run, 'deployer', 2);
  await f.ready(second);
  const { argv } = readJson(path.join(second.outDir, 'invocation.json'));
  assert.equal(argv[argv.indexOf('--session') + 1], 'fixture-claude');
  assert.equal(argv[argv.indexOf('--timeout') + 1], '45m', 'the relay keeps its options');
  assert.deepEqual([second.tier, second.attemptReason], ['complex', 'resume']);
  const brief = fs.readFileSync(path.join(second.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /## Your parked watcher woke you/);
  assert.match(brief, /You parked \(waits for the deploy\)\. Since then:/);
  assert.match(brief, /- Your wake condition `.*` exited 0 \(/);
  assert.match(brief, /Your watcher has just run your wake condition, so do not run it again to check/);
  // Its output is data, after the brief.
  assert.match(brief, /## The wake condition's output \(last 40 lines\)\n\n {4}checked the deploy\n {4}state: done/);
  assert.equal(watchers(run, 'deployer', 1), 0);
  f.release(second);
  const final = await f.finished(run, 'deployer');
  assert.equal(final.state, 'completed');
});

test('a PARKED: with nothing to wake it ends completed, and result says why it did not park', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'idler', { config: { finalMessage: PARKED('something') } });
  const row = await f.finished(run, 'idler');
  assert.equal(row.state, 'completed');
  assert.equal(row.parked, undefined);
  assert.match(row.notParked, /recorded no wake condition with `park-until` in this attempt, and no task it started was still running/);
  assert.match((await f.command(['result', run.id, 'idler'])).stdout, /^not parked: its final message says PARKED:, but nothing would wake it/m);
});

test('a PARKED: line in the middle of the final message does not park, and result says so', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'middle', { config: { finalMessage: 'The suite is still running.\n\nPARKED: waits for the suite\n\nStatus so far: tests pass.' } });
  const row = await f.finished(run, 'middle');
  assert.equal(row.state, 'completed');
  assert.equal(row.parked, undefined);
  assert.match(row.notParked, /has a `PARKED:` line, but not as the first line or the last line/);
  assert.match((await f.command(['result', run.id, 'middle'])).stdout, /^not parked: its final message has a `PARKED:` line/m);
});

test('a wake condition that cannot run, or whose longest wait passes, wakes the task with what happened', async (t) => {
  const f = await fixture(t);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Handled.' });
  const run = await f.newRun();

  // The program goes missing after it was recorded.
  const script = path.join(f.root, 'check.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const gone = await f.start(run, 'gone', { config: { hold: true, finalMessage: PARKED('a check') } });
  await f.ready(gone);
  await f.command(['park-until', '--', script], { env: inTask(run, 'gone') });
  everySecond(gone);
  fs.rmSync(script);
  f.release(gone);
  const woke = await attempt(f, run, 'gone', 2);
  await f.ready(woke);
  assert.match(fs.readFileSync(path.join(woke.outDir, 'orch-brief.md'), 'utf8'), /- Your wake condition `.*check\.sh` could not run \(.*\): `.*check\.sh` was not found\./);
  f.release(woke);

  // --for has passed: the task wakes with the last run's exit code.
  const late = await f.start(run, 'late', { config: { hold: true, finalMessage: PARKED('a slow job') } });
  await f.ready(late);
  await f.command(['park-until', '--', process.execPath, '-e', 'console.log("still going"); process.exit(3)'], { env: inTask(run, 'late') });
  const file = path.join(late.outDir, 'park-until.json');
  writeJson(file, { ...readJson(file), every: 1000, for: 2000, until: new Date(Date.now() + 2000).toISOString() });
  f.release(late);
  const expired = await attempt(f, run, 'late', 2);
  await f.ready(expired);
  const brief = fs.readFileSync(path.join(expired.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /was not met within the longest wait you gave it \(2s, until .*\): its last run \(.*\) exited 3\./);
  assert.match(brief, /still going/);
  f.release(expired);
  await f.finished(run, 'late');
});

test('a task parks while a task it started runs, and that task\'s finish wakes it; stop ends a park', async (t) => {
  const f = await fixture(t);
  // The attempts its watcher starts park again, on the condition each records.
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: PARKED('the check') });
  const run = await f.newRun();
  const lead = await f.start(run, 'lead', { config: { hold: true, finalMessage: PARKED('my child task') } });
  await f.ready(lead);
  const env = inTask(run, 'lead');
  const nested = await f.newRun('nested', env);
  const child = await f.start(nested, 'child', { config: { hold: true }, env });
  await f.ready(child);
  // The start recorded the child, and gave the lead, which nothing started, a finish watcher.
  assert.match(fs.readFileSync(path.join(run.dir, 'tasks', 'lead', 'children.jsonl'), 'utf8'), new RegExp(`"run":"${nested.id}","task":"child"`));
  assert.ok(fs.existsSync(path.join(lead.outDir, 'finish-watcher.json')));
  f.release(lead);
  const row = await parkedRow(f, run, 'lead');
  assert.deepEqual([row.parked.waitsFor, row.parked.children], ['waits for my child task', [`${nested.id}/child`]]);
  assert.equal(row.parked.condition, undefined);

  // The child finishes: its notice reaches the parked lead, whose watcher resumes it.
  f.release(child);
  const second = await attempt(f, run, 'lead', 2);
  await f.ready(second);
  const brief = fs.readFileSync(path.join(second.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /- A task you started has finished: its notice is among the messages below/);
  assert.match(brief, /Message from agent:.*\/child, an agent you started/);
  assert.doesNotMatch(brief, /wake condition `/);

  // It parks again, on a condition that never holds; stop ends the park and its watcher.
  await f.command(['park-until', '--', process.execPath, '-e', 'process.exit(1)'], { env });
  everySecond(second);
  f.release(second);
  await parkedRow(f, run, 'lead', 2);
  assert.match((await f.command(['stop', run.id, 'lead'])).stdout, /stopped parked lead/);
  assert.equal(watchers(run, 'lead', 2), 0);
  const stopped = await rowOf(f, run, 'lead');
  assert.deepEqual([stopped.state, stopped.parked], ['stopped', undefined]);
});
