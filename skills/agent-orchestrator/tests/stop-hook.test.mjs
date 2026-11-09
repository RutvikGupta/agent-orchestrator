import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, jsonl, readJson, writeJson } from './helpers.mjs';

// The Stop hook (scripts/hooks/orch-stop.mjs) runs as Claude Code runs it: a child process that gets
// the Stop event on stdin. Each test seeds the launching session's id in run.json, as the CLI would.

const hook = fileURLToPath(new URL('../scripts/hooks/orch-stop.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const SESSION = '0b6c2a4e-1f3d-4c6a-9d2e-5a7b8c9d0e1f';
const input = (extra = {}) => ({ session_id: SESSION, stop_hook_active: false, transcript_path: '/dev/null', cwd: '/', ...extra });
// The session's own shell: its runs' results, closes and acceptances are the owner's (ownership.mjs).
const OWNER = { CLAUDE_CODE_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION };

// Run the hook once. `env` is added to the fixture's environment, which has no AGENT_ORCH_TASK.
function runHook(f, stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      assert.equal(code, 0, `the hook must always exit 0 (signal ${signal}): ${stderr}`);
      assert.equal(stderr, '');
      resolve(stdout);
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

// The reason the hook blocked with, or null when it let the stop through (no output at all).
async function blocked(f, stdin = input(), env = {}) {
  const out = await runHook(f, stdin, env);
  if (out === '') return null;
  const decision = JSON.parse(out);
  assert.deepEqual(Object.keys(decision).sort(), ['decision', 'reason']);
  assert.equal(decision.decision, 'block');
  return decision.reason;
}

const commandOf = (pid) => spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
const recordFile = (f) => path.join(f.state, 'stop-hook', `${SESSION}.json`);

// A run that this session launched, with a task that finished and that nobody has read.
async function finishedRun(f, id = 'work', config = {}) {
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  await f.start(run, id, { config });
  await f.finished(run, id);
  return run;
}

// Start `orch.mjs wait`, as the main session runs it in the background, and stop that exact child.
async function withWait(f, args, body) {
  const child = spawn(process.execPath, [cli, 'wait', ...args], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    await body(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}

test('blocks for an unread result, names the task and its command, and lets the stop through once it is read', async (t) => {
  const f = await fixture(t);
  const run = await finishedRun(f);
  const reason = await blocked(f);
  assert.ok(reason, 'a finished, unread task blocks the stop');
  assert.ok(reason.includes(`${run.id}/work`), reason);
  assert.ok(reason.includes(`node ${cli} result ${run.id} work`), reason);
  assert.ok(reason.includes(`node ${cli} close ${run.id} work`), reason);
  assert.match(reason, /before ending the turn/i);
  assert.doesNotMatch(reason, /Nothing will wake/, 'a finished task needs no wait');
  assert.ok(fs.existsSync(recordFile(f)), 'the block is recorded, so it is not repeated');

  await f.command(['result', run.id, 'work'], { env: OWNER });
  assert.equal(await blocked(f), null);
  assert.ok(!fs.existsSync(recordFile(f)), 'an empty set clears the record');
});

test('blocks when a task runs and no wait is live, and answers an open question to the session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const task = await f.start(run, 'work', { config: { hold: true } });
  await f.ready(task);
  const dir = path.join(run.dir, 'tasks', 'work');
  const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
  jsonl(path.join(dir, 'questions.jsonl'), [
    { id: 'q1', time: at(0), attempt: 1, question: 'Which parser should stay?', options: ['old', 'new'], recommend: 'new', to: 'orchestrator', answerFrom: 'orchestrator' },
    { id: 'q2', time: at(1), attempt: 1, question: 'Is the budget fine?', options: [], recommend: null, to: 'user', answerFrom: 'user' },
  ]);
  const reason = await blocked(f);
  assert.ok(reason, 'a running task with no wait blocks the stop');
  assert.ok(reason.includes('Which parser should stay?'), reason);
  assert.ok(reason.includes(`node ${cli} send ${run.id} work "<answer>"`), reason);
  assert.ok(!reason.includes('Is the budget fine?'), 'a question for the user is not for this session');
  assert.match(reason, /Nothing will wake this session/);
  assert.ok(reason.includes(`node ${cli} wait ${run.id} --timeout 0`), reason);
  assert.match(reason, /run_in_background/);

  // A message the orchestrator sent after the question answers it; the missing wait is still reported.
  jsonl(path.join(dir, 'inbox.jsonl'), [{ id: 'm1', time: at(5), attempt: 1, text: 'Keep the new one.', logOffset: 0 }]);
  const after = await blocked(f);
  assert.ok(after, 'the set changed, so it blocks once more');
  assert.ok(!after.includes('Which parser should stay?'), after);
  assert.match(after, /Nothing will wake this session/);

  // A question of an earlier attempt is not open.
  jsonl(path.join(dir, 'questions.jsonl'), [{ id: 'q3', time: at(9), attempt: 7, question: 'Old attempt?', to: 'orchestrator' }]);
  assert.doesNotMatch((await blocked(f)) || '', /Old attempt/);
  f.release(task);
});

test('lets the stop through while a wait is live and nothing is pending', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const task = await f.start(run, 'work', { config: { hold: true } });
  await f.ready(task);
  await withWait(f, [run.id, '--timeout', '0'], async (child) => {
    await eventually(() => commandOf(child.pid).includes('orch.mjs wait'), 'the wait did not start');
    assert.equal(await blocked(f), null, 'a live wait on the run covers it');
    // A wait parks in a shell between checks; the shell, whose name is the command, still counts.
    if (typeof process.execve === 'function') {
      await eventually(() => /^(\/bin\/)?sh /.test(commandOf(child.pid)), 'the wait did not park');
      assert.ok(commandOf(child.pid).includes('orch.mjs wait'));
      assert.equal(await blocked(f), null, 'a parked wait counts as live');
    }
  });
  // The wait is gone (stopped by PID), so the hook blocks again.
  const reason = await blocked(f);
  assert.ok(reason && /Nothing will wake this session/.test(reason), reason);
  f.release(task);
});

test('a wait that main-wait.json names counts only while that process still runs a wait', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const task = await f.start(run, 'work', { config: { hold: true } });
  await f.ready(task);
  const file = path.join(run.dir, 'main-wait.json');
  // A `wait latest` names its run only once it parks; this stand-in has `orch.mjs wait` in its command
  // line and no run in it.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'orch.mjs wait latest'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    await eventually(() => commandOf(child.pid).includes('orch.mjs wait latest'), 'the stand-in did not start');
    // The test runner is a live process that runs no wait.
    writeJson(file, { pid: process.pid, at: new Date().toISOString() });
    assert.match((await blocked(f)) || '', /Nothing will wake this session/);
    writeJson(file, { pid: child.pid, at: new Date().toISOString() });
    assert.equal(await blocked(f), null);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  assert.match((await blocked(f)) || '', /Nothing will wake this session/, 'its process has ended');
  f.release(task);
});

test('blocks once for each set of items, and never loops', async (t) => {
  const f = await fixture(t);
  const run = await finishedRun(f, 'first');
  const reason = await blocked(f);
  assert.ok(reason && reason.includes(`${run.id}/first`));
  assert.equal(await blocked(f), null, 'the same set is allowed through');
  assert.equal(await blocked(f, input({ stop_hook_active: true })), null, 'so is the stop that follows a block');

  // A new item is a new set, even in the stop that follows a block.
  await f.start(run, 'second');
  await f.finished(run, 'second');
  const next = await blocked(f, input({ stop_hook_active: true }));
  assert.ok(next && next.includes(`${run.id}/second`) && next.includes(`${run.id}/first`), next);
  assert.equal(await blocked(f, input({ stop_hook_active: true })), null);
  assert.equal(await blocked(f), null);

  // Handling everything clears the record, so the same items would block again later.
  await f.command(['result', run.id, 'first'], { env: OWNER });
  await f.command(['result', run.id, 'second'], { env: OWNER });
  assert.equal(await blocked(f), null);
  assert.ok(!fs.existsSync(recordFile(f)));
  await f.start(run, 'third');
  await f.finished(run, 'third');
  assert.ok(await blocked(f), 'a later item blocks');
});

test('does nothing inside an orch task, and when switched off', async (t) => {
  const f = await fixture(t);
  await finishedRun(f);
  assert.equal(await blocked(f, input(), { AGENT_ORCH_TASK: 'work' }), null);
  assert.equal(await blocked(f, input(), { AGENT_ORCH_STOP_HOOK: 'off' }), null);
  assert.ok(!fs.existsSync(path.join(f.state, 'stop-hook')), 'neither run left a record');
  assert.ok(await blocked(f, input(), { AGENT_ORCH_STOP_HOOK: 'on' }), 'any other value leaves the hook on');
});

test('only items that address this session count', async (t) => {
  const f = await fixture(t);
  const run = await finishedRun(f);
  // Another session's runs, a task another task started, and a missing or odd session id.
  assert.equal(await blocked(f, input({ session_id: 'another-session' })), null);
  assert.equal(await blocked(f, input({ session_id: '../escape' })), null);
  assert.equal(await blocked(f, '{ not json'), null, 'no session id at all');
  assert.equal(await blocked(f, '', { CLAUDE_CODE_SESSION_ID: 'another-session' }), null);
  assert.ok(await blocked(f, '{}', { CLAUDE_CODE_SESSION_ID: SESSION }), 'the environment names the session when the input does not');
  const file = f.taskFile(run, 'work');
  const record = readJson(file);
  writeJson(file, { ...record, startedBy: { run: 'other', task: 'parent' } });
  fs.rmSync(recordFile(f), { force: true });
  assert.equal(await blocked(f), null, 'a task another task started reports to that task');
  writeJson(file, { ...record, startedBy: null });
  assert.ok(await blocked(f), 'a null startedBy is the session\'s own task');
});

test('a decision that was read but not resolved blocks until it is resolved', async (t) => {
  const f = await fixture(t);
  const run = await finishedRun(f, 'asks', { finalMessage: 'NEEDS DECISION:\n- Which parser should stay?' });
  const unread = await blocked(f);
  assert.ok(unread && unread.includes(`node ${cli} result ${run.id} asks`), unread);
  await f.command(['result', run.id, 'asks'], { env: OWNER }); // reading it marks the decision seen, and leaves the task open
  const read = await blocked(f);
  assert.ok(read, 'a decision read but not resolved still blocks');
  assert.ok(read.includes('Which parser should stay?'), read);
  assert.ok(read.includes(`node ${cli} start ${run.id} asks --agent claude --brief <answer-file> -- --session fixture-claude`), read);
  assert.ok(read.includes(`node ${cli} resolve ${run.id} asks --note "<how>"`), read);
  assert.ok(read.includes(`node ${cli} close ${run.id} asks`), read);
  await f.command(['resolve', run.id, 'asks', '--note', 'answered it in the chat'], { env: OWNER });
  assert.equal(await blocked(f), null);
});

test('a closed task never blocks, accepted or not, even a write task of the plan', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const planFile = path.join(f.root, 'plan.json');
  fs.mkdirSync(path.join(run.dir, 'briefs'), { recursive: true });
  const tasks = ['work', 'other'].map((id) => {
    const brief = `briefs/${id}.md`;
    fs.writeFileSync(path.join(run.dir, brief), `Planned task ${id}.\n<!-- fake-relay {} -->\n`);
    return { id, goal: `Build ${id}`, type: 'implement', owns: [`src/${id}/`], uses: [], produces: [], resources: [],
      dependsOn: [], agent: 'claude', tier: 'complex', why: 'Fixture assessment', readOnly: false, brief };
  });
  fs.writeFileSync(planFile, JSON.stringify({ goal: 'Ship it', tasks }));
  await f.command(['plan', run.id, planFile]);
  await f.json(['dispatch', run.id]);
  await f.finished(run, 'work');
  await f.finished(run, 'other');
  const reason = await blocked(f);
  assert.ok(reason.includes(`${run.id}/work finished (completed) and nobody has read its result`), reason);
  assert.ok(reason.includes(`${run.id}/other finished (completed)`), reason);
  // Closed by hand, and closed by reading its result: neither is accepted, and neither blocks.
  await f.command(['close', run.id, 'work'], { env: OWNER });
  await f.command(['result', run.id, 'other'], { env: OWNER });
  assert.equal(await blocked(f), null);
  assert.equal(readJson(f.taskFile(run, 'work')).acceptedAt, undefined);
});

test('an accepted task, a read-only task and a task outside the plan need nothing after their result is read', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  await f.start(run, 'impl');
  await f.start(run, 'reader', { flags: ['--read-only'] });
  await f.finished(run, 'impl');
  await f.finished(run, 'reader');
  assert.ok(await blocked(f));
  await f.command(['result', run.id, 'impl'], { env: OWNER });
  await f.command(['result', run.id, 'reader'], { env: OWNER });
  assert.equal(await blocked(f), null, 'no plan lists them, so reading is the end of it');
  await f.command(['accept', run.id, 'impl', '--note', 'checked'], { env: OWNER });
  assert.equal(await blocked(f), null);
});

// A fake gh on PATH, so that a parked babysitter never reaches a real service. It serves one open
// pull request, #42, with nothing to act on (the protocol of park.test.mjs), and its watcher checks
// every second.
async function fakeGh(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

test('a parked babysitter is not a finished result, and needs a wait like a running task', async (t) => {
  const f = await fixture(t);
  await fakeGh(f);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const parked = ['PARKED: PR #42 waits for a human review', '```orch-result',
    '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}', '```'].join('\n');
  const task = await f.json(['start', run.id, 'watch', '--agent', 'claude', '--babysit', '--pr', '42',
    '--why', 'Babysits the fixture PR', '--brief', f.brief('watch', { finalMessage: parked })]);
  // Parked: its attempt ended with the park signal, and its relay is gone.
  await eventually(() => fs.existsSync(path.join(task.outDir, 'result.json')) && commandOf(task.pid) === '', 'the babysitter did not park', 20_000);
  const reason = await blocked(f);
  assert.ok(reason, 'a parked babysitter with no wait blocks the stop');
  assert.match(reason, /Nothing will wake this session/);
  assert.ok(reason.includes('watch'), reason);
  assert.doesNotMatch(reason, /nobody has read/, 'a parked task has not finished');
  await withWait(f, [run.id, '--timeout', '0'], async (child) => {
    await eventually(() => commandOf(child.pid).includes('orch.mjs wait'), 'the wait did not start');
    assert.equal(await blocked(f), null);
  });
  // Closing it ends the park: nothing runs, and a babysitter's result is never a write task's.
  await f.command(['close', run.id, 'watch'], { env: OWNER });
  assert.equal(await blocked(f), null);
});
