import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, eventually } from './helpers.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const supported = typeof process.execve === 'function' && process.platform !== 'win32';
function helper(t, f, args, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: f.repo, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (s) => { stdout += s; });
  child.stderr.on('data', (s) => { stderr += s; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  return { child, ended, async parked() {
    await eventually(() => {
      const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
      // The sleep child is the handshake that the shell installed its signal traps.
      return rows.some((row) => Number(row[1]) === child.pid && path.basename(row[3]) === 'sh')
        && rows.some((row) => Number(row[2]) === child.pid && path.basename(row[3]) === 'sleep');
    }, 'helper did not hand its original PID to the shell');
  } };
}
const agentEnv = (run) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'worker' });
async function held(f, config = {}) {
  const run = await f.newRun();
  const task = await f.start(run, 'worker', { config: { hold: true, ...config } });
  await f.ready(task);
  return { run, task };
}

test('parked wait keeps its PID, wakes on completion, and removes its checkpoint', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run, task } = await held(f);
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0', '--json']);
  await wait.parked();
  assert.ok(fs.readdirSync(f.env.TMPDIR).some((name) => name.startsWith('orch-park-')));
  const releasedAt = Date.now();
  f.release(task);
  const out = await wait.ended;
  assert.ok(Date.now() - releasedAt < 1800, 'completion should wake within one shell tick');
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).finished, true);
  assert.equal(fs.readdirSync(f.env.TMPDIR).filter((name) => name.startsWith('orch-park-')).length, 0);
});

test('parked wait preserves its inbox baseline and wakes on a new question', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run } = await held(f);
  await f.command(['send', run.id, 'worker', 'old message']);
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0', '--json'], agentEnv(run));
  await wait.parked();
  await f.command(['ask', 'Which option?', '--options', 'a|b', '--recommend', 'a'], { env: agentEnv(run) });
  const out = await wait.ended;
  assert.equal(out.code, 5, out.stderr);
  assert.equal(JSON.parse(out.stdout).attention[0].kind, 'question');
  assert.equal(JSON.parse(out.stdout).message, undefined);
});

test('parked wait still returns exit 6 for a new caller message', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run } = await held(f);
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0', '--json'], agentEnv(run));
  await wait.parked();
  await f.command(['send', run.id, 'worker', 'new message']);
  const out = await wait.ended;
  assert.equal(out.code, 6, out.stderr);
  assert.equal(JSON.parse(out.stdout).message.text, 'new message');
});

test('parked nap ignores old messages and wakes on a new one', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run } = await held(f);
  await f.command(['send', run.id, 'worker', 'old message']);
  const nap = helper(t, f, ['nap', '20s'], agentEnv(run));
  await nap.parked();
  const sentAt = Date.now();
  await f.command(['send', run.id, 'worker', 'new message']);
  const out = await nap.ended;
  assert.ok(Date.now() - sentAt < 1800, 'message should wake within one shell tick');
  assert.equal(out.code, 6, out.stderr);
  assert.match(out.stdout, /new message/);
  assert.doesNotMatch(out.stdout, /old message/);
});

test('interrupting a parked helper removes its checkpoint', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const nap = helper(t, f, ['nap', '20s']);
  await nap.parked();
  nap.child.kill('SIGTERM');
  const out = await nap.ended;
  assert.equal(out.code === 143 || out.signal === 'SIGTERM', true);
  assert.equal(fs.readdirSync(f.env.TMPDIR).filter((name) => name.startsWith('orch-park-')).length, 0);
});


test('a decision raised while wait is parked still wakes it with attention', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run, task } = await held(f, { finalMessage: 'NEEDS DECISION: Choose A or B.' });
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0', '--json']);
  await wait.parked();
  f.release(task);
  const out = await wait.ended;
  assert.equal(out.code, 5, out.stderr);
  assert.equal(JSON.parse(out.stdout).tasks[0].state, 'needs-decision');
});


test('nap keeps its timer fallback when execve is unavailable', async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.root, 'no-execve.cjs');
  fs.writeFileSync(preload, 'process.execve = undefined;');
  const out = await f.command(['nap', '10ms'], { env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } });
  assert.equal(out.stdout, '');
  assert.equal(out.stderr, '');
  assert.equal(fs.readdirSync(f.env.TMPDIR).filter((name) => name.startsWith('orch-park-')).length, 0);
});


const checkpoints = (f) => fs.readdirSync(f.env.TMPDIR).filter((name) => name.startsWith('orch-park-'));
const sleepPid = (pid) => {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout.split('\n');
  for (const line of rows) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (row && Number(row[2]) === pid && path.basename(row[3]) === 'sleep') return Number(row[1]);
  }
  return null;
};

test('unchanged files stay in the same shell checkpoint across one-second ticks', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run } = await held(f);
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0']);
  await wait.parked();
  const before = checkpoints(f);
  let pid = sleepPid(wait.child.pid);
  for (let tick = 0; tick < 4; tick++) {
    pid = await eventually(() => {
      const next = sleepPid(wait.child.pid);
      return next && next !== pid ? next : null;
    }, 'shell did not advance to its next tick');
    assert.deepEqual(checkpoints(f), before, 'an idle tick must not restart Node');
  }
});

test('park maximum forces a Node recheck without any watched change', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const nap = helper(t, f, ['nap', '20s'], { AGENT_ORCH_PARK_MAX: '2s' });
  await nap.parked();
  const before = checkpoints(f)[0];
  await eventually(() => checkpoints(f).some((name) => name !== before), 'maximum park interval did not resume Node');
});

test('nap deadline takes precedence over a long park maximum', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const startedAt = Date.now();
  const nap = helper(t, f, ['nap', '1.2s'], { AGENT_ORCH_PARK_MAX: '30s' });
  await nap.parked();
  const out = await nap.ended;
  assert.equal(out.code, 0, out.stderr);
  assert.ok(Date.now() - startedAt < 2200, 'nap must not wait for its park maximum');
});

test('same-second inbox updates are seen by macOS sh even when -nt has second precision', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run } = await held(f);
  const nap = helper(t, f, ['nap', '20s'], agentEnv(run));
  await nap.parked();
  const marker = path.join(f.env.TMPDIR, checkpoints(f)[0], 'marker');
  const markerTime = fs.statSync(marker).mtimeMs / 1000;
  const inbox = path.join(run.dir, 'tasks', 'worker', 'inbox.jsonl');
  await f.command(['send', run.id, 'worker', 'same-second message']);
  // Set the append's timestamp to the second in which Node began its snapshot.
  // A marker touched after that snapshot would miss this update on bash 3.2.
  fs.utimesSync(inbox, markerTime + 1.1, markerTime + 1.1);
  const out = await nap.ended;
  assert.equal(out.code, 6, out.stderr);
  assert.match(out.stdout, /same-second message/);
});

test('a relay dying without a result wakes the shell through its PID watch', { skip: !supported }, async (t) => {
  const f = await fixture(t), { run, task } = await held(f);
  const wait = helper(t, f, ['wait', run.id, '--timeout', '0', '--json']);
  await wait.parked();
  const stoppedAt = Date.now();
  process.kill(task.pid, 'SIGKILL');
  const out = await wait.ended;
  assert.ok(Date.now() - stoppedAt < 1800, 'dead relay should wake within one shell tick');
  assert.equal(out.code, 5, out.stderr);
  assert.equal(JSON.parse(out.stdout).tasks[0].state, 'aborted');
});
