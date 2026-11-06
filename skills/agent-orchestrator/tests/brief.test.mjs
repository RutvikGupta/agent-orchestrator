import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, writeJson } from './helpers.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const WRITE_ROLE = 'You are a delegated implementer working in this directory. Commit your work on this branch as you go, following the repository\'s commit rules; push it, or open a pull request, when your task calls for it. Stay inside the files listed under Scope. You may hand parts of the task to other agents as "Delegating further" below describes.';
const markers = (text) => text.split('<fill in:').length - 1;

function task(id, fields = {}) {
  return { id, goal: `Goal of ${id}.`, type: 'implement', owns: [], uses: [], produces: [], resources: [],
    dependsOn: [], agent: 'claude', tier: 'standard', why: 'fixture', readOnly: false, brief: `briefs/${id}.md`, ...fields };
}
function plan(run, tasks) {
  writeJson(path.join(run.dir, 'plan.json'), { goal: 'Make the parser strict', acceptance: ['rejects trailing commas'], tasks });
}
async function commitFiles(f, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(f.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(f.repo, rel), content);
  }
  fs.symlinkSync('AGENTS.md', path.join(f.repo, 'CLAUDE.md'));
  await f.git(['add', '-A']);
  await f.git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'House rules']);
}

test('brief fills an implement draft from plan.json and lists the house-rule files', async (t) => {
  const f = await fixture(t);
  await commitFiles(f, {
    'AGENTS.md': '# Project rules\n\n## Setup\n\n```sh\n# not a heading\n```\n\n## Testing\n',
    'src/AGENTS.md': '## Source layout\n',
    'src/parser/CLAUDE.md': '## Parser rules\n',
    'src/parser/sub/AGENTS.md': 'No headings here.\n',
    'other/AGENTS.md': '# Unrelated\n',
  });
  const run = await f.newRun('plan');
  plan(run, [
    task('parser-fix', { goal: 'The parser rejects trailing commas with a clear error.', owns: ['src/parser/', 'tests/test_parser.py'],
      uses: ['token-api'], produces: ['parse-error-format'], resources: ['port:8080'], dependsOn: ['lexer'], agent: 'codex', tier: 'standard' }),
    task('lexer', { goal: 'The lexer emits comma tokens.', owns: ['src/lexer/'], produces: ['token-api'] }),
    task('cli', { owns: ['src/cli/'], uses: ['parse-error-format'] }),
  ]);
  // --type defaults to the plan's type, and the draft goes to the plan's brief path.
  const out = await f.json(['brief', run.id, 'parser-fix']);
  assert.equal(out.path, path.join(run.dir, 'briefs', 'parser-fix.md'));
  assert.equal(out.type, 'implement');
  assert.equal(out.readOnly, false);
  assert.equal(out.fromPlan, true);
  assert.deepEqual(out.houseRules, ['AGENTS.md', 'CLAUDE.md', 'src/AGENTS.md', 'src/parser/CLAUDE.md', 'src/parser/sub/AGENTS.md']);
  const text = fs.readFileSync(out.path, 'utf8');
  assert.equal(text.split('\n')[0], WRITE_ROLE);
  assert.match(text, /## Goal\n\nThe parser rejects trailing commas with a clear error\.\n/);
  assert.match(text, /This task is part of: Make the parser strict/);
  assert.match(text, /Builds on `lexer`, merged before this task starts: The lexer emits comma tokens\. It provides `token-api`\./);
  // A prerequisite's interface is merged first, so it needs no agreed shape; a consumer does.
  assert.match(text, /- Relies on `token-api`\.\n/);
  assert.match(text, /- Provides `parse-error-format`\. `cli` relies on it, so keep to its agreed shape: <fill in: /);
  assert.match(text, /Shared resources declared for this task: `port:8080`/);
  assert.match(text, /Change only these paths:\n\n- `src\/parser\/`\n- `tests\/test_parser\.py`\n/);
  assert.match(text, /Other tasks own: `src\/lexer\/` \(lexer\); `src\/cli\/` \(cli\)\./);
  assert.match(text, /- `AGENTS\.md` \(9 lines\): Project rules · Setup · Testing\n/);
  assert.match(text, /- `CLAUDE\.md`: the same file as `AGENTS\.md`/);
  assert.match(text, /- `src\/parser\/sub\/AGENTS\.md` \(1 line\): no headings/);
  assert.doesNotMatch(text, /not a heading|other\/AGENTS\.md/);
  assert.match(text, /## Report contract[\s\S]*```orch-result\n\{"outcome": "done \| partial \| blocked",/);
  assert.doesNotMatch(text, /\{\{/);
  assert.equal(out.markers, markers(text));
  assert.ok(out.markers > 0);
});

test('brief refuses to overwrite without --force and writes to --out', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('refuse');
  const file = path.join(run.dir, 'briefs', 'adhoc.md');
  const first = await f.command(['brief', run.id, 'adhoc', '--type', 'implement']);
  assert.match(first.stdout, new RegExp(`^wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
  assert.match(first.stdout, /not in a plan: fill in its goal and scope/);
  const draft = fs.readFileSync(file, 'utf8');
  assert.match(draft, /<fill in: one sentence with a verifiable outcome>/);
  assert.match(draft, /<fill in: the files and directories this task may change>/);
  assert.match(draft, /<fill in: the repository has no AGENTS\.md or CLAUDE\.md/);

  fs.writeFileSync(file, 'edited\n');
  const refused = await f.command(['brief', run.id, 'adhoc', '--type', 'implement'], { code: 1 });
  assert.match(refused.stderr, /brief already exists: .*adhoc\.md \(pass --force to overwrite it\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited\n');
  await f.command(['brief', run.id, 'adhoc', '--type', 'implement', '--force']);
  assert.equal(fs.readFileSync(file, 'utf8'), draft);

  const custom = path.join(f.root, 'custom', 'brief.md');
  const out = await f.json(['brief', run.id, 'adhoc', '--type', 'research', '--out', custom]);
  assert.equal(out.path, custom);
  assert.match(fs.readFileSync(custom, 'utf8'), /^You are a delegated researcher/);
  await f.command(['brief', run.id, 'adhoc', '--type', 'research', '--out', custom], { code: 1 });
});

test('brief rejects bad types, task ids, read-only babysitters, unknown runs, and malformed plans', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('errors');
  const cases = [
    [['brief', run.id, 'adhoc'], 2, /--type is required: implement, review, research, debug, babysit/],
    [['brief', run.id, 'adhoc', '--type', 'nope'], 2, /unknown --type "nope"/],
    [['brief', run.id, 'Bad_ID', '--type', 'implement'], 2, /task id "Bad_ID" must match/],
    [['brief', run.id, 'babysit-1', '--type', 'babysit', '--read-only'], 2, /a babysitter needs write mode/],
    [['brief', 'no-such-run', 'adhoc', '--type', 'implement'], 1, /unknown run "no-such-run"/],
  ];
  for (const [args, code, message] of cases) assert.match((await f.command(args, { code })).stderr, message);
  fs.writeFileSync(path.join(run.dir, 'plan.json'), '{');
  assert.match((await f.command(['brief', run.id, 'adhoc', '--type', 'implement'], { code: 1 })).stderr, /cannot parse .*plan\.json/);
  writeJson(path.join(run.dir, 'plan.json'), { goal: 'x' });
  assert.match((await f.command(['brief', run.id, 'adhoc', '--type', 'implement'], { code: 1 })).stderr, /plan\.json has no "tasks" list/);
  assert.equal(fs.existsSync(path.join(run.dir, 'briefs')), false);
});

test('brief role lines and sections follow the type and read-only mode', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('roles');
  plan(run, [
    task('review-a', { type: 'review', owns: ['src/'], readOnly: true }),
    task('research-a', { type: 'research', agent: 'codex', tier: 'standard', readOnly: undefined }),
    task('debug-ro', { type: 'debug', agent: 'codex', tier: 'complex', readOnly: true }),
    task('debug-w', { type: 'debug', owns: ['src/'] }),
  ]);
  const draft = async (id, extra = []) => {
    const out = await f.json(['brief', run.id, id, ...extra]);
    return { ...out, text: fs.readFileSync(out.path, 'utf8') };
  };
  const readOnlyRole = (who) => `You are a delegated ${who} working in this directory. Do not modify any file, commit, push, open pull requests, or start other agents. Report your findings in your final message.`;

  const review = await draft('review-a');
  assert.equal(review.readOnly, true);
  assert.equal(review.text.split('\n')[0], readOnlyRole('reviewer'));
  assert.match(review.text, /Read anything you need\. Change no file\.\n\nFocus on: `src\/`\./);
  // A read-only Claude reviewer has no shell, so the diff must be pasted in.
  assert.match(review.text, /## The change\n\n<fill in: paste the diff here/);
  assert.match(review.text, /leave it out, so that the review does not anchor/);

  const research = await draft('research-a');
  assert.equal(research.readOnly, true);
  assert.equal(research.text.split('\n')[0], readOnlyRole('researcher'));

  const debugRo = await draft('debug-ro');
  assert.equal(debugRo.text.split('\n')[0], readOnlyRole('investigator'));
  assert.match(debugRo.text, /4\. Do not fix it, and run only experiments that change no file\./);
  assert.match(debugRo.text, /`confirmed`, `falsified`,\nor `inconclusive`/);

  const debugW = await draft('debug-w');
  assert.equal(debugW.readOnly, false);
  assert.match(debugW.text.split('\n')[0], /^You are a delegated investigator working in this directory\. Commit your work on this branch as you go/);
  assert.match(debugW.text, /4\. Once the cause is confirmed, fix it inside Scope/);

  // Outside the plan: --read-only and the type decide, and a review gets the generic diff marker.
  const adhocDebug = await draft('adhoc-debug', ['--type', 'debug', '--read-only']);
  assert.equal(adhocDebug.readOnly, true);
  const adhocReview = await draft('adhoc-review', ['--type', 'review']);
  assert.equal(adhocReview.readOnly, true);
  assert.match(adhocReview.text, /<fill in: how to see the change: `git diff <base>\.\.\.<branch>`/);
  // An explicit --type wins over the plan's.
  assert.equal((await draft('debug-w', ['--type', 'implement', '--force'])).text.split('\n')[0], WRITE_ROLE);
});

test('babysit draft inlines the babysitter template with the CLI path and the report block', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('babysit');
  const shown = await f.command(['brief', run.id, 'babysit-12', '--type', 'babysit']);
  assert.match(shown.stdout, /babysit, babysitter; not in a plan/);
  assert.match(shown.stdout, /plus the <\.\.\.> placeholders from references\/babysit-brief\.md/);
  const text = fs.readFileSync(path.join(run.dir, 'briefs', 'babysit-12.md'), 'utf8');
  assert.match(text, /^You are the babysitter for pull request <PR URL>/);
  assert.doesNotMatch(text, /# Babysitter brief template|<orch-path>/);
  assert.ok(text.includes(`node ${cli} pr-watch`));
  assert.match(text, /## Final message[\s\S]*```orch-result\n/);
  assert.match(text, /## House rules\n\n<fill in: the repository has no AGENTS\.md/);
  assert.doesNotMatch(text, /\{\{/);
});

test('every template renders, and a generated brief dispatches through start', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('templates');
  for (const type of ['implement', 'review', 'research', 'debug', 'babysit']) {
    const out = await f.json(['brief', run.id, `adhoc-${type}`, '--type', type]);
    const text = fs.readFileSync(out.path, 'utf8');
    assert.doesNotMatch(text, /\{\{|\}\}/, type);
    assert.match(text, /## House rules\n/, type);
    assert.match(text, /```orch-result\n[\s\S]*"unresolved": \["\.\.\."\]\}\n```\n/, type);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), type);
  }
  const brief = path.join(run.dir, 'briefs', 'adhoc-implement.md');
  // start refuses a brief with unfilled markers; the orchestrator fills them in first.
  const unfilled = await f.command(['start', run.id, 'adhoc-implement', '--agent', 'claude', '--tier', 'standard', '--why', 'Dispatches a generated brief', '--brief', brief], { code: 2 });
  assert.match(unfilled.stderr, /unfilled marker/);
  fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace(/<fill in:[^>]*>/g, 'filled in'));
  const started = await f.json(['start', run.id, 'adhoc-implement', '--agent', 'claude', '--tier', 'standard', '--why', 'Dispatches a generated brief', '--brief', brief]);
  const sent = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
  assert.ok(sent.startsWith(`${WRITE_ROLE}\n`));
  assert.match(sent, /```orch-result[\s\S]*## Decisions/);
  assert.equal((await f.finished(run, 'adhoc-implement')).state, 'completed');
});

test('every template suggests a tier in the command output, and the brief itself carries no tier line', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('tiers');
  const expected = {
    implement: [/light or standard for a mechanical change or a well-specified one to 1 to 5 files/, /complex for several modules, an open approach, or costly or subtle mistakes/],
    review: [/standard for a small diff, on the agent that did not write it/, /complex for a large or risky diff/],
    research: [/Codex standard \(only Codex has live web search\)/, /a test or gate run that only reports: Claude light .* or Codex standard/],
    debug: [/by the criteria: light or standard to reproduce a bug/, /complex when the cause is unknown across modules/],
    babysit: [/complex, always: --babysit implies it, so no --tier is needed/],
  };
  for (const [type, patterns] of Object.entries(expected)) {
    const out = await f.json(['brief', run.id, `suggest-${type}`, '--type', type]);
    assert.equal(typeof out.suggestedTier, 'string', type);
    for (const pattern of patterns) assert.match(out.suggestedTier, pattern, type);
    const shown = await f.command(['brief', run.id, `suggest-${type}`, '--type', type, '--force']);
    assert.match(shown.stdout, new RegExp(`^  suggested tier: ${out.suggestedTier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(a suggestion; SKILL\\.md, "Choose the agent and model"\\)$`, 'm'), type);
    const text = fs.readFileSync(out.path, 'utf8');
    assert.doesNotMatch(text, /<!--|suggested tier/, `${type}: the suggestion is for the orchestrator, not in the brief`);
  }
});
