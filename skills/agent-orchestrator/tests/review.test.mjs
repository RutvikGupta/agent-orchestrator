import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

const block = (unresolved = []) => `\`\`\`orch-result\n${JSON.stringify({ outcome: 'done', changed: [], checks: [], decisions: [], unresolved })}\n\`\`\`\n`;
// An author's final report, and a reviewer's: its findings, its verdict line, then the block.
const report = (text) => `${text}\n\n${block()}`;
const verdict = (prose, word, unresolved) => `${prose}\n\nVERDICT: ${word}\n\n${block(unresolved)}`;
// The fake relay takes its controls from the first fake-relay comment of its brief. A review brief
// quotes --focus before the author's brief, so a focus that carries one controls the reviewer.
const controls = (config) => `<!-- fake-relay ${JSON.stringify(config).replaceAll('-->', '--\\u003e')} -->`;
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = async (f, cwd, message) => {
  await f.git(['-C', cwd, 'add', '-A']);
  await f.git(['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message]);
};
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const briefOf = (task) => fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');
const roundsOf = (run, id) => {
  const file = path.join(run.dir, 'tasks', id, 'reviews.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

test('review starts Codex on Claude work at the standard tier for a small diff, with the brief, the whole diff and the report', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const wt = (await f.json(['worktree', run.id, 'work', '--no-prep'])).path;
  // A brief with no fake-relay comment takes the relay's controls from FAKE_RELAY_CONFIG: this report
  // quotes a marker, which `start` would refuse in a brief.
  const authorBrief = path.join(f.root, 'work-brief.md');
  fs.writeFileSync(authorBrief, 'Fixture task work.\n');
  const finalMessage = report('Added greet() and its test. Left a <fill in: example> marker in the docs.');
  await f.command(['start', run.id, 'work', '--agent', 'claude', '--tier', 'complex', '--why', 'fixture author', '--brief', authorBrief], { env: { FAKE_RELAY_CONFIG: JSON.stringify({ finalMessage }) } });
  await f.finished(run, 'work');
  write(wt, 'greet.mjs', 'export const greet = (name) => `hi ${name}`;\n');
  await commit(f, wt, 'Add greet');
  fs.appendFileSync(path.join(wt, 'README.md'), 'Uncommitted line.\n');
  write(wt, 'notes.txt', 'A new untracked file.\n');

  const review = await f.json(['review', run.id, 'work']);
  assert.deepEqual([review.review, review.round, review.attempt, review.agent, review.tier], ['review-work', 1, 1, 'codex', 'standard']);
  assert.deepEqual([review.size.lines, review.size.files, review.size.tier], [3, 3, 'standard']);
  await f.finished(run, 'review-work');
  const saved = readJson(f.taskFile(run, 'review-work'));
  assert.deepEqual([saved.agent, saved.tier, saved.readOnly, saved.cd], ['codex', 'standard', true, wt]);
  assert.deepEqual(saved.reviews, { task: 'work', attempt: 1, round: 1 });
  assert.equal(saved.why, "codex reviews work's claude work, the other model; 3 changed lines in 3 files, no shared module: standard tier");
  assert.ok(readJson(path.join(saved.outDir, 'invocation.json')).argv.includes('--read-only'));

  const brief = briefOf(review.started);
  assert.match(brief, /Fixture task work\./, "the author's brief");
  assert.match(brief, /^\+export const greet/m, 'a committed change');
  assert.match(brief, /^\+Uncommitted line\.$/m, 'an uncommitted change');
  assert.match(brief, /^\+A new untracked file\.$/m, 'a new file');
  assert.match(brief, /Added greet\(\) and its test\./, "the author's report");
  assert.ok(brief.includes('<​fill in: example>'), 'a quoted marker does not stop the start');
  assert.ok(brief.includes(`git -C ${wt} diff `), 'Codex gets the command to see the diff itself');
  for (const rule of [/file and line/, /severity/, /failing input/, /the fix you would make/, /Leave out style/, /`VERDICT: changes`/, /`VERDICT: clean`/]) assert.match(brief, rule);
  // The author's brief is quoted without the notes `start` appended to it; the reviewer's own follow.
  assert.equal(brief.split('\n## Decisions\n').length, 2);
});

test('a Claude reviewer of Codex work gets the diff in its brief; a large diff gets the complex tier, and a later round its own name', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'big', { agent: 'codex', config: { finalMessage: report('Wrote the table.') } });
  await f.finished(run, 'big');
  write(f.repo, 'table.txt', numbered(200));

  const first = await f.json(['review', run.id, 'big']);
  assert.deepEqual([first.review, first.agent, first.tier, first.size.lines, first.size.files], ['review-big', 'claude', 'complex', 200, 1]);
  assert.match(first.started.why, /200 changed lines in 1 file, more than the standard tier's 150 lines in 3 files: complex tier$/);
  const brief = briefOf(first.started);
  assert.match(brief, /^\+line 200$/m);
  assert.match(brief, /no shell, so the diff follows/);
  assert.doesNotMatch(brief, /git -C /);

  await f.finished(run, 'review-big');
  const second = await f.json(['review', run.id, 'big', '--tier', 'standard']);
  assert.deepEqual([second.review, second.round, second.tier, second.size.tier], ['review-big-2', 2, 'standard', 'complex']);
  assert.match(second.started.why, /complex tier; --tier standard given$/);
  assert.deepEqual(readJson(f.taskFile(run, 'review-big-2')).reviews, { task: 'big', attempt: 1, round: 2 });
});

test('a small change to a module that other files import is reviewed at the complex tier', async (t) => {
  const f = await fixture(t);
  write(f.repo, 'lib/util.mjs', 'export const one = 1;\n');
  write(f.repo, 'main.mjs', "import { one } from './lib/util.mjs';\nconsole.log(one);\n");
  write(f.repo, 'pkg/helpers.py', 'def helper():\n    return 1\n');
  write(f.repo, 'app.py', 'from pkg import helpers\n');
  write(f.repo, 'solo.mjs', 'export const solo = 1;\n');
  await commit(f, f.repo, 'Add modules');
  const cases = [
    ['lib/util.mjs', 'export const two = 2;\n', 'complex', /with a shared module \(lib\/util\.mjs, imported by main\.mjs\): complex tier/],
    ['pkg/helpers.py', 'TWO = 2\n', 'complex', /with a shared module \(pkg\/helpers\.py, imported by app\.py\): complex tier/],
    ['solo.mjs', 'export const two = 2;\n', 'standard', /1 changed line in 1 file, no shared module: standard tier/],
  ];
  for (const [i, [file, added, tier, why]] of cases.entries()) {
    const run = await f.newRun(`shared-${i}`);
    await f.start(run, 'edit');
    await f.finished(run, 'edit');
    fs.appendFileSync(path.join(f.repo, file), added);
    const review = await f.json(['review', run.id, 'edit']);
    assert.equal(review.tier, tier, file);
    assert.match(review.size.text, why);
    await f.git(['checkout', '--', '.']);
  }

  // A new module that another file imports is shared as well.
  const run = await f.newRun('shared-new');
  await f.start(run, 'edit');
  await f.finished(run, 'edit');
  write(f.repo, 'lib/fresh.mjs', 'export const fresh = 1;\n');
  fs.appendFileSync(path.join(f.repo, 'main.mjs'), "import { fresh } from './lib/fresh.mjs';\n");
  const review = await f.json(['review', run.id, 'edit']);
  assert.equal(review.tier, 'complex');
  assert.match(review.size.text, /2 changed lines in 2 files, with a shared module \(lib\/fresh\.mjs, imported by main\.mjs\): complex tier/);
});

test('a diff too large for the brief is cut at file boundaries, and the top of the brief names every file left out or cut short', async (t) => {
  const f = await fixture(t);
  // About 207 KB of diff for one file, more than the brief holds (about 195 KB).
  const big = Array.from({ length: 4000 }, (_, i) => `a long line of text in the big change, number ${String(i + 1).padStart(5, '0')}`).join('\n') + '\n';

  // One file too large on its own: the brief shows its first part, and names it as cut short.
  const one = await f.newRun('one');
  await f.start(one, 'huge');
  await f.finished(one, 'huge');
  fs.appendFileSync(path.join(f.repo, 'README.md'), big);
  const brief = briefOf((await f.json(['review', one.id, 'huge'])).started);
  const top = brief.indexOf('## Files not shown in full');
  assert.ok(top > 0 && top < brief.indexOf("## The author's brief"), 'named at the top of the brief');
  assert.match(brief, /^- `README\.md` \(\+4000 −0, a 2\d\d KB diff\): cut short: the brief shows its first 19\d KB$/m);
  assert.ok(brief.includes(`\`git -C ${f.repo} diff `) && brief.includes(' -- <file>`'), 'Codex is told to read it with git diff');
  assert.match(brief, /number 00001$/m);
  assert.doesNotMatch(brief, /number 04000$/m);
  assert.match(brief, /This diff leaves out or cuts short 1 file, named under "Files not shown in full"/);
  await f.git(['checkout', '--', '.']);

  // Several files: each that fits is shown whole; one that does not is left out, never cut.
  const two = await f.newRun('two');
  await f.start(two, 'mixed', { agent: 'codex' });
  await f.finished(two, 'mixed');
  fs.appendFileSync(path.join(f.repo, 'README.md'), big);
  write(f.repo, 'small.txt', 'a small new file\n');
  write(f.repo, 'large.txt', big + big);
  const brief2 = briefOf((await f.json(['review', two.id, 'mixed'])).started);
  assert.match(brief2, /^- `README\.md` \(\+4000 −0, a 2\d\d KB diff\): left out$/m);
  assert.match(brief2, /^- `large\.txt` \(new, 8000 lines, 4\d\d KB, not diffed\): left out$/m);
  assert.match(brief2, /^\+a small new file$/m, 'a file that fits is shown whole');
  assert.doesNotMatch(brief2, /number 00001$/m, 'a file left out is not cut short');
  assert.ok(brief2.includes(`Read each of them directly with the Read tool, in \`${f.repo}\`, which holds the author's version`), 'Claude is told to read them');
});

test('an author that worked in a subfolder has the whole checkout reviewed, with paths from its top', async (t) => {
  const f = await fixture(t);
  write(f.repo, 'lib/util.mjs', 'export const one = 1;\n');
  write(f.repo, 'app/main.mjs', "import { one } from '../lib/util.mjs';\n");
  await commit(f, f.repo, 'Add modules');
  const run = await f.newRun();
  const app = path.join(f.repo, 'app');
  await f.start(run, 'sub', { flags: ['--cd', app] });
  await f.finished(run, 'sub');
  fs.appendFileSync(path.join(f.repo, 'lib/util.mjs'), 'export const two = 2;\n');
  write(app, 'new.mjs', 'export const n = 1;\n');
  const review = await f.json(['review', run.id, 'sub']);
  assert.deepEqual([review.size.lines, review.size.files, review.tier], [2, 2, 'complex']);
  assert.match(review.size.text, /lib\/util\.mjs, imported by app\/main\.mjs/);
  assert.match(briefOf(review.started), /`app\/new\.mjs` \(new, \+1 −0\)/);
  assert.equal(readJson(f.taskFile(run, 'review-sub')).cd, app, 'the reviewer works where the author worked');
});

test('rework resumes the author in its own session with the findings, its scope and gates, as a rework; the verdict is recorded once', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const authorBrief = path.join(f.root, 'work-brief.md');
  fs.writeFileSync(authorBrief, `## Goal\n\nParse comma lists.\n\n## Scope\n\nChange only parse.mjs.\n\n## Gates\n\nnode --test parse.test.mjs\n\n## Report\n\nKeep it short.\n${controls({ finalMessage: report('Parsed the input.') })}\n`);
  await f.command(['start', run.id, 'work', '--agent', 'claude', '--tier', 'complex', '--why', 'fixture author', '--brief', authorBrief]);
  const first = await f.finished(run, 'work');
  write(f.repo, 'parse.mjs', 'export const parse = (s) => s.split(",");\n');
  const finding = 'parse.mjs:1 (medium): parse("") returns [""] instead of []; fix: return [] for an empty string.';
  const message = verdict(`1. ${finding}\n\nCommands run: none.`, 'changes', [finding]);
  await f.json(['review', run.id, 'work', '--focus', controls({ finalMessage: message })]);
  await f.finished(run, 'review-work');

  // `status` records the reviewer's verdict line as a review round of the author.
  const row = (await f.json(['status', run.id])).tasks.find((task) => task.id === 'work');
  assert.deepEqual(row.reviewRounds.map((r) => [r.round, r.attempt, r.verdict, r.reviewer]), [[1, 1, 'changes', 'review-work']]);
  assert.match(row.reviewRounds[0].note, /^1 finding: parse\.mjs:1 \(medium\)/);

  const rework = await f.json(['rework', run.id, 'work', '--note', 'Fix the empty input only.']);
  assert.deepEqual([rework.from, rework.reviewed, rework.round, rework.started.attempt], ['review-work', 1, 1, 2]);
  await f.finished(run, 'work');
  const saved = readJson(f.taskFile(run, 'work'));
  assert.deepEqual([saved.attemptReason, saved.agent, saved.tier, saved.readOnly], ['rework', 'claude', 'complex', false]);
  assert.deepEqual(saved.reworkFrom, { 2: 'review-work' });
  const argv = readJson(path.join(saved.outDir, 'invocation.json')).argv;
  assert.equal(argv[argv.indexOf('--session') + 1], first.session);
  const brief = briefOf(saved);
  assert.ok(brief.includes(finding));
  assert.match(brief, /Fix the empty input only\./);
  assert.match(brief, /### Scope\n\nChange only parse\.mjs\.\n\n### Gates\n\nnode --test parse\.test\.mjs/);
  assert.doesNotMatch(brief, /Keep it short|VERDICT/);
  assert.equal(roundsOf(run, 'work').length, 1, 'status and rework record the round once');
  assert.equal((await f.json(['status', run.id])).tasks.find((task) => task.id === 'work').attemptReason, 'rework');
});

test('rework refuses a clean review and points to accept, which sees the clean verdict', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'tidy');
  await f.finished(run, 'tidy');
  write(f.repo, 'tidy.txt', 'tidy\n');
  await f.json(['review', run.id, 'tidy', '--focus', controls({ finalMessage: verdict('I found no defect.', 'clean', []) })]);
  await f.finished(run, 'review-tidy');
  await commit(f, f.repo, 'Tidy');

  const accepted = await f.json(['accept', run.id, 'tidy']);
  assert.equal(accepted.cleanVerdict, true);
  assert.deepEqual(roundsOf(run, 'tidy').map((r) => [r.round, r.attempt, r.verdict, r.reviewer, r.note]), [[1, 1, 'clean', 'review-tidy', null]]);
  const refused = await f.command(['rework', run.id, 'tidy'], { code: 1 });
  assert.match(refused.stderr, /review-tidy found nothing to fix \(VERDICT: clean\), so there is nothing to rework\. Accept tidy instead: .* accept \S+ tidy/);
  assert.equal(readJson(f.taskFile(run, 'tidy')).attempt, 1, 'the author is not resumed');
  assert.equal(roundsOf(run, 'tidy').length, 1);
});

test('rework takes the findings of a reviewer started by hand, and refuses one that found nothing', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'work', { agent: 'codex' });
  await f.finished(run, 'work');
  const finding = 'a.mjs:2 (high): crashes on null.';
  await f.start(run, 'look', { flags: ['--read-only'], config: { finalMessage: `1. ${finding}\n\n${block([finding])}` } });
  await f.start(run, 'blank', { flags: ['--read-only'], config: { finalMessage: block() } });
  // A clean review that adds a field of its own, such as a summary, is still clean.
  const summary = '```orch-result\n' + JSON.stringify({ outcome: 'done', changed: [], checks: [], decisions: [], unresolved: [], summary: 'No defects found.' }) + '\n```';
  await f.start(run, 'tidy', { flags: ['--read-only'], config: { finalMessage: summary } });
  await f.finished(run, 'look');
  await f.finished(run, 'blank');
  await f.finished(run, 'tidy');
  assert.match((await f.command(['rework', run.id, 'work', '--from', 'tidy'], { code: 1 })).stderr, /no verdict line, and no finding/);
  assert.match((await f.command(['rework', run.id, 'work'], { code: 1 })).stderr, /no review of work/);
  assert.match((await f.command(['rework', run.id, 'work', '--from', 'blank'], { code: 1 })).stderr, /no verdict line, and no finding under unresolved/);
  const rework = await f.json(['rework', run.id, 'work', '--from', 'look']);
  assert.equal(rework.started.attempt, 2);
  await f.finished(run, 'work');
  const saved = readJson(f.taskFile(run, 'work'));
  assert.deepEqual([saved.attemptReason, saved.agent, saved.tier], ['rework', 'codex', 'standard']);
  assert.ok(briefOf(saved).includes(finding));
  assert.match(briefOf(saved), /## Which findings to fix\n\nAll of them\./);
  assert.deepEqual(roundsOf(run, 'work').map((r) => [r.verdict, r.reviewer, r.note]), [['changes', 'look', `1 finding: ${finding}`]]);
});

test('rework passes on the findings of the report block with the prose, and --tier to start', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'work', { agent: 'codex' });
  await f.finished(run, 'work');
  const listed = 'x.mjs:3 (medium): parse("") throws; fix: return [] for an empty string.';
  const detail = { file: 'y.mjs', line: 7, severity: 'low', input: 'parse(null)', fix: 'guard null' };
  const block2 = JSON.stringify({ outcome: 'done', changed: [], checks: [], decisions: [], unresolved: [listed], findings: [detail] });
  const message = `Found two defects; the details are in the block.\n\nVERDICT: changes\n\n\`\`\`orch-result\n${block2}\n\`\`\`\n`;
  await f.start(run, 'look', { flags: ['--read-only'], config: { finalMessage: message } });
  await f.finished(run, 'look');
  const rework = await f.json(['rework', run.id, 'work', '--from', 'look', '--tier', 'complex']);
  assert.equal(rework.started.tier, 'complex');
  await f.finished(run, 'work');
  const saved = readJson(f.taskFile(run, 'work'));
  assert.deepEqual([saved.attempt, saved.attemptReason, saved.agent, saved.tier], [2, 'rework', 'codex', 'complex']);
  assert.equal(saved.why, "rework of look's findings on attempt 1, which ran the standard tier, at the complex tier");
  const brief = briefOf(saved);
  assert.match(brief, /Found two defects; the details are in the block\./);
  assert.ok(brief.includes(`From \`unresolved\`:\n\n- ${listed}`), 'the findings under unresolved');
  assert.ok(brief.includes(`From \`findings\`:\n\n- ${JSON.stringify(detail)}`), 'a finding field of its own');
  assert.doesNotMatch(brief, /VERDICT/);
  assert.ok(!brief.includes(block2), 'the findings, not the raw block');
});

test('review refuses a running task, one with no changes, and a second round while the first runs', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const busy = await f.start(run, 'busy', { config: { hold: true } });
  await f.ready(busy);
  assert.match((await f.command(['review', run.id, 'busy'], { code: 1 })).stderr, /task busy is running; review it once it finishes/);
  f.release(busy);
  await f.finished(run, 'busy');
  assert.match((await f.command(['review', run.id, 'busy'], { code: 1 })).stderr, /busy has no changes since [0-9a-f]{12} .*nothing to review/);
  assert.ok(!fs.existsSync(f.taskFile(run, 'review-busy')));

  // One round at a time: a second review waits for the first.
  write(f.repo, 'busy.txt', 'busy\n');
  const first = (await f.json(['review', run.id, 'busy', '--focus', controls({ hold: true })])).started;
  await f.ready(first);
  assert.match((await f.command(['review', run.id, 'busy'], { code: 1 })).stderr, /review-busy is still reviewing busy/);
  f.release(first);
  await f.finished(run, 'review-busy');
});

test('a delegated agent cannot start a reviewer on a stronger tier than its own', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  await f.start(parent, 'boss', { agent: 'codex', flags: ['--tier', 'light'] });
  await f.finished(parent, 'boss');
  const as = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'boss' };
  const run = await f.newRun('nested', as);
  await f.command(['start', run.id, 'small', '--agent', 'codex', '--tier', 'light', '--why', 'fixture author', '--brief', f.brief('small')], { env: as });
  await f.finished(run, 'small');
  write(f.repo, 'small.txt', 'one line\n');
  const refused = await f.command(['review', run.id, 'small'], { code: 2, env: as });
  assert.match(refused.stderr, /never starts a stronger model than its own/);
  assert.match(refused.stderr, /The diff's size chose the standard tier; --tier picks another\./);
  assert.ok(!fs.existsSync(f.taskFile(run, 'review-small')));
  const light = await f.json(['review', run.id, 'small', '--tier', 'light'], { env: as });
  assert.deepEqual([light.review, light.agent, light.tier], ['review-small', 'claude', 'light']);
});
