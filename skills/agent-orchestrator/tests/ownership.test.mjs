import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Constants: which commands are open to anyone, and which are guarded.
import { GUARDED_COMMANDS, OPEN_COMMANDS } from '../scripts/lib/ownership.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));

// A Claude Code or Codex session's shell. Both variables name the session, so the caller is that
// session whichever host (or none) runs the suite.
const session = (id) => ({ CLAUDE_CODE_SESSION_ID: id, CODEX_THREAD_ID: id });
const A = session('session-a');
const B = session('session-b');
// The shell of the agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const task = (run, id) => readJson(path.join(run.dir, 'tasks', id, 'task.json'));
const inbox = (run, id) => {
  const file = path.join(run.dir, 'tasks', id, 'inbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const claudeCall = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } });
const OWNER_A = /belongs to (claude|codex) session session-a\b/;

// Every file under a run's folder, with its content: a refused command leaves it as it was.
function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

// A held task with a shell command running under its relay, which steering would stop.
async function busy(f, run, id, env) {
  const command = 'sleep 61; echo done';
  const started = await f.start(run, id, { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: [claudeCall(command)] }, flags: ['--read-only'], env });
  await f.ready(started);
  const pid = Number(await eventually(() => fs.existsSync(path.join(started.outDir, 'shell.pid')) && fs.readFileSync(path.join(started.outDir, 'shell.pid'), 'utf8'), 'the shell did not start'));
  return { task: started, pid };
}

async function held(f, run, id, env) {
  const started = await f.start(run, id, { config: { hold: true }, flags: ['--read-only'], env });
  await f.ready(started);
  return started;
}

// Fake Claude Code processes: a shell named `claude` runs one orch.mjs command as its child, so the
// command's caller is that Claude session whichever host (or none) runs the suite. `linger` keeps
// the shell running afterwards, as the session's live process.
function hosts(t, f) {
  const bin = path.join(f.root, 'host', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nout=$1; linger=$2; shift 2\n"$@" > "$out.stdout" 2> "$out.stderr"\necho $? > "$out.tmp"; mv "$out.tmp" "$out.code"\n[ "$linger" = 1 ] || exit 0\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  let calls = 0;
  return {
    async run(env, args, { code = 0, linger = false } = {}) {
      const out = path.join(f.root, 'host', `call-${++calls}`);
      const child = spawn(bin, [out, linger ? '1' : '0', process.execPath, cli, ...args], { cwd: f.repo, env: { ...f.env, ...env }, stdio: 'ignore', detached: true });
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      t.after(stop);
      const status = Number(await eventually(() => fs.existsSync(`${out}.code`) && fs.readFileSync(`${out}.code`, 'utf8'), `node orch.mjs ${args.join(' ')} did not finish`, 20_000));
      const result = { stdout: fs.readFileSync(`${out}.stdout`, 'utf8'), stderr: fs.readFileSync(`${out}.stderr`, 'utf8'), pid: child.pid, stop };
      assert.equal(status, code, `node orch.mjs ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result;
    },
  };
}

// A fake Claude Code session that stays up and runs orch.mjs commands as its children, one at a
// time, as a live session's shell does: every command it runs has the same host process. Requests
// and answers are files in its folder.
function sessionHost(t, f, env) {
  const dir = fs.mkdtempSync(path.join(f.root, 'session-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const [dir, cli] = process.argv.slice(2);
let n = 0;
setInterval(() => {
  const req = dir + '/req-' + (n + 1) + '.json';
  if (!fs.existsSync(req)) return;
  n += 1;
  const r = spawnSync(process.execPath, [cli, ...JSON.parse(fs.readFileSync(req, 'utf8'))], { encoding: 'utf8' });
  fs.writeFileSync(dir + '/res.tmp', JSON.stringify({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
  fs.renameSync(dir + '/res.tmp', dir + '/res-' + n + '.json');
}, 50);
`, { mode: 0o755 });
  const child = spawn(bin, [dir, cli], { cwd: f.repo, env: { ...f.env, ...env }, stdio: 'ignore', detached: true });
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  t.after(stop);
  let calls = 0;
  return {
    pid: child.pid,
    stop,
    async run(args, { code = 0 } = {}) {
      const k = ++calls;
      fs.writeFileSync(path.join(dir, 'req.tmp'), JSON.stringify(args));
      fs.renameSync(path.join(dir, 'req.tmp'), path.join(dir, `req-${k}.json`));
      const answer = path.join(dir, `res-${k}.json`);
      const result = JSON.parse(await eventually(() => fs.existsSync(answer) && fs.readFileSync(answer, 'utf8'), `node orch.mjs ${args.join(' ')} did not finish`, 20_000));
      assert.equal(result.code, code, `node orch.mjs ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result;
    },
  };
}

test('every orch.mjs command is either open to anyone or guarded', () => {
  const source = fs.readFileSync(cli, 'utf8');
  const table = /const handlers = \{([\s\S]*?)\n\};/.exec(source)?.[1];
  assert.ok(table, 'orch.mjs has no handlers table');
  const commands = [...table.matchAll(/^\s*"?([\w-]+)"?:/gm)].map((m) => m[1]);
  assert.ok(commands.length > 20, `found only ${commands.length} commands`);
  const guarded = Object.keys(GUARDED_COMMANDS);
  assert.deepEqual(commands.filter((c) => !OPEN_COMMANDS.has(c) && !guarded.includes(c)), [], 'a command is on neither list: add it to OPEN_COMMANDS or GUARDED_COMMANDS in lib/ownership.mjs');
  assert.deepEqual(commands.filter((c) => OPEN_COMMANDS.has(c) && guarded.includes(c)), [], 'a command is on both lists');
  assert.deepEqual([...OPEN_COMMANDS, ...guarded].filter((c) => !commands.includes(c)), [], 'a list names a command orch.mjs does not have');
});

test('every guarded command refuses another session\'s run, changes nothing and signals nothing; reads stay open', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('mine', A);
  const { task: running, pid: shell } = await busy(f, run, 'busy', A);
  await f.start(run, 'done', { flags: ['--read-only'], env: A });
  await f.start(run, 'broke', { config: { status: 'failed', error: 'boom' }, flags: ['--read-only'], env: A });
  await f.finished(run, 'done');
  await f.finished(run, 'broke');
  const brief = f.brief('again');
  const planFile = path.join(f.root, 'plan.json');
  writeJson(planFile, { goal: 'Changed by B', acceptance: ['works'], tasks: [{ id: 'added', goal: 'Review', type: 'review', owns: [], uses: [], produces: [], resources: [], dependsOn: [], agent: 'claude', tier: 'light', why: 'Small review', readOnly: true, brief: 'briefs/added.md' }] });
  const before = snapshot(run.dir);

  // One refused call per guarded command, including those orch.mjs checks before they run.
  const refused = [
    ['start', run.id, 'done', '--agent', 'claude', '--tier', 'complex', '--why', 'resume', '--brief', brief],
    ['start', run.id, 'fresh', '--agent', 'claude', '--tier', 'complex', '--why', 'new', '--brief', brief],
    ['stop', run.id, 'busy'],
    ['close', run.id, 'busy'],
    ['close', run.id, '--all'],
    ['cleanup', run.id],
    ['dispatch', run.id],
    ['accept', run.id, 'done'],
    ['verdict', run.id, 'done', 'clean'],
    ['verdict', run.id, 'done', 'reject'],
    ['resolve', run.id, 'done', '--note', 'handled'],
    ['integrate', run.id, 'done'],
    ['send', run.id, 'busy', 'Stop now.', '--steer'],
    ['steer', run.id, 'busy'],
    ['plan', run.id, planFile],
    ['worktree', run.id, 'added', '--no-prep'],
    ['brief', run.id, 'added', '--type', 'review'],
    ['verify', run.id, 'done', '--', 'true'],
    ['review', run.id, 'done'],
    ['rework', run.id, 'done'],
    ['inbox', run.id, 'busy', '--ack'],
    ['reply', run.id, 'busy', 'Done.'],
  ];
  assert.deepEqual(Object.keys(GUARDED_COMMANDS).filter((c) => !refused.some((args) => args[0] === c)), [], 'a guarded command has no refusal case here');
  for (const args of refused) {
    const r = await f.command(args, { code: 4, env: B });
    assert.match(r.stderr, OWNER_A, args.join(' '));
    assert.match(r.stderr, /SendMessage|ask the user to pass the request on/, args.join(' '));
    assert.match(r.stderr, /Nothing was changed/, args.join(' '));
  }
  // close --all over a mix of running, completed and failed tasks acts on none, and lists them.
  const all = await f.command(['close', run.id, '--all'], { code: 4, env: B });
  assert.match(all.stderr, /Refused: .*busy \(running\)/);
  assert.match(all.stderr, /done \(completed\)/);
  assert.match(all.stderr, /broke \(failed\)/);

  // Reading stays open, and another session's `result` does not close the task it reads.
  const status = await f.command(['status', run.id], { env: B });
  assert.match(status.stdout.split('\n')[0], /another session's: read-only for you/);
  assert.equal((await f.json(['status', run.id], { env: B })).ownership.readOnly, true);
  await f.command(['result', run.id, 'done'], { env: B });
  await f.command(['log', run.id, 'busy'], { env: B });
  await f.command(['inbox', run.id, 'busy'], { env: B });
  await f.command(['plan', run.id, planFile, '--check'], { env: B });
  await f.command(['dispatch', run.id, '--dry-run'], { code: 1, env: B }); // no plan: refused for that, not its owner
  await f.command(['integrate', run.id, 'done', '--dry-run'], { code: 1, env: B }); // refused for its phase
  const recover = await f.command(['recover', '--all'], { env: B });
  assert.match(recover.stdout, new RegExp(`run ${run.id}.*another session's: read-only for you`));

  assert.deepEqual(snapshot(run.dir), before, 'a refused or read-only command changed the run');
  assert.ok(alive(running.pid), 'the relay was signalled');
  assert.ok(alive(shell), 'the agent\'s command was stopped');

  // A plain message is open to anyone.
  await f.command(['send', run.id, 'busy', 'FYI.'], { env: B });

  // The owner sees no marker, and may act; its own changes leave no notice.
  const own = await f.command(['status', run.id], { env: A });
  assert.doesNotMatch(own.stdout, /read-only for you/);
  await f.command(['plan', run.id, planFile], { env: A });
  const closed = await f.json(['close', run.id, '--all'], { env: A });
  assert.deepEqual(closed.closed.sort(), ['broke', 'busy', 'done']);
  assert.equal(task(run, 'busy').closedBy.sessionId, 'session-a');
  assert.equal(fs.existsSync(path.join(run.dir, 'owner-notices.jsonl')), false);
});

test('a main session manages every descendant run; a delegated agent its own, never a sibling\'s or its parent\'s', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent', A);
  await held(f, parent, 'lead', A);
  const sib = await held(f, parent, 'sib', A);
  const nested = await f.newRun('nested', as(parent, 'lead'));
  await held(f, nested, 'kid', as(parent, 'lead'));
  const deeper = await f.newRun('deeper', as(nested, 'kid', 2));
  await held(f, deeper, 'leaf', as(nested, 'kid', 2));

  // A sibling's agent, another main session, and the delegated agent on its parent's run: refused.
  const bySibling = await f.command(['stop', nested.id, 'kid'], { code: 4, env: as(parent, 'sib') });
  assert.match(bySibling.stderr, new RegExp(`belongs to task lead of run ${parent.id} \\(an orch task\\), under (claude|codex) session session-a`));
  assert.match(bySibling.stderr, new RegExp(`send ${parent.id} lead`));
  await f.command(['close', deeper.id, 'leaf'], { code: 4, env: as(parent, 'sib') });
  await f.command(['stop', nested.id, 'kid'], { code: 4, env: B });
  const byChild = await f.command(['stop', parent.id, 'sib'], { code: 4, env: as(parent, 'lead') });
  assert.match(byChild.stderr, OWNER_A);
  assert.ok(alive(sib.pid));

  // The delegated agent manages its own run and the runs below it.
  await f.command(['send', nested.id, 'kid', 'Carry on.', '--steer'], { env: as(parent, 'lead') });
  await f.command(['close', deeper.id, 'leaf'], { env: as(parent, 'lead') });
  // The main session manages its descendants, two levels down too.
  await f.command(['stop', nested.id, 'kid'], { env: A });
  assert.equal(task(nested, 'kid').stoppedBy.sessionId, 'session-a');
  // Owners up the chain leave no notice, and the delegated agent gets no owner notice.
  assert.equal(fs.existsSync(path.join(nested.dir, 'owner-notices.jsonl')), false);
  assert.deepEqual(inbox(parent, 'lead').filter((m) => m.kind === 'owner-notice'), []);
});

test('a run launched from a terminal is the user\'s; a nested run belongs to its parent task, whatever the root', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('terminal');
  // As `new` records it when no Claude Code or Codex process runs it.
  const file = path.join(run.dir, 'run.json');
  writeJson(file, { ...readJson(file), orchestrator: { agent: 'terminal', sessionId: null } });
  await held(f, run, 'lead');
  const sibling = await held(f, run, 'sibling');

  // An agent session is refused and told to ask the user, and cannot adopt the user's run.
  const bySession = await f.command(['stop', run.id, 'sibling'], { code: 4, env: A });
  assert.match(bySession.stderr, /belongs to the user at a terminal, not to you\.\n {2}It is the user's run: ask the user to stop task sibling/);
  const adopt = await f.command(['stop', run.id, 'sibling', '--adopt'], { code: 4, env: A });
  assert.match(adopt.stderr, /--adopt takes over only a run whose owners have gone/);
  assert.match((await f.command(['status', run.id], { env: A })).stdout.split('\n')[0], /the user's run: read-only for you/);

  // The lead's nested run is the lead's: its sibling and agent sessions are refused.
  const nested = await f.newRun('nested', as(run, 'lead'));
  const kid = await held(f, nested, 'kid', as(run, 'lead'));
  const bySibling = await f.command(['close', nested.id, 'kid'], { code: 4, env: as(run, 'sibling') });
  assert.match(bySibling.stderr, new RegExp(`belongs to task lead of run ${run.id} \\(an orch task\\), under the user at a terminal`));
  assert.match(bySibling.stderr, new RegExp(`send ${run.id} lead`));
  await f.command(['close', nested.id, 'kid'], { code: 4, env: A });
  assert.ok(alive(kid.pid));
  assert.ok(alive(sibling.pid));
  await f.command(['close', nested.id, 'kid'], { env: as(run, 'lead') });

  // The user acts on its own run.
  await f.command(['stop', run.id, 'sibling']);
  assert.equal(task(run, 'sibling').stoppedBy, 'user (terminal)');
});

test('an orphaned run is refused until --adopt takes it over; --adopt is refused while an owner remains', async (t) => {
  const f = await fixture(t);
  const host = hosts(t, f);
  const launcher = await host.run(A, ['new', '--repo', f.repo, '--name', 'hosted', '--json'], { linger: true });
  const run = JSON.parse(launcher.stdout);
  assert.deepEqual([run.orchestrator.agent, run.orchestrator.sessionId, run.orchestrator.pid], ['claude', 'session-a', launcher.pid]);
  assert.ok(run.orchestrator.started, 'new records the launcher\'s start time');
  assert.equal(run.orchestrator.lastSeenAt, run.createdAt);
  // The user starts a task in it from a terminal, which leaves the launcher's record alone.
  const relay = await held(f, run, 'busy');
  const file = path.join(run.dir, 'run.json');
  const late = { ...B, AGENT_ORCH_ADOPT_AFTER: '0' }; // the run counts as unused at once

  const live = await host.run(B, ['close', run.id, 'busy'], { code: 4 });
  assert.match(live.stderr, new RegExp(`claude session session-a \\(pid ${launcher.pid}\\)`));
  assert.doesNotMatch(live.stderr, /orphaned/);
  const early = await host.run(late, ['close', run.id, 'busy', '--adopt'], { code: 4 });
  assert.match(early.stderr, /refusing --adopt .*has not gone/);
  assert.equal(readJson(file).orchestrator.sessionId, 'session-a');

  // A PID that a later process reuses is not the launcher.
  const record = readJson(file);
  writeJson(file, { ...record, orchestrator: { ...record.orchestrator, started: 'Thu Jan 1 00:00:00 1970' } });
  assert.match((await host.run(late, ['stop', run.id, 'busy'], { code: 4 })).stderr, /pid \d+ now belongs to a process started at another time, and no owner has used the run since/);
  writeJson(file, record);

  launcher.stop();
  await eventually(() => !alive(launcher.pid), 'the host session did not exit');
  const orphaned = await host.run(late, ['close', run.id, 'busy'], { code: 4 });
  assert.match(orphaned.stderr, /Its owners have gone \(its process \(pid \d+\) is gone, and no owner has used the run since \S+\), so the run is orphaned: pass --adopt/);
  assert.match((await host.run(late, ['status', run.id])).stdout.split('\n')[0], /read-only for you \(orphaned/);
  assert.ok(alive(relay.pid));
  assert.equal(task(run, 'busy').closedAt ?? null, null);

  // --adopt from a terminal has no session to make the owner.
  await f.command(['close', run.id, 'busy', '--adopt'], { code: 2 });
  const adopted = await host.run(late, ['close', run.id, 'busy', '--adopt']);
  assert.match(adopted.stderr, /adopted run \S+: claude session session-b\b.* now owns it/);
  const after = readJson(file);
  assert.deepEqual([after.orchestrator.agent, after.orchestrator.sessionId], ['claude', 'session-b']);
  assert.equal(after.previousOrchestrators[0].sessionId, 'session-a');
  assert.equal(after.previousOrchestrators[0].replacedBy.sessionId, 'session-b');
  assert.equal(task(run, 'busy').closedBy.sessionId, 'session-b');

  // The old owner, back with the same session id, learns it from status and wait, once.
  const status = await host.run(A, ['status', run.id]);
  assert.match(status.stdout.split('\n')[0], /another session's: read-only for you/);
  assert.match(status.stdout, /run: run \S+ was adopted by claude session session-b/);
  assert.match(status.stdout, /busy: closed by claude session session-b \(pid \d+\) at \S+, not by you: check it and resume it if it was still needed/);
  const woke = await host.run(A, ['wait', run.id, '--timeout', '30s'], { code: 5 });
  assert.match(woke.stdout, /busy: closed by claude session session-b/);
  assert.match(woke.stdout, /\(a task needs attention\)/);
  assert.doesNotMatch((await host.run(A, ['status', run.id])).stdout, /not by you/);
  // The new owner sees none of it.
  assert.doesNotMatch((await host.run(B, ['status', run.id])).stdout, /not by you|read-only for you/);
});

test('a resumed owner keeps its run: its first command records its new process at once, and --adopt waits', async (t) => {
  const f = await fixture(t);
  const host = hosts(t, f);
  const first = sessionHost(t, f, A);
  const run = JSON.parse((await first.run(['new', '--repo', f.repo, '--name', 'resumed', '--json'])).stdout);
  const file = path.join(run.dir, 'run.json');
  assert.equal(run.orchestrator.pid, first.pid);
  await held(f, run, 'busy');
  first.stop();
  await eventually(() => !alive(first.pid), 'the first process did not exit');

  // The same session resumes in a new process within the minute. Its first command, a read,
  // records the new process at once.
  const second = sessionHost(t, f, A);
  assert.equal(JSON.parse((await second.run(['status', run.id, '--json'])).stdout).ownership.mine, true);
  const touched = readJson(file).orchestrator;
  assert.equal(touched.pid, second.pid);
  assert.ok(touched.started);
  // Another command from the same process within the minute writes nothing.
  await second.run(['log', run.id, 'busy']);
  assert.deepEqual(readJson(file).orchestrator, touched);
  // The same PID started at another time is a new process too: recorded at once.
  writeJson(file, { ...readJson(file), orchestrator: { ...touched, started: 'Thu Jan 1 00:00:00 1970' } });
  await second.run(['log', run.id, 'busy']);
  assert.equal(readJson(file).orchestrator.started, touched.started);

  // While it lives, nobody adopts the run, even when unused counts at once.
  const late = { ...B, AGENT_ORCH_ADOPT_AFTER: '0' };
  assert.match((await host.run(late, ['close', run.id, 'busy', '--adopt'], { code: 4 })).stderr, /has not gone/);
  assert.equal(readJson(file).orchestrator.sessionId, 'session-a');
  second.stop();
  await eventually(() => !alive(second.pid), 'the second process did not exit');
  // Gone, but it used the run lately: it may have resumed again.
  const recent = await host.run(B, ['close', run.id, 'busy', '--adopt'], { code: 4 });
  assert.match(recent.stderr, /but it used the run at \S+, so it may have resumed in a new process; --adopt works once the run has been unused for 30m/);
  assert.equal(readJson(file).orchestrator.sessionId, 'session-a');
  await host.run(late, ['close', run.id, 'busy', '--adopt']);
  assert.equal(readJson(file).orchestrator.sessionId, 'session-b');
});

test('two runs started in the same second with the same name get their own ids; new never overwrites a run', async (t) => {
  const f = await fixture(t);
  // Every `new` below sees the same clock, so they all stamp the same second.
  const preload = path.join(f.root, 'clock.cjs');
  fs.writeFileSync(preload, "const D = Date; global.Date = class extends D { constructor(...a) { super(...(a.length ? a : ['2026-11-09T12:00:00Z'])); } static now() { return D.parse('2026-11-09T12:00:00Z'); } };");
  const clock = { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  const first = await f.newRun('collision', { ...A, ...clock });
  const running = await held(f, first, 'busy', A);
  const second = await f.newRun('collision', { ...B, ...clock });
  const third = await f.newRun('collision', { ...B, ...clock });
  assert.deepEqual([second.id, third.id], [`${first.id}-2`, `${first.id}-3`]);
  assert.equal(readJson(path.join(first.dir, 'run.json')).orchestrator.sessionId, 'session-a');
  assert.equal(readJson(path.join(second.dir, 'run.json')).orchestrator.sessionId, 'session-b');
  const refused = await f.command(['close', first.id, 'busy'], { code: 4, env: B });
  assert.match(refused.stderr, OWNER_A);
  assert.ok(alive(running.pid));
  assert.equal(task(first, 'busy').closedAt ?? null, null);
});

test('a gate rerun by anyone but the owner leaves the owner a notice', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('verified', A);
  await f.start(run, 'done', { flags: ['--read-only'], env: A });
  await f.finished(run, 'done');
  await f.command(['verify', run.id, 'done', '--', 'true']);
  const records = () => fs.readFileSync(path.join(run.dir, 'tasks', 'done', 'verifications.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records()[0].actor, 'user (terminal)');
  const status = await f.json(['status', run.id], { env: A });
  assert.deepEqual(status.changedByOthers.map((n) => [n.task, n.action, n.by, n.text]), [
    ['done', 'gate rerun', 'user (terminal)', 'gate rerun by the user: a gate was rerun in its working directory and recorded; nothing to undo'],
  ]);
  // The owner's own rerun leaves no notice.
  await f.command(['verify', run.id, 'done', '--', 'true'], { env: A });
  assert.equal(records()[1].actor.sessionId, 'session-a');
  assert.equal((await f.json(['status', run.id], { env: A })).changedByOthers.length, 1);
});

// A fake gh on PATH serving pull request #42 (as park.test.mjs does), for a revived park watcher.
function github(f) {
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
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: 'abc', headRefName: 'main', baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

test('another session\'s status and wait revive and retry nothing; the owner\'s do', async (t) => {
  const f = await fixture(t);
  github(f);
  const run = await f.newRun('maintained', A);
  const sit = await f.start(run, 'sit', { flags: ['--read-only'], env: A });
  await f.finished(run, 'sit');
  // A task that failed on a transient error, which `wait` retries.
  await f.start(run, 'flaky', { flags: ['--read-only'], env: A, config: { status: 'failed', error: 'HTTP 503 provider unavailable' } });
  await f.finished(run, 'flaky');
  // Make `sit` a babysitter's attempt that ended parked, with no watcher (as after a reboot). Last,
  // since the owner's own `start` revives parked tasks.
  writeJson(path.join(sit.outDir, 'result.json'), { ...readJson(path.join(sit.outDir, 'result.json')), finalMessage: 'PARKED: waits for review' });
  writeJson(f.taskFile(run, 'sit'), { ...task(run, 'sit'), babysit: true, pr: { number: 42, url: 'https://github.com/example/repo/pull/42' } });
  const watchers = () => fs.readdirSync(sit.outDir).filter((n) => n.startsWith('park-watcher-'));
  const before = snapshot(run.dir);

  const status = await f.command(['status', run.id], { env: B });
  assert.doesNotMatch(status.stdout, /started a new one/);
  const waited = await f.command(['wait', run.id, '--timeout', '10s'], { env: B });
  assert.doesNotMatch(waited.stdout + waited.stderr, /retried/);
  assert.deepEqual(watchers(), []);
  assert.equal(task(run, 'flaky').attempt, 1);
  assert.deepEqual(snapshot(run.dir), before, 'another session\'s status or wait changed the run');

  assert.match((await f.command(['status', run.id], { env: A })).stdout, /sit: parked, and its watcher was not running; started a new one/);
  assert.equal(watchers().length, 1);
  const owner = await f.command(['wait', run.id, 'flaky', '--timeout', '20s'], { env: A });
  assert.match(owner.stdout + owner.stderr, /retried flaky after a transient error/);
  assert.equal(task(run, 'flaky').attempt, 2);
});

function post(url, token, body) {
  const { port, origin } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/send', method: 'POST', headers: { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json', 'x-orch-token': token } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (s) => { text += s; }).on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the user at a terminal and the dashboard may act on any run; each owner is told once', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent', A);
  await held(f, parent, 'lead', A);
  await held(f, parent, 'one', A);
  const { pid: dashShell } = await busy(f, parent, 'two', A);
  const { pid: userShell } = await busy(f, parent, 'three', A);
  await f.start(parent, 'done', { flags: ['--read-only'], env: A });
  await f.finished(parent, 'done');
  const nested = await f.newRun('nested', as(parent, 'lead'));
  await held(f, nested, 'kid', as(parent, 'lead'));

  // `result` closes a task only for its owner; for the user it only reads.
  await f.command(['result', parent.id, 'done']);
  assert.equal(task(parent, 'done').closedAt ?? null, null);
  await f.command(['result', parent.id, 'done'], { env: A });
  assert.ok(task(parent, 'done').closedAt);

  // The user (no session variables) closes the delegated agent's task, stops one of the session's,
  // and steers another.
  await f.command(['close', nested.id, 'kid']);
  assert.equal(task(nested, 'kid').closedBy, 'user (terminal)');
  // Closing a closed task again changes nothing: it keeps who closed it.
  await f.command(['close', nested.id, 'kid'], { env: as(parent, 'lead') });
  assert.equal(task(nested, 'kid').closedBy, 'user (terminal)');
  await f.command(['stop', parent.id, 'one']);
  assert.equal(task(parent, 'one').stoppedBy, 'user (terminal)');
  const steered = await f.json(['send', parent.id, 'three', 'Read this now.', '--steer']);
  assert.match(steered.steer.stopped, /sleep 61/);
  await eventually(() => !alive(userShell), 'the pending command was not stopped');
  assert.equal(inbox(parent, 'three').at(-1).steeredBy, 'user (terminal)');

  // An owning orch task gets an inbox message.
  const [message] = inbox(parent, 'lead').filter((m) => m.kind === 'owner-notice');
  assert.match(message.text, new RegExp(`Task kid of your run ${nested.id}: closed by the user: leave it closed`));
  assert.deepEqual(message.about, { run: nested.id, task: 'kid', attempt: 1 });
  // Each owner up the chain sees the change once, in its own status and wait: the lead's wait does
  // not use up the main session's.
  const leadWait = await f.command(['wait', nested.id, '--timeout', '30s'], { code: 5, env: as(parent, 'lead') });
  assert.match(leadWait.stdout, /kid: closed by the user: leave it closed/);
  assert.doesNotMatch((await f.command(['wait', nested.id, '--timeout', '30s'], { env: as(parent, 'lead') })).stdout, /closed by the user/);
  assert.deepEqual((await f.json(['status', nested.id], { env: A })).changedByOthers.map((n) => [n.task, n.action]), [['kid', 'closed']]);
  await f.command(['wait', nested.id, '--timeout', '30s'], { code: 5, env: A });
  assert.equal((await f.json(['status', nested.id], { env: A })).changedByOthers, undefined);
  assert.equal((await f.json(['status', nested.id], { env: as(parent, 'lead') })).changedByOthers, undefined);

  // The owning session sees the stop and the steer in status, and its wait wakes for them once.
  const status = await f.json(['status', parent.id], { env: A });
  assert.deepEqual(status.changedByOthers.map((n) => [n.task, n.action, n.by, n.text]), [
    ['one', 'stopped', 'user (terminal)', 'stopped by the user: leave it stopped'],
    ['three', 'steered', 'user (terminal)', 'steered by the user: its command was stopped so the user\'s message reached it at once; nothing to undo'],
  ]);
  const woke = await f.json(['wait', parent.id, 'lead', '--timeout', '30s'], { code: 5, env: A });
  assert.deepEqual(woke.attention.map((a) => [a.task, a.kind]), [['one', 'changed-by-other'], ['three', 'changed-by-other']]);
  await f.command(['wait', parent.id, 'lead', '--timeout', '1s'], { code: 3, env: A });

  // The dashboard steers another session's task: the user's click, and the owner is told.
  const dash = await f.dashboard();
  const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
  const sent = await post(dash.url, token, { run: parent.id, task: 'two', text: 'Read this now.', steer: true });
  assert.equal(sent.status, 200, sent.text);
  assert.match(JSON.parse(sent.text).steer.stopped, /sleep 61/);
  await eventually(() => !alive(dashShell), 'the dashboard did not stop the pending command');
  const fromDashboard = inbox(parent, 'two').at(-1);
  assert.deepEqual([fromDashboard.steeredBy, fromDashboard.from], ['user (dashboard)', 'user']);
  assert.deepEqual((await f.json(['status', parent.id], { env: A })).changedByOthers.map((n) => [n.task, n.action, n.by]), [['two', 'steered', 'user (dashboard)']]);
});
