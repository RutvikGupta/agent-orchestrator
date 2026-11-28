import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { eventually, fixture, jsonl, readJson, writeJson } from './helpers.mjs';

const timestamp = new Date().toISOString();
const prompt = (content, extra = {}) => ({
  type: 'user', timestamp, message: { role: 'user', content }, ...extra,
});
const entry = (text) => ({ time: timestamp, text });
const line = (record) => JSON.stringify(record) + '\n';
const transcriptRoute = (file) => '/api/transcript?file=' + encodeURIComponent(file);

async function mainTranscript(f) {
  const run = await f.newRun('transcript');
  const session = 'dashboard-transcript-fixture';
  f.launchingSession(run, session);
  return { run, file: path.join(f.claude, 'projects', 'fixture-project', session + '.jsonl') };
}

test('the dashboard reads the whole prompt history and follows changes to the transcript', async (t) => {
  const f = await fixture(t);
  const { file } = await mainTranscript(f);
  const large = 'x'.repeat(256 * 1024);
  const filler = Array.from({ length: 13 }, () => ({
    type: 'assistant', timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text: large }] },
  }));
  const long = 'a'.repeat(4100);
  jsonl(file, [
    prompt('First prompt'),
    ...filler.slice(0, 1),
    prompt([{ type: 'text', text: '<system-reminder>Reminder</system-reminder>' }, { type: 'text', text: '  Second prompt' }]),
    ...filler.slice(1),
    prompt(long),
    prompt('Hidden metadata', { isMeta: true }),
    prompt([{ type: 'tool_result', content: 'Tool output' }]),
    prompt('<task-notification>Background work finished</task-notification>'),
    prompt('<local-command-stdout>Local output</local-command-stdout>'),
    prompt('<local-command-caveat>Local command</local-command-caveat>'),
    prompt('<command-name>/status</command-name>'),
    prompt([{ type: 'text', text: '<system-reminder>Reminder</system-reminder>' }]),
    prompt('Sidechain input', { isSidechain: true }),
    prompt('Child agent input', { parent_tool_use_id: 'child-tool' }),
    prompt('<bash-stdout>Shell output</bash-stdout>'),
    prompt([{ type: 'text', text: '<bash-stderr>Shell error</bash-stderr>' }]),
    prompt('Explain tool results', { entryLabel: 'tool_result' }),
  ]);
  const board = await f.dashboard();
  const get = async () => (await board.json(transcriptRoute(file))).prompts;
  const first = await get();
  assert.deepEqual(first, [entry('First prompt'), entry('  Second prompt'), entry(long.slice(0, 4000)), entry('Explain tool results')]);
  t.diagnostic(`${fs.statSync(file).size} bytes, ${first.length} prompts on first request`);

  const added = Buffer.from(line(prompt('Appended café')));
  const split = added.indexOf(Buffer.from('é')) + 1;
  fs.appendFileSync(file, added.subarray(0, split));
  assert.deepEqual(await get(), first, 'an incomplete line does not become a prompt');
  fs.appendFileSync(file, added.subarray(split));
  const appended = await get();
  assert.deepEqual(appended, [...first, entry('Appended café')]);
  t.diagnostic(`${appended.length} prompts after appending one line`);

  const reset = Array.from({ length: 502 }, (_, i) => prompt(`Prompt ${i + 1}`));
  jsonl(file, reset);
  assert.deepEqual(await get(), reset.slice(-500).map((e) => entry(e.message.content)));

  // A replacement can be larger than its predecessor, so size alone cannot detect it.
  const replacement = jsonl(file + '.replacement', [prompt('Replacement'), filler[0]]);
  fs.renameSync(replacement, file);
  assert.deepEqual(await get(), [entry('Replacement')]);
});

test('a dead launcher ends the main row unless the session was resumed', async (t) => {
  const f = await fixture(t);
  const { run, file } = await mainTranscript(f);
  const processThatExited = spawn(process.execPath, ['-e', '']);
  await once(processThatExited, 'exit');
  fs.mkdirSync(path.join(f.claude, 'sessions'));
  const runFile = path.join(run.dir, 'run.json');
  const saved = readJson(runFile);
  writeJson(runFile, { ...saved, orchestrator: { ...saved.orchestrator, pid: processThatExited.pid } });
  jsonl(file, [prompt('A turn left open')]);

  const resumed = await f.newRun('resumed');
  const resumedSession = 'resumed-dashboard-session';
  f.launchingSession(resumed, resumedSession);
  const resumedFile = path.join(resumed.dir, 'run.json');
  const resumedRecord = readJson(resumedFile);
  writeJson(resumedFile, { ...resumedRecord, orchestrator: { ...resumedRecord.orchestrator, pid: processThatExited.pid } });
  jsonl(path.join(path.dirname(file), resumedSession + '.jsonl'), [prompt('Resumed turn')]);
  const host = spawn(process.execPath, ['-e', "process.title = 'claude'; process.on('disconnect', () => {}); process.send('ready')"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(host, 'exit');
  t.after(async () => { if (host.connected) host.disconnect(); await exited; });
  await once(host, 'message');
  writeJson(path.join(f.claude, 'sessions', host.pid + '.json'), { pid: host.pid, sessionId: resumedSession });

  const sections = await (await f.dashboard()).json('/api/state');
  const state = (session) => sections.find((s) => s.orchestrator.sessionId === session)?.tasks.find((row) => row.main)?.state;
  assert.equal(state(saved.orchestrator.sessionId), 'ended');
  assert.equal(state(resumedSession), 'running');

  await f.start(run, 'status-task', { env: {
    CLAUDE_CODE_SESSION_ID: saved.orchestrator.sessionId, CODEX_THREAD_ID: saved.orchestrator.sessionId,
  } });
  await f.finished(run, 'status-task');
  // The owner command refreshed the launcher's identity. Restore the ended process fixture.
  writeJson(runFile, { ...readJson(runFile), orchestrator: { ...saved.orchestrator, pid: processThatExited.pid } });
  const args = ['status', run.id];
  const { stdout } = await f.command(args, { env: { NODE_OPTIONS: '--import=data:text/javascript,process.stdout.isTTY=true' } });
  assert.match(stdout, /main session.*\x1b\[90mended\x1b\[0m/);
  assert.match((await f.command(args)).stdout, /main session.* · ended · /);
});

test('Claude exit and quit close a main session turn', async (t) => {
  const f = await fixture(t);
  const { file } = await mainTranscript(f);
  jsonl(file, [prompt('Start a turn')]);
  const board = await f.dashboard();
  const state = async () => {
    const [section] = await board.json('/api/state');
    return section.tasks.find((row) => row.main)?.state;
  };
  assert.equal(await state(), 'running');
  for (const exit of [
    '/exit',
    [{ type: 'text', text: '/quit' }],
    '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
  ]) {
    fs.appendFileSync(file, line(prompt(exit)));
    await eventually(async () => await state() === 'idle', 'exit did not close the turn');
    fs.appendFileSync(file, line(prompt('Start another turn')));
    await eventually(async () => await state() === 'running', 'the next prompt did not open a turn');
  }
});
