import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson } from './helpers.mjs';

// The dashboard's build lifecycle: one worker at a time, build deadlines, paced background builds,
// stale boards after failures, and escalation from fresh builds only. The dashboard's server and
// its state worker load PRELOAD, which the test steers through files in a control folder (ctl).
//
// Server: its clock stands still at its start plus the milliseconds in ctl/clock. The timers whose
// callbacks are named in TIMERS never fire on their own: ctl/timers logs each one set, cleared or
// fired, with its delay, and the test fires them. On SIGUSR2 the server runs the commands in ctl/do
// ("check" runs the escalation checks, which otherwise never run; "fire NAME" fires the pending
// timers of that name), then logs to ctl/acks. ctl/watched logs each file event after the server
// handled it, and ctl/sends each build request to a worker. ctl/forkthrow makes the next fork throw;
// ctl/sendthrow, ctl/senderror and ctl/childerror make the next build request throw, fail in its
// callback, or emit an error on the child, while the worker stays alive.
// Worker: ctl/workers logs each worker's PID with the earlier workers still alive when it started,
// ctl/builds each build's start and end, and ctl/ipc each message's field types and attention ids.
// ctl/hang (holding a count) blocks that many builds, and ctl/holdsend blocks the next build after
// it read the board, until ctl/release; ctl/blocked names the hold. ctl/crash makes builds exit 7,
// ctl/fail makes them fail with its text, and ctl/ignoreterm makes workers started while it exists
// ignore SIGTERM.
const TIMERS = ['overdueBuild', 'killWorker', 'pacedBuild', 'answerWaitingRead', 'autoCollect'];
const PRELOAD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const ctl = process.env.TEST_BOARD_CTL;
const at = (name) => path.join(ctl, name);
const has = (name) => fs.existsSync(at(name));
const take = (name) => { try { fs.unlinkSync(at(name)); return true; } catch { return false; } };
const log = (name, line) => fs.appendFileSync(at(name), line + '\n');
const realNow = Date.now;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hold = (name) => {
  fs.writeFileSync(at('blocked'), name);
  while (!has('release')) pause(10);
  take('release');
  take('blocked');
};
if (ctl && process.argv[2] === 'dashboard') {
  const base = realNow();
  Date.now = () => {
    let skew = 0;
    try { skew = Number(fs.readFileSync(at('clock'), 'utf8')) || 0; } catch {}
    return base + skew;
  };
  const controlled = new Set(${JSON.stringify(TIMERS)});
  const pending = new Map();
  let ids = 0;
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== 'function' || !controlled.has(fn.name)) return realSetTimeout.call(this, fn, ms, ...args);
    const id = ++ids;
    const timer = { fakeTimer: id, ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
    pending.set(id, { name: fn.name, fn, args });
    log('timers', 'set ' + id + ' ' + fn.name + ' ' + Math.round(ms));
    return timer;
  };
  globalThis.clearTimeout = function (timer) {
    if (!timer || !timer.fakeTimer) return realClearTimeout.call(this, timer);
    if (pending.delete(timer.fakeTimer)) log('timers', 'clear ' + timer.fakeTimer);
  };
  const checks = [];
  const every = globalThis.setInterval;
  globalThis.setInterval = function (fn, ...rest) {
    if (fn && fn.name === 'checkAttention') {
      checks.push(fn);
      return every(() => {}, 2 ** 30).unref();
    }
    return every.call(this, fn, ...rest);
  };
  process.on('SIGUSR2', () => {
    for (const command of fs.readFileSync(at('do'), 'utf8').split('\n').filter(Boolean)) {
      const [verb, name] = command.split(' ');
      if (verb === 'check') for (const fn of checks) fn();
      if (verb === 'fire') {
        for (const [id, timer] of [...pending]) {
          if (timer.name !== name || !pending.delete(id)) continue;
          log('timers', 'fire ' + id);
          timer.fn(...timer.args);
        }
      }
    }
    log('acks', 'done');
  });
  const watch = fs.watch;
  fs.watch = function (dir, options, listener) {
    return watch.call(this, dir, options, (kind, file) => { listener(kind, file); log('watched', String(file)); });
  };
  const cp = require('node:child_process');
  const fork = cp.fork;
  cp.fork = function (...args) {
    if (take('forkthrow')) throw new Error('injected fork failure');
    const child = fork.apply(this, args);
    const send = child.send;
    child.send = function (message, ...rest) {
      const done = rest.find((x) => typeof x === 'function');
      const mode = ['sendthrow', 'senderror', 'childerror'].find((name) => take(name));
      log('sends', mode || 'build');
      if (mode === 'sendthrow') throw new Error('injected sendthrow');
      if (mode) {
        const error = new Error('injected ' + mode);
        process.nextTick(() => (mode === 'senderror' && done ? done(error) : child.emit('error', error)));
        return false;
      }
      return send.call(this, message, ...rest);
    };
    return child;
  };
  require('node:module').syncBuiltinESMExports();
}
if (ctl && (process.argv[1] || '').endsWith('dashboard-worker.mjs')) {
  const listed = has('workers') ? fs.readFileSync(at('workers'), 'utf8').split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0])) : [];
  const alive = listed.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  log('workers', process.pid + ' ' + alive.join(','));
  if (has('ignoreterm')) process.on('SIGTERM', () => {});
  process.on('message', () => {
    log('builds', 'start ' + process.pid);
    if (has('crash')) process.exit(7);
    if (has('hang')) {
      const left = Number(fs.readFileSync(at('hang'), 'utf8')) || 1;
      if (left > 1) fs.writeFileSync(at('hang'), String(left - 1));
      else take('hang');
      hold('hang');
    }
  });
  const send = process.send;
  process.send = function (message, ...rest) {
    const type = (value) => Array.isArray(value) ? (value.every((x) => typeof x === 'string') ? 'strings' : 'array') : value === null ? 'null' : typeof value;
    const fields = Object.fromEntries(Object.entries(message).map(([key, value]) => [key, type(value)]));
    const attention = typeof message.body === 'string' ? JSON.parse(message.body).flatMap((s) => (s.attention || []).map((a) => a.id)) : null;
    log('ipc', JSON.stringify({ fields, attention }));
    if (take('holdsend')) hold('holdsend');
    log('builds', 'end ' + process.pid);
    return send.call(this, message, ...rest);
  };
  const readdir = fs.readdirSync;
  fs.readdirSync = function (dir, ...rest) {
    if (String(dir) === process.env.TEST_BOARD_RUNS && has('fail')) throw new Error(fs.readFileSync(at('fail'), 'utf8'));
    return readdir.call(this, dir, ...rest);
  };
}
`;

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  assert.notEqual(port, 4777);
  return port;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasMessage = (state, id) => state.some((s) => s.tasks.some((row) => row.inbox?.messages?.some((m) => m.id === id)));
const occurrences = (text, needle) => text.split(needle).length - 1;
const isWorker = (pid) => (spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').includes('dashboard-worker.mjs');

// A fixture and a dashboard loading PRELOAD. `prepare(b)` runs before the dashboard starts (to set
// markers or make tasks); `announced: false` returns once HTTP answers, before the first board.
// `receiver` starts a held task that accepts messages.
async function setup(t, { env = {}, prepare = async () => {}, announced = true, receiver = false } = {}) {
  let child = null, ctl = null;
  // Registered before the fixture's own cleanup, which removes the folders, so it runs first.
  t.after(async () => {
    if (ctl) fs.writeFileSync(path.join(ctl, 'release'), '');
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (child) await eventually(() => child.exitCode !== null || child.signalCode !== null, 'dashboard did not exit');
    // The server kills its worker as it exits; confirm it, and stop by PID one that survived.
    for (const line of ctl && fs.existsSync(path.join(ctl, 'workers')) ? fs.readFileSync(path.join(ctl, 'workers'), 'utf8').split('\n').filter(Boolean) : []) {
      const pid = Number(line.split(' ')[0]);
      if (isWorker(pid)) process.kill(pid, 'SIGKILL');
      await eventually(() => !alive(pid), `worker ${pid} outlived the test`);
    }
  });
  const f = await fixture(t);
  ctl = path.join(f.root, 'ctl');
  fs.mkdirSync(ctl);
  const preload = path.join(f.root, 'board-preload.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const run = await f.newRun('build');
  let task = null;
  if (receiver) {
    task = await f.start(run, 'receiver', { config: { hold: true } });
    await f.ready(task);
  }
  const at = (name) => path.join(ctl, name);
  const lines = (name) => (fs.existsSync(at(name)) ? fs.readFileSync(at(name), 'utf8').split('\n').filter(Boolean) : []);
  let output = '';
  const b = {
    f, run, task, ctl,
    output: () => output,
    touch(name, text = '') { fs.writeFileSync(at(name), text); },
    remove(name) { fs.rmSync(at(name), { force: true }); },
    exists(name) { return fs.existsSync(at(name)); },
    lines,
    // Move the server's clock forward.
    advance(ms) { fs.writeFileSync(at('clock'), String((Number(fs.existsSync(at('clock')) ? fs.readFileSync(at('clock'), 'utf8') : 0) || 0) + ms)); },
    // Run commands in the server ("check", "fire NAME") and wait until it has.
    async control(...commands) {
      const acks = lines('acks').length;
      fs.writeFileSync(at('do'), commands.join('\n'));
      process.kill(child.pid, 'SIGUSR2');
      await eventually(() => lines('acks').length > acks, `the server did not run ${commands.join(', ')}`);
    },
    // Let the board go stale and start a background build: move the clock past every pace, fire
    // a paced build already pending (such as one a message's own file writes asked for), and read.
    async rebuild(ms = 5000) {
      b.advance(ms);
      await b.control('fire pacedBuild');
      return b.state();
    },
    // The server's timers of a name that are still pending: [{ id, ms }].
    pending(name) {
      const open = new Map();
      for (const line of lines('timers')) {
        const [verb, id, timer, ms] = line.split(' ');
        if (verb === 'set' && timer === name) open.set(id, { id: Number(id), ms: Number(ms) });
        else open.delete(id);
      }
      return [...open.values()];
    },
    // Until the server has no build in flight: each build's deadline is set at its start and
    // cleared or fired at its end.
    async settled() {
      await eventually(() => b.pending('overdueBuild').length === 0, 'a build stayed in flight');
      await b.control(); // the deadline is cleared early in the result's handler: let it finish
    },
    sends: () => lines('sends').length,
    workers() {
      return lines('workers').map((line) => {
        const [pid, earlier = ''] = line.split(' ');
        return { pid: Number(pid), earlier: earlier ? earlier.split(',').map(Number) : [] };
      });
    },
    // Each build the workers ran, in order: { pid, ended }.
    builds() {
      const list = [];
      for (const line of lines('builds')) {
        const [kind, pid] = line.split(' ');
        if (kind === 'start') list.push({ pid: Number(pid), ended: false });
        else list.findLast((x) => x.pid === Number(pid) && !x.ended).ended = true;
      }
      return list;
    },
    get(route, ms = 5000) { return fetch(new URL(route, b.url), { signal: AbortSignal.timeout(ms) }); },
    async state() {
      const response = await b.get('/api/state');
      assert.equal(response.status, 200, await response.clone().text());
      return { response, text: await response.text() };
    },
    async post(text) {
      const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
      const response = await fetch(new URL('/api/send', b.url), {
        method: 'POST', headers: { origin: new URL(b.url).origin, 'content-type': 'application/json', 'x-orch-token': token },
        body: JSON.stringify({ run: run.id, task: 'receiver', text }), signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    // A file in the run's folder, once the server has handled its event.
    async write(name) {
      fs.writeFileSync(path.join(run.dir, name), 'x');
      await eventually(() => lines('watched').some((file) => file.endsWith(name)), `${name} was not watched`);
    },
    // An open tab's presence stream; abort it to close the tab.
    async tab() {
      const tab = new AbortController();
      t.after(() => tab.abort());
      const presence = await fetch(new URL('/api/presence', b.url), { signal: tab.signal });
      await presence.body.getReader().read();
      return tab;
    },
  };
  await prepare(b);
  const port = await freePort();
  child = spawn(process.execPath, [cli, 'dashboard', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: f.repo,
    env: {
      ...f.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_BOARD_CTL: ctl, TEST_BOARD_RUNS: path.join(f.state, 'runs'),
      AGENT_ORCH_RECLAIM: 'off', AGENT_ORCH_NOTIFY: 'off', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  b.child = child;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  b.url = `http://127.0.0.1:${port}/`;
  if (announced) {
    await eventually(() => {
      const file = path.join(f.state, 'dashboard.json');
      return fs.existsSync(file) && readJson(file).pid === child.pid;
    }, 'dashboard failed to start');
    b.url = readJson(path.join(f.state, 'dashboard.json')).url;
  } else {
    await eventually(async () => {
      try { return (await b.get('/api/health', 1000)).ok; } catch { return false; }
    }, 'dashboard did not answer');
  }
  return b;
}

test('a bad AGENT_ORCH_BUILD_TIMEOUT stops startup with the usage code', async (t) => {
  const f = await fixture(t);
  const result = await f.command(['dashboard', '--host', '127.0.0.1', '--port', '0'], { code: 2, env: { AGENT_ORCH_BUILD_TIMEOUT: 'soon' } });
  assert.match(result.stderr, /bad duration "soon"/);
  assert.equal(fs.existsSync(path.join(f.state, 'dashboard.json')), false);
});

test('health answers during the first build; state waits 10 seconds for the first board, then answers 503 building, never []', async (t) => {
  const b = await setup(t, {
    announced: false,
    prepare: async (b) => {
      await b.f.start(b.run, 'done', { config: { finalMessage: 'Finished before the dashboard.' } });
      await b.f.finished(b.run, 'done');
      b.touch('hang');
    },
  });
  await eventually(() => b.exists('blocked'), 'the first build did not start');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [300_000], 'the default first-build deadline is 5 minutes');
  const first = b.get('/api/state');
  const [wait] = await eventually(() => b.pending('answerWaitingRead').length && b.pending('answerWaitingRead'), 'the read did not wait');
  assert.equal(wait.ms, 10_000);
  for (let i = 0; i < 5; i++) {
    const health = await b.get('/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).pid, b.child.pid);
  }
  await b.control('fire answerWaitingRead');
  const building = await first;
  assert.equal(building.status, 503);
  assert.deepEqual(await building.json(), { error: 'building' });
  assert.equal(fs.existsSync(path.join(b.f.state, 'dashboard.json')), false, 'startup announced the dashboard before its first board');
  // A read that waits gets the first board as soon as it is built.
  const second = b.get('/api/state');
  await eventually(() => b.pending('answerWaitingRead').length === 1, 'the second read did not wait');
  b.touch('release');
  const board = await second;
  assert.equal(board.status, 200);
  const state = await board.json();
  assert.ok(state.some((s) => s.tasks.some((row) => row.id === 'done')), 'the first board lacks the finished task');
  assert.deepEqual(b.pending('answerWaitingRead'), [], 'the answered read left its timer');
  await eventually(() => fs.existsSync(path.join(b.f.state, 'dashboard.json')), 'startup did not announce the dashboard after its first board');
});

test('stopping the server during a hung first build kills its worker', async (t) => {
  const b = await setup(t, { announced: false, prepare: async (b) => { b.touch('hang'); b.touch('ignoreterm'); } });
  await eventually(() => b.exists('blocked'), 'the first build did not start');
  const [{ pid }] = b.workers();
  assert.ok(alive(pid));
  b.child.kill('SIGTERM');
  await eventually(() => b.child.exitCode !== null || b.child.signalCode !== null, 'the server did not stop');
  // The test's cleanup has not run, and the blocked worker ignores SIGTERM and its IPC channel.
  await eventually(() => !alive(pid), 'the hung worker outlived its server');
});

test('the worker sends only the serialized board; a failed build serves the last board with one-line safe headers until a build succeeds', async (t) => {
  const b = await setup(t);
  const initial = await b.state();
  assert.equal(initial.response.headers.get('x-orch-stale'), null);
  assert.equal(initial.response.headers.get('x-orch-error'), null);
  b.touch('fail', 'first line ünïcode 日本 "quoted"\r\nsecond line\nthird');
  await b.rebuild(7000); // a stale read starts a background build, which fails
  await b.settled();
  const stale = await b.state();
  assert.equal(stale.text, initial.text, 'a failed build must keep serving the last board');
  assert.equal(stale.response.headers.get('x-orch-error'), 'first line ?n?code ?? "quoted"');
  assert.equal(stale.response.headers.get('x-orch-stale'), '7');
  assert.deepEqual(JSON.parse(stale.response.headers.get('x-orch-heavy')), JSON.parse(initial.response.headers.get('x-orch-heavy')));
  b.remove('fail');
  await b.rebuild(7000);
  await b.settled();
  const fresh = await b.state();
  assert.equal(fresh.response.headers.get('x-orch-error'), null);
  assert.equal(fresh.response.headers.get('x-orch-stale'), null);
  assert.ok(Array.isArray(JSON.parse(fresh.text)));
  // Each IPC message was a failure or the serialized board with flat metadata, never a board object.
  const messages = b.lines('ipc').map((line) => JSON.parse(line).fields);
  assert.ok(messages.some((fields) => fields.error) && messages.filter((fields) => fields.body).length >= 2, JSON.stringify(messages));
  for (const fields of messages) {
    if (fields.error) assert.equal(fields.error, 'string');
    else assert.equal(fields.body, 'string');
    for (const [key, type] of Object.entries(fields)) assert.ok(!['object', 'array'].includes(type), `${key} carries ${type} over IPC`);
  }
});

test('a stored message answers 200 even when its rebuild throws', async (t) => {
  const b = await setup(t, { receiver: true });
  const initial = await b.state();
  // Builds crash, and the one automatic retry crashes too, leaving no worker.
  b.touch('crash');
  await b.rebuild();
  await eventually(() => occurrences(b.output(), 'state worker exited (7)') === 2, `two crashes expected:\n${b.output()}`);
  b.remove('crash');
  b.touch('forkthrow');
  const sent = await b.post('stored while the board cannot rebuild');
  assert.ok(sent.id);
  await eventually(() => b.output().includes('dashboard build failed: injected fork failure'), 'the rebuild did not throw');
  const stale = await b.state();
  assert.equal(stale.text, initial.text);
  assert.equal(stale.response.headers.get('x-orch-error'), 'injected fork failure');
  const next = await b.post('and the next one rebuilds');
  await b.settled();
  const fresh = await b.state();
  assert.ok(hasMessage(JSON.parse(fresh.text), sent.id) && hasMessage(JSON.parse(fresh.text), next.id), 'the rebuilt board lacks a message');
  assert.equal(fresh.response.headers.get('x-orch-error'), null);
  b.f.release(b.task);
});

test('an overdue build is stopped with SIGTERM, then SIGKILL; a replacement starts only after it exits, also after successive timeouts', async (t) => {
  const b = await setup(t, { receiver: true, env: { AGENT_ORCH_BUILD_TIMEOUT: '3s' }, prepare: async (b) => b.touch('ignoreterm') });
  const initial = await b.state();
  const [first] = b.workers();
  b.touch('hang');
  await b.rebuild();
  await eventually(() => b.exists('blocked'), 'the build did not hang');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [3000]);
  await b.control('fire overdueBuild');
  await eventually(() => b.output().includes('state build timed out after 3s'), 'the deadline did not stop the build');
  b.remove('ignoreterm'); // later workers honor SIGTERM
  assert.deepEqual(b.pending('killWorker').map((x) => x.ms), [2000]);
  // In its grace period the worker lives on, no other starts, and the cached board stays usable.
  const stale = await b.state();
  assert.equal(stale.text, initial.text);
  assert.equal(stale.response.headers.get('x-orch-error'), 'state build timed out after 3s');
  assert.equal(stale.response.headers.get('x-orch-stale'), '5');
  assert.equal((await b.get('/api/health')).status, 200);
  const sent = await b.post('sent while the hung worker is being stopped');
  assert.ok(alive(first.pid), 'the worker ignoring SIGTERM died before its grace ended');
  assert.equal(b.workers().length, 1, 'a replacement started beside the stopping worker');
  await b.control('fire killWorker');
  await eventually(() => b.output().includes('stopped the dashboard state worker (SIGKILL)'), `the worker was not killed:\n${b.output()}`);
  await eventually(() => b.builds().some((x) => x.pid !== first.pid && x.ended), 'the replacement did not build');
  await b.settled();
  const rebuilt = await b.state();
  assert.ok(hasMessage(JSON.parse(rebuilt.text), sent.id), 'the replacement board lacks the message');
  assert.equal(rebuilt.response.headers.get('x-orch-error'), null);
  b.remove('blocked');

  // Two hung builds in a row: each is stopped at its deadline and replaced without any request.
  b.touch('hang', '2');
  await b.rebuild();
  const count = b.workers().length;
  for (let i = 1; i <= 2; i++) {
    await eventually(() => b.builds().at(-1).pid === b.workers().at(-1).pid && !b.builds().at(-1).ended && b.pending('overdueBuild').length === 1, `hung build ${i} did not start`);
    await b.control('fire overdueBuild');
    await eventually(() => b.workers().length === count + i, `replacement ${i} did not start`);
  }
  await eventually(() => b.builds().at(-1).ended && b.builds().at(-1).pid === b.workers().at(-1).pid, 'the third worker did not finish a build on its own');
  await eventually(() => occurrences(b.output(), 'stopped the dashboard state worker (SIGTERM)') === 2, `two SIGTERM stops expected:\n${b.output()}`);
  for (const w of b.workers()) assert.deepEqual(w.earlier, [], `worker ${w.pid} started while another lived`);
  await b.settled();
  assert.equal((await b.state()).response.headers.get('x-orch-error'), null);
  b.f.release(b.task);
});

test('a read while the build is past its deadline gets the stale headers before the watchdog stops it', async (t) => {
  const b = await setup(t, { env: { AGENT_ORCH_BUILD_TIMEOUT: '60s' } });
  const initial = await b.state();
  b.touch('hang');
  await b.rebuild();
  await eventually(() => b.exists('blocked'), 'the build did not hang');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [60_000]);
  b.advance(59_999);
  assert.equal((await b.state()).response.headers.get('x-orch-error'), null, 'a build within its deadline is no failure');
  b.advance(1); // the deadline passes on the server's clock; the watchdog has not fired
  const overdue = await b.state();
  assert.equal(overdue.text, initial.text);
  assert.equal(overdue.response.headers.get('x-orch-error'), 'state build timed out after 60s');
  assert.equal(overdue.response.headers.get('x-orch-stale'), '65');
  assert.equal(b.pending('overdueBuild').length, 1);
  b.touch('release');
  await b.settled();
  assert.equal((await b.state()).response.headers.get('x-orch-error'), null, 'the finished build did not clear the overdue mark');
});

test('a worker error while its process lives stops that process before another starts', async (t) => {
  const b = await setup(t, { receiver: true, prepare: async (b) => b.touch('ignoreterm') });
  for (const mode of ['childerror', 'senderror', 'sendthrow']) {
    const count = b.workers().length;
    const old = b.workers().at(-1).pid;
    const previous = await b.state();
    b.touch(mode);
    await b.rebuild();
    await eventually(() => b.pending('killWorker').length === 1, `${mode} did not stop the worker`);
    assert.ok(b.lines('sends').includes(mode));
    const sent = await b.post(`sent after ${mode}`);
    const stale = await b.state();
    assert.equal(stale.text, previous.text, `${mode}: the cached board must stay usable`);
    assert.equal(stale.response.headers.get('x-orch-error'), `injected ${mode}`);
    assert.ok(alive(old), `${mode}: the worker ignoring SIGTERM died before its grace ended`);
    assert.equal(b.workers().length, count, `${mode}: a replacement started beside the old worker`);
    await b.control('fire killWorker');
    await eventually(() => b.workers().length === count + 1, `${mode}: no replacement worker`);
    assert.equal(alive(old), false, `${mode}: the old worker survived its replacement`);
    assert.deepEqual(b.workers().at(-1).earlier, [], `${mode}: the replacement started while the old worker lived`);
    await eventually(() => b.builds().at(-1).ended && b.builds().at(-1).pid === b.workers().at(-1).pid, `${mode}: the replacement did not build`);
    await b.settled();
    const fresh = await b.state();
    assert.ok(hasMessage(JSON.parse(fresh.text), sent.id), `${mode}: the replacement board lacks the message`);
    assert.equal(fresh.response.headers.get('x-orch-error'), null);
  }
  await eventually(() => occurrences(b.output(), 'stopped the dashboard state worker (SIGKILL)') === 3, `three SIGKILL stops expected:\n${b.output()}`);
  b.f.release(b.task);
});

test('an escalation check escalates only from a build that started after it, never from an older board', async (t) => {
  const b = await setup(t, {
    prepare: async (b) => {
      // A run started from a terminal has the user as its orchestrator, so its items reach the user.
      b.f.launchingSession(b.run, null, 'terminal');
      for (const id of ['resolved', 'kept']) {
        await b.f.start(b.run, id, { config: { status: 'failed', error: `${id} broke` } });
        await b.f.finished(b.run, id);
      }
    },
  });
  const ledger = () => readJson(path.join(b.f.state, 'escalations.json'));
  const record = (id) => Object.values(ledger()).find((r) => r.task === id);
  // The first board was the first check: both failures are tracked, neither is due yet.
  assert.ok(record('resolved') && record('kept'));
  assert.equal(record('kept').escalatedAt, undefined);
  // Both failures are overdue. A read starts a build that reads both, then waits before it reports.
  b.touch('holdsend');
  await b.rebuild(60 * 60_000);
  await eventually(() => b.exists('blocked'), 'the build did not reach its report');
  await b.f.command(['close', b.run.id, 'resolved']);
  const sends = b.sends();
  await b.control('check'); // the check comes while the older build is still in flight
  assert.equal(b.sends(), sends, 'a check must not start a second build beside the one in flight');
  b.touch('release');
  await b.settled();
  // The older build's board is served, but escalates nothing; the check waits for a paced build.
  assert.equal(record('kept').escalatedAt, undefined, 'a board read before the check escalated');
  const reports = () => b.lines('ipc').map((line) => JSON.parse(line).attention).filter(Boolean);
  assert.ok(reports().at(-1).includes('resolved'), 'the older build should have reported the closed task');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1000]);
  b.advance(1000);
  await b.control('fire pacedBuild');
  assert.equal(b.sends(), sends + 1, 'the check did not ask for a build after the one in flight');
  await eventually(() => record('kept')?.escalatedAt != null, 'the fresh build after the check did not escalate');
  assert.ok(!reports().at(-1).includes('resolved'));
  assert.equal(record('resolved'), undefined, 'a closed task was escalated');
});

test('file writes rebuild only while someone views the board', async (t) => {
  const b = await setup(t);
  // Nobody views: a write asks for no build, while an escalation check still gets its paced one.
  let sends = b.sends();
  await b.write('scratch-1.txt');
  assert.equal(b.sends(), sends, 'a write with no viewer started a build');
  assert.deepEqual(b.pending('pacedBuild'), []);
  await b.control('check');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1000]);
  b.advance(1000);
  await b.control('fire pacedBuild');
  assert.equal(b.sends(), ++sends, 'the check did not build without a viewer');
  await b.settled();

  // An open tab views: a write asks for a build, paced a second after the last one started.
  const tab = await b.tab();
  await b.write('scratch-2.txt');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1000]);
  b.advance(1000);
  await b.control('fire pacedBuild');
  assert.equal(b.sends(), sends + 1, 'the paced build did not start');
  await b.settled();
  tab.abort();
  await eventually(async () => (await (await b.get('/api/health')).json()).tabs === 0, 'the tab did not close');

  // A state read views for 30 seconds. Its board is stale, and the pace allows a build now. (A
  // paced request left by the tab lapses first, since nobody views.)
  b.advance(5000);
  await b.control('fire pacedBuild');
  sends = b.sends();
  await b.state();
  assert.equal(b.sends(), sends + 1, 'a stale read past the pace must start one build at once');
  await b.settled();
  await b.write('scratch-3.txt');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1000]);
  b.advance(1000);
  await b.control('fire pacedBuild');
  assert.equal(b.sends(), sends + 2, 'a write within 30 seconds of a read did not rebuild');
  await b.settled();

  // 30 seconds after the last read, nobody views again, and a pending request lapses.
  b.advance(30_000);
  await b.control('fire pacedBuild');
  sends = b.sends();
  await b.write('scratch-4.txt');
  assert.deepEqual(b.pending('pacedBuild'), []);
  assert.equal(b.sends(), sends, 'a write 30 seconds after the last read started a build');
});

test('background builds wait twice the last build time after it, whatever reads and writes come; a message rebuilds at once', async (t) => {
  const b = await setup(t, { receiver: true });
  await b.tab();
  // A build that takes 3 seconds on the server's clock.
  b.touch('hang');
  await b.rebuild();
  await eventually(() => b.exists('blocked'), 'the build did not start');
  b.advance(3000);
  b.touch('release');
  await b.settled();
  // Reads of the now stale board, writes, and escalation checks ask for one background build, 6
  // seconds after the slow build ended, and start nothing before it.
  b.advance(2500);
  const sends = b.sends();
  for (let i = 1; i <= 3; i++) {
    await b.state();
    await b.write(`steady-${i}.txt`);
    await b.control('check');
  }
  assert.equal(b.sends(), sends, 'reads, writes or checks started a build before its pace');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [3500]);
  b.advance(3499);
  await b.control('fire pacedBuild'); // early: it waits for the rest
  assert.equal(b.sends(), sends);
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1]);
  b.advance(1);
  await b.control('fire pacedBuild');
  assert.equal(b.sends(), sends + 1, 'the paced build did not start');
  await b.settled();
  // That build took no time, so the next waits a second after its start.
  await b.state();
  await b.write('steady-4.txt');
  assert.deepEqual(b.pending('pacedBuild').map((x) => x.ms), [1000]);
  // A message rebuilds at once, and its build replaces the paced one.
  const sent = await b.post('rebuild at once');
  assert.equal(b.sends(), sends + 2, 'the message waited for the pace');
  assert.deepEqual(b.pending('pacedBuild'), []);
  await b.settled();
  assert.ok(hasMessage(JSON.parse((await b.state()).text), sent.id), 'the message never reached the board');
  b.f.release(b.task);
});

test('when the first build fails, state answers 503 with the reason at once, not "building"', async (t) => {
  const b = await setup(t, { announced: false, prepare: async (b) => b.touch('fail', 'cannot read runs\nsecond line') });
  await eventually(() => b.lines('ipc').some((line) => JSON.parse(line).fields.error), 'the first build did not fail');
  const r = await b.get('/api/state');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-orch-error'), 'cannot read runs');
  assert.deepEqual(await r.json(), { error: 'cannot read runs' });
  assert.deepEqual(b.pending('answerWaitingRead'), [], 'a read waited although the reason was known');
});

test('a bad AGENT_ORCH_FIRST_BUILD_TIMEOUT stops startup with the usage code', async (t) => {
  const f = await fixture(t);
  const result = await f.command(['dashboard', '--host', '127.0.0.1', '--port', '0'], { code: 2, env: { AGENT_ORCH_FIRST_BUILD_TIMEOUT: 'later' } });
  assert.match(result.stderr, /bad duration "later"/);
  assert.equal(fs.existsSync(path.join(f.state, 'dashboard.json')), false);
});

test('builds get AGENT_ORCH_FIRST_BUILD_TIMEOUT until a first board exists, a lost first build too, then AGENT_ORCH_BUILD_TIMEOUT; the first limit is never the shorter', async (t) => {
  const b = await setup(t, { announced: false, env: { AGENT_ORCH_BUILD_TIMEOUT: '3s', AGENT_ORCH_FIRST_BUILD_TIMEOUT: '90s' }, prepare: async (b) => b.touch('hang') });
  await eventually(() => b.exists('blocked'), 'the first build did not start');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [90_000]);
  // A read waits for the first board, through the lost build and its replacement.
  const waiting = b.get('/api/state');
  await eventually(() => b.pending('answerWaitingRead').length === 1, 'the read did not wait for the first board');
  await b.control('fire overdueBuild');
  await eventually(() => b.output().includes('state build timed out after 90s'), `the first build was not stopped at its deadline:\n${b.output()}`);
  // Its replacement is a first build too.
  await eventually(() => b.builds().length === 2 && b.pending('overdueBuild').length === 1, 'the replacement did not start');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [90_000]);
  assert.equal((await waiting).status, 200, 'the waiting read did not get the first board');
  await b.settled();
  await eventually(() => fs.existsSync(path.join(b.f.state, 'dashboard.json')), 'the dashboard was not announced after its first board');
  b.remove('blocked');
  b.touch('hang');
  await b.rebuild();
  await eventually(() => b.exists('blocked'), 'the later build did not hang');
  assert.deepEqual(b.pending('overdueBuild').map((x) => x.ms), [3000]);
  b.touch('release');
  await b.settled();

  // A later-build limit longer than the first-build default applies to the first build too.
  const long = await setup(t, { announced: false, env: { AGENT_ORCH_BUILD_TIMEOUT: '10m' }, prepare: async (b) => b.touch('hang') });
  await eventually(() => long.exists('blocked'), 'the first build did not start');
  assert.deepEqual(long.pending('overdueBuild').map((x) => x.ms), [600_000]);
  long.touch('release');
  await long.settled();
});

// A run whose launching session has ended (its PID names no process), idle for three hours, with a
// closed task's clean worktree; or, with `live`, one that this test's own process launched.
async function idleRun(b, name, { live = false } = {}) {
  const run = await b.f.newRun(name);
  const wt = await b.f.json(['worktree', run.id, 'old', '--no-prep']);
  const old = new Date(Date.now() - 3 * 3600000).toISOString();
  const file = b.f.taskFile(run, 'old');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), createdAt: old, closedAt: old, closedExplicitlyAttempt: 0 }));
  fs.utimesSync(file, new Date(old), new Date(old));
  const runFile = path.join(run.dir, 'run.json');
  fs.writeFileSync(runFile, JSON.stringify({ ...readJson(runFile), createdAt: old, orchestrator: { agent: live ? 'codex' : 'claude', sessionId: live ? 'dashboard-session' : 'ended-session', pid: live ? process.pid : 99999999, lastSeenAt: old } }));
  return { run, wt };
}

test('the automatic collection runs five minutes after each pass, as the user whoever started the dashboard, and logs each worktree; AGENT_ORCH_AUTO_GC=off turns it off', async (t) => {
  let ended, live;
  // The dashboard runs in a live session's environment; its collection must not take that
  // session's run for its own. The disk is low, so one hour of rest is enough.
  const session = { CLAUDE_CODE_SESSION_ID: 'dashboard-session', CODEX_THREAD_ID: 'dashboard-session' };
  const b = await setup(t, {
    env: { AGENT_ORCH_DISK_FREE_BYTES: '20GB', ...session },
    prepare: async (b) => { ended = await idleRun(b, 'ended'); live = await idleRun(b, 'live', { live: true }); },
  });
  // The server sets its timers after it announces itself, and prints its address after them.
  await eventually(() => b.output().includes('dashboard: http'), 'the dashboard did not finish starting');
  assert.deepEqual(b.pending('autoCollect').map((x) => x.ms), [300_000]);
  await b.control('fire autoCollect');
  await eventually(() => b.output().includes('auto gc freed'), `the collection did not run:\n${b.output()}`);
  // Once the pass has ended, the next one waits five minutes again.
  await eventually(() => b.pending('autoCollect').length === 1, 'the next collection was not scheduled');
  assert.deepEqual(b.pending('autoCollect').map((x) => x.ms), [300_000]);
  assert.ok(b.output().includes(`orch: auto gc removed worktree ${ended.wt.path} (run ${ended.run.id}, task old, `), b.output());
  assert.match(b.output(), /orch: auto gc freed \S+ \S+ from 1 worktree; disk 20 GB free\n/);
  assert.equal(fs.existsSync(ended.wt.path), false);
  assert.equal(fs.existsSync(live.wt.path), true, 'the collection took the live session\'s worktree');

  const off = await setup(t, { env: { AGENT_ORCH_AUTO_GC: 'off' } });
  await eventually(() => off.output().includes('dashboard: http'), 'the dashboard did not finish starting');
  assert.deepEqual(off.pending('autoCollect'), []);
});
