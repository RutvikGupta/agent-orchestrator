import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, eventually, readJson, writeJson } from './helpers.mjs';
import { runningConflicts } from '../scripts/lib/plan.mjs';

function entry(f, id, extra = {}, config = { hold: true }) {
  return { id, goal: `Build ${id}`, owns: [`src/${id}`], dependsOn: [], agent: 'claude', tier: 'complex',
    why: 'Fixture plan', brief: f.brief(id, config), ...extra };
}
async function plan(f, run, tasks) {
  const file = path.join(f.root, 'plan-input.json');
  writeJson(file, { goal: 'Exercise scheduling recovery', tasks });
  await f.command(['plan', run.id, file]);
}
const task = (f, run, id) => readJson(f.taskFile(run, id));
const as = (run, id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });

// Observe each polling boundary before advancing the fixture, without relying on a guessed delay.
async function follow(f, run, steps, flags = [], options = {}) {
  const prefix = path.join(f.root, `poll-${Date.now()}`);
  const preload = `${prefix}.cjs`;
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = global.setTimeout;
let n = 0;
global.setTimeout = (fn, ms, ...args) => {
  if (ms !== 1000 || !process.argv.includes('dispatch') || n >= ${steps.length}) return original(fn, ms, ...args);
  const marker = ${JSON.stringify(prefix)} + '-' + (++n);
  fs.writeFileSync(marker, '');
  return original(function released() {
    if (!fs.existsSync(marker + '.release')) return original(released, 10);
    fn(...args);
  }, ms);
};`);
  const pending = f.command(['dispatch', run.id, '--follow', '--json', ...flags], {
    ...options, env: { ...options.env, NODE_OPTIONS: `--require=${preload}` },
  });
  try {
    for (let i = 0; i < steps.length; i++) {
      await Promise.race([
        eventually(() => fs.existsSync(`${prefix}-${i + 1}`), 'dispatch did not reach its polling boundary'),
        pending.then(() => assert.fail('dispatch exited before the expected poll')),
      ]);
      await steps[i]();
      fs.writeFileSync(`${prefix}-${i + 1}.release`, '');
    }
  } finally {
    for (let i = 1; i <= steps.length; i++) fs.writeFileSync(`${prefix}-${i}.release`, '');
    await pending;
  }
  return pending;
}

async function github(f) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const data = path.join(f.root, 'pr.json');
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR', state: 'OPEN',
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
    headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main', baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'pr') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  return (fields) => writeJson(data, { ...readJson(data), ...fields });
}
const PARKED = 'PARKED: PR #42 waits for review\n```orch-result\n{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n```';

// A finished attempt with no watcher record models a process restart, as in park.test.mjs.
function seedPark(f, run, record, resources = []) {
  const result = path.join(record.outDir, 'result.json');
  writeJson(result, { ...readJson(result), finalMessage: PARKED });
  writeJson(f.taskFile(run, record.id), { ...task(f, run, record.id), babysit: true,
    pr: { number: 42, url: 'https://github.com/example/repo/pull/42' },
    plan: { id: record.id, type: 'babysit', owns: ['.'], resources } });
}

test('later attempts bypass plan membership and dependency checks while first starts still refuse', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const id of ['old', 'waiting']) {
    await f.start(run, id, { flags: ['--read-only'] });
    await f.finished(run, id);
  }
  await plan(f, run, [entry(f, 'producer'), entry(f, 'waiting', { dependsOn: ['producer'], readOnly: true, owns: [] }),
    entry(f, 'new', { dependsOn: ['producer'], readOnly: true, owns: [] })]);
  for (const id of ['old', 'waiting']) {
    const resumed = await f.start(run, id, { flags: ['--read-only'] });
    assert.equal(resumed.attempt, 2);
    await f.finished(run, id);
  }
  const args = (id) => ['start', run.id, id, '--agent', 'claude', '--tier', 'complex', '--why', 'Fixture', '--brief', f.brief(id), '--read-only'];
  assert.match((await f.command(args('new'), { code: 1 })).stderr, /waits on producer/);
  assert.match((await f.command(args('outside'), { code: 1 })).stderr, /not in the plan/);
});

test('unplanned babysitters and command tasks do not reserve paths against planned writers', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'first'), entry(f, 'second')]);
  await f.command(['dispatch', run.id, '--max', '1']);
  await f.ready(task(f, run, 'first'));
  const sitter = await f.json(['start', run.id, 'sitter', '--agent', 'claude', '--babysit', '--pr', '42',
    '--why', 'Fixture PR', '--brief', f.brief('sitter', { hold: true }), '--unplanned']);
  await f.ready(sitter);
  const command = JSON.parse((await f.command(['start', run.id, 'check', '--agent', 'command', '--why', 'Fixture command', '--unplanned', '--json', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
  assert.equal(command.readOnly, true);
  await f.finished(run, 'check');
  const second = await f.json(['dispatch', run.id]);
  assert.deepEqual(second.started.map((x) => x.id), ['second']);
  f.release(sitter);
  f.release(task(f, run, 'first'));
  f.release(task(f, run, 'second'));
});

test('parked tasks hold no plan reservations in start or dispatch', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const sitter = await f.start(run, 'sitter');
  await f.finished(run, 'sitter');
  seedPark(f, run, sitter, ['port:8080', 'port:8081']);
  await plan(f, run, [entry(f, 'direct', { resources: ['port:8080'] }), entry(f, 'wave', { resources: ['port:8081'] })]);
  const wt = await f.json(['worktree', run.id, 'direct']);
  const direct = await f.start(run, 'direct');
  assert.equal(direct.cd, wt.path);
  const wave = await f.json(['dispatch', run.id]);
  assert.deepEqual(wave.started.map((x) => x.id), ['wave']);
  f.release(task(f, run, 'wave'));
});

test('follow ignores existing questions and stops for newly arising attention', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'old'), entry(f, 'new')]);
  await f.command(['dispatch', run.id]);
  for (const id of ['old', 'new']) await f.ready(task(f, run, id));
  await f.command(['ask', 'Existing question?'], { env: as(run, 'old') });
  const out = await follow(f, run, [async () => {
    await f.command(['ask', 'New question?'], { env: as(run, 'new') });
  }]);
  const result = JSON.parse(out.stdout);
  assert.equal(result.reason, 'attention');
  assert.deepEqual(result.attention.filter((x) => x.phase === 'question').map((x) => x.id).sort(), ['new', 'old']);
});

test('follow retries a transient failure from a task started before its plan, and also failures arriving during polling', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'retry-old', { flags: ['--read-only'], config: { status: 'failed', error: 'HTTP 503' } });
  await f.finished(run, 'retry-old');
  await plan(f, run, [entry(f, 'writer')]);
  const first = await f.command(['dispatch', run.id, '--follow', '--json']);
  assert.match(first.stderr, /retried retry-old/);
  assert.equal(task(f, run, 'retry-old').attempt, 2);
  await f.command(['result', run.id, 'retry-old']);
  const late = await f.start(run, 'retry-late', { flags: ['--unplanned', '--read-only'], config: { hold: true, status: 'failed', error: 'HTTP 503' } });
  await f.ready(late);
  const second = await follow(f, run, [async () => {
    f.release(late);
    await f.finished(run, 'retry-late');
  }]);
  assert.match(second.stderr, /retried retry-late/);
  assert.equal(task(f, run, 'retry-late').attempt, 2);
  assert.equal(JSON.parse(second.stdout).attention.find((x) => x.id === 'retry-late').phase, 'awaiting-review');
});

test('follow lists a ready babysitter while following running work', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'writer'), entry(f, 'watch', { type: 'babysit', owns: [] })]);
  const out = await follow(f, run, [async () => {
    const writer = task(f, run, 'writer');
    await f.ready(writer);
    f.release(writer);
    await f.finished(run, 'writer');
  }]);
  assert.deepEqual(JSON.parse(out.stdout).manual, ['watch']);
  assert.equal(JSON.parse(out.stdout).attention[0].id, 'writer');
  const idle = await f.json(['dispatch', run.id, '--follow']);
  assert.deepEqual(idle.manual, ['watch']);
});

test('follow --max caps concurrently running planned tasks across polls', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'first'), entry(f, 'second')]);
  const out = await follow(f, run, [async () => {
    await f.ready(task(f, run, 'first'));
    assert.equal(fs.existsSync(f.taskFile(run, 'second')), false);
  }, async () => {
    assert.equal(fs.existsSync(f.taskFile(run, 'second')), false, 'a subsequent poll must not add another planned task');
    const first = task(f, run, 'first');
    f.release(first);
    await f.finished(run, 'first');
  }], ['--max', '1']);
  assert.ok(JSON.parse(out.stdout).attention.some((x) => x.id === 'first'));
});

test('follow revives a parked watcher appearing during a poll', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const sitter = await f.start(run, 'sitter');
  await f.finished(run, 'sitter');
  await plan(f, run, [entry(f, 'writer')]);
  await follow(f, run, [async () => {
    seedPark(f, run, sitter);
  }, async () => {
    assert.ok(fs.readdirSync(sitter.outDir).some((name) => /^park-watcher-\d+\.json$/.test(name)), 'follow must revive the watcher without another command doing it');
    f.release(task(f, run, 'writer'));
    await f.finished(run, 'writer');
  }]);
});

test('a park watcher resumes a babysitter that started before the run acquired a plan', async (t) => {
  const f = await fixture(t);
  await github(f);
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true });
  const run = await f.newRun();
  await f.json(['start', run.id, 'sitter', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Fixture PR',
    '--brief', f.brief('sitter', { finalMessage: PARKED })]);
  await eventually(async () => {
    const row = (await f.json(['status', run.id])).tasks.find((x) => x.id === 'sitter');
    return row?.phase === 'parked' && row.parked.watcher === 'alive';
  }, 'babysitter did not park');
  await plan(f, run, [entry(f, 'writer')]);
  await f.command(['dispatch', run.id]);
  await f.ready(task(f, run, 'writer'));
  await f.command(['send', run.id, 'sitter', 'Check the latest review']);
  await eventually(() => task(f, run, 'sitter').attempt === 2, 'watcher did not resume the previously started task', 12_000);
  const resumed = task(f, run, 'sitter');
  await f.ready(resumed);
  assert.equal(resumed.babysit, true);
  f.release(resumed);
  f.release(task(f, run, 'writer'));
});

// Commands may inherit a plan reservation from an earlier agent attempt of the same task.
test('command reservations discard inherited resources and babysitters discard inherited paths', () => {
  const writer = { id: 'writer', owns: ['src/'], resources: ['port:8080'] };
  assert.deepEqual(runningConflicts(writer, [{ id: 'command', agent: 'command', readOnly: true, owns: ['.'], resources: ['port:8080'] }]), []);
  assert.deepEqual(runningConflicts(writer, [{ id: 'sitter', type: 'babysit', owns: ['.'], resources: [] }]), []);
});

test('follow --max includes planned automatic retries in its running cap', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'busy', { readOnly: true, owns: [] }),
    entry(f, 'retry', { readOnly: true, owns: [] }, { status: 'failed', error: 'HTTP 503' })]);
  await f.command(['dispatch', run.id]);
  await f.ready(task(f, run, 'busy'));
  await f.finished(run, 'retry');
  const out = await follow(f, run, [async () => {
    assert.equal(task(f, run, 'retry').attempt, 1, 'retry must wait for a planned slot');
    f.release(task(f, run, 'busy'));
    await f.finished(run, 'busy');
    await f.command(['result', run.id, 'busy']);
  }], ['--max', '1']);
  assert.match(out.stderr, /retried retry/);
  assert.equal(task(f, run, 'retry').attempt, 2);
});
