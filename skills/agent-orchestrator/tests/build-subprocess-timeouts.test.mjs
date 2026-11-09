import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, jsonl, readJson, writeJson } from './helpers.mjs';

// The synchronous `ps`, `lsof` and `git` calls that status, result and the dashboard's build make
// pass a 5-second timeout. A call that times out is a failure, whatever it printed first: each
// caller takes the failure path it already has. No test waits for a real timeout. The commands run
// as black-box children (the CLI, and the dashboard with its fake outside agents) with a Node
// preload, loaded through NODE_OPTIONS, that logs every spawnSync call with its timeout option and,
// for the commands a test names, returns what a timed-out child leaves behind: partial output,
// status null and ETIMEDOUT. The test changes the preload's stubs through a file, so one
// dashboard can see a healthy read, a timed-out one and a recovery.

const PRELOAD = `
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const real = childProcess.spawnSync;
const current = () => { try { return JSON.parse(fs.readFileSync(process.env.TIMEOUT_STUBS, 'utf8')); } catch { return []; } };
childProcess.spawnSync = function spawnSync(command, args, options) {
  const opts = (Array.isArray(args) ? options : args) || {};
  const line = [command, ...(Array.isArray(args) ? args : [])].join(' ');
  // Only a call that passes the 5-second timeout can time out.
  const stub = opts.timeout === 5000 ? current().find((s) => line.includes(s.match)) : undefined;
  if (process.env.TIMEOUT_LOG) {
    fs.appendFileSync(process.env.TIMEOUT_LOG, JSON.stringify({ pid: process.pid, line, timeout: opts.timeout ?? null, timedOut: Boolean(stub) }) + '\\n');
  }
  if (!stub) return real.apply(this, arguments);
  // \`real\`: the command ran and printed everything before it hung; otherwise it printed \`stdout\`.
  const stdout = stub.real ? real.apply(this, arguments).stdout : stub.stdout;
  const error = Object.assign(new Error('spawnSync ' + command + ' ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: null, signal: 'SIGTERM', error };
};
syncBuiltinESMExports();
`;

// The preload for fixture `f`'s children. `env` goes to a command (`{ env }`) or, for the
// dashboard, onto f.env while it starts. `stub` replaces the commands that time out, each as
// { match, stdout } (partial output) or { match, real: true } (the command's whole output).
function preload(f) {
  const file = path.join(f.root, 'timeout-preload.cjs');
  const stubs = path.join(f.root, 'timeout-stubs.json');
  const log = path.join(f.root, 'timeout-calls.jsonl');
  fs.writeFileSync(file, PRELOAD);
  fs.writeFileSync(stubs, '[]');
  fs.writeFileSync(log, '');
  return {
    env: { NODE_OPTIONS: `--require=${JSON.stringify(file)}`, TIMEOUT_STUBS: stubs, TIMEOUT_LOG: log },
    stub(list) {
      fs.writeFileSync(`${stubs}.tmp`, JSON.stringify(list));
      fs.renameSync(`${stubs}.tmp`, stubs); // whole or not at all, for a reader in another process
    },
    reset() { fs.writeFileSync(log, ''); },
    // Every logged call whose command line matches `match` (a string or a RegExp).
    calls(match) {
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((call) => (match instanceof RegExp ? match.test(call.line) : call.line.includes(match)));
    },
  };
}

// The calls ran with the 5-second timeout, and did (or did not) time out.
function assertCalls(calls, { timedOut }, what) {
  assert.ok(calls.length > 0, `${what}: no call was made`);
  for (const call of calls) {
    assert.equal(call.timeout, 5000, `${what}: no 5000 ms timeout on: ${call.line}`);
    assert.equal(call.timedOut, timedOut, `${what}: ${call.line}`);
  }
}

// The preload's environment while `start` runs, so that `start` (a dashboard) inherits it and
// nothing started afterwards does.
async function withPreload(f, probe, start) {
  Object.assign(f.env, probe.env);
  try {
    return await start();
  } finally {
    for (const key of Object.keys(probe.env)) delete f.env[key];
  }
}

// --- git status and rev-parse: result records the checkout ---------------------------------------

const REPORT = `Done.\n\n\`\`\`orch-result\n${JSON.stringify({ outcome: 'done', changed: [], checks: [{ cmd: 'npm test', result: 'pass' }], decisions: [], unresolved: [] })}\n\`\`\`\n`;

test('result records the checkout from git; a timed-out status leaves it dirty-unknown and a timed-out rev-parse leaves no commit', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const probe = preload(f);
  const head = await f.git(['rev-parse', 'HEAD']);
  // Evidence is worked out by `result`, once per task; the report row then shows what it saved.
  async function resultOf(id, stubs) {
    await f.start(run, id, { config: { finalMessage: REPORT } });
    await f.finished(run, id);
    probe.stub(stubs);
    probe.reset();
    await f.command(['result', run.id, id], { env: probe.env });
    return (await f.json(['status', run.id])).tasks.find((row) => row.id === id).report;
  }

  const healthy = await resultOf('healthy', []);
  assert.deepEqual([healthy.commit, healthy.dirty], [head, false]);
  assertCalls(probe.calls('rev-parse HEAD'), { timedOut: false }, 'rev-parse');
  assertCalls(probe.calls('status --porcelain'), { timedOut: false }, 'status');

  // The status printed a dirty file before it hung: it is not trusted, and the tree is unknown.
  const status = await resultOf('status-timeout', [{ match: 'status --porcelain', stdout: ' M partial.txt\n' }]);
  assert.deepEqual([status.commit, status.dirty], [head, null]);
  assertCalls(probe.calls('status --porcelain'), { timedOut: true }, 'status');

  const revParse = await resultOf('head-timeout', [{ match: 'rev-parse HEAD', stdout: '0123abc' }]);
  assert.deepEqual([revParse.commit, revParse.dirty], [null, null]);
  assertCalls(probe.calls('rev-parse HEAD'), { timedOut: true }, 'rev-parse');
  assert.deepEqual(probe.calls('status --porcelain'), [], 'status is not run once HEAD cannot be read');
});

// --- ps: a parked babysitter's watcher and claim --------------------------------------------------

const PARKED = [
  'PARKED: PR #42 waits for a human review',
  'Every check passed; nothing is unpushed.',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');

// A fake gh on PATH serving pull request #42, as in park.test.mjs. Watchers check every second.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

// A babysitter's finished attempt, made to look parked without a watcher: as after a reboot.
async function seeded(f, run, id = 'sit') {
  const task = await f.start(run, id);
  await f.finished(run, id);
  const result = path.join(task.outDir, 'result.json');
  writeJson(result, { ...readJson(result), finalMessage: PARKED });
  const record = { ...readJson(f.taskFile(run, id)), babysit: true, pr: { number: 42, url: 'https://github.com/example/repo/pull/42' } };
  writeJson(f.taskFile(run, id), record);
}

const attemptDir = (run, id) => path.join(run.dir, 'tasks', id, 'attempt-1');
const watcherFiles = (run, id) => fs.readdirSync(attemptDir(run, id)).filter((name) => /^park-watcher-\d+\.json$/.test(name));
const parkedRow = async (f, run, id, opts) => (await f.json(['status', run.id], opts)).tasks.find((row) => row.id === id);

test('status reads the process table with a timeout: a timed-out read starts no watcher for a parked task, a healthy one does', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const probe = preload(f);
  await seeded(f, run);

  // The table printed in full, then the call hung: without a trusted table, no watcher's
  // liveness can be confirmed, so none is started.
  probe.stub([{ match: 'pid=,lstart=,command=', real: true }]);
  const stuck = await parkedRow(f, run, 'sit', { env: probe.env });
  assert.equal(stuck.parked.watcher, 'none');
  assert.deepEqual(watcherFiles(run, 'sit'), []);
  assertCalls(probe.calls('pid=,lstart=,command='), { timedOut: true }, 'process table');

  probe.stub([]);
  probe.reset();
  await parkedRow(f, run, 'sit', { env: probe.env }); // this status starts the watcher
  assert.equal(watcherFiles(run, 'sit').length, 1);
  assertCalls(probe.calls('pid=,lstart=,command='), { timedOut: false }, 'process table');
  await eventually(async () => (await parkedRow(f, run, 'sit')).parked.watcher === 'alive', 'the watcher did not start', 20_000);
});

// This test process as a claim's owner, with its start time as `ps` prints it.
const liveOwner = () => ({
  pid: process.pid,
  started: spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.replace(/\s+/g, ' ').trim(),
});

test('status confirms a claim owner by its start time; a timed-out read leaves the owner unconfirmed, and partial output is no start time', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const probe = preload(f);
  await seeded(f, run);
  const owner = liveOwner();
  const claim = path.join(attemptDir(run, 'sit'), 'park-claim-1.json');
  const held = { by: 'watcher', claimedAt: new Date().toISOString(), owner };
  writeJson(claim, held);
  const read = `-o lstart= -p ${owner.pid}`;

  const healthy = await parkedRow(f, run, 'sit', { env: probe.env });
  assert.deepEqual([healthy.parked.claim, healthy.parked.resuming], ['live', 'watcher']);
  assertCalls(probe.calls(read), { timedOut: false }, 'start time');

  // A start time cut short is not the owner's: trusted, it would read as a reused PID and let
  // the claim be taken over. An unreadable time proves nothing, so the claim stays live.
  probe.stub([{ match: '-o lstart= -p', stdout: 'Sat Nov  9 10:0' }]);
  probe.reset();
  const timedOut = await parkedRow(f, run, 'sit', { env: probe.env });
  assert.deepEqual([timedOut.parked.claim, timedOut.parked.resuming], ['live', 'watcher']);
  assertCalls(probe.calls(read), { timedOut: true }, 'start time');
  assert.deepEqual(watcherFiles(run, 'sit'), [], 'a live claim is never taken over');
  writeJson(claim, { ...held, released: true }); // so that the fixture's close does not wait for this owner
});

// --- the dashboard's scan of outside agents: process table, lsof, environment ---------------------

// A fake agent process, as in external.test.mjs: `claude -p …` with a session file, or
// `codex exec …` holding its rollout open. It writes <fakes>/<name>.pid once it is ready, and exits
// when <fakes>/<name>.stop or <fakes>/all.stop appears, when its parent exits, or when the
// fixture's folder is removed.
const FAKE = `const fs = require('fs');
const path = require('path');
const env = process.env;
const own = (ext) => path.join(env.FAKE_DIR, env.FAKE_NAME + '.' + ext);
if (env.FAKE_SESSION) {
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'sessions', process.pid + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: env.FAKE_SESSION, cwd: env.FAKE_CWD,
    startedAt: Date.now(), kind: 'headless', entrypoint: 'sdk-cli' }));
}
if (env.FAKE_ROLLOUT) fs.openSync(env.FAKE_ROLLOUT, 'a');
fs.writeFileSync(own('tmp'), String(process.pid));
fs.renameSync(own('tmp'), own('pid'));
const parent = process.ppid;
const done = () => process.ppid !== parent || !fs.existsSync(env.FAKE_DIR)
  || fs.existsSync(path.join(env.FAKE_DIR, 'all.stop')) || fs.existsSync(own('stop'));
setInterval(() => { if (done()) process.exit(0); }, 50);
setTimeout(() => process.exit(0), 300000);
`;
const LOAD = 'require(process.env.FAKE_AGENT)'; // no spaces: `ps` output is split on whitespace

const running = (child) => child.exitCode === null && child.signalCode === null;
function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function setup(t) {
  const children = [];
  let dir = null;
  // Registered before the fixture's cleanup, so the fakes stop before it removes its folder.
  t.after(async () => {
    if (!dir) return;
    let pids = [];
    try {
      fs.writeFileSync(path.join(dir, 'all.stop'), '');
      pids = fs.readdirSync(dir).filter((n) => n.endsWith('.pid')).map((n) => Number(fs.readFileSync(path.join(dir, n), 'utf8')));
    } catch {}
    for (const child of children) if (running(child)) child.kill();
    await eventually(() => !children.some(running) && !pids.some(alive), 'fake agents did not exit', 10_000);
  });
  const f = await fixture(t);
  dir = path.join(f.root, 'fakes');
  const bin = path.join(f.root, 'fake-bin');
  const agent = path.join(bin, 'exec');
  fs.mkdirSync(dir);
  fs.mkdirSync(bin);
  fs.writeFileSync(agent, FAKE);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  const start = (argv0, args, name, extra) => {
    const child = spawn(process.execPath, args, { argv0, cwd: bin, stdio: 'ignore', env: { ...f.env, FAKE_AGENT: agent, FAKE_DIR: dir, FAKE_NAME: name, ...extra } });
    child.on('error', () => {});
    children.push(child);
  };
  const fakes = {
    // A headless Claude Code agent whose session file names `session`, started by `AGENT_ORCH_RUN`.
    claude: (name, session) => start('claude', ['-p', LOAD], name, { FAKE_SESSION: session, FAKE_CWD: f.repo, AGENT_ORCH_RUN: 'example-run' }),
    // `codex exec review …`, holding `rollout` open as Codex does while it runs.
    codex: (name, rollout) => start('codex', ['exec', 'review', 'fixture-prompt'], name, { FAKE_ROLLOUT: rollout }),
    // The PIDs of the named fakes, once they are ready.
    ready: (...names) => eventually(() => {
      const pids = {};
      for (const name of names) {
        const file = path.join(dir, `${name}.pid`);
        if (!fs.existsSync(file)) return null;
        pids[name] = Number(fs.readFileSync(file, 'utf8'));
      }
      return pids;
    }, `fake agents did not start: ${names.join(', ')}`, 15_000),
  };
  return { f, fakes };
}

// A Codex rollout, whose first line is the session_meta of `codex exec`.
function rollout(f, id) {
  const timestamp = new Date().toISOString();
  return jsonl(path.join(f.codex, 'sessions', ...timestamp.slice(0, 10).split('-'), `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`), [
    { type: 'session_meta', timestamp, payload: { id, timestamp, cwd: f.repo, originator: 'codex_exec', source: 'exec' } },
  ]);
}

// What the dashboard has recorded of outside agents (<state>/external.jsonl).
function records(f) {
  try {
    return fs.readFileSync(path.join(f.state, 'external.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
// Waits until the dashboard has recorded `keys`. Each build of its state may scan the process
// table, at most every 2 seconds.
const recorded = (board, f, keys) => eventually(async () => {
  await board.json('/api/state');
  const known = records(f).map((r) => r.key);
  return keys.every((key) => known.includes(key));
}, `outside agents were not recorded: ${keys.join(', ')}`, 20_000);
// Waits until at least `count` of `calls()` have been logged, building the dashboard's state
// meanwhile to make it scan again.
const scanned = (board, calls, count, what) => eventually(async () => {
  await board.json('/api/state');
  return calls().length >= count;
}, `the dashboard did not scan ${count} times: ${what}`, 20_000);

test('the dashboard\'s process-table read times out as a failure: no outside agent is found until a read succeeds', async (t) => {
  const { f, fakes } = await setup(t);
  const probe = preload(f);
  const id = randomUUID();
  fakes.codex('codex', rollout(f, id));
  await fakes.ready('codex');
  // Only the start of a table came back before the call hung.
  probe.stub([{ match: 'pid=,ppid=,command=', stdout: '      1     0 launchd\n' }]);
  const board = await withPreload(f, probe, () => f.dashboard());

  const table = () => probe.calls('pid=,ppid=,command=').filter((call) => call.timedOut);
  await scanned(board, table, 2, 'timed-out process table');
  assertCalls(probe.calls('pid=,ppid=,command='), { timedOut: true }, 'process table');
  assert.deepEqual(records(f), [], 'no agent is recorded from a table that timed out');

  probe.stub([]);
  await recorded(board, f, [`codex:${id}`]);
});

test('the dashboard\'s lsof and environment reads time out as failures: the Codex agent is retried, the Claude agent is recorded without the partial environment', async (t) => {
  const { f, fakes } = await setup(t);
  const probe = preload(f);
  const first = { codex: randomUUID(), claude: 'claude-session-1' };
  fakes.codex('codex-1', rollout(f, first.codex));
  fakes.claude('claude-1', first.claude);
  await fakes.ready('codex-1', 'claude-1');
  const board = await withPreload(f, probe, () => f.dashboard());

  // Healthy: the rollout lsof lists is found, and the environment ps prints names who started the agent.
  await recorded(board, f, [`codex:${first.codex}`, `claude:${first.claude}`]);
  assertCalls(probe.calls('lsof -nP'), { timedOut: false }, 'lsof');
  const procEnv = fs.existsSync('/proc/self/environ'); // Linux reads the environment from /proc, not ps
  if (!procEnv) assertCalls(probe.calls('-Eww'), { timedOut: false }, 'environment');
  assert.equal(records(f).find((r) => r.key === `claude:${first.claude}`).parent.run, 'example-run');

  // Both commands printed everything they have, then hung.
  probe.stub([{ match: 'lsof -nP', real: true }, { match: '-Eww', real: true }]);
  probe.reset();
  const second = { codex: randomUUID(), claude: 'claude-session-2' };
  fakes.codex('codex-2', rollout(f, second.codex));
  fakes.claude('claude-2', second.claude);
  const pids = await fakes.ready('codex-2', 'claude-2');
  await recorded(board, f, [`claude:${second.claude}`]);
  const rolloutRead = () => probe.calls(new RegExp(`lsof -nP -Fn -p ${pids['codex-2']}(,|$)`)).filter((call) => call.timedOut);
  await scanned(board, rolloutRead, 2, 'timed-out lsof');
  assertCalls(probe.calls('lsof -nP'), { timedOut: true }, 'lsof');
  assert.ok(!records(f).some((r) => r.key === `codex:${second.codex}`), 'a rollout from a timed-out lsof is not trusted');
  if (!procEnv) {
    assertCalls(probe.calls('-Eww'), { timedOut: true }, 'environment');
    assert.equal(records(f).find((r) => r.key === `claude:${second.claude}`).parent.run, null, 'partial environment output is not trusted');
  }

  // The scan retries the Codex agent once lsof answers again.
  probe.stub([]);
  await recorded(board, f, [`codex:${second.codex}`]);
});
