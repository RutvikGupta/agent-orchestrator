// Reclaim safety: what it may stop, what it must leave, and how it reads the process table.
// Every test confines ps to fixture PIDs, so reclaim never sees or signals a real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fixture, eventually, readJson, writeJson } from './helpers.mjs';
import { daemonDirectory } from '../scripts/lib/reclaim.mjs';

const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export function child(t, bin, args, options) {
  const proc = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.output = ''; proc.errors = '';
  proc.stdout.on('data', (s) => { proc.output += s; });
  proc.stderr.on('data', (s) => { proc.errors += s; });
  proc.done = new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await proc.done; });
  return proc;
}
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;

// Puts fake `ps` and `lsof` first on every fixture command's PATH. `ps -axww` lists only the
// fixture's PIDs; both record the locale they ran with. `restart()` makes every look after the
// next full listing report a different start time, as when a PID is reused.
export function processScope(f) {
  const bin = path.join(f.root, 'bin'), list = path.join(f.root, 'pids'), log = path.join(f.root, 'inspect.log');
  const arm = path.join(f.root, 'restart.armed'), restarted = path.join(f.root, 'restarted');
  fs.mkdirSync(bin); fs.writeFileSync(list, ''); fs.writeFileSync(log, '');
  const record = (name) => `printf '%s LC_ALL=%s LANG=%s\\n' ${name} "$LC_ALL" "$LANG" >> ${quote(log)}\n`;
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\n${record('ps')}`
    + `if [ "$1" = "-axww" ]; then\n shift\n set -- -ww -p "$(cat ${quote(list)})" "$@"\n if [ -e ${quote(arm)} ]; then mv ${quote(arm)} ${quote(restarted)}; exec /bin/ps "$@"; fi\nfi\n`
    + `if [ -e ${quote(restarted)} ]; then /bin/ps "$@" | sed 's/\\(:[0-9][0-9]\\) [0-9][0-9][0-9][0-9] /\\1 1999 /'; exit 0; fi\n`
    + `exec /bin/ps "$@"\n`, { mode: 0o755 });
  const lsof = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).stdout.trim();
  if (lsof) fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\n${record('lsof')}exec ${quote(lsof)} "$@"\n`, { mode: 0o755 });
  const pids = [];
  // Every command of this fixture, its cleanup included, sees only the fixture's processes.
  f.env.PATH = `${bin}:${f.env.PATH}`;
  return {
    add: (pid) => { pids.push(pid); fs.writeFileSync(list, pids.join(',')); },
    log: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    clearLog: () => fs.writeFileSync(log, ''),
    restart: () => fs.writeFileSync(arm, ''),
  };
}

// A long-lived process with a chosen title; `body` runs before it reports ready.
export async function fake(t, f, scope, title, body = '', cwd = f.root) {
  const ready = path.join(f.root, `fake-${process.hrtime.bigint()}.ready`);
  const script = `const fs=require('fs');process.title=${JSON.stringify(title)};${body};fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},10000);`;
  // The padding argument leaves room for a long title on macOS.
  const proc = child(t, process.execPath, ['-e', script, 'padding'.repeat(100)], { cwd, env: f.env });
  scope.add(proc.pid);
  await eventually(() => fs.existsSync(ready) || exited(proc), 'fake process did not start');
  assert.equal(exited(proc), false, proc.errors);
  return proc;
}
const pantsd = (t, f, scope, dir, body) => fake(t, f, scope, `pantsd [${dir}]`, body);
const alive = (proc) => { assert.equal(exited(proc), false); process.kill(proc.pid, 0); };
const dirs = (f, ...names) => names.map((name) => { const dir = path.join(f.root, name); fs.mkdirSync(dir, { recursive: true }); return dir; });

test('reclaim runs ps and lsof in the C locale whatever the caller uses', async (t) => {
  const f = await fixture(t), scope = processScope(f), [dir] = dirs(f, 'workspace');
  const proc = await pantsd(t, f, scope, dir);
  // A process outside the workspace, so reclaim must look up a working directory.
  await fake(t, f, scope, 'bystander');
  scope.clearLog();
  // The fixture's own C locale is overridden, so only reclaim itself can restore it.
  const result = await f.json(['reclaim'], { env: { LANG: 'en_CA.UTF-8', LC_ALL: 'en_CA.UTF-8', LC_TIME: 'fr_FR.UTF-8' } });
  assert.deepEqual(result.daemons.map((d) => [d.pid, d.action]), [[proc.pid, 'stopped']]);
  await proc.done;
  const calls = scope.log();
  assert.ok(calls.some((line) => line.startsWith('ps ')), 'reclaim did not run ps');
  if (process.platform !== 'linux') assert.ok(calls.some((line) => line.startsWith('lsof ')), 'reclaim did not run lsof');
  for (const line of calls) assert.match(line, /^(ps|lsof) LC_ALL=C LANG=C$/);
});

test('reclaim leaves Bazel servers alone and stops only pantsd', async (t) => {
  // No spaces in the workspace: the old matcher accepted exactly this title.
  const f = await fixture(t), scope = processScope(f), [bazelDir, pantsDir] = dirs(f, 'bazel-workspace', 'pants');
  const javaTitle = `/usr/lib/jvm/bin/java -Xverify:none -Dfile.encoding=UTF-8 com.google.devtools.build.lib.bazel.Bazel --max_idle_secs=10800 --output_base=${bazelDir}-out --workspace_directory=${bazelDir} --idle_server_tasks`;
  const serverTitle = `bazel(workspace) -XX:+HeapDumpOnOutOfMemoryError -jar /tmp/install/A-server.jar --max_idle_secs=10800 --output_base=/tmp/out --workspace_directory=/tmp/workspace --idle_server_tasks`;
  assert.equal(daemonDirectory(javaTitle), null);
  assert.equal(daemonDirectory(serverTitle), null);
  const bazel = await fake(t, f, scope, javaTitle);
  const pants = await pantsd(t, f, scope, pantsDir);
  const result = await f.json(['reclaim']);
  assert.deepEqual(result.daemons.map((d) => [d.kind, d.pid, d.action]), [['pantsd', pants.pid, 'stopped']]);
  await pants.done;
  alive(bazel);
});

test('reclaim keeps a daemon inside or around a running task directory', async (t) => {
  const f = await fixture(t), scope = processScope(f), run = await f.newRun();
  const [workspace, sibling] = dirs(f, 'workspace', 'sibling');
  const [taskDir, below] = dirs(f, 'workspace/project', 'workspace/project/sub');
  const task = await f.start(run, 'worker', { config: { hold: true } }); scope.add(task.pid); await f.ready(task);
  writeJson(f.taskFile(run, 'worker'), { ...readJson(f.taskFile(run, 'worker')), cd: taskDir });
  const inner = await pantsd(t, f, scope, below), outer = await pantsd(t, f, scope, workspace), other = await pantsd(t, f, scope, sibling);
  const result = await f.json(['reclaim', '--dry-run']);
  const byPid = new Map(result.daemons.map((d) => [d.pid, d]));
  assert.equal(byPid.get(inner.pid).action, 'kept'); assert.equal(byPid.get(inner.pid).reason, 'running task');
  assert.equal(byPid.get(outer.pid).action, 'kept'); assert.equal(byPid.get(outer.pid).reason, 'running task');
  assert.equal(byPid.get(other.pid).action, 'would-stop');
  f.release(task); await f.finished(run, 'worker');
});

test('closing tasks reclaims only the managed worktree inside the run folder', async (t) => {
  const f = await fixture(t), scope = processScope(f), run = await f.newRun();
  const managed = await f.json(['worktree', run.id, 'managed', '--no-prep']);
  const custom = path.join(f.root, 'custom worktree');
  await f.json(['worktree', run.id, 'outside', '--no-prep', '--path', custom]);
  for (const id of ['main', 'pointed', 'managed', 'outside']) {
    const task = await f.start(run, id); scope.add(task.pid); await f.finished(run, id);
  }
  // A task record whose worktree names the main checkout must not reach it either.
  writeJson(f.taskFile(run, 'pointed'), { ...readJson(f.taskFile(run, 'pointed')), worktree: { path: f.repo, branch: 'main', from: run.baseCommit } });
  assert.equal(readJson(f.taskFile(run, 'main')).cd, f.repo);
  const main = await pantsd(t, f, scope, f.repo), outside = await pantsd(t, f, scope, custom), own = await pantsd(t, f, scope, managed.path);
  await f.command(['close', run.id, 'main', 'pointed', 'outside']);
  alive(main); alive(outside); alive(own);
  const closed = await f.command(['close', run.id, 'managed']);
  await own.done;
  assert.match(closed.stderr, /stopped: pantsd/);
  alive(main); alive(outside);
});

// An owner that starts outside every workspace. `onTerm(dir, exit)` is daemon code: on its first
// SIGTERM it moves the owner into `dir` and waits until the owner is there, then exits if `exit`.
async function mover(t, f, scope) {
  const [target, moved, ready] = ['target', 'moved', 'ready'].map((name) => JSON.stringify(path.join(f.root, `owner.${name}`)));
  const proc = child(t, process.execPath, ['-e', `const fs=require('fs');process.on('SIGUSR2',()=>{process.chdir(fs.readFileSync(${target},'utf8'));fs.writeFileSync(${moved},'')});fs.writeFileSync(${ready},'');setInterval(()=>{},10000)`], { cwd: f.root, env: f.env });
  scope.add(proc.pid);
  await eventually(() => fs.existsSync(JSON.parse(ready)) || exited(proc), 'owner did not start');
  assert.equal(exited(proc), false, proc.errors);
  const onTerm = (dir, exit) => `process.on('SIGTERM',()=>{if(!fs.existsSync(${moved})){fs.writeFileSync(${target},${JSON.stringify(dir)});process.kill(${proc.pid},'SIGUSR2');const end=Date.now()+10000;while(!fs.existsSync(${moved})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}${exit ? 'process.exit(0)' : ''}})`;
  return { proc, onTerm, target: () => fs.readFileSync(JSON.parse(target), 'utf8') };
}

test('reclaim looks again before each stop and protects work that began meanwhile', async (t) => {
  const f = await fixture(t), scope = processScope(f), [first, second] = dirs(f, 'first', 'second');
  const owner = await mover(t, f, scope);
  // Whichever daemon reclaim stops first moves the owner into the other's workspace.
  const daemons = [await pantsd(t, f, scope, first, owner.onTerm(second, true)), await pantsd(t, f, scope, second, owner.onTerm(first, true))];
  const result = await f.json(['reclaim']);
  const stopped = result.daemons.filter((d) => d.action === 'stopped'), kept = result.daemons.filter((d) => d.action === 'kept');
  assert.equal(stopped.length, 1, JSON.stringify(result.daemons));
  assert.equal(kept.length, 1, JSON.stringify(result.daemons));
  assert.equal(kept[0].directory, owner.target());
  assert.equal(kept[0].reason, 'live working directory');
  assert.deepEqual(kept[0].owners, [owner.proc.pid]);
  await daemons.find((d) => d.pid === stopped[0].pid).done;
  alive(daemons.find((d) => d.pid === kept[0].pid));
});

test('reclaim does not escalate to SIGKILL when work begins during the grace period', async (t) => {
  const f = await fixture(t), scope = processScope(f), [dir] = dirs(f, 'workspace');
  const owner = await mover(t, f, scope);
  // The daemon ignores SIGTERM, but the owner is in its workspace before the grace period ends.
  const proc = await pantsd(t, f, scope, dir, owner.onTerm(dir, false));
  const result = await f.json(['reclaim']);
  assert.equal(owner.target(), dir);
  assert.deepEqual(result.daemons.map((d) => [d.pid, d.action, d.reason, d.signal]), [[proc.pid, 'kept', 'live working directory', 'SIGTERM']]);
  assert.deepEqual(result.daemons[0].owners, [owner.proc.pid]);
  assert.equal(result.bytes, 0);
  alive(proc);
});

test('reclaim does not signal a PID whose process changed since its listing', async (t) => {
  const f = await fixture(t), scope = processScope(f), [dir] = dirs(f, 'workspace');
  const proc = await pantsd(t, f, scope, dir);
  scope.restart();
  const result = await f.json(['reclaim']);
  assert.deepEqual(result.daemons.map((d) => [d.pid, d.action]), [[proc.pid, 'gone']]);
  alive(proc);
});


test('reclaim refreshes process membership before stopping even the first daemon', async (t) => {
  const f = await fixture(t), scope = processScope(f), [dir] = dirs(f, 'workspace');
  const daemon = await pantsd(t, f, scope, dir);
  const bin = path.join(f.root, 'bin'), saved = path.join(bin, 'ps-original');
  fs.renameSync(path.join(bin, 'ps'), saved);
  const listed = path.join(f.root, 'listed'), release = path.join(f.root, 'continue');
  const script = path.join(f.root, 'ps-gate.cjs');
  fs.writeFileSync(script, `const fs=require('fs'),{spawnSync}=require('child_process');const args=process.argv.slice(2),r=spawnSync(${JSON.stringify(saved)},args,{encoding:'utf8'});if(args[0]==='-axww'&&!fs.existsSync(${JSON.stringify(listed)})){fs.writeFileSync(${JSON.stringify(listed)},'');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const pending = f.json(['reclaim']);
  try {
    await eventually(() => fs.existsSync(listed), 'initial process listing did not finish');
    // This PID did not exist in the discovery snapshot. It must be in the stop-time survey.
    await fake(t, f, scope, 'new-owner', '', dir);
  } finally { fs.writeFileSync(release, ''); }
  const result = await pending;
  assert.deepEqual(result.daemons.map((d) => [d.pid, d.action, d.reason]), [[daemon.pid, 'kept', 'live working directory']]);
  alive(daemon);
});
