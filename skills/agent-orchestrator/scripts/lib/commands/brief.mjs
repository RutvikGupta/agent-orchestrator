// `brief`: write a draft brief for a task from references/briefs/<type>.md. It fills in what the
// run's plan.json says about the task, lists the repository's house-rule files for the orchestrator
// to copy rules from and its testing skills for the agent to use, leaves `<fill in: ...>`
// markers wherever only the orchestrator knows, and prints the tier its template suggests.

import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, SKILL_DIR } from "../config.mjs";
import { loadRun, loadTask, validTask } from "../runs.mjs";
import { die, emit, git } from "../util.mjs";
import { recipeFor, readLessons } from "../lessons.mjs";

const TEMPLATES = path.join(SKILL_DIR, "references", "briefs");
const TYPES = ["implement", "review", "research", "debug", "babysit"];
// Reviews and research change nothing unless the plan or the flag says otherwise.
const READ_ONLY_TYPES = ["review", "research"];
const WHO = { implement: "implementer", review: "reviewer", research: "researcher", debug: "investigator" };
// Claude Code loads CLAUDE.md (or .claude/CLAUDE.md); Codex loads AGENTS.md.
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", path.join(".claude", "CLAUDE.md")];
const MAX_HEADINGS = 25;
// Testing skills: the repository's own skills that test or verify a change. A skill counts when its
// name has a testing word, or when the first sentence of its description has one that is more than
// a verb: most workflow skills "validate fixes" or "verify" something in passing.
const SKILL_FOLDERS = [".claude/skills", ".agents/skills"];
const TESTING_WORD = /\b(?:test|mock|synthetic|e2e|end-to-end|replay|smoke|verif|validat)/i;
const TESTING_NOUN = /\b(?:test|mock|synthetic|e2e|end-to-end|replay|smoke)/i;
const TESTING_TYPES = ["implement", "debug", "review"];
const MAX_TESTING_SKILLS = 25; // listed in full; any more by name only
// Words of owned paths and goals that say nothing about which skill applies.
const COMMON_WORDS = new Set(
  `the and for with from into onto that this these those when then than also only each every all any
  not but are was were has have had can will must should would could its make makes made use uses using
  add adds added fix fixes fixed update updates change changes new one two out via per own
  src lib libs app apps pkg package packages internal common core util utils main index scripts script
  test tests testing spec specs doc docs file files code data customer customers project projects platform`.split(/\s+/),
);
// Each template opens with `<!-- tier: ... -->`, the tier it suggests for a task of its type. A
// suggestion for the orchestrator, not a rule: it is printed here and left out of the brief.
const TIER_HINT = /^<!--\s*tier:\s*([\s\S]*?)\s*-->[ \t]*\r?\n(?:[ \t]*\r?\n)*/;
const MARKER = "<fill in:";
const fill = (what) => `${MARKER} ${what}>`;
const code = (s) => `\`${s}\``;
const codes = (items) => items.map(code).join(", ");

export function cmdBrief(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const plan = loadPlan(run);
  const entry = plan?.tasks.find((t) => t?.id === id) || null;
  const type = args.type || (TYPES.includes(entry?.type) ? entry.type : null) || die(`--type is required: ${TYPES.join(", ")}`, 2);
  if (!TYPES.includes(type)) die(`unknown --type "${type}" (choose: ${TYPES.join(", ")})`, 2);
  if (type === "babysit" && args["read-only"]) die("a babysitter needs write mode: it commits, pushes, and replies on GitHub", 2);
  const readOnly =
    type !== "babysit" && Boolean(args["read-only"] || (typeof entry?.readOnly === "boolean" ? entry.readOnly : READ_ONLY_TYPES.includes(type)));

  const file = path.resolve(args.out || (entry?.brief ? path.resolve(run.dir, entry.brief) : path.join(run.dir, "briefs", `${id}.md`)));
  if (fs.existsSync(file) && !args.force) die(`brief already exists: ${file} (pass --force to overwrite it)`);

  // House rules come from the checkout the task works in, or the run's repository before it has one.
  const cd = loadTask(run, id)?.cd;
  const root = cd && fs.existsSync(cd) ? cd : run.repo;
  const rules = houseRuleFiles(root, entry?.owns || []);
  const testing = TESTING_TYPES.includes(type) ? testingSkills(root, run.repo, entry) : { skills: [], notes: [] };
  const text = render(type, {
    lessons: lessonsSection(run.repo),
    role: roleLine(type, readOnly),
    goal: entry?.goal || fill("one sentence with a verifiable outcome"),
    context: contextSection(run, plan, entry),
    scope: scopeSection(plan, entry, readOnly),
    houseRules: houseRulesSection(root, rules),
    testingSkills: testingSection(type, testing.skills),
    diff: diffSection(entry, readOnly),
    fixStep: readOnly
      ? "4. Do not fix it, and run only experiments that change no file. Describe the fix you would make."
      : "4. Once the cause is confirmed, fix it inside Scope, add a test that fails without the fix, and remove any temporary instrumentation.",
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);

  const markers = text.split(MARKER).length - 1;
  const source = entry ? "goal and scope from plan.json" : `not in ${plan ? "plan.json" : "a plan"}: fill in its goal and scope`;
  const required = testing.skills.filter((s) => s.required).length;
  const suggestedTier = tierHint(type);
  emit(
    args,
    {
      path: file, task: id, type, readOnly, fromPlan: Boolean(entry), markers, houseRules: rules, suggestedTier,
      testingSkills: testing.skills.map(({ name, path: rel, required: req, note }) => ({ name, path: rel, required: req, note })),
    },
    [
      `wrote ${file}`,
      `  ${type}, ${type === "babysit" ? "babysitter" : readOnly ? "read-only" : "write"}; ${source}`,
      `  ${markers} "${MARKER} ...>" marker${markers === 1 ? "" : "s"} to replace${type === "babysit" ? ", plus the <...> placeholders from references/babysit-brief.md" : ""}`,
      `  suggested tier: ${suggestedTier} (a suggestion; SKILL.md, "Choose the agent and model")`,
      `  house rules: ${rules.length ? rules.join(", ") : "no AGENTS.md or CLAUDE.md found"}`,
      ...(TESTING_TYPES.includes(type)
        ? [`  testing skills: ${testing.skills.length ? `${testing.skills.length} listed${required ? `, ${required} required` : ""}` : "none found"}`]
        : []),
      ...testing.notes.map((note) => `  recipe: ${note}`),
    ].join("\n"),
  );
}

function loadPlan(run) {
  const file = path.join(run.dir, "plan.json");
  if (!fs.existsSync(file)) return null;
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    die(`cannot parse ${file}: ${error.message}`);
  }
  if (!Array.isArray(plan?.tasks)) die(`${file} has no "tasks" list`);
  return plan;
}

// The tier a template suggests: the text of its `<!-- tier: ... -->` line, on one line.
function tierHint(type) {
  const file = path.join(TEMPLATES, `${type}.md`);
  if (!fs.existsSync(file)) die(`template not found: ${file}`);
  const hint = TIER_HINT.exec(fs.readFileSync(file, "utf8"))?.[1];
  return hint ? hint.replace(/\s+/g, " ") : "none (the template has no tier line)";
}

// `{{include FILE}}` inserts the brief part of a reference template (below its first `---` line);
// `{{name}}` inserts a computed section, and one alone on its line disappears with that line when
// the section is empty.
function render(type, values) {
  const file = path.join(TEMPLATES, `${type}.md`);
  if (!fs.existsSync(file)) die(`template not found: ${file}`);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(TIER_HINT, "")
    .replace(/\{\{include ([^}]+)\}\}/g, (_, rel) => included(path.resolve(TEMPLATES, rel.trim())))
    .replace(/^\{\{(\w+)\}\}\n\n?/gm, (m, key) => (values[key] === "" ? "" : m))
    .replace(/\{\{(\w+)\}\}/g, (m, key) => values[key] ?? m);
  const withLessons = values.lessons
    ? /^## Gates$/m.test(text)
      ? text.replace(/^## Gates$/m, () => `${values.lessons}\n\n## Gates`)
      : `${text.trimEnd()}\n\n${values.lessons}\n`
    : text;
  return `${withLessons.trimEnd()}\n`;
}

function included(file) {
  const text = fs.readFileSync(file, "utf8");
  const rule = /^---\s*$/m.exec(text);
  // The one placeholder of babysit-brief.md that this command knows the answer to.
  return (rule ? text.slice(rule.index + rule[0].length) : text).trim().replaceAll("<orch-path>", CLI_PATH);
}

function roleLine(type, readOnly) {
  if (type === "babysit") return "";
  const who = `You are a delegated ${WHO[type]} working in this directory.`;
  return readOnly
    ? `${who} Do not modify any file, commit, push, open pull requests, or start other agents. Report your findings in your final message.`
    : `${who} Commit your work on this branch as you go, following the repository's commit rules; push it, or open a pull request, when your task calls for it. Stay inside the files listed under Scope. You may hand parts of the task to other agents as "Delegating further" below describes.`;
}

function contextSection(run, plan, entry) {
  const lines = [];
  const goal = plan?.goal || run.goal;
  if (goal) lines.push(`- This task is part of: ${goal}`);
  if (entry) {
    const others = plan.tasks.filter((t) => t && t.id !== entry.id);
    for (const dep of entry.dependsOn || []) {
      const d = others.find((t) => t.id === dep);
      lines.push(`- Builds on ${code(dep)}, merged before this task starts${d?.goal ? `: ${d.goal}` : "."}${d?.produces?.length ? ` It provides ${codes(d.produces)}.` : ""}`);
    }
    // An interface that another task changes at the same time needs its agreed shape in both
    // briefs, or the two tasks may each assume a different one.
    for (const use of entry.uses || []) {
      const by = others.filter((t) => t.produces?.includes(use) && !entry.dependsOn?.includes(t.id)).map((t) => code(t.id));
      lines.push(`- Relies on ${code(use)}.${by.length ? ` ${by.join(" and ")} ${by.length === 1 ? "changes" : "change"} it at the same time, so use its agreed shape: ${fill("the signature or format")}` : ""}`);
    }
    for (const out of entry.produces || []) {
      const by = others.filter((t) => t.uses?.includes(out)).map((t) => code(t.id));
      lines.push(`- Provides ${code(out)}.${by.length ? ` ${by.join(" and ")} ${by.length === 1 ? "relies" : "rely"} on it, so keep to its agreed shape: ${fill("the signature or format")}` : ""}`);
    }
    if (entry.resources?.length) lines.push(`- Shared resources declared for this task: ${codes(entry.resources)}. Where tasks could collide (ports, databases, generated files), use only these.`);
  } else {
    lines.push(`- ${fill("the interfaces this task relies on, and the ones it must provide to other tasks")}`);
  }
  lines.push(`- ${fill("facts the agent cannot discover quickly: relevant files, decisions already made, and constraints found by earlier tasks")}`);
  return lines.join("\n");
}

function scopeSection(plan, entry, readOnly) {
  if (readOnly) return `Read anything you need. Change no file.${entry?.owns?.length ? `\n\nFocus on: ${codes(entry.owns)}.` : ""}`;
  const owns = entry?.owns?.length ? entry.owns.map((p) => `- ${code(p)}`).join("\n") : `- ${fill("the files and directories this task may change")}`;
  const others = (plan?.tasks || []).filter((t) => t && t.id !== entry?.id && !t.readOnly && t.owns?.length);
  const taken = others.length ? ` Other tasks own: ${others.map((t) => `${codes(t.owns)} (${t.id})`).join("; ")}.` : "";
  return `Change only these paths:\n\n${owns}\n\nLeave everything else alone.${taken}`;
}

function diffSection(entry, readOnly) {
  if (readOnly && entry?.agent === "claude") {
    return fill("paste the diff here, for example the output of `git diff <base>...<branch>`. Claude's read-only mode has no shell, so it cannot run git itself");
  }
  return fill("how to see the change: `git diff <base>...<branch>` for a committed branch, or `git diff` and `git status` in the task's worktree for uncommitted work. A read-only Claude reviewer has no shell: paste the diff instead");
}

function houseRulesSection(root, files) {
  if (!files.length) {
    return fill("the repository has no AGENTS.md or CLAUDE.md at its root or in the owned paths. Copy any rules that matter from its contribution or test docs, or delete this section");
  }
  const seen = new Map(); // real path -> the first listed path, for symlinked copies
  const items = files.map((rel) => {
    const abs = path.join(root, rel);
    const real = fs.realpathSync(abs);
    if (seen.has(real)) return `- ${code(rel)}: the same file as ${code(seen.get(real))}`;
    seen.set(real, rel);
    const text = fs.readFileSync(abs, "utf8");
    const heads = headings(text);
    const shown = heads.length > MAX_HEADINGS ? [...heads.slice(0, MAX_HEADINGS), `and ${heads.length - MAX_HEADINGS} more`] : heads;
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return `- ${code(rel)} (${lines} line${lines === 1 ? "" : "s"}): ${shown.length ? shown.join(" · ") : "no headings"}`;
  });
  return `${fill("copy in the rules from these files that matter for this task, then delete this list. Claude loads only CLAUDE.md and Codex only AGENTS.md, so restate the rules of both")}\n\n${items.join("\n")}`;
}

// The house-rule files that apply to the owned paths: at the root, in each owned folder and its
// parent folders, and anywhere inside an owned folder.
function houseRuleFiles(root, owns) {
  const dirs = new Set([""]);
  const found = new Set();
  for (const own of owns) {
    const o = ownedPath(root, own);
    if (!o) continue;
    for (let dir = o.isDir ? o.rel : path.dirname(o.rel); dir && dir !== "."; dir = path.dirname(dir)) dirs.add(dir);
    if (!o.isDir) continue;
    const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", o.rel || "."], { allowFail: true }) || "";
    for (const rel of listed.split("\0")) {
      if (["AGENTS.md", "CLAUDE.md"].includes(path.basename(rel)) && isFile(path.join(root, rel))) found.add(rel);
    }
  }
  for (const dir of dirs) {
    for (const name of RULE_FILES) {
      const rel = path.join(dir, name);
      if (isFile(path.join(root, rel))) found.add(rel);
    }
  }
  const depth = (rel) => rel.split(path.sep).length;
  return [...found].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

// An owned path relative to the root, cut at its first wildcard; null when it leaves the root.
function ownedPath(root, own) {
  let rel = String(own).replace(/^\.\//, "");
  const wild = rel.search(/[*?[]/);
  if (wild !== -1) rel = rel.slice(0, rel.lastIndexOf("/", wild) + 1);
  const abs = path.resolve(root, rel);
  rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  let isDir = rel === "" || wild !== -1 || String(own).endsWith("/");
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {}
  return { rel, isDir };
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Markdown headings (levels 1 to 3), skipping fenced code blocks.
function headings(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^#{1,3}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// The "Testing skills" section: what the agent should run, or for a reviewer, check that it ran.
function testingSection(type, skills) {
  if (!skills.length) return "";
  const shown = skills.slice(0, Math.max(MAX_TESTING_SKILLS, skills.filter((s) => s.required).length));
  const rest = skills.slice(shown.length);
  const folders = SKILL_FOLDERS.map((f) => `${f}/`).join(" or ");
  const lines = shown.map((s) => {
    const first = firstSentence(s.description);
    const about = !s.path ? `: not found in ${folders}.` : first ? `: ${first}${/[.!?…"')\]]$/.test(first) ? "" : "."}` : "";
    const note = s.note ? `${about ? " " : ": "}For this change: ${s.note}` : "";
    return `- ${s.required ? "**Required:** " : ""}${code(s.path || s.name)}${about}${note}`;
  });
  if (rest.length) lines.push(`- Less likely to apply: ${rest.map((s) => code(s.name)).join(", ")} (in ${folders})`);
  const required = skills.some((s) => s.required) ? " A skill marked **Required** applies to this change." : "";
  const intro =
    type === "review"
      ? `These are the repository's own skills for testing or verifying a change, most relevant first. The implementer was told to decide which one applies, use it to test the change with synthetic data or an end-to-end run, and report what it ran as a check, or say in one line why none applies or can run here. Check that it did, and that the result supports the change.${required}`
      : `These are the repository's own skills for testing or verifying a change, most relevant first. Before you report done, decide which of these skills applies to your change. Read its SKILL.md and use it to test the change with synthetic data or an end-to-end run, within what this environment allows. Report what you ran and the result as a check. If none applies, or one cannot run here (for example it needs production access or a deployed Airflow instance), say why in one line.${required ? `${required} Use it unless it cannot run here.` : ""}`;
  return `## Testing skills\n\n${intro}\n\n${lines.join("\n")}`;
}

// The skills to list: the recipe's pins that apply to the owned paths, as required, then every
// testing skill of the repository, the ones whose description mentions the task's words first.
function testingSkills(root, repo, entry) {
  const notes = [];
  const skills = repoSkills(root);
  const owns = entry?.owns || [];
  const listed = [];
  for (const pin of recipePins(recipeFor(repo, notes), owns, notes)) {
    const same = listed.find((s) => s.name === pin.skill);
    if (same) {
      if (pin.note) same.note = same.note ? `${same.note} ${pin.note}` : pin.note;
      continue;
    }
    const skill = skills.find((s) => s.name === pin.skill || s.dir === pin.skill);
    listed.push({ ...(skill || { name: pin.skill, path: null, description: "" }), required: true, note: pin.note });
  }
  const words = taskWords(entry);
  const others = skills
    .filter((s) => !listed.some((l) => l.name === s.name))
    .filter((s) => TESTING_WORD.test(s.name) || TESTING_NOUN.test(firstSentence(s.description)))
    .map((s) => ({ ...s, relevance: relevance(s, words), testing: testingWords(s) }))
    .sort((a, b) => b.relevance - a.relevance || b.testing - a.testing || a.name.localeCompare(b.name))
    .map(({ relevance: _r, testing: _t, ...s }) => ({ ...s, required: false, note: null }));
  return { skills: [...listed, ...others], notes };
}

// How much a skill's description is about the task: each task word it mentions counts twice in its
// name or first sentence, and twice again when the word comes from an owned path.
function relevance(skill, words) {
  const head = `${skill.name} ${firstSentence(skill.description)}`;
  let score = 0;
  for (const [word, weight] of words) {
    const re = wordRe(word);
    score += weight * (re.test(head) ? 2 : re.test(skill.description) ? 1 : 0);
  }
  return score;
}

// How much a skill is about testing: the distinct testing words in its name and first sentence.
function testingWords(skill) {
  const head = `${skill.name} ${firstSentence(skill.description)}`.toLowerCase();
  return new Set(head.match(new RegExp(TESTING_WORD.source, "gi")) || []).size;
}

// Every skill in .claude/skills and .agents/skills, once: a folder in both counts as one skill.
function repoSkills(root) {
  const skills = new Map();
  for (const folder of SKILL_FOLDERS) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(root, folder)).sort();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const rel = `${folder}/${dir}/SKILL.md`;
      if (skills.has(dir) || !isFile(path.join(root, rel))) continue;
      const meta = frontMatter(fs.readFileSync(path.join(root, rel), "utf8"));
      skills.set(dir, { name: meta.name || dir, dir, path: rel, description: meta.description || "" });
    }
  }
  return [...skills.values()];
}

// The `name` and `description` from a SKILL.md front matter, each on one line. Reads plain,
// quoted, and block (`>`, `>-`, `|`, ...) scalars, with indented continuation lines; it is not a
// general YAML parser.
function frontMatter(text) {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!block) return {};
  const lines = block[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const head = (kv[2] || "").trim();
    const more = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim());
    let value;
    if (/^[>|][-+0-9]*$/.test(head)) value = more.join(head[0] === ">" ? " " : "\n");
    else value = unquote([head, ...more].join(" "));
    out[kv[1]] = value.replace(/\s+/g, " ").trim();
  }
  return out;
}

function unquote(text) {
  if (text.startsWith('"')) {
    const body = /^"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text.slice(1);
    return body.replace(/\\(.)/g, (_, c) => ({ n: " ", t: " " })[c] ?? c);
  }
  if (text.startsWith("'")) return (/^'((?:[^']|'')*)'/.exec(text)?.[1] ?? text.slice(1)).replace(/''/g, "'");
  return text;
}

// A description's first sentence, not cut at "e.g." or "vs.", and at most about 300 characters.
function firstSentence(text) {
  const end = /[.!?]["')\]]*(?=\s|$)/g;
  let m;
  while ((m = end.exec(text))) {
    const before = text.slice(0, m.index);
    if (/\b(?:e\.g|i\.e|vs|etc|cf|incl|approx)$/i.test(before) || /(?:^|\s)[A-Z]$/.test(before)) continue;
    text = text.slice(0, m.index + m[0].length);
    break;
  }
  if (text.length <= 300) return text;
  const cut = text.lastIndexOf(" ", 300);
  return `${text.slice(0, cut > 0 ? cut : 300)} …`;
}

// The words of a task's owned paths and goal that can tell skills apart, such as a customer's
// client folder, `ledger`, `parse`, or `dag`, cut to a stem. Words of the owned paths weigh 2,
// since they name the code the task changes; words only in its goal weigh 1.
function taskWords(entry) {
  const stem = (w) => (w.length > 5 && /(?:ing|ed|es)$/.test(w) ? w.replace(/(?:ing|ed|es)$/, "") : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
  const split = (text) =>
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !COMMON_WORDS.has(w) && !/^\d+$/.test(w))
      .map(stem)
      .filter((w) => !COMMON_WORDS.has(w));
  const words = new Map();
  for (const w of split(entry?.goal || "")) words.set(w, 1);
  for (const w of split((entry?.owns || []).join(" "))) words.set(w, 2);
  return words;
}

const wordRe = (word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

// The recipe's `testing` pins that apply to a task: those with no `when`, and those whose `when`
// (path prefixes or globs) covers one of its owned paths.
function recipePins(recipe, owns, notes) {
  if (!recipe || recipe.testing === undefined) return [];
  if (!Array.isArray(recipe.testing)) {
    notes.push(`ignored "testing" in ${recipe.file}: it is not a list`);
    return [];
  }
  const pins = [];
  for (const item of recipe.testing) {
    const when = item?.when === undefined ? [] : [].concat(item.when);
    if (typeof item?.skill !== "string" || !item.skill.trim() || when.some((w) => typeof w !== "string") || (item.note != null && typeof item.note !== "string")) {
      notes.push(`ignored an invalid "testing" entry in ${recipe.file}: ${JSON.stringify(item)}`);
      continue;
    }
    if (!when.length || when.some((pattern) => owns.some((own) => covers(pattern, own)))) pins.push({ skill: item.skill.trim(), note: item.note || null });
  }
  return pins;
}

// Whether a `when` entry and an owned path can cover the same files: one path contains the other,
// the owned path or one of its folders matches the glob, or the owned folder contains the glob's base.
function covers(pattern, own) {
  const norm = (p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, "");
  const o = norm(own);
  const p = norm(pattern);
  const wild = p.search(/[*?[]/);
  const inside = (a, b) => a === b || b === "" || a.startsWith(`${b}/`);
  if (wild === -1 || o === "") return inside(o, p) || inside(p, o);
  const base = p.slice(0, Math.max(0, p.lastIndexOf("/", wild)));
  if (base && inside(base, o)) return true;
  const re = globRe(p);
  for (let dir = o; dir && dir !== "."; dir = path.posix.dirname(dir)) if (re.test(dir) || re.test(`${dir}/`)) return true;
  return false;
}

function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function lessonsSection(repo) {
  const { lessons } = readLessons(repo);
  if (!lessons.length) return "";
  return `## Known traps in this repository\n\n${lessons.map((lesson) => `- ${lesson.text}`).join("\n")}\n\nIf you hit a trap that is not listed and it is likely to recur, describe it under \`unresolved\` in your report so the orchestrator can record it.`;
}
