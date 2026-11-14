import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { eventually, fixture, readJson } from './helpers.mjs';

// Starts through launchd (scripts/lib/detach.mjs), against a fake `launchctl` first on PATH. Only the
// last test, opt-in, loads a job into the real launchd.
const macOS = process.platform === 'darwin';
const launchdOnly = macOS ? false : 'launchd is macOS only';
const uid = process.getuid();
const WHY = 'Exercises detached starts with a local command';

// The fake launchctl. `bootstrap` copies the job file, records the modes of the job files, and runs
// the helper the job names as launchd would: detached, with launchd's small environment (never the
// caller's), its output to the job's log. `bootout` stops that helper as launchd does: SIGTERM, then
// it waits for the helper to exit. Every call is recorded in calls.jsonl. FAKE_LAUNCHD_MODE picks a
// behaviour: `run`; `fail` (every bootstrap fails); `no-gui` (no gui domain, as in an SSH login);
// and, through a preload in the helper, `hang` (the helper never answers), `late` (it answers once
// the test writes helper-go) and `kill` (it is killed between its start and its report).
const FAKE = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [verb, target, file] = process.argv.slice(2);
const dir = process.env.FAKE_LAUNCHD_DIR;
const mode = process.env.FAKE_LAUNCHD_MODE || 'run';
const record = (entry) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ verb, target, ...entry }) + '\\n');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const mode8 = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8); } catch { return null; } };
if (verb === 'bootstrap') {
  const job = fs.readFileSync(file, 'utf8');
  const key = (name) => unxml(new RegExp('<key>' + name + '</key>\\\\s*<string>([^<]*)</string>').exec(job)?.[1] || '');
  const label = key('Label');
  const args = [...(/<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/.exec(job)?.[1] || '').matchAll(/<string>([^<]*)<\\/string>/g)].map((m) => unxml(m[1]));
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', label + '.plist'), job);
  record({ label, args, modes: { folder: mode8(path.dirname(file)), job: mode8(file), spec: mode8(args[2]) } });
  if (mode === 'fail' || (mode === 'no-gui' && target.startsWith('gui/'))) {
    process.stderr.write(mode === 'fail' ? 'Bootstrap failed: 5: Input/output error\\n' : 'Bootstrap failed: 125: Domain does not support specified action\\n');
    process.exit(mode === 'fail' ? 5 : 125);
  }
  const log = fs.openSync(key('StandardErrorPath'), 'a');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME };
  if (['hang', 'late', 'kill'].includes(mode)) Object.assign(env, { NODE_OPTIONS: '--require=' + path.join(dir, 'helper-preload.cjs'), FAKE_HELPER_MODE: mode, FAKE_LAUNCHD_DIR: dir });
  const helper = spawn(args[0], args.slice(1), { detached: true, stdio: ['ignore', log, log], env });
  fs.writeFileSync(path.join(dir, target.replace('/', '-') + '-' + label + '.pid'), String(helper.pid));
  helper.unref();
  process.exit(0);
}
if (verb === 'bootout') {
  const [domain, user, label] = target.split('/');
  const pidFile = path.join(dir, domain + '-' + user + '-' + label + '.pid');
  record({ label });
  if (!fs.existsSync(pidFile)) { process.stderr.write('Boot-out failed: 3: No such process\\n'); process.exit(3); }
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  fs.rmSync(pidFile);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const until = Date.now() + 30000;
  while (alive(pid) && Date.now() < until) pause(20);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  process.exit(0);
}
record({});
process.exit(64);
`;

// Loaded into the helper by the fake launchctl for the modes that change it.
const PRELOAD = `
const fs = require('node:fs');
const path = require('node:path');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const dir = process.env.FAKE_LAUNCHD_DIR;
const mode = process.env.FAKE_HELPER_MODE;
// Never answers: blocked before the helper runs, so the bootout's SIGTERM ends it.
if (mode === 'hang') pause(60000);
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(to).endsWith('.result.json')) {
    fs.writeFileSync(path.join(dir, 'helper-started'), String(process.pid));
    if (mode === 'late') while (!fs.existsSync(path.join(dir, 'helper-go'))) pause(20);
    if (mode === 'kill') { process.stderr.write('killed before reporting\\n'); process.kill(process.pid, 'SIGKILL'); pause(5000); }
  }
  return rename.call(this, from, to);
};
`;

// A fake launchd for fixture `f`: the environment that puts it first on PATH, and its records.
function fakeLaunchd(f, mode = 'run', extra = {}) {
  const dir = path.join(f.root, `fake-launchd-${mode}`);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'launchctl.mjs'), FAKE);
  fs.writeFileSync(path.join(dir, 'helper-preload.cjs'), PRELOAD);
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'launchctl.mjs'))} "$@"\n`, { mode: 0o755 });
  const calls = () => {
    const file = path.join(dir, 'calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const jobs = () => {
    const folder = path.join(dir, 'jobs');
    return fs.existsSync(folder) ? fs.readdirSync(folder).map((name) => fs.readFileSync(path.join(folder, name), 'utf8')) : [];
  };
  // AGENT_ORCH_LAUNCHD undefined removes the helpers' `off`.
  const env = { PATH: `${bin}${path.delimiter}${f.env.PATH}`, AGENT_ORCH_LAUNCHD: undefined, FAKE_LAUNCHD_DIR: dir, FAKE_LAUNCHD_MODE: mode, ...extra };
  return { dir, env, calls, jobs };
}

// f.env's PATH with launchctl taken out: each folder that holds one is replaced by a folder of
// links to everything else in it.
function pathWithoutLaunchctl(f) {
  return f.env.PATH.split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!fs.existsSync(path.join(dir, 'launchctl'))) return dir;
    const copy = path.join(f.root, `path-${i}`);
    fs.mkdirSync(copy);
    for (const name of fs.readdirSync(dir)) if (name !== 'launchctl') fs.symlinkSync(path.join(dir, name), path.join(copy, name));
    return copy;
  }).join(path.delimiter);
}

// A command task whose command records each start (its PID, in `starts`), prints its folder and
// environment, says it is ready, and waits for `release`.
function held(f, name) {
  const file = (what) => JSON.stringify(path.join(f.root, `${name}.${what}`));
  const argv = ['sh', '-c', `echo $$ >> ${file('starts')}; echo "cwd=$(pwd -P)"; echo "secret=$DETACH_SECRET"; echo "outside=$AGENT_ORCH_OUTSIDE"; echo ready > ${file('ready')}; while [ ! -f ${file('release')} ]; do sleep 0.05; done`];
  const at = (what) => path.join(f.root, `${name}.${what}`);
  return {
    argv,
    ready: () => eventually(() => fs.existsSync(at('ready')), `${name} did not start`, 20_000),
    release: () => fs.writeFileSync(at('release'), ''),
    starts: () => fs.readFileSync(at('starts'), 'utf8').trim().split('\n'),
  };
}

async function startHeld(f, run, id, env) {
  const command = held(f, id);
  const r = await f.command(['start', run.id, id, '--agent', 'command', '--why', WHY, '--json', '--', ...command.argv], { env });
  const task = JSON.parse(r.stdout);
  await command.ready();
  return { task, command };
}

async function finish(f, run, task, command) {
  command.release();
  await f.finished(run, task.id);
  assert.equal(command.starts().length, 1, 'the command started more than once');
}

const ps = (pid, field) => spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
// The paths a process holds open for descriptors `fds` (lsof -d), in order.
const openPaths = (pid, fds) => spawnSync('lsof', ['-a', '-p', String(pid), '-d', fds, '-Fn'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const jobsFolder = (f) => path.join(f.state, 'launchd');

test('on macOS a relay starts through a one-off launchd job, in its folder, with its environment and output, and leaves no job file', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f);
  const secret = `secret-${path.basename(f.root)}`;
  const run = await f.newRun('launchd');
  const { task, command } = await startHeld(f, run, 'job', { ...fake.env, DETACH_SECRET: secret });
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.match(task.launch.label, /^agent-orch\.[0-9a-f]+$/);

  // The relay is the task's PID: alive, leading its own process group, in --cd, its output in relay.log.
  assert.ok(alive(task.pid));
  assert.match(ps(task.pid, 'command'), /command-relay\.mjs --out-dir /);
  assert.equal(Number(ps(task.pid, 'pgid')), task.pid);
  assert.deepEqual(openPaths(task.pid, 'cwd'), [f.repo]);
  const log = path.join(task.outDir, 'relay.log');
  assert.deepEqual(openPaths(task.pid, '1,2'), [log, log]);
  const output = fs.readFileSync(log, 'utf8');
  assert.ok(output.split('\n').includes(`cwd=${f.repo}`), output);
  assert.ok(output.split('\n').includes(`secret=${secret}`), 'the environment did not reach the command');
  assert.match(output, /^outside=1$/m, 'what launchd starts is marked as outside the terminal');

  // One bootstrap in the gui domain, then the bootout of the same label.
  const calls = fake.calls();
  assert.deepEqual(calls.map((c) => [c.verb, c.target.replace(/\/agent-orch\.[0-9a-f]+$/, '/<label>')]),
    [['bootstrap', `gui/${uid}`], ['bootout', `gui/${uid}/<label>`]]);
  assert.equal(calls[0].label, task.launch.label);
  // The job file named only Node, the helper and the spec, and never held the environment; the
  // files were private to the user while they existed, and are all gone now.
  assert.deepEqual(calls[0].modes, { folder: '700', job: '600', spec: '600' });
  assert.equal(calls[0].args.length, 3);
  assert.equal(calls[0].args[0], process.execPath);
  assert.match(calls[0].args[1], /scripts\/detach-helper\.mjs$/);
  assert.equal(calls[0].args[2], path.join(jobsFolder(f), `${task.launch.label}.spec.json`));
  for (const job of fake.jobs()) {
    assert.ok(!job.includes(secret), 'the job file held the environment');
    assert.doesNotMatch(job, /EnvironmentVariables/);
  }
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);

  // `result` adds no launch line for a launchd start.
  assert.doesNotMatch((await f.command(['result', run.id, 'job'])).stdout, /^launch:/m);
  await finish(f, run, task, command);
});

test('a start removes the job files a dead caller left, and its job from launchd', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f);
  fs.mkdirSync(jobsFolder(f), { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 10 * 60_000);
  for (const name of ['agent-orch.0a1d.plist', 'agent-orch.0a1d.spec.json', 'agent-orch.5ec.spec.json']) {
    fs.writeFileSync(path.join(jobsFolder(f), name), '{"env":{"TOKEN":"left behind"}}', { mode: 0o600 });
    fs.utimesSync(path.join(jobsFolder(f), name), old, old);
  }
  const run = await f.newRun('stale');
  const { task, command } = await startHeld(f, run, 'stale', fake.env);
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  assert.deepEqual(fake.calls().filter((c) => c.verb === 'bootout' && c.target.endsWith('/agent-orch.0a1d')).map((c) => c.target), [`gui/${uid}/agent-orch.0a1d`, `user/${uid}/agent-orch.0a1d`]);
  await finish(f, run, task, command);
});

test('without a gui domain, as in an SSH login, the job goes to the user domain', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'no-gui');
  const run = await f.newRun('user-domain');
  const { task, command } = await startHeld(f, run, 'ssh', fake.env);
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.deepEqual(fake.calls().filter((c) => c.verb === 'bootstrap').map((c) => c.target), [`gui/${uid}`, `user/${uid}`]);
  assert.ok(fake.calls().some((c) => c.verb === 'bootout' && c.target === `user/${uid}/${task.launch.label}`));
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  await finish(f, run, task, command);
});

// Each way the launchd path can fail ends in one direct start, recorded with its reason.
for (const [name, setup, reason] of [
  ['a failing launchctl', (f) => fakeLaunchd(f, 'fail').env, new RegExp(`^launchctl bootstrap user/${uid} failed: Bootstrap failed: 5: Input/output error$`)],
  ['a missing launchctl', (f) => ({ PATH: pathWithoutLaunchctl(f), AGENT_ORCH_LAUNCHD: undefined }), /^launchctl was not found$/],
  ['a helper that never answers', (f) => fakeLaunchd(f, 'hang', { AGENT_ORCH_LAUNCHD_WAIT: '300ms' }).env, /^launchd gave no answer within 300 ms$/],
]) {
  test(`${name}: the relay starts directly, once, and the task records why`, { skip: launchdOnly }, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun('fallback');
    const { task, command } = await startHeld(f, run, 'direct', setup(f));
    assert.equal(task.launch.how, 'direct');
    assert.match(task.launch.reason, reason);
    assert.ok(alive(task.pid));
    assert.equal(Number(ps(task.pid, 'pgid')), task.pid);
    const output = fs.readFileSync(path.join(task.outDir, 'relay.log'), 'utf8');
    assert.match(output, /^outside=$/m, 'a direct start is not outside the terminal');
    assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
    const shown = (await f.command(['result', run.id, 'direct'])).stdout;
    assert.match(shown, /^launch: direct, not through launchd \(.+\)$/m);
    assert.equal(readJson(f.taskFile(run, 'direct')).launch.reason, task.launch.reason);
    await finish(f, run, task, command);
  });
}

test('a helper that answers after the caller stopped waiting: its process is the one recorded, and none other starts', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'late', { AGENT_ORCH_LAUNCHD_WAIT: '3s' });
  const run = await f.newRun('late');
  const command = held(f, 'late');
  const starting = f.command(['start', run.id, 'late', '--agent', 'command', '--why', WHY, '--json', '--', ...command.argv], { env: fake.env });
  // The helper has started the process and holds its answer; the caller stops waiting and boots the
  // job out. Only then does the helper answer.
  await eventually(() => fs.existsSync(path.join(fake.dir, 'helper-started')), 'the helper did not start the process', 20_000);
  await eventually(() => fake.calls().some((c) => c.verb === 'bootout'), 'the caller did not stop waiting', 20_000);
  fs.writeFileSync(path.join(fake.dir, 'helper-go'), '');
  const task = JSON.parse((await starting).stdout);
  await command.ready();
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.match(ps(task.pid, 'command'), /command-relay\.mjs --out-dir /);
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  await finish(f, run, task, command);
});

test('a helper killed between its start and its report: the process it started is recorded, not started again', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'kill');
  const run = await f.newRun('killed');
  const { task, command } = await startHeld(f, run, 'killed', fake.env);
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.ok(fs.existsSync(path.join(fake.dir, 'helper-started')));
  assert.equal(Number(ps(task.pid, 'ppid')), 1, 'launchd adopted the process');
  assert.match(ps(task.pid, 'command'), /command-relay\.mjs --out-dir /);
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  await finish(f, run, task, command);
});

test('AGENT_ORCH_OUTSIDE=1 and AGENT_ORCH_LAUNCHD=off start directly without calling launchctl', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f);
  const run = await f.newRun('direct');
  const outside = await startHeld(f, run, 'outside', { ...fake.env, AGENT_ORCH_OUTSIDE: '1' });
  assert.deepEqual(outside.task.launch, { how: 'direct', reason: 'already outside the terminal application (AGENT_ORCH_OUTSIDE=1)' });
  assert.match(fs.readFileSync(path.join(outside.task.outDir, 'relay.log'), 'utf8'), /^outside=1$/m);
  // A process already outside the terminal reads as such in `result` too.
  assert.match((await f.command(['result', run.id, 'outside'])).stdout, /^launch: direct, not through launchd \(already outside the terminal application/m);
  const off = await startHeld(f, run, 'off', { ...fake.env, AGENT_ORCH_LAUNCHD: 'off' });
  assert.deepEqual(off.task.launch, { how: 'direct', reason: 'AGENT_ORCH_LAUNCHD=off' });
  assert.match(fs.readFileSync(path.join(off.task.outDir, 'relay.log'), 'utf8'), /^outside=$/m);
  assert.deepEqual(fake.calls(), []);
  await finish(f, run, outside.task, outside.command);
  await finish(f, run, off.task, off.command);
});

test('a nested start runs both its relay and its finish watcher through launchd, and the notice arrives', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f);
  const as = (run, id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const child = await f.newRun('child', as(parent, 'lead'));
  const kid = await f.start(child, 'kid', { env: { ...fake.env, ...as(parent, 'lead') } });
  assert.equal(kid.launch.how, 'launchd', JSON.stringify(kid.launch));
  const invocation = path.join(kid.outDir, 'invocation.json');
  await eventually(() => fs.existsSync(invocation), 'the relay did not start');
  assert.equal(readJson(invocation).cwd, f.repo);
  // The relay's and the finish watcher's jobs.
  assert.equal(fake.calls().filter((c) => c.verb === 'bootstrap').length, 2);
  const record = await eventually(() => {
    try {
      const r = readJson(path.join(kid.outDir, 'parent-notice.json'));
      return r.sentAt || r.skipped ? r : null;
    } catch {
      return null;
    }
  }, 'no finish notice', 20_000);
  assert.ok(record.sentAt, JSON.stringify(record));
  assert.equal(record.to, `${parent.id}/lead`);
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  f.release(lead);
  await f.finished(parent, 'lead');
});

test('dashboard --detach starts the server through launchd and reports its pid', { skip: launchdOnly }, async (t) => {
  // Registered before the fixture's own cleanup, which removes the folders, so it runs first.
  let server = null;
  t.after(async () => {
    if (server && alive(server)) process.kill(server, 'SIGTERM');
    if (server) await eventually(() => !alive(server), 'the detached dashboard did not exit');
  });
  const f = await fixture(t);
  const fake = fakeLaunchd(f);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.notEqual(port, 4777);
  const env = { ...fake.env, AGENT_ORCH_RECLAIM: 'off', AGENT_ORCH_AUTO_GC: 'off', AGENT_ORCH_NOTIFY: 'off' };
  const out = (await f.command(['dashboard', '--detach', '--host', '127.0.0.1', '--port', String(port)], { env })).stdout;
  const m = /background pid (\d+)/.exec(out);
  assert.ok(m, out);
  server = Number(m[1]);
  assert.equal(readJson(path.join(f.state, 'dashboard.json')).pid, server);
  assert.equal(fake.calls().filter((c) => c.verb === 'bootstrap').length, 1);
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
});

test('agents says whether agents start outside the terminal application', async (t) => {
  const f = await fixture(t);
  const off = await f.json(['agents']);
  if (macOS) {
    assert.deepEqual(off.outsideTerminal, { outside: false, how: 'direct', text: 'no: AGENT_ORCH_LAUNCHD=off, so agents start directly and quitting the terminal application ends them' });
    const fake = fakeLaunchd(f);
    const on = await f.json(['agents'], { env: fake.env });
    assert.equal(on.outsideTerminal.outside, true);
    assert.equal(on.outsideTerminal.how, 'launchd');
    const already = await f.json(['agents'], { env: { AGENT_ORCH_OUTSIDE: '1' } });
    assert.equal(already.outsideTerminal.outside, true);
    const text = (await f.command(['agents'], { env: fake.env })).stdout;
    assert.match(text, /^agents outside the terminal: yes: each agent starts through a one-off launchd job/m);
  } else {
    assert.equal(off.outsideTerminal.outside, null);
  }
});

// Loads a job into the real launchd: run with AGENT_ORCH_TEST_LAUNCHD=1 on macOS.
test('the real launchd starts the relay, which launchd then parents, and keeps no job', {
  skip: macOS && process.env.AGENT_ORCH_TEST_LAUNCHD === '1' ? false : 'set AGENT_ORCH_TEST_LAUNCHD=1 on macOS to load a job into the real launchd',
}, async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('real');
  const { task, command } = await startHeld(f, run, 'real', { AGENT_ORCH_LAUNCHD: undefined });
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.equal(Number(ps(task.pid, 'ppid')), 1, 'the relay\'s parent is launchd');
  assert.equal(Number(ps(task.pid, 'pgid')), task.pid);
  assert.match(fs.readFileSync(path.join(task.outDir, 'relay.log'), 'utf8'), /^outside=1$/m);
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    const left = spawnSync('launchctl', ['print', `${domain}/${task.launch.label}`], { encoding: 'utf8' });
    assert.notEqual(left.status, 0, `${domain}/${task.launch.label} is still loaded`);
  }
  assert.deepEqual(fs.readdirSync(jobsFolder(f)), []);
  await finish(f, run, task, command);
});
