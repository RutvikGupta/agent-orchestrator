import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after } from 'node:test';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const relay = fileURLToPath(new URL('./fixtures/relay.mjs', import.meta.url));
// Make the test worker the nearest fake host. CLI children stop here instead of
// walking the user's session ancestry; explicit fake hosts below it still win.
// All process scans keep using the real table, including PID and group checks.
process.title = 'codex';
let baseRepository;
let baseRoot;
after(() => { if (baseRoot) fs.rmSync(baseRoot, { recursive: true, force: true }); });
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
export function jsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
export async function eventually(check, message = 'condition did not become true', timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  assert.fail(message);
}

function execute(bin, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function fixture(t) {
  // realpath avoids macOS /var -> /private/var differences in git's output.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-')));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const skills = path.join(root, 'skills');
  const claude = path.join(root, 'claude');
  const codex = path.join(root, 'codex');
  const home = path.join(root, 'home');
  for (const dir of [repo, state, home, path.join(root, 'tmp'), path.join(claude, 'projects'), path.join(codex, 'sessions')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const agent of ['claude', 'codex']) {
    const target = path.join(skills, `${agent}-delegate`, 'scripts', 'relay.mjs');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(relay, target);
  }
  // An allowlist prevents inherited nesting, git overrides, session IDs, Node preloads,
  // credentials, or user configuration from influencing any child process.
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: path.join(root, 'tmp'),
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    AGENT_ORCH_HOME: state, AGENT_ORCH_SKILLS_DIR: skills,
    AGENT_ORCH_WAIT_POLL_MS: '100',
    AGENT_ORCH_HEAVY_FREE_BYTES: '9999999999', AGENT_ORCH_HEAVY_PRESSURE_LEVEL: '0',
    CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const runs = [];
  const dashboards = [];
  let waitNumber = 0;
  const options = (extra = {}) => ({ cwd: repo, env: { ...env, ...extra } });
  const f = {
    root, repo, state, skills, claude, codex, env,
    async command(args, { code = 0, env: extra = {} } = {}) {
      const result = await execute(process.execPath, [cli, ...args], options(extra));
      assert.equal(result.code, code, `node orch.mjs ${args.join(' ')}\n${result.stdout}\n${result.stderr}\nsignal: ${result.signal}`);
      return result;
    },
    async json(args, opts) { return JSON.parse((await f.command([...args, '--json'], opts)).stdout); },
    async git(args) {
      const result = await execute('git', args, options());
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim();
    },
    async newRun(name = `run-${runs.length}`, extra = {}) {
      // Wait discovery scans the real process table across all fixture state roots.
      // Encode case losslessly and reserve the suffix within the CLI's 40-character
      // slug limit, even when an explicit name is long.
      const suffix = Buffer.from(path.basename(root)).toString('hex');
      const uniqueName = `${String(name).slice(0, 39 - suffix.length)}-${suffix}`;
      const run = await f.json(['new', '--repo', repo, '--name', uniqueName, '--goal', 'Black-box CLI fixture'], { env: extra });
      runs.push(run);
      return run;
    },
    brief(name, config = {}) {
      const file = path.join(root, `${name}.md`);
      fs.writeFileSync(file, `Fixture task ${name}.\n<!-- fake-relay ${JSON.stringify(config).replaceAll('-->', '--\\u003e')} -->\n`);
      return file;
    },
    // Every new task names its tier. The default keeps the model the fixtures assumed (`complex`
    // for Claude, `standard` for Codex); `flags` may name another tier, which wins.
    async start(run, id, { agent = 'claude', config = {}, flags = [], env: extra = {} } = {}) {
      return f.json(['start', run.id, id, '--agent', agent,
        '--tier', agent === 'codex' ? 'standard' : 'complex',
        '--why', 'Exercises the CLI with a local fake relay', '--brief', f.brief(id, config), ...flags], { env: extra });
    },
    taskFile(run, id) { return path.join(run.dir, 'tasks', id, 'task.json'); },
    async finished(run, id) {
      return eventually(async () => {
        const row = (await f.json(['status', run.id])).tasks.find((task) => task.id === id);
        // describe() reads the result before checking the PID. The relay can publish
        // and exit between those reads, yielding one aborted snapshot with no result.
        return row?.result && !['running', 'prepared'].includes(row.state) ? row : null;
      }, `${id} did not produce a finished result`);
    },
    async ready(task) {
      await eventually(() => fs.existsSync(path.join(task.outDir, 'ready')), 'relay did not start');
    },
    release(task) { fs.writeFileSync(path.join(task.outDir, 'release'), ''); },
    async waitAfterPoll(args, change, opts = {}) {
      // Observe wait's first completed poll, then change the fixture before its next
      // poll. A preload controls only this child's timer; no production hooks needed.
      const marker = path.join(root, `wait-${++waitNumber}`);
      const pending = f.command(['wait', ...args], { ...opts, env: {
        ...opts.env,
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./fixtures/wait-poll.cjs', import.meta.url)))}`,
        TEST_WAIT_MARKER: marker,
      } });
      try {
        await Promise.race([
          eventually(() => fs.existsSync(marker), 'wait did not complete its first poll'),
          pending.then(() => assert.fail('wait exited before its first polling interval')),
        ]);
        await change();
      } finally {
        fs.writeFileSync(`${marker}.release`, '');
        // Always reap the child, including when the fixture mutation fails.
        await pending;
      }
      return pending;
    },
    // The CLI discovers the launching session by inspecting ancestors. Seed only that
    // external metadata so transcript tests work in terminal, Codex, Claude, and CI alike. Returns
    // that session's environment: commands run with it act as the run's owner, whatever the host.
    launchingSession(run, sessionId, agent = 'claude') {
      const file = path.join(run.dir, 'run.json');
      writeJson(file, { ...readJson(file), orchestrator: { agent, sessionId } });
      return { CLAUDE_CODE_SESSION_ID: sessionId, CODEX_THREAD_ID: sessionId };
    },
    async dashboard() {
      const probe = net.createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      assert.notEqual(port, 4777);
      const child = spawn(process.execPath, [cli, 'dashboard', '--host', '127.0.0.1', '--port', String(port)], {
        ...options(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const entry = { child, output: '', url: null };
      dashboards.push(entry);
      child.stdout.on('data', (chunk) => { entry.output += chunk; });
      child.stderr.on('data', (chunk) => { entry.output += chunk; });
      child.on('error', (error) => { entry.output += error.message; });
      await eventually(() => {
        const file = path.join(state, 'dashboard.json');
        if (!fs.existsSync(file)) return false;
        const record = readJson(file);
        if (record.pid !== child.pid) return false;
        entry.url = record.url;
        return true;
      }, 'dashboard failed to start');
      assert.notEqual(new URL(entry.url).port, '4777');
      return {
        url: entry.url,
        async get(route) { return fetch(new URL(route, entry.url), { signal: AbortSignal.timeout(5000) }); },
        async json(route) {
          const response = await this.get(route);
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        },
        async checkScript(script) {
          const file = path.join(root, 'dashboard-inline.js');
          fs.writeFileSync(file, script);
          const result = await execute(process.execPath, ['--check', file], options());
          assert.equal(result.code, 0, result.stderr);
        },
      };
    },
  };
  t.after(async () => {
    try {
      for (const run of runs) {
        if ((await f.json(['status', run.id])).tasks.length) await f.command(['close', run.id, '--all']);
      }
    } finally {
      try {
        for (const entry of dashboards) {
          // Stop the exact foreground child we own, then verify its port is released.
          if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
          await eventually(() => entry.child.exitCode !== null || entry.child.signalCode !== null, 'dashboard did not exit');
          if (entry.url) {
            const server = net.createServer();
            await new Promise((resolve, reject) => {
              server.once('error', reject);
              server.listen(Number(new URL(entry.url).port), '127.0.0.1', resolve);
            });
            await new Promise((resolve) => server.close(resolve));
          }
        }
      } finally {
        // A finish notice can still be writing after its relay and park were
        // closed. Only fixtures that launched watchers need a process scan.
        const watcherFiles = fs.readdirSync(state, { recursive: true }).some((file) =>
          path.basename(file) === 'parent-notice.log' || /^park-watcher-\d+\.json$/.test(path.basename(file)));
        // The folder is removed whether or not the writers exit in time.
        try {
          if (watcherFiles) await eventually(() => {
            const result = spawnSync('ps', ['-axww', '-o', 'pid=,command='], {
              encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024,
            });
            if (result.status !== 0) return false;
            return !result.stdout.split('\n').some((line) => line.includes(`${root}${path.sep}`)
              && (line.includes('finish-notice.mjs') || line.includes(' park-watch ')));
          }, 'fixture background writers did not exit');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  // Build the immutable initial commit once per test file. Copy its files, rather than
  // sharing a checkout or hard links: each fixture may change refs, config and objects.
  const initializesBase = !baseRepository;
  if (initializesBase) {
    baseRepository = (async () => {
      await f.git(['init', '-q', '--initial-branch=main']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'Temporary fixture repository.\n');
      await f.git(['add', 'README.md']);
      await f.git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture base']);
      baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-base-'));
      fs.cpSync(repo, baseRoot, { recursive: true });
    })();
  }
  await baseRepository;
  if (!initializesBase) fs.cpSync(baseRoot, repo, { recursive: true });
  return f;
}
