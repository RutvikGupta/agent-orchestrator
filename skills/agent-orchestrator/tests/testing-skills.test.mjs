import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJson } from './helpers.mjs';

const INSTRUCTION = 'Before you report done, decide which of these skills applies to your change. Read its SKILL.md and use it to test the change with synthetic data or an end-to-end run, within what this environment allows. Report what you ran and the result as a check. If none applies, or one cannot run here (for example it needs production access or a deployed Airflow instance), say why in one line.';
const OWNS = ['services/ledger/', 'clients/acme/'];
const GOAL = "Acme's Ledger feed parses REFUND messages.";

function write(f, rel, content) {
  fs.mkdirSync(path.dirname(path.join(f.repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(f.repo, rel), content);
}
// A spread of front matter forms, a skill in both folders, and skills the filter must leave out.
function skills(f) {
  write(f, '.claude/skills/e2e-runner/SKILL.md', "---\nname: e2e-runner\ndescription: >-\n  Runs the customer's end-to-end DAG against\n  synthetic data, e.g. the nightly scenario. Use when a change\n  needs a full run.\n---\n# E2E runner\n");
  write(f, '.agents/skills/e2e-runner/SKILL.md', '---\nname: e2e-runner\ndescription: Duplicate copy for Codex.\n---\n');
  write(f, '.agents/skills/ledger-fixtures/SKILL.md', '---\nname: ledger-fixtures\ndescription: "Generate mock JSON \\"REFUND\\" messages for Ledger feeds. Use for parse work."\n---\n');
  write(f, '.claude/skills/verifying-output/SKILL.md', "---\nname: verifying-output\ndescription: |\n  Checks a parse's output tables\n  Use before a PR.\n---\n");
  write(f, '.claude/skills/replay-tool/SKILL.md', '---\nname: replay-tool\ndescription: Replays recorded traffic\n  against a local build. More text.\nmetadata:\n  owner: someone\n---\n');
  write(f, '.claude/skills/smoke-checks/SKILL.md', '# Smoke checks\n\nNo front matter here.\n');
  // Generic verbs in the first sentence, or keywords only later, do not make a testing skill.
  write(f, '.claude/skills/address-feedback/SKILL.md', '---\nname: address-feedback\ndescription: Resolve review comments; validate fixes and verify merge readiness. Use for tests of patience.\n---\n');
  write(f, '.claude/skills/latest-news/SKILL.md', "---\nname: latest-news\ndescription: 'Summarize the latest news. It''s not a testing skill.'\n---\n");
  write(f, '.claude/skills/deploy-helper/SKILL.md', '---\nname: deploy-helper\ndescription: Deploys the service to staging.\n---\n');
  fs.mkdirSync(path.join(f.repo, '.claude/skills/no-skill-file'), { recursive: true });
}
function plan(run, tasks) {
  writeJson(path.join(run.dir, 'plan.json'), { goal: 'Strict parsing', acceptance: [], tasks: tasks.map((t) => ({
    goal: GOAL, type: 'implement', owns: OWNS, uses: [], produces: [], resources: [], dependsOn: [], agent: 'claude', tier: 'standard',
    why: 'fixture', readOnly: false, brief: `briefs/${t.id}.md`, ...t })) });
}
async function draft(f, run, id, extra = [], env = {}) {
  const out = await f.json(['brief', run.id, id, ...extra], { env });
  return { ...out, text: fs.readFileSync(out.path, 'utf8') };
}
const section = (text) => /## Testing skills\n\n([\s\S]*?)\n\n## /.exec(text)?.[1];

test('brief lists testing skills from both folders, once each, filtered and most relevant first', async (t) => {
  const f = await fixture(t);
  skills(f);
  const run = await f.newRun('skills');
  plan(run, [{ id: 'acme-feed' }]);
  const shown = await f.command(['brief', run.id, 'acme-feed']);
  assert.match(shown.stdout, /\n {2}testing skills: 5 listed\n?$/);
  const out = await draft(f, run, 'acme-feed', ['--force']);
  assert.deepEqual(out.testingSkills.map((s) => [s.name, s.path, s.required]), [
    // ledger, feed, parse, REFUND, and messages all appear in its description
    ['ledger-fixtures', '.agents/skills/ledger-fixtures/SKILL.md', false],
    ['verifying-output', '.claude/skills/verifying-output/SKILL.md', false],
    // no task words: the most testing words in the name and first sentence first, then by name
    ['e2e-runner', '.claude/skills/e2e-runner/SKILL.md', false],
    ['replay-tool', '.claude/skills/replay-tool/SKILL.md', false],
    ['smoke-checks', '.claude/skills/smoke-checks/SKILL.md', false],
  ]);
  const body = section(out.text);
  assert.ok(body.includes(INSTRUCTION));
  assert.doesNotMatch(body, /Required/);
  assert.deepEqual(body.split('\n').filter((l) => l.startsWith('- ')), [
    '- `.agents/skills/ledger-fixtures/SKILL.md`: Generate mock JSON "REFUND" messages for Ledger feeds.',
    "- `.claude/skills/verifying-output/SKILL.md`: Checks a parse's output tables Use before a PR.",
    "- `.claude/skills/e2e-runner/SKILL.md`: Runs the customer's end-to-end DAG against synthetic data, e.g. the nightly scenario.",
    '- `.claude/skills/replay-tool/SKILL.md`: Replays recorded traffic against a local build.',
    '- `.claude/skills/smoke-checks/SKILL.md`',
  ]);
  assert.doesNotMatch(out.text, /Duplicate copy|address-feedback|latest-news|deploy-helper|no-skill-file/);
  // The section sits between the house rules and the gates, which point to it.
  assert.match(out.text, /## House rules[\s\S]*## Testing skills[\s\S]*## Gates[\s\S]*If this brief has a "Testing skills" section/);
});

test('recipe pins list required skills first, matched by owned paths, with their notes', async (t) => {
  const f = await fixture(t);
  skills(f);
  const recipes = path.join(f.root, 'recipes');
  // The recipe whose `match` is the repository's path wins over one that names its folder.
  writeJson(path.join(recipes, 'a-folder.json'), { match: 'repo', testing: [{ skill: 'smoke-checks', note: 'From the wrong recipe.' }] });
  writeJson(path.join(recipes, 'b-path.json'), { match: f.repo, testing: [
    { skill: 'e2e-runner', when: ['services/**'], note: 'Run the Ledger scenario.' },
    { skill: 'replay-tool', when: ['web/'], note: 'Only for web changes.' },
    { skill: 'deploy-helper', note: 'Deploy to the test instance first.' },
    { skill: 'ghost-skill', when: 'clients/', note: 'Not installed.' },
    { note: 'no skill' },
  ] });
  fs.writeFileSync(path.join(recipes, 'c-broken.json'), '{');
  const run = await f.newRun('pins');
  plan(run, [{ id: 'acme-feed' }, { id: 'web-only', owns: ['web/'], goal: 'Restyle the page.' }]);
  const env = { AGENT_ORCH_RECIPES_DIR: recipes };
  const shown = await f.command(['brief', run.id, 'acme-feed'], { env });
  assert.match(shown.stdout, /testing skills: 7 listed, 3 required/);
  assert.match(shown.stdout, /recipe: cannot read .*c-broken\.json/);
  assert.match(shown.stdout, /recipe: ignored an invalid "testing" entry in .*b-path\.json: \{"note":"no skill"\}/);

  const out = await draft(f, run, 'acme-feed', ['--force'], env);
  assert.deepEqual(out.testingSkills.map((s) => [s.name, s.required]), [
    ['e2e-runner', true], ['deploy-helper', true], ['ghost-skill', true],
    ['ledger-fixtures', false], ['verifying-output', false], ['replay-tool', false], ['smoke-checks', false],
  ]);
  assert.equal(out.testingSkills[2].path, null);
  const body = section(out.text);
  assert.match(body, /A skill marked \*\*Required\*\* applies to this change\. Use it unless it cannot run here\./);
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines[0], "- **Required:** `.claude/skills/e2e-runner/SKILL.md`: Runs the customer's end-to-end DAG against synthetic data, e.g. the nightly scenario. For this change: Run the Ledger scenario.");
  assert.equal(lines[1], '- **Required:** `.claude/skills/deploy-helper/SKILL.md`: Deploys the service to staging. For this change: Deploy to the test instance first.');
  assert.equal(lines[2], '- **Required:** `ghost-skill`: not found in .claude/skills/ or .agents/skills/. For this change: Not installed.');
  assert.doesNotMatch(body, /From the wrong recipe|Only for web/);

  // A task elsewhere gets the pins for its own paths and the one without `when`, in recipe order.
  const web = await draft(f, run, 'web-only', [], env);
  assert.deepEqual(web.testingSkills.filter((s) => s.required).map((s) => s.name), ['replay-tool', 'deploy-helper']);
});

test('the section is left out without testing skills, and a long list ends with the rest by name', async (t) => {
  const f = await fixture(t);
  write(f, '.claude/skills/deploy-helper/SKILL.md', '---\nname: deploy-helper\ndescription: Deploys the service to staging.\n---\n');
  const run = await f.newRun('none');
  const shown = await f.command(['brief', run.id, 'adhoc', '--type', 'implement']);
  assert.match(shown.stdout, /testing skills: none found/);
  const none = fs.readFileSync(path.join(run.dir, 'briefs', 'adhoc.md'), 'utf8');
  assert.doesNotMatch(none, /## Testing skills/);
  assert.match(none, /## House rules\n\n<fill in: the repository has no AGENTS\.md[^\n]*>\n\n## Gates\n/);
  assert.doesNotMatch(none, /\n\n\n|\{\{/);

  for (let i = 1; i <= 27; i++) {
    const name = `mock-${String(i).padStart(2, '0')}`;
    write(f, `.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Mock data number ${i}\n---\n`);
  }
  const long = await draft(f, run, 'adhoc', ['--type', 'implement', '--force']);
  assert.equal(long.testingSkills.length, 27);
  const lines = section(long.text).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 26);
  // A description without a full stop still ends its sentence before the next text.
  assert.equal(lines[24], '- `.agents/skills/mock-25/SKILL.md`: Mock data number 25.');
  assert.equal(lines[25], '- Less likely to apply: `mock-26`, `mock-27` (in .claude/skills/ or .agents/skills/)');
});

test('reviews check that the skill ran, research and babysitters get no section, and every brief asks for the check', async (t) => {
  const f = await fixture(t);
  skills(f);
  const run = await f.newRun('variants');
  plan(run, [
    { id: 'review-feed', type: 'review', readOnly: true },
    { id: 'debug-feed', type: 'debug' },
    { id: 'research-feed', type: 'research', readOnly: true },
  ]);
  const review = await draft(f, run, 'review-feed');
  const body = section(review.text);
  assert.match(body, /The implementer was told to decide which one applies, use it to test the change with synthetic data or an end-to-end run, and report what it ran as a check/);
  assert.ok(!body.includes(INSTRUCTION));
  assert.match(review.text, /- Testing skills: whether the implementer ran the repository's testing skill that applies to the\n {2}change/);

  const debug = await draft(f, run, 'debug-feed');
  assert.ok(section(debug.text).includes(INSTRUCTION));
  assert.match(debug.text, /## Gates\n\n[\s\S]*If this brief has a "Testing skills" section, use the skill from it that applies to reproduce the/);

  for (const [id, extra] of [['research-feed', []], ['babysit-1', ['--type', 'babysit']]]) {
    const shown = await f.command(['brief', run.id, id, ...extra]);
    assert.doesNotMatch(shown.stdout, /testing skills/, id);
    const out = await draft(f, run, id, [...extra, '--force']);
    assert.deepEqual(out.testingSkills, [], id);
    assert.doesNotMatch(out.text, /## Testing skills|\{\{/, id);
  }

  // The note that start appends to every brief asks for the testing check in the structured result.
  const started = await f.start(run, 'note-check');
  const sent = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
  assert.match(sent, /- `checks`: one object per check[^\n]*\n {2}- List the testing-skill or synthetic end-to-end check you ran \(name the skill in its `cmd`\), or one marked `not-run` with the reason in its `note`\.\n/);
  await f.finished(run, 'note-check');
});
