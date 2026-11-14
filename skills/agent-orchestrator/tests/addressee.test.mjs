import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// Every attention item has an addressee: the agent that must act on it, or the user. These tests
// drive the CLI and the dashboard with fixture runs whose launching session is set explicitly,
// because `new` otherwise records whichever session runs the suite.

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
// The run's launching session last had a live `wait` on it `n` minutes ago.
const waitedAgo = (run, n) => writeJson(path.join(run.dir, 'main-wait.json'), { pid: 1, at: minutesAgo(n) });
const setOrchestrator = (run, orchestrator) => {
  const file = path.join(run.dir, 'run.json');
  writeJson(file, { ...readJson(file), orchestrator });
};
const inboxOf = (run, id) => {
  const file = path.join(run.dir, 'tasks', id, 'inbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const questionsOf = (run, id) => fs.readFileSync(path.join(run.dir, 'tasks', id, 'questions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

async function finish(f, run, id, config = {}, opts = {}) {
  await f.start(run, id, { config, flags: ['--read-only'], ...opts });
  return f.finished(run, id);
}

// A run with a running task `lead` that reads its messages (the orch-inbox hook is registered), and
// a run that `lead` created for its own agents.
async function family(f) {
  fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: `node ${hook}` }] }] } }));
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const child = await f.newRun('child', as(parent, 'lead'));
  return { parent, lead, child, env: as(parent, 'lead') };
}

// Escalation deliveries through notify.json, with macOS notifications off unless a test turns them on.
function notifier(f) {
  f.env.AGENT_ORCH_NOTIFY = 'off';
  f.env.AGENT_ORCH_ESCALATE_AFTER = '100ms';
  const output = path.join(f.root, 'notices.jsonl');
  const script = path.join(f.root, 'notify.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nlet text=''; for await (const chunk of process.stdin) text+=chunk;\nfs.appendFileSync(process.argv[2], text);\n");
  writeJson(path.join(f.state, 'notify.json'), { command: [process.execPath, script, output] });
  return {
    messages: () => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    records: () => (fs.existsSync(path.join(f.state, 'escalations.json')) ? Object.values(readJson(path.join(f.state, 'escalations.json'))) : []),
  };
}

const laneOf = async (board) => Object.fromEntries((await board.json('/api/state')).flatMap((s) => s.attention).map((a) => [a.id, a]));

test('each item names who must act: the launching session, the parent task, or the user', async (t) => {
  const f = await fixture(t);
  // A top-level run whose launching session is present: no wait yet, but the run is new.
  const top = await f.newRun('top');
  f.launchingSession(top, 'livesess-0001');
  await finish(f, top, 'review');
  await finish(f, top, 'broke', { status: 'failed', error: 'Build failed' });
  await finish(f, top, 'limited', { status: 'failed', error: 'Usage limit reached' });
  await finish(f, top, 'decides', { finalMessage: 'NEEDS DECISION: Which endpoint?' });
  // A run started from a terminal: the user is its orchestrator.
  const term = await f.newRun('terminal');
  f.launchingSession(term, null, 'terminal');
  await finish(f, term, 'mine', { status: 'failed', error: 'Oops' });
  // A session whose process has ended, and one with no wait on its run for 20 minutes.
  const ended = await f.newRun('ended');
  setOrchestrator(ended, { agent: 'claude', sessionId: 'endedses-0001', pid: spawnSync('true').pid });
  await finish(f, ended, 'orphan');
  const idle = await f.newRun('idle');
  f.launchingSession(idle, 'idlesess-0001');
  waitedAgo(idle, 20);
  await finish(f, idle, 'stale');
  // Nested runs: `gone-lead` has finished, so its sub-agent's item goes on to the session above it;
  // `lead` runs (last, since a held fake relay fails after 30s).
  const earlier = await f.newRun('earlier');
  f.launchingSession(earlier, 'earliers-0001');
  await finish(f, earlier, 'gone-lead');
  const orphans = await f.newRun('orphans', as(earlier, 'gone-lead'));
  await finish(f, orphans, 'kid2', {}, { env: as(earlier, 'gone-lead') });
  const { parent, lead, child, env } = await family(f);
  await finish(f, child, 'kid', {}, { env });

  const board = await f.dashboard();
  const lane = await laneOf(board);
  f.release(lead);
  const who = (id) => [lane[id]?.to, lane[id]?.agent, lane[id]?.gone];
  assert.deepEqual(who('review'), ['agent', 'orchestrator session livesess', null]);
  assert.deepEqual(who('broke'), ['agent', 'orchestrator session livesess', null]);
  assert.deepEqual(who('limited'), ['user', null, null], 'a usage limit is the user\'s');
  assert.deepEqual(who('decides'), ['agent', 'orchestrator session livesess', null], 'a decision handed back in a top-level run goes to its session first');
  assert.deepEqual(who('mine'), ['user', null, null]);
  assert.deepEqual(who('orphan'), ['user', 'orchestrator session endedses', 'its process has ended']);
  assert.deepEqual(who('stale'), ['user', 'orchestrator session idlesess', 'no wait on its run for 20m']);
  assert.deepEqual(who('kid'), ['agent', `task ${parent.id}/lead`, null]);
  assert.deepEqual(who('kid2'), ['agent', 'orchestrator session earliers', null]);
  assert.deepEqual(lane.kid2.passed, [`task ${earlier.id}/gone-lead is not running`]);

  // A live wait of the session makes the idle run's items the session's again.
  waitedAgo(idle, 0);
  await eventually(async () => (await laneOf(board)).stale?.to === 'agent', 'a fresh wait did not bring the session back');
});

test('an item for an agent sends no notice: no macOS notification, no notify.json, no browser event', async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  // Real macOS delivery, through a fake osascript that records each call.
  delete f.env.AGENT_ORCH_NOTIFY;
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(f.root, 'osascript.jsonl');
  fs.writeFileSync(path.join(bin, 'osascript'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  f.env.PATH = `${bin}${path.delimiter}${f.env.PATH}`;
  const run = await f.newRun('agents');
  f.launchingSession(run, 'agentses-0001');
  await finish(f, run, 'review');
  await finish(f, run, 'broke', { status: 'failed', error: 'Build failed' });
  await finish(f, run, 'decides', { finalMessage: 'NEEDS DECISION: Which endpoint?' });
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  await f.command(['ask', 'Which cache?'], { env: as(run, 'asker') });
  // The one item for the user: once its notice is out, every item's delay has passed, because the
  // dashboard checks them all in one pass and the others are older.
  await finish(f, run, 'limited', { status: 'failed', error: 'Usage limit reached' });
  const board = await f.dashboard();
  const lane = await laneOf(board);
  assert.deepEqual(['review', 'broke', 'decides', 'asker', 'limited'].map((id) => lane[id].to), ['agent', 'agent', 'agent', 'agent', 'user']);
  await eventually(() => notify.messages().length > 0, 'the user\'s item was not delivered', 20_000);
  assert.deepEqual(notify.messages().map((m) => m.task), ['limited']);
  const records = notify.records();
  for (const id of ['review', 'broke', 'decides', 'asker']) {
    const record = records.find((r) => r.task === id);
    assert.ok(record, `${id} keeps a timer`);
    assert.equal(record.escalatedAt, undefined, `${id} was not escalated`);
  }
  if (process.platform === 'darwin') {
    await eventually(() => fs.existsSync(calls), 'osascript was not called for the user\'s item');
    const scripts = fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)[1]);
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /display notification "limited · /);
  }
  f.release(asker);
});

test('an item goes to the user once its agent is gone, and its notice says so', async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  const run = await f.newRun('gone');
  f.launchingSession(run, 'gonesess-0001');
  waitedAgo(run, 20);
  await finish(f, run, 'review');
  await finish(f, run, 'decides', { finalMessage: 'NEEDS DECISION: Which endpoint?' });
  // `lead` has ended and its run was started from a terminal, so its sub-agent's item ends with the user.
  const parent = await f.newRun('parent');
  f.launchingSession(parent, null, 'terminal');
  await finish(f, parent, 'lead');
  const child = await f.newRun('child', as(parent, 'lead'));
  await finish(f, child, 'kid', {}, { env: as(parent, 'lead') });
  await f.dashboard();
  const by = await eventually(() => {
    const sent = Object.fromEntries(notify.messages().map((m) => [m.task, m]));
    return sent.review && sent.kid && sent.decides ? sent : null;
  }, 'the items of gone agents did not reach the user', 20_000);
  assert.match(by.review.reason, /^orchestrator session gonesess is gone \(no wait on its run for 20m\); review has waited \d+m for review$/);
  assert.equal(by.review.kind, 'awaiting-review');
  assert.match(by.decides.reason, /^orchestrator session gonesess is gone \(no wait on its run for 20m\); decides has waited \d+m for a decision$/);
  assert.ok(by.kid.reason.startsWith(`task ${parent.id}/lead is gone (it is not running); kid has waited `), by.kid.reason);
});

test('wait reminds once per interval about a finished task left without accept, verdict or close', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'built', { config: { finalMessage: 'Parser rewritten.' } });
  await f.finished(run, 'built');
  await finish(f, run, 'read');
  // Both finished 20 minutes ago, past AGENT_ORCH_REVIEW_REMIND (10m).
  for (const id of ['built', 'read']) {
    const file = path.join(run.dir, 'tasks', id, 'attempt-1', 'result.json');
    writeJson(file, { ...readJson(file), finishedAt: minutesAgo(20) });
  }
  const first = await f.command(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.match(first.stdout, /\nbuilt has waited 20m for review: not accepted, closed or given a verdict\. Handle it now:\n/);
  for (const command of [`accept ${run.id} built --note "<why>"`, `verdict ${run.id} built changes --note "<fixes>"`, `close ${run.id} built`, `result ${run.id} read`, `close ${run.id} read`]) {
    assert.ok(first.stdout.includes(`node ${cli} ${command}`), command);
  }
  assert.doesNotMatch(first.stdout, /accept \S+ read/, 'a read-only task has nothing to accept');
  assert.match(first.stdout, /\(review overdue: built, read\)\n\(built, read finished and nobody has read their results/);

  // Within the interval the reminder stays quiet; the unread results still wake wait (exit 0).
  const second = await f.command(['wait', run.id, '--timeout', '1m'], { code: 0 });
  assert.doesNotMatch(second.stdout, /review overdue|for review: not accepted/);

  // Once the interval has passed, it reminds again.
  const ledger = path.join(run.dir, 'review-reminders.json');
  const passed = () => writeJson(ledger, Object.fromEntries(Object.entries(readJson(ledger)).map(([id, r]) => [id, { ...r, at: minutesAgo(11) }])));
  passed();
  const third = await f.json(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.deepEqual(third.reminders.map((r) => [r.task, r.attempt]), [['built', 1], ['read', 1]]);
  assert.ok(third.reminders.every((r) => r.waitedMs >= 20 * 60_000));

  // A verdict on this attempt, or closing the task, ends it.
  await f.command(['verdict', run.id, 'built', 'changes', '--note', 'Keep the old parser as a fallback.']);
  await f.command(['close', run.id, 'read']);
  passed();
  const fourth = await f.command(['wait', run.id, '--timeout', '1m'], { code: 0 });
  assert.doesNotMatch(fourth.stdout, /review overdue/);

  // AGENT_ORCH_REVIEW_REMIND=0 turns it off.
  await f.start(run, 'later', { config: { finalMessage: 'Docs done.' } });
  await f.finished(run, 'later');
  const later = path.join(run.dir, 'tasks', 'later', 'attempt-1', 'result.json');
  writeJson(later, { ...readJson(later), finishedAt: minutesAgo(20) });
  const off = await f.command(['wait', run.id, 'later', '--timeout', '1m'], { code: 0, env: { AGENT_ORCH_REVIEW_REMIND: '0' } });
  assert.doesNotMatch(off.stdout, /review overdue/);
});

test('tell sends a one-way note: to the launching session\'s next wait, or into the parent task\'s inbox', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('top');
  f.launchingSession(run, 'tellsess-0001');
  const kid = await f.start(run, 'kid', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(kid);
  assert.match((await f.command(['tell', 'Pushed.'], { code: 2 })).stderr, /tell is for a delegated agent/);
  assert.match((await f.command(['tell'], { code: 2, env: as(run, 'kid') })).stderr, /missing the note/);

  const told = await f.command(['tell', 'PUSHED #12 abc1234: ready for review'], { env: as(run, 'kid') });
  assert.match(told.stdout, new RegExp(`^told your orchestrator, orchestrator session tellsess: its next \`wait\` on run ${run.id} prints it \\(note \\w+\\)\\n$`));
  // A note does not end wait (wait-notes.test.mjs): this one prints when the timeout exits 3.
  const woken = await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3 });
  assert.match(woken.stdout, new RegExp(`\\nnote from agent ${run.id}/kid \\([^)]+\\): PUSHED #12 abc1234: ready for review\\n\\(a note from your tasks, sent with \`tell\`: no answer needed\\)\\n$`));
  // Printed once, never an attention item, so nothing escalates it.
  const quiet = await f.json(['wait', run.id, '--timeout', '1ms'], { code: 3 });
  assert.equal(quiet.notes, undefined);
  assert.deepEqual(quiet.attention, []);
  // A wait that an orch task runs leaves the session's notes alone.
  await f.command(['tell', 'Second note.'], { env: as(run, 'kid') });
  await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3, env: as(run, 'kid') });
  // --notes ends wait at the note itself, with exit 6.
  assert.match((await f.command(['wait', run.id, '--notes', '--timeout', '1m'], { code: 6 })).stdout, /: Second note\.\n/);

  // In a nested run, the note goes into the parent task's inbox, marked as needing no answer.
  const { parent, lead, child, env } = await family(f);
  const nested = await f.start(child, 'nested', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(nested);
  const sent = await f.json(['tell', 'Checks are green.'], { env: as(child, 'nested', 2) });
  assert.equal(sent.to, `agent:${parent.id}/lead`);
  const [note] = inboxOf(parent, 'lead');
  assert.deepEqual([note.id, note.kind, note.from], [sent.message, 'note', `agent:${child.id}/nested`]);
  assert.equal(note.text, `Note from agent ${child.id}/nested (attempt 1), which needs no answer:\nChecks are green.`);
  const listed = await f.command(['inbox', parent.id, 'lead'], { env });
  assert.match(listed.stdout, /that agent is not waiting on you, so no answer is needed/);
  assert.doesNotMatch(listed.stdout, /that agent is waiting on you/);

  // A parent that no longer runs cannot take it.
  f.release(lead);
  await f.finished(parent, 'lead');
  const refused = await f.command(['tell', 'Anyone there?'], { code: 1, env: as(child, 'nested', 2) });
  assert.match(refused.stderr, new RegExp(`not delivered: your parent ${parent.id}/lead cannot take it \\(task lead is not running \\(completed\\)\\)\\. Put the note in your final report instead\\.`));
  f.release(nested);
  f.release(kid);
});

test('ask from a top-level run goes to the launching session; --user sends it to the user from any run', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('asks');
  f.launchingSession(run, 'asksess1-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const me = as(run, 'asker');
  const asked = await f.json(['ask', 'Which cache?', '--options', 'pg|sqlite', '--recommend', 'pg'], { env: me });
  assert.equal(asked.to, 'orchestrator');
  const board = await f.dashboard();
  let lane = await laneOf(board);
  assert.deepEqual([lane.asker.kind, lane.asker.to, lane.asker.agent], ['question', 'agent', 'orchestrator session asksess1']);
  await f.command(['send', run.id, 'asker', 'Use pg.']);

  const credential = await f.command(['ask', 'Can you log in to the registry?', '--user'], { env: me });
  assert.match(credential.stdout, /^asked the user on the dashboard \(question \w+\)\n/);
  assert.equal(questionsOf(run, 'asker').at(-1).to, 'user');
  lane = await eventually(async () => {
    const now = await laneOf(board);
    return now.asker?.to === 'user' ? now : null;
  }, 'the question did not move to the user');
  assert.match(lane.asker.reason, /^Can you log in to the registry\?/);

  // From a nested run, --user skips the parent task's inbox.
  const { parent, lead, child, env } = await family(f);
  const nested = await f.start(child, 'nested', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(nested);
  const up = await f.json(['ask', 'Approve the extra cost?', '--user'], { env: as(child, 'nested', 2) });
  assert.equal(up.to, 'user');
  assert.deepEqual(inboxOf(parent, 'lead'), []);
  f.release(nested);
  f.release(lead);
  f.release(asker);
});

test('the lane leads with the user\'s items, counts only them, and mutes the items for agents', async (t) => {
  const f = await fixture(t);
  const board = await f.dashboard();
  const app = await (await board.get('/app.js')).text();
  const start = app.indexOf('const lane=state.flatMap');
  const end = app.indexOf('tick();', start);
  assert.ok(start > 0 && end > start, 'the lane code was found');
  const $ = (tag, attrs = {}, ...kids) => ({ tag, attrs, kids: kids.flat().filter((k) => k != null) });
  const text = (node) => (typeof node === 'string' ? node : node.kids.map(text).join(' '));
  const item = (id, kind, rank, to, agent = null, gone = null) => ({ key: id, id, kind, rank, label: kind, reason: 'why', sinceMs: rank, runId: 'run-1', runGoal: 'Goal', to, agent, gone });
  const render = (attention) => {
    const need = { hidden: true, textContent: '' };
    const root = { children: [], append(...nodes) { this.children.push(...nodes); } };
    vm.runInContext(app.slice(start, end), vm.createContext({ state: [{ id: 'sec', attention }], $, root, document: { getElementById: () => need }, sel: null, sectionTitle: () => 'section', dur: () => '1m', Date }));
    return { need, lane: root.children[0] };
  };

  const both = render([
    item('review', 'awaiting-review', 3, 'agent', 'orchestrator session abcd1234'),
    item('limited', 'failed', 2, 'user'),
    item('stale', 'awaiting-review', 3.5, 'user', 'task run-1/lead', 'it is not running'),
  ]);
  assert.deepEqual([both.need.hidden, both.need.textContent], [false, '2 need attention']);
  const rows = both.lane.kids;
  assert.deepEqual(rows.map((r) => (r.tag === 'h2' ? `# ${text(r)}` : r.attrs['data-key'])), ['# Needs attention', 'sec/limited', 'sec/stale', '# For agents', 'sec/review']);
  assert.match(rows[4].attrs.style, /opacity/);
  assert.match(text(rows[4]), /for orchestrator session abcd1234$/);
  assert.match(text(rows[2]), /task run-1\/lead is gone$/);
  assert.equal(rows[1].attrs.style, undefined);

  const agentsOnly = render([item('review', 'awaiting-review', 3, 'agent', 'task run-1/lead')]);
  assert.equal(agentsOnly.need.hidden, true, 'no count when nothing is the user\'s');
  assert.deepEqual(agentsOnly.lane.kids.map((r) => (r.tag === 'h2' ? `# ${text(r)}` : r.attrs['data-key'])), ['# For agents', 'sec/review']);
});

test('an item for an orch task reaches it as one inbox message when the user would have been told', async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  // A control item for the user: once its notice is out, the nested item's delay has passed too.
  const own = await f.newRun('own');
  f.launchingSession(own, null, 'terminal');
  await finish(f, own, 'limited', { status: 'failed', error: 'Usage limit reached' });
  // A finished child in a nested run, awaiting review: for the orch task that started it.
  const { parent, lead, child, env } = await family(f);
  await finish(f, child, 'kid', {}, { env });
  const board = await f.dashboard();
  assert.deepEqual([(await laneOf(board)).kid.to, (await laneOf(board)).kid.agentTask], ['agent', { run: parent.id, task: 'lead' }]);
  const told = () => inboxOf(parent, 'lead').filter((m) => m.kind === 'attention');
  const [note] = await eventually(() => (told().length ? told() : null), 'the parent task was not told', 20_000);
  assert.equal(note.from, `agent:${child.id}/kid`);
  assert.deepEqual(note.about, { run: child.id, task: 'kid', attempt: 1 });
  assert.match(note.text, new RegExp(`^Agent ${child.id}/kid \\(attempt 1\\), which you started, has waited \\d+m on you: awaiting review — waiting `));
  for (const command of [`result ${child.id} kid`, `accept ${child.id} kid`, `verdict ${child.id} kid changes`, `close ${child.id} kid`]) assert.ok(note.text.includes(`node ${cli} ${command}`), command);
  // The parent sees it as from the agent it started, which waits on it.
  assert.match((await f.command(['inbox', parent.id, 'lead'], { env })).stdout, /that agent is waiting on you/);
  // Once per item: a later pass (the second control's notice) sends nothing more, and the user hears nothing.
  await finish(f, own, 'limited-again', { status: 'failed', error: 'Usage limit reached' });
  await eventually(() => notify.messages().some((m) => m.task === 'limited-again'), 'the second control was not delivered', 20_000);
  assert.equal(told().length, 1);
  assert.deepEqual(notify.messages().map((m) => m.task).sort(), ['limited', 'limited-again']);
  const record = notify.records().find((r) => r.task === 'kid');
  assert.deepEqual([record.agentNotice.to, record.agentNotice.message, record.escalatedAt], [`${parent.id}/lead`, note.id, undefined]);
  f.release(lead);
});

test('an open question for the session wakes every wait until send answers it, even one asked before the wait', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('asks');
  f.launchingSession(run, 'quessess-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  await f.command(['ask', 'Which parser should stay?'], { env: as(run, 'asker') });
  // Asked before this wait began, and still it wakes it, every time.
  const first = await f.json(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.deepEqual(first.questions.map((q) => [q.task, q.text, q.to]), [['asker', 'Which parser should stay?', 'orchestrator']]);
  const again = await f.command(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.ok(again.stdout.includes(`Answer it now with \`node ${cli} send ${run.id} asker "<answer>"\`: wait exits 5 until you do.`), again.stdout);
  // A wait that an orch task runs does not own the session's question.
  await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3, env: as(run, 'asker') });
  await f.command(['send', run.id, 'asker', 'Keep the new one.']);
  const answered = await f.json(['wait', run.id, '--timeout', '1ms'], { code: 3 });
  assert.equal(answered.questions, undefined);
  f.release(asker);
});

// A message from the user, as the dashboard's box sends it.
function sendAsUser(f, board, body) {
  const { port, origin } = new URL(board.url);
  const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/send', method: 'POST', headers: { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json', 'x-orch-token': token } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (s) => { text += s; }).on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('each question keeps its addressee: the lane shows the user\'s, and each side\'s answer closes only its own', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('mixed');
  f.launchingSession(run, 'mixdsess-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const me = as(run, 'asker');
  await f.command(['ask', 'Which parser should stay?'], { env: me });
  await f.command(['ask', 'Can you approve the extra cost?', '--user'], { env: me });
  const row = async () => (await f.json(['status', run.id])).tasks.find((x) => x.id === 'asker');
  let now = await row();
  assert.deepEqual([now.question.text, now.question.to, now.question.open], ['Can you approve the extra cost?', 'user', 1]);
  assert.deepEqual([now.sessionQuestion.text, now.sessionQuestion.to], ['Which parser should stay?', 'orchestrator']);
  const board = await f.dashboard();
  const lane = await laneOf(board);
  assert.deepEqual([lane.asker.to, lane.asker.reason], ['user', 'Can you approve the extra cost?']);

  // The orchestrator's `send` answers the session's question only.
  await f.command(['send', run.id, 'asker', 'Keep the new parser.']);
  now = await row();
  assert.equal(now.sessionQuestion, undefined);
  assert.deepEqual([now.question.text, now.question.to], ['Can you approve the extra cost?', 'user']);
  await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3 });

  // The user's message from the dashboard answers the user's question only.
  await f.command(['ask', 'And the old flag?'], { env: me });
  const sent = await sendAsUser(f, board, { run: run.id, task: 'asker', text: 'Approved.' });
  assert.equal(sent.status, 200, sent.text);
  now = await row();
  assert.deepEqual([now.question.text, now.question.to], ['And the old flag?', 'orchestrator']);
  assert.equal(now.sessionQuestion.text, 'And the old flag?');
  await eventually(async () => (await laneOf(board)).asker?.to === 'agent', 'the user\'s question did not leave the user\'s lane');
  f.release(asker);
});

test('a wait parked in its shell keeps its session present, and the grace is at least two parking intervals', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_AGENT_GRACE = '1ms'; // the floor, twice AGENT_ORCH_PARK_MAX (30s), still applies
  // A session whose record is 10 seconds old and that has no wait: within the 60-second floor.
  const recent = await f.newRun('recent');
  f.launchingSession(recent, 'recesess-0001');
  await finish(f, recent, 'fresh');
  // A session whose wait is parked in its shell, and whose record is old: `ps` shows the wait. The
  // wait watches only `kid`, which runs (last: a held fake relay fails after 30 seconds).
  const parked = await f.newRun('parked');
  f.launchingSession(parked, 'parksess-0001');
  await finish(f, parked, 'later');
  const kid = await f.start(parked, 'kid', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(kid);
  waitedAgo(recent, 10 / 60);
  const waiter = spawn(process.execPath, [cli, 'wait', parked.id, 'kid', '--timeout', '0'], { cwd: f.repo, env: { ...f.env, AGENT_ORCH_PARK_MAX: '10m' }, stdio: 'ignore' });
  const exited = new Promise((resolve) => waiter.on('close', resolve));
  try {
    await eventually(() => spawnSync('ps', ['-p', String(waiter.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.startsWith('sh '), 'the wait did not park', 20_000);
    waitedAgo(parked, 20);
    const board = await f.dashboard();
    const lane = await laneOf(board);
    assert.deepEqual([lane.later.to, lane.later.gone], ['agent', null], 'a parked wait is live');
    assert.deepEqual([lane.fresh.to, lane.fresh.gone], ['agent', null], 'a 10-second-old record is within the floor');
    waiter.kill('SIGTERM');
    await exited;
    await eventually(async () => (await laneOf(board)).later?.gone === 'no wait on its run for 20m', 'the session stayed present once its wait ended');
  } finally {
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGTERM');
    await exited;
    f.release(kid);
  }
});

test('the user\'s reply answers a session\'s question that was shown to the user because the session is gone', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_NOTIFY = 'off';
  const run = await f.newRun('gone-ask');
  f.launchingSession(run, 'goneasks-0001');
  const kid = await f.start(run, 'kid', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(kid);
  const me = as(run, 'kid');
  await f.command(['ask', 'Which parser?'], { env: me });
  waitedAgo(run, 20);
  const board = await f.dashboard();
  const item = async () => (await laneOf(board)).kid;
  assert.deepEqual([(await item()).to, (await item()).gone], ['user', 'no wait on its run for 20m']);
  const row = async () => (await f.json(['status', run.id])).tasks.find((x) => x.id === 'kid');
  const sent = await sendAsUser(f, board, { run: run.id, task: 'kid', text: 'Use the new parser.' });
  assert.equal(sent.status, 200, sent.text);
  const answered = await row();
  assert.equal(answered.question, undefined, 'the user answered the question that was escalated to them');
  assert.equal(answered.sessionQuestion, undefined);
  await eventually(async () => (await item()) === undefined, 'the answered question stayed in the lane');

  // Once the session is back, the user's reply leaves its question to it.
  waitedAgo(run, 0);
  await f.command(['ask', 'Which flag?'], { env: me });
  assert.equal((await sendAsUser(f, board, { run: run.id, task: 'kid', text: 'Drop it.' })).status, 200);
  assert.equal((await row()).sessionQuestion?.text, 'Which flag?');
  f.release(kid);
});
