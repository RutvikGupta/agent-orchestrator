import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { eventually, fixture, readJson } from './helpers.mjs';

// A note that a task sends its launching session with `tell` needs no answer, so it does not end
// that session's `wait`: the wait holds it and prints every held note with its next exit of any
// other kind. `wait --notes` keeps the earlier behavior, where a note ends it with exit 6.

// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const notesIn = (stdout) => [...stdout.matchAll(/^note from agent \S+ \([^)]+\): (.*)$/gm)].map((m) => m[1]);
const TRAILER = /\n\((?:a note|notes) from your tasks, sent with `tell`: no answer needed\)\n$/;

// A top-level run that a session launched, with a running task `kid` that sends the notes.
async function session(t) {
  const f = await fixture(t);
  const run = await f.newRun('notes');
  const owner = f.launchingSession(run, 'notesess-0001');
  const kid = await f.start(run, 'kid', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(kid);
  const tell = (text) => f.command(['tell', text], { env: as(run, 'kid') });
  return { f, run, owner, kid, tell };
}

// When the session's wait last polled (main-wait.json, addressee.mjs), in ms, or 0.
const polledAt = (run) => {
  try {
    return Date.parse(readJson(path.join(run.dir, 'main-wait.json')).at) || 0;
  } catch {
    return 0;
  }
};

test('a note does not end wait: it keeps waiting, and prints every held note, in order, with the next result', async (t) => {
  const { f, run, owner, kid, tell } = await session(t);
  // One note arrives while no wait runs, the other while one does.
  await tell('First: pushed #12.');
  const before = Date.now();
  // Short parks, so the wait returns to Node and reads the notes again within a second.
  const waiting = f.command(['wait', run.id, '--timeout', '0'], { env: { ...owner, AGENT_ORCH_PARK_MAX: '1s' } });
  let settled = false;
  waiting.then(() => { settled = true; }, () => { settled = true; });
  const live = (since, why) => eventually(() => {
    if (settled) assert.fail(`wait ended ${why}`);
    return polledAt(run) > since;
  }, `wait did not poll ${why}`, 10_000);
  await live(before, 'with the first note waiting');
  await tell('Second: checks are green.');
  // A poll that began after the second note was written saw both notes, with kid still running.
  await live(Date.now(), 'after the second note');
  f.release(kid);
  const woken = await waiting;
  assert.match(woken.stdout, /kid finished and nobody has read its result/);
  assert.deepEqual(notesIn(woken.stdout), ['First: pushed #12.', 'Second: checks are green.']);
  assert.match(woken.stdout, TRAILER);
  assert.match(woken.stdout, /\(notes from your tasks/);

  // Printed once: the next wait does not print them again.
  const again = await f.json(['wait', run.id, '--timeout', '1ms'], { env: owner });
  assert.equal(again.notes, undefined);
});

test('held notes print when the timeout exits 3, once', async (t) => {
  const { f, run, owner, kid, tell } = await session(t);
  await tell('Before the wait.');
  const timed = await f.waitAfterPoll([run.id, '--timeout', '2s', '--json'], () => tell('During the wait.'), { code: 3, env: owner });
  const out = JSON.parse(timed.stdout);
  assert.equal(out.finished, false);
  assert.deepEqual(out.notes.map((n) => n.text), ['Before the wait.', 'During the wait.']);
  const text = await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3, env: owner });
  assert.doesNotMatch(text.stdout, /note from/);
  await tell('Third.');
  const last = await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3, env: owner });
  assert.match(last.stdout, /\(still running: wait timed out\)\nnote from agent \S+ \([^)]+\): Third\.\n/);
  assert.match(last.stdout, TRAILER);
  f.release(kid);
});

test('a question, a handed-back decision and a failure still end wait at once, and print the held notes', async (t) => {
  const { f, run, owner, kid, tell } = await session(t);
  const decides = await f.start(run, 'decides', { config: { hold: true, finalMessage: 'NEEDS DECISION: Which endpoint? Recommendation: A.' }, flags: ['--read-only'] });
  const broke = await f.start(run, 'broke', { config: { hold: true, status: 'failed', error: 'Build failed' }, flags: ['--read-only'] });
  await f.ready(decides);
  await f.ready(broke);

  await tell('Note before the question.');
  const asked = await f.waitAfterPoll([run.id, '--timeout', '0'], () => f.command(['ask', 'Ship today?'], { env: as(run, 'kid') }), { code: 5, env: owner });
  assert.match(asked.stdout, /kid asked you, .* "Ship today\?"/);
  assert.deepEqual(notesIn(asked.stdout), ['Note before the question.']);
  await f.command(['send', run.id, 'kid', 'Yes.'], { env: owner });

  await tell('Note before the decision.');
  const decided = await f.waitAfterPoll([run.id, '--timeout', '0'], async () => {
    f.release(decides);
    await f.finished(run, 'decides');
  }, { code: 5, env: owner });
  assert.match(decided.stdout, /decides handed back a decision/);
  assert.deepEqual(notesIn(decided.stdout), ['Note before the decision.']);
  await f.command(['result', run.id, 'decides'], { env: owner });

  await tell('Note before the failure.');
  const failed = await f.waitAfterPoll([run.id, '--timeout', '0', '--json'], async () => {
    f.release(broke);
    await f.finished(run, 'broke');
  }, { code: 5, env: owner });
  const out = JSON.parse(failed.stdout);
  assert.ok(out.attention.some((a) => a.task === 'broke'), JSON.stringify(out.attention));
  assert.deepEqual(out.notes.map((n) => n.text), ['Note before the failure.']);
  f.release(kid);
});

test('wait --notes ends at the first new note with exit 6, and a note it printed does not print again', async (t) => {
  const { f, run, owner, kid, tell } = await session(t);
  const woken = await f.waitAfterPoll([run.id, '--notes', '--timeout', '0'], () => tell('Pushed #7.'), { code: 6, env: owner });
  assert.deepEqual(notesIn(woken.stdout), ['Pushed #7.']);
  assert.match(woken.stdout, TRAILER);
  assert.doesNotMatch(woken.stdout, /wait timed out/);
  assert.equal((await f.json(['wait', run.id, '--timeout', '1ms'], { code: 3, env: owner })).notes, undefined);
  // A note already waiting ends --notes at once.
  await tell('Pushed #8.');
  assert.deepEqual(notesIn((await f.command(['wait', run.id, '--notes', '--timeout', '1m'], { code: 6, env: owner })).stdout), ['Pushed #8.']);
  f.release(kid);
});
