import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decisionNote } from '../scripts/lib/briefs.mjs';
import { reportFields, reportHints } from '../scripts/lib/report.mjs';
import { fixture, jsonl, readJson, writeJson } from './helpers.mjs';

const block = (value) => `\`\`\`orch-result\n${JSON.stringify(value)}\n\`\`\``;
const row = (finalMessage, extra = {}) => ({ state: 'completed', result: { finalMessage }, ...extra });
const fields = (message, task = {}, extra = {}) => reportFields({ repo: '/repo' }, task, row(message, extra));

test('report parsing selects the last block, accepts EOF/whitespace/CRLF, and normalizes absent fields', () => {
  const report = { outcome: 'partial', changed: ['src/a.js'], checks: [{ cmd: 'test', result: 'fail', note: '1 failed' }], decisions: [], unresolved: ['Fix it'] };
  assert.deepEqual(fields(`Prose\n${block({ outcome: 'done' })}\nMore prose\n${block(report)}`).report, report);
  assert.deepEqual(fields(`  \n  ${block(report).replaceAll('\n', '\r\n')}  \r\n  `).report, report);
  assert.deepEqual(fields(block({ outcome: 'other', changed: null, checks: {}, decisions: false })).report,
    { outcome: null, changed: [], checks: [], decisions: [], unresolved: [] });
  for (const outcome of ['done', 'partial', 'blocked']) assert.equal(fields(block({ outcome })).report.outcome, outcome);
});

test('missing, unfinished and malformed reports do not crash or fall back to an older report', () => {
  for (const message of [undefined, '', 'All done.', '```json\n{}\n```', '```orch-result\n{}']) assert.equal(fields(message).report, null);
  for (const message of ['```orch-result\n{nope}\n```', block(null), block([]), block(12)]) {
    const report = fields(`${block({ outcome: 'done' })}\n${message}`).report;
    assert.equal(report.invalid, true);
    assert.equal(typeof report.error, 'string');
    assert.ok(report.error.length);
  }
});

test('scope checks union reported/status paths, normalize boundaries, deduplicate, and ignore tool caches', () => {
  const task = { cd: '/repo', plan: { owns: ['src/', 'tests/ok.test.js'] } };
  const message = block({ changed: ['src/a.js', './src/deep/b.js', 'src/../outside.js', 'src-other/no.js', 'tests/ok.test.js', '/repo/src/absolute.js', 'nested/node_modules/pkg/a', 'src/__pycache__/x', 'outside.js'] });
  const touchedFiles = [' M src/allowed.js', '?? outside.js', 'A  extra.js', '?? .pytest_cache/v/cache', '?? nested/.mypy_cache/a', '?? .ruff_cache/x', '?? .DS_Store'];
  const result = fields(message, task, { result: { finalMessage: message, touchedFiles } });
  assert.deepEqual(result.scopeViolations, ['outside.js', 'src-other/no.js', 'extra.js']);
  assert.deepEqual(fields(message).scopeViolations, []);
  assert.deepEqual(fields(message, { plan: {} }).scopeViolations, []);
  assert.deepEqual(fields(block({ changed: ['src/a.js'] }), { plan: { owns: [] } }).scopeViolations, ['src/a.js']);
  assert.deepEqual(fields(block({ changed: ['src/a.js', '../outside.js'] }), { plan: { owns: ['.'] } }).scopeViolations, ['../outside.js']);
});

test('scope checks both rename paths and decode quoted git paths, including escaped UTF-8', () => {
  const task = { plan: { owns: ['src/'] } };
  const touchedFiles = ['R  old.js -> src/new.js', 'R  src/old.js -> new.js', 'R  "old -> name.js" -> "src/new name.js"', '?? "space name.js"', '?? "caf\\303\\251.js"', '?? "src/tab\\tname.js"'];
  assert.deepEqual(fields('', task, { result: { touchedFiles } }).scopeViolations, ['old.js', 'new.js', 'old -> name.js', 'space name.js', 'café.js']);
  const malformed = block({ changed: [null, 42, {}, 'outside.js'] });
  assert.deepEqual(fields(malformed, task, { result: { finalMessage: malformed, touchedFiles: 'not an array' } }).scopeViolations, ['outside.js']);
  assert.deepEqual(fields('```orch-result\ninvalid\n```', task, { result: { finalMessage: '```orch-result\ninvalid\n```', touchedFiles: [' M other.js'] } }).scopeViolations, ['other.js']);
});

test('structured decisions set needs-decision and preserve open/closed semantics only after success', () => {
  const message = block({ outcome: 'blocked', decisions: [{ question: 'Increase scope?', options: ['yes', 'no'], recommendation: 'no' }] });
  const result = fields(message);
  assert.equal(result.state, 'needs-decision');
  assert.equal(result.phase, 'needs-decision');
  assert.equal(result.awaitingReviewMs, null);
  assert.equal(result.closed, false);
  assert.deepEqual(result.decisions, ['Increase scope? Recommendation: no']);
  assert.equal(fields(message, { closedAt: '2026-01-01' }).closed, true);
  for (const state of ['running', 'failed', 'prepared']) assert.equal(fields(message, {}, { state }).state, undefined);
  assert.equal(fields(block({ decisions: [] })).state, undefined);
  assert.equal(fields(message, {}, { state: 'needs-decision' }).state, 'needs-decision');
});

test('health distinguishes prepared, dead, running and quiet threshold; only babysitter pr-watch is exempt', () => {
  assert.equal(fields('', {}, { state: 'prepared', result: null }).health, 'ok');
  assert.equal(fields('', { pid: 123 }, { state: 'aborted', result: null }).health, 'dead');
  assert.equal(fields('', { pid: 123 }, { state: 'failed', result: { error: 'ordinary error' } }).health, 'ok');
  for (const quietMs of [null, 0, 15 * 60000]) assert.equal(fields('', { pid: 123 }, { state: 'running', quietMs, result: null }).health, 'ok');
  const quiet = { state: 'running', quietMs: 15 * 60000 + 1, now: '$ node scripts/orch.mjs pr-watch 123' };
  assert.equal(fields('', { pid: 123 }, quiet).health, 'silent');
  assert.equal(fields('', { pid: 123, babysit: true }, quiet).health, 'ok');
  assert.equal(fields('', { pid: 123, plan: { type: 'babysit' } }, quiet).health, 'ok');
  assert.equal(fields('', { babysit: true }, { ...quiet, now: 'says: orch.mjs pr-watch is useful' }).health, 'silent');
  assert.equal(fields('', { babysit: true }, { ...quiet, now: '$ node scripts/orch.mjs status run' }).health, 'silent');
  assert.equal(fields('', { babysit: true }, { ...quiet, now: '$ node scripts/orch.mjs pr-watch-other' }).health, 'silent');
});

test('transient health recognizes provider/network failures but refuses ordinary failures, success, and usage limits', () => {
  for (const error of ['Provider overloaded', 'overloaded_error', 'HTTP 500', 'HTTP 502', '529', '503', 'provider 5xx', 'ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'stream disconnected', 'Internal server error']) {
    assert.equal(fields('', {}, { state: 'failed', result: { error } }).health, 'transient-error', error);
    assert.equal(fields('', {}, { state: 'failed', limitHit: true, result: { error } }).health, 'ok', error);
    assert.equal(fields('', {}, { state: 'completed', result: { finalMessage: error } }).health, 'ok', error);
  }
  for (const error of ['Compiler error', '401 Unauthorized', '403 Forbidden', '429 Too many requests', 'overloaded function signature', '15030 lines', '512 tests passed, 3 failed', 'exit code 1 after 503 steps']) assert.equal(fields('', {}, { state: 'failed', result: { error } }).health, 'ok', error);
  for (const result of [{ stderrTail: 'ECONNRESET' }, { finalMessage: 'API Error: 503 Internal server error' }, { error: { type: 'overloaded_error' } }]) assert.equal(fields('', {}, { state: 'failed', result }).health, 'transient-error');
});

test('hints give one line per problem with log/resume commands, silence duration, and scope files', () => {
  const tasks = [
    { id: 'dead', health: 'dead' }, { id: 'quiet', health: 'silent', quietMs: 16 * 60000 },
    { id: 'retry', health: 'transient-error', agent: 'codex', tier: 'complex', session: 'session-1' },
    { id: 'bad', health: 'ok', scopeViolations: ['one.js', 'two.js'], report: { invalid: true, error: 'Invalid JSON' } },
  ];
  const lines = reportHints({ id: 'run-1' }, tasks);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /log run-1 dead/);
  assert.match(lines[1], /quiet for 16m00s/);
  assert.match(lines[2], /start run-1 retry --agent codex --tier complex --brief <delta> -- --session session-1/);
  assert.match(lines[3], /scope violations: one.js, two.js/);
  assert.match(lines[4], /invalid orch-result report: Invalid JSON/);
  assert.deepEqual(reportHints({ id: 'run' }, [{ health: 'ok', report: null, scopeViolations: [] }]), []);
  assert.match(reportHints({ id: 'run' }, [{ id: 'task', agent: 'claude', health: 'transient-error' }])[0], /--agent claude --brief <delta> -- --session <id>/);
});

test('brief note retains decisions behavior and documents every structured field for normal/babysit tasks', () => {
  for (const babysit of [false, true]) {
    const note = decisionNote(babysit);
    assert.match(note, /## Decisions/);
    assert.match(note, /never stop to wait for an answer/);
    assert.match(note, /first line is `NEEDS DECISION:`/);
    assert.match(note, /End your final message/);
    const example = fields(note).report;
    assert.equal(example.outcome, 'done');
    for (const key of ['outcome', 'changed', 'checks', 'decisions', 'unresolved']) assert.ok(note.includes(`- \`${key}\``));
    assert.match(note, /"question".*"options".*"recommendation"/);
    if (babysit) assert.match(note, /stop watching/);
  }
});

test('CLI exposes reports/scope in JSON and text, appends the brief, and preserves result closing', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('reports');
  const report = { outcome: 'partial', changed: ['README.md', 'other.js'], checks: [{ cmd: 'test one', result: 'pass', note: '3 passed' }, { cmd: 'test two', result: 'fail', note: '1 failed' }, { cmd: 'test three', result: 'not-run', note: 'requires login' }], unresolved: ['Finish the remaining gate'], decisions: [] };
  const finalMessage = `Human-readable final message.\n${block(report)}`;
  const started = await f.start(run, 'report', { config: { finalMessage, touchedFiles: [' M extra.js'] } });
  await f.finished(run, 'report');
  const taskFile = f.taskFile(run, 'report');
  writeJson(taskFile, { ...readJson(taskFile), plan: { owns: ['README.md'] } });
  assert.match(fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8'), /```orch-result/);
  const result = await f.json(['result', run.id, 'report']);
  // The receipts that result adds (verify.test.mjs covers them) aside, the report is as written.
  const { commit, dirty, readAt, ...parsed } = result.report;
  assert.deepEqual({ ...parsed, checks: parsed.checks.map(({ evidence, ...check }) => check) }, report);
  assert.deepEqual(result.scopeViolations, ['other.js', 'extra.js']);
  assert.equal(result.health, 'ok');
  assert.ok(readJson(taskFile).closedAt);
  const text = (await f.command(['result', run.id, 'report'])).stdout;
  assert.ok(text.indexOf('Structured report:') > text.indexOf(finalMessage));
  assert.match(text, /outcome: partial/);
  assert.match(text, /check \[pass\]: test one — 3 passed/);
  assert.match(text, /check \[fail\]: test two — 1 failed/);
  assert.match(text, /check \[not-run\]: test three — requires login/);
  assert.match(text, /unresolved: Finish the remaining gate/);
  assert.match(text, /scope violations:\n    other.js\n    extra.js/);
  assert.match((await f.command(['wait', run.id, '--timeout', '1s'])).stdout, /report: scope violations: other.js, extra.js/);
});

test('CLI keeps structured decisions open and wait presents the question, with or without prose signal', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('decisions');
  for (const [id, prefix] of [['structured', ''], ['both', 'NEEDS DECISION:\nChoose? Recommendation: A.\n\n']]) {
    await f.start(run, id, { config: { finalMessage: `${prefix}${block({ outcome: 'blocked', decisions: [{ question: 'Choose?', options: ['A', 'B'], recommendation: 'A' }] })}` } });
    const result = await f.finished(run, id);
    assert.equal(result.state, 'needs-decision');
    assert.equal(result.closed, false);
    assert.deepEqual(result.decisions, ['Choose? Recommendation: A']);
    const text = (await f.command(['result', run.id, id])).stdout;
    assert.match(text, /NEEDS DECISION:/);
    assert.match(text, /Choose\? Recommendation: A/);
    assert.equal(readJson(f.taskFile(run, id)).closedAt, null);
    assert.match((await f.command(['wait', run.id, id, '--timeout', '1s'])).stdout, new RegExp(`${id} handed back a decision`));
    await f.command(['close', run.id, id]);
    assert.equal((await f.json(['result', run.id, id])).closed, true);
  }
});

test('CLI handles missing and invalid reports and suggests resuming only transient failures', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('report-errors');
  for (const [id, config, expected] of [
    ['missing', {}, /no orch-result block/],
    ['invalid', { finalMessage: '```orch-result\n{broken}\n```' }, /invalid orch-result block:/],
    ['transient', { status: 'failed', error: '503 provider overloaded' }, /no orch-result block/],
    ['limited', { status: 'failed', error: 'Usage limit reached; 503' }, /USAGE LIMIT:/],
  ]) {
    await f.start(run, id, { agent: 'codex', config });
    const row = await f.finished(run, id);
    assert.equal(row.health, id === 'transient' ? 'transient-error' : 'ok');
    assert.match((await f.command(['result', run.id, id])).stdout, expected);
    const waited = (await f.command(['wait', run.id, id, '--timeout', '1s'])).stdout;
    if (id === 'invalid') assert.match(waited, /invalid orch-result report:/);
    if (id === 'transient') assert.match(waited, /--agent codex --tier standard --brief <delta> -- --session fixture-codex/);
    else assert.doesNotMatch(waited, /transient error; resume/);
  }
});

test('CLI detects a dead relay without result.json, while an existing unreadable result is not absence', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('dead');
  const started = await f.start(run, 'dead');
  await f.finished(run, 'dead');
  fs.unlinkSync(path.join(started.outDir, 'result.json'));
  const result = await f.json(['result', run.id, 'dead']);
  assert.equal(result.state, 'aborted');
  assert.equal(result.health, 'dead');
  assert.match((await f.command(['wait', run.id, '--timeout', '1s'])).stdout, new RegExp(`log ${run.id} dead`));
  fs.writeFileSync(path.join(started.outDir, 'result.json'), '{broken');
  assert.notEqual((await f.json(['result', run.id, 'dead'])).health, 'dead');
});

test('CLI quiet-time health recognizes long pr-watch paths and rejects stale/completed waits', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('quiet');
  const started = await f.start(run, 'watcher', { flags: ['--read-only'], config: { delayMs: 30000 } });
  await f.ready(started);
  const taskFile = f.taskFile(run, 'watcher');
  writeJson(taskFile, { ...readJson(taskFile), babysit: true });
  const command = `node /a/${'long-directory/'.repeat(8)}scripts/orch.mjs pr-watch 123`;
  const watch = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'watch', name: 'Bash', input: { command } }] } };
  async function health(events) {
    const file = jsonl(path.join(started.outDir, 'events.jsonl'), events);
    const old = new Date(Date.now() - 16 * 60000);
    fs.utimesSync(file, old, old);
    return (await f.json(['status', run.id])).tasks[0].health;
  }
  assert.equal(await health([watch]), 'ok');
  assert.equal(await health([watch, { type: 'assistant', message: { content: [{ type: 'text', text: 'Now editing the fix.' }] } }]), 'silent');
  assert.equal(await health([watch, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'watch', content: 'Done' }] } }]), 'silent');
  writeJson(taskFile, { ...readJson(taskFile), babysit: false });
  assert.equal(await health([watch]), 'silent');
  assert.match((await f.command(['wait', run.id, '--timeout', '1ms'], { code: 3 })).stdout, /watcher: silent; quiet for 16m/);
  await f.command(['close', run.id, 'watcher']);

  // Exercise the Codex activity shape too, without needing a live GitHub babysitter.
  const task = { outDir: started.outDir, babysit: true };
  const quiet = { state: 'running', quietMs: 16 * 60000 };
  jsonl(path.join(started.outDir, 'events.jsonl'), [{ type: 'item.started', item: { type: 'command_execution', command } }]);
  assert.equal(fields('', task, quiet).health, 'ok');
  jsonl(path.join(started.outDir, 'events.jsonl'), [{ type: 'item.completed', item: { type: 'command_execution', command } }]);
  assert.equal(fields('', task, quiet).health, 'silent');
});

test('health reads a transient error from the current event stream when result omits it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('event-error');
  const started = await f.start(run, 'error', { agent: 'codex', config: { status: 'failed', finalMessage: 'Could not finish.', error: 'stream disconnected' } });
  await f.finished(run, 'error');
  const file = path.join(started.outDir, 'result.json');
  writeJson(file, { ...readJson(file), error: null });
  assert.equal((await f.json(['result', run.id, 'error'])).health, 'transient-error');
});

const ordinaryReports = [
  'The /api/claims endpoint still returns HTTP 500 for an empty batch; I ran out of time before fixing the serializer.',
  'Added retries for 5xx responses in the payments client; two tests still fail.',
  'The integration tests fail with ETIMEDOUT connecting to the local Postgres container.',
  'Reproduced: the staging page shows Internal Server Error after login.',
  'Found it: the webhook handler returns status 503 when the queue is full.',
];

for (const [index, finalMessage] of ordinaryReports.entries()) {
  test(`regression: ordinary failure report ${index + 1} never triggers an automatic retry`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'ordinary', { config: { status: 'failed', error: 'claude returned an error result (error_max_turns)', finalMessage } });
    assert.equal((await f.finished(run, 'ordinary')).health, 'ok');
    const waited = await f.command(['wait', run.id, '--timeout', '10s']);
    assert.doesNotMatch(waited.stdout, /retried|transient error; resume/);
    const task = readJson(f.taskFile(run, 'ordinary'));
    assert.equal(task.attempt, 1);
    assert.equal(task.retries, undefined);
  });
}

for (const state of ['stopped', 'timeout', 'aborted-signal', 'aborted-message']) {
  test(`regression: ${state} is not retried even with a provider error`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const stopped = state === 'stopped' || state === 'aborted-signal';
    const started = await f.start(run, 'task', { config: {
      status: state.startsWith('aborted') ? 'aborted' : state,
      delayMs: stopped ? 30000 : 0,
      error: state === 'aborted-message' ? 'the relay was killed by SIGTERM; claude was terminated with it' : 'HTTP 503 Service Unavailable',
      finalMessage: 'API Error: 503 Service Unavailable',
    } });
    if (stopped) { await f.ready(started); await f.command(['stop', run.id, 'task']); }
    await f.finished(run, 'task');
    if (state.startsWith('aborted')) {
      const file = path.join(started.outDir, 'result.json');
      writeJson(file, { ...readJson(file), status: 'aborted', stderrTail: 'ECONNRESET' });
    }
    const result = (await f.json(['status', run.id])).tasks[0];
    assert.equal(result.health, 'ok');
    const waited = await f.command(['wait', run.id, '--timeout', '10s']);
    assert.doesNotMatch(waited.stdout, /retried|transient error; resume/);
    assert.equal(readJson(f.taskFile(run, 'task')).attempt, 1);
  });
}

test('provider-format final messages remain transient while prose mentioning provider codes does not', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [index, finalMessage] of ['API Error: 529 overloaded', 'API Error: 5xx', 'overloaded_error: retry later', '{"error":{"type":"api_error","message":"unavailable"}}', 'I added handling for api_error and overloaded_error in the client.'].entries()) {
    const id = `provider-${index}`;
    await f.start(run, id, { config: { status: 'failed', error: 'claude returned an error result', finalMessage } });
    assert.equal((await f.finished(run, id)).health, index < 4 ? 'transient-error' : 'ok', finalMessage);
  }
});

test('regression: the read-only resume hint preserves read-only mode when executed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'review', { agent: 'codex', flags: ['--read-only'], config: { status: 'failed', error: '503 Service Unavailable' } });
  const before = await f.finished(run, 'review');
  const waited = await f.command(['wait', run.id, '--timeout', '1s'], { env: { AGENT_ORCH_MAX_RETRIES: '0' } });
  const hint = waited.stdout.split('\n').find((line) => line.includes('transient error; resume with:'));
  assert.ok(hint);
  assert.match(hint, / --read-only(?: |$)/);
  const args = hint.slice(hint.indexOf(' start ') + 1).replace('<delta>', f.brief('delta')).split(' ');
  await f.command(args);
  const after = await f.finished(run, 'review');
  assert.equal(after.attempt, 2);
  assert.equal(after.mode, 'read-only');
  assert.equal(after.session, before.session);
  assert.ok(readJson(path.join(after.outDir, 'invocation.json')).argv.includes('--read-only'));
});

for (const agent of ['claude', 'codex']) {
  test(`automatic retry preserves ${agent} read-only mode in the relay invocation`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'review', { agent, flags: ['--read-only'], config: { status: 'failed', error: 'HTTP 503 Service Unavailable' } });
    const before = await f.finished(run, 'review');
    const waited = await f.command(['wait', run.id, '--timeout', '10s', '--json']);
    assert.match(waited.stderr, /retried review after a transient error/);
    const after = JSON.parse(waited.stdout).tasks[0];
    assert.equal(after.attempt, 2);
    assert.equal(after.mode, 'read-only');
    assert.equal(after.session, before.session);
    assert.equal(readJson(f.taskFile(run, 'review')).readOnly, true);
    assert.ok(readJson(path.join(after.outDir, 'invocation.json')).argv.includes('--read-only'));
  });
}

test('regression: collapsed untracked directories check their files against individual owned paths', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const owned = ['references/briefs/implement.md', 'references/briefs/review.md'];
  fs.mkdirSync(path.join(f.repo, 'references/briefs'), { recursive: true });
  for (const file of owned) fs.writeFileSync(path.join(f.repo, file), 'New brief.');
  const touchedFiles = (await f.git(['status', '--porcelain'])).split('\n');
  assert.deepEqual(touchedFiles, ['?? references/']);
  const started = await f.start(run, 'briefs', { config: { finalMessage: block({ outcome: 'done', changed: owned }), touchedFiles } });
  await f.finished(run, 'briefs');
  const taskFile = f.taskFile(run, 'briefs');
  writeJson(taskFile, { ...readJson(taskFile), plan: { owns: owned } });
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].scopeViolations, []);
  // Exercise the reviewer's exact collapsed directory too, with mixed allowed/unowned files.
  const resultFile = path.join(started.outDir, 'result.json');
  writeJson(resultFile, { ...readJson(resultFile), touchedFiles: ['?? references/briefs/'] });
  const unexpected = 'references/briefs/unowned\nname.md';
  fs.writeFileSync(path.join(f.repo, unexpected), 'Not in scope.');
  fs.writeFileSync(path.join(f.repo, 'references/briefs/ignored.md'), 'Ignored.');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\nreferences/briefs/ignored.md\n');
  fs.mkdirSync(path.join(f.repo, 'references/briefs/__pycache__'));
  fs.writeFileSync(path.join(f.repo, 'references/briefs/__pycache__/cache.pyc'), 'Cache.');
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].scopeViolations, [unexpected]);
});

test('regression: without a checkout a collapsed folder containing owned paths is not a violation', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const owned = ['references/briefs/implement.md', 'references/briefs/review.md'];
  await f.start(run, 'briefs', { config: { finalMessage: block({ outcome: 'done', changed: owned }), touchedFiles: ['?? references/briefs/', '?? references/unowned/', '?? references/briefs-extra/'] } });
  await f.finished(run, 'briefs');
  const taskFile = f.taskFile(run, 'briefs');
  writeJson(taskFile, { ...readJson(taskFile), cd: path.join(f.root, 'missing-checkout'), plan: { owns: owned } });
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].scopeViolations, ['references/unowned', 'references/briefs-extra']);
  // A directory can remain after its checkout metadata has been removed.
  fs.mkdirSync(path.join(f.root, 'missing-checkout'));
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].scopeViolations, ['references/unowned', 'references/briefs-extra']);
});

test('report length counts prose before orch-result and hints only above sixty lines', () => {
  assert.equal(fields('').reportLines, 0);
  assert.equal(fields('One line.\n').reportLines, 1);
  assert.equal(fields(`One line.\n\n${block({ outcome: 'done' })}`).reportLines, 2);
  const message = Array.from({ length: 61 }, (_, i) => `Line ${i}`).join('\r\n');
  assert.equal(fields(`${message}\r\n${block({ outcome: 'done' })}`).reportLines, 61);
  assert.equal(fields(message).reportLines, 61);
  assert.equal(fields(`${message}\n  \`\`\`orch-result\nnot json\n\`\`\``).reportLines, 61);
  assert.deepEqual(reportHints({ id: 'run' }, [{ id: 'long', reportLines: 61 }, { id: 'short', reportLines: 60 }]), ['long: long report (61 lines)']);
  assert.match(decisionNote(false), /## Keep the final message short/);
  assert.match(decisionNote(false), /25 lines before the `orch-result` block/);
});
