import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// `rename RUN TASK --to NAME`: the task keeps its id as the key of everything it has, and views and
// commands use the name.

// A Claude Code or Codex session's shell, and the shell of the agent that `start` launched as task `id`.
const session = (id) => ({ CLAUDE_CODE_SESSION_ID: id, CODEX_THREAD_ID: id });
const A = session('session-a');
const B = session('session-b');
const as = (run, id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const record = (f, run, id) => readJson(f.taskFile(run, id));
const rowOf = async (f, run, id, env = {}) => (await f.json(['status', run.id], { env })).tasks.find((t) => t.id === id);
const lineOf = (text, name) => text.split('\n').find((l) => l.startsWith(`${name} `));

test('a renamed task shows its name in status, wait, result, recover and the dashboard, and keeps its id', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'impl', { flags: ['--read-only'] });
  await f.start(run, 'broke', { config: { status: 'failed', error: 'boom' }, flags: ['--read-only'] });
  await f.finished(run, 'impl');
  await f.finished(run, 'broke');

  const renamed = await f.command(['rename', run.id, 'impl', '--to', 'babysit-42']);
  assert.match(renamed.stdout, /renamed impl → babysit-42 \(task impl of run /);
  await f.command(['rename', run.id, 'broke', '--to', 'oops']);

  // status: the name in place of the id, in the rows and in the lines under them; --json keeps both.
  const status = await f.command(['status', run.id]);
  assert.ok(lineOf(status.stdout, 'babysit-42'), status.stdout);
  assert.ok(lineOf(status.stdout, 'oops'), status.stdout);
  assert.doesNotMatch(status.stdout, /^(impl|broke) /m);
  assert.match(status.stdout, /^ {2}babysit-42: 0 counted failures/m);
  const row = await rowOf(f, run, 'impl');
  assert.equal(row.name, 'babysit-42');
  assert.equal(row.outDir, path.join(run.dir, 'tasks', 'impl', 'attempt-1'), 'the id stays the key of its folder');

  // wait, by the name, names it by the name.
  const waited = await f.command(['wait', run.id, 'babysit-42', '--timeout', '0'], { code: 0 });
  assert.match(waited.stdout, /\(babysit-42 finished and nobody has read its result/);
  assert.doesNotMatch(waited.stdout, /\(impl finished/);

  // recover lists it by its name, and its next command takes the name.
  const recover = await f.command(['recover', run.id]);
  assert.match(recover.stdout, /failed \(1\): oops \(failed\)\n {4}next: node \S+ result \S+ oops;/);

  // The dashboard's state: each row keeps its id as its key and carries the name; the attention lane too.
  const board = await f.dashboard();
  const state = await eventually(async () => {
    const sections = await board.json('api/state');
    const rows = sections.flatMap((s) => s.tasks);
    return rows.some((r) => r.id === 'broke' && r.name === 'oops') ? sections : null;
  }, 'the dashboard does not show the names');
  const rows = state.flatMap((s) => s.tasks);
  assert.equal(rows.find((r) => r.id === 'impl').name, 'babysit-42');
  const lane = state.flatMap((s) => s.attention).find((a) => a.id === 'broke');
  assert.equal(lane?.name, 'oops', JSON.stringify(state.flatMap((s) => s.attention)));

  // result, by the name, shows the name, then the id.
  const result = await f.command(['result', run.id, 'babysit-42']);
  const [first, second] = result.stdout.split('\n');
  assert.match(first, /^task babysit-42 → claude \(read-only\), attempt 1: completed/);
  assert.equal(second, 'id: impl · name: babysit-42');
});

test('a named task is addressed by its name in send, result, stop and close, and an id wins over a name', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const worker = await f.start(run, 'worker', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(worker);
  await f.command(['rename', run.id, 'worker', '--to', 'builder']);

  // A running task: the rename restarts nothing.
  const running = record(f, run, 'worker');
  assert.deepEqual([running.attempt, running.pid], [1, worker.pid]);
  assert.equal((await rowOf(f, run, 'worker')).state, 'running');

  const sent = await f.json(['send', run.id, 'builder', 'Use the new name.']);
  assert.equal(sent.task, 'worker');
  const inbox = await f.json(['inbox', run.id, 'builder', '--all']);
  assert.equal(inbox.task, 'worker');
  assert.deepEqual(inbox.messages.map((m) => m.text), ['Use the new name.']);

  const stopped = await f.command(['stop', run.id, 'builder']);
  assert.match(stopped.stdout, /stopped worker/);
  const ended = await f.finished(run, 'worker');
  assert.notEqual(ended.state, 'running');
  assert.match((await f.command(['result', run.id, 'builder'])).stdout, /^task builder → /);
  const closed = await f.command(['close', run.id, 'builder']);
  assert.match(closed.stdout, /^builder: closed/m);
  assert.ok(record(f, run, 'worker').closedAt);
  // A closed task can be renamed too.
  await f.command(['rename', run.id, 'builder', '--to', 'retired']);
  assert.equal(record(f, run, 'worker').name, 'retired');

  // An id always wins over a name. `rename` refuses a name that is another task's id, so a task
  // whose id is a name arrives later, as one a plan dispatches; its record stands for one here.
  await f.start(run, 'alpha', { flags: ['--read-only'] });
  await f.finished(run, 'alpha');
  await f.command(['rename', run.id, 'alpha', '--to', 'omega']);
  writeJson(f.taskFile(run, 'omega'), { id: 'omega', createdAt: new Date().toISOString() });
  assert.equal((await f.json(['result', run.id, 'omega'])).id, 'omega');
  await f.command(['close', run.id, 'omega']);
  assert.ok(record(f, run, 'omega').closedAt);
  assert.equal(record(f, run, 'alpha').closedAt ?? null, null, 'the task named omega was left alone');
});

test('rename checks the name, records each one with when and who set it, and the task id removes it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'impl', { flags: ['--read-only'] });
  await f.start(run, 'other', { flags: ['--read-only'] });
  await f.finished(run, 'impl');
  await f.finished(run, 'other');
  await f.command(['rename', run.id, 'other', '--to', 'taken']);

  const refused = async (args, pattern) => {
    const r = await f.command(['rename', run.id, ...args], { code: 2 });
    assert.match(r.stderr, pattern, args.join(' '));
  };
  await refused(['impl'], /--to NAME is required/);
  await refused(['impl', '--to', 'Bad Name'], /must be a valid task id/);
  await refused(['impl', '--to', 'other'], /task other of run \S+ has that id; an id always wins/);
  await refused(['impl', '--to', 'taken'], /task other of run \S+ is already named taken/);
  // A planned task takes its plan id when it starts, which would then win over the name.
  const planFile = path.join(f.root, 'plan.json');
  writeJson(planFile, { goal: 'Fixture plan', acceptance: ['works'], tasks: [{ id: 'later', goal: 'Review', type: 'review', owns: [], uses: [], produces: [], resources: [], dependsOn: [], agent: 'claude', tier: 'light', why: 'Small review', readOnly: true, brief: 'briefs/later.md' }] });
  await f.command(['plan', run.id, planFile]);
  await refused(['impl', '--to', 'later'], /the plan of run \S+ has a task later/);
  assert.equal(record(f, run, 'impl').name, undefined, 'a refused rename changes nothing');

  // Each rename is recorded; the name addresses the task for the next one; the id removes it.
  await f.command(['rename', run.id, 'impl', '--to', 'first']);
  const same = await f.command(['rename', run.id, 'first', '--to', 'first']);
  assert.match(same.stdout, /already named first; nothing changed/);
  await f.command(['rename', run.id, 'first', '--to', 'second']);
  assert.equal(await f.command(['rename', run.id, 'first', '--to', 'third'], { code: 1 }).then((r) => r.stderr.includes('no task first')), true, 'an earlier name no longer names the task');
  const removed = await f.command(['rename', run.id, 'second', '--to', 'impl']);
  assert.match(removed.stdout, /removed the name second of task impl of run \S+; it shows as impl again/);
  const trace = record(f, run, 'impl').names;
  assert.deepEqual(trace.map((n) => n.name), ['first', 'second', null]);
  for (const n of trace) {
    assert.ok(Date.parse(n.at), JSON.stringify(n));
    assert.equal(n.by, 'user (terminal)');
  }
  assert.equal(record(f, run, 'impl').name, null);
  const status = await f.command(['status', run.id]);
  assert.ok(lineOf(status.stdout, 'impl'), status.stdout);
  const result = await f.command(['result', run.id, 'impl']);
  assert.match(result.stdout.split('\n')[1], /^id: impl · earlier names: first, second$/);
  assert.match((await f.command(['rename', run.id, 'impl', '--to', 'impl'])).stdout, /has no name; nothing changed/);
});

test('only the run\'s owner renames a task, and a task\'s own agent may rename itself', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('mine', A);
  await f.start(run, 'impl', { flags: ['--read-only'], env: A });
  await f.start(run, 'peer', { flags: ['--read-only'], env: A });
  await f.finished(run, 'impl');
  await f.finished(run, 'peer');

  const other = await f.command(['rename', run.id, 'impl', '--to', 'theirs'], { code: 4, env: B });
  assert.match(other.stderr, /refusing to rename task impl of run \S+: run \S+ belongs to (claude|codex) session session-a\b/);
  const sibling = await f.command(['rename', run.id, 'impl', '--to', 'theirs'], { code: 4, env: as(run, 'peer') });
  assert.match(sibling.stderr, /Nothing was changed/);
  assert.equal(record(f, run, 'impl').name, undefined);

  // Its own agent: allowed, recorded as set by that task, and nothing goes to the owner's notices.
  await f.command(['rename', run.id, 'impl', '--to', 'mine', '--json'], { env: as(run, 'impl') });
  const [named] = record(f, run, 'impl').names;
  assert.deepEqual([named.name, named.by], ['mine', { agent: 'delegated-agent', run: run.id, task: 'impl' }]);
  assert.equal(fs.existsSync(path.join(run.dir, 'owner-notices.jsonl')), false);
  // The owner renames it again, by its name.
  await f.command(['rename', run.id, 'mine', '--to', 'owned'], { env: A });
  assert.equal(record(f, run, 'impl').name, 'owned');
});

// The implementer of a pull request keeps it: its next attempt, in its own session, is the
// babysitter, and the rename shows it. The same task, row, attempts and tokens throughout.
const PARKED = [
  'PARKED: PR #42 waits for a human review',
  'Every check passed; nothing is unpushed.',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine

// A fake gh on PATH serving open pull request #42, as in park.test.mjs. Watchers check every second.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
  const list = (items) => ({ totalCount: items.length, nodes: items });
  const bodies = args.join(' ').includes('totalCount') ? { comments: list([]), reviews: list([]) } : {};
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}, ...bodies}}}}));
} else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

test('a finished implementer becomes its pull request\'s babysitter in its own session, on the same task', async (t) => {
  const f = await fixture(t);
  await github(f);
  // The briefs a watcher writes have no fake-relay comment: those attempts park again at once.
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ finalMessage: PARKED });
  const run = await f.newRun();
  await f.start(run, 'impl');
  const implemented = await f.finished(run, 'impl');
  assert.equal(implemented.mode, 'write');

  // --json goes before `--`: what follows is the relay's.
  const brief = f.brief('babysit-impl', { finalMessage: PARKED });
  const started = JSON.parse((await f.command(['start', run.id, 'impl', '--agent', 'claude', '--babysit', '--pr', '42',
    '--why', 'Keeps the pull request it implemented', '--brief', brief, '--json',
    '--', '--session', implemented.session])).stdout);
  assert.deepEqual([started.id, started.attempt, started.babysit, started.tier, started.pr.number], ['impl', 2, true, 'complex', 42]);
  const argsOf = (attempt) => eventually(() => {
    const file = path.join(attempt.outDir, 'invocation.json');
    return fs.existsSync(file) && readJson(file).argv;
  }, 'the relay did not record its arguments');
  const argv = await argsOf(started);
  assert.equal(argv[argv.indexOf('--session') + 1], implemented.session);
  assert.equal(argv[argv.indexOf('--timeout') + 1], '24h');
  // The babysitter brief is kept as the one a fresh session starts from after a handoff, though
  // this attempt continues the implementer's session.
  const kept = path.join(run.dir, 'tasks', 'impl', 'babysit-brief.md');
  assert.equal(fs.readFileSync(kept, 'utf8'), fs.readFileSync(brief, 'utf8'));
  await f.command(['rename', run.id, 'impl', '--to', 'babysit-42']);

  const parked = await eventually(async () => {
    const row = await rowOf(f, run, 'impl');
    return row?.phase === 'parked' && row.parked.watcher === 'alive' ? row : null;
  }, 'the babysitter did not park with a live watcher', SLOW);
  assert.deepEqual([parked.name, parked.mode, parked.attempt], ['babysit-42', 'babysit', 2]);
  assert.deepEqual(parked.attempts.map((a) => [a.n, a.session]), [[2, implemented.session], [1, implemented.session]]);
  assert.equal(parked.tokensIn, 2 * implemented.tokensIn, 'the tokens of both attempts add up on the one task');
  assert.match(lineOf((await f.command(['status', run.id])).stdout, 'babysit-42'), /\bparked\b.*parked · PR #42 waits for a human review/);

  // A message by its name wakes the parked watcher, which resumes the same session on the same task.
  await f.command(['send', run.id, 'babysit-42', 'A reviewer asked for a test.']);
  const resumed = await eventually(() => (record(f, run, 'impl').attempt === 3 ? record(f, run, 'impl') : null), 'the watcher did not resume it', SLOW);
  const resumedArgv = await argsOf(resumed);
  assert.equal(resumedArgv[resumedArgv.indexOf('--session') + 1], implemented.session);
  assert.deepEqual([resumed.name, resumed.babysit, resumed.tier], ['babysit-42', true, 'complex']);
  assert.equal(fs.readFileSync(kept, 'utf8'), fs.readFileSync(brief, 'utf8'), 'a resume of the babysitter keeps its brief');
  await f.command(['close', run.id, 'babysit-42']);
  assert.ok(record(f, run, 'impl').closedAt);
});

// The Stop hook, run as Claude Code runs it (stop-hook.test.mjs): the Stop event on stdin.
test('the Stop hook names a renamed task, and its commands, by the name', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const SESSION = '7d1e9c40-2b6a-4f1e-8c3d-9a0b1c2d3e4f';
  const owner = f.launchingSession(run, SESSION);
  await f.start(run, 'work');
  await f.finished(run, 'work');
  await f.command(['rename', run.id, 'work', '--to', 'named'], { env: owner });
  const hook = new URL('../scripts/hooks/orch-stop.mjs', import.meta.url).pathname;
  const out = spawnSync(process.execPath, [hook], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 15_000,
    input: JSON.stringify({ session_id: SESSION, stop_hook_active: false, transcript_path: '/dev/null', cwd: '/' }) });
  assert.equal(out.status, 0, out.stderr);
  const { reason } = JSON.parse(out.stdout);
  assert.ok(reason.includes(`${run.id}/named finished`), reason);
  assert.match(reason, new RegExp(`result ${run.id} named\\b`));
  assert.ok(!reason.includes(`${run.id}/work`), reason);
});

// The page shows a task's name in place of its id, and its id and earlier names in its details. The
// details panel is painted by the page's own detail() and paint(), with the browser stubbed as in
// regression-dashboard.test.mjs.
test('the dashboard page shows a name in place of the id, and its id and earlier names in the details', async () => {
  const app = fs.readFileSync(new URL('../scripts/dashboard/app.js', import.meta.url), 'utf8');
  const snippet = (from, until) => {
    const start = app.indexOf(from), end = app.indexOf(until, start);
    assert.ok(start >= 0 && end > start, `dashboard script must contain ${from}`);
    return app.slice(start, end);
  };
  const panel = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, dataset: {}, replaceChildren(...children) { this.children = children; } };
  const context = vm.createContext({
    sel: null, state: [], lastDetail: '', holding: () => false,
    document: { getElementById: () => panel },
    fetch: async () => ({ json: async () => ({ events: [] }) }),
    $: (tag, attrs, ...children) => ({ tag, attrs, children }), fmt: String, cls: String, startedIn: () => null, reportView: () => [], closeDetail() {},
  });
  vm.runInContext(snippet('const atBottom=', 'async function limits()'), context);
  const names = [{ name: 'first' }, { name: null }, { name: 'babysit-42' }, { name: 'first' }];
  context.sel = 'section/task';
  context.state = [{ id: 'section', tasks: [{ key: 'task', id: 'impl', name: 'babysit-42', names, agent: 'claude', state: 'running', run: 'a-run' }] }];
  await context.detail();
  const text = JSON.stringify(panel.children);
  assert.ok(text.includes('"babysit-42 · claude · "'), 'the heading shows the name');
  assert.ok(text.includes('"children":["id"]},{"tag":"dd","attrs":{},"children":["impl"]'), 'the id is listed');
  assert.ok(text.includes('"children":["earlier names"]},{"tag":"dd","attrs":{},"children":["first"]'), 'the earlier names are listed, once each');
  // An unnamed task shows its id, and no id or earlier-names line.
  context.state = [{ id: 'section', tasks: [{ key: 'task', id: 'impl', agent: 'claude', state: 'running', run: 'a-run' }] }];
  context.lastDetail = '';
  await context.detail();
  const plain = JSON.stringify(panel.children);
  assert.ok(plain.includes('"impl · claude · "'));
  assert.ok(!plain.includes('earlier names') && !plain.includes('"children":["id"]'));
  // The rows, the attention lane, the reply and the message box name a task the same way.
  for (const use of ['"main session"):t.name?$("span",{title:"task "+t.id},t.name):t.id', '$("b",a.name?{title:"task "+a.id}:{},a.name||a.id)', '(t.name||t.id)+" replied', '"Message "+(t.name||t.id)']) {
    assert.ok(app.includes(use), `app.js: ${use}`);
  }
});
