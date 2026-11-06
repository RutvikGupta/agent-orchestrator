import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Pure: they read only the environment variables passed in.
import { attentionOf } from '../scripts/lib/dashboard-state.mjs';
import { escalationCheckMs, escalationDelays } from '../scripts/lib/escalate.mjs';
// A constant: the watcher's shell script, run here with chosen arguments.
import { WAIT_SCRIPT } from '../scripts/lib/finish-notice.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
const watcher = fileURLToPath(new URL('../scripts/lib/finish-notice.mjs', import.meta.url));

// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const inboxOf = (run, id) => {
  const file = path.join(run.dir, 'tasks', id, 'inbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const noticeFile = (run, id, attempt = 1) => path.join(run.dir, 'tasks', id, `attempt-${attempt}`, 'parent-notice.json');
// The watcher's final record, sent or skipped. It is the watcher's last write, so no file changes
// after it (the fixture's cleanup removes the folder).
function notice(run, id, attempt = 1) {
  return eventually(() => {
    try {
      const record = readJson(noticeFile(run, id, attempt));
      return record.sentAt || record.skipped ? record : null;
    } catch {
      return null;
    }
  }, `no finish notice for ${id} attempt ${attempt}`, 15_000);
}

// Every process, with its process group and command line.
const ps = (args) => spawnSync('ps', args, { encoding: 'utf8' }).stdout;
const table = () => ps(['-axww', '-o', 'pid=,pgid=,command=']).split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)).filter(Boolean)
  .map(([, pid, pgid, command]) => ({ pid: Number(pid), pgid: Number(pgid), command }));
// The watcher that `start` launched for an attempt (its shell, until the relay ends).
const watcherOf = (run, id, attempt, pid) => table().find((row) => row.command.includes(`finish-notice.mjs ${run.dir} ${id} ${attempt} ${pid}`));
// Stop that watcher, by its confirmed PID, as a watcher that has not run yet would be.
async function holdBack(run, id, attempt, pid) {
  const watching = await eventually(() => watcherOf(run, id, attempt, pid), 'no watcher');
  process.kill(watching.pid, 'SIGTERM');
  await eventually(() => !table().some((row) => row.pid === watching.pid), 'the watcher did not stop');
}
const lstart = (pid) => ps(['-o', 'lstart=', '-p', String(pid)]).trim();

// A top-level run with a running task `lead`, and a run that `lead` created for its own agents.
// `lead` is a Claude agent with the orch-inbox hook registered, so it reads its messages.
async function family(t) {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: `node ${hook}` }] }] } }));
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const child = await f.newRun('child', as(parent, 'lead'));
  return { f, parent, lead, child, env: as(parent, 'lead') };
}

function runHook(f, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, ...env } });
    let out = '';
    child.stdout.on('data', (s) => { out += s; });
    child.on('close', () => resolve(out));
    child.stdin.end('{}');
  });
}

test('a finished child tells the task that started it, once per attempt: ready for review, needs decision, or failed', async (t) => {
  const { f, parent, child, env } = await family(t);
  const report = '```orch-result\n{"outcome":"partial","changed":[],"checks":[],"decisions":[],"unresolved":["one gate"]}\n```';
  const cases = {
    done: { finalMessage: `Ready.\n${report}` },
    asks: { finalMessage: 'NEEDS DECISION:\n- Which endpoint, A or B? Recommendation: A.' },
    broke: { status: 'failed', error: 'Build failed: missing entry point\n  at main.mjs' },
  };
  for (const [id, config] of Object.entries(cases)) await f.start(child, id, { config, flags: ['--read-only'], env });
  for (const id of Object.keys(cases)) {
    const record = await notice(child, id);
    assert.equal(record.to, `${parent.id}/lead`);
    assert.ok(record.message, JSON.stringify(record));
    assert.equal(readJson(f.taskFile(child, id)).startedBy.task, 'lead');
  }
  const messages = inboxOf(parent, 'lead');
  assert.equal(messages.length, 3);
  const by = Object.fromEntries(messages.map((m) => [m.about.task, m]));
  for (const id of Object.keys(cases)) {
    assert.equal(by[id].from, `agent:${child.id}/${id}`);
    assert.equal(by[id].kind, 'finished');
    assert.deepEqual(by[id].about, { run: child.id, task: id, attempt: 1 });
    assert.ok(by[id].text.includes(`\`node ${cli} result ${child.id} ${id}\``), by[id].text);
  }
  assert.match(by.done.text, /\(attempt 1\) completed and is ready for your review\. It reported partial\./);
  assert.match(by.done.text, /record `accept` or `verdict`/);
  assert.match(by.asks.text, /needs a decision and is waiting on you:\n- Which endpoint, A or B\? Recommendation: A\.\n/);
  assert.ok(by.asks.text.includes(`node ${cli} start ${child.id} asks --agent claude --brief <answer-file> -- --session fixture-claude`));
  assert.match(by.asks.text, /orch\.mjs ask "<question>"/);
  assert.match(by.broke.text, /failed \(failed\): Build failed: missing entry point\n/);
  assert.doesNotMatch(by.broke.text, /main\.mjs/);

  // Labelled as from the child, never as from the user, in `inbox` and in the hook's context.
  const listed = await f.command(['inbox', parent.id, 'lead', '--all']);
  assert.ok(listed.stdout.includes(`[${by.done.id}] Message from agent:${child.id}/done, an agent you started, `));
  assert.doesNotMatch(listed.stdout, /Message from the user/);
  const delivered = JSON.parse(await runHook(f, env)).hookSpecificOutput.additionalContext;
  assert.ok(delivered.includes(`Message from agent:${child.id}/broke, an agent you started (${by.broke.time}): Agent ${child.id}/broke (attempt 1) failed`));
  assert.match(delivered, /that agent is waiting on you\. Handle it now, before your next step on your own work/);
  assert.doesNotMatch(delivered, /from the user|reply .* lead/);

  // A second watcher for the same attempt finds the claim and sends nothing.
  const gone = spawnSync('true').pid;
  const again = spawnSync(process.execPath, [watcher, child.dir, 'done', '1', String(gone)], { env: f.env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(inboxOf(parent, 'lead').length, 3, 'one notice per attempt');

  // A new attempt ends with a notice of its own.
  await f.command(['start', child.id, 'done', '--agent', 'claude', '--read-only',
    '--brief', f.brief('done-again', { finalMessage: 'Fixed.' }), '--', '--session', 'fixture-claude'], { env });
  await notice(child, 'done', 2);
  const latest = inboxOf(parent, 'lead');
  assert.equal(latest.length, 4);
  assert.deepEqual(latest.at(-1).about, { run: child.id, task: 'done', attempt: 2 });
  assert.match(latest.at(-1).text, /\(attempt 2\) completed and is ready for your review\.\n/);
});

test('a top-level run sends no notice; a stopped child still notifies, from outside the relay\'s process group', async (t) => {
  const { f, parent, child, env } = await family(t);
  // The user's own session started `lead` and `solo`: no parent task, no watcher, no notice.
  assert.equal(readJson(f.taskFile(parent, 'lead')).startedBy, null);
  const solo = await f.start(parent, 'solo', { flags: ['--read-only'] });
  await f.finished(parent, 'solo');
  assert.equal(readJson(f.taskFile(parent, 'solo')).startedBy, null);
  assert.equal(fs.existsSync(path.join(solo.outDir, 'parent-notice.log')), false);
  assert.equal(fs.existsSync(noticeFile(parent, 'solo')), false);
  // A parent named in the environment that does not exist is no parent either.
  const orphan = await f.start(child, 'orphan', { flags: ['--read-only'], env: as({ id: 'no-such-run' }, 'nobody') });
  await f.finished(child, 'orphan');
  assert.equal(readJson(f.taskFile(child, 'orphan')).startedBy, null);
  assert.equal(fs.existsSync(path.join(orphan.outDir, 'parent-notice.log')), false);

  const held = await f.start(child, 'held', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(held);
  // The task's PID is still the relay's, so relayAlive and the running state hold.
  assert.match(ps(['-ww', '-o', 'command=', '-p', String(held.pid)]), /relay\.mjs/);
  assert.equal((await f.json(['status', child.id])).tasks.find((row) => row.id === 'held').state, 'running');
  const watching = await eventually(() => watcherOf(child, 'held', 1, held.pid), 'no watcher');
  const relayGroup = table().find((row) => row.pid === held.pid).pgid;
  assert.notEqual(watching.pgid, relayGroup);
  assert.equal(table().some((row) => row.pgid === relayGroup && row.command.includes('finish-notice.mjs')), false);

  const stopped = await f.command(['stop', child.id, 'held']);
  assert.match(stopped.stdout, /^stopped held/);
  const record = await notice(child, 'held');
  assert.equal(record.state, 'stopped');
  const sent = inboxOf(parent, 'lead').find((m) => m.id === record.message);
  assert.match(sent.text, new RegExp(`^Agent ${child.id}/held \\(attempt 1\\) failed \\(stopped\\): `));
  assert.equal((await f.json(['status', child.id])).tasks.find((row) => row.id === 'held').state, 'stopped');
});

test('wait is woken by a watched child\'s result, not again by its notice; a notice about another task wakes it', async (t) => {
  const { f, parent, child, env } = await family(t);
  const kid = await f.start(child, 'kid', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(kid);
  const waited = await f.waitAfterPoll([child.id, '--timeout', '0', '--json'], async () => {
    f.release(kid);
    await notice(child, 'kid');
  }, { env });
  const out = JSON.parse(waited.stdout);
  assert.equal(out.finished, true);
  assert.equal(out.message, undefined);
  assert.equal(fs.existsSync(path.join(parent.dir, 'tasks', 'lead', 'wake-pending.json')), false);
  assert.equal(inboxOf(parent, 'lead').filter((m) => !m.read).length, 1, 'the notice stays for the hook or inbox');

  await f.command(['result', child.id, 'kid']);
  const other = await f.start(child, 'other', { config: { hold: true }, flags: ['--read-only'], env });
  const next = await f.start(child, 'next', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(other);
  await f.ready(next);
  const woken = await f.waitAfterPoll([child.id, 'other', '--timeout', '0', '--json'], async () => {
    f.release(next);
    await notice(child, 'next');
  }, { code: 6, env });
  assert.equal(JSON.parse(woken.stdout).message.text.split('\n')[0], `Agent ${child.id}/next (attempt 1) completed and is ready for your review.`);
  f.release(other);
  await notice(child, 'other');
});

test('ask reaches a running parent task as a labelled question, and the answer comes back to the asker', async (t) => {
  const { f, parent, child, env } = await family(t);
  const asker = await f.start(child, 'asker', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(asker);
  const me = as(child, 'asker', 2);
  const refused = await f.command(['ask', 'Which?', '--options', 'a|b', '--recommend', 'c'], { code: 2, env: me });
  assert.match(refused.stderr, /--recommend must be one of the options: a, b/);
  assert.match((await f.command(['ask', 'Which?'], { code: 2 })).stderr, /ask is for a delegated agent/);

  const asked = await f.json(['ask', 'Which database for the cache?', '--options', 'pg | sqlite', '--recommend', 'pg'], { env: me });
  assert.equal(asked.to, `agent:${parent.id}/lead`);
  assert.deepEqual([asked.question, asked.options, asked.recommend, asked.attempt], ['Which database for the cache?', ['pg', 'sqlite'], 'pg', 1]);
  const [question] = inboxOf(parent, 'lead');
  assert.equal(question.id, asked.message);
  assert.equal(question.from, `agent:${child.id}/asker`);
  assert.equal(question.kind, 'question');
  assert.deepEqual(question.about, { run: child.id, task: 'asker', attempt: 1 });
  assert.match(question.text, /keeps working meanwhile:\nWhich database for the cache\?\nOptions: pg \| sqlite\nRecommended: pg\n/);
  assert.ok(question.text.includes(`\`node ${cli} send ${child.id} asker "<answer>"\``));
  // It went to the parent task, so it is not the user's: no attention item.
  assert.deepEqual((await f.json(['wait', child.id, '--timeout', '1ms'], { code: 3 })).attention, []);

  // The parent answers with send; the asker reads it in its own inbox.
  await f.command(['send', child.id, 'asker', 'Use pg.']);
  const read = await f.json(['inbox', child.id, 'asker', '--ack'], { env: me });
  assert.deepEqual(read.messages.map((m) => m.text), ['Use pg.']);
  f.release(asker);
  await notice(child, 'asker');
});

test('ask from a top-level task is a question in the attention lane, wakes wait with exit 5, and clears as soon as a later message is sent', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('top');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  await f.start(run, 'decides', { config: { finalMessage: 'NEEDS DECISION:\n- Keep the old flag? Recommendation: no.' }, flags: ['--read-only'] });
  await f.finished(run, 'decides');
  await f.command(['result', run.id, 'decides']);
  const me = as(run, 'asker');
  // A message sent before the question does not answer it.
  await f.command(['send', run.id, 'asker', 'An earlier note.']);
  let asked;
  const waited = await f.waitAfterPoll([run.id, '--timeout', '0', '--json'], async () => {
    asked = await f.command(['ask', 'Which database for the cache?', '--options', 'pg|sqlite', '--recommend', 'pg'], { env: me });
  }, { code: 5 });
  assert.match(asked.stdout, /^asked the user on the dashboard \(question \w+\)\nKeep working on everything that does not depend on the answer/);
  assert.ok(asked.stdout.includes(`node ${cli} nap 5m`));
  const reason = 'Which database for the cache? · options: pg | sqlite · recommends pg';
  const woken = JSON.parse(waited.stdout);
  assert.deepEqual(woken.attention.map((a) => [a.task, a.kind, a.rank]), [['asker', 'question', 0.5], ['decides', 'needs-decision', 1]]);
  assert.equal(woken.attention.find((a) => a.task === 'asker').reason, reason);
  const listed = await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3 });
  assert.ok(listed.stdout.includes(`asker: question — ${reason}`));
  assert.ok(listed.stdout.includes(`asker asked a question and keeps working: answer what the user's request covers with \`node ${cli} send ${run.id} <task> "<answer>"\``));

  // First in the dashboard's lane, ahead of a handed-back decision.
  const board = await f.dashboard();
  const lane = async () => (await board.json('/api/state')).flatMap((s) => s.attention).filter((a) => ['asker', 'decides'].includes(a.id));
  const items = await lane();
  assert.deepEqual(items.map((a) => [a.id, a.kind, a.rank, a.label]), [['asker', 'question', 0.5, 'question'], ['decides', 'needs-decision', 1, 'needs decision']]);
  assert.equal(items[0].reason, reason);

  const open = async () => (await f.json(['wait', run.id, 'asker', '--timeout', '1ms'], { code: 3 })).attention.map((a) => a.kind);
  await f.command(['inbox', run.id, 'asker', '--ack'], { env: me });
  assert.deepEqual(await open(), ['question'], 'reading an earlier message does not clear it');
  await f.command(['send', run.id, 'asker', 'Use pg.']);
  assert.deepEqual(await open(), [], 'a sent answer clears it before the agent reads it');
  await eventually(async () => (await lane()).every((a) => a.id !== 'asker'), 'the question stayed in the lane');
});

test('an attempt\'s notice still goes out, once, when the next attempt starts before its watcher runs', async (t) => {
  const { f, parent, child, env } = await family(t);
  const first = await f.start(child, 'redo', { config: { hold: true, status: 'failed', error: 'First attempt broke' }, flags: ['--read-only'], env });
  await f.ready(first);
  await holdBack(child, 'redo', 1, first.pid);
  f.release(first);
  await f.finished(child, 'redo');
  const second = JSON.parse((await f.command(['start', child.id, 'redo', '--agent', 'claude', '--read-only', '--json',
    '--brief', f.brief('redo-2', { hold: true, finalMessage: 'Fixed now.' }), '--', '--session', 'fixture-claude'], { env })).stdout);
  await f.ready(second);
  assert.deepEqual(readJson(f.taskFile(child, 'redo')).attemptStartedBy, { 1: { run: parent.id, task: 'lead' }, 2: { run: parent.id, task: 'lead' } });

  // Attempt 1's watcher runs only now, while attempt 2 runs.
  const late = () => spawnSync(process.execPath, [watcher, child.dir, 'redo', '1', String(first.pid), 'not the relay\'s start'], { env: f.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(late().status, 0);
  const record = readJson(noticeFile(child, 'redo', 1));
  assert.deepEqual([record.state, record.later, record.to, Boolean(record.message)], ['failed', 2, `${parent.id}/lead`, true]);
  const aboutRedo = (n) => inboxOf(parent, 'lead').filter((m) => m.about?.task === 'redo' && m.about.attempt === n);
  assert.equal(aboutRedo(1).length, 1);
  assert.match(aboutRedo(1)[0].text, new RegExp(`^Agent ${child.id}/redo \\(attempt 1\\) failed \\(failed\\): First attempt broke\\n`));
  assert.ok(aboutRedo(1)[0].text.includes(`Attempt 2 has started since, so \`result\` shows that one; this attempt's report is in ${path.join(child.dir, 'tasks', 'redo', 'attempt-1', 'result.json')}.`));
  assert.equal(late().status, 0);
  assert.equal(aboutRedo(1).length, 1, 'still one notice for attempt 1');

  f.release(second);
  await notice(child, 'redo', 2);
  assert.equal(aboutRedo(2).length, 1);
  assert.match(aboutRedo(2)[0].text, /\(attempt 2\) completed and is ready for your review\.\n/);
  assert.doesNotMatch(aboutRedo(2)[0].text, /has started since/);
});

test('ask falls back to a question for the user when the parent task will not read messages', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { agent: 'codex', config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  // An attempt started before messages existed: its brief has no inbox note, so Codex never reads them.
  const brief = path.join(lead.outDir, 'orch-brief.md');
  fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace('## Messages from your orchestrator', '## Notes'));
  const env = as(parent, 'lead');
  const child = await f.newRun('child', env);
  const asker = await f.start(child, 'asker', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(asker);
  const me = as(child, 'asker', 2);
  const asked = await f.command(['ask', 'Which region?', '--options', 'eu|us', '--recommend', 'eu'], { env: me });
  assert.ok(asked.stdout.startsWith(`asked the user on the dashboard (your parent ${parent.id}/lead cannot take it: it will not read messages (this attempt's brief has no inbox note, so Codex will not read it)) (question `), asked.stdout);
  assert.deepEqual(inboxOf(parent, 'lead'), [], 'nothing left in an inbox nobody reads');
  const [question] = fs.readFileSync(path.join(child.dir, 'tasks', 'asker', 'questions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(question.to, 'user');
  const woken = await f.json(['wait', child.id, '--timeout', '1ms'], { code: 3 });
  assert.deepEqual(woken.attention.map((a) => [a.task, a.kind, a.reason]), [['asker', 'question', 'Which region? · options: eu | us · recommends eu']]);
  f.release(asker);
  const record = await notice(child, 'asker');
  assert.equal(record.reaches, false, 'the finish notice records that the parent will not read it');
});

test('a PID that now belongs to another relay counts as ended, and the notice reports the attempt\'s own result', async (t) => {
  const { f, parent, child, env } = await family(t);
  const gone = await f.start(child, 'gone', { config: { hold: true, finalMessage: 'Gone and done.' }, flags: ['--read-only'], env });
  await f.ready(gone);
  await holdBack(child, 'gone', 1, gone.pid);
  f.release(gone);
  await f.finished(child, 'gone');
  // Another relay holds the PID now: the watcher gets that PID and the start time it recorded for
  // the ended relay, which is earlier (`lstart` counts seconds, so two fixture relays can share one).
  const other = await f.start(child, 'other', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(other);
  const started = 'Thu  1 Jan 00:00:00 2026';
  assert.ok(lstart(other.pid) && lstart(other.pid) !== started);
  const shell = (identity, timeout) => spawnSync('/bin/sh', ['-c', WAIT_SCRIPT, 'finish-notice', String(other.pid), identity, 'echo', 'ended'], { encoding: 'utf8', timeout });
  assert.equal(shell(started, 10_000).stdout, `ended ${started}\n`, 'the shell stops waiting at once');
  const waiting = shell('', 2500);
  assert.deepEqual([waiting.signal, waiting.stdout], ['SIGTERM', ''], 'it still waits on the relay it recorded');

  const sent = spawnSync(process.execPath, [watcher, child.dir, 'gone', '1', String(other.pid), started], { env: f.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(sent.status, 0, sent.stderr);
  const record = readJson(noticeFile(child, 'gone'));
  assert.deepEqual([record.state, record.relayStarted, Boolean(record.message)], ['completed', started, true]);
  const message = inboxOf(parent, 'lead').find((m) => m.id === record.message);
  assert.match(message.text, new RegExp(`^Agent ${child.id}/gone \\(attempt 1\\) completed and is ready for your review\\.`));
  f.release(other);
  await f.finished(child, 'other');
});

test('attentionOf ranks an open question first, and only while the asker runs', () => {
  const question = { id: 'q1', time: '2026-01-01T00:00:10.000Z', text: 'Ship today?\nmore', options: [], recommend: null, open: 2 };
  const item = attentionOf({ state: 'running', health: 'ok', question, lastActiveMs: 5 }, false);
  assert.deepEqual(item, { kind: 'question', rank: 0.5, label: 'question', reason: 'Ship today? · +1 more', sinceMs: Date.parse(question.time) });
  assert.equal(attentionOf({ state: 'completed', phase: 'awaiting-review', question, awaitingReviewMs: 1 }, false).kind, 'awaiting-review');
  assert.equal(attentionOf({ state: 'running', question }, true), null);
});

test('decision escalation defaults to 2 minutes, never later than the general delay, and sets the check interval', () => {
  const saved = { general: process.env.AGENT_ORCH_ESCALATE_AFTER, decision: process.env.AGENT_ORCH_DECISION_ESCALATE_AFTER };
  const set = (general, decision) => {
    for (const [name, value] of [['AGENT_ORCH_ESCALATE_AFTER', general], ['AGENT_ORCH_DECISION_ESCALATE_AFTER', decision]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    set(undefined, undefined);
    assert.deepEqual(escalationDelays(), { after: 600_000, decisionAfter: 120_000 });
    assert.equal(escalationCheckMs(), 10_000);
    set('1500ms', undefined);
    assert.deepEqual(escalationDelays(), { after: 1500, decisionAfter: 1500 });
    set('10m', '5m');
    assert.deepEqual(escalationDelays(), { after: 600_000, decisionAfter: 300_000 });
    set('1h', '2s');
    assert.equal(escalationCheckMs(), 1000);
  } finally {
    set(saved.general, saved.decision);
  }
});

test('decisions and questions escalate after AGENT_ORCH_DECISION_ESCALATE_AFTER; other kinds keep the longer delay', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, { AGENT_ORCH_NOTIFY: 'off', AGENT_ORCH_ESCALATE_AFTER: '1h', AGENT_ORCH_DECISION_ESCALATE_AFTER: '200ms' });
  const output = path.join(f.root, 'notices.jsonl');
  const script = path.join(f.root, 'notify.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nlet text=''; for await (const chunk of process.stdin) text+=chunk;\nfs.appendFileSync(process.argv[2], text);\n");
  writeJson(path.join(f.state, 'notify.json'), { command: [process.execPath, script, output] });
  const messages = () => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const run = await f.newRun();
  await f.start(run, 'decides', { config: { finalMessage: 'NEEDS DECISION: Which service?' }, flags: ['--read-only'] });
  await f.finished(run, 'decides');
  await f.start(run, 'broke', { config: { status: 'failed', error: 'Build failed' }, flags: ['--read-only'] });
  await f.finished(run, 'broke');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  await f.command(['ask', 'Ship it today?'], { env: as(run, 'asker') });
  await f.dashboard();
  await eventually(() => messages().length === 2, 'decision and question did not escalate', 20_000);
  assert.deepEqual(messages().map((m) => [m.task, m.kind]).sort(), [['asker', 'question'], ['decides', 'needs-decision']]);
  assert.match(messages().find((m) => m.kind === 'question').reason, /^Ship it today\?/);
  const records = Object.values(readJson(path.join(f.state, 'escalations.json')));
  const broke = records.find((r) => r.task === 'broke');
  assert.ok(broke, 'the failure has a pending timer');
  assert.equal(broke.escalatedAt, undefined);
});
