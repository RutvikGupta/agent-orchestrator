import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, jsonl } from './helpers.mjs';

// `questions` prints the questions agents asked with `ask` in full, and each answer is recorded on
// its question: the time and the id of the message that answered it.

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const questionsFile = (run, id) => path.join(run.dir, 'tasks', id, 'questions.jsonl');
const questionsOf = (run, id) => fs.readFileSync(questionsFile(run, id), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// The fake relay holds for at most 30 seconds, so each test runs only a few commands while it holds.
test('questions prints each open question whole, and wait and inbox point to it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('full');
  f.launchingSession(run, 'fullsess-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const long = `Which cache should the parser use?\n${'Each choice changes how the parser keeps its intermediate tables between passes. '.repeat(6)}The end of the question.`;
  const options = ['an in-memory map that grows without bound', 'sqlite on disk'];
  const asked = await f.json(['ask', long, '--options', options.join('|'), '--recommend', 'sqlite on disk'], { env: as(run, 'asker') });

  // `wait` shows a line of it, and the command that prints it whole.
  const woken = await f.command(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.ok(woken.stdout.includes(`\n  Read it in full, with the options and the recommendation: \`node ${cli} questions ${run.id} asker\``), woken.stdout);
  assert.ok(!woken.stdout.includes('The end of the question.'), 'wait cuts it short');

  const { stdout } = await f.command(['questions', run.id, 'asker']);
  assert.ok(stdout.startsWith(`1 open question for asker in run ${run.id}:\n\n`), stdout);
  assert.match(stdout, new RegExp(`\\n\\[${asked.id}\\] asker, attempt 1, asked the session that launched the run at ${escape(asked.time)} \\(\\d+m ago\\):\\n${escape(long)}\\n`));
  assert.ok(stdout.includes(`\nOptions:\n  - ${options[0]}\n  - ${options[1]}\nRecommended: sqlite on disk\nAnswer it with: node ${cli} send ${run.id} asker "<answer>"\n`), stdout);
  const listed = await f.json(['questions', run.id]);
  assert.deepEqual([listed.task, listed.counts], [null, { open: 1, answered: 0, unanswered: 0 }]);
  assert.deepEqual(listed.questions.map((q) => [q.id, q.task, q.attempt, q.time, q.to, q.question, q.options, q.recommend, q.state]),
    [[asked.id, 'asker', 1, asked.time, 'orchestrator', long, options, 'sqlite on disk', 'open']]);
  assert.equal('answeredAt' in questionsOf(run, 'asker')[0], false, 'an open question has no answer fields');

  // `inbox` with no task points to `questions`.
  const missing = await f.command(['inbox', run.id], { code: 2 });
  assert.ok(missing.stderr.includes('missing TASK id') && missing.stderr.includes(`node ${cli} questions ${run.id}`), missing.stderr);
  f.release(asker);
});

test('send records the answer on the question, and --all lists answered questions and those whose attempt ended', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('answers');
  f.launchingSession(run, 'answsess-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const asked = await f.json(['ask', 'Which cache should the parser use?', '--options', 'memory|sqlite', '--recommend', 'sqlite'], { env: as(run, 'asker') });
  // The orchestrator's `send` answers it, and the answer is written on the question's own line.
  const size = fs.statSync(questionsFile(run, 'asker')).size;
  const sent = await f.json(['send', run.id, 'asker', 'Use sqlite.']);
  const [record] = questionsOf(run, 'asker');
  assert.deepEqual([record.id, record.question, record.answeredAt, record.answerMessage], [asked.id, 'Which cache should the parser use?', sent.time, sent.id]);
  assert.equal(fs.statSync(questionsFile(run, 'asker')).size, size, 'the line is written in place');
  assert.equal((await f.json(['wait', run.id, '--timeout', '1ms'], { code: 3 })).questions, undefined, 'wait no longer reports it');
  // A question still open when its attempt ends is listed with --all as not answered.
  const later = await f.json(['ask', 'Shall I also drop the old flag?'], { env: as(run, 'asker') });
  f.release(asker);
  await f.finished(run, 'asker');

  assert.equal((await f.command(['questions', run.id])).stdout, `no open questions in run ${run.id} (2 earlier questions: --all lists them with their answers)\n`);
  const all = await f.command(['questions', run.id, '--all']);
  assert.ok(all.stdout.startsWith(`2 questions in run ${run.id}: 0 open, 1 answered, 1 not answered before their attempt ended\n\n== Answered:\n\n[${asked.id}] `), all.stdout);
  assert.match(all.stdout, new RegExp(`\\nRecommended: sqlite\\nAnswered at ${escape(sent.time)} \\(\\d+m ago\\) by message ${sent.id}, sent with \`send\`\\.\\n`));
  assert.ok(all.stdout.includes(`\n== Not answered (the attempt that asked has ended):\n\n[${later.id}] `), all.stdout);
  assert.ok(all.stdout.endsWith('Shall I also drop the old flag?\nNot answered: attempt 1 ended first.\n'), all.stdout);
  const json = await f.json(['questions', run.id, '--all']);
  assert.deepEqual(json.counts, { open: 0, answered: 1, unanswered: 1 });
  assert.deepEqual(json.questions.map((q) => [q.id, q.state, q.answeredAt, q.answerMessage, q.answeredVia]),
    [[asked.id, 'answered', sent.time, sent.id, 'send'], [later.id, 'unanswered', undefined, undefined, undefined]]);
});

test('the user answers a question to the user from the dashboard, and send does not answer it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('user-asks');
  f.launchingSession(run, 'usersess-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const asked = await f.json(['ask', 'Can you approve the extra cost?', '--user'], { env: as(run, 'asker') });
  await f.command(['send', run.id, 'asker', 'A note that is not the user\'s answer.']);
  const open = await f.command(['questions', run.id, 'asker']);
  assert.ok(open.stdout.includes(`[${asked.id}] asker, attempt 1, asked the user at `), open.stdout);
  assert.ok(open.stdout.includes('\nThe user answers it from the message box on the dashboard.\n'), open.stdout);
  assert.equal('answeredAt' in questionsOf(run, 'asker')[0], false);

  const board = await f.dashboard();
  const reply = await sendAsUser(f, board, { run: run.id, task: 'asker', text: 'Approved.' });
  assert.equal(reply.status, 200, reply.text);
  const message = JSON.parse(reply.text);
  const [record] = questionsOf(run, 'asker');
  assert.deepEqual([record.answeredAt, record.answerMessage], [message.time, message.id]);
  const all = await f.json(['questions', run.id, '--all']);
  assert.deepEqual(all.questions.map((q) => [q.id, q.state, q.answerMessage, q.answeredVia]), [[asked.id, 'answered', message.id, 'dashboard']]);
  assert.ok((await f.command(['questions', run.id, '--all'])).stdout.includes(`by message ${message.id}, from the user on the dashboard.`));
  f.release(asker);
});

test('a question to the parent task is open until the parent answers it with send', async (t) => {
  const f = await fixture(t);
  // The parent reads its messages through the orch-inbox hook, so the question reaches it.
  fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: `node ${hook}` }] }] } }));
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const env = as(parent, 'lead');
  const child = await f.newRun('child', env);
  const kid = await f.start(child, 'kid', { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(kid);
  const asked = await f.json(['ask', 'Which region?', '--options', 'eu|us', '--recommend', 'eu'], { env: as(child, 'kid', 2) });
  assert.equal(asked.to, `agent:${parent.id}/lead`);
  const open = await f.command(['questions', child.id]);
  assert.ok(open.stdout.includes(`[${asked.id}] kid, attempt 1, asked its parent, agent ${parent.id}/lead at `), open.stdout);
  assert.ok(open.stdout.includes(`Options:\n  - eu\n  - us\nRecommended: eu\nAnswer it with: node ${cli} send ${child.id} kid "<answer>"`), open.stdout);

  const sent = await f.json(['send', child.id, 'kid', 'eu'], { env });
  const [record] = questionsOf(child, 'kid');
  assert.deepEqual([record.answeredAt, record.answerMessage], [sent.time, sent.id]);
  assert.equal((await f.json(['questions', child.id])).counts.open, 0);
  f.release(kid);
  f.release(lead);
});

test('a question recorded before answers were written loads, and stays open until a later typed message answers it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('legacy');
  f.launchingSession(run, 'legacses-0001');
  const asker = await f.start(run, 'asker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(asker);
  const dir = path.join(run.dir, 'tasks', 'asker');
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  // Lines as `ask` wrote them before this change: no answer fields, and no room for them.
  jsonl(path.join(dir, 'questions.jsonl'), [
    { id: 'old1', time: ago(120), attempt: 1, question: 'Which parser should stay?', options: ['old', 'new'], recommend: 'new', to: 'orchestrator', answerFrom: 'orchestrator' },
    { id: 'old2', time: ago(110), attempt: 1, question: 'Asked before answerFrom existed?', options: [], recommend: null, to: 'orchestrator' },
  ]);
  // A note from an agent the task started is no answer.
  jsonl(path.join(dir, 'inbox.jsonl'), [{ id: 'note1', time: ago(60), attempt: 1, text: 'Note from agent x/y: pushed.', from: 'agent:x/y', kind: 'note', logOffset: 0 }]);
  const before = fs.readFileSync(path.join(dir, 'questions.jsonl'), 'utf8');
  const open = await f.json(['questions', run.id]);
  assert.deepEqual(open.questions.map((q) => [q.id, q.state, q.options, q.recommend]), [['old1', 'open', ['old', 'new'], 'new'], ['old2', 'open', [], null]]);
  const woken = await f.json(['wait', run.id, '--timeout', '1m'], { code: 5 });
  assert.deepEqual(woken.questions.map((q) => [q.id, q.open]), [['old1', 2]]);

  const sent = await f.json(['send', run.id, 'asker', 'Keep the new one, and yes.']);
  assert.equal(fs.readFileSync(path.join(dir, 'questions.jsonl'), 'utf8'), before, 'a line with no room is left as it is');
  const all = await f.json(['questions', run.id, '--all']);
  assert.deepEqual(all.questions.map((q) => [q.id, q.state, q.answeredAt, q.answerMessage]), [['old1', 'answered', sent.time, sent.id], ['old2', 'answered', sent.time, sent.id]]);
  assert.equal((await f.json(['wait', run.id, '--timeout', '1ms'], { code: 3 })).questions, undefined);
  f.release(asker);
});
