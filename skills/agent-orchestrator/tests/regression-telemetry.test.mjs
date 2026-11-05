import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, eventually, jsonl } from './helpers.mjs';
import { claudeTranscripts } from './fixtures/transcripts.mjs';

function rollout(f, id, events, extra = {}) {
  const timestamp = new Date().toISOString();
  return jsonl(path.join(f.codex, 'sessions', ...timestamp.slice(0, 10).split('-'), `rollout-${id}.jsonl`), [
    { timestamp, type: 'session_meta', payload: { id, timestamp, cwd: f.repo, ...extra } },
    { timestamp, type: 'turn_context', payload: { turn_id: id, model: 'gpt-6.1-sol', effort: 'high' } },
    ...events.map((payload) => ({ timestamp, type: 'event_msg', payload })),
  ]);
}
const message = (text) => ({ type: 'item_completed', item: { type: 'AgentMessage', content: [{ text }] } });
const tokens = (input, cached, output) => ({ type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });

// Vendor status is tested separately. These are the transcript fallback contracts, isolated
// even on a machine that has a logged-in Claude CLI.
function transcriptsOnly(f) { f.env.AGENT_ORCH_CLAUDE_BIN = path.join(f.root, 'no-vendor-cli'); }

test('a Claude session with native children gets its own section without creating a run', async (t) => {
  const f = await fixture(t);
  transcriptsOnly(f);
  const transcripts = claudeTranscripts(f, 'standalone-session');
  const board = await f.dashboard();
  const state = await board.json('/api/state');
  assert.equal(state.length, 1);
  assert.equal(state[0].orchestrator.sessionId, 'standalone-session');
  assert.equal(state[0].tasks.filter((row) => row.main).length, 1);
  assert.equal(state[0].tasks.filter((row) => row.native).length, 4);
  for (const row of state[0].tasks) {
    const log = await board.json(`/api/transcript?file=${encodeURIComponent(row.outDir)}`);
    assert.ok(log.events.length, `log for ${row.id}`);
  }
  fs.appendFileSync(transcripts.main, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Continue with the next task.' } }) + '\n');
  await eventually(async () => (await board.json('/api/state'))[0].tasks.find((row) => row.main).state === 'running');
  const main = (await board.json('/api/state'))[0].tasks.find((row) => row.main);
  assert.match(main.modelLabel, /opus-5-5.*xhigh/);
});

test('native Codex trees preserve running, finished, interrupted, decision and approval-review rows and logs', async (t) => {
  const f = await fixture(t);
  transcriptsOnly(f);
  const run = await f.newRun();
  f.launchingSession(run, 'parent', 'codex');
  rollout(f, 'parent', [{ type: 'task_started' }, message('Parent is working.')]);
  const cases = {
    running: [{ type: 'task_started' }, message('Still working.')],
    finished: [{ type: 'task_started' }, message('Finished.'), { type: 'task_complete' }],
    interrupted: [{ type: 'task_started' }, { type: 'turn_aborted', reason: 'interrupted by the user' }],
    decision: [message('NEEDS DECISION:\nWhich branch?'), { type: 'task_complete' }],
  };
  for (const [id, events] of Object.entries(cases)) rollout(f, id, [...events, tokens(100, 20, 10)],
    { parent_thread_id: 'parent', thread_source: 'subagent', agent_path: `/root/${id}` });
  rollout(f, 'grandchild', [message('Nested report.'), { type: 'task_complete' }],
    { parent_thread_id: 'finished', thread_source: 'subagent', agent_path: '/root/finished/grandchild' });
  for (const id of ['review-one', 'review-two']) rollout(f, id, [tokens(30, 5, 2), { type: 'task_complete' }],
    { parent_thread_id: 'parent', thread_source: 'guardian_review' });
  const board = await f.dashboard();
  const section = (await board.json('/api/state'))[0];
  const rows = new Map(section.tasks.map((row) => [row.id, row]));
  assert.equal(rows.get('main').state, 'running');
  assert.match(rows.get('main').modelLabel, /6.1-sol high/);
  // The old CLI reports idle for both completed and interrupted Codex children.
  for (const [id, state] of [['running', 'running'], ['finished', 'idle'], ['interrupted', 'idle'], ['decision', 'needs-decision']]) {
    const row = rows.get(id);
    assert.equal(row.state, state);
    assert.equal(row.session, id);
    assert.deepEqual([row.tokensIn, row.tokensCached, row.tokensOut], [100, 20, 10]);
    assert.match(row.modelLabel, /6.1-sol high/);
    const log = await board.json(`/api/transcript?file=${encodeURIComponent(row.outDir)}`);
    assert.ok(log.events.length, `log for native ${id}`);
    if (id === 'interrupted') assert.ok(log.events.some((event) => event.text.includes('interrupted by the user')));
  }
  assert.deepEqual(rows.get('decision').decisions, ['Which branch?']);
  assert.equal(rows.get('grandchild').parent, 'finished');
  assert.equal(rows.get('grandchild').parentKey, rows.get('finished').key);
  const approval = rows.get('approval-reviews');
  assert.equal(approval.state, 'completed');
  assert.deepEqual([approval.tokensIn, approval.tokensCached, approval.tokensOut], [60, 10, 4]);
  assert.match(approval.now, /2 automatic approval review/);
  assert.equal(section.tasks.length, 7);
  const status = await f.command(['status', run.id]);
  assert.match(status.stdout, /approval-reviews/);
  assert.match(status.stdout, /needs-decision/);
});

test('live Codex token counts include rollout progress without double-counting resumed turns', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'coder', { agent: 'codex' });
  await f.finished(run, 'coder');
  const task = await f.start(run, 'coder', { agent: 'codex', config: { hold: true } });
  await f.ready(task);
  const file = rollout(f, 'fixture-codex', [tokens(220, 40, 55)]);
  const read = async () => (await f.json(['status', run.id])).tasks[0];
  let row = await read();
  assert.equal(row.state, 'running');
  assert.deepEqual([row.tokensIn, row.tokensCached, row.tokensOut], [220, 40, 55]);
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: tokens(310, 60, 70) }) + '\n');
  row = await read();
  assert.deepEqual([row.tokensIn, row.tokensCached, row.tokensOut], [310, 60, 70]);
  const board = await f.dashboard();
  const boardRow = (await board.json('/api/state'))[0].tasks.find((row) => row.id === 'coder');
  assert.equal(boardRow.tokensIn, 310);
  f.release(task);
  await f.finished(run, 'coder');
});

test('usage header readings expose both vendors and their rolling windows', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  await f.start(run, 'limits', { config: { extraEvents: [{ type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed', unifiedWindows: { five_hour: { utilization: .42, resetsAt: reset }, seven_day: { utilization: .81, resetsAt: reset } },
  } }] } });
  await f.finished(run, 'limits');
  rollout(f, 'limits', [{ type: 'token_count', rate_limits: {
    primary: { used_percent: 23, window_minutes: 300, resets_at: reset },
    secondary: { used_percent: 67, window_minutes: 10080, resets_at: reset },
  } }]);
  const board = await f.dashboard();
  const usage = await board.json('/api/usage');
  assert.equal(usage.claude.max, 81);
  assert.match(usage.claude.short, /5h 42%.*week 81%/);
  assert.equal(usage.codex.max, 67);
  assert.match(usage.codex.short, /5h 23%.*week 67%/);
  assert.match(usage.claude.full, /resets/);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent}: log tails the current attempt's relay and stderr while a task runs`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const task = await f.start(run, 'logs', { agent, config: { hold: true } });
    await f.ready(task);
    fs.writeFileSync(path.join(task.outDir, 'relay.log'), 'old output\nrecent output\nlatest output\n');
    fs.writeFileSync(path.join(task.outDir, 'stderr.txt'), 'old error\nrecent error\nlatest error\n');
    const log = await f.command(['log', run.id, 'logs', '--lines', '2']);
    assert.match(log.stdout, /== relay.log\nrecent output\nlatest output/);
    assert.match(log.stdout, /== stderr.txt\nrecent error\nlatest error/);
    assert.doesNotMatch(log.stdout, /old output|old error/);
    f.release(task);
    await f.finished(run, 'logs');
  });
}

test('presence streams push a change after a run writes, and release disconnected readers', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const board = await f.dashboard();
  const abort = new AbortController();
  const response = await fetch(new URL('/api/presence', board.url), {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
  });
  const reader = response.body.getReader();
  try {
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.ok(response.headers.get('x-orch-server'));
    assert.match(new TextDecoder().decode((await reader.read()).value), /: open/);
    assert.equal((await board.json('/api/health')).tabs, 1);
    // The stream's open frame is the handshake: only then change a watched run file.
    fs.appendFileSync(path.join(run.dir, 'run.json'), '\n');
    let output = '';
    while (!output.includes('event: change')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'presence must remain open');
      output += new TextDecoder().decode(value);
    }
    assert.match(output, /event: change\ndata: \n\n/);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  await eventually(async () => (await board.json('/api/health')).tabs === 0);
});
