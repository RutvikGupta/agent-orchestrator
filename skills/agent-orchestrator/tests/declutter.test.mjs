import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
import { claudeTranscripts } from './fixtures/transcripts.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Make a finished task look as if it finished `ms` ago: its task record and its result.
function backdate(run, id, ms) {
  const taskFile = path.join(run.dir, 'tasks', id, 'task.json');
  const task = readJson(taskFile);
  writeJson(taskFile, { ...task, createdAt: ago(ms + MIN), startedAt: ago(ms + MIN) });
  const resultFile = path.join(task.outDir, 'result.json');
  writeJson(resultFile, { ...readJson(resultFile), startedAt: ago(ms + MIN), finishedAt: ago(ms) });
}
function editRun(run, fields) {
  const file = path.join(run.dir, 'run.json');
  writeJson(file, { ...readJson(file), ...fields });
}
const sectionOf = (state, run) => state.find((s) => s.runs.some((r) => r.id === run.id));

// Right after `start`, before `ps` shows the new relay, a busy machine can read the task as aborted.
// Once its result exists it never does, so wait for the result before waiting for the finished state.
// `env` is the identity that collects the result: only the run's owner closes a task with `result`.
async function finish(f, run, id, { config = {}, collect = false, env = {} } = {}) {
  const task = await f.start(run, id, { config });
  await eventually(() => fs.existsSync(path.join(task.outDir, 'result.json')), `${id} wrote no result`);
  await f.finished(run, id);
  if (collect) await f.command(['result', run.id, id], { env });
}
// `dashboard` reuses one that is serving, so stop it before starting one with other settings.
async function restart(f, board) {
  await f.json(['dashboard', '--stop', '--port', new URL(board.url).port]);
  return f.dashboard();
}

test('a run leaves the board after 2 hours with nothing running, or after AGENT_ORCH_BOARD_IDLE', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_NOTIFY = 'off';
  const runs = {};
  for (const [name, age] of [['fresh', 0], ['recent', 100 * MIN], ['old', 3 * HOUR]]) {
    runs[name] = await f.newRun(name);
    await finish(f, runs[name], 'only', { collect: true });
    if (age) {
      backdate(runs[name], 'only', age);
      editRun(runs[name], { createdAt: ago(age + 5 * MIN) });
    }
  }
  const shown = async (board) => {
    const state = await board.json('/api/state');
    return Object.keys(runs).filter((name) => sectionOf(state, runs[name]));
  };
  let board = await f.dashboard();
  assert.deepEqual(await shown(board), ['fresh', 'recent'], 'default: 2 hours');
  f.env.AGENT_ORCH_BOARD_IDLE = '90m';
  board = await restart(f, board);
  assert.deepEqual(await shown(board), ['fresh']);
  f.env.AGENT_ORCH_BOARD_IDLE = '5h';
  board = await restart(f, board);
  assert.deepEqual(await shown(board), ['fresh', 'recent', 'old']);
});

test('rows quiet for half an hour are flagged older, whole subtrees at a time; running, attention, and main rows never are', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_NOTIFY = 'off';
  // Run A, launched by a Claude session with native sub-agents. Run B hangs under A's task `lead`,
  // and run C under A's task `lead-quiet`, as runs started by those tasks would.
  const a = await f.newRun('a');
  const owner = f.launchingSession(a, 'session-declutter'); // owns A, and B and C under it
  const transcripts = claudeTranscripts(f, 'session-declutter');
  const b = await f.newRun('b');
  const c = await f.newRun('c');
  editRun(b, { orchestrator: { agent: 'delegated-agent', sessionId: null, parentRun: a.id, parentTask: 'lead' } });
  editRun(c, { orchestrator: { agent: 'delegated-agent', sessionId: null, parentRun: a.id, parentTask: 'lead-quiet' } });
  for (const id of ['fresh', 'lead', 'lead-quiet']) await finish(f, a, id, { collect: true, env: owner });
  await finish(f, a, 'old-review', { config: { finalMessage: 'Parser fixed.' } }); // awaits review
  await finish(f, b, 'child-fresh', { collect: true, env: owner });
  await finish(f, b, 'child-old', { collect: true, env: owner });
  await finish(f, c, 'grandchild', { collect: true, env: owner });
  for (const [run, id] of [[a, 'lead'], [a, 'lead-quiet'], [a, 'old-review'], [b, 'child-old'], [c, 'grandchild']]) backdate(run, id, 90 * MIN);
  // The session and two of its native sub-agents went quiet hours ago.
  const old = new Date(Date.now() - 3 * HOUR);
  for (const file of [transcripts.main, transcripts.children.completed, transcripts.children.stopped]) fs.utimesSync(file, old, old);
  // A babysitter waiting in pr-watch: running, with its last event hours old, yet not silent.
  const watcher = await f.start(a, 'watcher', {
    config: {
      delayMs: 30_000,
      extraEvents: [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'watch-1', name: 'Bash', input: { command: 'node orch.mjs pr-watch 42' } }] } }],
    },
  });
  await f.ready(watcher);
  const events = path.join(watcher.outDir, 'events.jsonl');
  await eventually(() => fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('pr-watch'), 'watcher did not write its pr-watch call');
  writeJson(f.taskFile(a, 'watcher'), { ...readJson(f.taskFile(a, 'watcher')), babysit: true });
  fs.utimesSync(events, old, old);

  const board = await f.dashboard();
  const state = await board.json('/api/state');
  const section = sectionOf(state, a);
  assert.ok(section, 'the section stays: something in it runs');
  assert.ok(sectionOf(state, b) === section && sectionOf(state, c) === section, 'nested runs share the section');
  const row = (id, native = false) => {
    const found = section.tasks.find((r) => r.id === id && Boolean(r.native) === native && !r.main);
    assert.ok(found, id);
    return found;
  };

  await t.test('quiet rows, orch.mjs and native alike, are older; recent ones are not', () => {
    for (const id of ['lead-quiet', 'grandchild', 'child-old']) assert.equal(row(id).older, true, id);
    for (const id of ['completed', 'stopped']) assert.equal(row(id, true).older, true, `native ${id}`);
    for (const id of ['fresh', 'child-fresh']) assert.equal(row(id).older, false, id);
    for (const id of ['running', 'needs-decision']) assert.equal(row(id, true).older, false, `native ${id}`);
    assert.ok(section.tasks.every((r) => typeof r.older === 'boolean'), 'every row carries the flag');
    assert.ok(section.tasks.every((r) => !('activeMs' in r)), 'the internal activity stamp stays off the board');
  });

  await t.test('a parent stays while any row under it stays, and folds with its whole subtree', () => {
    assert.equal(row('lead').older, false, 'lead is quiet, but child-fresh under it is not');
    assert.equal(row('child-fresh').parentKey, row('lead').key);
    assert.equal(row('child-old').parentKey, row('lead').key);
    assert.equal(row('grandchild').parentKey, row('lead-quiet').key);
    const byKey = new Map(section.tasks.map((r) => [r.key, r]));
    for (const r of section.tasks) {
      if (r.older) continue;
      for (let p = r.parentKey; p; p = byKey.get(p)?.parentKey) assert.equal(byKey.get(p).older, false, `${r.id} shows, so ${byKey.get(p).id} above it shows`);
    }
  });

  await t.test('running, attention, and main rows are never older, however quiet', () => {
    const watching = row('watcher');
    assert.equal(watching.state, 'running');
    assert.equal(watching.attention, null, 'a babysitter in pr-watch is not silent');
    assert.ok(Date.now() - watching.lastActiveMs >= 2 * HOUR);
    assert.equal(watching.older, false);
    const review = row('old-review');
    assert.equal(review.attention?.kind, 'awaiting-review');
    assert.equal(review.older, false);
    const main = section.tasks.find((r) => r.main);
    assert.ok(Date.now() - main.lastActiveMs >= 2 * HOUR);
    assert.equal(main.older, false);
  });

  await t.test('the older rows stay in the state, so the page can show them without a new request', () => {
    const older = section.tasks.filter((r) => r.older).map((r) => `${r.native ? 'native ' : ''}${r.id}`).sort();
    assert.deepEqual(older, ['child-old', 'grandchild', 'lead-quiet', 'native completed', 'native stopped']);
    for (const r of section.tasks.filter((r) => r.older)) assert.ok(r.key && 'parentKey' in r, r.id);
    assert.deepEqual(section.attention.map((x) => x.id), ['old-review'], 'the lane is unchanged by folding');
  });

  await t.test('the page folds older rows per section and follows the log', async () => {
    const app = await (await board.get('/app.js')).text();
    await board.checkScript(app);
    for (const needle of ['t.older', 'olderShown', 'hide older', '" older"']) assert.ok(app.includes(needle), needle);
    // The log-following rule is a pure function of the panel's scroll numbers.
    const context = vm.createContext({});
    vm.runInContext(`${app.slice(app.indexOf('const atBottom='), app.indexOf('async function detail('))};this.logScroll=logScroll;`, context);
    const panel = (scrollTop) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });
    assert.equal(context.logScroll(false, panel(0)), 'bottom', 'a session just chosen opens at its newest events');
    assert.equal(context.logScroll(false, panel(300)), 'bottom');
    assert.equal(context.logScroll(true, panel(1500)), 'bottom', 'at the bottom: stay pinned');
    assert.equal(context.logScroll(true, panel(1470)), 'bottom', 'within 40 px counts as the bottom');
    assert.equal(context.logScroll(true, panel(1400)), 1400, 'scrolled up: keep the place');
    assert.equal(context.logScroll(true, panel(0)), 0);
  });

  await t.test('AGENT_ORCH_ROW_IDLE sets the age', async () => {
    f.env.AGENT_ORCH_ROW_IDLE = '2h';
    const later = sectionOf(await (await restart(f, board)).json('/api/state'), a);
    const flagged = later.tasks.filter((r) => r.older).map((r) => `${r.native ? 'native ' : ''}${r.id}`).sort();
    assert.deepEqual(flagged, ['native completed', 'native stopped'], 'rows quiet for 90 minutes stay');
  });
});

test('the lane leaves out babysitters and stale reviews; recover still lists them', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_NOTIFY = 'off';
  const run = await f.newRun('reviews');
  for (const id of ['review-now', 'review-hour', 'review-stale', 'sitter']) await finish(f, run, id, { config: { finalMessage: `${id} done.` } });
  backdate(run, 'review-hour', 90 * MIN);
  backdate(run, 'review-stale', 25 * HOUR);
  // A babysitter's record, as `start --babysit` writes it (that needs a real pull request).
  writeJson(f.taskFile(run, 'sitter'), { ...readJson(f.taskFile(run, 'sitter')), babysit: true });
  const reviewing = async (board) => {
    const section = sectionOf(await board.json('/api/state'), run);
    assert.ok(section);
    return { section, ids: section.attention.filter((a) => a.kind === 'awaiting-review').map((a) => a.id).sort() };
  };

  const board = await f.dashboard();
  const { section, ids } = await reviewing(board);
  assert.deepEqual(ids, ['review-hour', 'review-now'], 'the section header counts this same list');
  const sitter = section.tasks.find((r) => r.id === 'sitter');
  assert.equal(sitter.mode, 'babysit');
  assert.equal(sitter.state, 'completed');
  assert.equal(sitter.attention, null, 'a babysitter is never awaiting review');
  const stale = section.tasks.find((r) => r.id === 'review-stale');
  assert.equal(stale.phase, 'awaiting-review');
  assert.equal(stale.attention, null, 'a review waiting over 24 hours is stale');
  assert.equal(stale.older, true, 'out of the lane, it folds away like other quiet rows');

  const recover = await f.json(['recover', run.id]);
  const listed = recover.runs[0].groups['awaiting-review'].map((r) => r.id);
  assert.ok(listed.includes('review-stale'), JSON.stringify(listed));

  f.env.AGENT_ORCH_REVIEW_STALE = '1h';
  assert.deepEqual((await reviewing(await restart(f, board))).ids, ['review-now'], 'AGENT_ORCH_REVIEW_STALE sets the age');
});
