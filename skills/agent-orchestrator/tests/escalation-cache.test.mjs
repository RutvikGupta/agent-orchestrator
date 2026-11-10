import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, writeJson } from './helpers.mjs';

function copySkill(f) {
  const copy = path.join(f.root, 'skill-copy');
  fs.cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), path.join(copy, 'scripts'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../policy.json', import.meta.url)), path.join(copy, 'policy.json'));
  return copy;
}

function inspect(f, copy, run, task, body) {
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const { describe } = await import(${JSON.stringify(pathToFileURL(path.join(copy, 'scripts/lib/runs.mjs')).href)});
    const task = JSON.parse(fs.readFileSync(${JSON.stringify(f.taskFile(run, task.id))}, 'utf8'));
    const run = ${JSON.stringify(run)};
    const policyFile = ${JSON.stringify(path.join(copy, 'policy.json'))};
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('describe tolerates missing and invalid policy, including legacy model-to-tier fallback', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'legacy', { flags: ['--tier', 'light'], config: { status: 'failed' } });
  await f.finished(run, task.id);
  const copy = copySkill(f);
  inspect(f, copy, run, task, `
    // Known tiers do not read policy at all, even on the first description.
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) { if (String(file) === policyFile) reads++; return read.call(this, file, ...args); };
    assert.equal(describe(run, task).failureCount, 1);
    assert.equal(reads, 0);
    // Legacy records use a tolerant fallback, cached until the policy changes.
    task.tier = null;
    task.attemptTiers = {};
    assert.equal(describe(run, task).attempts[0].tier, 'light');
    assert.equal(describe(run, task).attempts[0].tier, 'light');
    assert.equal(reads, 1);
    fs.writeFileSync(policyFile, '{unfinished');
    assert.equal(describe(run, task).failureCount, 1);
    assert.equal(describe(run, task).failureCount, 1);
    assert.equal(reads, 2);
    fs.unlinkSync(policyFile);
    assert.equal(describe(run, task).failureCount, 1);
  `);
});

test('describe reuses cached historical failure facts and does not tail running or prepared attempts', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'cached', { flags: ['--tier', 'light'], config: { status: 'failed', error: 'weekly limit reached' } });
  await f.finished(run, 'cached');
  const task = await f.start(run, 'cached', { flags: ['--tier', 'light'], config: { hold: true } });
  await f.ready(task);
  const copy = copySkill(f);
  inspect(f, copy, run, task, `
    describe(run, task);
    const read = fs.readFileSync;
    const open = fs.openSync;
    const reads = [];
    const opened = [];
    fs.readFileSync = function(file, ...args) { reads.push(String(file)); return read.call(this, file, ...args); };
    fs.openSync = function(file, ...args) { opened.push(String(file)); return open.call(this, file, ...args); };
    const row = describe(run, task);
    assert.equal(row.state, 'running');
    assert.equal(row.failureCount, 0, 'cached historical usage limit remains excluded');
    assert.equal(reads.some((f) => f.endsWith('/attempt-1/result.json')), false);
    assert.equal(reads.includes(policyFile), false);
    assert.equal(opened.some((f) => f.endsWith('/relay.log') || f.endsWith('/events.jsonl')), false);
    const prepared = { id: 'prepared', agent: 'claude', tier: 'light', attempt: 1, attemptTiers: { 1: 'light' }, cd: task.cd };
    fs.mkdirSync(run.dir + '/tasks/prepared/attempt-1', { recursive: true });
    fs.writeFileSync(run.dir + '/tasks/prepared/attempt-1/relay.log', 'usage limit');
    opened.length = 0;
    assert.equal(describe(run, prepared).state, 'prepared');
    assert.equal(opened.some((f) => f.endsWith('/relay.log')), false);
  `);
  f.release(task);
  await f.finished(run, task.id);
});

test('an aborted log usage limit is cached and refreshed when its log changes', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = { id: 'aborted-log', agent: 'codex', tier: 'light', attempt: 2, attemptTiers: { 1: 'light', 2: 'light' }, cd: f.repo };
  writeJson(f.taskFile(run, task.id), task);
  const dir = path.join(run.dir, 'tasks', task.id, 'attempt-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relay.log'), 'usage limit reached');
  const copy = copySkill(f);
  inspect(f, copy, run, task, `
    const file = run.dir + '/tasks/aborted-log/attempt-1/relay.log';
    const open = fs.openSync;
    let tails = 0;
    fs.openSync = function(target, ...args) { if (String(target) === file && args[0] === 'r') tails++; return open.call(this, target, ...args); };
    assert.equal(describe(run, task).failureCount, 0);
    assert.equal(describe(run, task).failureCount, 0);
    assert.equal(tails, 1);
    fs.writeFileSync(file, 'worker crashed');
    assert.equal(describe(run, task).failureCount, 1);
    assert.equal(describe(run, task).failureCount, 1);
    assert.equal(tails, 2, 'the changed log is tailed just once');
  `);
});
