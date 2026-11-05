import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, eventually, writeJson } from './helpers.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const agentEnv = (run, id) => ({ AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
async function held(f, run, id) {
  const task = await f.start(run, id, { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  return task;
}

test('wait wakes for its calling agent, even when watching another run, without acknowledging', async (t) => {
  const f = await fixture(t);
  const caller = await f.newRun('caller');
  await held(f, caller, 'agent');
  const run = await f.newRun('watched');
  await held(f, run, 'worker');
  let sent, sentAt;
  const result = await f.waitAfterPoll([run.id, '--timeout', '0', '--json'], async () => {
    sent = await f.json(['send', caller.id, 'agent', 'x'.repeat(201) + '\nsecond line']);
    sentAt = Date.now();
  }, { code: 6, env: agentEnv(caller, 'agent') });
  assert.ok(Date.now() - sentAt < 4500, 'inbox must wake within one 3s poll');
  const out = JSON.parse(result.stdout);
  assert.equal(out.finished, false);
  assert.equal(out.message.id, sent.id);
  assert.equal(out.message.time, sent.time);
  assert.equal(out.message.text, 'x'.repeat(200));
  assert.match(out.message.hint, /Claude receives it as context/);
  assert.ok(out.message.hint.includes(`node ${cli} inbox ${caller.id} agent --ack`));
  assert.match(out.message.hint, /then run the same command again/);
  assert.equal((await f.json(['inbox', caller.id, 'agent'])).messages[0].read, false);
});

test('wait ignores a message already unread at entry', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await held(f, run, 'agent');
  await f.command(['send', run.id, 'agent', 'already waiting']);
  const result = await f.command(['wait', run.id, '--timeout', '1ms', '--json'], { code: 3, env: agentEnv(run, 'agent') });
  assert.equal(JSON.parse(result.stdout).message, undefined);
});

test('wait ignores new messages without the calling agent environment', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await held(f, run, 'agent');
  const result = await f.waitAfterPoll([run.id, '--timeout', '1s'], async () => {
    await f.command(['send', run.id, 'agent', 'new but no caller']);
  }, { code: 3 });
  assert.match(result.stdout, /wait timed out/);
  assert.doesNotMatch(result.stdout, /message waiting/);
});

test('wait gives new attention priority and also reports a new message', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await held(f, run, 'agent');
  const worker = await f.start(run, 'worker', { config: { hold: true, status: 'failed', error: 'invalid input' }, flags: ['--read-only'] });
  await f.ready(worker);
  const result = await f.waitAfterPoll([run.id, 'worker', '--timeout', '0'], async () => {
    f.release(worker);
    await f.finished(run, 'worker');
    await f.command(['send', run.id, 'agent', 'look here\nnow']);
  }, { code: 5, env: agentEnv(run, 'agent') });
  assert.match(result.stdout, /a task needs attention/);
  assert.match(result.stdout, /message waiting \([^\n]+\): look here now .*Claude receives/);
  await f.command(['result', run.id, 'worker']);
  const deferred = await f.json(['wait', run.id, 'agent', '--timeout', '0'], { code: 6, env: agentEnv(run, 'agent') });
  assert.equal(deferred.message.text, 'look here\nnow');
  // Once reported with exit 6, an unacknowledged message must not wake every subsequent call.
  await f.command(['wait', run.id, 'agent', '--timeout', '1ms'], { code: 3, env: agentEnv(run, 'agent') });
});

// Same fake gh protocol as regression-github.test.mjs. The first sleep is a handshake,
// ensuring the message arrives between GitHub polls, rather than during the initial query.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  const calls = path.join(f.root, 'gh-calls');
  const data = path.join(f.root, 'pr.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
if (process.argv[2] === 'pr') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
`, { mode: 0o755 });
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', state: 'OPEN',
    title: 'Fixture PR', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [], comments: [], reviews: [] });
  const preload = path.join(f.root, 'pr-poll.cjs');
  const marker = path.join(f.root, 'pr-poll');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = global.setTimeout;
let first = true;
global.setTimeout = (callback, ms, ...args) => {
  if (ms !== 3000 || !first) return original(callback, ms, ...args);
  first = false;
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  return original(function released() {
    if (!fs.existsSync(${JSON.stringify(marker + '.release')})) return original(released, 10);
    callback(...args);
  }, ms);
};
`);
  return { calls, marker, env: { PATH: `${bin}:${f.env.PATH}`, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } };
}

test('pr-watch wakes between GitHub polls with status and a single-line message', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await held(f, run, 'agent');
  const gh = await github(f);
  const pending = f.command(['pr-watch', '42', '--interval', '60s', '--timeout', '0'], {
    code: 6, env: { ...gh.env, ...agentEnv(run, 'agent') },
  });
  let sentAt, sent;
  try {
    await Promise.race([eventually(() => fs.existsSync(gh.marker)), pending.then(() => assert.fail('watch exited before sleeping'))]);
    sent = await f.json(['send', run.id, 'agent', 'check this\nplease']);
    sentAt = Date.now();
  } finally {
    fs.writeFileSync(gh.marker + '.release', '');
    await pending;
  }
  const result = await pending;
  assert.ok(Date.now() - sentAt < 4500, 'must wake before the 60s GitHub poll');
  assert.match(result.stdout, /^PR #42 OPEN/);
  assert.ok(result.stdout.includes(`message waiting (${sent.time}): check this please`));
  assert.equal(result.stdout.trim().split('\n').length, 4);
  assert.equal(fs.readFileSync(gh.calls, 'utf8').trim().split('\n').length, 2, 'no extra GitHub requests');
});
