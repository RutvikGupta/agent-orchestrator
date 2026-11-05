import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson } from './helpers.mjs';

// A final message that ends with an orch-result block listing these checks.
const report = (checks) => `Done.\n\n\`\`\`orch-result\n${JSON.stringify({ outcome: 'done', changed: [], checks, decisions: [], unresolved: [] })}\n\`\`\`\n`;

// Claude relay events: a Bash call, and its result.
const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const bash = (id, command, s, input = {}) => ({
  type: 'assistant', timestamp: at(s),
  message: { id: `message-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...input } }] },
});
const toolResult = (id, content, isError = false, extra = {}) => ({
  type: 'user', timestamp: at(59), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra,
});

const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
// Evidence is worked out by `result` (or `accept`), never by `status` or the dashboard.
const resultRow = async (f, run, id) => { await f.finished(run, id); await f.command(['result', run.id, id]); return rowOf(f, run, id); };

test('result matches each reported check against the commands in the log', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const head = await f.git(['rev-parse', 'HEAD']);
  const checks = [
    { cmd: 'npm test', result: 'pass', note: '12 pass' },
    { cmd: 'npm run lint', result: 'pass' },
    { cmd: 'npm run e2e', result: 'pass' },
    { cmd: 'npm run docs', result: 'pass' },
    { cmd: 'rm -rf build', result: 'not-run', note: 'denied' },
  ];
  await f.start(run, 'claims', { config: {
    finalMessage: report(checks),
    extraEvents: [
      // The last matching run counts: this one failed, the rerun below passed.
      bash('t1', 'npm   test', 1), toolResult('t1', 'Exit code 1\n1 failing', true),
      bash('t2', 'npm run lint', 2), toolResult('t2', 'Exit code 2\nlint errors', true),
      bash('t3', 'npm test', 3), toolResult('t3', '12 passing'),
      // A background command reports its exit code in its task notification.
      bash('t4', 'npm run e2e', 4, { run_in_background: true }),
      { type: 'system', subtype: 'task_notification', tool_use_id: 't4', status: 'failed', summary: 'Background command "e2e" failed with exit code 3' },
      toolResult('t4', 'Command running in background with ID: b1.', false, { tool_use_result: { backgroundTaskId: 'b1' } }),
      // A denied command never ran.
      bash('t5', 'rm -rf build', 5),
      { type: 'system', subtype: 'permission_denied', tool_use_id: 't5' },
      toolResult('t5', 'Permission to use Bash with command rm -rf build has been denied.', true),
    ],
  } });
  const row = await resultRow(f, run, 'claims');
  assert.deepEqual(row.report.checks.map((c) => c.evidence), [
    { ran: true, exitCode: 0, atMs: Date.parse(at(3)) },
    { ran: true, exitCode: 2, atMs: Date.parse(at(2)) },
    { ran: true, exitCode: 3, atMs: Date.parse(at(4)) },
    { ran: false },
    { ran: false },
  ]);
  assert.equal(row.report.commit, head);
  assert.equal(row.report.dirty, false);
  assert.ok(Number.isFinite(Date.parse(row.report.readAt)));

  // The checkout is recorded when the result is first read, and kept.
  fs.writeFileSync(path.join(f.repo, 'later.txt'), 'changed after the result was read\n');
  const text = (await f.command(['result', run.id, 'claims'])).stdout;
  assert.match(text, /check \[pass\]: npm test — 12 pass · ran, exit 0\n/);
  assert.match(text, /check \[pass\]: npm run lint · ran, exit 2\n/);
  assert.match(text, /check \[pass\]: npm run docs · NOT FOUND in the log\n/);
  assert.match(text, /check \[not-run\]: rm -rf build — denied · NOT FOUND in the log\n/);
  assert.match(text, new RegExp(`checkout when the result was read: ${head.slice(0, 12)}, clean`));
  assert.match(text, /WARNING: check "npm run lint" is reported pass, but its last run exited 2/);
  assert.match(text, /WARNING: check "npm run e2e" is reported pass, but its last run exited 3/);
  assert.match(text, /WARNING: check "npm run docs" is reported pass, but no matching run is in the log/);
  assert.doesNotMatch(text, /WARNING: check "(npm test|rm -rf build)"/);
  assert.deepEqual(readJson(path.join(row.outDir, 'evidence.json')).checks, row.report.checks.map((c) => c.evidence));
});

test('a Codex check matches its command without the shell wrapper', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'codex-claims', { agent: 'codex', config: {
    finalMessage: report([{ cmd: 'npm run build', result: 'pass' }, { cmd: 'npm test', result: 'fail' }]),
    extraEvents: [
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "/bin/zsh -lc 'npm  run   build'", status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: "/bin/zsh -lc 'npm  run   build'", exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", exit_code: 1, status: 'failed' } },
    ],
  } });
  const row = await resultRow(f, run, 'codex-claims');
  assert.deepEqual(row.report.checks.map((c) => c.evidence), [{ ran: true, exitCode: 0, atMs: null }, { ran: true, exitCode: 1, atMs: null }]);
  const text = (await f.command(['result', run.id, 'codex-claims'])).stdout;
  assert.match(text, /check \[pass\]: npm run build · ran, exit 0\n/);
  assert.match(text, /check \[fail\]: npm test · ran, exit 1\n/);
  assert.doesNotMatch(text, /WARNING/);
});

test('verify reruns a gate in the task directory and records it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'gated', { flags: ['--read-only'] });
  await f.finished(run, 'gated');
  const head = await f.git(['rev-parse', 'HEAD']);

  const passed = await f.command(['verify', run.id, 'gated', '--', 'echo hello from $(basename "$PWD")']);
  assert.match(passed.stdout, new RegExp(`^gated v1 passed in \\d+s at ${head.slice(0, 12)}: echo hello`));
  assert.equal(passed.stdout.trim().split('\n').length, 1);
  const failed = await f.command(['verify', run.id, 'gated', '--', 'sh', '-c', 'echo broken >&2; exit 3'], { code: 1 });
  assert.match(failed.stdout, /^gated v2 FAILED: exit 3 in \d+s/);
  const node = JSON.stringify(process.execPath);
  // --json goes before "--": everything after it is the command.
  const verify = async (args, opts) => JSON.parse((await f.command(['verify', run.id, 'gated', '--json', ...args], opts)).stdout);
  const long = await verify(['--', `${node} -e "process.stdout.write('x'.repeat(10000) + 'END')"`]);
  assert.equal(long.passed, true);
  const timedOut = await verify(['--timeout', '300ms', '--', 'sleep 20'], { code: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);

  const records = lines(path.join(run.dir, 'tasks', 'gated', 'verifications.jsonl'));
  assert.deepEqual(records.map((r) => [r.id, r.exitCode, r.by, r.commit, r.dirty, r.attempt]), [
    ['v1', 0, 'coordinator', head, false, 1], ['v2', 3, 'coordinator', head, false, 1],
    ['v3', 0, 'coordinator', head, false, 1], ['v4', null, 'coordinator', head, false, 1],
  ]);
  assert.equal(records[0].cmd, 'echo hello from $(basename "$PWD")');
  assert.equal(records[0].outputTail, `hello from ${path.basename(f.repo)}\n`);
  assert.equal(records[1].cmd, "sh -c 'echo broken >&2; exit 3'");
  assert.equal(records[1].outputTail, 'broken\n');
  assert.equal(Buffer.byteLength(records[2].outputTail), 4096);
  assert.ok(records[2].outputTail.endsWith('xxxEND'));
  for (const r of records) {
    assert.ok(Number.isFinite(Date.parse(r.startedAt)));
    assert.ok(Number.isInteger(r.durationMs) && r.durationMs >= 0);
  }
  // The described row carries the latest five, without their output.
  const row = await rowOf(f, run, 'gated');
  assert.deepEqual(row.verifications.map((v) => v.id), ['v1', 'v2', 'v3', 'v4']);
  assert.equal(row.verifications[0].outputTail, undefined);
  const text = (await f.command(['result', run.id, 'gated'])).stdout;
  assert.match(text, /Verifications \(coordinator reruns\):\n {2}v1 \(attempt 1\): pass, exit 0/);
  assert.match(text, /v2 \(attempt 1\): FAIL, exit 3 .* sh -c 'echo broken >&2; exit 3'/);
  assert.match(text, /v4 \(attempt 1\): FAIL, killed by SIGTERM \(timed out\)/);

  await f.command(['verify', run.id, 'gated'], { code: 2 });
});

test('verify refuses while the task is running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'busy', { config: { hold: true } });
  await f.ready(task);
  const refused = await f.command(['verify', run.id, 'busy', '--', 'true'], { code: 2 });
  assert.match(refused.stderr, /task busy is still running; verify it once it finishes/);
  assert.equal(fs.existsSync(path.join(run.dir, 'tasks', 'busy', 'verifications.jsonl')), false);
  const verdict = await f.command(['verdict', run.id, 'busy', 'clean'], { code: 1 });
  assert.match(verdict.stderr, /still running/);
  f.release(task);
  await f.finished(run, 'busy');
  await f.command(['verify', run.id, 'busy', '--', 'true']);
});

test('verdicts record review rounds, and each attempt records why it started', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'work');
  const first = await f.finished(run, 'work');
  assert.equal(readJson(f.taskFile(run, 'work')).attemptReason, 'first');
  assert.equal(first.attemptReason, 'first');

  await f.command(['verify', run.id, 'work', '--', 'true']);
  const changes = await f.command(['verdict', run.id, 'work', 'changes', '--note', 'handle the empty input']);
  assert.match(changes.stdout, /^work round 1 \(attempt 1\): changes by coordinator, 1 verification \(v1\) — handle the empty input/);
  assert.match(changes.stdout, /next: resume it with a delta brief/);
  assert.ok(!readJson(f.taskFile(run, 'work')).closedAt);

  // The attempt after a `changes` verdict is a rework.
  await f.start(run, 'work', { flags: ['--json', '--', '--session', first.session] });
  await f.finished(run, 'work');
  const saved = readJson(f.taskFile(run, 'work'));
  assert.equal(saved.attemptReason, 'rework');
  assert.deepEqual(saved.attemptReasons, { 1: 'first', 2: 'rework' });
  assert.match((await f.command(['status', run.id])).stdout, /completed \(2 attempts, 1 rework round\)/);

  await f.start(run, 'reviewer', { flags: ['--read-only'] });
  await f.finished(run, 'reviewer');
  await f.command(['verify', run.id, 'work', '--', 'true']);
  await f.json(['verdict', run.id, 'work', 'clean', '--reviewer', 'reviewer']);
  const rounds = lines(path.join(run.dir, 'tasks', 'work', 'reviews.jsonl'));
  assert.deepEqual(rounds.map(({ at: when, ...r }) => (assert.ok(Number.isFinite(Date.parse(when))), r)), [
    { round: 1, attempt: 1, verdict: 'changes', note: 'handle the empty input', reviewer: 'coordinator', verifications: ['v1'] },
    { round: 2, attempt: 2, verdict: 'clean', note: null, reviewer: 'reviewer', verifications: ['v2'] },
  ]);
  const row = await rowOf(f, run, 'work');
  assert.deepEqual(row.reviewRounds.map((r) => [r.round, r.verdict, r.reviewer]), [[1, 'changes', 'coordinator'], [2, 'clean', 'reviewer']]);
  assert.equal(row.attemptReason, 'rework');
  assert.equal(row.phase, 'awaiting-review');
  const text = (await f.command(['result', run.id, 'work'])).stdout;
  assert.match(text, /Review rounds:\n {2}round 1 \(attempt 1\): changes by coordinator, .* · verified by v1 — handle the empty input\n {2}round 2 \(attempt 2\): clean by reviewer/);

  // A follow-up attempt with no `changes` verdict is a resume.
  await f.start(run, 'work', { flags: ['--json', '--', '--session', first.session] });
  await f.finished(run, 'work');
  assert.equal(readJson(f.taskFile(run, 'work')).attemptReason, 'resume');

  await f.command(['verdict', run.id, 'work', 'maybe'], { code: 2 });
  await f.command(['verdict', run.id, 'work', 'clean', '--reviewer', 'nobody'], { code: 2 });
});

test('a reject verdict closes the task as rejected', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'bad');
  await f.finished(run, 'bad');
  const rejected = await f.command(['verdict', run.id, 'bad', 'reject', '--note', 'wrong approach']);
  assert.match(rejected.stdout, /round 1 \(attempt 1\): reject by coordinator — wrong approach\nbad: closed, as rejected/);
  const saved = readJson(f.taskFile(run, 'bad'));
  assert.ok(saved.closedAt);
  assert.equal(saved.rejectedAttempt, 1);
  assert.equal(saved.rejectNote, 'wrong approach');
  const row = await rowOf(f, run, 'bad');
  assert.deepEqual([row.state, row.phase, row.rejected, row.closed], ['completed', 'failed', true, true]);
  assert.match((await f.command(['recover', run.id])).stdout, /closed after failing \(1\): bad/);
});

test('the automatic retry is recorded as such, and its report counts the commands of the turn it continues', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // The retry brief quotes the error's first line, which carries the retried attempt's fixture.
  const retried = { finalMessage: report([{ cmd: 'npm test', result: 'pass' }]) };
  await f.start(run, 'flaky', { flags: ['--read-only'], config: {
    status: 'failed',
    error: `HTTP 503 provider unavailable <!-- fake-relay ${JSON.stringify(retried)} -->`,
    extraEvents: [bash('t1', 'npm test', 1), toolResult('t1', 'ok')],
  } });
  await f.finished(run, 'flaky');
  const waited = await f.command(['wait', run.id, '--timeout', '10s']);
  assert.match(waited.stdout, /retried flaky after a transient error/);
  const saved = readJson(f.taskFile(run, 'flaky'));
  assert.deepEqual([saved.attempt, saved.attemptReason, saved.attemptReasons], [2, 'retry', { 1: 'first', 2: 'retry' }]);
  const row = await resultRow(f, run, 'flaky');
  assert.equal(row.attemptReason, 'retry');
  assert.deepEqual(row.report.checks[0].evidence, { ran: true, exitCode: 0, atMs: Date.parse(at(1)) });
});

test('accept records its note and linked verifications, and says when no clean verdict is on file', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'good');
  await f.finished(run, 'good');
  await f.command(['verify', run.id, 'good', '--', 'true']);
  await f.command(['verdict', run.id, 'good', 'clean']);
  await f.command(['verify', run.id, 'good', '--', 'true']);
  const accepted = await f.json(['accept', run.id, 'good', '--note', 'gates rerun green']);
  assert.deepEqual(
    [accepted.acceptNote, accepted.acceptedBy, accepted.acceptVerifications, accepted.cleanVerdict],
    ['gates rerun green', 'coordinator', ['v2'], true],
  );
  const saved = readJson(f.taskFile(run, 'good'));
  assert.deepEqual([saved.acceptNote, saved.acceptedBy, saved.acceptVerifications], ['gates rerun green', 'coordinator', ['v2']]);
  assert.equal((await rowOf(f, run, 'good')).acceptNote, 'gates rerun green');
  assert.match((await f.command(['result', run.id, 'good'])).stdout, /accepted: gates rerun green/);

  await f.start(run, 'plain');
  await f.finished(run, 'plain');
  await f.command(['accept', run.id, 'plain', '--note', ' '], { code: 2 });
  const plain = await f.command(['accept', run.id, 'plain']);
  assert.match(plain.stdout, /^accepted plain at [0-9a-f]{12} \(attempt 1\)\nnote: no clean verdict is recorded for attempt 1 \(.* verdict .* plain clean records one\)\nnext: /);
  const record = readJson(f.taskFile(run, 'plain'));
  assert.deepEqual([record.acceptNote, record.acceptedBy, record.acceptVerifications], [null, 'coordinator', []]);

  // A `changes` round on the attempt is not a clean verdict either.
  await f.start(run, 'redo');
  await f.finished(run, 'redo');
  await f.command(['verdict', run.id, 'redo', 'changes']);
  assert.equal((await f.json(['accept', run.id, 'redo'])).cleanVerdict, false);
});

test('a check matches across whitespace outside quotes only', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'quoted', { config: {
    finalMessage: report([{ cmd: "test 'a  b' = 'a b'", result: 'pass' }, { cmd: "test   'a b'  =  'a b'", result: 'pass' }]),
    extraEvents: [bash('t1', "test 'a b' = 'a b'", 1), toolResult('t1', '')],
  } });
  const row = await resultRow(f, run, 'quoted');
  assert.deepEqual(row.report.checks.map((c) => c.evidence.ran), [false, true]);
});

test('a leading cd matches the bare command only when it enters the task directory', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const link = path.join(f.root, 'repo-link');
  fs.symlinkSync(f.repo, link);
  const logged = [
    ['a', `cd ${f.repo} && npm run a`], ['b', 'cd . && npm run b'], ['c', `cd ${f.repo}/sub/.. && npm run c`],
    ['d', `cd "${f.repo}" && npm run d`], ['e', `cd ${link} && npm run e`],
    ['f', 'cd sub && npm run f'], ['g', `cd ${f.root} && npm run g`], ['h', 'cd ~ && npm run h'],
  ];
  await f.start(run, 'dirs', { config: {
    finalMessage: report(logged.map(([name]) => ({ cmd: `npm run ${name}`, result: 'not-run' }))),
    extraEvents: logged.flatMap(([name, cmd], i) => [bash(`t${name}`, cmd, i + 1), toolResult(`t${name}`, '')]),
  } });
  const row = await resultRow(f, run, 'dirs');
  assert.deepEqual(
    Object.fromEntries(row.report.checks.map((c) => [c.cmd, c.evidence.ran])),
    { 'npm run a': true, 'npm run b': true, 'npm run c': true, 'npm run d': true, 'npm run e': true, 'npm run f': false, 'npm run g': false, 'npm run h': false },
  );
});

test('the rework hint keeps the task\'s read-only mode and Codex tier', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'reader', { flags: ['--read-only'] });
  await f.start(run, 'coder', { agent: 'codex', flags: ['--read-only'] });
  await f.finished(run, 'reader');
  await f.finished(run, 'coder');
  const reader = (await f.command(['verdict', run.id, 'reader', 'changes'])).stdout;
  assert.match(reader, /start \S+ reader --agent claude --read-only --brief <delta> -- --session fixture-claude$/m);
  const coder = (await f.command(['verdict', run.id, 'coder', 'changes'])).stdout;
  assert.match(coder, /start \S+ coder --agent codex --tier standard --read-only --brief <delta> -- --session fixture-codex$/m);
  await f.start(run, 'writer', { agent: 'codex' });
  await f.finished(run, 'writer');
  const writer = (await f.command(['verdict', run.id, 'writer', 'changes'])).stdout;
  assert.match(writer, /start \S+ writer --agent codex --tier standard --brief <delta> -- --session fixture-codex$/m);
});

test('a verify timeout kills what the command started, even after the shell exits', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'slow', { flags: ['--read-only'] });
  await f.finished(run, 'slow');
  const pidFile = path.join(f.root, 'straggler.pid');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => {
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  });
  // The shell dies of the SIGTERM; the background command ignores it and holds no output pipe.
  const command = `sh -c "trap '' TERM; exec sleep 30" > /dev/null 2>&1 & echo $! > '${pidFile}'; wait`;
  const out = JSON.parse((await f.command(['verify', run.id, 'slow', '--json', '--timeout', '300ms', '--', command], { code: 1 })).stdout);
  assert.deepEqual([out.timedOut, out.passed], [true, false]);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await eventually(() => !alive(pid), 'the background command survived the timeout', 3000);
});

test('a verify command that exits 0 after its timeout still fails', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'trapped', { flags: ['--read-only'] });
  await f.finished(run, 'trapped');
  const out = await f.command(['verify', run.id, 'trapped', '--timeout', '300ms', '--', "trap 'exit 0' TERM; sleep 30 & wait"], { code: 1 });
  assert.match(out.stdout, /^trapped v1 FAILED: timed out after 0s/);
  const [record] = lines(path.join(run.dir, 'tasks', 'trapped', 'verifications.jsonl'));
  assert.deepEqual([record.exitCode, record.timedOut, record.passed], [0, true, false]);
  assert.match((await f.command(['result', run.id, 'trapped'])).stdout, /v1 \(attempt 1\): FAIL, exit 0 \(timed out\)/);
});

test('verify refuses with exit 2 when the task directory is gone', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const dir = path.join(f.root, 'scratch');
  fs.mkdirSync(dir);
  await f.start(run, 'gone', { flags: ['--read-only', '--cd', dir] });
  await f.finished(run, 'gone');
  fs.rmSync(dir, { recursive: true });
  const refused = await f.command(['verify', run.id, 'gone', '--', 'true'], { code: 2 });
  assert.match(refused.stderr, /task gone's working directory is gone/);
});
