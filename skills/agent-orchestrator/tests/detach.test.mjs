import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson } from './helpers.mjs';
// A constant: the shell that claims a launchd start's answer, run here with chosen arguments.
import { CLAIM_SCRIPT } from '../scripts/lib/detach.mjs';

// Starts through launchd (scripts/lib/detach.mjs), against a fake `launchctl` first on PATH. Only the
// last test, opt-in, loads a job into the real launchd.
const macOS = process.platform === 'darwin';
const launchdOnly = macOS ? false : 'launchd is macOS only';
const uid = process.getuid();
const WHY = 'Exercises detached starts with a local command';
const COMMAND_RELAY = fileURLToPath(new URL('../scripts/command-relay.mjs', import.meta.url));

// The fake launchctl. `bootstrap` copies the job file, records the modes of the job files, marks the
// job loaded in that domain, and runs the helper the job names as launchd would: detached, with
// launchd's small environment (never the caller's), its output to the job's log. `bootout` unloads
// the job and stops its helper as launchd does (SIGTERM, then it waits for the helper to exit).
// `print` succeeds only for a loaded job. Every call is recorded in calls.jsonl, with the admission
// lock's tickets at that moment (FAKE_LOCKS). FAKE_LAUNCHD_MODE picks a behaviour: `run`; `fail`
// (every bootstrap fails); `no-gui` (no gui domain, as in an SSH login); `stuck` (bootout fails and
// the job stays loaded); `slow-unknown` (bootout and print of a job it never loaded take 10s);
// `nopid` (the job answers without a PID); and, through a preload in the helper: `hang` (the helper
// never answers), `late` (it waits after taking the spec until the test writes helper-go, and
// bootout leaves it running), `die-early` (it is killed after taking the spec) and
// `kill-after-spawn` (it is killed as soon as it has started the shell).
const FAKE = String.raw`
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [verb, target, file] = process.argv.slice(2);
const dir = process.env.FAKE_LAUNCHD_DIR;
const mode = process.env.FAKE_LAUNCHD_MODE || 'run';
const locks = () => { try { return fs.readdirSync(process.env.FAKE_LOCKS).filter((n) => /^\d+-/.test(n)); } catch { return null; } };
const record = (entry) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ verb, target, locks: locks(), ...entry }) + '\n');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const mode8 = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8); } catch { return null; } };
const loadedIn = (domain, label) => path.join(dir, 'loaded-' + domain.replace('/', '-') + '-' + label);
if (verb === 'bootstrap') {
  const job = fs.readFileSync(file, 'utf8');
  const key = (name) => unxml(new RegExp('<key>' + name + '</key>\\s*<string>([^<]*)</string>').exec(job)?.[1] || '');
  const label = key('Label');
  const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(job)?.[1] || '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', label + '.plist'), job);
  record({ label, args, modes: { jobs: mode8(path.dirname(path.dirname(file))), folder: mode8(path.dirname(file)), job: mode8(file), spec: mode8(args[2]) } });
  if (mode === 'fail' || (mode === 'no-gui' && target.startsWith('gui/'))) {
    process.stderr.write(mode === 'fail' ? 'Bootstrap failed: 5: Input/output error\n' : 'Bootstrap failed: 125: Domain does not support specified action\n');
    process.exit(mode === 'fail' ? 5 : 125);
  }
  fs.writeFileSync(loadedIn(target, label), '');
  fs.writeFileSync(path.join(dir, 'known-' + label), '');
  if (mode === 'nopid') {
    const result = path.join(path.dirname(args[2]), 'result.json');
    fs.writeFileSync(result + '.fake', '{"note":"no pid"}');
    fs.linkSync(result + '.fake', result);
    fs.rmSync(result + '.fake');
    process.exit(0);
  }
  const log = fs.openSync(key('StandardErrorPath'), 'a');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME };
  if (['hang', 'late', 'die-early', 'kill-after-spawn'].includes(mode)) Object.assign(env, { NODE_OPTIONS: '--require=' + path.join(dir, 'helper-preload.cjs'), FAKE_HELPER_MODE: mode, FAKE_LAUNCHD_DIR: dir });
  const helper = spawn(args[0], args.slice(1), { detached: true, stdio: ['ignore', log, log], env });
  fs.writeFileSync(path.join(dir, 'helper-' + label + '.pid'), String(helper.pid));
  helper.unref();
  process.exit(0);
}
const [domain, user, label] = String(target).split('/');
const loaded = loadedIn(domain + '/' + user, label);
const unknown = !fs.existsSync(path.join(dir, 'known-' + label));
if (verb === 'bootout') {
  record({ label });
  if (!fs.existsSync(loaded)) {
    if (mode === 'slow-unknown' && unknown) pause(10000);
    process.stderr.write('Boot-out failed: 3: No such process\n');
    process.exit(3);
  }
  if (mode === 'stuck') { process.stderr.write('Boot-out failed: 5: Input/output error\n'); process.exit(5); }
  fs.rmSync(loaded);
  const pidFile = path.join(dir, 'helper-' + label + '.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  if (pid && mode !== 'late') {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    const until = Date.now() + 30000;
    while (alive(pid) && Date.now() < until) pause(20);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
}
if (verb === 'print') {
  record({ label });
  if (fs.existsSync(loaded)) { process.stdout.write(target + ' = {\n\tstate = not running\n}\n'); process.exit(0); }
  if (mode === 'slow-unknown' && unknown) pause(10000);
  process.stderr.write('Could not find service "' + label + '" in domain for user\n');
  process.exit(113);
}
record({});
process.exit(64);
`;

// Loaded into the helper by the fake launchctl for the modes that change it.
const PRELOAD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const dir = process.env.FAKE_LAUNCHD_DIR;
const mode = process.env.FAKE_HELPER_MODE;
if (mode === 'hang') pause(60000); // blocked before the helper runs: the bootout's SIGTERM ends it
const unlink = fs.unlinkSync;
fs.unlinkSync = function (file) {
  const r = unlink.call(this, file);
  if (String(file).endsWith('spec.json')) {
    fs.writeFileSync(path.join(dir, 'helper-took'), String(process.pid));
    if (mode === 'late') while (!fs.existsSync(path.join(dir, 'helper-go'))) pause(20);
    if (mode === 'die-early') { process.kill(process.pid, 'SIGKILL'); pause(5000); }
  }
  return r;
};
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  if (mode === 'kill-after-spawn') { process.kill(process.pid, 'SIGKILL'); pause(5000); }
  return child;
};
require('node:module').syncBuiltinESMExports();
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

// A command task's command that records each start (its PID, in `starts`), prints its folder and
// environment, says it is ready, and waits for `release` (or, `quick`, ends at once).
function held(f, name, { quick = false } = {}) {
  const at = (what) => path.join(f.root, `${name}.${what}`);
  const q = (what) => JSON.stringify(at(what));
  const wait = quick ? '' : `; while [ ! -f ${q('release')} ]; do sleep 0.05; done`;
  const script = `echo $$ >> ${q('starts')}; echo "cwd=$(pwd -P)"; echo "secret=$DETACH_SECRET"; echo "outside=$AGENT_ORCH_OUTSIDE"; echo ready > ${q('ready')}${wait}`;
  return {
    argv: ['sh', '-c', script],
    ready: () => eventually(() => fs.existsSync(at('ready')), `${name} did not start`, 20_000),
    release: () => fs.writeFileSync(at('release'), ''),
    starts: () => fs.readFileSync(at('starts'), 'utf8').trim().split('\n'),
  };
}

const startArgs = (run, id, command) => ['start', run.id, id, '--agent', 'command', '--why', WHY, '--json', '--', ...command.argv];

async function startHeld(f, run, id, env, options) {
  const command = held(f, id, options);
  const task = JSON.parse((await f.command(startArgs(run, id, command), { env })).stdout);
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
const listJobs = (f) => (fs.existsSync(jobsFolder(f)) ? fs.readdirSync(jobsFolder(f)) : []);
const minutesAgo = (file, minutes) => { const t = new Date(Date.now() - minutes * 60_000); fs.utimesSync(file, t, t); };

test('the claim script runs the command only when its link creates the answer, with the arguments as given', async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'orch-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = path.join(dir, 'result.json');
  const out = path.join(dir, 'out');
  const claim = (answer, ...command) => spawnSync('/bin/sh', ['-c', CLAIM_SCRIPT, 'detach-start', answer, ...command], { encoding: 'utf8' });
  const record = ['/bin/sh', '-c', 'echo $$ > "$1"; shift; printf "%s|" "$@" >> "$0"', out, out, 'a b', '$HOME', '"q"', ''];
  // No answer yet: the shell's PID is the answer, and is the command's.
  let r = claim(result, ...record);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { pid: Number(fs.readFileSync(out, 'utf8').split('\n')[0]) });
  assert.match(fs.readFileSync(out, 'utf8'), /\na b\|\$HOME\|"q"\|\|$/);
  // An answer exists (the caller's own, say): the command never runs, and the answer is kept.
  fs.rmSync(out);
  fs.writeFileSync(result, '{"cancelled":true}');
  r = claim(result, ...record);
  assert.equal(r.status, 75);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.readFileSync(result, 'utf8'), '{"cancelled":true}');
  // The job's folder is gone: nothing runs, and nothing is printed.
  r = claim(path.join(dir, 'gone', 'result.json'), ...record);
  assert.equal(r.status, 70);
  assert.equal(r.stderr, '');
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['result.json']);
});

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

  // One bootstrap in the gui domain, then the bootout of the same label, checked with print.
  const calls = fake.calls();
  assert.deepEqual(calls.map((c) => [c.verb, c.target.replace(/\/agent-orch\.[0-9a-f]+$/, '/<label>')]),
    [['bootstrap', `gui/${uid}`], ['bootout', `gui/${uid}/<label>`], ['print', `gui/${uid}/<label>`]]);
  assert.equal(calls[0].label, task.launch.label);
  // The job file named only Node, the helper and the spec, and never held the environment; the
  // files were private to the user while they existed, and are all gone now.
  assert.deepEqual(calls[0].modes, { jobs: '700', folder: '700', job: '600', spec: '600' });
  assert.equal(calls[0].args.length, 3);
  assert.equal(calls[0].args[0], process.execPath);
  assert.match(calls[0].args[1], /scripts\/detach-helper\.mjs$/);
  assert.equal(calls[0].args[2], path.join(jobsFolder(f), task.launch.label, 'spec.json'));
  for (const job of fake.jobs()) {
    assert.ok(!job.includes(secret), 'the job file held the environment');
    assert.doesNotMatch(job, /EnvironmentVariables/);
  }
  assert.deepEqual(listJobs(f), []);

  // `result` adds no launch line for a launchd start.
  assert.doesNotMatch((await f.command(['result', run.id, 'job'])).stdout, /^launch:/m);
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
  assert.deepEqual(listJobs(f), []);
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
    assert.deepEqual(listJobs(f), []);
    const shown = (await f.command(['result', run.id, 'direct'])).stdout;
    assert.match(shown, /^launch: direct, not through launchd \(.+\)$/m);
    assert.equal(readJson(f.taskFile(run, 'direct')).launch.reason, task.launch.reason);
    await finish(f, run, task, command);
  });
}

test('a helper that goes on after the caller stopped waiting, and outlives the bootout, starts nothing', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'late', { AGENT_ORCH_LAUNCHD_WAIT: '3s' });
  const run = await f.newRun('late');
  // The helper takes the spec and waits; the caller stops waiting, answers for itself, starts the
  // relay directly and removes the job, while the helper still runs.
  const { task, command } = await startHeld(f, run, 'late', fake.env);
  assert.ok(fs.existsSync(path.join(fake.dir, 'helper-took')), 'the helper did not take the spec');
  assert.deepEqual(task.launch, { how: 'direct', reason: 'launchd gave no answer within 3000 ms' });
  // Now the helper goes on and starts its shell, which finds no place to answer: it runs nothing.
  const helper = Number(fs.readFileSync(path.join(fake.dir, 'helper-took'), 'utf8'));
  fs.writeFileSync(path.join(fake.dir, 'helper-go'), '');
  await eventually(() => !alive(helper), 'the helper did not end', 20_000);
  const label = fake.calls().find((c) => c.verb === 'bootstrap').label;
  await eventually(() => !spawnSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' }).stdout.includes(`detach-start ${path.join(jobsFolder(f), label)}`), 'the shell did not end', 20_000);
  assert.equal(command.starts().length, 1, 'the late helper ran the command too');
  assert.deepEqual(listJobs(f), []);
  await finish(f, run, task, command);
});

test('a helper killed as soon as it has started the shell: the command it ran is the one recorded, and it runs once', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'kill-after-spawn', { AGENT_ORCH_LAUNCHD_WAIT: '3s' });
  const run = await f.newRun('killed');
  // A command that ends at once: nothing of it is left to find when the caller decides.
  const { task, command } = await startHeld(f, run, 'killed', fake.env, { quick: true });
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  await f.finished(run, 'killed');
  assert.equal(command.starts().length, 1, 'the command started more than once');
  assert.deepEqual(listJobs(f), []);
});

test('a helper killed before it started anything: the caller starts directly and never takes another process with the same command line', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'die-early', { AGENT_ORCH_LAUNCHD_WAIT: '3s' });
  const run = await f.newRun('decoy');
  const command = held(f, 'decoy');
  // Once the job is loaded, an unrelated process starts whose command line is exactly the relay's,
  // with launchd as its parent: it must not be taken for the relay.
  let decoy = null;
  t.after(() => { if (decoy && alive(decoy)) process.kill(decoy, 'SIGKILL'); });
  const outDir = path.join(run.dir, 'tasks', 'decoy', 'attempt-1');
  const block = path.join(f.root, 'block.cjs');
  fs.writeFileSync(block, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);\n');
  const starting = f.command(startArgs(run, 'decoy', command), { env: fake.env });
  await eventually(() => fs.existsSync(path.join(fake.dir, 'helper-took')), 'the helper did not take the spec', 20_000);
  const r = spawnSync('/bin/sh', ['-c', '"$@" >/dev/null 2>&1 & echo $!', 'sh', process.execPath, COMMAND_RELAY, '--out-dir', outDir, '--cd', f.repo, '--', ...command.argv],
    { encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: `--require=${block}` } });
  decoy = Number(r.stdout.trim());
  await eventually(() => Number(ps(decoy, 'ppid')) === 1, 'the decoy was not adopted by launchd');
  const task = JSON.parse((await starting).stdout);
  await command.ready();
  assert.notEqual(task.pid, decoy);
  assert.equal(task.launch.how, 'direct', JSON.stringify(task.launch));
  assert.ok(alive(decoy), 'the decoy was touched');
  await finish(f, run, task, command);
});

test('a start that cannot start fails as a direct start does, on either path, and records nothing', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const pausePreload = path.join(f.root, 'pause.cjs');
  // Pauses `start` once the brief is in place, so that the test can remove the task's folder.
  fs.writeFileSync(pausePreload, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const copy = fs.copyFileSync;
fs.copyFileSync = function (from, to, ...rest) {
  const r = copy.call(this, from, to, ...rest);
  const dir = process.env.TEST_PAUSE_DIR;
  if (dir && String(to).endsWith('orch-brief.md')) {
    fs.writeFileSync(path.join(dir, 'paused'), '');
    while (!fs.existsSync(path.join(dir, 'go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return r;
};
`);
  const run = await f.newRun('missing');
  const errors = {};
  for (const [id, env] of [['direct', {}], ['launchd', fakeLaunchd(f).env]]) {
    const cd = path.join(f.root, `cd-${id}`);
    const pauseDir = path.join(f.root, `pause-${id}`);
    fs.mkdirSync(cd);
    fs.mkdirSync(pauseDir);
    const starting = f.command(['start', run.id, id, '--agent', 'claude', '--tier', 'complex', '--why', WHY, '--brief', f.brief(id), '--cd', cd],
      { code: 1, env: { ...env, NODE_OPTIONS: `--require=${pausePreload}`, TEST_PAUSE_DIR: pauseDir } });
    await eventually(() => fs.existsSync(path.join(pauseDir, 'paused')), 'start did not reach its launch', 20_000);
    fs.rmSync(cd, { recursive: true });
    fs.writeFileSync(path.join(pauseDir, 'go'), '');
    const r = await starting;
    errors[id] = (/^orch: task .*$/m.exec(r.stderr)?.[0] || r.stderr).replace(cd, '<cd>').replace(` ${id} `, ' <id> ');
    assert.equal(fs.existsSync(f.taskFile(run, id)), false, 'a task was recorded as started');
    assert.equal(fs.existsSync(path.join(run.dir, 'tasks', id, 'attempt-1')), false);
  }
  assert.match(errors.direct, /^orch: task <id> did not start: cannot start \S+: its working directory does not exist: <cd>$/);
  assert.equal(errors.launchd, errors.direct);
  assert.deepEqual(listJobs(f), []);
});

test('a launchd job that answers without a PID is a failed start, not a started task', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'nopid');
  const run = await f.newRun('nopid');
  const command = held(f, 'nopid');
  const r = await f.command(startArgs(run, 'nopid', command), { code: 1, env: fake.env });
  assert.match(r.stderr, /^orch: task nopid did not start: cannot start \S+: the launchd job answered without a PID$/m);
  assert.equal(fs.existsSync(f.taskFile(run, 'nopid')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'nopid.starts')), false, 'the command ran');
  assert.deepEqual(listJobs(f), []);
});

test('every command deletes a spec that a dead caller left for over a minute, with no launchd start', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(jobsFolder(f), { mode: 0o700 });
  const spec = (label) => path.join(jobsFolder(f), label, 'spec.json');
  for (const label of ['agent-orch.0000000000a1', 'agent-orch.0000000000b2']) {
    fs.mkdirSync(path.dirname(spec(label)), { mode: 0o700 });
    fs.writeFileSync(spec(label), '{"env":{"TOKEN":"left behind"}}', { mode: 0o600 });
  }
  minutesAgo(spec('agent-orch.0000000000a1'), 2);
  await f.newRun('sweep'); // any command; AGENT_ORCH_LAUNCHD=off
  assert.equal(fs.existsSync(spec('agent-orch.0000000000a1')), false, 'a spec older than a minute was kept');
  assert.equal(fs.existsSync(spec('agent-orch.0000000000b2')), true, 'a live start\'s spec was deleted');
});

test('a job that bootout leaves loaded keeps a record of its label alone, which later commands retry until it is gone', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const stuck = fakeLaunchd(f, 'stuck');
  const secret = `secret-${path.basename(f.root)}`;
  const run = await f.newRun('stuck');
  const { task, command } = await startHeld(f, run, 'stuck', { ...stuck.env, DETACH_SECRET: secret });
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  const label = task.launch.label;
  const file = path.join(jobsFolder(f), `${label}.loaded`);
  assert.deepEqual(listJobs(f), [`${label}.loaded`]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { label, domains: [`gui/${uid}`] });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));
  // The same launchd, now able to remove it. A record younger than a minute waits.
  const works = { ...stuck.env, FAKE_LAUNCHD_MODE: 'run' };
  const tries = () => stuck.calls().filter((c) => c.label === label && c.verb === 'bootout').length;
  const before = tries();
  await f.json(['status', run.id], { env: works });
  assert.equal(tries(), before);
  minutesAgo(file, 2);
  await f.json(['status', run.id], { env: works });
  assert.equal(tries(), before + 1);
  assert.ok(stuck.calls().some((c) => c.verb === 'print' && c.target === `gui/${uid}/${label}`));
  assert.deepEqual(listJobs(f), []);
  await finish(f, run, task, command);
});

test('the cleanup of old jobs runs outside the admission lock and within five seconds, leaving what it did not reach', { skip: launchdOnly }, async (t) => {
  const f = await fixture(t);
  const fake = fakeLaunchd(f, 'slow-unknown', { AGENT_ORCH_MAX_TOTAL: '8', FAKE_LOCKS: path.join(f.state, 'admission', 'locks') });
  const run = await f.newRun('slow');
  // Jobs of dead callers, whose bootout and print each take ten seconds.
  fs.mkdirSync(jobsFolder(f), { mode: 0o700 });
  const stale = ['agent-orch.000000000001', 'agent-orch.000000000002', 'agent-orch.000000000003'];
  for (const label of stale) {
    const record = path.join(jobsFolder(f), `${label}.loaded`);
    fs.writeFileSync(record, JSON.stringify({ label, domains: [`gui/${uid}`, `user/${uid}`] }), { mode: 0o600 });
    minutesAgo(record, 10);
    const plist = path.join(jobsFolder(f), `${label}1.plist`);
    fs.writeFileSync(plist, '<plist/>', { mode: 0o600 });
    minutesAgo(plist, 10);
  }
  const begun = Date.now();
  const task = await f.start(run, 'slow', { config: { hold: true }, env: fake.env });
  const took = Date.now() - begun;
  assert.equal(task.launch.how, 'launchd', JSON.stringify(task.launch));
  assert.ok(took < 12_000, `start took ${took} ms`);
  const calls = fake.calls();
  const sweeping = calls.filter((c) => stale.includes(c.label));
  assert.ok(sweeping.length >= 1 && sweeping.length <= 3, JSON.stringify(sweeping));
  for (const call of sweeping) assert.ok(!call.locks?.length, `a cleanup call ran under the admission lock: ${JSON.stringify(call)}`);
  // The start's own job is loaded under the lock, which the fake does see.
  assert.ok(calls.find((c) => c.verb === 'bootstrap').locks?.length, 'the admission lock was not held for the start');
  assert.ok(stale.some((label) => fs.existsSync(path.join(jobsFolder(f), `${label}.loaded`))), 'everything was reached');
  for (const label of stale) assert.equal(fs.existsSync(path.join(jobsFolder(f), `${label}1.plist`)), false);
  await f.ready(task);
  f.release(task);
  await f.finished(run, 'slow');
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
  assert.deepEqual(listJobs(f), []);
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
  assert.deepEqual(listJobs(f), []);
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
  assert.match(ps(task.pid, 'command'), /command-relay\.mjs --out-dir /);
  assert.match(fs.readFileSync(path.join(task.outDir, 'relay.log'), 'utf8'), /^outside=1$/m);
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    const left = spawnSync('launchctl', ['print', `${domain}/${task.launch.label}`], { encoding: 'utf8' });
    assert.notEqual(left.status, 0, `${domain}/${task.launch.label} is still loaded`);
  }
  assert.deepEqual(listJobs(f), []);
  await finish(f, run, task, command);
});
