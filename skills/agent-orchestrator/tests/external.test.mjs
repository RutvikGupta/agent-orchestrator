import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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

test('an agent that a skill\'s script runs from a task\'s shell is not listed: the task\'s row stands for it', async (t) => {
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
  const rows = boardRows(await board.json('/api/state'));
  const reviewer = rows.find((r) => r.run === run.id && r.id === 'reviewer' && !r.native);
  assert.equal(reviewer.session, 'fixture-claude');
  assert.equal(reviewer.state, 'running');
  assert.deepEqual(rows.filter((r) => r.external).map((r) => r.session).filter((s) => ['task-shell-agent', id].includes(s)), []);
  f.release(task);
  await f.finished(run, 'reviewer');
});

test('an outside agent the board leaves out keeps its session\'s own section when it used the Agent tool', async (t) => {
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

  // Once the dashboard has found the agent, it is not listed, as before this feature, and its
  // session still gets the section that any session with sub-agents gets.
  await recorded(board, f, ['claude:task-shell-session']);
  const state = await board.json('/api/state');
  assert.ok(!boardRows(state).some((r) => r.external && r.session === 'task-shell-session'), 'the task\'s row stands for the agent');
  const section = state.find((s) => s.id === 'claude-task-shell-session');
  assert.ok(section, `no section for the agent's session: ${JSON.stringify(state.map((s) => s.id))}`);
  const main = section.tasks.find((r) => r.main);
  assert.ok(main);
  assert.deepEqual(section.tasks.filter((r) => !r.main).map((r) => [r.id, r.mode, r.native, r.parentKey]), [['helper', 'native', true, main.key]]);
  f.release(task);
  await f.finished(run, 'reviewer');
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
