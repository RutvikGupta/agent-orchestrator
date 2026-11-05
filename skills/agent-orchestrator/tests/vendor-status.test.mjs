import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { eventually, fixture, jsonl, writeJson } from './helpers.mjs';
import { claudeTranscripts, codexTranscript } from './fixtures/transcripts.mjs';

// Exercise the public dashboard with isolated homes, fake Claude CLI and a Unix WebSocket daemon.
// Advancing Date.now via a child-only preload tests cache expiry without timing sleeps.
async function setup(t, mode = 'ok') {
  const f = await fixture(t);
  const clock = path.join(f.root, 'clock.json');
  writeJson(clock, 0);
  const preload = path.join(f.root, 'clock.cjs');
  const probeTimes = path.join(f.root, 'probe-times.jsonl');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const now = Date.now;
Date.now = () => now() + JSON.parse(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
// Measure only the Codex child boundary, excluding Claude probes and HTTP rendering.
const cp = require('node:child_process'), spawnSync = cp.spawnSync;
cp.spawnSync = function(bin, args, options) {
 const started = performance.now();
 const result = spawnSync(bin, args, options);
 if (args?.includes('--read-codex-status')) fs.appendFileSync(${JSON.stringify(probeTimes)},
   JSON.stringify({ms:performance.now()-started,status:result.status})+'\\n');
 return result;
};
// The dashboard server probes in the background, through spawn.
const spawn = cp.spawn;
cp.spawn = function(bin, args, options) {
 const started = performance.now();
 const child = spawn(bin, args, options);
 if (args?.includes('--read-codex-status')) child.on('close', (status) => fs.appendFileSync(${JSON.stringify(probeTimes)},
   JSON.stringify({ms:performance.now()-started,status})+'\\n'));
 return child;
};
require('node:module').syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `--require=${preload}`;
  const controls = {}, calls = {}, requests = {};
  const bin = path.join(f.root, 'fake-claude');
  controls.claude = path.join(f.root, 'claude-control.json');
  calls.claude = path.join(f.root, 'claude-calls.jsonl');
  writeJson(controls.claude, { mode, rows: [] });
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controls.claude)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls.claude)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');
if (control.mode === 'failure') process.exit(1);
if (control.mode === 'timeout') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else if (control.mode === 'invalid') { console.log('not JSON'); process.exit(0); }
else console.log(JSON.stringify(control.rows));
`);
  fs.chmodSync(bin, 0o755);
  f.env.AGENT_ORCH_CLAUDE_BIN = mode === 'missing' ? `${bin}-missing` : bin;
  controls.codex = path.join(f.root, 'codex-control.json');
  calls.codex = path.join(f.root, 'codex-calls.jsonl');
  requests.codex = path.join(f.root, 'codex-requests.jsonl');
  writeJson(controls.codex, { mode, rows: [] });
  f.env.AGENT_ORCH_CODEX_APP_SERVER = '1';
  // The daemon itself uses a short target behind a CODEX_HOME symlink on macOS.
  const socketDir = fs.mkdtempSync('/tmp/orch-ws-');
  const socketPath = path.join(socketDir, 'daemon.sock');
  const controlDir = path.join(f.codex, 'app-server-control');
  fs.mkdirSync(controlDir);
  fs.symlinkSync(socketPath, path.join(controlDir, 'app-server-control.sock'));
  const sockets = new Set(), disconnections = [];
  let connections = 0, closed = 0;
  const daemon = http.createServer();
  daemon.on('connection', socket => {
    sockets.add(socket); connections++;
    fs.appendFileSync(calls.codex, JSON.stringify({connection: connections})+'\n');
    disconnections.push(new Promise(resolve => socket.on('close', () => { sockets.delete(socket); closed++; resolve(); })));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  // Server frames are unmasked. Split text messages into continuation frames and
  // interleave a ping so transport handling is exercised independently of JSON-RPC.
  const frame = (data, opcode = 1, final = true) => {
    data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const prefix = data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10;
    const head = Buffer.alloc(prefix);
    head[0] = (final ? 128 : 0) | opcode;
    head[1] = prefix === 2 ? data.length : prefix === 4 ? 126 : 127;
    if (prefix === 4) head.writeUInt16BE(data.length, 2);
    if (prefix === 10) head.writeBigUInt64BE(BigInt(data.length), 2);
    return Buffer.concat([head, data]);
  };
  daemon.on('upgrade', (req, socket, head) => {
    const control = JSON.parse(fs.readFileSync(controls.codex, 'utf8'));
    if (control.mode === 'handshake-timeout') return;
    if (control.mode === 'failure') { socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
      + (control.mode === 'bad-upgrade' ? 'invalid' : accept) + '\r\n\r\n');
    let buffer = head;
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        assert.ok(buffer[0] & 128, 'client sends complete frames');
        assert.ok(buffer[1] & 128, 'client frames are masked');
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + size) return;
        const opcode = buffer[0] & 15, mask = buffer.subarray(offset, offset+4);
        const data = Buffer.from(buffer.subarray(offset+4, offset+4+size));
        buffer = buffer.subarray(offset+4+size);
        for (let i=0; i<data.length; i++) data[i] ^= mask[i%4];
        if (opcode === 10) continue;
        assert.equal(opcode, 1);
        const msg = JSON.parse(data.toString());
        fs.appendFileSync(requests.codex, JSON.stringify(msg)+'\n');
        if (msg.method === 'initialized') continue;
        if (control.mode === 'timeout') continue;
        if (control.mode === 'disconnect') { socket.destroy(); return; }
        if (control.mode === 'bad-frame') { socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0])); return; }
        let result;
        if (msg.method === 'initialize') result = {userAgent:'fixture'};
        else if (msg.method === 'thread/loaded/list') {
          const offset = Number(msg.params.cursor || 0);
          result = {data:control.rows.slice(offset,offset+2).map(t=>t.id),
            nextCursor:offset+2<control.rows.length ? String(offset+2):null};
          if (control.mode === 'bad-page') result.data = {};
          if (control.mode === 'repeated-cursor') result.nextCursor = 'repeat';
        } else if (msg.method === 'thread/read') {
          assert.equal(msg.params.includeTurns, false);
          result = {thread:control.rows.find(t=>t.id===msg.params.threadId)};
          if (control.mode === 'bad-thread') result.thread = {id:msg.params.threadId,status:{type:'active',activeFlags:'invalid'}};
        } else assert.fail(`unexpected mutating request: ${msg.method}`);
        const reply = control.mode === 'invalid' ? 'not JSON'
          : control.mode === 'null-reply' ? 'null'
          : JSON.stringify(control.mode === 'rpc-error' ? {id:msg.id,error:{code:-1,message:'fixture'}} : {id:msg.id,result});
        const text = Buffer.from(reply);
        const split = Math.min(8, text.length);
        const packet = Buffer.concat([
          frame(JSON.stringify({method:'fixture/notification',params:{}})),
          frame(text.subarray(0, split), 1, false), frame('ping', 9), frame(text.subarray(split), 0),
        ]);
        // A partial frame header and coalesced frames in the same response.
        socket.write(packet.subarray(0, 1));
        socket.write(packet.subarray(1));
      }
    };
    socket.on('data', receive);
    if (head.length) receive(Buffer.alloc(0));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (daemon.listening) await new Promise(resolve => daemon.close(resolve));
    fs.rmSync(socketDir, {recursive:true,force:true});
  });
  if (mode === 'refused') {
    // Exit a fixture listener without unlinking its socket, leaving a real stale socket.
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))`, socketPath], {env:f.env});
    await once(child.stdout, 'data');
    const exited = once(child, 'close');
    child.kill('SIGKILL');
    await exited;
  } else if (mode !== 'missing') {
    const listening = once(daemon, 'listening');
    daemon.listen(socketPath);
    await listening;
  }
  const claude = await f.newRun('claude');
  f.launchingSession(claude, 'claude-main');
  claudeTranscripts(f, 'claude-main');
  const codex = await f.newRun('codex');
  codexTranscript(f);
  const codexId = '019a0000-0000-7000-8000-000000000001';
  f.launchingSession(codex, codexId, 'codex');
  const timestamp = new Date().toISOString();
  const childId = '019a0000-0000-7000-8000-000000000002';
  jsonl(path.join(f.codex, 'sessions', timestamp.slice(0,10).replaceAll('-', '/'), `rollout-${childId}.jsonl`), [
    {type:'session_meta', timestamp, payload:{id:childId, timestamp, cwd:f.repo,
      parent_thread_id:codexId, thread_source:'subagent', agent_path:'/root/child'}},
    {type:'event_msg', timestamp, payload:{type:'task_started'}},
  ]);
  let offset = 0;
  return { f, codexId, childId, controls, calls, requests, probeTimes,
    async disconnected() { await Promise.all(disconnections); return {connections, closed}; },
    set(agent, rows) { writeJson(controls[agent], {mode, rows}); },
    advance(ms) { offset += ms; writeJson(clock, offset); },
    log(file) { return fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse) : []; },
    async rows(board) { return (await board.json('/api/state')).flatMap(s=>s.tasks); },
  };
}

test('vendor status overrides main and native rows, keeps telemetry, and caches for five seconds', async (t) => {
  const s = await setup(t);
  s.set('claude', [
    {sessionId:'claude-main', kind:'interactive', status:'busy'},
    {sessionId:'running', kind:'background', state:'blocked', status:'waiting', waitingFor:'permission prompt'},
    {sessionId:'stopped', state:'working', status:'idle'},
    {sessionId:'completed', state:'stopped'},
    {sessionId:'needs-decision', state:'done'},
  ]);
  s.set('codex', [
    {id:s.codexId, status:{type:'active',activeFlags:[]}, model:'gpt-fixture'},
    {id:s.childId, status:{type:'active',activeFlags:['waitingOnUserInput']}},
    {id:'unrelated',status:{type:'idle'},cwd:'x'.repeat(66000)}, // pagination and 64-bit frame length
    {id:'failed',status:{type:'systemError'}},
  ]);
  const board = await s.f.dashboard();
  let rows = await s.rows(board);
  const bySession = (id) => rows.find(r=>r.session===id);
  assert.equal(bySession('claude-main').state, 'running');
  assert.equal(bySession('claude-main').stateSource, 'claude-agents');
  assert.equal(bySession('claude-main').tokensIn, 10);
  assert.match(bySession('claude-main').modelLabel, /opus-5-5/);
  assert.equal(bySession('running').state, 'needs-decision');
  assert.equal(bySession('running').waiting, true);
  assert.equal(bySession('running').closed, false);
  assert.equal(bySession('running').now, 'permission prompt');
  assert.equal(bySession('stopped').state, 'running');
  assert.equal(bySession('completed').state, 'stopped');
  assert.equal(bySession('needs-decision').state, 'completed');
  assert.equal(bySession('needs-decision').decisions, null);
  assert.equal(bySession(s.codexId).state, 'running');
  assert.equal(bySession(s.codexId).stateSource, 'codex-app-server');
  assert.equal(bySession(s.codexId).model, 'gpt-fixture');
  assert.equal(bySession(s.childId).state, 'needs-decision');
  assert.equal(bySession(s.childId).stateSource, 'codex-app-server');
  for (const agent of ['claude','codex']) assert.equal(s.log(s.calls[agent]).length, 1);
  assert.deepEqual(s.log(s.calls.claude)[0].args, ['agents','--json','--all']);
  assert.deepEqual([...new Set(s.log(s.requests.codex).map(m=>m.method))],
    ['initialize','initialized','thread/loaded/list','thread/read']);
  assert.equal(s.log(s.requests.codex).filter(m=>m.method==='thread/loaded/list').length, 2);

  s.set('claude', [{sessionId:'claude-main',status:'waiting',waitingFor:'input needed'}]);
  s.set('codex', [{id:s.codexId,status:{type:'idle'}}]);
  s.advance(1000);
  rows = await s.rows(board);
  assert.equal(bySession('claude-main').state, 'running');
  assert.equal(bySession(s.codexId).state, 'running');
  for (const agent of ['claude','codex']) assert.equal(s.log(s.calls[agent]).length, 1);
  // Once the cache expires, the next build starts a refresh in the background and keeps the last
  // answer; a later build shows the new one.
  s.advance(5000);
  rows = await s.rows(board);
  assert.equal(bySession('claude-main').state, 'running', 'a stale answer is served while the refresh runs');
  rows = await eventually(async () => {
    const next = await s.rows(board);
    return next.find((r) => r.session === 'claude-main')?.state === 'needs-decision' && next.find((r) => r.session === s.codexId)?.state === 'idle' ? next : null;
  }, 'the background refresh did not land');
  assert.equal(bySession('claude-main').state, 'needs-decision');
  assert.equal(bySession(s.codexId).state, 'idle');
  assert.equal(bySession('running').stateSource, 'transcript');
  assert.equal(bySession(s.childId).stateSource, 'transcript');
  for (const agent of ['claude','codex']) assert.equal(s.log(s.calls[agent]).length, 2);
  assert.deepEqual(await s.disconnected(), {connections:2,closed:2});
});

for (const mode of ['failure','timeout','missing','invalid']) {
  test(`vendor status falls back on ${mode} and caches failures`, async (t) => {
    const s = await setup(t, mode);
    const started = performance.now();
    const board = await s.f.dashboard();
    const rows = await s.rows(board);
    // Both vendors are read sequentially, each under two seconds; allow startup/HTTP overhead.
    if (mode === 'timeout') assert.ok(performance.now()-started < 6000);
    for (const row of rows.filter(r=>r.main||r.native)) assert.equal(row.stateSource,'transcript');
    assert.equal(rows.find(r=>r.session==='claude-main').state,'idle');
    assert.equal(rows.find(r=>r.session===s.codexId).state,'idle');
    assert.equal(rows.find(r=>r.session==='running').state,'running');
    assert.equal(rows.find(r=>r.session==='stopped').state,'stopped');
    s.advance(300);
    await s.rows(board);
    for (const agent of ['claude','codex']) {
      const calls = s.log(s.calls[agent]);
      assert.equal(calls.length,mode==='missing'?0:1);
      if (agent === 'claude') for (const call of calls) assert.throws(()=>process.kill(call.pid,0), {code:'ESRCH'}, 'probe child was reaped');
    }
  });
}

test('unreported, unknown and notLoaded statuses retain transcript state', async (t) => {
  const s = await setup(t);
  s.set('claude', [{sessionId:'claude-main',status:'new-vendor-status'}, {id:'running',state:'done'}, null]);
  s.set('codex', [{id:s.codexId,status:{type:'notLoaded'}}, {id:s.childId,status:{type:'new-status'}}]);
  const board = await s.f.dashboard();
  for (const row of await s.rows(board)) assert.equal(row.stateSource,'transcript');
});

for (const mode of ['refused','timeout','handshake-timeout','disconnect','bad-frame','bad-upgrade','bad-page','bad-thread','repeated-cursor','null-reply','rpc-error']) {
  test(`Codex daemon falls back on ${mode}`, async (t) => {
    const s = await setup(t, mode);
    writeJson(s.controls.claude, {mode:'ok',rows:[]});
    s.set('codex', [{id:s.codexId,status:{type:'idle'}}]);
    const board = await s.f.dashboard();
    // Dashboard startup primes the cache. Expire it before timing an actual refresh, which runs
    // in the background.
    s.advance(5000);
    await s.rows(board);
    const probes = await eventually(() => { const log = s.log(s.probeTimes); return log.length === 2 ? log : null; }, 'the background probe did not run');
    const rows = await s.rows(board);
    assert.equal(probes.length, 2, 'timing covers a fresh probe, not a cache hit');
    const elapsed = probes.at(-1).ms;
    assert.ok(elapsed < 2000, `Codex probe took ${elapsed}ms (limit: 2000ms)`);
    if (mode.endsWith('timeout')) assert.ok(elapsed >= 1500, 'stalled connection reaches its deadline');
    assert.equal(rows.find(r=>r.session===s.codexId).stateSource, 'transcript');
    await s.rows(board);
    assert.equal(s.log(s.calls.codex).length, mode === 'refused' ? 0 : 2, 'failure is cached');
    for (const req of s.log(s.requests.codex)) {
      assert.ok(['initialize','initialized','thread/loaded/list','thread/read'].includes(req.method));
      if (req.method === 'thread/read') assert.equal(req.params.includeTurns, false);
    }
  });
}

test('Codex makes no connection with opt-in unset, even with a binary override', async (t) => {
  const s = await setup(t);
  delete s.f.env.AGENT_ORCH_CODEX_APP_SERVER;
  s.f.env.AGENT_ORCH_CODEX_BIN = s.f.env.AGENT_ORCH_CLAUDE_BIN;
  const board = await s.f.dashboard();
  const rows = await s.rows(board);
  assert.equal(rows.find(r=>r.session===s.codexId).stateSource, 'transcript');
  assert.deepEqual(s.log(s.calls.codex), []);
  assert.deepEqual(s.log(s.requests.codex), []);
  assert.deepEqual(s.log(s.probeTimes), []);
  assert.equal(s.log(s.calls.claude).length, 1);
});
