// Worktree-local artifacts and personal recipes. Git supplies gitignore matching semantics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CACHE_PATH } from './config.mjs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

function git(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'git failed');
  return result.stdout.split('\0').filter(Boolean);
}

function destination(root, relative) {
  const parts = relative.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const target = path.join(root, relative);
  try { fs.lstatSync(target); return null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

function ensureIgnoredLink(wt, relative) {
  const ignored = () => {
    const result = spawnSync('git', ['-C', wt, 'check-ignore', '-q', '--', relative], { encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'could not check prep link ignore rules');
    return result.status === 0;
  };
  if (ignored()) return;
  if (/[\r\n]/.test(relative)) throw new Error(`cannot ignore prep link with a newline in its name: ${JSON.stringify(relative)}`);
  // Linked worktrees share the common git directory's info/exclude. Escape glob
  // characters so this rule covers just this path, including directory symlinks.
  const common = git(wt, ['rev-parse', '--git-common-dir'])[0]?.trim();
  if (!common) throw new Error('could not locate common git directory for prep link');
  const file = path.resolve(wt, common, 'info', 'exclude');
  const pattern = '/' + relative.replace(/[\\*?\[\] ]/g, '\\$&');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n# orch prep: keep worktree artifacts out of commits\n${pattern}\n`);
  // .gitignore rules have higher precedence and may negate the local exclusion.
  if (!ignored()) throw new Error(`git still does not ignore prep link: ${relative}`);
}

// Let git prune and match while traversing, then intersect with the repo's own ignores.
// No patterns means no git invocation or filesystem traversal at all.
export function ignoredMatches(repo, patterns, { directory = false } = {}) {
  if (!patterns.some((pattern) => pattern.trim() && !pattern.startsWith('#'))) return [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-include-'));
  try {
    const excludeFile = path.join(temp, 'patterns');
    fs.writeFileSync(excludeFile, patterns.join('\n') + '\n');
    const candidates = git(repo, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${excludeFile}`, ...(directory ? ['--directory'] : [])]);
    if (!candidates.length) return [];
    return git(repo, ['check-ignore', '-z', '--stdin'], candidates.join('\0') + '\0').sort();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function recipeFor(repo, errors) {
  const dir = process.env.AGENT_ORCH_RECIPES_DIR || path.join(os.homedir(), '.agents', 'orch-recipes');
  if (!fs.existsSync(dir)) return null;
  const recipes = [];
  for (const file of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    const filename = path.join(dir, file);
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value && typeof value === 'object') recipes.push({ ...value, file: filename });
      else errors.push(`invalid recipe in ${filename}`);
    } catch (error) { errors.push(`${filename}: ${error.message}`); }
  }
  const recipe = recipes.find((r) => r.match === repo) || recipes.find((r) => r.match === path.basename(repo)) || null;
  if (recipe) {
    for (const key of ['copy', 'symlink', 'setup', 'teardown']) {
      if (recipe[key] !== undefined && (!Array.isArray(recipe[key]) || recipe[key].some((item) => typeof item !== 'string'))) {
        errors.push(`invalid ${key} in ${recipe.file}`);
        return null;
      }
    }
  }
  return recipe;
}

export async function worktreePort(run, task) {
  const offset = createHash('sha256').update(`${run}:${task}`).digest().readUInt32BE(0) % 8000;
  for (let step = 0; step < 8000; step++) {
    const port = 41000 + (offset + step) % 8000;
    let available = true;
    // macOS can bind the wildcard address while a loopback-only server holds
    // the same port. Probe both loopback families explicitly as well.
    for (const host of [undefined, '127.0.0.1', '::1']) {
      available = await new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (error) => resolve(host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)));
        server.listen({ port, host }, () => server.close(() => resolve(true)));
      });
      if (!available) break;
    }
    if (available) return port;
  }
  throw new Error('no free worktree ports in 41000–48999');
}

function environment(run, task, prep) {
  const { ORCH_PORT: _inheritedPort, ...inherited } = process.env;
  return { ...inherited, ORCH_WORKTREE: task.worktree.path, ORCH_REPO: run.repo, ORCH_RUN: run.id, ORCH_TASK: task.id,
    ...(prep.port ? { ORCH_PORT: String(prep.port) } : {}) };
}

export function runPrepCommand(command, cwd, env, timeout = 600_000, { signal: abortSignal } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (abortSignal?.aborted) {
      resolve({ command, exitCode: null, durationMs: 0, output: '', interrupted: abortSignal.reason });
      return;
    }
    const child = spawn('bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', timedOut = false, error = null, interrupted = null, settled = false;
    const capture = (chunk) => { output = (output + chunk).slice(-8192); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', interrupt);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ command, exitCode: code, durationMs: Date.now() - start, output: output.trimEnd(), ...(signal ? { signal } : {}), ...(timedOut ? { timedOut } : {}), ...(interrupted ? { interrupted } : {}), ...(error ? { error } : {}) });
    };
    const stop = () => {
      // The process group belongs solely to this command and its descendants.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      // An escaped descendant can keep inherited pipes open after the shell
      // exits. Cancellation must not wait for those streams' close events.
      child.stdout.destroy(); child.stderr.destroy();
      if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
    };
    const interrupt = () => { interrupted = abortSignal.reason; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    abortSignal?.addEventListener('abort', interrupt, { once: true });
    child.on('error', (e) => { error = e.message; finish(null, null); });
    child.on('exit', (code, signal) => {
      if (timedOut || interrupted) finish(code, signal);
    });
    child.on('close', finish);
  });
}

export async function prepareWorktree(run, task, { onProgress = () => {}, signal } = {}) {
  const prep = { copied: [], symlinked: [], setup: [], teardown: [], port: null, recipeFile: null, notes: null, errors: [] };
  task.worktree.prep = prep;
  const persist = () => onProgress(prep);
  try {
    const recipe = recipeFor(run.repo, prep.errors);
    prep.recipeFile = recipe?.file || null; prep.notes = recipe?.notes || null;
    prep.teardown = recipe?.teardown || [];
    if (recipe?.port) prep.port = await worktreePort(run.id, task.id);
    const includeFile = path.join(run.repo, '.worktreeinclude');
    const patterns = fs.existsSync(includeFile) ? fs.readFileSync(includeFile, 'utf8').split('\n') : [];
    const copies = ignoredMatches(run.repo, [...patterns, ...(recipe?.copy || [])]);
    const links = ignoredMatches(run.repo, recipe?.symlink || [], { directory: true });
    const linked = [];
    for (const entry of links) {
      if (linked.some((dir) => entry.startsWith(dir))) continue;
      const relative = entry.replace(/\/$/, '');
      const target = destination(task.worktree.path, relative);
      if (!target) { prep.errors.push(`kept existing path: ${relative}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(run.repo, relative), target);
      try { ensureIgnoredLink(task.worktree.path, relative); }
      catch (error) {
        fs.unlinkSync(target);
        prep.errors.push(`removed unignored prep link ${relative}: ${error.message}`);
        continue;
      }
      prep.symlinked.push(relative);
      if (entry.endsWith('/')) linked.push(entry);
    }
    for (const entry of copies) {
      if (entry.endsWith('/') || linked.some((dir) => entry.startsWith(dir)) || prep.symlinked.includes(entry)) continue;
      const target = destination(task.worktree.path, entry);
      if (!target) { prep.errors.push(`kept existing path: ${entry}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(run.repo, entry);
      if (fs.lstatSync(source).isSymbolicLink()) {
        const resolved = path.resolve(path.dirname(source), fs.readlinkSync(source));
        const fromRepo = path.relative(run.repo, resolved);
        const internal = fromRepo !== '..' && !fromRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRepo);
        fs.symlinkSync(internal ? path.relative(path.dirname(source), resolved) || '.' : resolved, target);
      }
      else if (process.platform !== 'darwin' || spawnSync('cp', ['-c', source, target]).status !== 0) fs.copyFileSync(source, target);
      prep.copied.push(entry);
    }
    persist();
    for (const command of recipe?.setup || []) {
      if (signal?.aborted) break;
      prep.setup.push(await runPrepCommand(command, task.worktree.path, environment(run, task, prep), 600_000, { signal }));
      if (signal?.aborted) prep.interrupted = signal.reason;
      persist();
    }
  } catch (error) { prep.errors.push(error.message); }
  if (signal?.aborted) prep.interrupted = signal.reason;
  persist();
  return prep;
}

export async function teardownWorktree(run, task) {
  const prep = task.worktree.prep;
  if (!prep) return [];
  const results = [];
  for (const command of prep.teardown || []) results.push(await runPrepCommand(command, task.worktree.path, environment(run, task, prep)));
  return results;
}

export function prepSummary(prep) {
  return `\nprep     ${prep.copied.length} copied, ${prep.symlinked.length} symlinked; ${prep.setup.length} setup commands${prep.port ? `; port ${prep.port}` : ''}${prep.notes ? `\n  ${prep.notes}` : ''}${prep.setup.filter((r) => r.exitCode !== 0).map((r) => `\n  setup failed (${r.exitCode ?? r.signal}): ${r.command}`).join('')}${prep.errors.map((error) => `\n  prep: ${error}`).join('')}`;
}

export function worktreeChanges(wt, prep, repo) {
  // -z keeps spaces, quotes, and newlines in paths intact; enumerate untracked children.
  const records = git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const links = new Set(prep?.symlinked || []);
  const copied = new Set(prep?.copied || []);
  const dirty = [];
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
    const code = line.slice(0, 2);
    const name = line.slice(3);
    if (code.includes('R') || code.includes('C')) index++; // the next field is the rename source
    if (CACHE_PATH.test(name)) continue;
    if (code === '??') {
      if (copied.has(name)) continue;
      if (links.has(name)) {
        const target = path.join(wt, name);
        if (fs.lstatSync(target).isSymbolicLink() && fs.readlinkSync(target) === path.join(repo, name)) continue;
      }
    }
    dirty.push(line);
  }
  return dirty;
}
