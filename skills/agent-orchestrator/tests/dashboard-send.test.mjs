import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { fixture } from './helpers.mjs';

const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
const inboxFile = (run, id) => path.join(run.dir, 'tasks', id, 'inbox.jsonl');

// A raw request, so a test can send any Host, Origin and content type, as another page could.
function request(url, { method = 'POST', headers = {}, body = '' } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/send', method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (s) => { text += s; }).on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', (error) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(error)));
    req.end(body);
  });
}

async function dashboardWithTask(t) {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'steer', { config: { hold: true } });
  await f.ready(task);
  const dash = await f.dashboard();
  // The send key is never served over HTTP; only the user's own files hold it.
  const state = await dash.get('api/state');
  assert.equal(state.headers.get('x-orch-token'), null);
  const keyFile = path.join(f.state, 'dashboard-token');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const token = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/);
  const origin = new URL(dash.url).origin;
  const post = (value, headers = {}) => request(dash.url, {
    headers: { origin, 'content-type': 'application/json', 'x-orch-token': token, ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return { f, run, task, dash, token, origin, post };
}

test('the dashboard sends a message to a running task, marked as from the user', async (t) => {
  const { f, run, task, post } = await dashboardWithTask(t);
  const sent = await post({ run: run.id, task: 'steer', text: '  Use the v2 API  ' });
  assert.equal(sent.status, 200, sent.text);
  const reply = JSON.parse(sent.text);
  assert.match(reply.delivery, /orch-inbox hook|inbox/);
  const stored = fs.readFileSync(inboxFile(run, 'steer'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(stored.map((m) => [m.id, m.text, m.from, m.attempt]), [[reply.id, 'Use the v2 API', 'user', 1]]);
  const inbox = await f.command(['inbox', run.id, 'steer', '--all']);
  assert.match(inbox.stdout, new RegExp(`\\[${reply.id}\\] Message from the user, sent from the orchestrator dashboard, `));
  // The agent's hook says who sent it.
  const delivered = await new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'steer' } });
    let out = '';
    child.stdout.on('data', (s) => { out += s; });
    child.on('close', () => resolve(out));
    child.stdin.end('{}');
  });
  const { USER_FIRST, replyHint } = await import('../scripts/lib/inbox.mjs');
  assert.equal(JSON.parse(delivered).hookSpecificOutput.additionalContext, `Message from the user, sent from the orchestrator dashboard (${reply.time}): Use the v2 API\n${USER_FIRST} ${replyHint(run.id, 'steer')}`);
  assert.match(USER_FIRST, /handle it now, before your next step/);
  assert.match(replyHint(run.id, 'steer'), /orch\.mjs reply .* steer "<your answer>"/);
  const row = (await f.json(['status', run.id])).tasks.find((row) => row.id === 'steer');
  assert.deepEqual(row.inbox.messages.map((m) => [m.from, m.read, m.text]), [['user', true, 'Use the v2 API']]);
  f.release(task);
  await f.finished(run, 'steer');
});

test('the dashboard refuses messages that do not come from its own page', async (t) => {
  const { run, dash, token, origin, post } = await dashboardWithTask(t);
  const body = { run: run.id, task: 'steer', text: 'hello' };
  const port = new URL(dash.url).port;
  const refusals = [
    ['no token', await post(body, { 'x-orch-token': '' }), 403],
    ['a wrong token', await post(body, { 'x-orch-token': 'f'.repeat(48) }), 403],
    ['no Origin', await request(dash.url, { headers: { 'content-type': 'application/json', 'x-orch-token': token }, body: JSON.stringify(body) }), 403],
    ['another Origin', await post(body, { origin: 'https://evil.example' }), 403],
    ['a rebound Host', await post(body, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), 403],
    ['a form post', await post('run=x', { 'content-type': 'application/x-www-form-urlencoded' }), 415],
    ['a GET', await request(dash.url, { method: 'GET', headers: { origin, 'x-orch-token': token } }), 405],
    ['bad JSON', await post('{', {}), 400],
    ['a bad task id', await post({ ...body, task: '../x' }), 400],
    ['an unknown run', await post({ ...body, run: 'no-such-run' }), 404],
    ['an unknown task', await post({ ...body, task: 'nope' }), 404],
    ['an empty message', await post({ ...body, text: '   ' }), 400],
    ['a non-text message', await post({ ...body, text: 7 }), 400],
    ['a run that is not text', await post({ ...body, run: { toString: null } }), 400],
    ['a body that is not an object', await post('null'), 400],
  ];
  for (const [what, got, status] of refusals) assert.equal(got.status, status, `${what}: ${got.text}`);
  const big = await post({ ...body, text: 'x'.repeat(70 * 1024) });
  assert.ok(big.status === 413 || big.status === 'reset', `an oversized message: ${big.status}`);
  assert.equal(fs.existsSync(inboxFile(run, 'steer')), false);
  // A rebound Host gets nothing at all, so it cannot read the token either.
  const rebound = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}` } }, (res) => {
    res.resume();
    resolve({ status: res.statusCode, token: res.headers['x-orch-token'] });
  }));
  assert.deepEqual(rebound, { status: 403, token: undefined });
  // None of those requests stopped the server.
  assert.equal((await dash.get('api/health')).status, 200);
});

test('the dashboard keeps its send key across restarts', async (t) => {
  const f = await fixture(t);
  await f.dashboard();
  const keyFile = path.join(f.state, 'dashboard-token');
  const first = fs.readFileSync(keyFile, 'utf8');
  await f.command(['dashboard', '--stop']);
  await f.dashboard();
  assert.equal(fs.readFileSync(keyFile, 'utf8'), first);
});

test('the Host check: loopback names, the --host address, and every name on a wildcard address for reading only', async () => {
  const { servesHost } = await import('../scripts/lib/dashboard-server.mjs');
  const cases = [
    ['127.0.0.1:4777', '127.0.0.1', {}, true], ['LOCALHOST:4777', '127.0.0.1', {}, true], ['[::1]:4777', '127.0.0.1', {}, true],
    ['127.0.0.1:4778', '127.0.0.1', {}, false], ['evil.example:4777', '127.0.0.1', {}, false], [undefined, '127.0.0.1', {}, false],
    ['192.168.1.5:4777', '192.168.1.5', {}, true], ['192.168.1.5:4777', '0.0.0.0', {}, true], ['0.0.0.0:4777', '0.0.0.0', {}, true],
    ['192.168.1.5:4777', '0.0.0.0', { loopbackOnly: true }, false], ['127.0.0.1:4777', '0.0.0.0', { loopbackOnly: true }, true],
    ['192.168.1.5:4777', '192.168.1.5', { loopbackOnly: true }, false], ['localhost:4777', '192.168.1.5', { loopbackOnly: true }, true],
  ];
  for (const [header, host, opts, expected] of cases) assert.equal(servesHost(header, host, 4777, opts), expected, `${header} on ${host}`);
});

test('the dashboard refuses a message to a task that is not running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'done');
  await f.finished(run, 'done');
  const dash = await f.dashboard();
  const token = fs.readFileSync(path.join(f.state, 'dashboard-token'), 'utf8').trim();
  const got = await request(dash.url, {
    headers: { origin: new URL(dash.url).origin, 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify({ run: run.id, task: 'done', text: 'hello' }),
  });
  assert.equal(got.status, 409);
  assert.match(JSON.parse(got.text).error, /task done is not running \(completed\); resume it with a delta brief/);
});

// Another account can listen on a loopback port once the dashboard stops. Whatever answers there
// is reused, and handed the send key by --open, only if this account's own dashboard runs it.
test('dashboard does not reuse a foreign server that answers on its port', async (t) => {
  const f = await fixture(t);
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/health' ? { pid: process.pid, tabs: 1, pageAgoMs: 0 } : []));
  });
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const port = foreign.address().port;
  t.after(() => f.command(['dashboard', '--stop']).catch(() => {}));
  const started = await f.json(['dashboard', '--detach', '--port', String(port)]);
  assert.equal(started.reused, undefined);
  assert.notEqual(new URL(started.url).port, String(port));
  assert.equal((await fetch(new URL('api/health', started.url))).status, 200);
});

// A tiny valid PNG, built the way the format defines it.
function png() {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(2, 0); head.writeUInt32BE(2, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.alloc(14))), chunk('IEND', Buffer.alloc(0))]);
}

test('the dashboard sends images with a message, saved where only the user can read them', async (t) => {
  const { f, run, task, post } = await dashboardWithTask(t);
  const image = png();
  const sent = await post({ run: run.id, task: 'steer', text: 'Compare with this screenshot', images: [{ data: image.toString('base64') }] });
  assert.equal(sent.status, 200, sent.text);
  const { images: [file] } = JSON.parse(sent.text);
  assert.match(file, new RegExp(`${run.id}/tasks/steer/attachments/[^/]+-1\\.png$`));
  assert.deepEqual(fs.readFileSync(file), image);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const [stored] = fs.readFileSync(inboxFile(run, 'steer'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(stored.body, 'Compare with this screenshot');
  assert.deepEqual(stored.images, [file]);
  assert.match(stored.text, new RegExp(`^Compare with this screenshot\\n\\nAttached image: open it with your image-viewing tool[^\\n]*\\n- ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  // An image alone is a message too.
  assert.equal((await post({ run: run.id, task: 'steer', text: '', images: [{ data: image.toString('base64') }] })).status, 200);
  const row = (await f.json(['status', run.id])).tasks.find((r) => r.id === 'steer');
  assert.deepEqual(row.inbox.messages.map((m) => [m.text, m.images]), [['Compare with this screenshot', 1], ['', 1]]);
  for (const [what, images, status] of [
    ['not an image', [{ data: Buffer.from('hello there, world').toString('base64') }], 400],
    ['five images', Array.from({ length: 5 }, () => ({ data: image.toString('base64') })), 400],
    ['not base64', [{ data: '***' }], 400],
  ]) assert.equal((await post({ run: run.id, task: 'steer', text: 'x', images })).status, status, what);
  assert.equal(fs.readdirSync(path.join(run.dir, 'tasks', 'steer', 'attachments')).length, 2);
  f.release(task);
  await f.finished(run, 'steer');
});

test('the event log shows each message where it was sent and where the agent received it', async (t) => {
  const { f, run, task, dash, post } = await dashboardWithTask(t);
  const events = path.join(task.outDir, 'events.jsonl');
  const before = (await (await dash.get(`api/events?run=${run.id}&task=steer`)).json()).events.length;
  assert.equal((await post({ run: run.id, task: 'steer', text: 'Use the v2 API' })).status, 200);
  fs.appendFileSync(events, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still reading the code.' }] } })}\n`);
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'steer' } });
    child.on('close', resolve);
    child.stdin.end('{}');
  });
  fs.appendFileSync(events, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Switching to the v2 API.' }] } })}\n`);
  const log = (await (await dash.get(`api/events?run=${run.id}&task=steer`)).json()).events.slice(before);
  assert.deepEqual(log.map((e) => [e.kind, e.text]), [
    ['sent', 'You: Use the v2 API'],
    ['says', 'Still reading the code.'],
    ['received', 'The agent received your message: Use the v2 API'],
    ['says', 'Switching to the v2 API.'],
  ]);
  f.release(task);
  await f.finished(run, 'steer');
});

test('an agent answers the user with reply, shown under the message and highlighted in its log', async (t) => {
  const { f, run, task, dash, post } = await dashboardWithTask(t);
  const events = path.join(task.outDir, 'events.jsonl');
  const sent = JSON.parse((await post({ run: run.id, task: 'steer', text: 'Why did you drop the label?' })).text);
  // Before it has read anything, reply answers the latest message from the user.
  await f.command(['reply', run.id, 'steer', 'Reply to the user: The orchestrator removed it; I left it as set.']);
  fs.appendFileSync(events, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reply to the user: and I will keep watching.' }] } })}\n`);
  const row = (await f.json(['status', run.id])).tasks.find((r) => r.id === 'steer');
  assert.deepEqual(row.inbox.messages[0].replies.map((r) => r.text), ['The orchestrator removed it; I left it as set.']);
  assert.equal(row.inbox.lastReply.to, sent.id);
  const log = (await (await dash.get(`api/events?run=${run.id}&task=steer`)).json()).events;
  assert.deepEqual(log.filter((e) => e.kind === 'reply').map((e) => e.text), ['The orchestrator removed it; I left it as set.', 'and I will keep watching.']);
  const inbox = await f.command(['inbox', run.id, 'steer', '--all']);
  assert.match(inbox.stdout, /\n  replied [^:]+:\d\d:[\d.]+Z: The orchestrator removed it; I left it as set\./);
  // --to must name a message from the user.
  const wrong = await f.command(['reply', run.id, 'steer', 'x', '--to', 'nope'], { code: 2 });
  assert.match(wrong.stderr, /no message nope from the user/);
  f.release(task);
  await f.finished(run, 'steer');
});

test('reply refuses a task with no message from the user', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'quiet');
  await f.finished(run, 'quiet');
  const refused = await f.command(['reply', run.id, 'quiet', 'hello'], { code: 2 });
  assert.match(refused.stderr, /has no message from the user to answer/);
});
