import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson } from './helpers.mjs';

// Command tasks: `start --agent command -- COMMAND...` runs a command with no model, through
// scripts/command-relay.mjs, and every reader treats it as a task.

const WHY = 'Runs a script that needs no model watching it';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
// A Claude Code or Codex session's shell, which owns the runs it creates.
const session = (id) => ({ CLAUDE_CODE_SESSION_ID: id, CODEX_THREAD_ID: id });

// `start` with --json before `--`: everything after it is the command.
async function startCommand(f, run, id, argv, { flags = [], env = {}, code = 0 } = {}) {
  const r = await f.command(['start', run.id, id, '--agent', 'command', '--why', WHY, '--json', ...flags, '--', ...argv], { env, code });
  return code === 0 ? JSON.parse(r.stdout) : r;
}
const row = async (f, run, id, env) => (await f.json(['status', run.id], { env })).tasks.find((t) => t.id === id);
// A command that waits for `release` in its folder, after printing `ready`.
const held = (dir, extra = '') => ['sh', '-c', `echo ready > ${JSON.stringify(path.join(dir, 'ready'))}; ${extra}while [ ! -f ${JSON.stringify(path.join(dir, 'release'))} ]; do sleep 0.05; done; echo released`];

test('a command that succeeds: the relay artifacts, status, result, log, a re-run and accept', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('cmd');
  const script = 'for i in $(seq 1 50); do echo "line $i"; done; printf "\\033[32mALL DONE\\033[0m\\n"';
  const task = await startCommand(f, run, 'ok', ['sh', '-c', script], { flags: ['--done', 'ALL DONE'] });
  assert.equal(task.agent, 'command');
  assert.equal(task.model, null);
  assert.equal(task.tier, null);
  assert.equal(task.readOnly, true);
  assert.deepEqual(task.command, ['sh', '-c', script]);
  assert.equal(task.title, `sh -c '${script}'`);
  assert.equal(fs.existsSync(path.join(task.outDir, 'orch-brief.md')), false, 'a command has no brief');

  const done = await f.finished(run, 'ok');
  assert.equal(done.state, 'completed');
  assert.equal(done.agent, 'command');
  assert.equal(done.modelLabel, '-');
  assert.equal(done.mode, 'read-only');
  assert.equal(done.steps, 51);
  assert.equal(done.now, 'ALL DONE');
  assert.equal(done.command, `sh -c '${script}'`);

  const result = readJson(path.join(task.outDir, 'result.json'));
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.doneSeen, true);
  const last = result.finalMessage.split('\n');
  assert.equal(last.length, 40, 'the final message is the last 40 lines');
  assert.equal(last[0], 'line 12');
  assert.equal(last.at(-1), 'ALL DONE', 'without the color codes');
  assert.match(fs.readFileSync(path.join(task.outDir, 'relay.log'), 'utf8'), /^line 1\n[\s\S]*line 50\n/);
  const events = lines(path.join(task.outDir, 'events.jsonl'));
  assert.equal(events[0].type, 'command.started');
  assert.deepEqual(events[0].command, ['sh', '-c', script]);
  const printed = events.slice(1).flatMap((e) => e.message.content[0].content.split('\n'));
  assert.equal(printed.length, 51);
  assert.equal(events.at(-1).command_output.last, 51);

  const status = await f.command(['status', run.id]);
  assert.match(status.stdout, /^ok\s+command\s+-\s+read-only\s+completed\s+\S+\s+51\s+-\s+ALL DONE$/m);
  const shown = await f.command(['result', run.id, 'ok']);
  assert.match(shown.stdout, /^task ok → command \(read-only\), attempt 1: completed \(exit 0\)$/m);
  assert.match(shown.stdout, /^line 50\nALL DONE$/m);
  assert.doesNotMatch(shown.stdout, /^line 11$/m);
  assert.doesNotMatch(shown.stdout, /session:/);
  const log = await f.command(['log', run.id, 'ok', '--lines', '3']);
  assert.match(log.stdout, /line 49\nline 50\n.*ALL DONE/);

  // No session to resume: `start` again runs the same command, with its --done, as attempt 2.
  const again = await startCommand(f, run, 'ok', []);
  assert.equal(again.attempt, 2);
  assert.equal(again.why, WHY);
  assert.deepEqual(again.command, ['sh', '-c', script]);
  assert.equal(again.doneMarker, 'ALL DONE');
  const second = await f.finished(run, 'ok');
  assert.equal(second.attempt, 2);
  assert.equal(second.state, 'completed');
  assert.deepEqual(second.attempts.map((a) => [a.n, a.agent, a.state, a.resumed]), [[2, 'command', 'completed', null], [1, 'command', 'completed', null]]);

  // Accepted as a read-only task: the checkout's changes are not its work.
  fs.writeFileSync(path.join(f.repo, 'untracked.txt'), 'not the command\'s\n');
  const accepted = await f.json(['accept', run.id, 'ok']);
  assert.equal(accepted.acceptedAttempt, 2);
});

test('a command that fails, one that exits 0 without its done marker, one that cannot run, and one that times out', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('fail');
  await startCommand(f, run, 'broke', ['sh', '-c', 'echo "building"; echo "error: missing entry point" >&2; exit 3']);
  await startCommand(f, run, 'unmarked', ['sh', '-c', 'echo "looked at it"'], { flags: ['--done', 'REVIEW COMPLETE'] });
  await startCommand(f, run, 'missing', [path.join(f.root, 'no-such-program')]);
  await startCommand(f, run, 'slow', ['sh', '-c', 'echo started; exec sleep 30'], { flags: ['--timeout', '1s'] });

  const broke = await f.finished(run, 'broke');
  assert.equal(broke.state, 'failed');
  assert.equal(broke.result.exitCode, 3);
  assert.equal(broke.result.error, 'the command exited with code 3');
  assert.equal(broke.now, 'the command exited with code 3 · error: missing entry point');
  assert.match((await f.command(['result', run.id, 'broke'])).stdout, /attempt 1: failed \(exit 3\)\n[\s\S]*building\nerror: missing entry point/);

  const unmarked = await f.finished(run, 'unmarked');
  assert.equal(unmarked.state, 'failed');
  assert.equal(unmarked.result.exitCode, 0);
  assert.equal(unmarked.result.doneSeen, false);
  assert.match(unmarked.result.error, /exited 0 but never printed the done marker "REVIEW COMPLETE"/);

  const missing = await f.finished(run, 'missing');
  assert.equal(missing.state, 'failed');
  assert.equal(missing.result.exitCode, 127);
  assert.match(missing.result.error, /could not run .*no-such-program/);

  const slow = await eventually(async () => {
    const r = await row(f, run, 'slow');
    return r?.result ? r : null;
  }, 'the timeout did not stop the command', 15_000);
  assert.equal(slow.state, 'timeout');
  assert.match(slow.result.error, /did not finish within --timeout 1s/);

  // `wait` lists the failures, as for any failed task.
  const waited = await f.command(['wait', run.id, '--timeout', '0']);
  assert.match(waited.stdout, /^unmarked: failed — the command exited 0 but never printed the done marker "REVIEW COMPLETE"$/m);
  assert.match(waited.stdout, /^slow: timeout — the command did not finish within --timeout 1s/m);
});

test('start refuses what a command task cannot use', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('refuse');
  const refused = async (args, pattern) => {
    const r = await f.command(['start', run.id, 'x', ...args], { code: 2 });
    assert.match(r.stderr, pattern, args.join(' '));
  };
  await refused(['--agent', 'command', '--why', WHY, '--tier', 'light', '--', 'true'], /runs no model: drop --tier/);
  await refused(['--agent', 'command', '--why', WHY, '--brief', f.brief('x'), '--', 'true'], /no brief, sandbox or pull request: drop --brief/);
  await refused(['--agent', 'command', '--why', WHY, '--sandbox', '--', 'true'], /drop --sandbox/);
  await refused(['--agent', 'command', '--why', WHY], /give the command after --/);
  await refused(['--agent', 'command', '--', 'true'], /--why is required/);
  await refused(['--agent', 'command', '--why', WHY, '--timeout', 'soon', '--', 'true'], /bad --timeout "soon"/);
  await refused(['--agent', 'claude', '--tier', 'light', '--why', WHY, '--done', 'X', '--brief', f.brief('x')], /--done applies to --agent command only/);
  await refused(['--agent', 'robot', '--why', WHY, '--', 'true'], /unsupported agent "robot" \(choose: claude, codex, or command/);
  assert.equal(fs.existsSync(f.taskFile(run, 'x')), false);
});

test('the command runs as an argument vector with no shell, in --cd, with a relay\'s variables', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('env');
  const work = path.join(f.root, 'work');
  fs.mkdirSync(work);
  await startCommand(f, run, 'vars', ['env', 'FOO=bar', 'sh', '-c', 'echo $FOO']);
  await startCommand(f, run, 'literal', ['echo', '$HOME', '*', 'a;b']);
  await startCommand(f, run, 'linked', ['sh', '-c', 'echo "$AGENT_ORCH_RUN $AGENT_ORCH_TASK $AGENT_ORCH_DEPTH $(pwd -P)"'], { flags: ['--cd', work] });
  assert.equal((await f.finished(run, 'vars')).result.finalMessage, 'bar');
  assert.equal((await f.finished(run, 'literal')).result.finalMessage, '$HOME * a;b', 'no shell expands the words');
  assert.equal((await f.finished(run, 'linked')).result.finalMessage, `${run.id} linked 1 ${fs.realpathSync(work)}`);
});

test('stop ends the command and its children; close stops a running one; another session is refused', async (t) => {
  const f = await fixture(t);
  const A = session('session-a');
  const B = session('session-b');
  const run = await f.newRun('stop', A);
  const dir = path.join(f.root, 'stop');
  fs.mkdirSync(dir);
  const pidFile = path.join(dir, 'child.pid');
  const task = await startCommand(f, run, 'long', ['sh', '-c', `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; echo waiting; wait`], { env: A });
  const child = Number(await eventually(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 'the command did not start its child'));
  const shell = (await eventually(() => fs.existsSync(path.join(task.outDir, 'events.jsonl')) && lines(path.join(task.outDir, 'events.jsonl'))[0], 'no start event')).pid;
  assert.ok(alive(child) && alive(shell));
  const running = await row(f, run, 'long', A);
  assert.equal(running.state, 'running');
  assert.equal(running.quietMs, null, 'a command is never flagged silent');

  // The ownership guard: another session can neither stop it nor run it again.
  for (const args of [['stop', run.id, 'long'], ['close', run.id, 'long'], ['start', run.id, 'long', '--agent', 'command', '--why', WHY, '--', 'true']]) {
    const r = await f.command(args, { code: 4, env: B });
    assert.match(r.stderr, /Nothing was changed/, args.join(' '));
  }
  assert.ok(alive(task.pid) && alive(child), 'a refused command signalled the task');

  const stopped = await f.command(['stop', run.id, 'long'], { env: A });
  assert.match(stopped.stdout, new RegExp(`^stopped long \\(pid ${task.pid}\\)`));
  await eventually(() => !alive(child) && !alive(shell), 'the command or its child outlived stop');
  const after = await f.finished(run, 'long');
  assert.equal(after.state, 'aborted');
  assert.equal(after.result.signal, 'SIGTERM');
  assert.equal(after.health, 'ok', 'a stop is not a failure to retry');

  // close stops a running command too.
  const second = await startCommand(f, run, 'second', held(dir), { env: A });
  await eventually(() => fs.existsSync(path.join(dir, 'ready')), 'the command did not start');
  const closed = await f.command(['close', run.id, 'second'], { env: A });
  assert.match(closed.stdout, new RegExp(`second: stopped \\(pid ${second.pid}\\) and closed`));
  assert.equal(alive(second.pid), false);
});

// A finished row, waiting longer than f.finished does: ending a group takes its 5-second grace.
const settled = (f, run, id, timeout = 30_000) => eventually(async () => {
  const r = await row(f, run, id);
  return r?.result && !['running', 'prepared'].includes(r.state) ? r : null;
}, `${id} did not finish`, timeout);
const pidIn = (file) => eventually(() => fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').trim()), `no pid in ${file}`);

test('what a command leaves running in its group is ended when it exits, and counted in its result', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('leftover');
  const dir = path.join(f.root, 'left');
  fs.mkdirSync(dir);
  const [polite, stubborn, ready] = ['polite.pid', 'stubborn.pid', 'stubborn.ready'].map((name) => path.join(dir, name));
  // One child leaves on SIGTERM; the other ignores SIGTERM, so only SIGKILL ends it. The command
  // exits as soon as both run.
  const script = `sleep 300 & echo $! > "${polite}"; (trap "" TERM; echo > "${ready}"; exec sleep 301) & echo $! > "${stubborn}"; `
    + `while [ ! -f "${ready}" ]; do sleep 0.05; done; echo spawned`;
  const task = await startCommand(f, run, 'left', ['sh', '-c', script]);
  const children = [await pidIn(polite), await pidIn(stubborn)];
  const groupFile = path.join(task.outDir, 'command-group.json');
  const group = await eventually(() => fs.existsSync(groupFile) && readJson(groupFile), 'no group record');
  const done = await settled(f, run, 'left');
  assert.equal(done.state, 'completed');
  assert.equal(group.pgid, done.result.pid, 'the group is the command\'s own');
  assert.equal(done.result.leftover, 2);
  assert.equal(done.result.leftoverKilled, 1);
  for (const pid of children) await eventually(() => !alive(pid), `leftover ${pid} still runs`);
  assert.deepEqual(['cleared', 'leftover', 'killed'].map((k) => readJson(path.join(task.outDir, 'command-group.json'))[k]), [true, 2, 1]);
  assert.match(fs.readFileSync(path.join(task.outDir, 'relay.log'), 'utf8'), /command-relay: the command left 2 processes running in its group; stopped them, 1 with SIGKILL/);
});

test('stop and close end the group a killed relay left, even after the command that led it exited', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('orphan');
  for (const verb of ['stop', 'close']) {
    const dir = path.join(f.root, verb);
    fs.mkdirSync(dir);
    const [pidFile, release] = ['child.pid', 'release'].map((name) => path.join(dir, name));
    const task = await startCommand(f, run, verb, ['sh', '-c', `sleep 300 & echo $! > "${pidFile}"; while [ ! -f "${release}" ]; do sleep 0.05; done`]);
    const child = await pidIn(pidFile);
    const groupFile = path.join(task.outDir, 'command-group.json');
    const leader = (await eventually(() => fs.existsSync(groupFile) && readJson(groupFile), 'no group record')).pgid;
    // The relay dies without ending the group; then the command itself exits, leaving its child.
    process.kill(task.pid, 'SIGKILL');
    await eventually(() => !alive(task.pid), 'the relay outlived SIGKILL');
    fs.writeFileSync(release, '');
    await eventually(() => !alive(leader), 'the command did not exit');
    assert.ok(alive(child), 'the child should outlive the command and its relay');

    const r = await f.command([verb, run.id, verb]);
    const said = `stopped the 1 process its command left running (process group ${leader})`;
    assert.ok(r.stdout.includes(verb === 'stop' ? `${said}; its relay had already exited` : `close: ${said}; closed`), r.stdout);
    await eventually(() => !alive(child), `${verb} left the child running`);
    assert.equal(readJson(groupFile).cleared, true);
  }
  // Nothing is left to stop.
  assert.match((await f.command(['stop', run.id, 'stop'], { code: 1 })).stderr, /task stop is not running/);
});

test('a 32 MB burst streams into small events in a 64 MB heap; relay.log keeps it whole', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('burst');
  // 16 MB of 128-byte lines, then one 16 MB line, then the marker.
  const script = 'yes "$(printf "%0127d" 7)" | head -c 16777216; head -c 16777216 /dev/zero | tr "\\0" y; printf "\\nBURST DONE\\n"';
  const task = await startCommand(f, run, 'burst', ['sh', '-c', script], { flags: ['--done', 'BURST DONE'], env: { NODE_OPTIONS: '--max-old-space-size=64' } });
  const done = await settled(f, run, 'burst', 90_000);
  assert.equal(done.state, 'completed', done.result.error);
  assert.equal(done.result.lines, 131074);
  assert.equal(fs.statSync(path.join(task.outDir, 'relay.log')).size, 32 * 1024 * 1024 + 12, 'relay.log keeps the full output');

  const raw = fs.readFileSync(path.join(task.outDir, 'events.jsonl'), 'utf8').trim().split('\n');
  const events = raw.slice(1).map((line) => JSON.parse(line));
  assert.ok(raw.every((line) => line.length < 70 * 1024), 'an event over 64 KB of output');
  assert.ok(events.every((e) => e.command_output.last - e.command_output.first < 200), 'an event over 200 lines');
  assert.deepEqual(events.map((e) => e.command_output.first), events.map((e, i) => (i ? events[i - 1].command_output.last + 1 : 1)), 'lines skipped or repeated');
  assert.equal(events.at(-1).command_output.last, 131074);
  const cut = events.filter((e) => e.command_output.truncated);
  assert.equal(cut.length, 1);
  const long = cut[0].message.content[0].content.split('\n').find((l) => l.startsWith('y'));
  assert.equal(long, `${'y'.repeat(4096)} … [truncated: the line has 16777216 characters; relay.log has it whole]`);
  assert.equal(done.result.finalMessage.split('\n').at(-1), 'BURST DONE');
});

test('the done marker is found when it falls across two reads of the output', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('split');
  // 1048574 characters, then the marker: the 1 MiB boundary falls between "DO" and "NE".
  await startCommand(f, run, 'split', [process.execPath, '-e', "process.stdout.write('x'.repeat(1048574) + 'DONE\\n')"], { flags: ['--done', 'DONE'] });
  const done = await f.finished(run, 'split');
  assert.equal(done.state, 'completed', done.result.error);
  assert.equal(done.result.doneSeen, true);
  assert.equal(done.result.lines, 1);
  assert.match(done.result.finalMessage, /^x{4096} … \[truncated: the line has 1048578 characters; relay\.log has it whole\]$/);
});

test('wait wakes when a command finishes, and the task that started it gets the finish notice', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const env = as(parent, 'lead');
  const child = await f.newRun('child', env);
  const dir = path.join(f.root, 'held');
  fs.mkdirSync(dir);
  const task = await startCommand(f, child, 'review', held(dir), { env });
  assert.deepEqual(task.startedBy, { run: parent.id, task: 'lead' });
  await eventually(() => fs.existsSync(path.join(dir, 'ready')), 'the command did not start');

  const waited = await f.waitAfterPoll([child.id, 'review', '--timeout', '0'], () => fs.writeFileSync(path.join(dir, 'release'), ''), { env });
  assert.match(waited.stdout, /review\s+command\s+-\s+read-only\s+completed/);

  const notice = await eventually(() => {
    const file = path.join(child.dir, 'tasks', 'review', 'attempt-1', 'parent-notice.json');
    const record = fs.existsSync(file) ? readJson(file) : null;
    return record?.sentAt || record?.skipped ? record : null;
  }, 'no finish notice', 15_000);
  assert.equal(notice.to, `${parent.id}/lead`);
  assert.equal(notice.state, 'completed');
  const inbox = lines(path.join(parent.dir, 'tasks', 'lead', 'inbox.jsonl'));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'finished');
  assert.match(inbox[0].text, new RegExp(`Agent ${child.id}/review \\(attempt 1\\) completed and is ready for your review\\.`));
});

test('a review script\'s headless claude -p is linked to the command task through its environment', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('review');
  const bin = path.join(f.root, 'bin');
  const work = path.join(f.root, 'checkout');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);
  // A fake `claude` that records what a real one would inherit, then prints a review.
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "$AGENT_ORCH_RUN" "$AGENT_ORCH_TASK" "$AGENT_ORCH_DEPTH" "$*" > claude-record.txt',
    'echo "reviewer: no findings"',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(work, 'review.sh'), [
    '#!/bin/sh',
    'echo "starting the reviewer"',
    'claude -p "Review the change" --output-format text || exit 1',
    'echo "REVIEW COMPLETE"',
  ].join('\n'), { mode: 0o755 });
  const env = { PATH: `${bin}:${f.env.PATH}` };
  await startCommand(f, run, 'standards', ['bash', 'review.sh'], { flags: ['--cd', work, '--done', 'REVIEW COMPLETE'], env });
  const done = await f.finished(run, 'standards');
  assert.equal(done.state, 'completed');
  assert.equal(done.result.finalMessage, 'starting the reviewer\nreviewer: no findings\nREVIEW COMPLETE');
  assert.deepEqual(fs.readFileSync(path.join(work, 'claude-record.txt'), 'utf8').trim().split('\n'),
    [run.id, 'standards', '1', '-p Review the change --output-format text']);
});

// These fakes write the durable files the CLIs leave, then exit immediately. The transcript
// case removes Claude's live PID file before exit, as a clean shutdown does.
function quickAgent(f, agent) {
  const dir = path.join(f.root, 'quick-agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, agent);
  fs.writeFileSync(file, `
const fs = require('node:fs');
const path = require('node:path');
const agent = ${JSON.stringify(agent)};
const sessionId = process.env.QUICK_SESSION;
const cwd = process.cwd();
const startedAt = Date.now();
const timestamp = new Date(startedAt).toISOString();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value) + '\\n'); };
let liveFile;
if (agent === 'claude') {
  liveFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions', process.pid + '.json');
  write(liveFile, { sessionId, cwd, startedAt, pid: process.pid, entrypoint: 'sdk-cli' });
  write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), sessionId + '.jsonl'),
    { type: 'user', sessionId, cwd, timestamp, message: { role: 'user', content: 'Review.' } });
} else {
  const file = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '10', 'rollout-' + sessionId + '.jsonl');
  write(file, { type: 'session_meta', timestamp, payload: { id: sessionId, cwd, timestamp, originator: 'codex_exec', source: 'exec' } });
  fs.openSync(file, 'a');
}
const finish = () => {
  if (liveFile && process.env.QUICK_REMOVE_SESSION) fs.unlinkSync(liveFile);
  write(process.env.QUICK_DONE, { pid: process.pid, durationMs: Date.now() - startedAt });
};
if (process.env.QUICK_RELEASE) {
  write(process.env.QUICK_READY, { pid: process.pid });
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parent || !fs.existsSync(path.dirname(process.env.QUICK_RELEASE))) process.exit(0);
    if (fs.existsSync(process.env.QUICK_RELEASE)) { clearInterval(timer); finish(); }
  }, 10);
} else finish();
`);
  return file;
}

for (const agent of ['claude', 'codex']) {
  test(`the relay records a subsecond ${agent} with its session and parent without a dashboard`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const bin = quickAgent(f, agent);
    const doneFile = path.join(f.root, `${agent}-done.json`);
    const id = agent === 'codex' ? '11111111-2222-4333-8444-555555555555' : 'quick-claude';
    // A wrapper starts the agent in a child directory, and waits for it, as review scripts do.
    const childDir = path.join(f.repo, 'child');
    fs.mkdirSync(childDir);
    const wrapper = path.join(f.root, `run-${agent}.cjs`);
    fs.writeFileSync(wrapper, `require('node:child_process').spawnSync(process.execPath, ${JSON.stringify([bin, agent === 'claude' ? '-p' : 'exec', 'review'])}, { cwd: ${JSON.stringify(childDir)}, env: process.env, stdio: 'inherit' });`);
    await startCommand(f, run, 'quick', [process.execPath, wrapper], { env: {
      QUICK_SESSION: id, QUICK_DONE: doneFile, QUICK_REMOVE_SESSION: '1',
    } });
    await f.finished(run, 'quick');
    assert.ok(readJson(doneFile).durationMs < 1000, 'the agent exits in under a second');
    const records = lines(path.join(f.state, 'external.jsonl'));
    assert.equal(records.length, 1);
    const r = records[0];
    assert.deepEqual([r.key, r.agent, r.sessionId, r.parent.run, r.parent.task, r.cwd],
      [`${agent}:${id}`, agent, id, run.id, 'quick', childDir]);
    assert.ok(r.startedMs > 0);
    assert.ok(['pid', 'command', 'name', 'launcher'].every((k) => Object.hasOwn(r, k)));
    assert.equal(fs.existsSync(path.join(f.state, 'dashboard.json')), false);
  });
}

test('the relay ignores a simultaneous unrelated Claude session in another directory', async (t) => {
  const { spawn } = await import('node:child_process');
  let outsider, outsideRelease;
  t.after(async () => {
    if (!outsider) return;
    fs.writeFileSync(outsideRelease, '');
    await eventually(() => outsider.exitCode !== null, 'unrelated fixture did not stop');
  });
  const f = await fixture(t);
  const run = await f.newRun();
  const bin = quickAgent(f, 'claude');
  const control = path.join(f.root, 'control');
  fs.mkdirSync(control);
  await startCommand(f, run, 'owner', held(control));
  await eventually(() => fs.existsSync(path.join(control, 'ready')), 'command was not ready');
  outsideRelease = path.join(f.root, 'outside-release');
  outsider = spawn(process.execPath, [bin, '-p', 'review'], { cwd: f.root, env: {
    ...f.env, QUICK_SESSION: 'unrelated', QUICK_DONE: path.join(f.root, 'outside-done.json'),
    QUICK_READY: path.join(f.root, 'outside-ready.json'), QUICK_RELEASE: path.join(f.root, 'outside-release'),
  }, stdio: 'ignore' });
  await eventually(() => fs.existsSync(path.join(f.root, 'outside-ready.json')), 'unrelated agent was not ready');
  fs.writeFileSync(path.join(control, 'release'), '');
  await f.finished(run, 'owner');
  const file = path.join(f.state, 'external.jsonl');
  assert.deepEqual(fs.existsSync(file) ? lines(file) : [], []);
});

test('the relay and dashboard record the same live command agent once', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const bin = quickAgent(f, 'claude');
  const release = path.join(f.root, 'agent-release');
  await startCommand(f, run, 'shared', [process.execPath, bin, '-p', 'review'], { env: {
    QUICK_SESSION: 'shared-agent', QUICK_DONE: path.join(f.root, 'done.json'),
    QUICK_READY: path.join(f.root, 'ready.json'), QUICK_RELEASE: release,
  } });
  const file = path.join(f.state, 'external.jsonl');
  await eventually(() => fs.existsSync(file) && lines(file).length, 'relay did not record the running agent');
  const board = await f.dashboard();
  const found = await eventually(async () => {
    const state = await board.json('/api/state');
    return JSON.stringify(state).includes('shared-agent') ? state : null;
  }, 'dashboard did not find the shared agent', 20_000);
  assert.ok(found);
  assert.equal(lines(file).filter((r) => r.key === 'claude:shared-agent').length, 1);
  fs.writeFileSync(release, '');
  await f.finished(run, 'shared');
  assert.equal(lines(file).filter((r) => r.key === 'claude:shared-agent').length, 1);
});
