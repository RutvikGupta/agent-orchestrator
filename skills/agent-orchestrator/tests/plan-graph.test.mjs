import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixture, writeJson } from './helpers.mjs';

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
    dependsOn: [], agent: 'claude', tier: null, why: 'Fixture assessment', readOnly: false,
    brief: brief(run, id, config), ...extra,
  };
}

test('/api/state draws each run of a section as a plan graph', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('graph');
  f.launchingSession(run, 'session-graph'); // its section, which the nested run joins
  const plan = {
    goal: 'Ship the feature',
    tasks: [
      entry(run, 'api', { goal: 'Add the API\nwith a second line that the title leaves out' }, { finalMessage: 'API added.' }),
      entry(run, 'ui', { dependsOn: ['api'] }),
      entry(run, 'docs', { type: 'research', readOnly: true, owns: [], agent: 'codex', tier: 'standard' }),
      entry(run, 'e2e', { type: 'review', readOnly: true, owns: [], dependsOn: ['ui', 'docs'] }),
    ],
  };
  const file = path.join(f.root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  await f.command(['plan', run.id, file]);
  // Only api starts; docs stays ready, ui and e2e wait on their dependencies.
  assert.deepEqual((await f.json(['dispatch', run.id, '--max', '1'])).started.map((s) => s.id), ['api']);
  await f.finished(run, 'api');
  await f.json(['worktree', run.id, 'e2e']); // prepared, but no attempt has started
  // Tasks started outside the plan: hotfix, then zfix, then hotfix again. Its second attempt starts
  // last, but the graph keeps it where it first started, before zfix.
  await f.start(run, 'hotfix', { config: { finalMessage: 'Fixed.' } });
  await f.finished(run, 'hotfix');
  await f.start(run, 'zfix', { config: { finalMessage: 'Also fixed.' } });
  await f.finished(run, 'zfix');
  await f.start(run, 'hotfix', { config: { finalMessage: 'Fixed again.' } });
  await f.finished(run, 'hotfix');
  // A nested run that the api task started: its tasks are drawn in its own graph, not in the parent's.
  const nested = await f.newRun('nested', { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'api' });
  for (const id of ['child-a', 'child-b']) {
    await f.start(nested, id, { config: { finalMessage: `${id} done.` } });
    await f.finished(nested, id);
  }
  // A run with no launching session: its nested run gets a section of its own, and still counts.
  const lone = await f.newRun('lone');
  await f.start(lone, 'lead', { config: { finalMessage: 'Led.' } });
  await f.finished(lone, 'lead');
  const helper = await f.newRun('helper', { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: lone.id, AGENT_ORCH_TASK: 'lead' });
  await f.start(helper, 'helps', { config: { finalMessage: 'Helped.' } });
  await f.finished(helper, 'helps');

  const board = await f.dashboard();
  const state = await board.json('/api/state');
  const section = state.find((s) => s.runs.some((r) => r.id === run.id));
  assert.ok(section, 'the run has a section');
  const parent = section.runs.find((r) => r.id === run.id);
  const child = section.runs.find((r) => r.id === nested.id);
  assert.ok(child, 'the nested run shares its parent run\'s section');
  const nodes = Object.fromEntries(parent.graph.nodes.map((n) => [n.id, n]));
  const rowKey = (r, id) => section.tasks.find((x) => x.run === r.id && x.id === id && !x.native).key;

  // Plan order first, then tasks started outside the plan by their first start; nested tasks stay out.
  assert.deepEqual(parent.graph.nodes.map((n) => n.id), ['api', 'ui', 'docs', 'e2e', 'hotfix', 'zfix']);
  assert.deepEqual(parent.graph.edges, [{ from: 'api', to: 'ui' }, { from: 'ui', to: 'e2e' }, { from: 'docs', to: 'e2e' }]);
  assert.equal(parent.parent, null);

  assert.deepEqual(nodes.api, {
    id: 'api', title: 'Add the API', type: 'implement', agent: 'claude', tier: null, planned: false, ready: false,
    state: 'completed', phase: 'awaiting-review', attempts: 1, attention: 'awaiting-review', key: rowKey(run, 'api'), delegated: 2,
  });
  assert.deepEqual(nodes.ui, {
    id: 'ui', title: 'Build ui', type: 'implement', agent: 'claude', tier: null, planned: true, ready: false,
    state: null, phase: null, attempts: 0, attention: null, key: null, delegated: 0,
  });
  assert.deepEqual([nodes.docs.planned, nodes.docs.ready, nodes.docs.agent, nodes.docs.tier, nodes.docs.type], [true, true, 'codex', 'standard', 'research']);
  // A prepared task has a row to choose, and is still only planned.
  assert.deepEqual([nodes.e2e.planned, nodes.e2e.ready, nodes.e2e.state, nodes.e2e.key], [true, false, 'prepared', rowKey(run, 'e2e')]);
  assert.deepEqual([nodes.hotfix.planned, nodes.hotfix.title, nodes.hotfix.state, nodes.hotfix.attempts, nodes.hotfix.key],
    [false, null, 'completed', 2, rowKey(run, 'hotfix')]);

  // A run without plan.json: a node per task, no edges, and the task that started it.
  assert.deepEqual(child.parent, { run: run.id, task: 'api' });
  assert.deepEqual(child.graph.nodes.map((n) => [n.id, n.planned, n.state, n.key]),
    [['child-a', false, 'completed', rowKey(nested, 'child-a')], ['child-b', false, 'completed', rowKey(nested, 'child-b')]]);
  assert.deepEqual(child.graph.edges, []);
  const graphOf = (r) => state.flatMap((s) => s.runs).find((x) => x.id === r.id).graph;
  const sectionOf = (r) => state.find((s) => s.runs.some((x) => x.id === r.id)).id;
  assert.notEqual(sectionOf(lone), sectionOf(helper), 'the count crosses sections');
  assert.deepEqual(graphOf(lone).nodes.map((n) => [n.id, n.delegated]), [['lead', 1]]);
  assert.deepEqual(graphOf(helper).nodes.map((n) => n.id), ['helps']);

  // The page has the view toggle and the layout, and its script still parses.
  const app = await (await board.get('/app.js')).text();
  for (const needle of ['function graphLayout(', 'graphShown', '.gnode[data-key]', 'r.graph']) assert.ok(app.includes(needle), needle);
  await board.checkScript(app);
});

// Builds the board in a child process with the fixture's state root, counting the reads of
// plan.json and of the briefs. The state is cached for 250 ms, so a fake clock moves a second
// before each build; after `builds` builds, the plan gains a task and the board is built again.
const BUILD_SCRIPT = `
import fs from 'node:fs';
const [moduleUrl, planFile, runId, builds] = process.argv.slice(2);
const reads = { plan: 0, briefs: 0 };
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const name = String(file);
  if (name === planFile) reads.plan++;
  else if (name.includes('/briefs/')) reads.briefs++;
  return readFileSync.call(this, file, ...rest);
};
let clock = Date.now();
Date.now = () => clock;
const { dashboardState } = await import(moduleUrl);
const graph = () => { clock += 1000; return dashboardState().flatMap((s) => s.runs).find((r) => r.id === runId).graph; };
const before = [];
for (let i = 0; i < Number(builds); i++) before.push(graph());
const unchanged = { ...reads };
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
plan.tasks.push({ ...plan.tasks.at(-1), id: 'late', goal: 'Build late', dependsOn: ['top'] });
fs.writeFileSync(planFile, JSON.stringify(plan));
const after = graph();
process.stdout.write(JSON.stringify({ unchanged, reads, before, after }));
`;

test('repeated board builds read an unchanged plan once and never read briefs', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('big-plan');
  // 100 tasks: 96 with no dependencies (each would be checked for its brief if the board looked),
  // one chain, and a babysitter, which is never ready since it needs a pull request number.
  const tasks = [entry(run, 'base'), entry(run, 'top', { dependsOn: ['base'] }), entry(run, 'sit', { type: 'babysit', owns: [] })];
  for (let i = 0; tasks.length < 100; i++) tasks.push(entry(run, `w${String(i).padStart(2, '0')}`));
  const planFile = path.join(run.dir, 'plan.json');
  writeJson(planFile, { goal: 'A large plan', tasks });
  const script = path.join(f.root, 'build-board.mjs');
  fs.writeFileSync(script, BUILD_SCRIPT);
  const moduleUrl = new URL('../scripts/lib/dashboard-state.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [script, moduleUrl, planFile, run.id, '4'], { cwd: f.repo, env: f.env, maxBuffer: 16 * 1024 * 1024 });
  const { unchanged, reads, before, after } = JSON.parse(stdout);

  assert.deepEqual(unchanged, { plan: 1, briefs: 0 }, 'four builds of an unchanged plan read it once and read no brief');
  assert.deepEqual(reads, { plan: 2, briefs: 0 }, 'a changed plan is read again');
  assert.equal(before.length, 4);
  for (const g of before) assert.deepEqual(g, before[0]);
  const nodes = Object.fromEntries(before[0].nodes.map((n) => [n.id, n]));
  assert.equal(before[0].nodes.length, 100);
  assert.deepEqual([nodes.base.ready, nodes.w00.ready, nodes.top.ready, nodes.sit.ready], [true, true, false, false],
    'ready: not started, and every dependency integrated; a babysitter is started by hand');
  assert.deepEqual(after.nodes.at(-1).id, 'late');
  assert.deepEqual(after.edges.at(-1), { from: 'top', to: 'late' });
});
