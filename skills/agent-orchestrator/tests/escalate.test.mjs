import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, eventually, readJson, writeJson } from './helpers.mjs';

for (const [name, config, reason] of [
  ['decision', { finalMessage: 'NEEDS DECISION: Choose the endpoint? Recommendation: A.' }, /Choose the endpoint/],
  ['failure', { status: 'failed', error: 'Build failed: missing entry point' }, /missing entry point/],
  ['usage-limit', { status: 'failed', error: 'Usage limit reached' }, /usage limit/i],
  ['exhausted-retry', { status: 'failed', error: 'HTTP 503' }, /HTTP 503/],
]) {
  test(`wait wakes with exit 5 for a new ${name} while a sibling runs`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'sibling', { flags: ['--read-only'], config: { delayMs: 30_000 } });
    const task = await f.start(run, 'attention', { flags: ['--read-only'], config: { ...config, hold: true } });
    const waited = await f.waitAfterPoll([run.id, '--timeout', '0'], async () => {
      f.release(task);
      await f.finished(run, 'attention');
    }, { code: 5, env: { AGENT_ORCH_MAX_RETRIES: '0' } });
    assert.match(waited.stdout, /attention: /);
    assert.match(waited.stdout, reason);
    assert.match(waited.stdout, /a task needs attention/);
    assert.doesNotMatch(waited.stdout, /wait timed out/);
    const tasks = (await f.json(['status', run.id])).tasks;
    assert.equal(tasks.find((row) => row.id === 'sibling').state, 'running');
    if (name === 'decision') assert.match(waited.stdout, /handed back a decision/);
    if (name === 'usage-limit') assert.match(waited.stdout, /stopped on a usage limit/);
    if (name === 'exhausted-retry') assert.match(waited.stdout, /transient error; resume with:/);
  });
}

test('wait lists old attention without waking, and ignores unwatched new attention', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'old', { config: { finalMessage: 'NEEDS DECISION: Already asked.' } });
  await f.finished(run, 'old');
  await f.start(run, 'old-failure', { config: { status: 'failed', error: 'Already failed' } });
  await f.finished(run, 'old-failure');
  // The orchestrator has read the decision (it stays open) and the failure (reading closes it).
  // An unread one would wake wait at once.
  await f.command(['result', run.id, 'old']);
  await f.command(['result', run.id, 'old-failure']);
  await f.start(run, 'sibling', { flags: ['--read-only'], config: { delayMs: 30_000 } });
  const unwatched = await f.start(run, 'unwatched', { flags: ['--read-only'], config: { status: 'failed', hold: true } });
  const began = Date.now();
  const waited = await f.waitAfterPoll([run.id, 'old', 'old-failure', 'sibling', '--timeout', '1s', '--json'], async () => {
    f.release(unwatched);
    await f.finished(run, 'unwatched');
  }, { code: 3 });
  const result = JSON.parse(waited.stdout);
  assert.ok(Date.now() - began >= 1000);
  assert.equal(result.finished, false);
  assert.deepEqual(result.attention.map((a) => a.task).sort(), ['old']);
  assert.equal(result.tasks.some((row) => row.id === 'unwatched'), false);
});

test('an unread failure from before wait started wakes it at once', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'old-failure', { config: { status: 'failed', error: 'Already failed' } });
  await f.finished(run, 'old-failure');
  await f.start(run, 'sibling', { flags: ['--read-only'], config: { delayMs: 30_000 } });
  const waited = await f.command(['wait', run.id, '--timeout', '20s', '--json']);
  const result = JSON.parse(waited.stdout);
  assert.equal(result.finished, true);
  assert.deepEqual(result.attention.map((a) => a.task), ['old-failure']);
});

test('wait suppresses a transient error that was retried, but wakes if the retry fails too', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'sibling', { flags: ['--read-only'], config: { delayMs: 30_000 } });
  const retry = await f.start(run, 'retry', { flags: ['--read-only'], config: { hold: true, status: 'failed', error: 'HTTP 503' } });
  // The transient error never wakes wait; the retry's completed result does, as any finished
  // task does, so the orchestrator reviews it.
  const waited = await f.waitAfterPoll([run.id, '--timeout', '20s'], async () => {
    f.release(retry);
    await f.finished(run, 'retry');
  }, { code: 0 });
  assert.match(waited.stdout, /retried retry/);
  assert.doesNotMatch(waited.stdout, /a task needs attention/);
  assert.match(waited.stdout, /retry finished and nobody has read its result/);
  assert.equal((await f.finished(run, 'retry')).state, 'completed');
  await f.command(['result', run.id, 'retry']);
  // Configure the retry's failure before wait can observe it, instead of editing
  // result.json while wait races to consume that same result.
  const task = await f.start(run, 'exhausted', { flags: ['--read-only'], config: {
    hold: true, status: 'failed',
    error: 'HTTP 503 <!-- fake-relay {"status":"failed","error":"HTTP 503"} -->',
  } });
  const exhausted = await f.waitAfterPoll([run.id, '--timeout', '0', '--json'], async () => {
    f.release(task);
    await f.finished(run, 'exhausted');
  }, { code: 5 });
  assert.match(exhausted.stderr, /retried exhausted/);
  const result = JSON.parse(exhausted.stdout);
  // The failed retry is also an unread result; exit 5 marks it as attention.
  assert.equal(result.finished, true);
  assert.equal(result.attention[0].task, 'exhausted');
  assert.equal(result.attention[0].attempt, 2);
});

for (const kind of ['dead', 'silent']) {
  test(`wait wakes on new health ${kind} and keeps health hints`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const task = await f.start(run, 'task', { flags: ['--read-only'], config: { delayMs: 30_000 } });
    await f.ready(task);
    const waited = await f.waitAfterPoll([run.id, '--timeout', '0'], async () => {
      if (kind === 'dead') {
        await f.command(['stop', run.id, 'task']);
        await f.finished(run, 'task');
        fs.unlinkSync(path.join(task.outDir, 'result.json'));
      } else {
        const old = new Date(Date.now() - 16 * 60_000);
        fs.utimesSync(path.join(task.outDir, 'events.jsonl'), old, old);
      }
    }, { code: 5 });
    assert.match(waited.stdout, new RegExp(`task: ${kind}`));
  });
}

function notifier(f) {
  f.env.AGENT_ORCH_NOTIFY = 'off';
  f.env.AGENT_ORCH_ESCALATE_AFTER = '1500ms';
  const output = path.join(f.root, 'notices.jsonl');
  const script = path.join(f.root, 'notify.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
let text=''; for await (const chunk of process.stdin) text+=chunk;
fs.appendFileSync(process.argv[2], text);
`);
  writeJson(path.join(f.state, 'notify.json'), { command: [process.execPath, script, output] });
  return {
    output,
    messages: () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    records: () => fs.existsSync(path.join(f.state, 'escalations.json')) ? readJson(path.join(f.state, 'escalations.json')) : {},
  };
}

async function stopBoard(f, board) {
  await f.command(['dashboard', '--stop', '--port', new URL(board.url).port]);
  await eventually(async () => {
    try { await board.get('/api/health'); return false; } catch { return true; }
  }, 'dashboard stayed up');
}

test('escalation waits, pushes SSE, persists timers and notices across restarts, and repeats only for a new attempt', async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  const run = await f.newRun('escalation');
  await f.start(run, 'decision', { config: { finalMessage: 'NEEDS DECISION: Which service?' } });
  await f.finished(run, 'decision');
  await f.start(run, 'review', { config: { finalMessage: 'Ready to review.' } });
  await f.finished(run, 'review');
  await f.start(run, 'handled', { config: { status: 'failed', error: 'Missing service' } });
  await f.finished(run, 'handled');
  let board = await f.dashboard();
  // The decision, the uncollected review and the failure each start a timer.
  await eventually(() => Object.keys(notify.records()).length === 3);
  const pending = Object.values(notify.records()).find((r) => r.task === 'decision');
  assert.equal(pending.escalatedAt, undefined);
  assert.equal(notify.messages().length, 0, 'no immediate escalation');
  await f.command(['close', run.id, 'handled', 'review']);
  await stopBoard(f, board);
  board = await f.dashboard();
  const abort = new AbortController();
  const response = await fetch(new URL('/api/presence', board.url), { signal: abort.signal });
  const reader = response.body.getReader();
  let events = '';
  const reading = (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; events += new TextDecoder().decode(value); } }
    catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  try {
    await eventually(() => notify.messages().length === 1, 'no notification', 20_000); // a loaded machine starves the dashboard's timers
    await eventually(() => events.includes('event: escalation'), 'no SSE escalation', 20_000);
    const message = notify.messages()[0];
    assert.deepEqual(Object.keys(message).sort(), ['kind', 'reason', 'run', 'task', 'url', 'waited']);
    assert.equal(message.run, run.id);
    assert.equal(message.task, 'decision');
    assert.equal(message.kind, 'needs-decision');
    assert.match(message.reason, /Which service/);
    assert.ok(message.waited >= 1500);
    assert.equal(message.url, board.url);
    const record = Object.values(notify.records()).find((r) => r.task === 'decision');
    assert.equal(record.since, pending.since, 'restart preserves the pending timer');
    const event = events.split('\n').find((line) => line.startsWith('data: {'));
    const pushed = JSON.parse(event.slice(6));
    assert.match(pushed.text, /decision · Black-box CLI fixture · Which service/);
    const section = (await board.json('/api/state')).find((s) => s.tasks.some((row) => row.id === 'decision'));
    assert.equal(pushed.key, `${section.id}/${section.tasks.find((row) => row.id === 'decision').key}`);
    assert.equal(Object.values(notify.records()).some((r) => ['review', 'handled'].includes(r.task)), false);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
    await reading;
  }
  await delay(2000);
  assert.equal(notify.messages().length, 1, 'one notice per item');
  await stopBoard(f, board);
  board = await f.dashboard();
  await delay(2000);
  assert.equal(notify.messages().length, 1, 'a restart must not resend');
  await f.command(['start', run.id, 'decision', '--agent', 'claude', '--why', 'Resume the fixture',
    '--brief', f.brief('decision-again', { finalMessage: 'NEEDS DECISION: Second attempt question.' }), '--', '--session', 'fixture-claude']);
  await f.finished(run, 'decision');
  await eventually(() => notify.messages().length === 2, 'new attempt did not escalate');
  const sent = Object.values(notify.records()).filter((r) => r.escalatedAt);
  assert.deepEqual(sent.map((r) => r.attempt).sort(), [1, 2]);
  assert.ok(sent.every((r) => r.kind === 'needs-decision'));
  assert.equal((await board.json('/api/health')).url, board.url);
});

test('failed, dead, silent and uncollected finished tasks escalate, but closed tasks do not', async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  f.env.AGENT_ORCH_ESCALATE_AFTER = '100ms';
  const run = await f.newRun();
  await f.start(run, 'failed', { config: { status: 'failed', error: 'Usage limit reached' } });
  await f.finished(run, 'failed');
  const dead = await f.start(run, 'dead');
  await f.finished(run, 'dead');
  fs.unlinkSync(path.join(dead.outDir, 'result.json'));
  await f.start(run, 'closed', { config: { status: 'failed' } });
  await f.finished(run, 'closed');
  await f.command(['close', run.id, 'closed']);
  await f.start(run, 'review');
  await f.finished(run, 'review');
  const silent = await f.start(run, 'silent', { config: { delayMs: 30_000 } });
  await f.ready(silent);
  await eventually(() => fs.existsSync(path.join(silent.outDir, 'events.jsonl')));
  const old = new Date(Date.now() - 16 * 60_000);
  fs.utimesSync(path.join(silent.outDir, 'events.jsonl'), old, old);
  await f.dashboard();
  await eventually(() => notify.messages().length === 4);
  assert.deepEqual(notify.messages().map((m) => [m.task, m.kind]).sort(), [['dead', 'dead'], ['failed', 'failed'], ['review', 'awaiting-review'], ['silent', 'silent']]);
});

for (const failure of ['exit', 'spawn', 'config', 'timeout']) {
  test(`notification ${failure} failures are recorded without crashing or retrying`, async (t) => {
    const f = await fixture(t);
    const notify = notifier(f);
    f.env.AGENT_ORCH_ESCALATE_AFTER = '100ms';
    if (failure === 'timeout') {
      // Shorten only the delivery timeout; the production code still uses 60 seconds.
      const preload = path.join(f.root, 'timeout.cjs');
      fs.writeFileSync(preload, 'const original=setTimeout;global.setTimeout=(fn,ms,...args)=>original(fn,ms===60000?100:ms,...args);');
      f.env.NODE_OPTIONS = `--require=${preload}`;
    }
    const command = failure === 'spawn' ? ['/no-such-orch-notifier'] : failure === 'config' ? ['relative-program'] :
      [process.execPath, '-e', failure === 'timeout' ? 'process.stdin.resume();setInterval(()=>{},1000)' : 'process.stderr.write("delivery unavailable");process.exit(7)'];
    writeJson(path.join(f.state, 'notify.json'), { command });
    const run = await f.newRun();
    await f.start(run, 'failed', { config: { status: 'failed' } });
    await f.finished(run, 'failed');
    const board = await f.dashboard();
    const failed = await eventually(() => Object.values(notify.records()).find((r) => r.deliveries?.command?.error));
    assert.match(failed.deliveries.command.error, failure === 'exit' ? /exit 7.*delivery unavailable/ : failure === 'spawn' ? /ENOENT/ : failure === 'timeout' ? /timed out after 60 seconds/ : /absolute program path/);
    assert.equal((await board.json('/api/health')).url, board.url);
    const at = failed.deliveries.command.at;
    await delay(1100);
    assert.equal(Object.values(notify.records())[0].deliveries.command.at, at);
  });
}

test('macOS notifications use a literal spawn argument array', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  const notify = notifier(f);
  delete f.env.AGENT_ORCH_NOTIFY;
  f.env.AGENT_ORCH_ESCALATE_AFTER = '100ms';
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const captured = path.join(f.root, 'osascript.json');
  fs.writeFileSync(path.join(bin, 'osascript'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  f.env.PATH = `${bin}${path.delimiter}${f.env.PATH}`;
  const run = await f.newRun();
  await f.start(run, 'failed', { config: { status: 'failed', error: 'Failed "quoted" \\ path; $(touch nope)' } });
  await f.finished(run, 'failed');
  await f.dashboard();
  await eventually(() => fs.existsSync(captured));
  const argv = readJson(captured);
  assert.equal(argv.length, 2);
  assert.equal(argv[0], '-e');
  assert.ok(argv[1].includes('display notification "failed · Black-box CLI fixture · Failed \\"quoted\\" \\\\ path; $(touch nope)"'), argv[1]);
  assert.ok(argv[1].endsWith('with title "Agent Orchestrator needs attention"'));
  await eventually(() => Object.values(notify.records())[0]?.deliveries?.macos);
  assert.equal(Object.values(notify.records())[0].deliveries.macos.error, null);
});

test('the browser asks once from a click and granted notifications focus and select the session', async (t) => {
  const f = await fixture(t);
  const board = await f.dashboard();
  const app = await (await board.get('/app.js')).text();
  await board.checkScript(app);
  const callbacks = {};
  const stored = new Map();
  let asked = 0, focused = 0, selected = null, lastNotice;
  class Notification {
    static permission = 'default';
    static requestPermission() { asked++; return Promise.resolve('default'); }
    constructor(title, options) { this.title = title; this.options = options; lastNotice = this; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    Notification, window: { Notification, focus: () => focused++ },
    localStorage: { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v) },
    document: { getElementById: () => ({ addEventListener: (k, fn) => { callbacks[k] = fn; }, scrollTo() {}, click: () => callbacks.click() }) },
    refresh: async () => {}, reveal: (key) => { selected = key; },
  });
  const permissions = app.slice(app.indexOf('let notificationAsked='), app.indexOf('// Hold a panel'));
  vm.runInContext(permissions, context);
  assert.equal(asked, 0, 'no prompt on load');
  callbacks.click(); callbacks.click();
  assert.equal(asked, 1);
  const reloaded = vm.createContext({ ...context });
  vm.runInContext(permissions, reloaded);
  callbacks.click();
  assert.equal(asked, 1, 'a dismissed request stays remembered after reload');
  vm.runInContext(app.slice(app.indexOf('function showEscalation('), app.indexOf('presence.addEventListener("escalation"')), context);
  const event = { data: JSON.stringify({ run: 'run', task: 'task', attempt: 1, kind: 'failed', key: 'section/task', text: 'task · run · failed' }) };
  context.showEscalation(event);
  assert.equal(lastNotice, undefined);
  Notification.permission = 'granted';
  context.showEscalation(event);
  assert.equal(lastNotice.options.body, 'task · run · failed');
  lastNotice.onclick();
  await Promise.resolve();
  assert.equal(focused, 1);
  assert.equal(selected, 'section/task');
  assert.equal(lastNotice.closed, true);
  assert.match(app, /presence\.addEventListener\("escalation",showEscalation\)/);
  assert.match(await (await board.get('/')).text(), /id="need" role="button" tabindex="0"/);
});

test('wait help documents exit 5 and every appended brief tells blocked agents to report immediately', async (t) => {
  const f = await fixture(t);
  assert.match((await f.command(['wait', '--help'])).stdout, /newly needs attention \(exit 5\)/);
  assert.match((await f.command(['--help'])).stdout, /newly needs attention \(exit 5\)/);
  const run = await f.newRun();
  const started = await f.start(run, 'brief');
  await f.ready(started);
  const invocation = readJson(path.join(started.outDir, 'invocation.json'));
  const text = fs.readFileSync(invocation.argv[invocation.argv.indexOf('--brief') + 1], 'utf8');
  assert.match(text, /a gate cannot run here, a credential or service is missing, or the same failure has survived two fix attempts/);
  assert.match(text, /stop and report it right away in your final message, with the exact command and error/);
  assert.match(text, /Do not keep retrying or work around it silently/);
  assert.match(text, /Nobody reads your messages until your session ends/);
  assert.match(text, /Hand back only a decision beyond this brief/);
});
