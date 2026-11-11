import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson } from './helpers.mjs';

test('fixtures copy the initial repository without sharing writable Git state', async (t) => {
  // Guard against sharing writable state between fixtures. Pinned commit dates
  // mean this also passes with per-fixture git init; it does not enforce reuse.
  const one = await fixture(t);
  const two = await fixture(t);
  assert.equal(await one.git(['rev-parse', 'HEAD']), await two.git(['rev-parse', 'HEAD']));
  await one.git(['config', 'fixture.private', 'one']);
  await one.git(['checkout', '-qb', 'private-branch']);
  fs.writeFileSync(path.join(one.repo, 'README.md'), 'Changed in one fixture.\n');
  assert.equal(await two.git(['branch', '--show-current']), 'main');
  assert.equal(await two.git(['status', '--porcelain']), '');
  assert.equal((await two.git(['config', '--list'])).includes('fixture.private'), false);
});

test('fixture run IDs stay distinct across roots at the same clock and name', async (t) => {
  const one = await fixture(t);
  const two = await fixture(t);
  const preload = path.join(one.root, 'clock.cjs');
  fs.writeFileSync(preload, "const D=Date;global.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-11-09T12:00:00Z']))}static now(){return D.parse('2026-11-09T12:00:00Z')}};");
  const clock = { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  for (const name of [undefined, 'shared-name', 'long-name'.repeat(8)]) {
    const [a, b] = await Promise.all([one.newRun(name, clock), two.newRun(name, clock)]);
    assert.notEqual(a.id, b.id, `name: ${name}`);
    for (const [run, f] of [[a, one], [b, two]]) {
      assert.ok(run.id.endsWith(Buffer.from(path.basename(f.root)).toString('hex')), 'explicit and default names retain the full fixture suffix');
      assert.equal(readJson(path.join(run.dir, 'run.json')).id, run.id);
    }
  }
});

test('fixture cleanup waits for its last finish-notice writer before deleting state', async (t) => {
  const callbacks = [];
  const f = await fixture({ after(callback) { callbacks.push(callback); } });
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-writer-control-'));
  const release = path.join(control, 'release');
  const ready = path.join(control, 'ready');
  const writer = path.join(f.root, 'finish-notice.mjs');
  fs.writeFileSync(path.join(f.state, 'parent-notice.log'), '');
  fs.writeFileSync(writer, `import fs from 'node:fs';
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  fs.writeFileSync(${JSON.stringify(path.join(f.state, 'last-record.json'))}, '{}');
  clearInterval(timer);
}, 10);
setTimeout(() => process.exit(99), 30000).unref();
fs.writeFileSync(${JSON.stringify(ready)}, '');\n`);
  const child = spawn(process.execPath, [writer], { env: f.env, stdio: 'ignore' });
  const ended = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  t.after(async () => {
    fs.writeFileSync(release, '');
    await ended;
    if (fs.existsSync(f.root)) await callbacks[0]();
    fs.rmSync(control, { recursive: true, force: true });
  });
  await eventually(() => fs.existsSync(ready), 'writer did not become ready');
  const cleaning = callbacks[0]();
  try {
    assert.equal(fs.existsSync(f.root), true, 'cleanup must leave state intact while a writer is alive');
  } finally {
    fs.writeFileSync(release, '');
    await cleaning;
  }
  assert.equal(await ended, 0, 'the final write must succeed before deletion');
  assert.equal(fs.existsSync(f.root), false);
});

test('fixture launchers stop at the test worker instead of the user session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  assert.equal(run.orchestrator.agent, 'codex');
  assert.equal(run.orchestrator.pid, process.pid);
  assert.equal(run.orchestrator.sessionId, null);
  assert.ok(run.orchestrator.started);
});

test('test entry point clears session variables and accepts a named file', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'session.test.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict';
import test from 'node:test';
test('clean session', () => {
  for (const key of ['AGENT_ORCH_DEPTH', 'AGENT_ORCH_RUN', 'AGENT_ORCH_TASK', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) assert.equal(process.env[key], undefined, key);
});\n`);
  const script = fileURLToPath(new URL('../../../tools/test.sh', import.meta.url));
  const result = spawnSync('bash', [script, file], { encoding: 'utf8', timeout: 10_000, env: {
    ...f.env, AGENT_ORCH_DEPTH: '3', AGENT_ORCH_RUN: 'parent', AGENT_ORCH_TASK: 'child',
    CLAUDE_CODE_SESSION_ID: 'session', CODEX_THREAD_ID: 'thread',
  } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /clean session/);
});

test('repository test instructions describe the current entry points and fixture behavior', () => {
  for (const location of ['../../../AGENTS.md', '../AGENTS.md', './README.md']) {
    const text = fs.readFileSync(new URL(location, import.meta.url), 'utf8');
    assert.ok(text.includes('bash tools/test.sh'), location);
    assert.ok(text.includes('--quick') && text.includes('<file>...'), location);
    assert.doesNotMatch(text, /node --test tests\//, 'instructions must not direct agents to serial directory imports');
  }
  const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(readme, /process\.title = 'codex'/);
  assert.match(readme, /100 ms/);
  assert.match(readme, /3000 ms/);
  assert.doesNotMatch(readme, /without impersonating a host|preserving the real three-second interval/);
});

test('wait polling defaults to three seconds and accepts a shorter configured interval', async (t) => {
  const f = await fixture(t);
  const config = new URL('../scripts/lib/config.mjs', import.meta.url).href;
  for (const [value, expected] of [[undefined, 3000], ['100', 100], ['0', 3000], ['-1', 3000], ['invalid', 3000]]) {
    const env = { ...f.env };
    delete env.AGENT_ORCH_WAIT_POLL_MS;
    if (value !== undefined) env.AGENT_ORCH_WAIT_POLL_MS = value;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { WAIT_POLL_MS } from ${JSON.stringify(config)}; console.log(WAIT_POLL_MS);`],
      { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), expected, `configured interval: ${value}`);
  }
});

test('test entry point bounds file workers and permits an explicit override', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'node-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../../../tools/test.sh', import.meta.url));
  for (const [extra, workers] of [[{}, 4], [{ AGENT_ORCH_TASK: 'child' }, 2],
    [{ AGENT_ORCH_TASK: 'child', AGENT_ORCH_TEST_CONCURRENCY: '1' }, 1]]) {
    const result = spawnSync('bash', [script, '--quick'], { encoding: 'utf8', timeout: 5000,
      env: { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}`, ...extra } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^--test-concurrency=${workers}$`, 'm'));
  }
  const invalid = spawnSync('bash', [script, '--quick'], { encoding: 'utf8', timeout: 5000,
    env: { ...f.env, AGENT_ORCH_TEST_CONCURRENCY: '0' } });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /positive integer/);
  const all = spawnSync('bash', [script], { encoding: 'utf8', timeout: 5000,
    env: { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}` } });
  assert.equal(all.status, 0, all.stderr);
  const files = all.stdout.trim().split('\n').filter((arg) => arg.startsWith('tests/'));
  const imported = ['memory-heavy.test.mjs', 'memory-reclaim.test.mjs'];
  const expected = fs.readdirSync(new URL('./', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs') && !imported.includes(name)).map((name) => `tests/${name}`);
  assert.deepEqual([...files].sort(), expected.sort(), 'every test group is scheduled exactly once');
  const memory = fs.readFileSync(new URL('./memory.test.mjs', import.meta.url), 'utf8');
  for (const name of imported) assert.ok(memory.includes(`import './${name}'`), `${name} must run through the memory group`);
  assert.ok(files.includes('tests/memory.test.mjs'), 'the memory aggregate is scheduled');
});

for (const [name, config, health, limited] of [
  ['provider error', { finalMessage: 'API Error: 529 overloaded', error: 'claude returned an error result' }, 'transient-error', false],
  ['usage limit', { finalMessage: 'Could not finish.', error: 'Usage limit reached; resets at 20:00 UTC.' }, 'ok', true],
]) {
  test(`status reports the real outcome when ${name} exits between result read and PID check`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const task = await f.start(run, 'race', { config: { ...config, status: 'failed', hold: true } });
    await f.ready(task);
    const json = f.json;
    let raced;
    f.json = async (args, opts) => {
      if (args[0] !== 'status' || raced) return json(args, opts);
      const result = await json(args, { env: {
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./fixtures/finish-during-read.cjs', import.meta.url)))}`,
        TEST_RACE_RESULT: path.join(task.outDir, 'result.json'),
        TEST_RACE_RELEASE: path.join(task.outDir, 'release'),
        TEST_RACE_PID: String(task.pid),
      } });
      raced = result.tasks[0];
      return result;
    };
    const row = await f.finished(run, 'race');
    // describe() reads result.json again when the relay finished between the read and the PID
    // check, so even the forced interleaving reports the real outcome instead of "aborted".
    assert.equal(raced.state, 'failed', 'the forced interleaving no longer yields a stale aborted row');
    assert.equal(raced.result.exitCode, 1);
    assert.equal(raced.health, health);
    assert.equal(row.state, 'failed');
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.health, health);
    assert.equal(row.limitHit, limited);
  });
}
