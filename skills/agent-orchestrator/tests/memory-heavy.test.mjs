// Heavy lane regressions: signal forwarding without duplicates or SIGKILL, unwritable or obstructed
// lane storage, nested calls, suspended, dead or PID-reused holders, waiters and lock owners, memory
// readings and pressure, and spacing between admissions. Every wrapper and command is stopped by
// its exact PID (a command by its own process group, after checking that it leads it and runs this
// test's stub); the stand-in processes are children of this test, stopped by their own PIDs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, eventually, readJson } from './helpers.mjs';
import { parseMemory, darwinAvailable, memoryPressure, rampMs, sameStart, sameProcess, lockStart } from '../scripts/lib/heavy.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const node = process.execPath;

// The command stub writes its PID to `ready` once its handlers are installed and exits when
// `release` appears. `int` logs each SIGINT and exits 130 on release. `term` logs each SIGTERM,
// then cleans up for six seconds, longer than the five-second SIGKILL the wrapper used to send,
// and ends by SIGTERM. A one-minute limit keeps a stub from outliving a broken test.
const STUB = `
const fs = require('fs'), path = require('path');
const [mode, dir] = process.argv.slice(2), at = (n) => path.join(dir, n);
const log = (s) => fs.appendFileSync(at('signals'), s + '\\n');
setTimeout(() => process.exit(99), 60000).unref();
if (mode === 'int') process.on('SIGINT', () => log('SIGINT'));
if (mode === 'term') process.on('SIGTERM', () => {
  log('SIGTERM');
  setTimeout(() => { fs.writeFileSync(at('cleaned'), ''); process.removeAllListeners('SIGTERM'); process.kill(process.pid, 'SIGTERM'); }, 6000);
});
fs.watchFile(at('release'), { interval: 20 }, () => {
  if (!fs.existsSync(at('release'))) return;
  fs.unwatchFile(at('release'));
  process.exit(mode === 'int' ? 130 : 0);
});
fs.writeFileSync(at('ready'), String(process.pid));
`;

// Loaded into the wrapper only (other Node processes skip it). TEST_HEAVY_KILLS logs every
// signal the wrapper sends. TEST_HEAVY_FAULT=op:CODE:N fails that fs call on the lane after N
// successful ones, as a sandbox or read-only disk would. TEST_HEAVY_STOP_AT stops the wrapper
// inside the lane lock the first time it writes a matching file. TEST_HEAVY_STOP_AFTER_LINK=VALUE
// stops it right after it first creates a lock symlink with that target ("choosing").
const PRELOAD = `
if (process.argv[1] && process.argv[1].endsWith('orch.mjs')) {
  const fs = require('fs'), path = require('path'), env = process.env;
  if (env.TEST_HEAVY_KILLS) {
    const real = process.kill;
    process.kill = function (pid, sig) {
      const result = real.apply(process, arguments);
      if (sig && sig !== 0) fs.appendFileSync(env.TEST_HEAVY_KILLS, pid + ' ' + sig + '\\n');
      return result;
    };
  }
  if (env.TEST_HEAVY_FAULT) {
    const [op, code, allowed] = env.TEST_HEAVY_FAULT.split(':');
    const lane = path.join(env.AGENT_ORCH_HOME, 'heavy'), real = fs[op];
    let calls = 0;
    fs[op] = function (...args) {
      const target = String(op === 'symlinkSync' ? args[1] : args[0]);
      if ((target === lane || target.startsWith(lane + path.sep)) && ++calls > Number(allowed)) {
        const syscall = op.replace(/Sync$/, '').replace('writeFile', 'open');
        throw Object.assign(new Error(code + ': simulated failure, ' + syscall + " '" + target + "'"), { code, errno: -1, syscall, path: target });
      }
      return real.apply(this, args);
    };
  }
  if (env.TEST_HEAVY_STOP_AFTER_LINK) {
    const real = fs.symlinkSync;
    let done = false;
    fs.symlinkSync = function (target, file, ...rest) {
      const result = real.call(fs, target, file, ...rest);
      if (!done && target === env.TEST_HEAVY_STOP_AFTER_LINK && String(file).includes(path.join('heavy', 'locks'))) {
        done = true;
        fs.writeFileSync(env.TEST_HEAVY_STOPPED, '');
        process.kill(process.pid, 'SIGSTOP');
      }
      return result;
    };
  }
  if (env.TEST_HEAVY_STOP_AT) {
    const real = fs.writeFileSync;
    let done = false;
    fs.writeFileSync = function (file, ...rest) {
      if (!done && String(file).includes(env.TEST_HEAVY_STOP_AT)) {
        done = true;
        real.call(fs, env.TEST_HEAVY_STOPPED, '');
        process.kill(process.pid, 'SIGSTOP');
      }
      return real.call(fs, file, ...rest);
    };
  }
}
`;

const exists = (file) => fs.existsSync(file);
const text = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const ps = (pid, fields) => spawnSync('ps', ['-o', `${fields}=`, '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const stopped = (pid) => ps(pid, 'stat').startsWith('T');
const pgid = (pid) => Number(ps(pid, 'pgid'));
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
function atomicWrite(file, value) {
  fs.writeFileSync(`${file}.tmp`, value);
  fs.renameSync(`${file}.tmp`, file);
}

// Stop a command only by its own process group, and only after checking that it leads that
// group and that its command line names this test's folder.
function stopGroup(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const m = /^\s*(\d+)\s+(.*)$/.exec(spawnSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  if (m && Number(m[1]) === pid && m[2].includes(marker)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
}
function stopPid(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (ps(pid, 'command').includes(marker)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function laneRows(f) {
  const dir = path.join(f.state, 'heavy');
  try { return fs.readdirSync(dir).filter((n) => /^\d+-.*\.json$/.test(n)).map((n) => readJson(path.join(dir, n))); } catch { return []; }
}
const row = (f, label) => laneRows(f).find((r) => r.label === label);
const queued = (f, label) => eventually(() => { const r = row(f, label); return r?.state === 'waiting' && r; }, `${label} did not queue`);

// A fixture whose cleanup runs before the fixture removes its folder (hooks run in the order
// they are registered), with a ps that answers only PID queries: a process-table snapshot is
// empty, so nothing here can see, let alone signal, the user's own processes.
async function laneFixture(t) {
  const cleanups = [];
  let f = null;
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    // Anything still in the lane: commands by their verified group, wrappers by verified PID.
    for (const r of f ? laneRows(f) : []) { stopGroup(r.childPid, f.root); stopPid(r.pid, cli); }
  });
  f = await fixture(t);
  f.cleanups = cleanups;
  f.bin = path.join(f.root, 'bin');
  fs.mkdirSync(f.bin);
  fs.writeFileSync(path.join(f.bin, 'ps'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-p" ] && exec /bin/ps "$@"; done\nexit 0\n', { mode: 0o755 });
  f.stub = path.join(f.root, 'stub.cjs');
  fs.writeFileSync(f.stub, STUB);
  f.preload = path.join(f.root, 'preload.cjs');
  fs.writeFileSync(f.preload, PRELOAD);
  // Deterministic memory by default: low free memory, normal pressure, no spacing.
  f.laneEnv = (extra = {}) => ({
    ...f.env, PATH: `${f.bin}:${f.env.PATH}`, AGENT_ORCH_HEAVY_FREE_BYTES: '0',
    AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '0', AGENT_ORCH_HEAVY_RAMP_MS: '0', ...extra,
  });
  return f;
}

let serial = 0;
function heavy(f, name, { mode = 'hold', env = {}, detached = false } = {}) {
  const dir = path.join(f.root, `command-${++serial}`);
  fs.mkdirSync(dir);
  const proc = spawn(node, [cli, 'heavy', '--label', name, '--', node, f.stub, mode, dir], {
    cwd: f.repo, env: f.laneEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached,
  });
  proc.errors = '';
  proc.stderr.on('data', (s) => { proc.errors += s; });
  proc.stdout.resume();
  proc.done = new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', (code, signal) => resolve({ code, signal })); });
  // `close` also waits for the pipes, which an orphaned command keeps open after its wrapper dies.
  proc.exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const item = {
    proc, dir, pid: proc.pid, cpid: null,
    async ready() {
      item.cpid = Number(await eventually(() => text(path.join(dir, 'ready')), `${name} did not run: ${proc.errors}`));
      return item.cpid;
    },
    release: () => fs.writeFileSync(path.join(dir, 'release'), ''),
    signals: () => text(path.join(dir, 'signals')),
  };
  f.cleanups.push(async () => {
    stopGroup(Number(text(path.join(dir, 'ready'))), dir);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await proc.done;
  });
  return item;
}

// A live process that does nothing, to stand in for a stopped lock owner.
async function sleeper(f) {
  const ready = path.join(f.root, `sleeper-${++serial}`);
  const proc = spawn(node, ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, '');setInterval(() => {}, 1000);setTimeout(() => process.exit(99), 60000)`], { stdio: 'ignore' });
  const done = new Promise((resolve) => proc.on('close', resolve));
  f.cleanups.push(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await done; });
  await eventually(() => exists(ready), 'sleeper did not start');
  return { proc, done };
}

// A process's start time as the lane records it: ps under the C locale and UTC, whatever TZ is set.
const lstart = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }).stdout.trim();
const FORMER = 'Mon Jan  1 00:00:00 2001'; // the start time of a process that held a PID before it was reused
const hourAgo = () => new Date(Date.now() - 3600000).toISOString();
// The same start time moved by whole seconds, in ps's format.
function shifted(start, seconds) {
  const d = new Date(Date.parse(`${start} UTC`) + seconds * 1000), pad = (n) => String(n).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
// A lock file name: PID-UUID, with the start time's text in hex appended when the lock names one.
const hex = (start) => Buffer.from(start, 'utf8').toString('hex');
const lockFile = (locks, pid, n, start) => path.join(locks, `${pid}-00000000-0000-4000-8000-00000000000${n}${start ? `-${hex(start)}` : ''}`);
// How a reader from before start times reads the bakery: any file named like `PID-UUID...` is a
// contender, and its symlink target is "choosing" or the ticket. This is that code's logic, verbatim.
const OLD_CONTENDER = /^\d+-[a-f0-9-]+$/;
function oldReader(locks) {
  return fs.readdirSync(locks).filter((n) => OLD_CONTENDER.test(n)).map((name) => {
    const value = fs.readlinkSync(path.join(locks, name));
    return { name, pid: Number(name.split('-')[0]), ticket: value === 'choosing' ? null : Number(value) };
  });
}
const oldWaits = (tickets, ticket, name) => tickets.some((r) => r.ticket === null || r.ticket < ticket || (r.ticket === ticket && r.name < name));
const present = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };
const untouched = (pid) => assert.doesNotThrow(() => process.kill(pid, 0), 'the live process was signaled or lost');
const kill = async (owner) => { owner.proc.kill('SIGKILL'); await owner.done; };
const heavyStatus = (f) => JSON.parse(spawnSync(node, ['--input-type=module', '-e',
  `import { heavyStatus } from ${JSON.stringify(new URL('../scripts/lib/heavy.mjs', import.meta.url).href)};console.log(JSON.stringify(heavyStatus()))`],
  { env: f.env, encoding: 'utf8' }).stdout);

// A lane entry written by hand, for a process this test controls.
function seed(f, ticket, pid, fields) {
  const dir = path.join(f.state, 'heavy');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticket}-${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ticket, pid, label: `seed ${ticket}`, state: 'waiting', queuedAt: new Date().toISOString(), ...fields }));
  return file;
}

// Start a command beside hand-written records, with no free memory, and see whether they hold it.
// `holds` is what it prints while held. Held, it must not run until the owners are gone; not held,
// it runs at once without waiting.
async function beside(f, holds, owners, held, during = () => {}) {
  const item = heavy(f, 'beside');
  if (held) {
    await eventually(() => holds.test(item.proc.errors), `a live owner's record did not hold the command: ${item.proc.errors}`);
    assert.equal(exists(path.join(item.dir, 'ready')), false);
    during();
    for (const owner of owners) await kill(owner);
  }
  await item.ready();
  if (!held) assert.doesNotMatch(item.proc.errors, /waiting/);
  item.release();
  assert.equal((await item.proc.done).code, 0);
}

const vmStat = ({ free, speculative, inactive, purgeable }) =>
  `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${free}.\nPages active: 1000.\nPages inactive: ${inactive}.\nPages speculative: ${speculative}.\nPages purgeable: ${purgeable}.\nPages occupied by compressor: 99999.\n`;

test('heavy forwards a SIGINT sent to its process group to the command exactly once', async (t) => {
  const f = await laneFixture(t), kills = path.join(f.root, 'kills');
  // The wrapper leads its own group here, as a foreground job does in a terminal.
  const item = heavy(f, 'group', { mode: 'int', detached: true, env: { NODE_OPTIONS: `--require=${f.preload}`, TEST_HEAVY_KILLS: kills } });
  const cpid = await item.ready();
  // The command leads a separate group, so a signal to the wrapper's group cannot reach it directly.
  assert.equal(pgid(cpid), cpid);
  assert.equal(pgid(item.pid), item.pid);
  process.kill(-item.pid, 'SIGINT');
  await eventually(() => text(kills).includes(`-${cpid} SIGINT`), 'the wrapper did not forward SIGINT');
  await eventually(() => item.signals().includes('SIGINT'), 'the command did not receive SIGINT');
  item.release();
  assert.deepEqual(await item.proc.done, { code: 130, signal: null });
  assert.equal(item.signals(), 'SIGINT\n');
  assert.equal(text(kills).match(/SIGINT/g).length, 1);
  assert.doesNotMatch(text(kills), /SIGKILL/);
});

test('heavy waits for a command that needs more than five seconds to clean up after SIGTERM', async (t) => {
  const f = await laneFixture(t);
  const item = heavy(f, 'slow cleanup', { mode: 'term' });
  const cpid = await item.ready();
  item.proc.kill('SIGTERM'); // the wrapper only
  // The stub ends by SIGTERM after six seconds of cleanup: 128 + 15, and its cleanup completed.
  assert.deepEqual(await item.proc.done, { code: 143, signal: null });
  assert.ok(exists(path.join(item.dir, 'cleaned')), 'the command was killed before its cleanup finished');
  assert.equal(item.signals(), 'SIGTERM\n');
  assert.ok(gone(cpid));
});

test('heavy runs the command exactly once when lane storage cannot be written', async (t) => {
  const f = await laneFixture(t), count = path.join(f.root, 'count');
  const command = [node, '-e', `require('fs').appendFileSync(${JSON.stringify(count)}, 'ran\\n');process.stdout.write('direct output');process.exit(7)`];
  const run = (fault, code) => f.command(['heavy', '--label', 'storage', '--', ...command], {
    code, env: f.laneEnv({ NODE_OPTIONS: `--require=${f.preload}`, TEST_HEAVY_FAULT: fault }),
  });
  // Before queueing, after queueing (the admission lock), and after the command started.
  for (const [fault, notes] of [['mkdirSync:EPERM:0', 1], ['symlinkSync:EROFS:2', 1], ['writeFileSync:EACCES:2', 0]]) {
    fs.rmSync(count, { force: true });
    const result = await run(fault, 7);
    assert.equal(text(count), 'ran\n', fault);
    assert.match(result.stdout, /direct output/);
    assert.equal((result.stderr.match(/lane skipped/g) || []).length, notes, `${fault}\n${result.stderr}`);
    assert.equal(laneRows(f).length, 0, fault);
  }
  // Other failures are real errors, not a reason to bypass the lane.
  fs.rmSync(count, { force: true });
  const failed = await run('mkdirSync:EIO:0', 2);
  assert.match(failed.stderr, /EIO/);
  assert.equal(exists(count), false);
});

test('a file where the lane or its locks folder belongs runs the command once, with one note', async (t) => {
  const f = await laneFixture(t), count = path.join(f.root, 'count'), lane = path.join(f.state, 'heavy');
  const command = [node, '-e', `require('fs').appendFileSync(${JSON.stringify(count)}, 'ran\\n');process.stdout.write('direct output');process.exit(7)`];
  const obstructions = [
    ['a file at the lane folder', lane, 'ENOTDIR', () => {}],
    ['a file at the locks folder', path.join(lane, 'locks'), 'EEXIST', () => fs.mkdirSync(lane)],
  ];
  for (const [name, obstruction, code, prepare] of obstructions) {
    fs.rmSync(lane, { recursive: true, force: true });
    fs.rmSync(count, { force: true });
    prepare();
    fs.writeFileSync(obstruction, 'not a folder');
    const result = await f.command(['heavy', '--label', 'obstructed', '--', ...command], { code: 7, env: f.laneEnv() });
    assert.equal(text(count), 'ran\n', name);
    assert.match(result.stdout, /direct output/);
    assert.equal((result.stderr.match(/lane skipped/g) || []).length, 1, `${name}\n${result.stderr}`);
    assert.match(result.stderr, new RegExp(`lane skipped \\(${code}:`), name);
    assert.equal(text(obstruction), 'not a folder', `${name}: the obstructing file was changed`);
  }
});

test('Linux memory is MemAvailable, never Inactive, with a conservative fallback without it', () => {
  const meminfo = (values) => Object.entries(values).map(([name, kb]) => `${name}:${String(kb).padStart(12)} kB`).join('\n') + '\n';
  const common = { MemTotal: 16000000, Active: 400, Inactive: 9000, 'Inactive(anon)': 8000, 'Inactive(file)': 1000, Cached: 7000, SwapCached: 6000 };
  // The kernel's estimate wins, whatever else is listed.
  assert.equal(parseMemory(meminfo({ ...common, MemFree: 10, SReclaimable: 3, MemAvailable: 999 }), 'linux'), 999 * 1024);
  assert.equal(parseMemory(meminfo({ ...common, MemFree: 10, SReclaimable: 3, MemAvailable: 0 }), 'linux'), 0);
  // Without it: MemFree plus SReclaimable; Inactive, Cached and the rest never count.
  assert.equal(parseMemory(meminfo({ ...common, MemFree: 10, SReclaimable: 3 }), 'linux'), 13 * 1024);
  // Without a slab figure: MemFree alone.
  assert.equal(parseMemory(meminfo({ ...common, MemFree: 10 }), 'linux'), 10 * 1024);
  // An unreadable MemAvailable is the same as a missing one.
  assert.equal(parseMemory('MemFree: 10 kB\nMemAvailable: n/a\nSReclaimable: 3 kB\nInactive: 20 kB\n', 'linux'), 13 * 1024);
  assert.equal(parseMemory(meminfo({ ...common, SReclaimable: 3 }), 'linux'), 0);
  assert.equal(parseMemory('invalid', 'linux'), 0);
});

test('a heavy call inside a heavy command runs at once and passes the marker on', async (t) => {
  const f = await laneFixture(t), out = path.join(f.root, 'nested.json'), lane = path.join(f.state, 'heavy');
  const inner = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({marker:process.env.AGENT_ORCH_HEAVY_ACTIVE,rows:fs.readdirSync(${JSON.stringify(lane)}).filter((n)=>/^\\d+-.*\\.json$/.test(n)).length}));process.exit(5)`;
  const outer = `const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(cli)},'heavy','--label','inner','--',process.execPath,'-e',${JSON.stringify(inner)}],{stdio:'inherit'});process.exit(r.status===null?99:r.status)`;
  // At low memory, an inner call that queued would wait for its own outer command forever.
  const result = await f.command(['heavy', '--label', 'outer', '--', node, '-e', outer], { code: 5, env: f.laneEnv() });
  assert.deepEqual(readJson(out), { marker: '1', rows: 1 });
  assert.doesNotMatch(result.stderr, /waiting/);
  assert.equal(laneRows(f).length, 0);
});

test('a suspended holder or waiter does not block the lane and resumes without breaking admission', async (t) => {
  const f = await laneFixture(t);
  const a = heavy(f, 'a');
  await a.ready();
  const b = heavy(f, 'b');
  await queued(f, 'b');
  // Ctrl-Z stops the command's group, then the wrapper. The holder keeps its entry.
  process.kill(a.pid, 'SIGTSTP');
  await eventually(() => stopped(a.pid) && stopped(a.cpid), 'job control did not suspend the holder');
  await b.ready();
  assert.equal(row(f, 'a').state, 'running');
  const c = heavy(f, 'c');
  await queued(f, 'c');
  process.kill(c.pid, 'SIGSTOP');
  await eventually(() => stopped(c.pid), 'waiter did not stop');
  const d = heavy(f, 'd');
  await queued(f, 'd');
  b.release();
  assert.equal((await b.proc.done).code, 0);
  await d.ready(); // past the stopped waiter, beside the suspended holder
  assert.equal(row(f, 'c').state, 'waiting');
  process.kill(a.pid, 'SIGCONT');
  process.kill(c.pid, 'SIGCONT');
  await eventually(() => !stopped(a.cpid) && !stopped(c.pid), 'SIGCONT did not resume the holder and its command');
  assert.deepEqual(Object.fromEntries(laneRows(f).map((r) => [r.label, r.state])), { a: 'running', c: 'waiting', d: 'running' });
  // Resumed, the holder counts again; the waiter stays queued while a command runs.
  a.release();
  assert.equal((await a.proc.done).code, 0);
  assert.equal(row(f, 'c').state, 'waiting');
  d.release();
  assert.equal((await d.proc.done).code, 0);
  await c.ready();
  c.release();
  assert.equal((await c.proc.done).code, 0);
  assert.equal(laneRows(f).length, 0);
});

test('a dead wrapper whose command still runs does not block the lane', async (t) => {
  const f = await laneFixture(t);
  const a = heavy(f, 'orphaned');
  const cpid = await a.ready();
  const b = heavy(f, 'next');
  await queued(f, 'next');
  a.proc.kill('SIGKILL');
  assert.deepEqual(await a.proc.exited, { code: null, signal: 'SIGKILL' });
  await b.ready();
  assert.equal(gone(cpid), false, 'the orphaned command should still run');
  a.release();
  await eventually(() => gone(cpid), 'orphaned command did not exit');
  await a.proc.done;
  b.release();
  assert.equal((await b.proc.done).code, 0);
  assert.equal(laneRows(f).length, 0);
});

test('a stopped lock owner does not block the lane and withdraws when it resumes', async (t) => {
  const f = await laneFixture(t), locks = path.join(f.state, 'heavy', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  // A stopped process with an unfinished choice and an earlier ticket would block every contender.
  const owner = await sleeper(f);
  process.kill(owner.proc.pid, 'SIGSTOP');
  await eventually(() => stopped(owner.proc.pid), 'lock owner did not stop');
  const files = ['choosing', '1'].map((value, i) => {
    const file = path.join(locks, `${owner.proc.pid}-00000000-0000-4000-8000-00000000000${i}`);
    fs.symlinkSync(value, file);
    return file;
  });
  await f.command(['heavy', '--label', 'past a stopped lock', '--', node, '-e', 'process.exit(4)'], { code: 4, env: f.laneEnv() });
  // Its live owner keeps its files, marked revoked so that it withdraws if it resumes.
  for (const file of files) assert.ok(fs.lstatSync(file).isSymbolicLink() && exists(`${file}.revoked`));
  owner.proc.kill('SIGKILL');
  await owner.done;

  // A real wrapper stopped inside the lock: the next arrival enters past it and runs. Resumed,
  // the first notices its revoked place, queues again with a new ticket, and runs afterwards.
  const marker = path.join(f.root, 'stopped-in-lock');
  const first = heavy(f, 'first', { env: { NODE_OPTIONS: `--require=${f.preload}`, TEST_HEAVY_STOP_AT: 'sequence.json', TEST_HEAVY_STOPPED: marker } });
  await eventually(() => exists(marker) && stopped(first.pid), 'wrapper did not stop inside the lock');
  const second = heavy(f, 'second');
  await second.ready();
  process.kill(first.pid, 'SIGCONT');
  const waiting = await queued(f, 'first');
  assert.ok(waiting.ticket > row(f, 'second').ticket);
  second.release();
  assert.equal((await second.proc.done).code, 0);
  await first.ready();
  first.release();
  assert.equal((await first.proc.done).code, 0);
  assert.equal(laneRows(f).length, 0);
});

test('an empty lane always admits; with a command running, only critical pressure and low memory hold', async (t) => {
  const f = await laneFixture(t), roomy = { AGENT_ORCH_HEAVY_FREE_BYTES: '999999999999' };
  // No pressure level, no free memory and no spacing keeps a command out of an empty lane.
  for (const level of ['2', '4']) {
    const item = heavy(f, `empty ${level}`, { env: { AGENT_ORCH_HEAVY_PRESSURE_LEVEL: level, AGENT_ORCH_HEAVY_FREE_BYTES: '0', AGENT_ORCH_HEAVY_RAMP_MS: '600000' } });
    await item.ready();
    assert.doesNotMatch(item.proc.errors, /waiting/);
    item.release();
    assert.equal((await item.proc.done).code, 0);
  }
  const a = heavy(f, 'a');
  await a.ready();
  // Warning pressure admits beside a running command when there is room, and holds when there is not.
  const low = heavy(f, 'warning, no room', { env: { AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '2' } });
  await eventually(() => low.proc.errors.includes('waiting for memory'), `warning pressure did not wait for memory: ${low.proc.errors}`);
  assert.doesNotMatch(low.proc.errors, /pressure level/);
  low.proc.kill('SIGTERM');
  assert.deepEqual(await low.proc.done, { code: 143, signal: null });
  const b = heavy(f, 'warning', { env: { ...roomy, AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '2' } });
  await b.ready();
  // Critical pressure holds the next command while any command runs, and releases it into the empty lane.
  const c = heavy(f, 'critical', { env: { ...roomy, AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '4' } });
  await eventually(() => c.proc.errors.includes('memory pressure level 4'), `critical pressure did not hold the command: ${c.proc.errors}`);
  assert.equal(exists(path.join(c.dir, 'ready')), false);
  a.release();
  assert.equal((await a.proc.done).code, 0);
  assert.equal(exists(path.join(c.dir, 'ready')), false, 'b still runs');
  b.release();
  assert.equal((await b.proc.done).code, 0);
  await c.ready();
  c.release();
  assert.equal((await c.proc.done).code, 0);
  assert.equal(laneRows(f).length, 0);
});

test('macOS memory readings: kernel estimate, vm_stat fallback, pressure and spacing settings', () => {
  const read = (values) => (name) => values[name] ?? null;
  const memsize = '17179869184';
  assert.equal(darwinAvailable(read({ 'kern.memorystatus_level': '36', 'hw.memsize': memsize })), Math.floor(17179869184 * 0.36));
  assert.equal(darwinAvailable(read({ 'hw.memsize': memsize })), null);
  assert.equal(darwinAvailable(read({ 'kern.memorystatus_level': 'n/a', 'hw.memsize': memsize })), null);
  assert.equal(darwinAvailable(read({ 'kern.memorystatus_level': '101', 'hw.memsize': memsize })), null);
  // Free and speculative pages only: inactive, purgeable and compressed pages do not count.
  assert.equal(parseMemory(vmStat({ free: 10, speculative: 3, inactive: 20, purgeable: 5 }), 'darwin'), 13 * 16384);
  for (const level of ['1', '2', '4']) assert.equal(memoryPressure(read({ 'kern.memorystatus_vm_pressure_level': level }), {}, 'darwin'), Number(level));
  assert.equal(memoryPressure(read({}), {}, 'darwin'), 0);
  assert.equal(memoryPressure(read({ 'kern.memorystatus_vm_pressure_level': '4' }), { AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '0' }, 'darwin'), 0);
  assert.equal(memoryPressure(read({}), { AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '2' }, 'linux'), 2);
  assert.equal(memoryPressure(read({ 'kern.memorystatus_vm_pressure_level': '4' }), {}, 'linux'), 0);
  assert.equal(rampMs(undefined), 20000);
  assert.equal(rampMs('0'), 0);
  assert.equal(rampMs('1500'), 1500);
  for (const invalid of ['-1', '2s', 'x']) assert.throws(() => rampMs(invalid), /AGENT_ORCH_HEAVY_RAMP_MS/);
});

test('macOS lane uses the kernel estimate, falls back to vm_stat, and holds only under critical pressure', { skip: process.platform !== 'darwin' && 'reads macOS sysctl and vm_stat' }, async (t) => {
  const f = await laneFixture(t), values = path.join(f.root, 'values'), calls = path.join(values, 'calls');
  fs.mkdirSync(values);
  // Fake sysctl and vm_stat that answer from files the test controls, and log each call.
  fs.writeFileSync(path.join(f.bin, 'sysctl'), `#!/bin/sh\n[ "$1" = "-n" ] && shift\necho "$1" >> '${calls}'\n[ -f '${values}'/"$1" ] && exec cat '${values}'/"$1"\necho "sysctl: unknown oid '$1'" >&2\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f.bin, 'vm_stat'), `#!/bin/sh\necho vm_stat >> '${calls}'\nexec cat '${values}/vm_stat'\n`, { mode: 0o755 });
  const set = (entries) => { for (const [name, value] of Object.entries(entries)) atomicWrite(path.join(values, name), value); };
  const vmCalls = () => text(calls).split('\n').filter((l) => l === 'vm_stat').length;
  const env = { AGENT_ORCH_HEAVY_FREE_BYTES: undefined, AGENT_ORCH_HEAVY_PRESSURE_LEVEL: undefined, AGENT_ORCH_HEAVY_MIN_FREE: '1GB' };
  set({ 'hw.memsize': '17179869184', 'kern.memorystatus_level': '50', 'kern.memorystatus_vm_pressure_level': '1', vm_stat: vmStat({ free: 1, speculative: 1, inactive: 1000000, purgeable: 1000000 }) });
  // Half of 16 GiB is available, so the second command starts beside the first; vm_stat's free
  // and speculative pages alone would refuse it.
  const a = heavy(f, 'a', { env });
  await a.ready();
  const b = heavy(f, 'b', { env });
  await b.ready();
  // 1% of 16 GiB is under 1GB: the next command waits for memory.
  set({ 'kern.memorystatus_level': '1' });
  const c = heavy(f, 'c', { env });
  await eventually(() => c.proc.errors.includes('waiting for memory'), `c did not wait: ${c.proc.errors}`);
  // Without the kernel's estimate, vm_stat decides. Two readings mean the first one refused,
  // although inactive and purgeable pages add up to far more than the threshold.
  fs.rmSync(path.join(values, 'kern.memorystatus_level'));
  const before = vmCalls();
  await eventually(() => vmCalls() >= before + 2, 'vm_stat fallback was not read');
  assert.equal(exists(path.join(c.dir, 'ready')), false);
  set({ vm_stat: vmStat({ free: 10000, speculative: 60000, inactive: 0, purgeable: 0 }) }); // about 1.15 GB
  await c.ready();
  for (const item of [a, b, c]) { item.release(); assert.equal((await item.proc.done).code, 0); }
  // An empty lane admits at any pressure and with little memory: nothing running will free any.
  set({ 'kern.memorystatus_vm_pressure_level': '4', 'kern.memorystatus_level': '1' });
  const d = heavy(f, 'd', { env });
  await d.ready();
  assert.doesNotMatch(d.proc.errors, /waiting/);
  // Beside a running command, warning pressure admits when there is room, and critical holds.
  set({ 'kern.memorystatus_vm_pressure_level': '2', 'kern.memorystatus_level': '50' });
  const e = heavy(f, 'e', { env });
  await e.ready();
  set({ 'kern.memorystatus_vm_pressure_level': '4' });
  const g = heavy(f, 'g', { env });
  await eventually(() => g.proc.errors.includes('memory pressure level 4'), `g did not report critical pressure: ${g.proc.errors}`);
  assert.equal(exists(path.join(g.dir, 'ready')), false);
  set({ 'kern.memorystatus_vm_pressure_level': '1' });
  await g.ready();
  for (const item of [d, e, g]) { item.release(); assert.equal((await item.proc.done).code, 0); }
});

test('admissions are spaced across contenders, twenty seconds apart by default', async (t) => {
  const f = await laneFixture(t), admitted = path.join(f.state, 'heavy', 'admitted.json'), roomy = { AGENT_ORCH_HEAVY_FREE_BYTES: '999999999999' };
  const seconds = (item) => Number(/next admission in (\d+)s/.exec(item.proc.errors)?.[1]);
  const a = heavy(f, 'a', { env: { ...roomy, AGENT_ORCH_HEAVY_RAMP_MS: '60000' } });
  await a.ready();
  const first = readJson(admitted);
  assert.equal(first.label, 'a');
  // There is room, but another wrapper was admitted moments ago: the default spacing applies.
  const c = heavy(f, 'default', { env: { ...roomy, AGENT_ORCH_HEAVY_RAMP_MS: undefined } });
  await eventually(() => seconds(c) > 0, `default spacing not applied: ${c.proc.errors}`);
  assert.ok(seconds(c) <= 20, c.proc.errors);
  c.proc.kill('SIGTERM');
  assert.deepEqual(await c.proc.done, { code: 143, signal: null });
  const b = heavy(f, 'b', { env: { ...roomy, AGENT_ORCH_HEAVY_RAMP_MS: '60000' } });
  await eventually(() => seconds(b) > 20, `spacing not applied: ${b.proc.errors}`);
  assert.equal(row(f, 'b').state, 'waiting');
  // Move the shared admission time back a minute, as if the spacing had elapsed.
  atomicWrite(admitted, JSON.stringify({ ...first, at: first.at - 60000 }));
  await b.ready();
  assert.equal(readJson(admitted).label, 'b');
  for (const item of [a, b]) { item.release(); assert.equal((await item.proc.done).code, 0); }
});

test('calls on an empty lane are never spaced, however close together', async (t) => {
  const f = await laneFixture(t), env = { AGENT_ORCH_HEAVY_FREE_BYTES: '999999999999', AGENT_ORCH_HEAVY_RAMP_MS: '600000' };
  // With spacing applied, the second call would wait ten minutes and the helper would kill it at 15 s.
  for (const label of ['first', 'second', 'third']) {
    const result = await f.command(['heavy', '--label', label, '--', node, '-e', 'process.exit(3)'], { code: 3, env: f.laneEnv(env) });
    assert.doesNotMatch(result.stderr, /waiting|next admission/);
  }
  assert.equal(laneRows(f).length, 0);
});

test('spacing follows the command admitted last: it ends with that command, and names it exactly', async (t) => {
  const f = await laneFixture(t), admitted = path.join(f.state, 'heavy', 'admitted.json');
  const roomy = { AGENT_ORCH_HEAVY_FREE_BYTES: '999999999999' }, spaced = { ...roomy, AGENT_ORCH_HEAVY_RAMP_MS: '600000' };
  const a = heavy(f, 'older', { env: roomy });
  await a.ready();
  const b = heavy(f, 'last', { env: roomy });
  await b.ready();
  // The record names the command admitted last, by ticket, wrapper and command, with start times.
  const last = readJson(admitted), brow = row(f, 'last');
  assert.deepEqual(last, { at: last.at, label: 'last', pid: b.pid, ticket: brow.ticket, pidStart: lstart(b.pid), childPid: b.cpid, childPidStart: lstart(b.cpid) });
  b.release();
  assert.equal((await b.proc.done).code, 0);
  // `older` still runs, but the command admitted last has ended: no spacing from it.
  const c = heavy(f, 'after last ended', { env: spaced });
  await c.ready();
  assert.doesNotMatch(c.proc.errors, /next admission/);
  // c now is the command admitted last, and runs: the spacing applies to the next one.
  const d = heavy(f, 'spaced', { env: spaced });
  await eventually(() => /next admission in \d+s/.test(d.proc.errors), `spacing not applied while the last command runs: ${d.proc.errors}`);
  const record = readJson(admitted);
  assert.equal(record.label, 'after last ended');
  // The same record naming another process's command (its start time differs) holds nobody.
  atomicWrite(admitted, JSON.stringify({ ...record, childPidStart: FORMER }));
  await d.ready();
  for (const item of [a, c, d]) { item.release(); assert.equal((await item.proc.done).code, 0); }
});

test('spacing from a record without a ticket applies only to a command that was admitted by then', async (t) => {
  const f = await laneFixture(t), admitted = path.join(f.state, 'heavy', 'admitted.json');
  const roomy = { AGENT_ORCH_HEAVY_FREE_BYTES: '999999999999' }, spaced = { ...roomy, AGENT_ORCH_HEAVY_RAMP_MS: '600000' };
  const a = heavy(f, 'running', { env: roomy });
  await a.ready();
  // Written before the lane named its holder: the wrapper's PID and a time, as older versions did.
  // Still the wrapper's running entry that was started by then: the spacing applies.
  fs.writeFileSync(admitted, JSON.stringify({ at: Date.now(), label: 'running', pid: a.pid }));
  const b = heavy(f, 'held', { env: spaced });
  await eventually(() => /next admission in \d+s/.test(b.proc.errors), `legacy record did not space the next admission: ${b.proc.errors}`);
  // Naming a time before that entry started, it is not that entry's admission: no spacing.
  fs.writeFileSync(admitted, JSON.stringify({ at: Date.now() - 5000, label: 'older', pid: a.pid }));
  await b.ready();
  for (const item of [a, b]) { item.release(); assert.equal((await item.proc.done).code, 0); }
});

test('start times: exact comparison, and trust for a record without one only before it was written', () => {
  const start = 'Fri Nov  6 15:13:13 2026', at = Date.parse(`${start} UTC`);
  assert.equal(shifted(start, 0), start);
  assert.equal(sameStart(start, 'Fri Nov 6 15:13:13 2026'), true); // only ps's padding differs
  for (const seconds of [1, -1, 60]) assert.equal(sameStart(start, shifted(start, seconds)), false, `${seconds}s apart`);
  assert.equal(sameProcess(null, FORMER, 0), true); // ps could not read the process: the PID is trusted
  assert.equal(sameProcess(start, start, 0), true);
  assert.equal(sameProcess(start, shifted(start, 1), at), false);
  assert.equal(sameProcess(start, null, at + 1000), true); // began before the record was written
  assert.equal(sameProcess(start, null, at - 3600000), false); // began an hour after it
  assert.equal(sameProcess(start, null, NaN), true); // no time to compare with
});

test('every lane entry and the admission record carry process start times, whatever TZ the wrapper has', async (t) => {
  const f = await laneFixture(t);
  const a = heavy(f, 'holder', { env: { TZ: 'America/Toronto' } });
  await a.ready();
  const holding = row(f, 'holder');
  assert.equal(holding.pidStart, lstart(a.pid));
  assert.equal(holding.childPidStart, lstart(a.cpid));
  assert.match(holding.pidStart, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  const b = heavy(f, 'waiter', { env: { TZ: 'Asia/Tokyo' } });
  assert.equal((await queued(f, 'waiter')).pidStart, lstart(b.pid));
  assert.equal(row(f, 'holder').pidStart, holding.pidStart, 'the same process records the same time in every wrapper');
  // Existing fields keep their names and meaning; start times are added.
  assert.deepEqual(Object.keys(holding).sort(), ['childPid', 'childPidStart', 'label', 'pid', 'pidStart', 'queuedAt', 'startedAt', 'state', 'ticket']);
  a.release();
  assert.equal((await a.proc.done).code, 0);
  await b.ready();
  b.release();
  assert.equal((await b.proc.done).code, 0);
});

test('a running entry whose wrapper PID was reused does not count, is pruned, and a live one still holds', async (t) => {
  const f = await laneFixture(t);
  // Another process now has the PID the entry names: no start time matches, or the entry predates the process.
  for (const [name, fields] of [
    ['start time differs', (start, pid) => ({ pidStart: FORMER, childPid: pid, childPidStart: FORMER })],
    ['start time one second off', (start, pid) => ({ pidStart: shifted(start, -1), childPid: pid, childPidStart: shifted(start, -1) })],
    ['no start time, written before the process began', (start, pid) => ({ childPid: pid, queuedAt: hourAgo(), startedAt: hourAgo() })],
  ]) {
    const owner = await sleeper(f), pid = owner.proc.pid, file = seed(f, 1, pid, { state: 'running', ...fields(lstart(pid), pid) });
    assert.deepEqual(heavyStatus(f), { running: 0, waiting: 0 }, name);
    assert.equal(exists(file), true, 'a status read must not remove entries');
    await beside(f, /./, [owner], false);
    assert.equal(exists(file), false, `${name}: the entry was not pruned`);
    untouched(pid);
    await kill(owner);
  }
  // The process the entry names: held until it is gone, with a start time or without one.
  for (const [name, fields] of [
    ['start time matches', (start, pid) => ({ pidStart: start, childPid: pid, childPidStart: start })],
    ['no start time, written after the process began', (start, pid) => ({ childPid: pid })],
  ]) {
    const owner = await sleeper(f), pid = owner.proc.pid, file = seed(f, 1, pid, { state: 'running', ...fields(lstart(pid), pid) });
    await beside(f, /waiting for memory/, [owner], true, () => assert.deepEqual(heavyStatus(f), { running: 1, waiting: 1 }, name));
    assert.equal(exists(file), false, `${name}: the entry of a gone process was not pruned`);
  }
});

test('a waiting entry whose PID was reused does not take first place; a live one does', async (t) => {
  const f = await laneFixture(t);
  for (const [name, fields, held] of [
    ['start time differs', () => ({ pidStart: FORMER }), false],
    ['start time one second off', (start) => ({ pidStart: shifted(start, 1) }), false],
    ['no start time, written before the process began', () => ({ queuedAt: hourAgo() }), false],
    ['start time matches', (start) => ({ pidStart: start }), true],
    ['no start time, written after the process began', () => ({}), true],
  ]) {
    const owner = await sleeper(f), pid = owner.proc.pid, file = seed(f, 1, pid, { state: 'waiting', ...fields(lstart(pid)) });
    // An entry that counted would be first in line: the command would queue at place 2 behind it, forever.
    await beside(f, /place 2 \(0 running\)/, [owner], held, () => assert.deepEqual(heavyStatus(f), { running: 0, waiting: 2 }, name));
    assert.equal(exists(file), false, name);
    if (!held) { untouched(pid); await kill(owner); }
  }
});

test('a running entry whose command PID was reused does not count while its wrapper lives', async (t) => {
  const f = await laneFixture(t);
  for (const [name, fields, held] of [
    ['command start time differs', () => ({ childPidStart: FORMER }), false],
    ['command start time one second off', (start) => ({ childPidStart: shifted(start, -1) }), false],
    ['no command start time, started before the process began', () => ({ startedAt: hourAgo() }), false],
    ['command start time matches', (start) => ({ childPidStart: start }), true],
    ['no command start time, started after the process began', () => ({}), true],
  ]) {
    const wrapper = await sleeper(f), command = await sleeper(f);
    const file = seed(f, 1, wrapper.proc.pid, { state: 'running', pidStart: lstart(wrapper.proc.pid), childPid: command.proc.pid, ...fields(lstart(command.proc.pid)) });
    // The wrapper is the one that wrote the entry, so the entry stays; only a live command holds the lane.
    await beside(f, /waiting for memory/, [wrapper, command], held, () => assert.deepEqual(heavyStatus(f), { running: 1, waiting: 1 }, name));
    if (!held) {
      assert.equal(exists(file), true, `${name}: the live wrapper's entry was pruned`);
      untouched(command.proc.pid);
      await kill(wrapper);
      await kill(command);
    }
    fs.rmSync(file, { force: true });
  }
});

test('a lock whose owner PID was reused does not block and is removed; a live owner still holds the lock', async (t) => {
  const f = await laneFixture(t), locks = path.join(f.state, 'heavy', 'locks'), longAgo = new Date(Date.now() - 3600000);
  fs.mkdirSync(locks, { recursive: true });
  // The start time is in the lock's name, so a lock never exists without it. An older name has none.
  for (const [name, target, start, old] of [
    ['choosing, start time differs', 'choosing', () => FORMER, false],
    ['ticket, start time differs', '1', () => FORMER, false],
    ['ticket, start time one second off', '1', (real) => shifted(real, 1), false],
    ['choosing, older name, written before the process began', 'choosing', () => null, true],
    ['ticket, older name, written before the process began', '1', () => null, true],
  ]) {
    const owner = await sleeper(f), pid = owner.proc.pid, file = lockFile(locks, pid, 1, start(lstart(pid)));
    fs.symlinkSync(target, file);
    if (old) fs.lutimesSync(file, longAgo, longAgo);
    // A reader from before start times would wait on this lock for as long as the PID is alive.
    assert.equal(oldWaits(oldReader(locks), 99, 'z'), true, `${name}: an old reader must see the lock as live`);
    await f.command(['heavy', '--label', name, '--', node, '-e', 'process.exit(4)'], { code: 4, env: f.laneEnv() });
    assert.equal(present(file), false, `${name}: the lock of a reused PID was not removed`);
    untouched(pid);
    await kill(owner);
  }
  // A lock of the process that owns it, with its start time or an older name, holds contenders until the owner is gone.
  for (const [name, target, start] of [
    ['choosing, start time matches', 'choosing', (real) => real],
    ['ticket, start time matches', '1', (real) => real],
    ['choosing, older name, written after the process began', 'choosing', () => null],
    ['ticket, older name, written after the process began', '1', () => null],
  ]) {
    const owner = await sleeper(f), pid = owner.proc.pid, file = lockFile(locks, pid, 1, start(lstart(pid)));
    fs.symlinkSync(target, file);
    const item = heavy(f, 'behind a live lock');
    // The contender has published its ticket, in a name that carries its own start time, and waits.
    const own = () => {
      try { return fs.readdirSync(locks).filter((n) => n.startsWith(`${item.pid}-`) && !n.includes('.')).map((n) => [n, fs.readlinkSync(path.join(locks, n))]); } catch { return []; }
    };
    await eventually(() => own().some(([, v]) => /^\d+$/.test(v)), `${name}: the contender did not queue for the lock: ${item.proc.errors}`);
    for (const [lock] of own()) assert.equal(lockStart(lock), lstart(item.pid), `${name}: ${lock}`);
    assert.equal(laneRows(f).length, 0);
    assert.equal(exists(path.join(item.dir, 'ready')), false);
    assert.equal(present(file), true);
    await kill(owner);
    await item.ready();
    item.release();
    assert.equal((await item.proc.done).code, 0);
  }
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('lock files stay readable by readers from before start times, and new ones recover the start time', async (t) => {
  const f = await laneFixture(t), locks = path.join(f.state, 'heavy', 'locks');
  // A wrapper stopped right after it published "choosing", and one stopped inside the lock with its ticket.
  const published = [
    ['choosing', { TEST_HEAVY_STOP_AFTER_LINK: 'choosing' }, null],
    ['its ticket', { TEST_HEAVY_STOP_AT: 'sequence.json' }, 1],
  ];
  for (const [name, hook, ticket] of published) {
    const marker = path.join(f.root, `stopped-${ticket}`);
    const item = heavy(f, name, { env: { NODE_OPTIONS: `--require=${f.preload}`, TEST_HEAVY_STOPPED: marker, ...hook } });
    await eventually(() => exists(marker) && stopped(item.pid), `${name}: the wrapper did not stop`);
    const [lock, ...more] = oldReader(locks);
    assert.equal(more.length, 0);
    // Named PID-UUID-HEX and linked to the literal "choosing" or the ticket, as before.
    assert.equal(lock.pid, item.pid);
    assert.equal(lock.ticket, ticket);
    assert.equal(fs.readlinkSync(path.join(locks, lock.name)), ticket === null ? 'choosing' : String(ticket));
    // An old reader waits for a choosing lock whatever its own ticket, and for a lower ticket.
    assert.equal(oldWaits([lock], 1, 'z'), true);
    if (ticket !== null) {
      assert.equal(oldWaits([lock], ticket, 'z'), true);
      assert.equal(oldWaits([lock], ticket, '0'), false, 'a lower name at the same ticket goes first');
      assert.equal(oldWaits([lock], ticket - 1, 'z'), false, 'a lower ticket goes first');
    }
    // A new reader recovers the start time from the name.
    assert.equal(lockStart(lock.name), lstart(item.pid));
    process.kill(item.pid, 'SIGCONT');
    await item.ready();
    item.release();
    assert.equal((await item.proc.done).code, 0);
  }
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('lock names: only a UUID followed by hex printable text is an identity', () => {
  const uuid = '00000000-0000-4000-8000-000000000001', start = 'Fri Nov  6 15:13:13 2026';
  assert.equal(lockStart(`123-${uuid}-${hex(start)}`), start);
  assert.equal(lockStart(`123-${uuid}`), null); // an older name
  assert.equal(lockStart('123-dead'), null);
  assert.equal(lockStart(`123-${uuid}-${hex(start)}0`), null); // not whole bytes
  assert.equal(lockStart(`123-${uuid}-0001`), null); // not printable text
  assert.equal(lockStart(`123-${uuid}-${uuid}`), null); // hyphens are not hex
  assert.equal(lockStart(`123-${uuid.slice(1)}-${hex(start)}`), null); // not a UUID before it
});

test('without a readable start time of its own, heavy skips the lane with one note and runs the command once', async (t) => {
  const f = await laneFixture(t), count = path.join(f.root, 'count');
  const failing = path.join(f.root, 'failing-ps'), nowhere = path.join(f.root, 'no-ps');
  fs.mkdirSync(failing);
  fs.mkdirSync(nowhere);
  fs.writeFileSync(path.join(failing, 'ps'), '#!/bin/sh\necho "ps: not permitted" >&2\nexit 1\n', { mode: 0o755 });
  const command = [node, '-e', `require('fs').appendFileSync(${JSON.stringify(count)}, 'ran\\n');process.stdout.write('direct output');process.exit(7)`];
  for (const [name, searchPath] of [['ps fails', `${failing}:${f.env.PATH}`], ['ps is missing', nowhere]]) {
    fs.rmSync(count, { force: true });
    const result = await f.command(['heavy', '--label', 'blind', '--', ...command], { code: 7, env: f.laneEnv({ PATH: searchPath }) });
    assert.equal(text(count), 'ran\n', name);
    assert.match(result.stdout, /direct output/);
    assert.equal((result.stderr.match(/lane skipped/g) || []).length, 1, `${name}\n${result.stderr}`);
    assert.match(result.stderr, /start time/);
    // Neither an entry nor a lock, nor the lane's folders, was created.
    assert.equal(exists(path.join(f.state, 'heavy')), false, `${name}: the lane was written`);
  }
});
