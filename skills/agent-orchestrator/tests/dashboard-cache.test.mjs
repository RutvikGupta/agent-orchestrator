import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, eventually } from './helpers.mjs';

// Pause actual worker builds at the run-directory read. The handshake leaves the HTTP
// thread free, and disables file watching so a send must explicitly invalidate the cache.
async function cachedBoard(t) {
  let marker;
  // Release a paused child before fixture teardown, even if an assertion fails.
  t.after(() => { if (marker) fs.writeFileSync(`${marker}.release`, ""); });
  const f = await fixture(t);
  const run = await f.newRun('cache');
  const task = await f.start(run, 'receiver', { config: { hold: true } });
  await f.ready(task);
  marker = path.join(f.root, 'build');
  const preload = path.join(f.root, 'board-preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const isServer = !process.send;
    const marker = ${JSON.stringify(marker)};
    const runs = ${JSON.stringify(path.join(f.state, 'runs'))};
    const readdir = fs.readdirSync;
    fs.readdirSync = function(dir, ...args) {
      if (String(dir) === runs && fs.existsSync(marker + '.armed')) {
        if (isServer) throw new Error('state was built on the HTTP thread');
        fs.appendFileSync(marker + '.started', 'build\\n');
        fs.writeFileSync(marker + '.pid', String(process.pid));
        if (fs.existsSync(marker + '.crash')) {
          fs.unlinkSync(marker + '.crash');
          fs.writeFileSync(marker + '.crashed', String(process.pid));
          process.exit(7);
        }
        if (fs.existsSync(marker + '.hold')) {
          fs.writeFileSync(marker + '.blocked', '');
          const lock = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(marker + '.release')) Atomics.wait(lock, 0, 0, 10);
        }
      }
      return readdir.call(this, dir, ...args);
    };
    const now = Date.now;
    Date.now = () => now() + (fs.existsSync(marker + '.older') ? 3000 : 0);
    if (isServer) fs.watch = () => ({ on() { return this; }, close() {} });
  `);
  f.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  const board = await f.dashboard();
  delete f.env.NODE_OPTIONS;
  const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
  const post = async (text) => {
    const response = await fetch(new URL('/api/send', board.url), {
      method: 'POST', headers: { origin: new URL(board.url).origin, 'content-type': 'application/json', 'x-orch-token': token },
      body: JSON.stringify({ run: run.id, task: 'receiver', text }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const touch = (suffix) => fs.writeFileSync(`${marker}.${suffix}`, '');
  const builds = () => fs.existsSync(`${marker}.started`) ? fs.readFileSync(`${marker}.started`, 'utf8').trim().split('\n').length : 0;
  return { f, run, task, board, marker, touch, builds, post };
}

test('state serves its cache during one worker build; send queues a fresh build without waiting', async (t) => {
  const { f, task, board, marker, touch, builds, post } = await cachedBoard(t);
  const initial = await (await board.get('/api/state')).text();
  touch('armed');
  for (let i = 0; i < 4; i++) assert.equal(await (await board.get('/api/state')).text(), initial);
  assert.equal(builds(), 0, 'fresh polls reuse the completed snapshot');
  touch('hold');
  touch('older'); // expire the main-thread snapshot without a guessed delay
  assert.equal(await (await board.get('/api/state')).text(), initial);
  await eventually(() => fs.existsSync(`${marker}.blocked`), 'worker did not begin the stale rebuild');
  const sent = await post('sent while the board worker is blocked');
  assert.ok(sent.id);
  await Promise.all(Array.from({ length: 10 }, async () => {
    assert.equal(await (await board.get('/api/state')).text(), initial);
    assert.equal((await board.get('/api/health')).status, 200);
  }));
  assert.equal(builds(), 1, 'polls and sends cannot start overlapping builds');
  touch('release');
  await eventually(async () => {
    const state = await board.json('/api/state');
    return state.some((section) => section.tasks.some((row) => row.inbox?.messages?.some((m) => m.id === sent.id)));
  }, 'the queued message never reached the rebuilt state');
  await eventually(() => builds() === 2, 'send during a build must trigger a follow-up build');
  f.release(task);
});

test('send rebuilds a fresh snapshot immediately without file watchers or another state poll', async (t) => {
  const { f, task, board, marker, touch, builds, post } = await cachedBoard(t);
  touch('armed');
  touch('hold');
  const sent = await post('refresh immediately');
  await eventually(() => fs.existsSync(`${marker}.blocked`), 'send waited for a state poll to rebuild');
  assert.equal(builds(), 1);
  touch('release');
  await eventually(async () => (await board.json('/api/state')).some((s) => s.tasks.some((row) => row.inbox?.messages?.some((m) => m.id === sent.id))), 'send was absent from its first rebuild');
  assert.equal(builds(), 1, 'fresh state polling must reuse the send rebuild');
  f.release(task);
});


test('a worker exit preserves cached state while its automatic replacement builds', async (t) => {
  const { f, task, board, marker, touch, post } = await cachedBoard(t);
  const initial = await (await board.get('/api/state')).text();
  touch('armed');
  touch('hold');
  touch('crash');
  const sent = await post('survives a worker exit');
  await eventually(() => fs.existsSync(`${marker}.crashed`), 'worker did not exercise its exit path');
  const oldPid = Number(fs.readFileSync(`${marker}.crashed`, 'utf8'));
  await eventually(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, 'crashed worker still lives');
  await eventually(() => fs.existsSync(`${marker}.blocked`), 'the automatic replacement did not start');
  assert.equal(await (await board.get('/api/state')).text(), initial);
  assert.equal((await board.get('/api/health')).status, 200);
  touch('older');
  touch('release');
  await eventually(async () => (await board.json('/api/state')).some((s) => s.tasks.some((row) => row.inbox?.messages?.some((m) => m.id === sent.id))), 'replacement worker did not rebuild state');
  const nextPid = Number(fs.readFileSync(`${marker}.pid`, 'utf8'));
  assert.notEqual(nextPid, oldPid);
  t.after(async () => {
    await eventually(() => { try { process.kill(nextPid, 0); return false; } catch { return true; } }, 'worker outlived the HTTP server');
  });
  f.release(task);
});


test('a worker configuration error preserves the dashboard startup exit code', async (t) => {
  const f = await fixture(t);
  const result = await f.command(['dashboard', '--host', '127.0.0.1', '--port', '0'], {
    code: 2, env: { AGENT_ORCH_BOARD_IDLE: 'invalid-duration' },
  });
  assert.match(result.stderr, /bad duration "invalid-duration"/);
  assert.equal(fs.existsSync(path.join(f.state, 'dashboard.json')), false);
});
