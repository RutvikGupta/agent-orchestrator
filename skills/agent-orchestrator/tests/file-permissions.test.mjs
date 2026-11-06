import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, readJson } from './helpers.mjs';

test('Claude file confinement flags reach the relay and persist on resume', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [id, flags, confined] of [
    ['write', [], false], ['read', ['--read-only'], false],
    ['sandbox', ['--sandbox'], true], ['offline', ['--offline'], true],
    ['read-offline', ['--read-only', '--offline'], false],
    ['read-sandbox', ['--read-only', '--sandbox'], false],
    ['confined', ['--confine'], true], ['confined-read', ['--read-only', '--confine'], true],
  ]) {
    const task = await f.start(run, id, { flags });
    await f.ready(task);
    assert.equal(readJson(path.join(task.outDir, 'invocation.json')).argv.includes('--confine'), confined, id);
    const argv = readJson(path.join(task.outDir, 'invocation.json')).argv;
    assert.ok(argv.includes('Bash(git push --force*)'), id);
    assert.ok(argv.includes('Bash(gh secret)'), id);
    assert.ok(argv.includes('Bash(gh auth token)'), id);
    assert.ok(argv.includes('Bash(gh auth status *--show-token*)'), id);
    assert.ok(!argv.includes('Bash(gh auth)'), id);
    assert.ok(!argv.includes('Bash(gh auth status)'), id);
    if (!argv.includes('--allow-publish')) assert.ok(argv.includes('Bash(gh pr create)'), id);
    await f.finished(run, id);
  }
  const resumed = await f.start(run, 'confined');
  await f.ready(resumed);
  assert.ok(readJson(path.join(resumed.outDir, 'invocation.json')).argv.includes('--confine'));
  await f.finished(run, 'confined');
});

test('real relay passes home and temp directories and denies credential file tools in every profile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-perms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('test'); process.exit(0); }
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'}));
`, { mode: 0o755 });
  const relay = fileURLToPath(new URL('../../claude-delegate/scripts/relay.mjs', import.meta.url));
  for (const [id, flags, broad] of [
    ['write', ['--no-sandbox'], true], ['read', ['--read-only'], true],
    ['sandbox', [], false], ['confined', ['--no-sandbox', '--confine'], false],
    ['confined-read', ['--read-only', '--confine'], false],
  ]) {
    const out = path.join(root, id);
    const capture = path.join(root, `${id}.json`);
    const child = spawnSync(process.execPath, [relay, '--cd', root, '--out-dir', out, ...flags], {
      input: 'Reply ok.', encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, TMPDIR: root, CAPTURE: capture },
    });
    assert.equal(child.status, 0, child.stderr);
    const args = readJson(capture);
    const start = args.indexOf('--add-dir');
    const dirs = start < 0 ? [] : args.slice(start + 1, args.findIndex((v, i) => i > start && v.startsWith('--')));
    assert.equal(dirs.includes(root), broad, id);
    assert.ok(!dirs.includes('/tmp'));
    assert.ok(!dirs.includes('/private/tmp'));
    assert.ok(!dirs.includes('/private/var/folders'));
    if (broad) assert.deepEqual(dirs, [root]);
    const settings = readJson(path.join(out, 'profile.json'));
    for (const p of ['~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.docker/config.json', '~/.netrc', '~/.git-credentials', '~/.claude/.credentials*', '~/.codex/auth.json', '~/.local/state/agent-orchestrator/dashboard-token', '~/.config/gh/**', '~/.config/graphite/**', '~/.config/github-copilot/**', '~/.boto', '~/.kube/**', '~/.fly/**', '~/.gnupg/**', '~/.npmrc', '~/.claude.json']) {
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(settings.permissions.deny.includes(`${tool}(${p})`), `${id}: ${tool}(${p})`);
    }
    for (const rule of ['Bash(*node *relay.mjs*)', 'Bash(claude *)', 'Bash(git commit *)', 'Bash(git push *)']) {
      assert.ok(settings.permissions.deny.includes(rule), `${id}: ${rule}`);
    }
    assert.ok(!settings.permissions.deny.includes('Bash(*claude-delegate*)'));
  }
});


test('Codex never receives Claude confinement or permission rules', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const flags of [[], ['--confine'], ['--sandbox', '--confine'], ['--offline', '--confine'], ['--read-only', '--offline', '--confine']]) {
    const id = `codex-${flags.length}-${flags.join('-').replaceAll('--', '')}`;
    const task = await f.start(run, id, { agent: 'codex', flags });
    await f.ready(task);
    const argv = readJson(path.join(task.outDir, 'invocation.json')).argv;
    assert.ok(!argv.includes('--confine'));
    assert.ok(!argv.includes('--deny'));
    await f.finished(run, id);
  }
});

test('start denies resolved credential paths, including relocated and XDG state roots', async (t) => {
  const f = await fixture(t);
  for (const xdg of [false, true]) {
    const state = path.join(f.root, xdg ? 'xdg' : 'custom-state');
    const env = {
      AGENT_ORCH_HOME: xdg ? '' : state,
      XDG_STATE_HOME: state,
      CLAUDE_CONFIG_DIR: path.join(f.root, 'custom-claude'),
      CODEX_HOME: path.join(f.root, 'custom-codex'),
    };
    const run = await f.json(['new', '--repo', f.repo, '--name', `relocated-${xdg}`, '--goal', 'Credential path rules'], { env });
    try {
      const task = await f.start(run, 'paths', { flags: ['--read-only', '--offline'], env });
      await f.ready(task);
      const argv = readJson(path.join(task.outDir, 'invocation.json')).argv;
      const paths = [path.join(state, ...(xdg ? ['agent-orchestrator'] : []), 'dashboard-token'),
        path.join(env.CLAUDE_CONFIG_DIR, '.credentials*'), path.join(env.CODEX_HOME, 'auth.json')];
      for (const p of paths) for (const tool of ['Read', 'Edit', 'Write']) assert.ok(argv.includes(`${tool}(/${p})`));
      assert.ok(!argv.includes('--confine'));
      await f.command(['wait', run.id, 'paths', '--timeout', '30s'], { env });
    } finally {
      await f.command(['close', run.id, '--all'], { env });
    }
  }
});
