// SKILL.md is read in full by every session that loads the skill, so it stays a short core that
// sends the agent to a reference file for each step's detail. These checks keep it within its line
// budget and keep every pointer true: the files it names exist, every reference file is reachable
// from it, and every section that the scripts and references cite by name is still a heading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_LINES = 300;

const read = (rel) => fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8');

function filesUnder(rel, ext) {
  const dir = path.join(SKILL_DIR, rel);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) return filesUnder(child, ext);
    return entry.name.endsWith(ext) ? [child] : [];
  });
}

// Headings outside fenced code blocks, without their `#` marks.
function headings(text) {
  let fenced = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) out.push(line.replace(/^#+ +/, '').trim());
  }
  return out;
}

// Paths that start with `references/` on their own. A path inside another skill, such as
// `~/.agents/skills/codex-delegate/references/x.md`, is not this skill's, so a preceding path
// character rules a match out; a placeholder such as `<type>` ends one.
function referencePaths(text) {
  const found = new Set();
  for (const match of text.matchAll(/(?<![\w./~<>-])references\/[\w./-]*/g)) {
    found.add(match[0].replace(/\.+$/, ''));
  }
  return [...found];
}

// Citations of a section by name, such as (SKILL.md, "Usage limits") or
// `references/agents.md` ("Command tasks"), and of a SKILL.md step by number ("SKILL.md step 8").
// Comment markers and line breaks inside a citation are folded away first, and escaped quotes in
// script strings count as quotes.
function citations(text) {
  const flat = text.replace(/\n\s*(\/\/|\*)?\s*/g, ' ').replace(/\\"/g, '"');
  const named = [...flat.matchAll(/(SKILL\.md|references\/[\w-]+\.md)(?:[^"]{0,20}?[ (])"(\w[^"]{0,59})"/g)]
    .map((m) => ({ file: m[1], section: m[2] }));
  const steps = [...flat.matchAll(/SKILL\.md`? steps? (\d+)/g)].map((m) => ({ file: 'SKILL.md', step: m[1] }));
  return [...named, ...steps];
}

test('SKILL.md stays within its line budget', () => {
  const text = read('SKILL.md');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= MAX_LINES, `SKILL.md has ${lines} lines, over ${MAX_LINES}: move detail into a file under references/ and point to it`);
});

test('every reference file that SKILL.md names exists', () => {
  const named = referencePaths(read('SKILL.md'));
  assert.ok(named.length > 0, 'SKILL.md names no reference files');
  assert.deepEqual(named.filter((rel) => !fs.existsSync(path.join(SKILL_DIR, rel))), []);
});

test('SKILL.md names every top-level reference file', () => {
  const named = new Set(referencePaths(read('SKILL.md')));
  const files = filesUnder('references', '.md').filter((rel) => rel.split('/').length === 2);
  assert.deepEqual(files.filter((rel) => !named.has(rel)), []);
});

test('every section that scripts and references cite by name is a heading', () => {
  const sources = [...filesUnder('scripts', '.mjs'), ...filesUnder('references', '.md'), 'SKILL.md'];
  const cited = sources.flatMap((source) => citations(read(source)).map((c) => ({ ...c, source })));
  assert.ok(cited.some((c) => c.section === 'Delegate well'), 'the citation scan found no known citation');
  const broken = cited.filter((c) => {
    if (!fs.existsSync(path.join(SKILL_DIR, c.file))) return true;
    const heads = headings(read(c.file));
    return c.step ? !heads.some((h) => h.startsWith(`${c.step}. `)) : !heads.includes(c.section);
  });
  assert.deepEqual(broken.map((c) => `${c.source}: ${c.file} ${c.step ? `step ${c.step}` : `"${c.section}"`}`), []);
});
