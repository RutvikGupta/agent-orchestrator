import { foldCommandAgents } from '../scripts/lib/dashboard-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventually, fixture, jsonl, writeJson } from './helpers.mjs';
import { claudeTranscripts } from './fixtures/transcripts.mjs';

// Agents that a command started outside the orchestrator, found by the dashboard in the process
// table. The board lists only Codex and Claude Opus agents that a skill's script (one under the
// skill folders) started from a session. One started from a task's shell is that task's own
// work, so the task's row stands for it.
//
// The fake processes below run FAKE with an argv0 that `ps` shows: `claude -p …` for a headless
// Claude Code agent, `codex exec …` for a Codex one (the fake is a file named `exec`, so `exec` is
// the command's first argument), and `claude -e …` for an interactive session above them. The
// agents run under such a session (or a stub relay), so the nearest-agent and launcher lookups
// never reach the processes that run the suite. A fake writes <fakes>/<name>.pid once its
// session file is written and its rollout is open, and exits when <fakes>/<name>.stop or
// <fakes>/all.stop appears, when its parent exits, or when the fixture's folder is removed.
const FAKE = `const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const env = process.env;
const own = (ext) => path.join(env.FAKE_DIR, env.FAKE_NAME + '.' + ext);
if (env.FAKE_SESSION) {
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'sessions', process.pid + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: env.FAKE_SESSION, cwd: env.FAKE_CWD,
    startedAt: Number(env.FAKE_STARTED_AT) || Date.now(), kind: 'headless', entrypoint: env.FAKE_ENTRYPOINT || 'sdk-cli' }));
}
if (env.FAKE_ROLLOUT) fs.openSync(env.FAKE_ROLLOUT, 'a');
for (const c of JSON.parse(env.FAKE_CHILDREN || '[]')) {
  spawn(c.bin || process.execPath, c.args, { argv0: c.argv0, cwd: c.cwd, env: c.env, stdio: 'ignore' });
}
fs.writeFileSync(own('tmp'), String(process.pid));
fs.renameSync(own('tmp'), own('pid'));
const parent = process.ppid;
const done = () => process.ppid !== parent || !fs.existsSync(env.FAKE_DIR)
  || fs.existsSync(path.join(env.FAKE_DIR, 'all.stop')) || fs.existsSync(own('stop'));
setInterval(() => { if (done()) process.exit(0); }, 50);
setTimeout(() => process.exit(0), 300000);
`;
const LOAD = 'require(process.env.FAKE_AGENT)'; // no spaces: `ps` output is split on whitespace

const running = (child) => child.exitCode === null && child.signalCode === null;
function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

async function setup(t) {
  const children = [];
  let dir = null;
  // Registered before the fixture's cleanup, so the fakes stop before it closes runs and removes
  // its folder (which would also stop them).
  t.after(async () => {
    if (!dir) return;
    let pids = [];
    try {
      fs.writeFileSync(path.join(dir, 'all.stop'), '');
      pids = fs.readdirSync(dir).filter((n) => n.endsWith('.pid')).map((n) => Number(fs.readFileSync(path.join(dir, n), 'utf8')));
    } catch {}
    for (const child of children) if (running(child)) child.kill();
    await eventually(() => !children.some(running) && !pids.some(alive), 'fake agents did not exit', 10_000);
  });
  const f = await fixture(t);
  dir = path.join(f.root, 'fakes');
  const bin = path.join(f.root, 'fake-bin');
  const agent = path.join(bin, 'exec');
  fs.mkdirSync(dir);
  fs.mkdirSync(bin);
  fs.writeFileSync(agent, FAKE);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  const spec = (argv0, args, name, extra = {}, kids = []) => ({
    argv0, args, cwd: bin,
    env: Object.fromEntries(Object.entries({
      ...f.env, FAKE_AGENT: agent, FAKE_DIR: dir, FAKE_NAME: name, FAKE_CHILDREN: kids.length ? JSON.stringify(kids) : undefined, ...extra,
    }).filter(([, value]) => value !== undefined)),
  });
  // `child` run by bash in a subshell, as a shell runs a command: bash keeps running as its parent.
  const subshell = (child) => `(exec -a ${child.argv0} "$FAKE_NODE" ${child.args.map(quote).join(' ')}) &\nwait\n`;
  const fakes = {
    // A headless Claude Code agent whose session file (<CLAUDE_CONFIG_DIR>/sessions/<pid>.json) names `session`.
    claude: (name, session, { env = {}, startedAt, entrypoint, children: kids = [] } = {}) => spec('claude', ['-p', LOAD], name, {
      FAKE_SESSION: session, FAKE_CWD: f.repo, FAKE_STARTED_AT: startedAt && String(startedAt), FAKE_ENTRYPOINT: entrypoint, ...env,
    }, kids),
    // `codex exec <sub> …`, holding `rollout` open as Codex does while it runs.
    codex: (name, rollout, { sub = 'review', env = {} } = {}) => spec('codex', ['exec', sub, 'fixture-prompt'], name, { FAKE_ROLLOUT: rollout, ...env }),
    // An interactive session whose shell started `kids`.
    session: (name, kind, kids) => spec(kind, ['-e', LOAD], name, {}, kids),
    // A Node script, such as a stub relay, that starts `kids`.
    node: (name, script, kids) => spec(undefined, [script], name, {}, kids),
    // A bash script <root>/<file> that starts `child`. The fixture's HOME is <root>/home, so a
    // script under home/.agents/ counts as a skill's. Its name is the agent's row id.
    script(file, child) {
      const target = path.join(f.root, file);
      const text = subshell(child);
      assert.ok(!fs.existsSync(target) || fs.readFileSync(target, 'utf8') === text, `${file} already starts another command`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      return { bin: 'bash', args: [target], cwd: bin, env: { ...child.env, FAKE_NODE: process.execPath } };
    },
    // `child` run through `bash -c`, as an agent's shell tool runs a command.
    shell: (child) => ({ bin: 'bash', args: ['-c', subshell(child)], cwd: bin, env: { ...child.env, FAKE_NODE: process.execPath } }),
    start(top) {
      const child = spawn(top.bin || process.execPath, top.args, { argv0: top.argv0, cwd: top.cwd, env: top.env, stdio: 'ignore' });
      child.on('error', () => {});
      children.push(child);
      return child;
    },
    async ready(...names) {
      return eventually(() => {
        const pids = {};
        for (const name of names) {
          const file = path.join(dir, `${name}.pid`);
          if (!fs.existsSync(file)) return null;
          pids[name] = Number(fs.readFileSync(file, 'utf8'));
        }
        return pids;
      }, `fake agents did not start: ${names.join(', ')}`, 15_000);
    },
    async stop(...names) {
      const pids = await fakes.ready(...names);
      for (const name of names) fs.writeFileSync(path.join(dir, `${name}.stop`), '');
      await eventually(() => !Object.values(pids).some(alive), `fake agents did not stop: ${names.join(', ')}`, 10_000);
    },
  };
  return { f, fakes };
}

// A Claude Code transcript: one prompt and its reply, finished or stopped in the middle of a tool call.
function claudeEvents(f, text, done = true, model = 'claude-opus-5-5') {
  const timestamp = new Date().toISOString();
  return [
    { type: 'user', timestamp, cwd: f.repo, message: { role: 'user', content: 'Review the change.' } },
    { type: 'assistant', timestamp, message: {
      id: `reply-${text}`, model, stop_reason: done ? 'end_turn' : 'tool_use',
      content: done ? [{ type: 'text', text }] : [{ type: 'tool_use', id: `read-${text}`, name: 'Read', input: { file_path: 'README.md' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    } },
  ];
}
const projectDir = (f) => path.join(f.claude, 'projects', 'fixture-project');
const transcript = (f, session, done = true, model = undefined) => jsonl(path.join(projectDir(f), `${session}.jsonl`), claudeEvents(f, `${session} reply`, done, model));
// A sub-agent transcript <dir>/agent-<agentId>.jsonl, with its .meta.json.
function agentTranscript(f, dir, agentId, description) {
  const file = jsonl(path.join(dir, `agent-${agentId}.jsonl`), claudeEvents(f, `${agentId} reply`));
  writeJson(file.replace(/\.jsonl$/, '.meta.json'), { agentType: 'general-purpose', description });
}
// A run launched by Claude Code session `session`, which has a transcript: an outside agent whose
// shell names that session goes under the section's main row.
async function launchedRun(f, session = 'launching-session') {
  const run = await f.newRun();
  f.launchingSession(run, session);
  claudeTranscripts(f, session);
  return run;
}
const SKILL = 'home/.agents/code-review'; // a skill folder under the fixture's HOME

// Random ids, so that no two runs of this suite share a Codex session.
const codexId = () => randomUUID();
const rolloutEvent = (payload) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload });
const tokenCount = (input, cached, output) => rolloutEvent({ type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });
const commandRun = (command) => rolloutEvent({ type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', command] } });
// A Codex rollout whose first line is its session_meta (by default `codex exec`'s), with a
// turn_context naming `model` unless it is null, then `events`.
function rollout(f, id, meta = {}, { model = 'gpt-6.1-sol', events = [] } = {}) {
  const timestamp = new Date().toISOString();
  return jsonl(path.join(f.codex, 'sessions', ...timestamp.slice(0, 10).split('-'), `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`), [
    { type: 'session_meta', timestamp, payload: { id, timestamp, cwd: f.repo, originator: 'codex_exec', source: 'exec', ...meta } },
    ...(model ? [{ type: 'turn_context', timestamp, payload: { turn_id: id, cwd: f.repo, model, effort: 'medium' } }] : []),
    rolloutEvent({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_text', text: 'Review the change.' }] } }),
    ...events,
  ]);
}

function records(f) {
  try {
    return fs.readFileSync(path.join(f.state, 'external.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const boardRows = (state) => state.flatMap((section) => section.tasks.map((row) => ({ ...row, section: section.id })));
// The board row of the outside agent whose own session is `session`, once `check` holds for it.
// The dashboard scans the process table at most every 2 seconds.
async function outside(board, session, check = () => true) {
  return eventually(async () => {
    const rows = boardRows(await board.json('/api/state'));
    const row = rows.find((r) => r.external && r.session === session);
    return row && check(row) ? { row, rows } : null;
  }, `outside agent ${session} did not reach the board`, 15_000);
}
// Every board row, once the outside agents of all `sessions` are on the board together.
async function listed(board, sessions) {
  return eventually(async () => {
    const rows = boardRows(await board.json('/api/state'));
    return sessions.every((session) => rows.some((r) => r.external && r.session === session)) && rows;
  }, `outside agents did not reach the board: ${sessions.join(', ')}`, 15_000);
}
// Every board row, once the dashboard has recorded the agents with these record keys.
async function recorded(board, f, keys) {
  return eventually(async () => {
    const state = await board.json('/api/state'); // each build may scan the process table
    const known = records(f).map((r) => r.key);
    return keys.every((key) => known.includes(key)) && boardRows(state);
  }, `outside agents were not recorded: ${keys.join(', ')}`, 15_000);
}

test('headlessKind tells headless Claude Code and codex exec processes from interactive ones', async () => {
  const { headlessKind } = await import('../scripts/lib/external.mjs');
  for (const [command, kind] of [
    ['claude -p x', 'claude'],
    ['claude --print summarize', 'claude'],
    ['claude --resume abc', null],
    ['/opt/x/codex exec review --base main', 'codex'],
    ['node /opt/homebrew/bin/codex exec --json', 'codex'],
    ['codex-aarch64-apple-darwin exec review', 'codex'],
    ['codex -c a=1 -c b=2 -c c=3 -c d=4 exec review', 'codex'],
    ['codex app-server --listen x', null],
    ['codex mcp-server exec', null],
    ['codex please exec this', null],
    ['/x/codex-code-mode-host', null],
  ]) assert.equal(headlessKind(command), kind, command);
});

test('an agent that a skill\'s script runs from a task\'s shell is a row under that task, not a row of its session', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const task = await f.start(run, 'reviewer', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  transcript(f, 'task-shell-agent');
  const id = codexId();
  // The task agent's shell: the task's variables, and its own session.
  const env = { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'reviewer', CLAUDE_CODE_SESSION_ID: 'fixture-claude' };
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.script(`${SKILL}/claude_review.sh`, fakes.claude('claude', 'task-shell-agent', { env })),
    fakes.script(`${SKILL}/codex_review.sh`, fakes.codex('codex', rollout(f, id), { env })),
  ]));
  await fakes.ready('claude', 'codex');
  const board = await f.dashboard();

  await recorded(board, f, ['claude:task-shell-agent', `codex:${id}`]);
  const { state, row: reviewer, agents } = await withAgents(board, run, 'reviewer', 2);
  assert.equal(reviewer.session, 'fixture-claude');
  assert.equal(reviewer.state, 'running');
  assert.deepEqual(agents.map((r) => r.session).sort(), ['task-shell-agent', id].sort());
  assert.deepEqual(agents.map((r) => [r.kind, r.parentKey, r.section]).sort(), [['claude -p', reviewer.key, sectionOfRun(state, run).id], ['codex exec', reviewer.key, sectionOfRun(state, run).id]]);
  assert.ok(boardRows(state).every((r) => !r.external || r.taskAgent), 'none of them is a row of a session');
  f.release(task);
  await f.finished(run, 'reviewer');
});

// Defect: the agent showed twice, as a row under its task and as the main row of a section of its session,
// whose Agent-tool sub-agents were in that section instead of under the agent's row.
test('an agent a task\'s shell started shows once, as its row under the task, with its Agent-tool sub-agents one level deeper', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const task = await f.start(run, 'reviewer', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  // The agent's own session: its transcript, and one sub-agent that its Agent tool started.
  transcript(f, 'task-shell-session');
  agentTranscript(f, path.join(projectDir(f), 'task-shell-session', 'subagents'), 'helper', 'helper');
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.claude('agent', 'task-shell-session', { env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'reviewer' } }),
  ]));
  await fakes.ready('agent');
  const board = await f.dashboard();

  const { state, row, agents: [agent] } = await eventually(async () => {
    const found = await withAgents(board, run, 'reviewer');
    const helper = boardRows(found.state).find((r) => r.id === 'helper');
    return helper && found;
  }, 'the agent and its sub-agent did not reach the board', 20_000);
  assert.equal(agent.session, 'task-shell-session');
  assert.equal(agent.parentKey, row.key);
  const helper = boardRows(state).find((r) => r.id === 'helper');
  assert.deepEqual([helper.mode, helper.native, helper.parentKey, helper.depth, helper.run, helper.parent], ['native', true, agent.key, agent.depth + 1, run.id, agent.id]);
  assert.equal(agent.kids, 1);
  // Nothing else shows the agent: no section of its own, and no second row.
  assert.ok(!state.some((s) => s.id === 'claude-task-shell-session'), `its session got a section: ${JSON.stringify(state.map((s) => s.id))}`);
  assert.deepEqual(boardRows(state).filter((r) => r.session === 'task-shell-session').map((r) => r.id), [agent.id], 'one row for the agent');
  assert.ok(!boardRows(state).some((r) => r.main), 'no main row of its session');
  f.release(task);
  await f.finished(run, 'reviewer');
});

// Defect: the agent's session was a run's orchestrator session, so the board took it for shown and dropped its
// row from the task.
test('a run that a task\'s shell agent launched hangs under that agent\'s row, which stays under its task', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await launchedRun(f); // the task's run has a launching session, as a nested run's root does
  const task = await f.start(run, 'reviewer', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  // The agent's session launched a run of its own, and its Agent tool started a sub-agent.
  transcript(f, 'launcher-agent', false);
  agentTranscript(f, path.join(projectDir(f), 'launcher-agent', 'subagents'), 'helper', 'helper');
  const launched = await f.newRun('launched');
  f.launchingSession(launched, 'launcher-agent');
  const nested = await f.start(launched, 'nested-work', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(nested);
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.script(`${SKILL}/launch_review.sh`, fakes.claude('agent', 'launcher-agent', { env: innerEnv(run, 'reviewer') })),
  ]));
  await fakes.ready('agent');
  const board = await f.dashboard();

  const found = await eventually(async () => {
    const state = await board.json('/api/state');
    const reviewer = rowOf(state, run, 'reviewer');
    const agent = reviewer && agentsOf(state, reviewer)[0];
    const work = rowOf(state, launched, 'nested-work');
    return agent && work?.parentKey === agent.key && state.length === 1 && { state, reviewer, agent, work };
  }, 'the agent\'s row and the run it launched did not reach one section', 20_000);
  const { state, reviewer, agent, work } = found;
  const main = boardRows(state).find((r) => r.main);
  assert.equal(reviewer.parentKey, main.key);
  assert.equal(agent.parentKey, reviewer.key, 'the agent keeps its row under its task');
  assert.equal(agent.session, 'launcher-agent');
  assert.equal(work.parentKey, agent.key, 'the run it launched nests under the agent\'s row');
  assert.equal(work.depth, agent.depth + 1);
  assert.equal(agent.kids, 2, 'the launched run\'s task and the agent\'s sub-agent');
  const helper = boardRows(state).find((r) => r.id === 'helper');
  assert.deepEqual([helper.parentKey, helper.depth, helper.run], [agent.key, agent.depth + 1, run.id], 'its sub-agent is shown once, under it');
  assert.equal(boardRows(state).filter((r) => r.id === 'helper').length, 1);
  // One section: the launched run is in the task's own, with no section or main row for the agent's session.
  assert.deepEqual(state.map((s) => s.id), [sectionOfRun(state, run).id]);
  assert.ok(sectionOfRun(state, launched) === sectionOfRun(state, run));
  assert.deepEqual(Object.fromEntries(sectionOfRun(state, run).runs.map((r) => [r.id, r.parent])), { [launched.id]: { run: run.id, task: 'reviewer' }, [run.id]: null });
  assert.deepEqual(boardRows(state).filter((r) => r.main).map((r) => r.session), ['launching-session'], 'the only main row is the task\'s run\'s own');
  assert.deepEqual(boardRows(state).filter((r) => r.session === 'launcher-agent').map((r) => r.id), [agent.id]);
  f.release(task);
  f.release(nested);
  await f.finished(run, 'reviewer');
  await f.finished(launched, 'nested-work');
});

test('a headless Claude agent that a skill\'s script runs from a session\'s shell shows under that session, and stays after it exits', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await launchedRun(f);
  transcript(f, 'headless-one');
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/claude_review.sh`, fakes.claude('agent', 'headless-one', { env: { CLAUDE_CODE_SESSION_ID: 'launching-session' } })),
  ]));
  const { agent: pid } = await fakes.ready('agent');
  const board = await f.dashboard();

  const { row, rows } = await outside(board, 'headless-one');
  const main = rows.find((r) => r.section === 'claude-launching-session' && r.main);
  assert.ok(main);
  assert.equal(row.section, 'claude-launching-session');
  assert.equal(row.run, run.id);
  assert.equal(row.parentKey, main.key);
  assert.equal(row.id, 'claude-review');
  assert.equal(row.agent, 'claude');
  assert.equal(row.external, true);
  assert.equal(row.native, true);
  assert.equal(row.mode, 'external');
  assert.equal(row.state, 'running');

  const record = records(f).find((r) => r.key === 'claude:headless-one');
  assert.ok(record, JSON.stringify(records(f)));
  assert.equal(record.agent, 'claude');
  assert.equal(record.pid, pid);
  assert.match(record.launcher, /^bash \S*\/home\/\.agents\/code-review\/claude_review\.sh$/);
  assert.deepEqual(record.parent, { run: null, task: null, claude: 'launching-session', codex: null, nearest: 'claude' });

  await fakes.stop('agent');
  const { row: done } = await outside(board, 'headless-one', (r) => r.state !== 'running');
  assert.equal(done.state, 'completed');
  assert.equal(done.parentKey, main.key);
});

test('a Codex agent that a skill\'s codex_review.sh runs from a session\'s shell shows under that session\'s main row', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await launchedRun(f);
  const id = codexId();
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/codex_review.sh`, fakes.codex('review', rollout(f, id), { env: { CLAUDE_CODE_SESSION_ID: 'launching-session' } })),
  ]));
  await fakes.ready('review');
  const board = await f.dashboard();

  const { row, rows } = await outside(board, id);
  assert.equal(row.section, 'claude-launching-session');
  assert.equal(row.run, run.id);
  assert.equal(row.id, 'codex-review');
  assert.equal(row.agent, 'codex');
  assert.equal(row.state, 'running');
  assert.equal(row.parentKey, rows.find((r) => r.section === row.section && r.main).key);
  const record = records(f).find((r) => r.key === `codex:${id}`);
  assert.match(record.launcher, /^bash \S*\/home\/\.agents\/code-review\/codex_review\.sh$/);
  assert.equal(record.parent.claude, 'launching-session');
});

test('a Codex agent\'s row adds its sub-threads\' tokens and steps, and takes their model when it has none', async (t) => {
  const { f, fakes } = await setup(t);
  await launchedRun(f);
  const id = codexId();
  // `codex exec review` names no model of its own here and does most of its work in sub-threads.
  const own = rollout(f, id, {}, { model: null, events: [tokenCount(100, 0, 50), commandRun('git diff')] });
  const sub = { parent_thread_id: id, thread_source: 'subagent' };
  const subs = [codexId(), codexId()];
  rollout(f, subs[0], sub, { events: [tokenCount(1000, 200, 300), commandRun('rg TODO'), commandRun('git log -1')] });
  rollout(f, subs[1], sub, { events: [tokenCount(500, 0, 100), commandRun('ls')] });
  // Another thread's sub-thread does not count.
  rollout(f, codexId(), { parent_thread_id: codexId(), thread_source: 'subagent' }, { model: 'gpt-other', events: [tokenCount(7000, 0, 7000), commandRun('ls')] });
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/codex_review.sh`, fakes.codex('review', own, { env: { CLAUDE_CODE_SESSION_ID: 'launching-session' } })),
  ]));
  await fakes.ready('review');
  const board = await f.dashboard();

  const { row, rows } = await outside(board, id);
  assert.deepEqual({ in: row.tokensIn, cached: row.tokensCached, out: row.tokensOut, steps: row.steps }, { in: 1600, cached: 200, out: 450, steps: 4 });
  assert.equal(row.model, 'gpt-6.1-sol');
  assert.ok(!rows.some((r) => subs.includes(r.session)), 'sub-threads get no rows');
});

test('the orchestrator\'s own agents, interactive sessions and a wrapper\'s child are not listed', async (t) => {
  const { f, fakes } = await setup(t);
  const interactive = codexId();
  const resumed = codexId();
  const cli = { originator: 'codex_cli_rs', source: 'cli' };
  // Each runs under a skill folder, so the board would list it: only detection leaves it out.
  for (const session of ['relay-agent', 'cli-agent', 'wrapper-agent', 'wrapper-child']) transcript(f, session);
  const relay = path.join(f.root, 'home', '.agents', 'skills', 'fixture-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(process.env.FAKE_AGENT);\n");
  fakes.start(fakes.node('relay', relay, [fakes.claude('relay-child', 'relay-agent')]));
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/interactive_review.sh`, fakes.codex('interactive', rollout(f, interactive, cli))),
    fakes.script(`${SKILL}/cli_review.sh`, fakes.claude('cli', 'cli-agent', { entrypoint: 'cli' })),
    fakes.script(`${SKILL}/wrapper_review.sh`, fakes.claude('wrapper', 'wrapper-agent', { children: [fakes.claude('wrapped', 'wrapper-child')] })),
    // `codex exec resume` keeps the first header of a session that began interactive.
    fakes.script(`${SKILL}/resume_review.sh`, fakes.codex('resumed', rollout(f, resumed, cli), { sub: 'resume' })),
  ]));
  const pids = await fakes.ready('relay-child', 'interactive', 'cli', 'wrapper', 'wrapped', 'resumed');
  const board = await f.dashboard();

  // Every fake was ready before the dashboard's first scan, so once the listed ones show, that
  // scan has also judged the others.
  const rows = await listed(board, [resumed, 'wrapper-agent']);
  const external = rows.filter((r) => r.external);
  assert.equal(external.find((r) => r.session === resumed).id, 'resume-review');
  assert.deepEqual(external.filter((r) => r.session === 'wrapper-agent').map((r) => r.id), ['wrapper-review']);
  assert.equal(records(f).find((r) => r.key === 'claude:wrapper-agent').pid, pids.wrapper);
  const keys = records(f).map((r) => r.key);
  for (const [session, key, why] of [
    [interactive, `codex:${interactive}`, 'an interactive Codex rollout'],
    ['relay-agent', 'claude:relay-agent', 'a relay\'s agent'],
    ['cli-agent', 'claude:cli-agent', 'a Claude session whose entrypoint is cli'],
    ['wrapper-child', 'claude:wrapper-child', 'a headless process\'s child of the same kind'],
  ]) {
    assert.ok(!keys.includes(key), `${why} must not be recorded: ${JSON.stringify(keys)}`);
    assert.ok(!external.some((r) => r.session === session), `${why} must not be listed`);
  }
});

test('an agent is listed only if a skill\'s script started it, in the shared section when its session is unknown', async (t) => {
  const { f, fakes } = await setup(t);
  // [session, script that starts it]: the first is outside every skill folder.
  const agents = [
    ['tool-agent', 'tools/review.sh'],
    ['agents-agent', `${SKILL}/review.sh`],
    ['claude-home-agent', 'home/.claude/scripts/review.sh'],
    ['project-skill-agent', 'project/.claude/skills/reviewer/review.sh'],
  ];
  for (const [session] of agents) transcript(f, session);
  transcript(f, 'orphan-agent');
  const now = Date.now();
  fakes.start(fakes.session('shell', 'claude', [
    ...agents.map(([session, script], i) => fakes.script(script, fakes.claude(session, session, { startedAt: now - 10_000 + i * 1000 }))),
    // Its session variable names a session whose transcript does not exist.
    fakes.script(`${SKILL}/review.sh`, fakes.claude('orphan-agent', 'orphan-agent', {
      startedAt: now, env: { CLAUDE_CODE_SESSION_ID: 'session-without-transcript' },
    })),
  ]));
  await fakes.ready(...agents.map(([session]) => session), 'orphan-agent');
  const board = await f.dashboard();

  // Every fake was ready before the dashboard's first scan, so once the listed ones show, that
  // scan has also found the other one.
  const shown = ['agents-agent', 'claude-home-agent', 'project-skill-agent', 'orphan-agent'];
  const rows = await listed(board, shown);
  const ours = shown.map((session) => rows.find((r) => r.external && r.session === session));
  for (const row of ours) {
    assert.equal(row.section, 'external', row.session);
    assert.equal(row.run, 'external', row.session);
    assert.equal(row.parentKey, null, row.session);
  }
  assert.deepEqual(ours.map((r) => r.id), ['review', 'review-2', 'review-3', 'review-4']);
  assert.ok(!rows.some((r) => r.section === 'external' && r.main));
  assert.ok(!rows.some((r) => r.section === 'claude-session-without-transcript'));
  const tool = records(f).find((r) => r.key === 'claude:tool-agent');
  assert.match(tool?.launcher ?? '', /\/tools\/review\.sh$/, 'it was found, with its script');
  assert.ok(!rows.some((r) => r.external && r.session === 'tool-agent'), 'a script outside the skill folders is not a skill\'s');
});

test('two outside agents with the same name under one session get distinct ids, and one cut off mid-turn is stopped', async (t) => {
  const { f, fakes } = await setup(t);
  await launchedRun(f);
  transcript(f, 'twin-one', true);
  transcript(f, 'twin-two', false);
  const env = { CLAUDE_CODE_SESSION_ID: 'launching-session' };
  const now = Date.now();
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/claude_review.sh`, fakes.claude('one', 'twin-one', { env, startedAt: now - 2000 })),
    fakes.script(`${SKILL}/claude_review.sh`, fakes.claude('two', 'twin-two', { env, startedAt: now - 1000 })),
  ]));
  await fakes.ready('one', 'two');
  const board = await f.dashboard();

  const rows = await listed(board, ['twin-one', 'twin-two']);
  const [one, two] = ['twin-one', 'twin-two'].map((session) => rows.find((r) => r.external && r.session === session));
  const main = rows.find((r) => r.section === 'claude-launching-session' && r.main);
  assert.deepEqual([one.id, two.id], ['claude-review', 'claude-review-2']);
  assert.notEqual(one.key, two.key);
  assert.equal(one.parentKey, main.key);
  assert.equal(two.parentKey, main.key);

  await fakes.stop('one', 'two');
  const { row: finished } = await outside(board, 'twin-one', (r) => r.state !== 'running');
  const { row: cut } = await outside(board, 'twin-two', (r) => r.state !== 'running');
  assert.equal(finished.state, 'completed');
  assert.equal(cut.state, 'stopped');
  assert.match(cut.now, /^stopped without finishing/);
});

test('a headless Claude agent is listed only if its model is Opus or not known yet', async (t) => {
  const { f, fakes } = await setup(t);
  await launchedRun(f);
  transcript(f, 'opus-agent', true, 'claude-opus-5-5');
  transcript(f, 'sonnet-agent', true, 'claude-sonnet-5-5');
  // new-agent has written no transcript yet.
  const env = { CLAUDE_CODE_SESSION_ID: 'launching-session' };
  fakes.start(fakes.session('shell', 'claude', ['opus', 'sonnet', 'new'].map((name) => fakes.script(`${SKILL}/claude_review.sh`, fakes.claude(name, `${name}-agent`, { env })))));
  await fakes.ready('opus', 'sonnet', 'new');
  const board = await f.dashboard();

  // Every fake was ready before the dashboard's first scan, so once the listed ones show, that
  // scan has also found the other one.
  const rows = await listed(board, ['opus-agent', 'new-agent']);
  const main = rows.find((r) => r.section === 'claude-launching-session' && r.main);
  const opus = rows.find((r) => r.external && r.session === 'opus-agent');
  const fresh = rows.find((r) => r.external && r.session === 'new-agent');
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.equal(fresh.model, null);
  for (const row of [opus, fresh]) assert.equal(row.parentKey, main.key, row.session);
  assert.ok(records(f).some((r) => r.key === 'claude:sonnet-agent'), 'it was found');
  assert.ok(!rows.some((r) => r.external && r.session === 'sonnet-agent'), 'a Sonnet agent is not listed');
});

test('an outside agent run from another outside agent\'s shell shows under that agent', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await launchedRun(f);
  transcript(f, 'outer-agent');
  transcript(f, 'inner-agent');
  // The session's shell runs a skill's script, whose agent runs another skill's script from its
  // own shell; each shell names the session that owns it.
  fakes.start(fakes.session('shell', 'claude', [
    fakes.script(`${SKILL}/outer_review.sh`, fakes.claude('outer', 'outer-agent', {
      env: { CLAUDE_CODE_SESSION_ID: 'launching-session' }, startedAt: Date.now() - 60_000, children: [
        fakes.script(`${SKILL}/inner_review.sh`, fakes.claude('inner', 'inner-agent', { env: { CLAUDE_CODE_SESSION_ID: 'outer-agent' } })),
      ],
    })),
  ]));
  await fakes.ready('outer', 'inner');
  const board = await f.dashboard();

  const rows = await listed(board, ['outer-agent', 'inner-agent']);
  const [outer, inner] = ['outer-agent', 'inner-agent'].map((session) => rows.find((r) => r.external && r.session === session));
  assert.equal(outer.parentKey, rows.find((r) => r.section === 'claude-launching-session' && r.main).key);
  assert.equal(inner.parentKey, outer.key);
  assert.equal(inner.run, run.id);
  assert.deepEqual([outer.id, inner.id], ['outer-review', 'inner-review']);
});

test('a Claude Code session with Agent-tool sub-agents still gets its section and native rows', async (t) => {
  const f = await fixture(t);
  // A session that launched no run, with one sub-agent in each state.
  claudeTranscripts(f, 'session-with-agents');
  // A session whose sub-agent ran but whose own transcript is missing.
  agentTranscript(f, path.join(projectDir(f), 'agents-only-session', 'subagents'), 'solo', 'solo');
  const board = await f.dashboard();

  const state = await eventually(async () => {
    const all = await board.json('/api/state');
    return all.some((s) => s.id === 'claude-session-with-agents') && all.some((s) => s.id === 'claude-agents-only-session') && all;
  }, 'sessions with sub-agents did not reach the board', 15_000);
  const section = state.find((s) => s.id === 'claude-session-with-agents');
  const main = section.tasks.find((r) => r.main);
  assert.ok(main);
  const agents = section.tasks.filter((r) => !r.main).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(agents.map((r) => [r.id, r.mode, r.native, r.state, r.parentKey]), ['completed', 'needs-decision', 'running', 'stopped']
    .map((expected) => [expected, 'native', true, expected, main.key]));
  const only = state.find((s) => s.id === 'claude-agents-only-session');
  assert.deepEqual(only.tasks.map((r) => [r.id, r.native, r.main ?? false, r.parentKey]), [['solo', true, false, null]]);
  assert.ok(!boardRows(state).some((r) => r.external));
});

// Agents that a task's own shell started (a wrapper that runs `claude -p` or `codex exec`) are rows of
// their own, nested under the task like a delegated task. Each has its own kind, model, state, steps,
// tokens and activity, and counts in the section's totals; the task's own row and tokens stay its own.
const WRAPPER = 'bash ~/.agents/code-review/standards_review.sh --base main';
const oldTime = new Date(Date.now() - 20 * 60_000);
const makeQuiet = (task) => fs.utimesSync(path.join(task.outDir, 'events.jsonl'), oldTime, oldTime);
// The task's own events: its usage so far, then the wrapper command, which has no result yet.
const claudeWrapperEvents = [{ type: 'assistant', message: {
  id: 'wrapper-call', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 },
  content: [{ type: 'tool_use', id: 'wrapper-bash', name: 'Bash', input: { command: WRAPPER } }],
} }];
const codexWrapperEvents = [
  { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 4 } },
  { type: 'item.started', item: { id: 'wrapper-cmd', type: 'command_execution', command: WRAPPER } },
];
const innerEnv = (run, task) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: task });
const rowOf = (state, run, id) => boardRows(state).find((r) => r.run === run.id && r.id === id && !r.native);
// The rows under a task that its own shell started, in the board's order.
const agentsOf = (state, task) => boardRows(state).filter((r) => r.taskAgent && r.parentKey === task.key);
// The board's task row and its agent rows, once the task has `count` agents of its own shell and `check` holds.
async function withAgents(board, run, id, count = 1, check = () => true) {
  return eventually(async () => {
    const state = await board.json('/api/state');
    const row = rowOf(state, run, id);
    const agents = row ? agentsOf(state, row) : [];
    return row && agents.length === count && check(row, agents) ? { state, row, agents } : null;
  }, `${id} did not show ${count} agents of its own shell`, 20_000);
}
const transcriptEvents = async (board, agent) => (await board.json(`/api/transcript?file=${encodeURIComponent(agent.outDir)}`)).events;
const sectionOfRun = (state, run) => state.find((s) => s.tasks.some((r) => r.run === run.id));

test('a running task shows the Claude session its shell runs as a row under it, with its own tokens, and keeps its own activity', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const wrapper = await f.start(run, 'standards-r4', { config: { hold: true, extraEvents: claudeWrapperEvents }, flags: ['--read-only'] });
  const plain = await f.start(run, 'plain', { config: { hold: true }, flags: ['--read-only'] });
  await Promise.all([f.ready(wrapper), f.ready(plain)]);
  makeQuiet(wrapper);
  makeQuiet(plain);
  transcript(f, 'inner-claude', false);
  transcript(f, 'inner-plain', false);
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.script(`${SKILL}/standards_review.sh`, fakes.claude('inner', 'inner-claude', { env: innerEnv(run, 'standards-r4') })),
    fakes.script(`${SKILL}/other_review.sh`, fakes.claude('inner-other', 'inner-plain', { env: innerEnv(run, 'plain') })),
  ]));
  await fakes.ready('inner', 'inner-other');
  const board = await f.dashboard();

  await withAgents(board, run, 'standards-r4');
  await withAgents(board, run, 'plain');
  const state = await board.json('/api/state');
  const rows = boardRows(state);
  const row = rowOf(state, run, 'standards-r4');
  assert.deepEqual(rows.filter((r) => r.run === run.id && !r.main).map((r) => r.id).sort(), ['other-review', 'plain', 'standards-r4', 'standards-review'],
    'each task keeps its row, and each agent has one');
  const [child] = agentsOf(state, row);
  assert.deepEqual({ id: child.id, parentKey: child.parentKey, depth: child.depth, external: child.external, agent: child.agent, kind: child.kind, model: child.model, state: child.state, session: child.session, in: child.tokensIn, out: child.tokensOut },
    { id: 'standards-review', parentKey: row.key, depth: row.depth + 1, external: true, agent: 'claude', kind: 'claude -p', model: 'claude-opus-5-5', state: 'running', session: 'inner-claude', in: 10, out: 5 });
  assert.match(child.launcher, /standards_review\.sh$/);
  assert.match(child.why, /started by the shell of task standards-r4/);
  assert.equal(child.now, 'Read README.md', 'the agent\'s activity is on its own row');
  assert.equal(child.outDir, rows.find((r) => r.session === 'inner-claude').outDir);
  assert.equal(child.taskAttempt, 1);
  // The task's activity and tokens are its own, and each agent's tokens are in the section's totals once.
  assert.match(row.now, /^quiet \d+m\d+s · /, `its own activity: ${row.now}`);
  assert.doesNotMatch(row.now, /^inner:/);
  assert.deepEqual({ in: row.tokensIn, out: row.tokensOut }, { in: 3, out: 2 });
  const section = sectionOfRun(state, run);
  assert.equal(section.totals.tokensIn, 3 + 0 + 10 + 10);
  assert.equal(section.totals.tokensOut, 2 + 0 + 5 + 5);
  assert.equal(section.totals.running, 4, 'two tasks and two agents run');
  // Its events come from its own transcript, newest last: what the panel shows when the row is chosen.
  assert.deepEqual((await transcriptEvents(board, child)).map((e) => [e.kind, e.text]), [['user', 'Review the change.'], ['tool', 'Read README.md']]);

  // The other task has its own activity too, and its own agent row.
  const other = rowOf(state, run, 'plain');
  assert.match(other.now, /^quiet \d+m\d+s · starting$/, `its own activity stays: ${other.now}`);
  assert.equal(agentsOf(state, other)[0].session, 'inner-plain');
  assert.equal(other.kids, 1);
  f.release(wrapper);
  f.release(plain);
  await f.finished(run, 'standards-r4');
  await f.finished(run, 'plain');
});

test('a running Codex task shows the codex exec its shell runs as a row, with its commands and tokens', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const wrapper = await f.start(run, 'standards-r4', { agent: 'codex', config: { hold: true, extraEvents: codexWrapperEvents }, flags: ['--read-only'] });
  await f.ready(wrapper);
  makeQuiet(wrapper);
  const id = codexId();
  const file = rollout(f, id, {}, { events: [tokenCount(100, 20, 50), commandRun('git diff origin/main')] });
  fakes.start(fakes.session('task-agent', 'codex', [
    fakes.script(`${SKILL}/standards_review.sh`, fakes.codex('review', file, { sub: 'exec', env: innerEnv(run, 'standards-r4') })),
  ]));
  await fakes.ready('review');
  const board = await f.dashboard();

  const { state, row, agents: [child] } = await withAgents(board, run, 'standards-r4');
  assert.deepEqual({ parentKey: child.parentKey, kind: child.kind, model: child.model, state: child.state, session: child.session, in: child.tokensIn, cached: child.tokensCached, out: child.tokensOut, steps: child.steps },
    { parentKey: row.key, kind: 'codex exec', model: 'gpt-6.1-sol', state: 'running', session: id, in: 100, cached: 20, out: 50, steps: 1 });
  assert.equal(child.outDir, file);
  assert.equal(child.now, '$ git diff origin/main');
  assert.doesNotMatch(row.now, /^inner:/);
  assert.deepEqual({ in: row.tokensIn, out: row.tokensOut }, { in: 7, out: 4 }, 'the task\'s own tokens only');
  assert.deepEqual((await transcriptEvents(board, child)).map((e) => e.kind), ['user', 'tool']);
  assert.equal(sectionOfRun(state, run).totals.tokensIn, 7 + 100);
  f.release(wrapper);
  await f.finished(run, 'standards-r4');
});

// The case that made the agent hard to find: a light Codex task runs a review script, whose claude -p
// session on a stronger model does the real work.
test('a Codex task whose shell runs a claude -p agent shows two rows: the agent on its own model, nested under the task, running first', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const wrapper = await f.start(run, 'standards-r4', { agent: 'codex', config: { hold: true, extraEvents: codexWrapperEvents }, flags: ['--read-only'] });
  await f.ready(wrapper);
  makeQuiet(wrapper);
  transcript(f, 'inner-fable', false, 'claude-fable-5-2');
  transcript(f, 'inner-earlier', true, 'claude-fable-5-2');
  // An earlier agent of the same task, finished, recorded by an earlier dashboard.
  const ended = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(projectDir(f), 'inner-earlier.jsonl'), ended, ended);
  fs.writeFileSync(path.join(f.state, 'external.jsonl'), JSON.stringify({ key: 'claude:inner-earlier', agent: 'claude', sessionId: 'inner-earlier', file: null, cwd: f.repo, pid: 2_147_000_000,
    command: 'claude -p fixture', startedMs: ended.getTime() - 60_000, seenMs: ended.getTime(), name: 'earlier-review', launcher: 'bash /home/user/.agents/code-review/earlier_review.sh',
    parent: { run: run.id, task: 'standards-r4', claude: null, codex: null, nearest: 'codex' } }) + '\n');
  fakes.start(fakes.session('task-agent', 'codex', [
    fakes.script(`${SKILL}/standards_review.sh`, fakes.claude('inner', 'inner-fable', { env: innerEnv(run, 'standards-r4') })),
  ]));
  await fakes.ready('inner');
  const board = await f.dashboard();

  const { state, row, agents } = await withAgents(board, run, 'standards-r4', 2);
  const section = sectionOfRun(state, run);
  const ours = section.tasks.filter((r) => r.run === run.id && !r.main);
  assert.equal(ours.length, 3, 'the task and its two agents');
  assert.deepEqual(ours.map((r) => r.id), ['standards-r4', 'standards-review', 'earlier-review'], 'the agents follow the task, the running one first');
  assert.deepEqual(agents.map((r) => r.state), ['running', 'completed']);
  const child = agents[0];
  assert.equal(child.parentKey, row.key);
  assert.equal(child.depth, row.depth + 1);
  assert.equal(row.kids, 2);
  assert.equal(row.descendants, 2);
  // The agent's own kind and model, never the task's.
  assert.deepEqual([row.agent, row.mode], ['codex', row.mode]);
  assert.deepEqual([child.agent, child.kind, child.model, child.modelLabel, child.mode], ['claude', 'claude -p', 'claude-fable-5-2', 'fable-5-2', 'external']);
  assert.notEqual(child.modelLabel, row.modelLabel);
  assert.equal(child.session, 'inner-fable');
  assert.deepEqual({ in: row.tokensIn, out: row.tokensOut }, { in: 7, out: 4 });
  assert.equal(section.totals.tokensIn, 7 + 10 + 10, 'both agents count once');
  assert.equal(section.totals.tokensOut, 4 + 5 + 5);
  f.release(wrapper);
  await f.finished(run, 'standards-r4');
});

test('an agent a command task runs directly is named for itself, not for the orchestrator\'s command relay', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const task = await f.start(run, 'live-cmd', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  transcript(f, 'direct-agent', false);
  const relay = path.join(f.root, 'home', '.agents', 'skills', 'agent-orchestrator', 'scripts', 'command-relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(process.env.FAKE_AGENT);\n");
  fakes.start(fakes.node('relay', relay, [fakes.claude('direct', 'direct-agent', { env: innerEnv(run, 'live-cmd') })]));
  await fakes.ready('direct');
  const board = await f.dashboard();

  const { agents } = await withAgents(board, run, 'live-cmd');
  assert.deepEqual([agents[0].id, agents[0].launcher, agents[0].session], ['claude-headless', null, 'direct-agent']);
  f.release(task);
  await f.finished(run, 'live-cmd');
});

test('a command task shows the agent its command runs in its own row: its model, tokens, activity and log, with no row under it', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  await f.command(['start', run.id, 'review', '--agent', 'command', '--why', 'runs a review script', '--', 'sleep', '60']);
  const taskFile = path.join(run.dir, 'tasks', 'review', 'task.json');
  writeJson(taskFile, { ...JSON.parse(fs.readFileSync(taskFile, 'utf8')), maxTier: 'standard' });
  transcript(f, 'cmd-agent', false, 'claude-fable-5-2');
  fakes.start(fakes.session('cmd-shell', 'claude', [
    fakes.script(`${SKILL}/standards_review.sh`, fakes.claude('inner', 'cmd-agent', { env: innerEnv(run, 'review') })),
  ]));
  await fakes.ready('inner');
  const board = await f.dashboard();

  const { state, row } = await eventually(async () => {
    const found = await board.json('/api/state');
    const task = rowOf(found, run, 'review');
    return task?.session === 'cmd-agent' ? { state: found, row: task } : null;
  }, 'the command task did not take up its agent', 20_000);
  const ours = boardRows(state).filter((r) => r.run === run.id && !r.main);
  assert.deepEqual(ours.map((r) => r.id), ['review'], 'one row: the agent has none of its own');
  assert.deepEqual([row.agent, row.model, row.modelLabel, row.state, row.kids], ['command', 'claude-fable-5-2', 'fable-5-2', 'running', 0]);
  assert.deepEqual({ in: row.tokensIn, out: row.tokensOut, steps: row.steps }, { in: 10, out: 5, steps: 1 });
  assert.equal(row.maxTier, 'standard');
  assert.equal(row.now, 'Read README.md · ⚠ standards-review (claude claude-fable-5-2) exceeds the standard ceiling');
  assert.deepEqual(row.runs.map((a) => [a.kind, a.modelLabel, a.state, a.session]), [['claude -p', 'fable-5-2', 'running', 'cmd-agent']]);
  assert.match(row.agentLog, /cmd-agent\.jsonl$/);
  assert.deepEqual((await board.json(`/api/transcript?file=${encodeURIComponent(row.agentLog)}`)).events.map((e) => [e.kind, e.text]), [['user', 'Review the change.'], ['tool', 'Read README.md']]);
  const section = sectionOfRun(state, run);
  assert.deepEqual([section.totals.tokensIn, section.totals.tokensOut], [10, 5], 'counted once');
  await f.command(['stop', run.id, 'review']);
});

test('a finished task still shows the agents its shell ran, finished, with their events', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const first = await f.start(run, 'claude-wrapper', { config: { hold: true, extraEvents: claudeWrapperEvents }, flags: ['--read-only'] });
  const second = await f.start(run, 'codex-wrapper', { agent: 'codex', config: { hold: true, extraEvents: codexWrapperEvents }, flags: ['--read-only'] });
  await Promise.all([f.ready(first), f.ready(second)]);
  transcript(f, 'inner-done', true);
  const id = codexId();
  const file = rollout(f, id, {}, { events: [tokenCount(40, 0, 10), commandRun('git log -1'), rolloutEvent({ type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'output_text', text: 'No findings.' }] } })] });
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.script(`${SKILL}/standards_review.sh`, fakes.claude('inner-claude', 'inner-done', { env: innerEnv(run, 'claude-wrapper') })),
    fakes.script(`${SKILL}/codex_review.sh`, fakes.codex('inner-codex', file, { sub: 'exec', env: innerEnv(run, 'codex-wrapper') })),
  ]));
  await fakes.ready('inner-claude', 'inner-codex');
  const board = await f.dashboard();
  await withAgents(board, run, 'claude-wrapper');
  await withAgents(board, run, 'codex-wrapper');

  // The agents end, then their tasks do; the finished tasks go on showing them.
  await fakes.stop('inner-claude', 'inner-codex');
  f.release(first);
  f.release(second);
  await f.finished(run, 'claude-wrapper');
  await f.finished(run, 'codex-wrapper');
  const done = await eventually(async () => {
    const state = await board.json('/api/state');
    const tasks = ['claude-wrapper', 'codex-wrapper'].map((id) => rowOf(state, run, id));
    const agents = tasks.map((r) => (r ? agentsOf(state, r) : []));
    return tasks.every((r, i) => r?.state === 'completed' && agents[i].length === 1 && agents[i][0].state !== 'running') ? { tasks, agents: agents.map(([a]) => a), state } : null;
  }, 'the finished tasks did not show their finished agents', 20_000);
  const { tasks: [claudeRow, codexRow], agents: [claudeAgent, codexAgent] } = done;
  assert.equal(claudeAgent.kind, 'claude -p');
  assert.equal(claudeAgent.state, 'completed');
  assert.equal(codexAgent.kind, 'codex exec');
  assert.equal(codexAgent.state, 'completed');
  assert.deepEqual({ in: codexAgent.tokensIn, out: codexAgent.tokensOut }, { in: 40, out: 10 });
  assert.notEqual(claudeRow.now, undefined);
  assert.ok(!String(claudeRow.now).startsWith('inner: ') && !String(codexRow.now).startsWith('inner: '), 'a finished task shows its own last words');
  assert.equal(claudeAgent.now, 'inner-done reply', 'a finished agent shows its last words');
  assert.deepEqual((await transcriptEvents(board, claudeAgent)).map((e) => [e.kind, e.text]), [['user', 'Review the change.'], ['says', 'inner-done reply']]);
  assert.deepEqual((await transcriptEvents(board, codexAgent)).map((e) => [e.kind, e.text]),
    [['user', 'Review the change.'], ['tool', '$ git log -1'], ['says', 'No findings.']]);
});

// Make a finished task look as if it finished `ms` ago: its task record and its result.
function backdate(run, id, ms) {
  const taskFile = path.join(run.dir, 'tasks', id, 'task.json');
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const at = (back) => new Date(Date.now() - back).toISOString();
  writeJson(taskFile, { ...task, createdAt: at(ms + 60_000), startedAt: at(ms + 60_000) });
  const resultFile = path.join(task.outDir, 'result.json');
  writeJson(resultFile, { ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), startedAt: at(ms + 60_000), finishedAt: at(ms) });
}

test('a shown task keeps its finished agents after the board\'s idle window, and an unlisted task\'s agents get no row', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'old-wrapper', { config: { finalMessage: 'Reviewed.' }, flags: ['--read-only'] });
  await f.finished(run, 'old-wrapper');
  const long = await f.start(run, 'long', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(long);
  // The agent ended three hours ago: past AGENT_ORCH_BOARD_IDLE (2h), when a finished one leaves the board.
  const ago = new Date(Date.now() - 3 * 3600_000);
  const file = transcript(f, 'old-inner', true);
  fs.utimesSync(file, ago, ago);
  const base = { agent: 'claude', cwd: f.repo, pid: 2_147_000_000, command: 'claude -p fixture', startedMs: ago.getTime() - 60_000, seenMs: ago.getTime(), name: 'standards-review',
    launcher: 'bash /home/user/.agents/code-review/standards_review.sh' };
  const parent = (task) => ({ run: run.id, task, claude: null, codex: null, nearest: 'claude' });
  const records = [
    { ...base, key: 'claude:old-inner', sessionId: 'old-inner', parent: parent('old-wrapper') },
    // Another run's task is not on the board, and a record with no task is the board's own business.
    { ...base, key: 'claude:elsewhere', sessionId: 'elsewhere', parent: { ...parent('old-wrapper'), run: 'no-such-run' } },
  ];
  fs.writeFileSync(path.join(f.state, 'external.jsonl'), records.map((r) => JSON.stringify(r) + '\n').join(''));
  const board = await f.dashboard();

  const { state, row, agents: [child] } = await withAgents(board, run, 'old-wrapper');
  assert.equal(child.session, 'old-inner');
  assert.equal(child.state, 'completed');
  assert.equal(child.parentKey, row.key);
  assert.equal(child.older, false, 'it stays while its task stays');
  assert.deepEqual(boardRows(state).filter((r) => r.run === run.id && !r.native).map((r) => r.id).sort(), ['long', 'old-wrapper']);
  assert.equal(agentsOf(state, rowOf(state, run, 'long')).length, 0, 'a task whose shell started nothing has no agent rows');
  assert.ok(!boardRows(state).some((r) => r.session === 'elsewhere'), 'an agent of a task that is not on the board gets no row');
  f.release(long);
  await f.finished(run, 'long');
});

// An agent folds away with its task, not before it: a task that is shown keeps the agents it started.
test('a task\'s agents fold with it as older rows, and stay while it stays', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const owner = f.launchingSession(run, 'fold-session'); // the run's owner collects the results, so no task awaits review
  claudeTranscripts(f, 'fold-session');
  for (const id of ['quiet', 'recent']) {
    await f.start(run, id, { config: { finalMessage: 'Reviewed.' }, flags: ['--read-only'] });
    await f.finished(run, id);
    await f.command(['result', run.id, id], { env: owner });
  }
  backdate(run, 'quiet', 90 * 60_000); // finished 90 minutes ago: older than the rows' hour
  const long = await f.start(run, 'long', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(long);
  const ago = new Date(Date.now() - 100 * 60_000);
  const base = { agent: 'claude', cwd: f.repo, pid: 2_147_000_000, command: 'claude -p fixture', startedMs: ago.getTime() - 60_000, seenMs: ago.getTime(), name: 'review',
    launcher: 'bash /home/user/.agents/code-review/standards_review.sh' };
  const records = ['quiet', 'recent', 'long'].map((task) => {
    const session = `old-${task}`;
    const file = transcript(f, session, true);
    fs.utimesSync(file, ago, ago); // each agent ended 100 minutes ago, so quiet itself
    return { ...base, key: `claude:${session}`, sessionId: session, parent: { run: run.id, task, claude: null, codex: null, nearest: 'claude' } };
  });
  fs.writeFileSync(path.join(f.state, 'external.jsonl'), records.map((r) => JSON.stringify(r) + '\n').join(''));
  const board = await f.dashboard();

  const state = (await withAgents(board, run, 'quiet')).state;
  const older = (id) => rowOf(state, run, id).older;
  assert.deepEqual(['quiet', 'recent', 'long'].map(older), [true, false, false], 'only the task that has been quiet a while folds');
  for (const id of ['quiet', 'recent', 'long']) {
    const [child] = agentsOf(state, rowOf(state, run, id));
    assert.equal(child.state, 'completed', id);
    assert.equal(child.older, older(id), `${id}'s agent folds with it, and shows with it`);
  }
  f.release(long);
  await f.finished(run, 'long');
});

test('an agent\'s row is read incrementally: an unchanged transcript is not read again, and a finished one is built once', async (t) => {
  const { innerAgent } = await import('../scripts/lib/external.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'inner-unit.jsonl');
  const timestamp = new Date().toISOString();
  const line = (entry) => JSON.stringify(entry) + '\n';
  const reply = (id, content, stop, usage) => ({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-5-5', stop_reason: stop, content, usage } });
  fs.writeFileSync(file, line({ type: 'user', timestamp, cwd: dir, message: { role: 'user', content: 'Review.' } })
    + line(reply('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }], 'tool_use', { input_tokens: 10, output_tokens: 5 })));
  // Every read of the transcript: [position, bytes].
  const files = new Map();
  const reads = [];
  const { openSync, readSync } = fs;
  fs.openSync = (p, ...rest) => { const fd = openSync(p, ...rest); if (p === file) files.set(fd, p); return fd; };
  fs.readSync = (fd, ...rest) => { const n = readSync(fd, ...rest); if (files.has(fd)) reads.push([rest[3], n]); return n; };
  t.after(() => { fs.openSync = openSync; fs.readSync = readSync; });
  const x = { key: 'claude:inner-unit', agent: 'claude', sessionId: 'inner-unit', file, cwd: dir, startedMs: Date.now() - 5000, lastMs: Date.now(), alive: true,
    name: 'standards-review', launcher: 'bash standards_review.sh', parent: {} };

  const first = innerAgent(x);
  assert.deepEqual({ state: first.state, now: first.now, steps: first.steps, in: first.tokensIn, out: first.tokensOut }, { state: 'running', now: 'Read a.txt', steps: 1, in: 10, out: 5 });
  const size = fs.statSync(file).size;
  assert.deepEqual(reads, [[0, size]]);
  innerAgent(x);
  assert.equal(reads.length, 1, 'an unchanged transcript is not read again');
  // It finishes: only the appended lines are read.
  fs.appendFileSync(file, line(reply('m2', [{ type: 'text', text: 'No findings.' }], 'end_turn', { input_tokens: 4, output_tokens: 2 })));
  const done = innerAgent({ ...x, alive: false, lastMs: Date.now() });
  assert.equal(reads.length, 2);
  assert.equal(reads[1][0], size, 'the read starts where the last one ended');
  assert.deepEqual({ state: done.state, in: done.tokensIn, out: done.tokensOut }, { state: 'completed', in: 14, out: 7 });
  // A finished agent's row is kept as built until its transcript or state changes.
  assert.equal(innerAgent({ ...x, alive: false, lastMs: done.lastActiveMs }), done);
  assert.equal(reads.length, 2);
});

// A Claude transcript that stops at a tool call, so its agent's activity is that call.
const toolTranscript = (f, session, name, input) => {
  const timestamp = new Date().toISOString();
  return jsonl(path.join(projectDir(f), `${session}.jsonl`), [
    { type: 'user', timestamp, cwd: f.repo, message: { role: 'user', content: 'Review the change.' } },
    { type: 'assistant', timestamp, message: { id: `${session}-reply`, model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `${session}-call`, name, input }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
};

// Defect: agents were grouped by run and task only, so a resumed task's new attempt took the agents of
// its earlier attempts as its own.
test('an agent row is labelled with the attempt that started it, and an old attempt\'s agents still show', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  await f.start(run, 'wrapper', { config: { finalMessage: 'First attempt.' }, flags: ['--read-only'] });
  const first = await f.finished(run, 'wrapper');
  const wrapper = await f.start(run, 'wrapper', { config: { hold: true, extraEvents: claudeWrapperEvents }, flags: ['--read-only'] });
  await f.ready(wrapper);
  makeQuiet(wrapper);
  // One agent started in the first attempt and still runs; the other started in the second.
  toolTranscript(f, 'inner-early', 'Grep', { pattern: 'TODO' });
  toolTranscript(f, 'inner-late', 'Read', { file_path: 'late.txt' });
  fakes.start(fakes.session('task-agent', 'claude', [
    fakes.script(`${SKILL}/early_review.sh`, fakes.claude('early', 'inner-early', { env: innerEnv(run, 'wrapper'), startedAt: Date.parse(first.startedAt) + 1 })),
    fakes.script(`${SKILL}/late_review.sh`, fakes.claude('late', 'inner-late', { env: innerEnv(run, 'wrapper'), startedAt: Date.now() })),
  ]));
  await fakes.ready('early', 'late');
  const board = await f.dashboard();

  const { row, agents } = await withAgents(board, run, 'wrapper', 2);
  assert.equal(row.attempt, 2);
  assert.deepEqual(agents.map((x) => [x.session, x.taskAttempt, x.state, x.parentKey]).sort(), [['inner-early', 1, 'running', row.key], ['inner-late', 2, 'running', row.key]]);
  assert.match(row.now, /^quiet \d+m\d+s · /, 'the task\'s own activity, whichever attempt an agent belongs to');
  assert.doesNotMatch(row.now, /^inner:/);
  assert.equal(agents.find((x) => x.session === 'inner-late').now, 'Read late.txt');
  f.release(wrapper);
  await f.finished(run, 'wrapper');
});

// Defect (before agents had rows): the task's row showed an agent's activity, after "inner:", whenever
// the task had a command still waiting for a result. The agent's row shows it now, and the task's is its own.
test('a task\'s activity is its own whatever its latest event is, and its agent\'s activity is on the agent\'s row', async (t) => {
  const { f, fakes } = await setup(t);
  const run = await f.newRun();
  const message = { type: 'assistant', message: { id: 'wrapper-note', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Own latest activity after the review started' }], usage: { input_tokens: 1, output_tokens: 1 } } };
  const finishedCommand = [codexWrapperEvents[1], { type: 'item.completed', item: { id: 'wrapper-cmd', type: 'command_execution', command: WRAPPER, exit_code: 0, status: 'completed', aggregated_output: 'ok' } }];
  const tasks = {
    waiting: await f.start(run, 'waiting', { config: { hold: true, extraEvents: claudeWrapperEvents }, flags: ['--read-only'] }),
    later: await f.start(run, 'later', { config: { hold: true, extraEvents: [...claudeWrapperEvents, message] }, flags: ['--read-only'] }),
    answered: await f.start(run, 'answered', { agent: 'codex', config: { hold: true, extraEvents: finishedCommand }, flags: ['--read-only'] }),
  };
  for (const task of Object.values(tasks)) {
    await f.ready(task);
    makeQuiet(task);
  }
  const ids = Object.keys(tasks);
  for (const id of ids) transcript(f, `inner-${id}`, false);
  fakes.start(fakes.session('task-agent', 'claude', ids.map((id) => (
    fakes.script(`${SKILL}/${id}_review.sh`, fakes.claude(id, `inner-${id}`, { env: innerEnv(run, id) }))))));
  await fakes.ready(...ids);
  const board = await f.dashboard();

  for (const id of ids) await withAgents(board, run, id);
  // Again once every task has been built with its agent: the rows are stable.
  const state = await board.json('/api/state');
  const rows = Object.fromEntries(ids.map((id) => [id, rowOf(state, run, id)]));
  for (const id of ids) assert.doesNotMatch(rows[id].now, /^inner:/, `${id}: its own activity`);
  assert.match(rows.waiting.now, /^quiet \d+m\d+s · /);
  assert.match(rows.later.now, /^quiet \d+m\d+s · says: Own latest activity/, 'a newer message of its own shows');
  assert.match(rows.answered.now, /^quiet \d+m\d+s · \$ bash /, 'a call that has its result is not a waiting call');
  for (const id of ids) {
    const [child] = agentsOf(state, rows[id]);
    assert.equal(child.session, `inner-${id}`, `${id} shows its agent`);
    assert.equal(child.now, 'Read README.md', `${id}'s agent's activity is on its row`);
  }
  for (const task of Object.values(tasks)) f.release(task);
  for (const id of ids) await f.finished(run, id);
});

test('folded command agent ceiling warnings distinguish above, equal, below, and no ceiling', () => {
  const task = { run: 'r', id: 'work', agent: 'command', maxTier: 'standard', attempt: 1 };
  const child = (id, model) => ({ run: 'r', id, parent: 'work', taskAgent: true, agent: 'claude', model, state: 'running', taskAttempt: 1 });
  const rows = [task, child('above', 'claude-opus-5-5'), child('equal', 'claude-sonnet-5-5'), child('below', 'claude-haiku-5-5')];
  assert.equal(foldCommandAgents(rows)[0].now, '⚠ above (claude claude-opus-5-5) exceeds the standard ceiling');
  assert.equal(foldCommandAgents([{ ...task, maxTier: undefined }, ...rows.slice(1)])[0].now, undefined);
});
