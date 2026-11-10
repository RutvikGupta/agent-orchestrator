import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

async function task(f, run, id, { agent = 'codex', config = {}, fields = {}, elapsed = 60000 } = {}) {
  const started = await f.start(run, id, { agent, config });
  await f.finished(run, id);
  const file = f.taskFile(run, id);
  const record = readJson(file);
  const resultFile = path.join(started.outDir, 'result.json');
  const result = readJson(resultFile);
  writeJson(resultFile, { ...result, startedAt: '2026-01-01T00:00:00Z', finishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed).toISOString() });
  writeJson(file, { ...record, ...fields });
  return { started, file, resultFile };
}

const counts = (g) => Object.fromEntries(['tasks', 'attempts', 'firstAttemptAccepted', 'accepted', 'integrated', 'failed', 'limitHits', 'transientErrors', 'tokensIn', 'tokensOut', 'medianFirstAttemptMs', 'medianReviewWaitMs', 'tokensInPerAccepted'].map((key) => [key, g[key]]));

test('stats groups task outcomes and reports every column using all attempts', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await task(f, run, 'first', { fields: { plan: { type: 'implement' }, acceptedAt: '2026-01-01T00:03:00Z', acceptedAttempt: 1, integratedAt: '2026-01-01T00:04:00Z' } });
  const resumed = await task(f, run, 'resumed', { fields: { plan: { type: 'implement' } }, elapsed: 180000 });
  // Use the CLI to create the second attempt; acceptance and review times are controller records.
  await f.start(run, 'resumed', { agent: 'codex' });
  await f.finished(run, 'resumed');
  const record = readJson(resumed.file);
  const secondFile = path.join(record.outDir, 'result.json');
  writeJson(secondFile, { ...readJson(secondFile), finishedAt: '2026-01-01T00:06:00Z' });
  writeJson(resumed.file, { ...record, acceptedAt: '2026-01-01T00:10:00Z', acceptedAttempt: 2, retries: 2 });
  await task(f, run, 'limited', { config: { status: 'failed', error: 'Usage limit reached' }, fields: { plan: { type: 'implement' } }, elapsed: 120000 });
  await task(f, run, 'transient', { config: { status: 'failed', error: 'HTTP 503 Service Unavailable' }, fields: { readOnly: true }, elapsed: 240000 });
  await task(f, run, 'stopped', { config: { status: 'stopped' }, fields: { babysit: true }, elapsed: 300000 });
  const aborted = await task(f, run, 'aborted', { config: { status: 'aborted' }, elapsed: 360000 });
  // A relay that exits without a result is also aborted, and has no timing sample.
  fs.unlinkSync(aborted.resultFile);
  await task(f, run, 'decision', { config: { finalMessage: 'NEEDS DECISION:\nChoose a target' }, fields: { plan: { type: 'research' } } });
  await task(f, run, 'structured-decision', { config: { finalMessage: '```orch-result\n{"decisions":["Choose target"]}\n```' }, fields: { plan: { type: 'research' } } });
  await task(f, run, 'claude', { agent: 'claude', fields: { readOnly: true } });
  // A model change creates a separate agent/model group, without changing the relay fixture.
  await task(f, run, 'other-model', { fields: { model: 'gpt-6-astra', effort: 'high' } });
  // Non-task metadata must not expand the population.
  writeJson(path.join(run.dir, 'subagents.json'), [{ agent: 'codex', state: 'failed' }]);
  const stats = await f.json(['stats', run.id]);
  assert.equal(stats.byAgent.length, 3);
  const codex = stats.byAgent.find((g) => g.agent === 'codex' && g.modelLabel !== '6-astra high');
  assert.deepEqual(counts(codex), { tasks: 8, attempts: 9, firstAttemptAccepted: 1, accepted: 2, integrated: 1,
    failed: 4, limitHits: 1, transientErrors: 2, tokensIn: 1080, tokensOut: 270,
    medianFirstAttemptMs: 120000, medianReviewWaitMs: 180000, tokensInPerAccepted: 180 });
  assert.equal(codex.firstAttemptAcceptance, 0.5);
  const implement = stats.byType.find((g) => g.type === 'implement');
  assert.deepEqual(counts(implement), { tasks: 3, attempts: 4, firstAttemptAccepted: 1, accepted: 2, integrated: 1,
    failed: 1, limitHits: 1, transientErrors: 1, tokensIn: 480, tokensOut: 120,
    medianFirstAttemptMs: 120000, medianReviewWaitMs: 180000, tokensInPerAccepted: 180 });
  assert.deepEqual(stats.byType.map((g) => g.type).sort(), ['babysit', 'implement', 'read-only', 'research', 'write']);
  assert.equal(stats.byType.find((g) => g.type === 'research').failed, 0);
  const claude = stats.byAgent.find((g) => g.agent === 'claude');
  assert.equal(claude.tokensIn, 120);
  assert.equal(claude.tokensOut, 30);
  assert.equal(claude.firstAttemptAcceptance, null);
  assert.equal(claude.medianReviewWaitMs, null);
  assert.equal(claude.tokensInPerAccepted, null);
  const text = (await f.command(['stats', run.id])).stdout;
  for (const heading of ['By agent and model', 'By task type', 'TASKS', 'ATTEMPTS', 'FIRST ACCEPTED', 'ACCEPTED', 'INTEGRATED', 'FAILED', 'LIMIT HITS', 'TRANSIENT', 'FIRST ELAPSED', 'REVIEW WAIT', 'TOKENS IN', 'TOKENS OUT', 'TOKENS IN PER ACCEPTED']) assert.ok(text.includes(heading), heading);
  assert.match(text, /codex 6-astra high/);
  assert.match(text, /1\/2/);
});

test('stats filters runs by creation time and single RUN bypasses the time range', async (t) => {
  const f = await fixture(t);
  const recent = await f.newRun('recent');
  const older = await f.newRun('older');
  const ancient = await f.newRun('ancient');
  for (const run of [recent, older, ancient]) await task(f, run, 'task');
  for (const [run, age] of [[recent, 60 * 60000], [older, 2 * 86400000], [ancient, 40 * 86400000]]) {
    const file = path.join(run.dir, 'run.json');
    writeJson(file, { ...readJson(file), createdAt: new Date(Date.now() - age).toISOString() });
  }
  assert.equal((await f.json(['stats'])).byAgent[0].tasks, 2);
  assert.equal((await f.json(['stats', '--since', '7d'])).byAgent[0].tasks, 2);
  for (const duration of ['12h', '90m']) assert.equal((await f.json(['stats', '--since', duration])).byAgent[0].tasks, 1);
  assert.deepEqual(await f.json(['stats', '--since', '1m']), { byAgent: [], byType: [] });
  for (const ref of [ancient.id, ancient.dir]) assert.equal((await f.json(['stats', ref, '--since', '1m'])).byAgent[0].tasks, 1);
  const invalid = await f.command(['stats', '--since', 'forever'], { code: 2 });
  assert.match(invalid.stderr, /bad duration/);
  await f.command(['stats', recent.id, older.id], { code: 2 });
});

test('stats prints empty input and excludes prepared worktrees', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command(['stats'])).stdout.trim(), 'no tasks in range');
  assert.deepEqual(await f.json(['stats']), { byAgent: [], byType: [] });
  const run = await f.newRun();
  await f.command(['worktree', run.id, 'prepared', '--no-prep']);
  assert.equal((await f.command(['stats', run.id])).stdout.trim(), 'no tasks in range');
});
