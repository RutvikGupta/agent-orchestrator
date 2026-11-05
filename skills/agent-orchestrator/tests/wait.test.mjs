import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

// The orchestrator waits in the background with plain `wait RUN`. A task that finishes while a
// slower sibling still runs must wake it, or its result sits unreviewed until the slowest task ends.
test('wait returns as soon as any running task finishes, naming it, while others keep running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const slow = await f.start(run, 'slow', { config: { hold: true }, flags: ['--read-only'] });
  const fast = await f.start(run, 'fast', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(slow);
  await f.ready(fast);
  await f.waitAfterPoll([run.id, '--timeout', '60s'], async () => {
    f.release(fast);
    await f.finished(run, 'fast');
  }).then((waited) => {
    assert.equal(waited.code, 0);
    assert.match(waited.stdout, /fast finished and nobody has read its result: review it now with `result`, or `close` what you handled another way, then wait again for slow/);
  });
  assert.equal((await f.json(['status', run.id])).tasks.find((row) => row.id === 'slow').state, 'running');
  f.release(slow);
  await f.finished(run, 'slow');
});

test('wait --all keeps waiting until every task has finished', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const slow = await f.start(run, 'slow', { config: { hold: true }, flags: ['--read-only'] });
  const fast = await f.start(run, 'fast', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(slow);
  await f.ready(fast);
  f.release(fast);
  await f.finished(run, 'fast');
  const waited = await f.command(['wait', run.id, '--all', '--timeout', '4s'], { code: 3 });
  assert.match(waited.stdout, /still running: wait timed out/);
  f.release(slow);
  await f.finished(run, 'slow');
  await f.command(['wait', run.id, '--all', '--timeout', '30s']);
});

// The orchestrator re-arms wait after reviewing one result. A task that finished in between must
// still wake it, or the run idles with an unread result.
test('a task that finished while no wait was running wakes the next wait at once', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'done');
  await f.finished(run, 'done');
  const slow = await f.start(run, 'slow', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(slow);
  const waited = await f.command(['wait', run.id, '--timeout', '30s']);
  assert.match(waited.stdout, /done finished and nobody has read its result: review it now with `result`, or `close` what you handled another way, then wait again for slow/);
  f.release(slow);
  await f.finished(run, 'slow');
});

test('a finished result that was read, closed or accepted does not wake wait', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const id of ['read', 'closed']) {
    await f.start(run, id);
    await f.finished(run, id);
  }
  await f.command(['result', run.id, 'read']);
  await f.command(['close', run.id, 'closed']);
  const slow = await f.start(run, 'slow', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(slow);
  const waited = await f.command(['wait', run.id, '--timeout', '4s'], { code: 3 });
  assert.match(waited.stdout, /still running: wait timed out/);
  f.release(slow);
  await f.finished(run, 'slow');
});

test('a decision handed back while no wait ran wakes the next wait until its result is read', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'asks', { config: { finalMessage: 'NEEDS DECISION: Which endpoint? Recommendation: A.' } });
  await f.finished(run, 'asks');
  const slow = await f.start(run, 'slow', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(slow);
  const woke = await f.command(['wait', run.id, '--timeout', '30s']);
  assert.match(woke.stdout, /asks finished and nobody has read its result/);
  assert.match(woke.stdout, /asks handed back a decision/);
  await f.command(['result', run.id, 'asks']);
  assert.equal((await f.json(['status', run.id])).tasks.find((row) => row.id === 'asks').state, 'needs-decision');
  const quiet = await f.command(['wait', run.id, '--timeout', '4s'], { code: 3 });
  assert.match(quiet.stdout, /still running: wait timed out/);
  f.release(slow);
  await f.finished(run, 'slow');
});

test('closing a task that handed back a decision marks the decision resolved', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'asks', { config: { finalMessage: 'NEEDS DECISION: Which endpoint? Recommendation: A.' } });
  await f.finished(run, 'asks');
  const closed = await f.command(['close', run.id, 'asks']);
  assert.match(closed.stdout, /asks: closed; its decision is marked resolved/);
  const row = (await f.json(['status', run.id])).tasks.find((task) => task.id === 'asks');
  assert.equal(row.state, 'completed');
  assert.match(row.now, /decision resolved: closed by the orchestrator without resuming the task/);
});
