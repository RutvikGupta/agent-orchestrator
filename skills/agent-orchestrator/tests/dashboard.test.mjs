import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, eventually, jsonl } from './helpers.mjs';
import { claudeTranscripts, codexTranscript } from './fixtures/transcripts.mjs';

test('dashboard HTTP API and native transcript states', async (t) => {
  const f = await fixture(t);
  const first = await f.newRun('first');
  const second = await f.newRun('second');
  const other = await f.newRun('other-session');
  f.launchingSession(first, 'session-a');
  f.launchingSession(second, 'session-a');
  f.launchingSession(other, 'session-b');
  const transcripts = claudeTranscripts(f, 'session-a');
  claudeTranscripts(f, 'session-b');
  const codexFile = codexTranscript(f);
  for (const agent of ['claude', 'codex']) {
    await f.start(second, `${agent}-task`, { agent, config: { finalMessage: `${agent} dashboard report` }, flags: ['--read-only'] });
    await f.finished(second, `${agent}-task`);
  }
  const board = await f.dashboard();

  await t.test('/api/state groups runs by launching session without duplicate main rows', async () => {
    const state = await board.json('/api/state');
    assert.equal(state.length, 2);
    const a = state.find((s) => s.orchestrator.sessionId === 'session-a');
    const b = state.find((s) => s.orchestrator.sessionId === 'session-b');
    assert.ok(a && b);
    assert.deepEqual(a.runs.map((r) => r.id).sort(), [first.id, second.id].sort());
    assert.deepEqual(b.runs.map((r) => r.id), [other.id]);
    // The plan graph view is gone: a run entry has its goal, start and parent task, and no graph.
    for (const run of [...a.runs, ...b.runs]) assert.deepEqual(Object.keys(run).sort(), ['createdAt', 'goal', 'id', 'parent']);
    assert.equal(a.tasks.filter((row) => row.main).length, 1);
    assert.equal(a.tasks.filter((row) => row.native).length, 4);
    for (const agent of ['claude', 'codex']) {
      const row = a.tasks.find((row) => row.id === `${agent}-task`);
      assert.equal(row.state, 'completed');
      assert.equal(row.finalMessage, `${agent} dashboard report`);
      assert.equal(row.exitCode, 0);
    }
  });

  for (const expected of ['running', 'completed', 'stopped', 'needs-decision']) {
    await t.test(`native Claude sub-agent is ${expected} in state and status`, async () => {
      const state = await board.json('/api/state');
      const section = state.find((s) => s.orchestrator.sessionId === 'session-a');
      const row = section.tasks.find((row) => row.native && row.id === expected);
      assert.ok(row);
      assert.equal(row.state, expected);
      assert.equal(row.closed, expected !== 'running');
      if (expected === 'needs-decision') assert.deepEqual(row.decisions, ['Which scope should I use? Recommendation: keep the scope.']);
      const status = await f.command(['status', second.id]);
      const line = status.stdout.split('\n').find((line) => line.trim().startsWith(`${expected} `));
      assert.ok(line, status.stdout);
      assert.match(line, new RegExp(`native\\s+${expected}\\s`));
    });
  }

  await t.test('compaction leaves the main session idle and its model includes effort', async () => {
    const state = await board.json('/api/state');
    const main = state.find((s) => s.orchestrator.sessionId === 'session-a').tasks.find((row) => row.main);
    assert.equal(main.state, 'idle');
    assert.match(main.modelLabel, /opus-5-5.*xhigh/);
    const status = await f.command(['status', second.id]);
    assert.match(status.stdout, /main session.*opus-5-5 xhigh · idle/);
  });

  await t.test('/api/events returns both stream formats and rejects malformed or unknown runs', async () => {
    for (const agent of ['claude', 'codex']) {
      const body = await board.json(`/api/events?run=${second.id}&task=${agent}-task`);
      assert.ok(body.events.some((event) => event.text.includes(`${agent} dashboard report`)));
    }
    assert.equal((await board.get('/api/events?run=../../outside&task=x')).status, 400);
    assert.equal((await board.get('/api/events?run=missing&task=x')).status, 404);
    assert.deepEqual(await board.json(`/api/events?run=${second.id}&task=missing`), { events: [] });
  });

  await t.test('/api/transcript reads Claude and Codex fixtures and refuses outside paths and symlinks', async () => {
    const get = (file) => board.get(`/api/transcript?file=${encodeURIComponent(file)}`);
    for (const [file, text] of [[transcripts.main, 'The main turn finished.'], [codexFile, 'Codex fixture transcript reply.']]) {
      const response = await get(file);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.events.some((event) => event.text.includes(text)), `${file}: ${JSON.stringify(body)}`);
    }
    const outside = jsonl(path.join(f.root, 'private.jsonl'), [{ type: 'user', message: { content: 'private fixture data' } }]);
    const sibling = jsonl(path.join(f.claude, 'projects-elsewhere', 'private.jsonl'), []);
    const symlink = path.join(f.claude, 'projects', 'escape.jsonl');
    fs.symlinkSync(outside, symlink);
    for (const file of [outside, sibling, symlink]) {
      const response = await get(file);
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /not a session transcript/);
    }
    const wrongExtension = path.join(f.claude, 'projects', 'notes.txt');
    fs.writeFileSync(wrongExtension, 'not a transcript');
    assert.equal((await get(wrongExtension)).status, 403);
    assert.equal((await get(path.join(f.root, 'missing.jsonl'))).status, 404);
  });

  await t.test('/api/presence opens an SSE stream and releases its tab on disconnect', async () => {
    const controller = new AbortController();
    const response = await fetch(new URL('/api/presence', board.url), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    const reader = response.body.getReader();
    try {
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), /: open/);
      assert.equal((await board.json('/api/health')).tabs, 1);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    await eventually(async () => (await board.json('/api/health')).tabs === 0, 'presence tab leaked');
  });

  await t.test('page scripts (inline or served) parse with node --check; logo and missing routes have correct types', async () => {
    const page = await board.get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    const scripts = [];
    for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
      if (!src) {
        scripts.push(body);
        continue;
      }
      const served = await board.get(`/${src.replace(/^\.?\//, '')}`);
      assert.equal(served.status, 200, `${src} must be served`);
      assert.match(served.headers.get('content-type'), /javascript/);
      scripts.push(await served.text());
    }
    assert.ok(scripts.some((script) => script.trim()), 'dashboard must load its application script');
    for (const script of scripts) await board.checkScript(script);
    // No graph view on the page: no layout code, no toggle, no styles.
    const css = await (await board.get('/app.css')).text();
    for (const text of [...scripts, css]) assert.doesNotMatch(text, /graphLayout|graphShown|gnode|gpanel|orchGraphView|class:"view"/);
    const logo = await board.get('/logo.svg');
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await logo.text(), /<svg[^>]+viewBox=/);
    assert.equal((await board.get('/does-not-exist')).status, 404);
  });

  await t.test('dashboard --stop removes its state record', async () => {
    const result = await f.json(['dashboard', '--stop', '--port', new URL(board.url).port]);
    assert.equal(result.stopped, true);
    assert.equal(result.url, board.url);
    assert.equal(fs.existsSync(path.join(f.state, 'dashboard.json')), false);
    // Fixture teardown also waits for the exact child and binds its former port.
  });
});

// Defect: the board took the 25 newest active runs, so a long run created early dropped off the board
// while its relay still ran. A run counts toward the cap while it is active: not older than the idle
// window, whether or not it has tasks. Runs with a live process show however old they are.
test('a run whose relay is alive stays on the board when 25 newer runs fill its cap', async (t) => {
  const f = await fixture(t);
  const long = await f.newRun('long-run');
  const worker = await f.start(long, 'worker', { config: { hold: true } });
  await f.ready(worker);
  // 26 runs created after it, each active (created now, so within the idle window); they take the
  // cap's 25 places in newest-first order. Written directly: each is a run record with no tasks.
  const template = JSON.parse(fs.readFileSync(path.join(long.dir, 'run.json'), 'utf8'));
  const start = Date.parse(template.createdAt) + 1000;
  const newer = Array.from({ length: 26 }, (_, i) => {
    const createdAt = new Date(start + i * 1000).toISOString();
    const id = `${createdAt.slice(0, 19).replaceAll(/[-:]/g, '').replace('T', '-')}-filler-${String(i).padStart(2, '0')}`;
    const dir = path.join(f.state, 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...template, id, createdAt, goal: `Filler ${i}`, dir: undefined }));
    return id;
  });
  const board = await f.dashboard();

  const state = await board.json('/api/state');
  const shown = new Set(state.flatMap((s) => s.runs.map((r) => r.id)));
  assert.ok(shown.has(long.id), 'the run with a live relay is on the board');
  const row = state.flatMap((s) => s.tasks).find((r) => r.run === long.id && r.id === 'worker');
  assert.equal(row?.state, 'running');
  // The cap still holds for the rest: the 25 newest fillers show, the oldest one does not.
  assert.deepEqual(newer.filter((id) => shown.has(id)), newer.slice(1), 'the 25 newest of the other runs are listed');
  assert.ok(!shown.has(newer[0]), 'a run that is not live and over the cap stays off the board');
  f.release(worker);
  await f.finished(long, 'worker');
});

// A finished run past the cap still shows while a task of it waits on someone: unclosed, and
// finished within the idle window. A closed one does not.
test('a finished run with an unclosed task stays on the board past the cap; a closed one does not', async (t) => {
  const f = await fixture(t);
  const waiting = await f.newRun('waiting-review');
  await f.start(waiting, 'reviewer', { config: { finalMessage: 'Found one issue.' } });
  await f.finished(waiting, 'reviewer');
  const done = await f.newRun('all-closed');
  await f.start(done, 'helper', { config: { finalMessage: 'Done.' } });
  await f.finished(done, 'helper');
  await f.command(['close', done.id, 'helper']);
  const template = JSON.parse(fs.readFileSync(path.join(done.dir, 'run.json'), 'utf8'));
  const start = Date.parse(template.createdAt) + 1000;
  for (let i = 0; i < 25; i++) {
    const createdAt = new Date(start + i * 1000).toISOString();
    const id = `${createdAt.slice(0, 19).replaceAll(/[-:]/g, '').replace('T', '-')}-filler-${String(i).padStart(2, '0')}`;
    const dir = path.join(f.state, 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...template, id, createdAt, goal: `Filler ${i}`, dir: undefined }));
  }
  const board = await f.dashboard();
  const shown = new Set((await board.json('/api/state')).flatMap((s) => s.runs.map((r) => r.id)));
  assert.ok(shown.has(waiting.id), 'the run whose task awaits review is on the board');
  assert.ok(!shown.has(done.id), 'a run with every task closed stays capped');
});
