import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

for (const agent of ['claude', 'codex']) {
  test(`wait retries ${agent} once in the same session and waits for completion`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'retry', { agent, flags: ['--read-only'], config: { status: 'failed', error: 'HTTP 503 provider unavailable\nextra detail' } });
    const before = await f.finished(run, 'retry');
    const original = readJson(f.taskFile(run, 'retry'));
    const waited = await f.command(['wait', run.id, '--timeout', '10s', '--json']);
    assert.match(waited.stderr, /retried retry after a transient error \(1\/1\)/);
    const result = JSON.parse(waited.stdout);
    assert.equal(result.finished, true);
    assert.equal(result.tasks[0].state, 'completed');
    assert.equal(result.tasks[0].session, before.session);
    const saved = readJson(f.taskFile(run, 'retry'));
    assert.equal(saved.attempt, 2);
    assert.equal(saved.retries, 1);
    assert.deepEqual([saved.agent, saved.tier, saved.why, saved.readOnly], [original.agent, original.tier, original.why, true]);
    assert.equal(saved.retryLog.length, 1);
    assert.equal(saved.retryLog[0].attempt, 2);
    assert.equal(saved.retryLog[0].error, 'HTTP 503 provider unavailable');
    assert.ok(Number.isFinite(Date.parse(saved.retryLog[0].time)));
    const invocation = readJson(path.join(saved.outDir, 'invocation.json'));
    assert.deepEqual(invocation.argv.slice(-2), ['--session', before.session]);
    assert.equal(fs.readFileSync(path.join(run.dir, 'tasks/retry/retry-1.md'), 'utf8'), 'Your previous turn ended with a transient provider or network error: HTTP 503 provider unavailable. Continue the task from where you left off; do not redo work that is already done. End with the same final report.\n');
  });
}

// The fake relay reads its configuration from a brief comment. Carrying a comment in the first
// error line makes the generated delta fail once too, without changing the relay fixture.
const failAgain = 'HTTP 503 <!-- fake-relay {"status":"failed","error":"HTTP 503"} -->';

test('retry budget persists across waits and exhausted transient errors retain their hint', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const initial = await f.start(run, 'retry', { config: { status: 'failed', error: 'HTTP 503' } });
  await f.finished(run, 'retry');
  const resultFile = path.join(initial.outDir, 'result.json');
  writeJson(resultFile, { ...readJson(resultFile), error: failAgain });
  // The retried attempt fails again with no retries left: that is new attention, so wait exits 5.
  const first = await f.command(['wait', run.id, '--timeout', '10s'], { code: 5 });
  assert.match(first.stdout, /retried retry after a transient error \(1\/1\)/);
  assert.match(first.stdout, /transient error; resume with:/);
  const second = await f.command(['wait', run.id]);
  assert.doesNotMatch(second.stdout, /retried/);
  assert.match(second.stdout, /transient error; resume with:/);
  assert.equal(readJson(f.taskFile(run, 'retry')).attempt, 2);
});

test('AGENT_ORCH_MAX_RETRIES overrides the default budget', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const initial = await f.start(run, 'retry', { config: { status: 'failed', error: 'HTTP 503' } });
  await f.finished(run, 'retry');
  const resultFile = path.join(initial.outDir, 'result.json');
  writeJson(resultFile, { ...readJson(resultFile), error: failAgain });
  const waited = await f.command(['wait', run.id, '--timeout', '10s'], { env: { AGENT_ORCH_MAX_RETRIES: '2' } });
  assert.match(waited.stdout, /retried retry after a transient error \(2\/2\)/);
  const saved = readJson(f.taskFile(run, 'retry'));
  assert.equal(saved.retries, 2);
  assert.deepEqual(saved.retryLog.map((entry) => entry.attempt), [2, 3]);
  assert.equal((await f.finished(run, 'retry')).state, 'completed');
});

for (const scenario of ['usage-limit', 'ordinary-failure', 'no-session', 'closed', 'disabled', 'completed', 'dead']) {
  test(`wait does not retry ${scenario}`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const error = scenario === 'usage-limit' ? 'Usage limit reached; HTTP 503' : scenario === 'ordinary-failure' ? 'Assertion failed' : 'HTTP 503';
    const task = await f.start(run, 'task', { config: { status: scenario === 'completed' ? 'completed' : 'failed', error } });
    await f.finished(run, 'task');
    if (scenario === 'closed') await f.command(['close', run.id, 'task']);
    if (scenario === 'no-session') {
      const file = path.join(task.outDir, 'result.json');
      const result = readJson(file);
      delete result.sessionId;
      writeJson(file, result);
      fs.writeFileSync(path.join(task.outDir, 'events.jsonl'), '');
    }
    if (scenario === 'dead') fs.unlinkSync(path.join(task.outDir, 'result.json'));
    const waited = await f.command(['wait', run.id], { env: scenario === 'disabled' ? { AGENT_ORCH_MAX_RETRIES: '0' } : {} });
    assert.doesNotMatch(waited.stdout, /retried/);
    const saved = readJson(f.taskFile(run, 'task'));
    assert.equal(saved.attempt, 1);
    assert.equal(saved.retries, undefined);
    if (['no-session', 'closed', 'disabled'].includes(scenario)) assert.match(waited.stdout, /transient error; resume with:/);
    if (scenario === 'no-session') assert.match(waited.stdout, /--session <id>/);
  });
}

test('start refuses all unfilled markers with code 2 and the first marked line', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const brief = f.brief('unfilled');
  fs.appendFileSync(brief, 'First <fill in: goal> and <fill in: scope>\nLater <fill in: checks>\n');
  const refused = await f.command(['start', run.id, 'task', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture assessment', '--brief', brief], { code: 2 });
  assert.match(refused.stderr, /3 unfilled markers: First <fill in: goal> and <fill in: scope>/);
  assert.doesNotMatch(refused.stderr, /Later/);
  assert.equal(fs.existsSync(f.taskFile(run, 'task')), false);
});

test('dispatch reports an unfilled brief without launching its task', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const brief = f.brief('unfilled');
  fs.appendFileSync(brief, '<fill in: goal>\n');
  const plan = path.join(f.root, 'plan.json');
  writeJson(plan, { goal: 'Validate briefs', tasks: [{ id: 'task', goal: 'Inspect', type: 'research', owns: [], uses: [], produces: [], resources: [], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Fixture assessment', readOnly: true, brief }] });
  await f.command(['plan', run.id, plan]);
  const refused = await f.command(['dispatch', run.id], { code: 1 });
  assert.match(refused.stdout, /could not start task: brief contains 1 unfilled marker: <fill in: goal>/);
  assert.equal(fs.existsSync(f.taskFile(run, 'task')), false);
});

test('wait observes a running task fail, retries it, and keeps waiting with --any', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'task', { config: { hold: true, status: 'failed', error: 'ECONNRESET' } });
  const waited = await f.waitAfterPoll([run.id, '--any', '--timeout', '0'], async () => {
    f.release(task);
    await f.finished(run, 'task');
  });
  assert.match(waited.stdout, /retried task after a transient error \(1\/1\)/);
  assert.equal((await f.finished(run, 'task')).state, 'completed');
});

test('start accepts a brief that only mentions the marker syntax in prose', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const brief = f.brief('mentions');
  fs.appendFileSync(brief, 'Refuse briefs with `<fill in:` markers when dispatching.\n');
  await f.command(['start', run.id, 'task', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture assessment', '--brief', brief]);
  assert.equal((await f.finished(run, 'task')).state, 'completed');
});

test('start accepts a brief that quotes a full marker inside a code span', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const brief = f.brief('quoted');
  fs.appendFileSync(brief, 'start refuses briefs with `<fill in: …>` markers.\n');
  await f.command(['start', run.id, 'task', '--agent', 'claude', '--tier', 'standard', '--why', 'Fixture assessment', '--brief', brief]);
  assert.equal((await f.finished(run, 'task')).state, 'completed');
});
