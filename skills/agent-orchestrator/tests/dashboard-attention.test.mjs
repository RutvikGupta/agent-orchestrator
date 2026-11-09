import test from 'node:test';
import assert from 'node:assert/strict';
import { eventually, fixture } from './helpers.mjs';
import { claudeTranscripts } from './fixtures/transcripts.mjs';
// The one internal import in the suite: phase, health, awaitingReviewMs, and report come from the
// lifecycle and report hooks, which a fixture task cannot produce on its own, so the classifier is
// also checked directly with rows shaped like that contract. It is pure: no files, no environment.
import { attentionOf, byUrgency } from '../scripts/lib/dashboard-state.mjs';

const ask = 'NEEDS DECISION:\n- Which parser should stay? Recommendation: the new one.';

test('/api/state lists what needs attention, in order, from state, closed, and limitHit', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('lane');
  f.launchingSession(run, 'session-lane');
  claudeTranscripts(f, 'session-lane'); // a main session and native sub-agents, one of them asking
  // Started one after another, so each finishes later than the one before it.
  const tasks = [
    ['review-me', { finalMessage: 'Parser fixed.' }],
    ['collected', { finalMessage: 'Docs updated.' }],
    ['limited', { status: 'failed', error: "You've hit your usage limit · resets 5pm" }],
    ['broken', { status: 'failed', finalMessage: 'Could not finish.', error: 'Tests failed: 2 of 23\n  at parser.test.mjs' }],
    ['slow', { status: 'timeout', finalMessage: 'Still compiling when the timeout hit.' }],
    ['retired', { status: 'failed', error: 'Gave up' }],
    ['asks', { finalMessage: ask }],
    ['asks-closed', { finalMessage: ask }],
  ];
  for (const [id, config] of tasks) {
    await f.start(run, id, { config });
    await f.finished(run, id);
  }
  await f.command(['result', run.id, 'collected']); // collecting a completed result closes it
  await f.command(['result', run.id, 'asks']); // a decision stays open after `result`
  await f.command(['close', run.id, 'retired', 'asks-closed']);
  await f.json(['worktree', run.id, 'later']);
  await f.start(run, 'busy', { config: { delayMs: 30_000 } });
  await eventually(async () => (await f.json(['status', run.id])).tasks.find((x) => x.id === 'busy')?.state === 'running', 'busy did not start');
  const board = await f.dashboard();
  const section = async () => (await board.json('/api/state')).find((s) => s.orchestrator?.sessionId === 'session-lane');

  await t.test('kinds come in order: decision, failure, review; each kind oldest first', async () => {
    const s = await section();
    assert.ok(s, 'section for the launching session');
    assert.equal(s.tasks.find((row) => row.id === 'busy').state, 'running');
    assert.deepEqual(s.attention.map((a) => [a.id, a.kind, a.rank]), [
      ['asks', 'needs-decision', 1],
      ['limited', 'failed', 2],
      ['broken', 'failed', 2],
      ['slow', 'failed', 2],
      ['review-me', 'awaiting-review', 3],
    ]);
    for (let i = 1; i < s.attention.length; i++) assert.ok(byUrgency(s.attention[i - 1], s.attention[i]) <= 0);
  });

  await t.test('each item names its row and a short reason', async () => {
    const s = await section();
    const by = Object.fromEntries(s.attention.map((a) => [a.id, a]));
    assert.equal(by.asks.reason, 'Which parser should stay? Recommendation: the new one.');
    assert.equal(by.asks.label, 'needs decision');
    assert.equal(by.limited.label, 'usage limit');
    assert.match(by.limited.reason, /hit your usage limit/);
    assert.equal(by.broken.label, 'failed');
    assert.equal(by.broken.reason, 'Tests failed: 2 of 23', 'first line of the error, before the final message');
    assert.equal(by.slow.label, 'timeout');
    assert.equal(by.slow.reason, 'Still compiling when the timeout hit.', 'the final message when there is no error');
    assert.equal(by['review-me'].label, 'awaiting review');
    assert.match(by['review-me'].reason, /^waiting (\d+m)?\d+s$/);
    for (const a of s.attention) {
      const row = s.tasks.find((row) => row.key === a.key);
      assert.ok(row, `${a.key} is a row of its section`);
      assert.equal(row.id, a.id);
      assert.equal(row.attention.kind, a.kind);
      assert.equal(a.sinceMs, row.lastActiveMs);
    }
  });

  await t.test('closed, collected, running, prepared, main, and native rows stay out', async () => {
    const s = await section();
    const listed = new Set(s.attention.map((a) => a.key));
    for (const id of ['collected', 'retired', 'asks-closed', 'busy', 'later']) {
      const row = s.tasks.find((row) => row.id === id && !row.native);
      assert.ok(row, id);
      assert.equal(row.attention, null, id);
      assert.ok(!listed.has(row.key), id);
    }
    const main = s.tasks.find((row) => row.main);
    assert.ok(main);
    assert.equal(main.attention, null);
    const natives = s.tasks.filter((row) => row.native);
    assert.ok(natives.some((row) => row.state === 'needs-decision'), 'fixture has a native that asks');
    for (const row of natives) assert.ok(!listed.has(row.key), `native ${row.id}`);
  });

  await t.test('a section with nothing to act on has an empty list', async () => {
    const quiet = await f.newRun('quiet');
    await f.start(quiet, 'done', { config: { finalMessage: 'All good.' } });
    await f.finished(quiet, 'done');
    await f.command(['result', quiet.id, 'done']);
    // State reads serve the previous snapshot while its worker rebuilds after the CLI action.
    const s = await eventually(async () => {
      const state = await board.json('/api/state');
      const section = state.find((x) => x.runs.some((r) => r.id === quiet.id));
      return section?.attention.length === 0 ? section : null;
    }, 'the collected result remained in the attention lane');
    assert.deepEqual(s.attention, []);
  });

  await t.test('the page has the lane, its header count, and the report view', async () => {
    const html = await (await board.get('/')).text();
    assert.match(html, /<span id="need"[^>]*hidden/);
    const app = await (await board.get('/app.js')).text();
    for (const needle of ['run.attention', 'reveal(', 'awaiting review', 'scopeViolations', 'reportView(']) assert.ok(app.includes(needle), needle);
    await board.checkScript(app);
  });
});

test('attentionOf follows phase and health when the contract fields are present', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const row = (fields) => ({ id: 'x', state: 'completed', lastActiveMs: now - 65_000, ...fields });
  const kind = (fields, closed = false) => attentionOf(row(fields), closed, now);

  // Phase decides over state.
  assert.equal(kind({ phase: 'accepted' }), null);
  assert.equal(kind({ phase: 'integrated' }), null);
  assert.equal(kind({ state: 'failed', phase: 'accepted' }), null, 'an accepted task needs nobody');
  assert.equal(kind({ phase: 'running', state: 'running' }), null);
  assert.deepEqual(kind({ phase: 'awaiting-review', awaitingReviewMs: 125_000, report: { outcome: 'partial' } }),
    { kind: 'awaiting-review', rank: 3, label: 'awaiting review', reason: 'waiting 2m05s · reported partial', sinceMs: now - 65_000 });
  assert.equal(kind({ phase: 'awaiting-review', awaitingReviewMs: null }).reason, 'waiting 1m05s', 'falls back to the finish time');
  assert.equal(kind({ state: 'completed', phase: 'failed' }).label, 'failed');

  // Needs decision: from state or phase, with the first question from the row or the report.
  assert.equal(kind({ state: 'needs-decision', decisions: ['Pick A or B? Recommendation: A.', 'Second'] }).reason, 'Pick A or B? Recommendation: A.');
  assert.equal(kind({ phase: 'needs-decision', report: { decisions: [{ question: 'Keep v1?', options: ['yes', 'no'] }] } }).reason, 'Keep v1?');
  assert.equal(kind({ phase: 'needs-decision', decisions: null, report: { decisions: [null] } }).reason, 'read its final message');
  assert.equal(kind({ state: 'needs-decision', phase: 'needs-decision' }).rank, 1);

  // Failures: usage limit first, then dead, then a transient error, then any other failed state.
  assert.equal(kind({ state: 'failed', phase: 'failed', limitHit: true, health: 'transient-error', result: { error: 'Usage limit reached' } }).label, 'usage limit');
  const dead = kind({ state: 'aborted', phase: 'failed', health: 'dead', now: 'relay exited without a result; see log' });
  assert.deepEqual([dead.kind, dead.label, dead.reason], ['failed', 'dead', 'relay exited without a result; see log']);
  const transient = kind({ state: 'failed', health: 'transient-error', result: { error: 'overloaded_error: try again\nretry-after: 30' } });
  assert.deepEqual([transient.label, transient.reason], ['transient error', 'overloaded_error: try again']);
  assert.equal(kind({ state: 'failed', health: 'transient-error', phase: 'failed', result: null, finalMessage: null, now: '' }).reason, '');
  assert.equal(kind({ state: 'stopped' }).label, 'stopped', 'fallback: any unsuccessful end is a failure');

  // Silent comes from health only: a quiet running task with health ok, or no health, is fine.
  const silent = kind({ state: 'running', phase: 'running', health: 'silent', quietMs: 963_000, now: 'quiet 16m03s · $ npm test' });
  assert.deepEqual([silent.kind, silent.rank, silent.reason], ['silent', 4, 'no events for 16m03s · $ npm test']);
  assert.equal(kind({ state: 'running', health: 'ok', quietMs: 3_600_000, now: 'quiet 1h00m · pr-watch' }), null);
  assert.equal(kind({ state: 'running', quietMs: 3_600_000 }), null);

  // A closed session, the main session, and a prepared one never need attention.
  for (const fields of [{ state: 'needs-decision' }, { state: 'failed', limitHit: true }, { state: 'aborted', health: 'dead' }, { phase: 'awaiting-review' }]) {
    assert.equal(kind(fields, true), null, JSON.stringify(fields));
  }
  assert.equal(kind({ main: true, state: 'running', health: 'silent' }), null);
  assert.equal(kind({ state: 'prepared' }), null);
  assert.equal(kind({ state: 'idle', native: true }), null);
});

test('byUrgency orders by kind, then by how long each has waited', () => {
  const item = (id, rank, sinceMs) => ({ id, rank, sinceMs });
  const items = [item('silent-old', 4, 1), item('review-old', 3, 2), item('failed-new', 2, 50), item('ask-new', 1, 99), item('failed-old', 2, 10), item('ask-old', 1, 5)];
  assert.deepEqual(items.sort(byUrgency).map((x) => x.id), ['ask-old', 'ask-new', 'failed-old', 'failed-new', 'review-old', 'silent-old']);
});
