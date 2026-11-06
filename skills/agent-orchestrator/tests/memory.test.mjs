import './memory-reclaim.test.mjs';
import './memory-heavy.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture as baseFixture, eventually, readJson, writeJson } from './helpers.mjs';
import { parseMemory, memoryThreshold } from '../scripts/lib/heavy.mjs';
import { daemonDirectory } from '../scripts/lib/reclaim.mjs';
import { commandTree, isHeavyWrapper } from '../scripts/lib/steer.mjs';
import { CLI_PATH } from '../scripts/lib/config.mjs';

async function fixture(t) {
  const f = await baseFixture(t);
  Object.assign(f.env, { AGENT_ORCH_HEAVY_RAMP_MS: '0', AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '0' });
  return f;
}

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
function child(t, bin, args, options) {
  const proc = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.output = ''; proc.errors = '';
  proc.stdout.on('data', (s) => { proc.output += s; });
  proc.stderr.on('data', (s) => { proc.errors += s; });
  proc.done = new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { proc.cleanupChild?.(); if (proc.exitCode === null && proc.signalCode === null) proc.kill(proc.cleanupSignal || 'SIGKILL'); await proc.done; });
  return proc;
}
const holderScript = `const fs=require('fs');const [ready,release]=process.argv.slice(1);fs.watchFile(release,{interval:20},()=>{if(fs.existsSync(release)){fs.unwatchFile(release);process.exit(0)}});fs.writeFileSync(ready,'');`;
function heavy(t, f, name, env = {}) {
  const ready = path.join(f.root, `${name}.ready`), release = path.join(f.root, `${name}.release`);
  const proc = child(t, process.execPath, [cli, 'heavy', '--label', name, '--', process.execPath, '-e', holderScript, ready, release], { cwd: f.repo, env: { ...f.env, AGENT_ORCH_HEAVY_FREE_BYTES: '0', ...env } });
  proc.cleanupSignal = 'SIGTERM';
  return { proc, ready: () => eventually(() => {
    const row = laneRows(f).find((r) => r.label === name && r.state === 'running' && r.childPid);
    if (!row || !fs.existsSync(ready)) return false;
    proc.cleanupChild = () => {
      const command = spawnSync('ps', ['-p', String(row.childPid), '-o', 'command='], { encoding: 'utf8' }).stdout || '';
      if (command.includes(ready)) { try { process.kill(row.childPid, 'SIGKILL'); } catch {} }
    };
    return true;
  }, `${name} did not run: ${proc.errors}`), release: () => fs.writeFileSync(release, '') };
}
function laneRows(f) {
  try { return fs.readdirSync(path.join(f.state, 'heavy')).filter((n) => /^\d+-.*\.json$/.test(n)).map((n) => readJson(path.join(f.state, 'heavy', n))); } catch { return []; }
}
async function queued(f, name) { return eventually(() => laneRows(f).find((r) => r.label === name && r.state === 'waiting'), `${name} did not queue`); }

// Restrict the real ps snapshot to fixture PIDs. Reclaim must never see real user daemons.
function processScope(f) {
  const bin = path.join(f.root, 'bin'), list = path.join(f.root, 'pids');
  fs.mkdirSync(bin); fs.writeFileSync(list, '');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nif [ "$1" = "-axww" ]; then\n shift\n exec /bin/ps -ww -p "$(cat '${list}')" "$@"\nfi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const pids = [];
  return { env: { PATH: `${bin}:${f.env.PATH}` }, add: (pid) => { pids.push(pid); fs.writeFileSync(list, pids.join(',')); } };
}
async function daemon(t, f, scope, dir, ignoreTerm = false) {
  const ready = path.join(f.root, `daemon-${Math.random()}.ready`);
  const script = `process.title=${JSON.stringify(`pantsd [${dir}]`)};${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}require('fs').writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},10000);`;
  const proc = child(t, process.execPath, ['-e', script, 'padding'.repeat(100)], { cwd: f.root, env: f.env });
  scope.add(proc.pid);
  await eventually(() => fs.existsSync(ready), 'daemon did not start');
  return proc;
}

test('memory readings omit compressed pages and accept explicit thresholds', () => {
  assert.equal(parseMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages purgeable: 3.\nPages speculative: 7.\nPages occupied by compressor: 99999.', 'darwin'), 17 * 16384);
  assert.equal(parseMemory('MemFree: 10 kB\nInactive: 20 kB\nSReclaimable: 3 kB\nSwapCached: 999 kB\nMemAvailable: 999 kB', 'linux'), 999 * 1024);
  assert.equal(parseMemory('invalid', 'darwin'), 0);
  assert.equal(memoryThreshold('2.5GB'), 2500000000);
  assert.equal(memoryThreshold('1GiB'), 1073741824);
  assert.throws(() => memoryThreshold('invalid'));
  assert.equal(daemonDirectory('java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.0'), null);
  assert.equal(daemonDirectory('sh -c "pantsd [/tmp/foo]"'), null);
  assert.equal(daemonDirectory('java com.google.devtools.build.lib.bazel.Bazel --workspace_directory=/tmp/example'), null);
  assert.equal(daemonDirectory('sh -c java com.google.devtools.build.lib.bazel.Bazel --workspace_directory=/tmp/example'), null);
  assert.equal(daemonDirectory('java com.google.devtools.build.lib.bazel.Bazel --workspace_directory=/tmp/with spaces'), null);
});

test('heavy passes exit status and admits the first command under low memory', async (t) => {
  const f = await fixture(t);
  const result = await f.command(['heavy', '--label', 'exit fixture', '--', process.execPath, '-e', 'process.stdout.write("inherited output");process.exit(23)'], { code: 23, env: { AGENT_ORCH_HEAVY_FREE_BYTES: '0' } });
  assert.match(result.stdout, /inherited output/);
  assert.equal(laneRows(f).length, 0);
  await f.command(['heavy', '--', 'missing-heavy-command-fixture'], { code: 127 });
  assert.equal(laneRows(f).length, 0);
});

test('heavy queues FIFO at low memory and admits concurrent commands with room', async (t) => {
  const f = await fixture(t);
  const first = heavy(t, f, 'first'); await first.ready();
  const second = heavy(t, f, 'second'); await queued(f, 'second');
  const third = heavy(t, f, 'third'); await queued(f, 'third');
  first.release(); await first.proc.done; await second.ready();
  assert.equal(laneRows(f).find((r) => r.label === 'third').state, 'waiting');
  second.release(); await second.proc.done; await third.ready();
  const fourth = heavy(t, f, 'fourth', { AGENT_ORCH_HEAVY_FREE_BYTES: '9999999999' }); await fourth.ready();
  assert.equal(laneRows(f).filter((r) => r.state === 'running').length, 2);
  third.release(); fourth.release(); await Promise.all([third.proc.done, fourth.proc.done]);
});

test('heavy serializes simultaneous arrivals and discards a crashed lock owner', async (t) => {
  const f = await fixture(t);
  const dead = child(t, process.execPath, ['-e', ''], { cwd: f.repo, env: f.env }); await dead.done;
  const locks = path.join(f.state, 'heavy', 'locks'); fs.mkdirSync(locks, { recursive: true });
  const abandoned = path.join(locks, `${dead.pid}-dead`); fs.symlinkSync('choosing', abandoned);
  const first = heavy(t, f, 'first'); await first.ready();
  assert.throws(() => fs.lstatSync(abandoned), { code: 'ENOENT' });
  const arrivals = ['a', 'b', 'c'].map((name) => [name, heavy(t, f, name)]);
  await Promise.all(arrivals.map(([name]) => queued(f, name)));
  const order = laneRows(f).filter((r) => r.state === 'waiting').sort((a, b) => a.ticket - b.ticket);
  assert.equal(new Set(order.map((r) => r.ticket)).size, 3);
  first.release(); await first.proc.done;
  for (const row of order) {
    const item = arrivals.find(([name]) => name === row.label)[1];
    await item.ready();
    assert.equal(laneRows(f).filter((r) => r.state === 'running').length, 1);
    item.release(); await item.proc.done;
  }
});

test('heavy recovers a crashed wrapper and removes its slot', async (t) => {
  const f = await fixture(t);
  const first = heavy(t, f, 'crash'); await first.ready();
  const commandPid = laneRows(f)[0].childPid;
  const next = heavy(t, f, 'next'); await queued(f, 'next');
  first.proc.kill('SIGKILL');
  process.kill(commandPid, 0);
  first.release(); await first.proc.done;
  await next.ready(); next.release(); await next.proc.done;
  assert.equal(laneRows(f).length, 0);
});

test('heavy waiting exits 6 on a new message, without running the command', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const task = await f.start(run, 'worker', { config: { hold: true } }); await f.ready(task);
  const first = heavy(t, f, 'occupied'); await first.ready();
  const waiter = heavy(t, f, 'message', { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'worker' }); await queued(f, 'message');
  await f.command(['send', run.id, 'worker', 'Handle this message now']);
  assert.equal((await waiter.proc.done).code, 6);
  assert.match(waiter.proc.errors, /message waiting/);
  assert.equal(laneRows(f).some((r) => r.label === 'message'), false);
  first.release(); await first.proc.done;
});

test('reclaim dry run, exact PID stop, SIGKILL fallback and off switch', async (t) => {
  const f = await fixture(t), scope = processScope(f), dir = path.join(f.root, 'workspace with spaces'); fs.mkdirSync(dir);
  const proc = await daemon(t, f, scope, dir, true);
  const dry = await f.json(['reclaim', '--dry-run'], { env: scope.env });
  assert.equal(dry.daemons[0].action, 'would-stop'); assert.ok(dry.bytes > 0); process.kill(proc.pid, 0);
  const off = await f.json(['reclaim'], { env: { ...scope.env, AGENT_ORCH_RECLAIM: 'off' } });
  assert.equal(off.disabled, true); process.kill(proc.pid, 0);
  const stopped = await f.json(['reclaim'], { env: scope.env });
  assert.equal(stopped.daemons[0].action, 'stopped'); assert.equal(stopped.daemons[0].signal, 'SIGKILL');
  assert.ok(stopped.bytes > 0); await proc.done;
});

test('reclaim retains a daemon with a live owner in a nested working directory', async (t) => {
  const f = await fixture(t), scope = processScope(f), dir = path.join(f.root, 'workspace'), nested = path.join(dir, 'child'); fs.mkdirSync(nested, { recursive: true });
  const proc = await daemon(t, f, scope, dir);
  const ready = path.join(f.root, 'owner.ready');
  const owner = child(t, process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},10000)`], { cwd: nested, env: f.env }); scope.add(owner.pid);
  await eventually(() => fs.existsSync(ready));
  const kept = await f.json(['reclaim'], { env: scope.env });
  assert.equal(kept.daemons[0].action, 'kept'); assert.ok(kept.daemons[0].owners.includes(owner.pid));
  owner.kill('SIGTERM'); await owner.done;
  const stopped = await f.json(['reclaim'], { env: scope.env }); assert.equal(stopped.daemons[0].action, 'stopped'); await proc.done;
});

test('reclaim protects a running task even if its relay cwd differs', async (t) => {
  const f = await fixture(t), scope = processScope(f), run = await f.newRun();
  const task = await f.start(run, 'worker', { config: { hold: true } }); await f.ready(task); scope.add(task.pid);
  const dir = path.join(f.root, 'workspace'); fs.mkdirSync(dir);
  writeJson(f.taskFile(run, 'worker'), { ...readJson(f.taskFile(run, 'worker')), cd: dir });
  const proc = await daemon(t, f, scope, dir);
  const kept = await f.json(['reclaim'], { env: scope.env });
  assert.equal(kept.daemons[0].reason, 'running task');
  await f.command(['close', run.id, 'worker'], { env: scope.env });
  process.kill(proc.pid, 0); // A task without a managed worktree cannot reclaim its checkout.
  await f.command(['reclaim'], { env: scope.env }); await proc.done;
});

for (const action of ['result', 'accept', 'integrate', 'cleanup']) {
  test(`${action} reclaims its worktree while another task runs`, async (t) => {
    const f = await fixture(t), scope = processScope(f), run = await f.newRun();
    const wt = await f.json(['worktree', run.id, 'worker', '--no-prep']);
    await f.start(run, 'worker'); await f.finished(run, 'worker');
    const other = await f.start(run, 'other', { config: { hold: true } }); await f.ready(other); scope.add(other.pid);
    if (action === 'integrate') await f.command(['accept', run.id, 'worker'], { env: { AGENT_ORCH_RECLAIM: 'off' } });
    const proc = await daemon(t, f, scope, wt.path);
    await f.command([action, run.id, ...(action === 'cleanup' ? [] : ['worker'])], { env: scope.env });
    await eventually(() => proc.exitCode !== null || proc.signalCode !== null, `${action} did not reclaim the daemon`);
    assert.equal((await f.json(['status', run.id])).tasks.find((r) => r.id === 'other').state, 'running');
  });
}

test('dashboard exposes heavy lane counts without changing state shape', async (t) => {
  const f = await fixture(t), board = await f.dashboard();
  const first = heavy(t, f, 'running'); await first.ready();
  const second = heavy(t, f, 'waiting'); await queued(f, 'waiting');
  assert.deepEqual(await board.json('/api/heavy'), { running: 1, waiting: 1 });
  const response = await board.get('/api/state');
  assert.deepEqual(JSON.parse(response.headers.get('x-orch-heavy')), { running: 1, waiting: 1 });
  assert.ok(Array.isArray(await response.json()));
  first.release(); await first.proc.done; await second.ready(); second.release(); await second.proc.done;
});

test('start rejects reserved environment keys and applies ordinary values', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const config = path.join(f.root, 'config');
  const blocked = ['AGENT_ORCH_HOME', 'AGENT_ORCH_TASK', 'AGENT_ORCH_ANY_FUTURE_KEY', 'AGENT_ORCH_HEAVY_ACTIVE', 'XDG_STATE_HOME', 'HOME', 'PATH', 'NODE_OPTIONS'];
  writeJson(path.join(config, 'agent-orchestrator', 'agent-env.json'), { MEMORY_FIXTURE: 'limited', MEMORY_NUMBER: 123, ...Object.fromEntries(blocked.map((key) => [key, 'rejected-value'])) });
  const preload = path.join(f.root, 'env.cjs'), seen = path.join(f.root, 'env.json');
  fs.writeFileSync(preload, `if(process.argv[1]?.endsWith('relay.mjs'))require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify({value:process.env.MEMORY_FIXTURE,number:process.env.MEMORY_NUMBER,env:Object.fromEntries(${JSON.stringify(blocked)}.map(k=>[k,process.env[k]]))}));`);
  const options = `--require=${preload}`;
  const result = await f.command(['start', run.id, 'worker', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture', '--brief', f.brief('worker')], { env: { XDG_CONFIG_HOME: config, NODE_OPTIONS: options, AGENT_ORCH_HEAVY_ACTIVE: '1' } });
  await f.finished(run, 'worker');
  const actual = readJson(seen);
  assert.equal(actual.value, 'limited'); assert.equal(actual.number, '123');
  assert.equal(actual.env.AGENT_ORCH_HOME, f.state); assert.equal(actual.env.AGENT_ORCH_TASK, 'worker');
  assert.equal(actual.env.AGENT_ORCH_ANY_FUTURE_KEY, undefined); assert.equal(actual.env.AGENT_ORCH_HEAVY_ACTIVE, undefined); assert.equal(actual.env.XDG_STATE_HOME, undefined);
  assert.equal(actual.env.HOME, f.env.HOME); assert.equal(actual.env.PATH, f.env.PATH); assert.equal(actual.env.NODE_OPTIONS, options);
  for (const key of blocked) assert.equal(result.stderr.split('\n').filter((line) => line.endsWith(`key ${key}`)).length, 1, key);
});

test('start warns once for bad optional environment JSON before creating attempt artifacts', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const config = path.join(f.root, 'config'), envFile = path.join(config, 'agent-orchestrator', 'agent-env.json');
  writeJson(envFile, {}); fs.writeFileSync(envFile, '{invalid');
  const preload = path.join(f.root, 'env-order.cjs'), seen = path.join(f.root, 'env-seen.json');
  fs.writeFileSync(preload, `const fs=require('fs'),read=fs.readFileSync,mkdir=fs.mkdirSync;let checked=false;fs.readFileSync=function(file,...args){if(String(file)===${JSON.stringify(envFile)})checked=true;return read.call(this,file,...args)};fs.mkdirSync=function(dir,...args){if(process.argv[1]?.endsWith('orch.mjs')&&String(dir).includes('/attempt-')&&!checked)throw new Error('attempt created before environment file read');return mkdir.call(this,dir,...args)};if(process.argv[1]?.endsWith('relay.mjs'))fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({value:process.env.MEMORY_FIXTURE}));`);
  const result = await f.command(['start', run.id, 'worker', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture', '--brief', f.brief('worker')], { env: { XDG_CONFIG_HOME: config, NODE_OPTIONS: `--require=${preload}` } });
  await f.finished(run, 'worker');
  assert.equal(result.stderr.split('\n').filter((line) => line.includes('ignoring agent environment')).length, 1);
  assert.match(result.stderr, /invalid JSON/); assert.deepEqual(readJson(seen), {});
  writeJson(envFile, { nested: {} });
  const malformed = await f.command(['start', run.id, 'shape', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture', '--brief', f.brief('shape')], { env: { XDG_CONFIG_HOME: config } });
  await f.finished(run, 'shape');
  assert.equal(malformed.stderr.split('\n').filter((line) => line.includes('ignoring agent environment')).length, 1);
});


test('dashboard schedules reclaim every five minutes and honors off', async (t) => {
  const f = await fixture(t), scope = processScope(f), dir = path.join(f.root, 'workspace'); fs.mkdirSync(dir);
  const proc = await daemon(t, f, scope, dir);
  const armed = path.join(f.root, 'armed'), release = path.join(f.root, 'tick'), preload = path.join(f.root, 'timer.cjs');
  // A handshake invokes the real five-minute callback without waiting five minutes.
  fs.writeFileSync(preload, `const fs=require('fs'),original=setInterval;global.setInterval=(fn,ms,...args)=>{if(ms!==300000)return original(fn,ms,...args);fs.writeFileSync(${JSON.stringify(armed)},'');const watcher=fs.watch(${JSON.stringify(f.root)},()=>{if(fs.existsSync(${JSON.stringify(release)})){watcher.close();fn(...args)}});watcher.unref();return {unref(){}}};`);
  Object.assign(f.env, scope.env, { NODE_OPTIONS: `--require=${preload}` });
  await f.dashboard();
  await eventually(() => fs.existsSync(armed), 'five-minute reclaim timer not scheduled');
  process.kill(proc.pid, 0); fs.writeFileSync(release, '');
  await eventually(() => proc.exitCode !== null || proc.signalCode !== null, 'periodic reclaim did not stop daemon');
  fs.rmSync(armed);
  const offFixture = await fixture(t);
  Object.assign(offFixture.env, { NODE_OPTIONS: `--require=${preload}`, AGENT_ORCH_RECLAIM: 'off' });
  const disabled = await offFixture.dashboard(); await disabled.json('/api/health');
  assert.equal(fs.existsSync(armed), false);
});

// Steering a command that runs under `orch heavy`: the wrapper forwards each signal it receives to
// its command's group, so steering must not also signal the command or anything else under the wrapper.
const claudeCall = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } });
// Counts its SIGTERMs. After the first it cleans up and exits 143, once it has also seen a SIGWINCH:
// the test sends that fence after steer has returned. A wrapper forwards signals in the order it
// received them, so every SIGTERM a wrapper forwards reaches its command before the fence does. With
// the `nested` argument it runs a nested `orch heavy` call, as a build tool with its own heavy step.
const counterScript = `const fs=require('fs'),{spawn}=require('child_process');
const [dir,name,cli,nested]=process.argv.slice(2);
const note=(suffix,text)=>fs.appendFileSync(dir+'/'+name+'.'+suffix,text);
let termed=false,fenced=false,innerDone=!nested;
const finish=()=>{if(termed&&fenced&&innerDone){note('cleanup','done\\n');process.exit(143)}};
process.on('SIGTERM',()=>{note('signals','SIGTERM\\n');termed=true;finish()});
process.on('SIGWINCH',()=>{fenced=true;finish()});
if(nested)spawn(process.execPath,[cli,'heavy','--label','inner','--',process.execPath,__filename,dir,'inner',cli],{stdio:'inherit'}).on('exit',(code)=>{fs.writeFileSync(dir+'/inner-wrapper.exit',String(code));innerDone=true;finish()});
fs.writeFileSync(dir+'/'+name+'.ready',JSON.stringify({pid:process.pid,ppid:process.ppid}));
setTimeout(()=>process.exit(99),30000);`;
// A non-heavy parent of a plain command, two sibling heavy commands and a nested one. It counts its
// own SIGTERMs, records each child's exit status, and ends once they have all ended.
const harnessScript = `const fs=require('fs'),{spawn}=require('child_process');
const [dir,cli,counter]=process.argv.slice(2);
let pending=0;
const run=(name,args)=>{pending++;spawn(process.execPath,args,{stdio:'inherit'}).on('exit',(code,signal)=>{fs.writeFileSync(dir+'/'+name+'.exit',String(code??signal));if(--pending===0)process.exit(0)})};
process.on('SIGTERM',()=>fs.appendFileSync(dir+'/harness.signals','SIGTERM\\n'));
const heavy=(label,...rest)=>[cli,'heavy','--label',label,'--',process.execPath,counter,dir,label,cli,...rest];
run('plain',[counter,dir,'plain',cli]);
run('normal',heavy('normal'));
run('sibling',heavy('sibling'));
run('outer',heavy('outer','nested'));
fs.writeFileSync(dir+'/harness.ready',JSON.stringify({pid:process.pid,ppid:process.ppid}));
setTimeout(()=>process.exit(99),30000);`;

// Everything these tests start carries the fixture's directory in its command line. That confirms a
// PID is ours before it is signaled, or killed when a test fails part-way.
const ownedBy = (dir, pid) => (spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '').includes(dir);
function signalOwned(dir, pid, signal) {
  assert.ok(ownedBy(dir, pid), `process ${pid} is not one of this test's processes`);
  process.kill(pid, signal);
}
const readyInfo = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.ready`), 'utf8')); } catch { return null; } };
const noted = (dir, file) => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; } };

// The fixture and the directory of its scripts and notes. The cleanup that kills leftovers is
// registered first, so it runs before the fixture's cleanup removes the directory.
async function steeringFixture(t, scripts) {
  let dir = null;
  t.after(() => {
    for (const file of dir ? fs.readdirSync(dir).filter((n) => n.endsWith('.ready')) : []) {
      const info = readyInfo(dir, file.slice(0, -6));
      for (const pid of [info?.pid, info?.ppid].filter(Number.isInteger)) if (ownedBy(dir, pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });
  const f = await fixture(t);
  dir = path.join(f.root, 'steer'); fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, `${name}.cjs`), text);
  return { f, dir };
}

// A task whose pending Bash call runs `command` in a real shell under its relay.
async function busyShell(t, f, command, dir) {
  const run = await f.newRun();
  const task = await f.start(run, 'busy', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: [claudeCall(command)] } });
  await f.ready(task);
  const shellPid = Number(await eventually(() => noted(task.outDir, 'shell.pid'), 'the shell did not start'));
  t.after(() => { if (ownedBy(dir, shellPid)) { try { process.kill(shellPid, 'SIGKILL'); } catch {} } });
  return { run, task };
}

// A copy of the skill's scripts under a path with spaces, to run a heavy wrapper from. The steering
// process runs from this checkout and does not know that path.
function spacedCli(f) {
  const skill = path.join(f.root, 'spaced dir', 'agent-orchestrator');
  fs.mkdirSync(skill, { recursive: true });
  fs.cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), path.join(skill, 'scripts'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../policy.json', import.meta.url)), path.join(skill, 'policy.json'));
  return path.join(skill, 'scripts', 'orch.mjs');
}

for (const spaced of [false, true]) {
  test(`steer sends a heavy command one SIGTERM, and the wrapper passes on its exit status${spaced ? ' (CLI path with spaces)' : ''}`, async (t) => {
    const { f, dir } = await steeringFixture(t, { counter: counterScript });
    const script = spaced ? spacedCli(f) : cli;
    assert.equal(script.includes(' '), spaced);
    // `trap` keeps the shell alive to record the wrapper's status, and counts the shell's own SIGTERM.
    const command = `trap "echo SIGTERM >> ${dir}/shell.signals" TERM; ${process.execPath} "${script}" heavy --label normal -- ${process.execPath} ${path.join(dir, 'counter.cjs')} ${dir} normal "${script}"; echo $? > ${dir}/shell.exit`;
    const { run, task } = await busyShell(t, f, command, dir);
    const normal = await eventually(() => readyInfo(dir, 'normal'), 'the heavy command did not start');
    await f.command(['send', run.id, 'busy', 'Check the DAG run.']);
    const steered = await f.json(['steer', run.id, 'busy']);
    assert.equal(steered.queued, 1);
    assert.match(steered.steer.stopped, /^trap /);
    signalOwned(dir, normal.ppid, 'SIGWINCH'); // the fence: the wrapper has forwarded its SIGTERM before this
    await eventually(() => noted(dir, 'shell.exit'), 'the shell never saw the wrapper end');
    assert.equal(noted(dir, 'normal.signals'), 'SIGTERM\n');
    assert.equal(noted(dir, 'normal.cleanup'), 'done\n');
    assert.equal(noted(dir, 'shell.exit'), '143\n');
    assert.equal(noted(dir, 'shell.signals'), 'SIGTERM\n');
    f.release(task);
    await f.finished(run, 'busy');
  });
}

test('steer sends one SIGTERM to each heavy command, a nested one and a plain sibling, and each cleans up', async (t) => {
  const { f, dir } = await steeringFixture(t, { counter: counterScript, harness: harnessScript });
  f.env.AGENT_ORCH_HEAVY_FREE_BYTES = '9999999999'; // three heavy commands run at once only with room
  const command = `trap "echo SIGTERM >> ${dir}/shell.signals" TERM; ${process.execPath} ${path.join(dir, 'harness.cjs')} ${dir} ${cli} ${path.join(dir, 'counter.cjs')}; echo $? > ${dir}/shell.exit`;
  const { run, task } = await busyShell(t, f, command, dir);
  const names = ['plain', 'normal', 'sibling', 'outer', 'inner'], started = {};
  for (const name of names) started[name] = await eventually(() => readyInfo(dir, name), `${name} did not start`);
  assert.notEqual(started.inner.ppid, started.outer.pid, 'the nested command runs under its own wrapper');
  await f.command(['send', run.id, 'busy', 'Check the DAG run.']);
  const steered = await f.json(['steer', run.id, 'busy']);
  assert.equal(steered.queued, 1);
  assert.ok(steered.steer.stopped);
  // The fence goes to each outer wrapper, which forwards it, and straight to the plain command.
  for (const pid of [started.normal.ppid, started.sibling.ppid, started.outer.ppid, started.plain.pid]) signalOwned(dir, pid, 'SIGWINCH');
  await eventually(() => noted(dir, 'shell.exit'), 'the shell never saw the harness end');
  for (const name of [...names, 'harness', 'shell']) assert.equal(noted(dir, `${name}.signals`), 'SIGTERM\n', `${name} got exactly one SIGTERM`);
  for (const name of names) assert.equal(noted(dir, `${name}.cleanup`), 'done\n', `${name} cleaned up`);
  for (const name of ['plain', 'normal', 'sibling', 'outer', 'inner-wrapper']) assert.equal(noted(dir, `${name}.exit`), '143', `${name} exit status`);
  assert.equal(noted(dir, 'shell.exit'), '0\n');
  f.release(task);
  await f.finished(run, 'busy');
});

test('commandTree leaves a heavy wrapper to forward the signal to everything under it', () => {
  const node = '/usr/local/bin/node', cliPath = '/skills/agent-orchestrator/scripts/orch.mjs', command = 'make test; echo done';
  const row = (pid, ppid, text) => ({ pid, ppid, command: text });
  const wrapper = (...args) => `${node} ${cliPath} heavy ${args.join(' ')}`;
  const rows = [
    row(1, 0, '/sbin/init'), row(10, 1, `${node} relay.mjs --brief b.md`),
    row(11, 10, `/bin/bash -c ${command}`),
    row(12, 11, wrapper('--label', 'big', 'build', '--', 'pants', 'test', '::')), // a label with spaces
    row(13, 12, 'pants test ::'), row(14, 13, 'pantsd worker'),
    row(15, 13, wrapper('--', 'nested-tool')), row(16, 15, 'nested-tool'), row(17, 16, 'leaf'), // a nested wrapper
    row(18, 11, 'sleep 61'), // a plain sibling
    row(19, 11, wrapper('--label=other', '--', 'tool')), row(20, 19, 'tool'),
    row(21, 11, `/bin/sh -c ${wrapper('--', 'only', 'mentioned')}`), row(22, 21, 'only mentioned'), // not a wrapper
    row(23, 11, wrapper('--', 'queued')), // a wrapper still waiting for admission: it has no command yet
  ];
  const tree = commandTree(10, command, rows);
  assert.equal(tree.shell.pid, 11);
  // Deepest first: the shell, every wrapper, the plain branches and the shell that only mentions the
  // words. Nothing under a wrapper, nested wrappers included.
  assert.deepEqual(tree.pids, [23, 22, 21, 19, 18, 12, 11]);
  assert.equal(commandTree(10, 'nothing like it', rows), null);
});

test('only a real node orch.mjs heavy command line is a heavy wrapper', () => {
  const real = [
    '/usr/local/bin/node /x/orch.mjs heavy -- cmd',
    'node /x/orch.mjs heavy --label empty lane -- echo RAN',
    'node /x/orch.mjs heavy --label=a b -- cmd arg',
    'node /x/orch.mjs heavy --json --label a -- cmd',
    'node --no-warnings --require /p.cjs /x/orch.mjs heavy -- cmd',
    'node /x/orch.mjs heavy --label a -- node /x/orch.mjs heavy -- cmd',
    `${process.execPath} /x/orch.mjs heavy -- cmd`,
  ];
  const other = [
    '/bin/bash -c node /x/orch.mjs heavy -- cmd',
    'echo node /x/orch.mjs heavy -- cmd',
    'grep orch.mjs heavy -- cmd',
    'node -e console.log("orch.mjs heavy -- cmd")',
    'node -e run /x/orch.mjs heavy -- cmd',
    'node other.mjs /x/orch.mjs heavy -- cmd',
    'node /x/orch.mjs status heavy -- cmd',
    'node /x/orch.mjs heavy cmd -- cmd', // a stray word: the real command refuses it
    'node /x/orch.mjs heavy --label a --json cmd -- cmd',
    'node /x/orch.mjs heavy --label x',
    'node /x/orch.mjs heavy --',
    'node /x/orch.mjs heavy --label --',
    'node /x/orch.mjs heavy --unknown -- cmd',
    'node /x/orch.mjs reclaim -- heavy',
    'python /x/orch.mjs heavy -- cmd',
    '',
  ];
  for (const line of real) assert.equal(isHeavyWrapper(line), true, line);
  for (const line of other) assert.equal(isHeavyWrapper(line), false, line);
  assert.equal(isHeavyWrapper(`${process.execPath} ${CLI_PATH} heavy --label ps -- cmd`), true, 'this copy of the CLI is always known');
});

test('a heavy wrapper whose CLI path has spaces is recognized by its known path, and nothing else is', () => {
  const home = '/Users/Jo Smith/Library/Application Support', script = `${home}/skills/agent-orchestrator/scripts/orch.mjs`;
  const node = `${home}/fnm/node-versions/v22.1.0/installation/bin/node`, known = [script];
  const wrapper = [
    `/usr/local/bin/node ${script} heavy -- cmd`,
    `/usr/local/bin/node ${script} heavy --label two words -- cmd arg`,
    `${node} ${script} heavy -- cmd`, // the Node path has spaces too
    `/usr/local/bin/node --require /tmp/preload.cjs --no-warnings ${script} heavy --json -- cmd`,
    `"${node}" "${script}" heavy -- cmd`, // as a shell would write it
    `'${node}' '${script}' heavy -- cmd`,
    `${process.execPath} ${script} heavy --label a -- ${process.execPath} ${script} heavy -- cmd`,
  ];
  const other = [
    `/bin/bash -c /usr/local/bin/node ${script} heavy -- cmd`, // a shell that mentions it
    `/bin/bash -c "node '${script}' heavy -- cmd"`,
    `echo /usr/local/bin/node ${script} heavy -- cmd`,
    `grep ${script} heavy -- cmd`,
    `/usr/local/bin/node -e run ${script} heavy -- cmd`, // code from the line, then arguments
    `/usr/local/bin/node --eval=run ${script} heavy -- cmd`,
    `/usr/local/bin/node other.js ${script} heavy -- cmd`, // another script's arguments
    `/usr/local/bin/node /tmp/other.js ${script} heavy -- cmd`,
    `/usr/local/bin/node /tmp/other.js orch.mjs heavy -- cmd`,
    `sudo -u me /usr/local/bin/node ${script} heavy -- cmd`,
    `/usr/bin/time /usr/local/bin/node ${script} heavy -- cmd`,
    `/usr/local/bin/node ${script} heavy cmd -- cmd`, // the real command refuses a stray word
    `/usr/local/bin/node ${script} heavy --label x`,
    `/usr/local/bin/node ${script} heavyweight -- cmd`,
    `/usr/local/bin/node ${script} status heavy -- cmd`,
    `/usr/local/bin/node ${home}/other/agent-orchestrator/scripts/orch.mjs heavy -- cmd`, // a stranger's path with spaces
    `/usr/local/bin/python ${script} heavy -- cmd`,
  ];
  const nothing = () => false; // no file exists, so only the known path can identify a spaced one
  for (const line of wrapper) assert.equal(isHeavyWrapper(line, known, nothing), true, line);
  for (const line of other) assert.equal(isHeavyWrapper(line, known, nothing), false, line);
  // Without the known path the same line cannot be told from other arguments.
  assert.equal(isHeavyWrapper(wrapper[0], [], nothing), false);
  assert.equal(isHeavyWrapper('/usr/local/bin/node /tmp/no-spaces/orch.mjs heavy -- cmd', [], nothing), true);
});

test('a heavy wrapper run from another existing script path with spaces is recognized by the file', () => {
  const dir = '/Users/Jo Smith/Library/Application Support/other skill/scripts', script = `${dir}/orch.mjs`;
  // `/Users/Jo` is a folder: only files end the search.
  const files = new Set([script, '/tmp/other.js', '/tmp/dir with spaces/other.js', '/Users/Jo Smith/node']);
  const exists = (file) => files.has(file);
  const node = '/usr/local/bin/node';
  const wrapper = [
    `${node} ${script} heavy -- cmd`,
    `${node} ${script} heavy --label two words -- cmd arg`,
    `${node} --require /tmp/other.js ${script} heavy --json -- cmd`, // a preload is an option's value
    `/Users/Jo Smith/node ${script} heavy -- cmd`, // the Node path has spaces too
  ];
  const other = [
    `${node} /tmp/other.js ${script} heavy -- cmd`, // the first existing file is another script
    `${node} /tmp/dir with spaces/other.js ${script} heavy -- cmd`,
    `${node} /tmp/other.js ${dir}/orch.mjs heavy --label x -- cmd`,
    `${node} -e run ${script} heavy -- cmd`,
    `${node} --print=1 ${script} heavy -- cmd`,
    `${node} ${script}.bak heavy -- cmd`, // a file that does not exist
    `${node} ${dir}/missing/orch.mjs heavy -- cmd`,
    `${node} ${script} heavy cmd -- cmd`,
    `${node} ${script} heavy --label x`,
    `${node} ${script} status heavy -- cmd`,
    `/bin/bash -c ${node} ${script} heavy -- cmd`,
    `echo ${node} ${script} heavy -- cmd`,
    `/usr/bin/time ${node} ${script} heavy -- cmd`,
    `${node} /tmp/other.js orch.mjs heavy -- cmd`,
  ];
  for (const line of wrapper) assert.equal(isHeavyWrapper(line, [], exists), true, line);
  for (const line of other) assert.equal(isHeavyWrapper(line, [], exists), false, line);
  // A file that ends the search earlier than the script: `/Users/Jo` is now a file.
  files.add('/Users/Jo');
  assert.equal(isHeavyWrapper(`${node} ${script} heavy -- cmd`, [], exists), false);
  // The script cannot be told from its neighbours once it is gone.
  files.delete('/Users/Jo'); files.delete(script);
  assert.equal(isHeavyWrapper(`${node} ${script} heavy -- cmd`, [], exists), false);
});

test('steer still signals a command under a script that only mentions a spaced CLI path', async (t) => {
  const otherScript = `const fs=require('fs'),{spawn}=require('child_process');
const [dir,counter,cli]=process.argv.slice(2); // the words after these are only text: <cli> heavy -- ...
process.on('SIGTERM',()=>fs.appendFileSync(dir+'/other.signals','SIGTERM\\n'));
spawn(process.execPath,[counter,dir,'leaf',cli],{stdio:'inherit'}).on('exit',(code)=>{fs.writeFileSync(dir+'/leaf.exit',String(code));process.exit(0)});
fs.writeFileSync(dir+'/other.ready',JSON.stringify({pid:process.pid,ppid:process.ppid}));
setTimeout(()=>process.exit(99),30000);`;
  const { f, dir } = await steeringFixture(t, { counter: counterScript, other: otherScript });
  const script = spacedCli(f);
  // An existing script, not the CLI, whose own arguments end in `<spaced CLI> heavy -- ...`.
  const command = `trap "echo SIGTERM >> ${dir}/shell.signals" TERM; ${process.execPath} ${path.join(dir, 'other.cjs')} ${dir} ${path.join(dir, 'counter.cjs')} "${script}" heavy -- not a wrapper; echo $? > ${dir}/shell.exit`;
  const { run, task } = await busyShell(t, f, command, dir);
  const leaf = await eventually(() => readyInfo(dir, 'leaf'), 'the command did not start');
  await f.command(['send', run.id, 'busy', 'Check the DAG run.']);
  const steered = await f.json(['steer', run.id, 'busy']);
  assert.equal(steered.queued, 1);
  assert.match(steered.steer.stopped, /^trap /);
  signalOwned(dir, leaf.pid, 'SIGWINCH'); // no wrapper stands between the leaf and steer: it gets the SIGTERM directly
  await eventually(() => noted(dir, 'shell.exit'), 'the shell never saw the script end');
  for (const name of ['leaf', 'other', 'shell']) assert.equal(noted(dir, `${name}.signals`), 'SIGTERM\n', `${name} got exactly one SIGTERM`);
  assert.equal(noted(dir, 'leaf.cleanup'), 'done\n');
  assert.equal(noted(dir, 'leaf.exit'), '143');
  assert.equal(noted(dir, 'shell.exit'), '0\n');
  f.release(task);
  await f.finished(run, 'busy');
});

test('dashboard shares a five-second heavy snapshot across both endpoints', async (t) => {
  const f = await fixture(t);
  const first = heavy(t, f, 'cached-running'); await first.ready();
  const clock = path.join(f.root, 'clock'), reads = path.join(f.root, 'lane-reads');
  const preload = path.join(f.root, 'lane-cache.cjs'), epoch = Date.now();
  fs.writeFileSync(clock, String(epoch)); fs.writeFileSync(reads, '');
  // Control time through a file, and count actual lane scans in the dashboard process only.
  // There are no timing sleeps: each HTTP response is the completion handshake.
  fs.writeFileSync(preload, `if(process.argv[2]==='dashboard'){const fs=require('fs'),read=fs.readdirSync;Date.now=()=>Number(fs.readFileSync(${JSON.stringify(clock)},'utf8'));fs.readdirSync=function(dir,...args){if(String(dir)===${JSON.stringify(path.join(f.state, 'heavy'))})fs.appendFileSync(${JSON.stringify(reads)},'scan\\n');return read.call(this,dir,...args)}}`);
  f.env.NODE_OPTIONS = `--require=${preload}`;
  const board = await f.dashboard();
  const scans = () => fs.readFileSync(reads, 'utf8').trim().split('\n').filter(Boolean).length;
  const counts = async () => JSON.parse((await board.get('/api/state')).headers.get('x-orch-heavy'));
  assert.deepEqual(await board.json('/api/heavy'), { running: 1, waiting: 0 });
  assert.equal(scans(), 1);
  const second = heavy(t, f, 'cached-waiting'); await queued(f, 'cached-waiting');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await counts(), { running: 1, waiting: 0 });
    assert.deepEqual(await board.json('/api/heavy'), { running: 1, waiting: 0 });
  }
  fs.writeFileSync(clock, String(epoch + 4999));
  assert.deepEqual(await counts(), { running: 1, waiting: 0 });
  assert.equal(scans(), 1);
  fs.writeFileSync(clock, String(epoch + 5000));
  assert.deepEqual(await counts(), { running: 1, waiting: 1 });
  assert.deepEqual(await board.json('/api/heavy'), { running: 1, waiting: 1 });
  assert.equal(scans(), 2);
  first.release(); await first.proc.done; await second.ready(); second.release(); await second.proc.done;
  assert.deepEqual(await board.json('/api/heavy'), { running: 1, waiting: 1 });
  fs.writeFileSync(clock, String(epoch + 10000));
  assert.deepEqual(await board.json('/api/heavy'), { running: 0, waiting: 0 });
  assert.equal(scans(), 3);
});
