import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture as baseFixture, eventually, readJson, writeJson } from './helpers.mjs';

async function fixture(t) {
  const f = await baseFixture(t);
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  return f;
}

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const argsFor = (f, run, id, flags = []) => ['start', run.id, id, '--agent', 'codex', '--tier', 'standard', '--why', 'Admission fixture', '--read-only', '--brief', f.brief(id, { hold: true }), ...flags];
function child(t, f, args, env = {}) {
  const proc = spawn(process.execPath, [cli, ...args], { cwd: f.repo, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (s) => { stdout += s; });
  proc.stderr.on('data', (s) => { stderr += s; });
  const done = new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', (code) => resolve({ code, stdout, stderr })); });
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await done; });
  return { proc, done, output: () => stdout + stderr };
}

// Observe a real CLI polling interval, then hold its callback while the fixture changes.
function pollGate(f, command) {
  const marker = path.join(f.root, 'poll-ready'), release = `${marker}.release`, preload = path.join(f.root, 'poll.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),original=setTimeout;let seen=false;
if(process.argv[2]===${JSON.stringify(command)})global.setTimeout=(fn,ms,...args)=>{
 if(seen)return original(fn,ms,...args);seen=true;fs.writeFileSync(${JSON.stringify(marker)},'');
 return original(function check(){if(!fs.existsSync(${JSON.stringify(release)}))return original(check,10);fn(...args)},10);
};`);
  return { env: { NODE_OPTIONS: `--require=${preload}` }, ready: () => eventually(() => fs.existsSync(marker)), release: () => fs.writeFileSync(release, '') };
}

test('default machine limit follows physical RAM, rounds and has a floor', async () => {
  const { totalLimit } = await import('../scripts/lib/admission.mjs');
  for (const [gb, limit] of [[16, 12], [32, 24], [2, 4], [10, 8]]) assert.equal(totalLimit('', gb * 1024 ** 3), limit);
  assert.equal(totalLimit('0'), 0);
  assert.throws(() => totalLimit('-1'), /AGENT_ORCH_MAX_TOTAL/);
});

test('machine cap counts both agents across runs, excludes command tasks and leaves refusals untouched', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '2';
  const one = await f.start(a, 'one', { config: { hold: true }, flags: ['--read-only'] }); await f.ready(one);
  const two = await f.start(b, 'two', { agent: 'codex', config: { hold: true }, flags: ['--read-only'] }); await f.ready(two);
  const before = fs.readFileSync(f.taskFile(a, 'one'), 'utf8');
  const refusal = await f.command(argsFor(f, b, 'denied', ['--force']), { code: 7 });
  assert.match(refusal.stderr, /2 agent tasks run on this machine; the limit is 2/);
  assert.match(refusal.stderr, /wait returns when one does.*AGENT_ORCH|AGENT_ORCH_MAX_TOTAL.*wait returns when one does/s);
  assert.equal(fs.existsSync(path.dirname(f.taskFile(b, 'denied'))), false);
  assert.equal(fs.readFileSync(f.taskFile(a, 'one'), 'utf8'), before);
  const command = JSON.parse((await f.command(['start', a.id, 'command', '--agent', 'command', '--why', 'No model', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'])).stdout);
  const machine = (await f.json(['agents'])).machine;
  assert.equal(machine.running, 2); assert.equal(machine.limit, 2); assert.equal(machine.availableBytes, 9999999999);
  await f.command(['stop', a.id, 'command']);
  assert.ok(command.pid);
  f.release(one); await f.finished(a, 'one');
  const next = await f.json(argsFor(f, b, 'next')); await f.ready(next);
  assert.equal((await f.json(['agents'])).machine.running, 2);
});

test('explicit memory guard with count disabled refuses low memory and critical pressure', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  f.env.AGENT_ORCH_MAX_TOTAL = '0';
  f.env.AGENT_ORCH_MIN_FREE_AGENT = '1.5GB';
  for (const [id, env, pattern] of [
    ['low', { AGENT_ORCH_HEAVY_FREE_BYTES: '1499999999' }, /available memory.*minimum.*AGENT_ORCH_MIN_FREE_AGENT/],
    ['critical', { AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '4' }, /memory pressure is critical \(level 4\)/],
    ['custom', { AGENT_ORCH_MIN_FREE_AGENT: '12GB' }, /minimum is 12.00GB/],
  ]) {
    const result = await f.command(argsFor(f, run, id), { code: 7, env });
    assert.match(result.stderr, pattern);
    assert.equal(fs.existsSync(f.taskFile(run, id)), false);
  }
  const okay = await f.json(argsFor(f, run, 'boundary'), { env: { AGENT_ORCH_HEAVY_FREE_BYTES: '1500000000', AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '2' } });
  await f.ready(okay);
  assert.equal((await f.json(['agents'])).machine.limit, 0);
});

test('start --wait times out with 7 and no task, or starts when another run releases its place', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const held = await f.start(a, 'held', { config: { hold: true } }); await f.ready(held);
  const timeout = await f.command(argsFor(f, b, 'timeout', ['--wait', '1ms']), { code: 7 });
  assert.match(timeout.stderr, /limit is 1/);
  assert.equal(fs.existsSync(f.taskFile(b, 'timeout')), false);
  const gate = pollGate(f, 'start');
  const pending = child(t, f, [...argsFor(f, b, 'later', ['--wait']), '--json'], gate.env);
  await gate.ready();
  assert.match(pending.output(), /waiting:.*limit is 1/);
  f.release(held); await f.finished(a, 'held'); gate.release();
  const result = await pending.done; assert.equal(result.code, 0, result.stderr);
  const task = JSON.parse(result.stdout); await f.ready(task);
  assert.equal(task.attempt, 1);
});

test('start --wait rereads memory before starting', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  f.env.AGENT_ORCH_MIN_FREE_AGENT = '1.5GB';
  const gate = pollGate(f, 'start');
  const preload = path.join(f.root, 'memory.cjs'), free = path.join(f.root, 'free');
  fs.writeFileSync(free, '1');
  fs.writeFileSync(preload, `const fs=require('fs');
const original=fs.readdirSync;fs.readdirSync=function(...args){process.env.AGENT_ORCH_HEAVY_FREE_BYTES=fs.readFileSync(${JSON.stringify(free)},'utf8');return original.apply(this,args)};`);
  const pending = child(t, f, [...argsFor(f, run, 'memory', ['--wait', '10s']), '--json'], { NODE_OPTIONS: `${gate.env.NODE_OPTIONS} --require=${preload}` });
  await gate.ready(); fs.writeFileSync(free, '9999999999'); gate.release();
  const result = await pending.done; assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /available memory/);
});

test('simultaneous starts across runs cannot both take the last machine place', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const first = child(t, f, [...argsFor(f, a, 'one'), '--json']);
  const second = child(t, f, [...argsFor(f, b, 'two'), '--json']);
  const results = await Promise.all([first.done, second.done]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 7]);
  const task = JSON.parse(results.find((r) => r.code === 0).stdout); await f.ready(task);
  assert.equal((await f.json(['agents'])).machine.running, 1);
});

test('a dead admission lock holder never keeps its place', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const entered = path.join(f.root, 'entered'), preload = path.join(f.root, 'kill-holder.cjs');
  // Stop after the holder publishes its ticket and enters admission, before it creates a task.
  fs.writeFileSync(preload, `const fs=require('fs'),original=fs.readdirSync;fs.readdirSync=function(dir,...args){
if(String(dir)===${JSON.stringify(path.join(f.state, 'runs'))}){fs.writeFileSync(${JSON.stringify(entered)},'');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)}return original.call(this,dir,...args)};`);
  const holder = child(t, f, argsFor(f, a, 'holder'), { NODE_OPTIONS: `--require=${preload}` });
  await eventually(() => fs.existsSync(entered));
  const locks = path.join(f.state, 'admission', 'locks');
  assert.equal(fs.readdirSync(locks).length, 1);
  holder.proc.kill('SIGKILL'); await holder.done;
  const next = await f.json(argsFor(f, b, 'next')); await f.ready(next);
  assert.deepEqual(fs.readdirSync(locks), []);
  assert.equal(fs.existsSync(f.taskFile(a, 'holder')), false);
});

test('dispatch keeps machine-blocked tasks ready and follow starts them after another run finishes', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const held = await f.start(a, 'held', { config: { hold: true } }); await f.ready(held);
  const plan = path.join(f.root, 'plan.json');
  writeJson(plan, { goal: 'Admission', tasks: [{ id: 'later', goal: 'Later', type: 'implement', owns: [], dependsOn: [], agent: 'codex', tier: 'standard', why: 'Fixture', readOnly: true, brief: f.brief('later', { hold: true }) }] });
  await f.command(['plan', b.id, plan]);
  const wave = await f.json(['dispatch', b.id]);
  assert.deepEqual(wave.failed, []); assert.deepEqual(wave.started, []);
  assert.equal(wave.waitingForMachine[0].id, 'later');
  assert.match(wave.waitingForMachine[0].reason, /limit is 1/);
  assert.equal(fs.existsSync(f.taskFile(b, 'later')), false);
  const gate = pollGate(f, 'dispatch');
  const following = child(t, f, ['dispatch', b.id, '--follow', '--json'], gate.env);
  await gate.ready(); f.release(held); await f.finished(a, 'held'); gate.release();
  await eventually(() => fs.existsSync(f.taskFile(b, 'later')));
  const task = readJson(f.taskFile(b, 'later')); await f.ready(task); f.release(task);
  const result = await following.done; assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).started[0].id, 'later');
});

test('retry replaces its attempt at a full machine without counting the old relay', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  await f.start(a, 'retry', { flags: ['--read-only'], config: { status: 'failed', error: 'HTTP 503 provider unavailable' } });
  await f.finished(a, 'retry');
  const held = await f.start(b, 'held', { config: { hold: true } }); await f.ready(held);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true });
  await f.command(['wait', a.id, '--timeout', '1ms'], { code: 3 });
  const replacement = readJson(f.taskFile(a, 'retry')); await f.ready(replacement);
  assert.equal(replacement.attempt, 2);
  assert.equal((await f.json(['agents'])).machine.running, 2);
  f.release(replacement); await f.finished(a, 'retry');
  assert.equal((await f.json(['agents'])).machine.running, 1);
});

test('interrupt resumes at the count limit and counts only its replacement relay', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const first = await f.start(run, 'worker', { config: { hold: true } }); await f.ready(first);
  await f.command(['send', run.id, 'worker', 'Continue with the update.', '--steer'], { env: { FAKE_RELAY_CONFIG: JSON.stringify({ hold: true }) } });
  const replacement = readJson(f.taskFile(run, 'worker')); await f.ready(replacement);
  assert.equal(replacement.attempt, 2);
  assert.equal((await f.json(['agents'])).machine.running, 1);
});

test('park watcher resumes at a full machine; the parked watcher itself holds no place', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  const data = path.join(f.root, 'github.json');
  const pr = { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main', baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] };
  writeJson(data, pr);
  fs.writeFileSync(path.join(f.root, 'bin', 'gh'), `#!${process.execPath}
const fs=require('fs');if(process.argv[2]==='pr')console.log(fs.readFileSync(${JSON.stringify(data)},'utf8'));
else console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]},comments:{totalCount:0,nodes:[]},reviews:{totalCount:0,nodes:[]}}}}}));`, { mode: 0o755 });
  f.env.AGENT_ORCH_MAX_TOTAL = '1'; f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true });
  await f.json(['start', a.id, 'sit', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Fixture babysitter', '--brief', f.brief('sit', { finalMessage: 'PARKED: PR #42 waits for human review\n```orch-result\n{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n```' })]);
  await eventually(async () => (await f.json(['status', a.id])).tasks.find((task) => task.id === 'sit')?.phase === 'parked', 'did not park');
  assert.equal((await f.json(['agents'])).machine.running, 0);
  const held = await f.start(b, 'held', { config: { hold: true } }); await f.ready(held);
  await f.command(['send', a.id, 'sit', 'Please check the requested update.']);
  await eventually(() => readJson(f.taskFile(a, 'sit')).attempt === 2, 'watcher did not resume', 20000);
  const replacement = readJson(f.taskFile(a, 'sit')); await f.ready(replacement);
  assert.equal((await f.json(['agents'])).machine.running, 2);
});

test('a resume that dies after spawning remains counted through its claim', async (t) => {
  const f = await fixture(t), a = await f.newRun('a'), b = await f.newRun('b');
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  await f.start(a, 'worker'); await f.finished(a, 'worker');
  const entered = path.join(f.root, 'spawned'), preload = path.join(f.root, 'orphan.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),original=fs.renameSync;fs.renameSync=function(from,to){
if(String(to)===${JSON.stringify(f.taskFile(a, 'worker'))}){fs.writeFileSync(${JSON.stringify(entered)},'');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)}return original.call(this,from,to)};`);
  const resumer = child(t, f, argsFor(f, a, 'worker'), { NODE_OPTIONS: `--require=${preload}` });
  await eventually(() => fs.existsSync(entered));
  resumer.proc.kill('SIGKILL'); await resumer.done;
  const refused = await f.command(argsFor(f, b, 'denied'), { code: 7 });
  assert.match(refused.stderr, /1 agent tasks run on this machine; the limit is 1/);
  assert.equal((await f.json(['agents'])).machine.running, 1);
  // Stop adopts the orphan from the claim and shuts down exactly that fixture relay.
  await f.command(['stop', a.id, 'worker']);
});

// Review regressions use child-only preloads to stop at the exact operation under test.
function preload(f, name, code) {
  const file = path.join(f.root, `${name}.cjs`);
  fs.writeFileSync(file, code);
  return { NODE_OPTIONS: `--require=${file}` };
}

function planned(f, run, id = 'planned') {
  const file = path.join(f.root, 'plan.json');
  writeJson(file, { goal: 'Admission review', tasks: [{ id, goal: 'Inspect', type: 'research', owns: [], dependsOn: [], agent: 'codex', tier: 'standard', why: 'Fixture', readOnly: true, brief: f.brief(id, { hold: true }) }] });
  return f.command(['plan', run.id, file]);
}

test('review: unreadable process start time skips the count check instead of crashing start or dispatch', async (t) => {
  const f = await fixture(t), run = await f.newRun(), second = await f.newRun();
  f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const env = preload(f, 'no-start-time', `const cp=require('child_process'),original=cp.spawnSync;cp.spawnSync=function(bin,args,...rest){if(bin==='ps'&&args.includes('lstart='))return {status:1,stdout:'',stderr:''};return original.call(this,bin,args,...rest)};require('module').syncBuiltinESMExports();`);
  const started = await f.command([...argsFor(f, run, 'one'), '--json'], { env });
  assert.match(started.stderr, /cannot read this process's start time.*starting without/);
  await f.ready(JSON.parse(started.stdout));
  await planned(f, second);
  const wave = await f.json(['dispatch', second.id], { env });
  // Dispatch preflight can defer a genuinely full machine; it must not crash the wave.
  assert.deepEqual(wave.failed, []);
  f.release(JSON.parse(started.stdout)); await f.finished(run, 'one');
  const next = await f.command(['dispatch', second.id], { env });
  assert.match(next.stdout, /started planned/);
  assert.match(next.stderr, /cannot read this process's start time/);
});

test('review: unknown memory skips only that check, while measured zero still refuses', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  f.env.AGENT_ORCH_MAX_TOTAL = '2';
  const env = { AGENT_ORCH_HEAVY_FREE_BYTES: 'unknown' };
  const result = await f.command([...argsFor(f, run, 'unknown'), '--json'], { env });
  assert.match(result.stderr, /available memory could not be read/);
  assert.equal((await f.json(['agents'], { env })).machine.availableBytes, null);
  await f.command(argsFor(f, run, 'zero'), { code: 7, env: { AGENT_ORCH_HEAVY_FREE_BYTES: '0' } });
});

test('review: disabling admission restores legacy starts unless memory is explicitly configured', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  f.env.AGENT_ORCH_HEAVY_FREE_BYTES = '0'; f.env.AGENT_ORCH_HEAVY_PRESSURE_LEVEL = '4';
  await f.json(argsFor(f, run, 'legacy'));
  assert.equal(fs.existsSync(path.join(f.state, 'admission')), false);
  await f.command(argsFor(f, run, 'explicit'), { code: 7, env: { AGENT_ORCH_MIN_FREE_AGENT: '1.5GB' } });
});

test('review: invalid starts keep their own errors at capacity, including with --wait', async (t) => {
  const f = await fixture(t), run = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const task = await f.start(run, 'held', { config: { hold: true }, flags: ['--read-only'] }); await f.ready(task);
  const missing = await f.command(['start', run.id, 'bad', '--agent', 'codex', '--why', 'fixture', '--wait', '0'], { code: 2 });
  assert.match(missing.stderr, /--brief FILE is required/);
  const badAgent = await f.command(['start', run.id, 'bad', '--agent', 'invalid'], { code: 2 });
  assert.match(badAgent.stderr, /unsupported agent/);
  const running = await f.command(argsFor(f, run, 'held'), { code: 1 });
  assert.match(running.stderr, /already running/);
});

test('review: start --wait checks capacity again at its deadline', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const held = await f.start(a, 'held', { config: { hold: true } }); await f.ready(held);
  const gate = pollGate(f, 'start'), clock = path.join(f.root, 'clock'), epoch = Date.now(); fs.writeFileSync(clock, String(epoch));
  const env = preload(f, 'clock', `const fs=require('fs');Date.now=()=>Number(fs.readFileSync(${JSON.stringify(clock)},'utf8'));`);
  const pending = child(t, f, [...argsFor(f, b, 'at-deadline', ['--wait', '3s']), '--json'], { NODE_OPTIONS: `${gate.env.NODE_OPTIONS} ${env.NODE_OPTIONS}` });
  await gate.ready(); f.release(held); await f.finished(a, 'held'); fs.writeFileSync(clock, String(epoch + 3000)); gate.release();
  const result = await pending.done; assert.equal(result.code, 0, result.stderr);
});

test('review: start --wait returns exit 6 for a new message without starting', async (t) => {
  const f = await fixture(t), run = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const held = await f.start(run, 'parent', { config: { hold: true } }); await f.ready(held);
  const gate = pollGate(f, 'start');
  const pending = child(t, f, argsFor(f, run, 'later', ['--wait', '10s']), { ...gate.env, AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'parent' });
  await gate.ready(); await f.command(['send', run.id, 'parent', 'Handle this message first.']); gate.release();
  const result = await pending.done; assert.equal(result.code, 6, result.stderr);
  assert.match(result.stderr, /Handle this message first/); assert.equal(fs.existsSync(f.taskFile(run, 'later')), false);
});

test('review: a live interrupt keeps its place throughout the stopped-relay gap', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const worker = await f.start(a, 'worker', { config: { hold: true } }); await f.ready(worker);
  const entered = path.join(f.root, 'gap'), release = `${entered}.release`;
  const env = preload(f, 'interrupt-gap', `if(process.argv[1].endsWith('/steer.mjs')){const fs=require('fs'),write=fs.writeFileSync;fs.writeFileSync=function(file,data,...rest){const result=write.call(this,file,data,...rest);if(String(file).includes('resume-')&&String(data).includes('"stopped": true')){write.call(this,${JSON.stringify(entered)},'');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return result}}`);
  const sender = child(t, f, ['send', a.id, 'worker', 'Resume with this message.', '--steer'], { ...env, FAKE_RELAY_CONFIG: JSON.stringify({ hold: true }) });
  await eventually(() => fs.existsSync(entered), 'interrupt did not enter the gap');
  try {
    assert.equal((await f.json(['agents'])).machine.running, 1);
    await f.command(argsFor(f, b, 'outsider'), { code: 7 });
  } finally { fs.writeFileSync(release, ''); }
  assert.equal((await sender.done).code, 0);
  assert.equal(readJson(f.taskFile(a, 'worker')).attempt, 2);
  assert.equal((await f.json(['agents'])).machine.running, 1);
});

// Pause the count read after the ticket is published, forcing actual lock overlap.
function heldCount(f, name) {
  const entered = path.join(f.root, `${name}-entered`), release = `${entered}.release`;
  const env = preload(f, name, `const fs=require('fs'),read=fs.readdirSync;let held=false;fs.readdirSync=function(dir,...args){if(!held&&String(dir)===${JSON.stringify(path.join(f.state, 'runs'))}){held=true;fs.writeFileSync(${JSON.stringify(entered)},'');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return read.call(this,dir,...args)};`);
  return { env, ready: () => eventually(() => fs.existsSync(entered)), release: () => fs.writeFileSync(release, '') };
}

test('review: overlapping starts publish two tickets and only one takes the last place', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const hold = heldCount(f, 'overlap'); const one = child(t, f, argsFor(f, a, 'one'), hold.env); await hold.ready();
  const two = child(t, f, argsFor(f, b, 'two'));
  await eventually(() => fs.readdirSync(path.join(f.state, 'admission/locks')).filter((n) => !n.includes('.')).length === 2);
  assert.equal(fs.existsSync(f.taskFile(b, 'two')), false); hold.release();
  assert.equal((await one.done).code, 0); assert.equal((await two.done).code, 7);
});

test('review: a stopped holder is revoked and rechecks capacity when continued', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const hold = heldCount(f, 'stopped'); const one = child(t, f, argsFor(f, a, 'one'), hold.env); await hold.ready();
  one.proc.kill('SIGSTOP');
  try {
    const two = await f.json(argsFor(f, b, 'two')); await f.ready(two);
    assert.equal(fs.existsSync(f.taskFile(a, 'one')), false);
  } finally { hold.release(); one.proc.kill('SIGCONT'); }
  assert.equal((await one.done).code, 7);
});

test('review: a lock deadline falls back once rather than hanging a start', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const hold = heldCount(f, 'deadline'); const one = child(t, f, argsFor(f, a, 'one'), hold.env); await hold.ready();
  try {
    const result = await f.command(argsFor(f, b, 'two', ['--wait', '0']));
    assert.match(result.stderr, /lock wait timed out.*starting without/);
  } finally { hold.release(); }
  assert.equal((await one.done).code, 7);
});

test('review: slow pull-request validation holds no machine lock', async (t) => {
  const f = await fixture(t), a = await f.newRun(), b = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1';
  const entered = path.join(f.root, 'gh-entered'), release = `${entered}.release`;
  fs.writeFileSync(path.join(f.root, 'bin/gh'), `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(entered)},'');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(JSON.stringify({number:42,url:'https://github.com/example/repo/pull/42',state:'OPEN',isDraft:false}));`, { mode: 0o755 });
  const sitter = child(t, f, ['start', a.id, 'sit', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'fixture', '--brief', f.brief('sit')]);
  await eventually(() => fs.existsSync(entered));
  try {
    assert.equal(fs.existsSync(path.join(f.state, 'admission/locks')), false);
    await f.json(argsFor(f, b, 'other'));
  } finally { fs.writeFileSync(release, ''); }
  assert.equal((await sitter.done).code, 7);
});

test('review: dispatch follow reports limit kinds rather than every memory fluctuation', async (t) => {
  const f = await fixture(t), run = await f.newRun(); f.env.AGENT_ORCH_MAX_TOTAL = '1'; await planned(f, run);
  const marker = path.join(f.root, 'polls'), release = path.join(f.root, 'allow');
  const env = preload(f, 'fluctuating-memory', `if(process.argv[2]==='dispatch'){const fs=require('fs'),timeout=setTimeout;let n=0;process.env.AGENT_ORCH_HEAVY_FREE_BYTES='100000000';global.setTimeout=(fn,ms,...args)=>{if(ms!==1000)return timeout(fn,ms,...args);fs.writeFileSync(${JSON.stringify(marker)},String(++n));return timeout(function tick(){if(n>=3&&!fs.existsSync(${JSON.stringify(release)}))return timeout(tick,10);process.env.AGENT_ORCH_HEAVY_FREE_BYTES=n>=3?'9999999999':String(100000000+n*20000000);fn(...args)},10)}}`);
  const following = child(t, f, ['dispatch', run.id, '--follow'], env);
  await eventually(() => fs.existsSync(marker) && Number(fs.readFileSync(marker)) >= 3);
  assert.equal(following.output().match(/ready, waiting planned:/g)?.length, 1);
  fs.writeFileSync(release, ''); await eventually(() => fs.existsSync(f.taskFile(run, 'planned')));
  const task = readJson(f.taskFile(run, 'planned')); await f.ready(task); f.release(task);
  assert.equal((await following.done).code, 0);
});
