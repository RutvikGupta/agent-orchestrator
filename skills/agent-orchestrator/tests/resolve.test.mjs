import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, readJson, writeJson } from './helpers.mjs';

const row = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((task) => task.id === id);
const question = 'Which behavior? Recommendation: keep the default.';
const note = 'Kept the default; no change needed.';
const reportMessage = 'Handing back a question.\n```orch-result\n' + JSON.stringify({
  outcome: 'partial', changed: [], checks: [],
  decisions: [{ question: 'Which behavior?', options: ['default', 'new'], recommendation: 'keep the default.' }],
  unresolved: [],
}) + '\n```';

for (const [source, finalMessage] of [
  ['text', `NEEDS DECISION:\n${question}`],
  ['report', reportMessage],
]) {
  test(`resolve records a ${source} decision, keeps its note, and allows acceptance`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'asks', { config: { finalMessage } });
    const before = await f.finished(run, 'asks');
    assert.equal(before.state, 'needs-decision');
    assert.deepEqual(before.decisions, [question]);

    const result = await f.json(['resolve', run.id, 'asks', '--note', note]);
    const task = readJson(f.taskFile(run, 'asks'));
    assert.ok(Number.isFinite(Date.parse(task.decisionResolvedAt)));
    assert.equal(task.decisionResolvedAttempt, before.attempt);
    assert.equal(task.decisionNote, note);
    assert.equal(result.decisionResolvedAt, task.decisionResolvedAt);

    const resolved = await row(f, run, 'asks');
    assert.equal(resolved.state, 'completed');
    assert.equal(resolved.phase, 'awaiting-review');
    assert.equal(resolved.closed, true);
    assert.deepEqual(resolved.decisions, [`${question} Resolved: ${note}`]);
    const accepted = await f.command(['accept', run.id, 'asks']);
    if (source === 'report') assert.match(accepted.stderr, /WARNING:.*no passing checks/);
    assert.equal((await row(f, run, 'asks')).phase, 'accepted');
    assert.deepEqual((await f.json(['recover', run.id])).runs[0].groups['needs-decision'], []);
  });
}

test('resolve refuses other states and missing, empty, or multiline notes without changing task records', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'done');
  await f.finished(run, 'done');
  const before = readJson(f.taskFile(run, 'done'));
  assert.match((await f.command(['resolve', run.id, 'done', '--note', note], { code: 2 })).stderr, /not needs-decision/);
  assert.deepEqual(readJson(f.taskFile(run, 'done')), before);
  await f.start(run, 'asks', { config: { finalMessage: `NEEDS DECISION:\n${question}` } });
  await f.finished(run, 'asks');
  const asking = readJson(f.taskFile(run, 'asks'));
  for (const flags of [[], ['--note', ''], ['--note', '   '], ['--note', 'first\nsecond']]) {
    assert.match((await f.command(['resolve', run.id, 'asks', ...flags], { code: 2 })).stderr, /--note/);
    assert.deepEqual(readJson(f.taskFile(run, 'asks')), asking);
  }
});

test('a resolution belongs only to its attempt; resuming can complete or hand back a new decision', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'asks', { config: { finalMessage: `NEEDS DECISION:\n${question}` } });
  const first = await f.finished(run, 'asks');
  await f.command(['resolve', run.id, 'asks', '--note', note]);
  await f.command(['accept', run.id, 'asks']);
  await f.start(run, 'asks', { config: { finalMessage: 'NEEDS DECISION:\nA new question?' }, flags: ['--json', '--', '--session', first.session] });
  const second = await f.finished(run, 'asks');
  assert.equal(second.attempt, first.attempt + 1);
  assert.equal(second.state, 'needs-decision');
  assert.equal(second.phase, 'needs-decision');
  assert.deepEqual(second.decisions, ['A new question?']);
  assert.equal(readJson(f.taskFile(run, 'asks')).decisionResolvedAttempt, first.attempt);
  await f.command(['accept', run.id, 'asks'], { code: 1 });

  await f.start(run, 'asks', { flags: ['--json', '--', '--session', second.session] });
  const third = await f.finished(run, 'asks');
  assert.equal(third.state, 'completed');
  assert.equal(third.phase, 'awaiting-review');
});

test('completed babysitters are integrated and absent from wait and recover review hints', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'sitter');
  await f.finished(run, 'sitter');
  // Seed the babysitter metadata rather than invoking gh against an actual pull request.
  const file = f.taskFile(run, 'sitter');
  writeJson(file, { ...readJson(file), babysit: true });
  const sitter = await row(f, run, 'sitter');
  assert.equal(sitter.mode, 'babysit');
  assert.equal(sitter.state, 'completed');
  assert.equal(sitter.phase, 'integrated');
  assert.equal(sitter.awaitingReviewMs, null);
  assert.doesNotMatch((await f.command(['wait', run.id, '--timeout', '1s'])).stdout, /awaiting review:/);
  const recovered = await f.json(['recover', run.id]);
  assert.deepEqual(recovered.runs[0].groups['awaiting-review'], []);
  assert.deepEqual(recovered.runs[0].groups.integrated, ['sitter']);
});
