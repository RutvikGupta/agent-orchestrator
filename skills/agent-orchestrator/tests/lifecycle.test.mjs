import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson } from './helpers.mjs';

// A brief inside the run directory, where plan.json's relative brief paths point.
function brief(run, id, config = {}) {
  const rel = `briefs/${id}.md`;
  fs.mkdirSync(path.join(run.dir, 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(run.dir, rel), `Planned task ${id}.\n<!-- fake-relay ${JSON.stringify(config)} -->\n`);
  return rel;
}

function entry(run, id, extra = {}, config = {}) {
  return {
    id, goal: `Build ${id}`, type: 'implement', owns: [`src/${id}/`], uses: [], produces: [], resources: [],
    dependsOn: [], agent: 'claude', tier: 'complex', why: 'Fixture assessment', readOnly: false,
    brief: brief(run, id, config), ...extra,
  };
}

function planFile(f, name, plan) {
  const file = path.join(f.root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

async function commit(f, dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await f.git(['-C', dir, 'add', file]);
  await f.git(['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `Change ${file}`]);
  return f.git(['-C', dir, 'rev-parse', 'HEAD']);
}

const row = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);

test('plan rejects invalid fields, unknown dependencies, and cycles without recording anything', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const invalid = {
    goal: ' ',
    tasks: [
      entry(run, 'ok'),
      { ...entry(run, 'bad-id'), id: 'Bad_ID' },
      entry(run, 'dup', { owns: ['a/'] }),
      entry(run, 'dup', { owns: ['b/'] }),
      entry(run, 'ghost', { dependsOn: ['missing'] }),
      entry(run, 'self', { dependsOn: ['self'] }),
      entry(run, 'codex-task', { agent: 'codex', tier: null }),
      entry(run, 'claude-tier', { tier: 'imaginary' }),
      entry(run, 'claude-null', { tier: null }),
      entry(run, 'claude-absent', { tier: undefined }),
      entry(run, 'claude-light', { tier: 'light' }),
      entry(run, 'codex-absent', { agent: 'codex', tier: undefined }),
      entry(run, 'babysit-light', { type: 'babysit', owns: [], tier: 'light' }),
      entry(run, 'babysit-implied', { type: 'babysit', owns: [], tier: null }),
      entry(run, 'robot', { agent: 'robot' }),
      entry(run, 'no-why', { why: '  ' }),
      entry(run, 'no-brief', { brief: '' }),
      entry(run, 'brief-later', { brief: 'briefs/not-written-yet.md' }),
      entry(run, 'no-goal', { goal: '' }),
      entry(run, 'reader', { readOnly: true, owns: ['src/'] }),
    ],
  };
  const out = await f.command(['plan', run.id, planFile(f, 'invalid', invalid)], { code: 1 });
  for (const pattern of [
    /goal is empty: one line/, /task Bad_ID: id must be a lowercase slug/, /task dup: duplicate id/,
    /task ghost: dependsOn names "missing", which is not in the plan/, /task self: depends on itself/,
    /task codex-task: a Codex task needs a tier \(standard or complex\)/, /task claude-tier: tier "imaginary" is not a Claude tier \(light, standard or complex\)/,
    /task claude-null: a Claude task needs a tier \(light, standard or complex\): the lightest that does the task as well as the top one/,
    /task claude-absent: a Claude task needs a tier \(light, standard or complex\)/, /task codex-absent: a Codex task needs a tier \(standard or complex\)/,
    /task babysit-light: a babysit task runs the complex tier/,
    /task robot: agent must be claude or codex/, /task no-why: why is empty/,
    /task no-brief: brief is empty: the path of its brief file/, /task no-goal: goal is empty/,
    /task reader: is read-only, so it owns nothing/,
  ]) assert.match(out.stderr, pattern);
  // A babysitter always runs complex, so its plan entry may leave the tier out.
  assert.doesNotMatch(out.stderr, /task ok:|task brief-later:|task claude-light:|task babysit-implied:/);
  assert.equal(fs.existsSync(path.join(run.dir, 'plan.json')), false);

  const cycle = { goal: 'Cycle', tasks: [entry(run, 'a', { dependsOn: ['c'] }), entry(run, 'b', { dependsOn: ['a'] }), entry(run, 'c', { dependsOn: ['b'] })] };
  const cyc = await f.command(['plan', run.id, planFile(f, 'cycle', cycle), '--check'], { code: 1 });
  assert.match(cyc.stderr, /dependency cycle: a → c → b → a/);
  const unreadable = await f.command(['plan', run.id, path.join(f.root, 'nope.json')], { code: 2 });
  assert.match(unreadable.stderr, /cannot read the plan/);
  assert.equal(fs.existsSync(path.join(run.dir, 'plan.json')), false);
});

test('plan names parallel conflicts on owned paths and resources, and records a plan without them', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const tasks = [
    entry(run, 'core', { owns: ['src/'] }),
    entry(run, 'parser', { owns: ['./src/parser.js'] }),
    entry(run, 'server', { owns: ['server/'], resources: ['port:8080'] }),
    entry(run, 'smoke', { readOnly: true, type: 'review', owns: [], resources: ['port:8080'], agent: 'codex', tier: 'standard' }),
    entry(run, 'docs', { owns: ['docs/**'] }),
    entry(run, 'docs-more', { owns: ['docs/guide/'], dependsOn: ['middle'] }),
    entry(run, 'middle', { owns: ['lib/'], dependsOn: ['docs'] }),
    entry(run, 'audit', { readOnly: true, type: 'review', owns: [] }),
    entry(run, 'whole', { owns: ['.'], dependsOn: ['core', 'parser', 'server', 'smoke', 'docs', 'docs-more', 'middle'] }),
  ];
  const conflicted = await f.command(['plan', run.id, planFile(f, 'conflicted', { goal: 'Ship it', tasks })], { code: 1 });
  assert.match(conflicted.stderr, /the plan has 2 problems/);
  assert.match(conflicted.stderr, /tasks core and parser can run at the same time but both own src\/ \/ \.\/src\/parser\.js; add "dependsOn": \["core"\] to parser/);
  assert.match(conflicted.stderr, /tasks server and smoke can run at the same time but both use port:8080/);
  // A transitive dependency orders docs before docs-more; read-only tasks never conflict on owns.
  assert.doesNotMatch(conflicted.stderr, /docs-more|audit|whole/);

  tasks[1].dependsOn = ['core'];
  tasks[3].dependsOn = ['server'];
  const file = planFile(f, 'fixed', { goal: 'Ship it', acceptance: ['works'], tasks });
  const checked = await f.command(['plan', run.id, file, '--check']);
  assert.match(checked.stdout, /9 tasks \(2 read-only\), no conflicts/);
  assert.match(checked.stdout, /checked only \(--check\): nothing recorded/);
  assert.equal(fs.existsSync(path.join(run.dir, 'plan.json')), false);
  const recorded = await f.command(['plan', run.id, file]);
  assert.match(recorded.stdout, /parser\s+claude complex\s+write\s+core/);
  assert.match(recorded.stdout, /next: .* dispatch /);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')), readJson(file));
});

test('dispatch starts ready tasks in worktrees; accept and integrate unblock their dependents', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const plan = {
    goal: 'Build the feature',
    acceptance: ['the feature works'],
    tasks: [
      entry(run, 'api', { goal: 'Add the API' }),
      entry(run, 'scan', { type: 'research', readOnly: true, owns: [], agent: 'codex', tier: 'standard' }),
      entry(run, 'ui', { dependsOn: ['api'] }),
      entry(run, 'notes', { owns: ['docs/'], dependsOn: ['scan'] }),
      entry(run, 'sitter', { type: 'babysit', owns: [] }),
    ],
  };
  await f.command(['plan', run.id, planFile(f, 'plan', plan)]);

  const dry = await f.command(['dispatch', run.id, '--dry-run']);
  assert.match(dry.stdout, new RegExp(`would start api → claude \\(complex tier\\), in a new worktree from the run's base commit ${run.baseCommit.slice(0, 12)}`));
  assert.match(dry.stdout, new RegExp(`would start scan → codex \\(standard tier\\), read-only, in ${f.repo}`));
  assert.match(dry.stdout, /blocked ui: waits on api \(not started\)/);
  assert.match(dry.stdout, /blocked notes: waits on scan \(not started\)/);
  assert.match(dry.stdout, /start by hand: sitter babysits a pull request/);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);

  const first = await f.json(['dispatch', run.id, '--max', '1']);
  assert.deepEqual(first.started.map((s) => s.id), ['api']);
  assert.deepEqual(first.waitingForSlot, ['scan']);
  const api = readJson(f.taskFile(run, 'api'));
  assert.deepEqual(api.plan, plan.tasks[0]);
  assert.equal(api.worktree.from, run.baseCommit);
  assert.equal(api.worktree.branch, `orch/${run.id}/api`);
  assert.equal(api.cd, api.worktree.path);
  assert.equal(api.readOnly, false);
  assert.match(fs.readFileSync(path.join(api.outDir, 'orch-brief.md'), 'utf8'), /^Planned task api\./);

  const second = await f.command(['dispatch', run.id]);
  assert.match(second.stdout, /started scan → codex .*read-only/);
  assert.match(second.stdout, /next: .* wait /);
  const scan = readJson(f.taskFile(run, 'scan'));
  assert.equal(scan.cd, f.repo);
  assert.equal(scan.readOnly, true);
  assert.equal(scan.tier, 'standard');
  assert.equal(scan.worktree, undefined);
  assert.equal(scan.why, 'Fixture assessment');
  await f.finished(run, 'api');
  await f.finished(run, 'scan');

  const apiRow = await row(f, run, 'api');
  assert.equal(apiRow.state, 'completed');
  assert.equal(apiRow.phase, 'awaiting-review');
  assert.equal(typeof apiRow.awaitingReviewMs, 'number');
  let waited = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(waited.stdout, /awaiting review: api \(0m\), scan \(0m\); review, commit, then run `accept`/);
  assert.doesNotMatch(waited.stdout, /ready to dispatch/);

  // A read-only prerequisite counts once its result is collected.
  await f.command(['result', run.id, 'scan']);
  assert.equal((await row(f, run, 'scan')).phase, 'integrated');
  waited = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(waited.stdout, /ready to dispatch: notes \(run `dispatch`\)/);

  // accept: the orchestrator commits after review; uncommitted work is refused.
  fs.mkdirSync(path.join(api.cd, 'src', 'api'), { recursive: true });
  fs.writeFileSync(path.join(api.cd, 'src', 'api', 'index.js'), 'export const api = 1;\n');
  const dirty = await f.command(['accept', run.id, 'api'], { code: 1 });
  assert.match(dirty.stderr, /uncommitted changes in .*api.*\n.*src\//);
  const head = await commit(f, api.cd, 'src/api/index.js', 'export const api = 1;\n');
  const accepted = await f.json(['accept', run.id, 'api']);
  assert.equal(accepted.acceptedCommit, head);
  const apiTask = readJson(f.taskFile(run, 'api'));
  assert.equal(apiTask.acceptedCommit, head);
  assert.equal(apiTask.acceptedAttempt, 1);
  assert.ok(apiTask.acceptedAt);
  assert.equal((await row(f, run, 'api')).phase, 'accepted');
  waited = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(waited.stdout, /accepted, not integrated: api \(run `integrate`\)/);

  // integrate refuses a checkout on another branch, or one with uncommitted changes.
  const mainHead = await f.git(['rev-parse', 'HEAD']);
  await f.git(['checkout', '-q', '-b', 'elsewhere']);
  const wrong = await f.command(['integrate', run.id, 'api'], { code: 1 });
  assert.match(wrong.stderr, /has branch elsewhere checked out, not main/);
  await f.git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'Local edit.\n');
  const unclean = await f.command(['integrate', run.id, 'api'], { code: 1 });
  assert.match(unclean.stderr, /uncommitted changes; commit them or set them aside yourself:\n.*README\.md/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'Local edit.\n');
  await f.git(['checkout', '--', 'README.md']);

  const check = await f.command(['integrate', run.id, 'api', '--dry-run']);
  assert.match(check.stdout, new RegExp(`orch/${run.id}/api merges cleanly into main; nothing was changed`));
  assert.equal(await f.git(['rev-parse', 'HEAD']), mainHead);
  const merged = await f.command(['integrate', run.id, 'api']);
  assert.match(merged.stdout, /integrated api: merged .* into main at/);
  assert.match(merged.stdout, /ready to dispatch now: ui/);
  const mergeHead = await f.git(['rev-parse', 'HEAD']);
  assert.notEqual(mergeHead, mainHead);
  assert.equal(await f.git(['log', '-1', '--format=%s']), 'Merge api: Add the API');
  assert.equal(await f.git(['rev-parse', 'HEAD^2']), head);
  assert.equal(readJson(f.taskFile(run, 'api')).integratedCommit, mergeHead);
  assert.equal((await row(f, run, 'api')).phase, 'integrated');
  assert.match((await f.command(['integrate', run.id, 'api'])).stdout, /already integrated/);

  // Dependents start from the base branch's head, which now holds their prerequisites.
  const third = await f.json(['dispatch', run.id]);
  assert.deepEqual(third.started.map((s) => s.id).sort(), ['notes', 'ui']);
  assert.deepEqual(third.manual, ['sitter']);
  const ui = readJson(f.taskFile(run, 'ui'));
  assert.equal(ui.worktree.from, mergeHead);
  assert.equal(fs.readFileSync(path.join(ui.cd, 'src', 'api', 'index.js'), 'utf8'), 'export const api = 1;\n');
  assert.equal(readJson(f.taskFile(run, 'notes')).worktree.from, mergeHead);
  await f.finished(run, 'ui');
  await f.finished(run, 'notes');
  const done = await f.command(['dispatch', run.id]);
  assert.match(done.stdout, /start by hand: sitter/);
  assert.doesNotMatch(done.stdout, /started|would start/);
});

test('accept and integrate refuse unfinished work, report conflicts without changing anything, and record repo tasks', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const missing = await f.command(['dispatch', run.id], { code: 1 });
  assert.match(missing.stderr, /has no plan; record one with: .* plan /);

  const slow = await f.start(run, 'slow', { config: { delayMs: 30_000 }, flags: ['--read-only'] });
  await f.ready(slow);
  assert.match((await f.command(['accept', run.id, 'slow'], { code: 1 })).stderr, /slow is running, not completed: it is still running/);
  await f.command(['close', run.id, 'slow']);
  await f.start(run, 'broken', { config: { status: 'failed', finalMessage: 'Could not.' } });
  await f.finished(run, 'broken');
  assert.match((await f.command(['accept', run.id, 'broken'], { code: 1 })).stderr, /broken is failed, not completed/);
  await f.start(run, 'asks', { config: { finalMessage: 'NEEDS DECISION:\nA or B? Recommendation: A.' } });
  await f.finished(run, 'asks');
  assert.match((await f.command(['accept', run.id, 'asks'], { code: 1 })).stderr, /needs-decision, not completed: it handed back a decision/);
  assert.equal((await row(f, run, 'asks')).phase, 'needs-decision');
  assert.equal((await row(f, run, 'broken')).phase, 'failed');

  // Two tasks change the same file in their own worktrees.
  const worktrees = {};
  for (const id of ['left', 'right']) {
    worktrees[id] = (await f.json(['worktree', run.id, id])).path;
    await f.start(run, id);
    await f.finished(run, id);
  }
  // Without a plan, `wait` stops naming a task as awaiting review once its result is collected.
  assert.match((await f.command(['wait', run.id, '--timeout', '1s'])).stdout, /awaiting review: left \(0m\), right \(0m\);/);
  await f.command(['result', run.id, 'left']);
  assert.match((await f.command(['wait', run.id, '--timeout', '1s'])).stdout, /awaiting review: right \(0m\);/);
  assert.match((await f.command(['integrate', run.id, 'left'], { code: 1 })).stderr, /left is awaiting-review, not accepted: .* accept /);
  const empty = await f.command(['accept', run.id, 'left']);
  assert.match(empty.stdout, /has no commits beyond where it started, so integrating it changes nothing/);
  const left = await commit(f, worktrees.left, 'README.md', 'Left version.\n');
  await commit(f, worktrees.right, 'README.md', 'Right version.\n');
  assert.match((await f.command(['accept', run.id, 'right', '--commit', 'deadbeef'], { code: 2 })).stderr, /no commit deadbeef/);
  const reaccepted = await f.command(['accept', run.id, 'left']);
  assert.doesNotMatch(reaccepted.stdout, /no commits beyond/);
  assert.equal(readJson(f.taskFile(run, 'left')).acceptedCommit, left);
  await f.command(['accept', run.id, 'right']);
  await f.command(['integrate', run.id, 'left']);
  const before = await f.git(['rev-parse', 'HEAD']);
  for (const extra of [['--dry-run'], []]) {
    const conflict = await f.command(['integrate', run.id, 'right', ...extra], { code: 1 });
    assert.match(conflict.stdout, /would conflict in 1 file:\n  README\.md\nNothing was changed/);
    assert.match(conflict.stdout, new RegExp(`in ${worktrees.right}: git merge main, resolve the conflicts, and commit`));
    assert.match(conflict.stdout, /accept .* right\n.*integrate .* right/);
  }
  assert.equal(await f.git(['rev-parse', 'HEAD']), before);
  assert.equal(await f.git(['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_HEAD')), false);

  // Resolve in the task's worktree; integrate then wants the new head accepted first.
  await f.git(['-C', worktrees.right, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', 'main']).catch(() => {}); // stops on the conflict
  const resolved = await commit(f, worktrees.right, 'README.md', 'Both versions.\n');
  assert.match((await f.command(['integrate', run.id, 'right'], { code: 1 })).stderr, /is at .* but right was accepted at .*: review the newer commits/);
  assert.equal((await f.json(['accept', run.id, 'right'])).acceptedCommit, resolved);
  await f.command(['integrate', run.id, 'right']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'Both versions.\n');

  // A task that ran in the run's repository is recorded at the current head.
  await f.start(run, 'inline', { config: { finalMessage: 'Edited in place.' } });
  await f.finished(run, 'inline');
  const inlineCommit = await commit(f, f.repo, 'inline.txt', 'Inline work.\n');
  await f.command(['accept', run.id, 'inline']);
  const inline = await f.command(['integrate', run.id, 'inline']);
  assert.match(inline.stdout, /recorded inline as integrated at main @ .* \(it ran without a branch of its own\)/);
  assert.equal(readJson(f.taskFile(run, 'inline')).integratedCommit, inlineCommit);
  assert.equal(await f.git(['rev-parse', 'HEAD']), inlineCommit);
});

test('re-planning keeps started tasks, refuses to drop a running one, and dispatch waits for free slots', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const env = { AGENT_ORCH_MAX_PARALLEL: '1' };
  const slow = entry(run, 'slow', { readOnly: true, owns: [], type: 'review' }, { delayMs: 30_000 });
  const quick = entry(run, 'quick', { readOnly: true, owns: [], type: 'review' });
  await f.command(['plan', run.id, planFile(f, 'both', { goal: 'Two reviews', tasks: [slow, quick] })]);
  const first = await f.json(['dispatch', run.id], { env });
  assert.deepEqual(first.started.map((s) => s.id), ['slow']);
  assert.deepEqual(first.waitingForSlot, ['quick']);
  await f.ready(readJson(f.taskFile(run, 'slow')));
  const full = await f.command(['dispatch', run.id], { env });
  assert.match(full.stdout, /ready, waiting for a free slot \(1 running, limit 1\): quick/);
  assert.equal(fs.existsSync(f.taskFile(run, 'quick')), false);

  const dropRunning = await f.command(['plan', run.id, planFile(f, 'quick-only', { goal: 'One review', tasks: [quick] })], { code: 1 });
  assert.match(dropRunning.stderr, /task slow is running, and the new plan drops it/);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')).tasks.map((t) => t.id), ['slow', 'quick']);

  await f.command(['stop', run.id, 'slow']);
  await f.finished(run, 'slow');
  const replaced = await f.command(['plan', run.id, planFile(f, 'quick-only', { goal: 'One review', tasks: [quick] })]);
  assert.match(replaced.stdout, /dropped from the previous plan, records kept: slow \(stopped\)/);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')).tasks.map((t) => t.id), ['quick']);
  assert.ok(fs.existsSync(f.taskFile(run, 'slow')));
  assert.deepEqual((await f.json(['dispatch', run.id], { env })).started.map((s) => s.id), ['quick']);
});

test('recover groups tasks by phase, flags dirty worktrees and dead processes, and changes nothing', async (t) => {
  const f = await fixture(t);
  const parent = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: 'parent-run', AGENT_ORCH_TASK: 'parent-task' };
  const run = await f.newRun('mine', parent);
  const other = await f.newRun('other');
  const plan = {
    goal: 'Recover me',
    tasks: [
      entry(run, 'busy', { readOnly: true, owns: [], type: 'review' }, { delayMs: 30_000 }),
      entry(run, 'review-me', { owns: ['src/'] }),
      entry(run, 'oops', { readOnly: true, owns: [], type: 'debug' }, { status: 'failed', finalMessage: 'Broke.' }),
      entry(run, 'asks', { readOnly: true, owns: [], type: 'review' }, { finalMessage: 'NEEDS DECISION:\nWhich? Recommendation: this.' }),
      entry(run, 'later', { owns: ['lib/'], dependsOn: ['review-me'] }),
    ],
  };
  await f.command(['plan', run.id, planFile(f, 'plan', plan)], { env: parent });
  await f.command(['dispatch', run.id], { env: parent });
  await f.ready(readJson(f.taskFile(run, 'busy')));
  for (const id of ['review-me', 'oops', 'asks']) await f.finished(run, id);
  fs.writeFileSync(path.join(readJson(f.taskFile(run, 'review-me')).cd, 'draft.txt'), 'Unreviewed.\n');
  // A relay that dies without writing its result: the test kills the exact process it started.
  const dead = await f.start(other, 'dead', { config: { delayMs: 30_000 }, flags: ['--read-only'] });
  await f.ready(dead);
  process.kill(dead.pid, 'SIGKILL');
  await eventually(async () => (await row(f, other, 'dead')).state === 'aborted', 'relay did not die');
  await f.start(other, 'peek', { flags: ['--read-only'] });
  await f.finished(other, 'peek');

  const snapshot = () => fs.readdirSync(path.join(run.dir, 'tasks')).map((id) => fs.readFileSync(f.taskFile(run, id), 'utf8'));
  const before = snapshot();
  const text = (await f.command(['recover', run.id])).stdout;
  assert.match(text, new RegExp(`run ${run.id}: Black-box CLI fixture`));
  assert.match(text, /plan of 5 tasks/);
  assert.match(text, /running \(1\): busy \(claude, /);
  assert.match(text, /next: .* wait .* --timeout 0/);
  assert.match(text, /needs decision \(1\): asks\n    next: .* result .* asks; decide, then resume it: .* start .* asks --agent claude .* -- --session fixture-claude/);
  assert.match(text, /failed \(1\): oops \(failed\)/);
  assert.match(text, /awaiting review \(1\): review-me \(waited 0m\)\n    next: .* result .* review-me; review and commit its work; then .* accept .* review-me/);
  assert.match(text, /blocked \(1\): later waits on review-me \(awaiting-review\)/);
  assert.match(text, /! review-me: 1 uncommitted change in its worktree/);
  assert.deepEqual(snapshot(), before);

  const otherText = (await f.command(['recover', other.id])).stdout;
  assert.match(otherText, /no plan/);
  assert.match(otherText, /failed \(1\): dead \(aborted\)/);
  assert.match(otherText, /awaiting review \(1\): peek/);
  assert.match(otherText, /! dead: its process is gone without a result \(.* log .* dead\)/);

  const json = await f.json(['recover', run.id]);
  assert.deepEqual(json.runs[0].groups.running, ['busy']);
  assert.deepEqual(json.runs[0].groups.blocked, [{ id: 'later', waitsOn: [{ id: 'review-me', phase: 'awaiting-review' }] }]);
  assert.equal(json.runs[0].groups['awaiting-review'][0].id, 'review-me');

  // Without RUN: the runs this session launched; --all: every run active in the last day.
  const mine = await f.json(['recover'], { env: parent });
  assert.match(mine.scope, /runs launched by task parent-task of run parent-run/);
  assert.deepEqual(mine.runs.map((r) => r.id), [run.id]);
  const all = await f.json(['recover', '--all']);
  assert.deepEqual(all.runs.map((r) => r.id).sort(), [run.id, other.id].sort());
  assert.deepEqual(snapshot(), before);

  // Closing a task, or collecting its result, moves it out of the groups that need action.
  await f.command(['close', run.id, 'busy']);
  await f.command(['result', run.id, 'oops']);
  const after = (await f.command(['recover', run.id])).stdout;
  assert.match(after, /closed after failing \(2\): busy, oops/);
  assert.doesNotMatch(after, /running \(/);
  await f.command(['result', other.id, 'peek']);
  assert.match((await f.command(['recover', other.id])).stdout, /integrated \(1\): peek/);
});

// Regression tests for a review of the lifecycle commands: each failed before its fix.

// A finished task in its own worktree whose committed change the orchestrator accepted.
async function acceptedTask(f, run, id, file = `${id}.txt`) {
  const wt = await f.json(['worktree', run.id, id]);
  await f.start(run, id);
  await f.finished(run, id);
  const sha = await commit(f, wt.path, file, `${id} work\n`);
  await f.command(['accept', run.id, id]);
  return { path: wt.path, branch: wt.branch, commit: sha };
}

test('plan records briefs that are not written yet, and dispatch starts a task only once its brief is ready', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const plan = {
    goal: 'Plan first, brief later',
    tasks: [
      entry(run, 'now'),
      entry(run, 'drafted', { brief: 'briefs/drafted-later.md' }),
      entry(run, 'unwritten', { brief: 'briefs/unwritten-later.md' }),
    ],
  };
  const planned = await f.command(['plan', run.id, planFile(f, 'plan', plan)]);
  assert.match(planned.stdout, /briefs not ready \(dispatch starts these tasks once they are\): drafted \(not written yet\), unwritten \(not written yet\); draft one with: .* brief /);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')), plan);

  // `brief` drafts from the recorded plan; its draft still has markers to fill in.
  await f.command(['brief', run.id, 'drafted']);
  const draft = path.join(run.dir, 'briefs', 'drafted-later.md');
  assert.match(fs.readFileSync(draft, 'utf8'), /<fill in:/);
  // dispatch refuses those two before preparing anything, and they use no slot.
  const first = await f.json(['dispatch', run.id], { code: 1, env: { AGENT_ORCH_MAX_PARALLEL: '1' } });
  assert.deepEqual(first.started.map((s) => s.id), ['now']);
  assert.deepEqual(first.failed.map((x) => x.id), ['drafted', 'unwritten']);
  assert.match(first.failed[0].error, /^brief contains \d+ unfilled markers?: .*<fill in:.*; write it \(.* brief .* drafted drafts it from the plan\), then dispatch again$/);
  assert.equal(first.failed[1].error, `brief is missing or empty: ${path.join(run.dir, 'briefs', 'unwritten-later.md')}; write it (node ${fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url))} brief ${run.id} unwritten drafts it from the plan), then dispatch again`);
  assert.equal(fs.existsSync(f.taskFile(run, 'drafted')), false);
  assert.equal(fs.existsSync(path.join(run.dir, 'worktrees', 'drafted')), false);
  await f.finished(run, 'now');
  const hint = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(hint.stdout, /ready, waiting for a brief: drafted \(\d+ unfilled .*\), unwritten \(not written yet\)/);
  assert.match((await f.command(['recover', run.id])).stdout, /ready, waiting for a brief \(2\): drafted .*\n    next: .* brief .* <task>; fill it in; then .* dispatch /);

  fs.writeFileSync(draft, 'Planned task drafted, now filled in.\n<!-- fake-relay {} -->\n');
  const second = await f.command(['dispatch', run.id], { code: 1 });
  assert.match(second.stdout, /started drafted → claude/);
  assert.match(second.stdout, /could not start unwritten: brief is missing or empty: .*unwritten-later\.md; write it/);
  await f.finished(run, 'drafted');
});

test('a plan task without a tier is refused by plan, and by dispatch for that task only', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = (id, extra = {}) => entry(run, id, { type: 'research', readOnly: true, owns: [], ...extra });
  const plan = { goal: 'Mixed tiers', tasks: [task('no-tier', { tier: null }), task('codex-no-tier', { agent: 'codex', tier: null }), task('light-one', { tier: 'light' }), task('codex-one', { agent: 'codex', tier: 'standard' })] };
  // `plan` and `plan --check` name each task and its tiers, and record nothing.
  for (const flags of [[], ['--check']]) {
    const refused = await f.command(['plan', run.id, planFile(f, 'mixed', plan), ...flags], { code: 1 });
    assert.match(refused.stderr, /task no-tier: a Claude task needs a tier \(light, standard or complex\)/);
    assert.match(refused.stderr, /task codex-no-tier: a Codex task needs a tier \(standard or complex\)/);
    assert.doesNotMatch(refused.stderr, /light-one|codex-one/);
  }
  assert.equal(fs.existsSync(path.join(run.dir, 'plan.json')), false);
  // A plan recorded before tiers were required still dispatches its other tasks. Dry run and real run alike.
  fs.writeFileSync(path.join(run.dir, 'plan.json'), JSON.stringify(plan));
  const dry = await f.command(['dispatch', run.id, '--dry-run'], { code: 1 });
  assert.match(dry.stdout, /could not start no-tier: a Claude task needs a tier \(light, standard or complex\).*; set its tier in the plan and record it again/);
  assert.match(dry.stdout, /could not start codex-no-tier: a Codex task needs a tier \(standard or complex\)/);
  assert.match(dry.stdout, /would start light-one → claude \(light tier\)/);
  assert.match(dry.stdout, /would start codex-one → codex \(standard tier\)/);
  const out = await f.json(['dispatch', run.id], { code: 1 });
  assert.deepEqual(out.started.map((s) => s.id), ['light-one', 'codex-one']);
  assert.deepEqual(out.failed.map((x) => x.id), ['no-tier', 'codex-no-tier']);
  assert.equal(fs.existsSync(f.taskFile(run, 'no-tier')), false);
  assert.equal(readJson(f.taskFile(run, 'light-one')).tier, 'light');
  await f.finished(run, 'light-one');
  await f.finished(run, 'codex-one');
});

test('a refused task uses no slot: dispatch starts the next ready task instead', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.command(['plan', run.id, planFile(f, 'plan', { goal: 'Two tasks', tasks: [entry(run, 'unavailable'), entry(run, 'available', { agent: 'codex', tier: 'standard' })] })]);
  fs.rmSync(path.join(f.skills, 'claude-delegate'), { recursive: true });
  const out = await f.json(['dispatch', run.id], { code: 1, env: { AGENT_ORCH_MAX_PARALLEL: '1' } });
  assert.deepEqual(out.started.map((s) => s.id), ['available']);
  assert.deepEqual(out.failed.map((x) => x.id), ['unavailable']);
  assert.match(out.failed[0].error, /no claude-delegate relay found/);
  assert.deepEqual(out.waitingForSlot, []);
  await f.finished(run, 'available');
});

test('re-planning keeps the owned paths and resources a running task started with', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = entry(run, 'first', { owns: ['src/first/'], resources: ['port:8080'] }, { delayMs: 30_000 });
  await f.command(['plan', run.id, planFile(f, 'one', { goal: 'Reserve', tasks: [first] })]);
  await f.command(['dispatch', run.id]);
  await f.ready(readJson(f.taskFile(run, 'first')));

  const second = entry(run, 'second', { owns: ['src/first/api.js'], resources: ['port:8080'] });
  const shrunk = { ...first, owns: ['src/elsewhere/'], resources: [] };
  const refused = await f.command(['plan', run.id, planFile(f, 'two', { goal: 'Reserve', tasks: [shrunk, second] })], { code: 1 });
  assert.match(refused.stderr, /tasks first and second can run at the same time but both own src\/first\/ \/ src\/first\/api\.js and use port:8080 \(first is running, and keeps the paths and resources it started with until it finishes\)/);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')).tasks, [first]);

  await f.command(['plan', run.id, planFile(f, 'ordered', { goal: 'Reserve', tasks: [shrunk, { ...second, dependsOn: ['first'] }] })]);
  assert.deepEqual(readJson(path.join(run.dir, 'plan.json')).tasks.map((x) => x.id), ['first', 'second']);
});

test('dispatch refuses a prepared worktree that lacks a prerequisite\'s integrated work, and says how to fix it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const plan = {
    goal: 'Build on the producer',
    tasks: [
      entry(run, 'producer'),
      entry(run, 'merged-in', { dependsOn: ['producer'] }),
      entry(run, 'recreated', { dependsOn: ['producer'] }),
    ],
  };
  await f.command(['plan', run.id, planFile(f, 'plan', plan)]);
  // Worktrees prepared before the producer's work landed.
  const stale = { 'merged-in': await f.json(['worktree', run.id, 'merged-in']), recreated: await f.json(['worktree', run.id, 'recreated']) };
  await f.command(['dispatch', run.id]);
  await f.finished(run, 'producer');
  await commit(f, readJson(f.taskFile(run, 'producer')).cd, 'src/producer/api.js', 'export const api = 1;\n');
  await f.command(['accept', run.id, 'producer']);
  await f.command(['integrate', run.id, 'producer']);
  const integrated = readJson(f.taskFile(run, 'producer')).integratedCommit;

  assert.deepEqual((await f.json(['dispatch', run.id, '--dry-run'], { code: 1 })).wouldStart, []);
  const refused = await f.json(['dispatch', run.id], { code: 1 });
  assert.deepEqual(refused.started, []);
  assert.deepEqual(refused.failed.map((x) => x.id), ['merged-in', 'recreated']);
  const wt = stale['merged-in'];
  assert.equal(refused.failed[0].error,
    `merged-in would start in ${wt.path} (branch ${wt.branch} @ ${run.baseCommit.slice(0, 12)}), which lacks the work of producer (integrated at ${integrated.slice(0, 12)}); ` +
    `merge the base branch into it (git -C ${wt.path} merge main), or remove it (git -C ${f.repo} worktree remove ${wt.path} && git -C ${f.repo} branch -d ${wt.branch}), then dispatch again`);
  assert.equal(readJson(f.taskFile(run, 'merged-in')).pid, undefined);

  // Either fix works: merge the base into the prepared worktree, or remove it and its branch.
  await f.git(['-C', wt.path, 'merge', '-q', 'main']);
  await f.git(['worktree', 'remove', stale.recreated.path]);
  await f.git(['branch', '-d', stale.recreated.branch]);
  const started = await f.json(['dispatch', run.id]);
  assert.deepEqual(started.started.map((s) => s.id), ['merged-in', 'recreated']);
  for (const id of ['merged-in', 'recreated']) {
    const task = readJson(f.taskFile(run, id));
    assert.equal(fs.readFileSync(path.join(task.cd, 'src', 'producer', 'api.js'), 'utf8'), 'export const api = 1;\n');
    await f.finished(run, id);
  }
  assert.equal(readJson(f.taskFile(run, 'recreated')).worktree.from, await f.git(['rev-parse', 'main']));
});

test('dispatch refuses a read-only task whose checkout lacks work integrated into another branch', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.command(['plan', run.id, planFile(f, 'plan', {
    goal: 'Review the producer',
    tasks: [entry(run, 'producer'), entry(run, 'review', { type: 'review', readOnly: true, owns: [], dependsOn: ['producer'] })],
  })]);
  await f.command(['dispatch', run.id]);
  await f.finished(run, 'producer');
  await commit(f, readJson(f.taskFile(run, 'producer')).cd, 'producer.txt', 'API\n');
  await f.command(['accept', run.id, 'producer']);
  await f.git(['checkout', '-qb', 'integration']);
  await f.command(['integrate', run.id, 'producer', '--into', 'integration']);
  const integrated = readJson(f.taskFile(run, 'producer')).integratedCommit;
  await f.git(['checkout', '-q', 'main']);

  const refused = await f.json(['dispatch', run.id], { code: 1 });
  assert.deepEqual(refused.started, []);
  const head = (await f.git(['rev-parse', 'main'])).slice(0, 12);
  assert.equal(refused.failed[0].error,
    `review would start in ${f.repo} (branch main @ ${head}), which lacks the work of producer (integrated at ${integrated.slice(0, 12)}); ` +
    `check out a branch there that contains it (git -C ${f.repo} branch --contains ${integrated.slice(0, 12)}), then dispatch again`);
  assert.equal(fs.existsSync(f.taskFile(run, 'review')), false);
  await f.git(['checkout', '-q', 'integration']);
  assert.deepEqual((await f.json(['dispatch', run.id])).started.map((s) => s.id), ['review']);
  await f.finished(run, 'review');
});

test('integrate refuses to run during the user\'s own merge, and leaves that merge alone', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await acceptedTask(f, run, 'user-merge');
  // A merge in progress with a clean index passes the uncommitted-changes check.
  await f.git(['checkout', '-qb', 'user-side']);
  await commit(f, f.repo, 'side.txt', 'side\n');
  await f.git(['checkout', '-q', 'main']);
  await f.git(['merge', '--no-commit', '-s', 'ours', 'user-side']);
  const userMerge = await f.git(['rev-parse', 'MERGE_HEAD']);
  const busy = await f.command(['integrate', run.id, 'user-merge'], { code: 1 });
  assert.equal(await f.git(['rev-parse', 'MERGE_HEAD']), userMerge);
  assert.match(busy.stderr, /cannot integrate user-merge yet:\n- a merge is in progress in .*; finish or abort it yourself/);
  assert.match((await f.command(['integrate', run.id, 'user-merge', '--dry-run'])).stdout, /merges cleanly into main; nothing was changed\nnote: a merge is in progress in /);
  await f.git(['merge', '--abort']);
  await f.command(['integrate', run.id, 'user-merge']);
});

test('integrate never overwrites an ignored local file that the task\'s branch adds', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await acceptedTask(f, run, 'ignored', 'local.env');
  const integratedAt = (id) => readJson(f.taskFile(run, id)).integratedAt;
  await commit(f, f.repo, '.gitignore', 'local.env\n');
  fs.writeFileSync(path.join(f.repo, 'local.env'), 'USER LOCAL VALUE\n');
  const head = await f.git(['rev-parse', 'HEAD']);
  const ignored = await f.command(['integrate', run.id, 'ignored'], { code: 1 });
  assert.equal(fs.readFileSync(path.join(f.repo, 'local.env'), 'utf8'), 'USER LOCAL VALUE\n');
  assert.match(ignored.stderr, /cannot integrate ignored: merging .* would overwrite 1 file .*: local\.env; move it aside yourself, then integrate again/);
  assert.equal(await f.git(['rev-parse', 'HEAD']), head);
  assert.equal(integratedAt('ignored'), undefined);
  assert.match((await f.command(['integrate', run.id, 'ignored', '--dry-run'])).stdout, /note: merging .* would overwrite 1 file in .* that git does not track \(ignored or untracked\): local\.env/);
  fs.renameSync(path.join(f.repo, 'local.env'), path.join(f.root, 'local.env'));
  await f.command(['integrate', run.id, 'ignored']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'local.env'), 'utf8'), 'ignored work\n');
});

test('integrate overrides merge settings that would leave the merge uncommitted or squashed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const tasks = { 'no-commit': await acceptedTask(f, run, 'no-commit'), squash: await acceptedTask(f, run, 'squash') };
  const mergeHead = path.join(f.repo, '.git', 'MERGE_HEAD');
  for (const [id, option] of [['no-commit', '--no-commit'], ['squash', '--squash']]) {
    await f.git(['config', 'branch.main.mergeOptions', option]);
    const before = await f.git(['rev-parse', 'HEAD']);
    await f.command(['integrate', run.id, id]);
    const after = await f.git(['rev-parse', 'HEAD']);
    assert.notEqual(after, before, option);
    assert.equal(await f.git(['rev-parse', 'HEAD^2']), tasks[id].commit, option);
    assert.equal(fs.existsSync(mergeHead), false, option);
    assert.equal(readJson(f.taskFile(run, id)).integratedCommit, after, option);
  }
});

test('integrate undoes a merge a hook stopped, and says so when undoing it fails too', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await acceptedTask(f, run, 'hooked');
  const mergeHead = path.join(f.repo, '.git', 'MERGE_HEAD');
  const integratedAt = (id) => readJson(f.taskFile(run, id)).integratedAt;
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-merge-commit');
  const before = await f.git(['rev-parse', 'HEAD']);
  // The hook dirties a file the merge touches, so that `git merge --abort` fails as well.
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "hook changed it\\n" > hooked.txt\nexit 1\n', { mode: 0o755 });
  const stuck = await f.command(['integrate', run.id, 'hooked'], { code: 1 });
  assert.equal(fs.existsSync(mergeHead), true);
  assert.doesNotMatch(stuck.stderr, /aborted|it was undone/);
  assert.match(stuck.stderr, /git merge failed in .*, and undoing it failed too, so the merge is still in progress there; hooked is not integrated\./);
  assert.match(stuck.stderr, /git merge --abort said: .*not uptodate/);
  assert.match(stuck.stderr, /To recover: see what is left with git -C .* status\. Finish the merge with git -C .* commit, or set aside the files it lists and run git -C .* merge --abort\. Then integrate again\./);
  assert.equal(integratedAt('hooked'), undefined);
  assert.equal(await f.git(['rev-parse', 'HEAD']), before);
  await f.git(['reset', '-q', '--hard']);

  // An ordinary refusal by the hook is undone, leaving the checkout as it was.
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const undone = await f.command(['integrate', run.id, 'hooked'], { code: 1 });
  assert.match(undone.stderr, /git merge failed in .*; it was undone, so the checkout is as it was, and hooked is not integrated/);
  assert.equal(fs.existsSync(mergeHead), false);
  assert.equal(await f.git(['status', '--porcelain']), '');
  assert.equal(await f.git(['rev-parse', 'HEAD']), before);
  fs.rmSync(hook);
  await f.command(['integrate', run.id, 'hooked']);
  assert.ok(integratedAt('hooked'));
});

test('integrate needs --into for a run started on a detached HEAD', async (t) => {
  const f = await fixture(t);
  await f.git(['checkout', '-q', '--detach']);
  const run = await f.newRun();
  assert.equal(run.baseBranch, null);
  const writer = await acceptedTask(f, run, 'writer');
  const detached = await f.command(['integrate', run.id, 'writer'], { code: 2 });
  assert.match(detached.stderr, /the run started on a detached HEAD, so it has no base branch; pass --into BRANCH/);
  await f.git(['checkout', '-q', 'main']);
  await f.command(['integrate', run.id, 'writer', '--into', 'main']);
  assert.equal(await f.git(['rev-parse', 'HEAD^2']), writer.commit);
  assert.equal(fs.readFileSync(path.join(f.repo, 'writer.txt'), 'utf8'), 'writer work\n');
});
