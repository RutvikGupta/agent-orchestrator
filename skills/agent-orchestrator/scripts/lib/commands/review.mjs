// `review` and `rework`: one review round of a task's work in two commands.
//
// `review RUN TASK` starts the other model (Codex on Claude's work, Claude on Codex's) as a
// read-only reviewer task, `review-TASK` (`review-TASK-2` and on for later rounds), with a brief
// built here: the author's brief, the diff of its work, its final report, and what to report. The
// size of the diff picks the reviewer's tier. `rework RUN TASK` resumes the author's own session
// with the reviewer's findings.
//
// A reviewer ends with a verdict line, `VERDICT: clean` or `VERDICT: changes`. It is recorded as a
// review round of the author in its reviews.jsonl, the record `verdict` writes, so that `status`,
// `accept` and the reason of the author's next attempt see it: orch.mjs records it before the
// commands that read or act on review rounds (syncReviewVerdicts), and `rework` before it resumes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CACHE_PATH, CLI_PATH, TASK_ID } from "../config.mjs";
import { attemptReasonOf, reviewRoundsOf, reviewsPath, unlinkedVerifications, verificationsOf } from "../lifecycle.mjs";
import { callerIdentity, guard, mayAct, ownershipOf, recordChange, runNamed } from "../ownership.mjs";
import { COMMAND_AGENT } from "../policy.mjs";
import { describe, loadRun, loadTask, relayAlive, taskDir, validTask } from "../runs.mjs";
import { die, emit, readJson } from "../util.mjs";
import { lessonsSection, reviewTestingSection } from "./brief.mjs";
import { StartRefused, startTask } from "./start.mjs";

const CLI = `node ${CLI_PATH}`;
// The standard tier reviews a diff of at most this many changed lines (added plus removed) in at
// most this many files, none of them a module that other files import; anything more is complex.
const STANDARD_MAX_LINES = 150;
const STANDARD_MAX_FILES = 3;
// The diff goes into the brief up to about this many characters, cut at a file's boundary.
const INLINE_MAX_CHARS = 200_000;
// Files searched for imports of one changed file, and the largest file read for them.
const MAX_IMPORTERS_READ = 400;
const MAX_READ_BYTES = 1024 * 1024;
// Written in a reviewer's attempt folder once its verdict is recorded, so that it is recorded once.
const VERDICT_FILE = "verdict-recorded.json";
// A reviewer's verdict line, also when it is bolded, quoted, or a list item.
const VERDICT_LINE = /^[\t >*_#-]*VERDICT\b[*_]*[ \t]*:?[ \t]*[*_`]*(clean|changes)\b.*$/gim;
const ORCH_RESULT = /^[\t ]*```orch-result[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*(?=\r?$)/gm;
// The notes `start` appends to every brief, after the brief the orchestrator wrote.
const APPENDED = /\n+---[ \t]*\n+## (?:Delegating further|Publishing|Decisions|Messages from your orchestrator)\b[\s\S]*$/;
// The parts of an author's brief that a rework restates.
const RESTATED = /^(?:scope|gates?|house rules)\b/i;
const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (sha) => String(sha || "").slice(0, 12);
const quote = (value) => (/^[\w./:@%+=,-]+$/.test(String(value)) ? String(value) : `'${String(value).replaceAll("'", "'\\''")}'`);
const code = (text) => `\`${text}\``;

// ---------------------------------------------------------------------------------------------
// `review`

export function cmdReview(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const author = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `start a review of task ${id} in run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const focus = args.focus === undefined ? null : String(args.focus).trim() || die("--focus needs text: what the reviewer should look at hardest", 2);
  const notReviewable = authorProblem(author);
  if (notReviewable) die(notReviewable, 2);
  const row = describe(run, author);
  if (row.state === "running" || row.state === "prepared") die(`task ${id} is ${row.state}; review it once it finishes (${CLI} wait ${run.id} ${id})`);
  const live = reviewTasks(run, id).find((t) => relayAlive(t.pid, t.startedAt));
  if (live) die(`${live.id} is still reviewing ${id}; wait for it (${CLI} wait ${run.id} ${live.id}), or stop it first`);

  const change = changeOf(run, author);
  if (!change.files.length) die(`${id} has no changes since ${short(change.base)} (committed, uncommitted or new files), so there is nothing to review`);
  const size = sizeOf(change);
  const agent = author.agent === "claude" ? "codex" : "claude";
  const tier = args.tier || size.tier;
  const { round, name } = nextReview(run, id);
  const why = `${agent} reviews ${id}'s ${author.agent} work, the other model; ${size.text}${args.tier && args.tier !== size.tier ? `; --tier ${args.tier} given` : ""}`;
  const file = path.join(run.dir, "reviews", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, reviewBrief({ run, author, row, agent, change, focus, root: change.cwd || run.repo }));

  let started;
  try {
    started = startTask(
      {
        // The reviewer works where the author worked, or in the run's repository once that is gone.
        // A reviewer is never a plan entry: it reads one task's work and reserves nothing.
        _: [run.dir, name], agent, tier, why, brief: file, cd: change.dir || run.repo, "read-only": true, unplanned: true,
        title: `review of ${id}${round > 1 ? ` (round ${round})` : ""}`, passthrough: [],
      },
      { reviews: { task: id, attempt: row.attempt, round } },
    );
  } catch (error) {
    if (!(error instanceof StartRefused)) throw error;
    die(`${error.message}${args.tier ? "" : `\n  The diff's size chose the ${tier} tier; --tier picks another.`}`, error.code);
  }
  recordChange(run, g, { task: name, attempt: started.task.attempt, action: `review of ${id} started` });
  emit(
    args,
    {
      review: name, task: id, round, attempt: row.attempt, agent, tier, brief: file,
      size: { lines: size.lines, files: size.files, shared: size.shared, tier: size.tier, text: size.text },
      started: started.task,
    },
    [
      `${name} reviews ${id} (attempt ${row.attempt}, ${author.agent}), round ${round}`,
      `  size:  ${size.text}${args.tier && args.tier !== size.tier ? `; --tier ${args.tier} given` : ""}`,
      `  brief: ${file}`,
      started.text,
      `then:  ${CLI} rework ${run.id} ${id} to resume ${id} with its findings, or ${CLI} accept ${run.id} ${id} if it finds none`,
    ].join("\n"),
  );
}

// Why a task's work cannot be reviewed with `review`, or null.
function authorProblem(task) {
  if (task.reviews) return `${task.id} is itself a review; review the task it reviewed (${task.reviews.task})`;
  if (task.agent === COMMAND_AGENT) return `${task.id} is a command task: it has no brief or session to review`;
  if (!["claude", "codex"].includes(task.agent)) return `${task.id} has not started, so there is nothing to review`;
  if (task.babysit) return `${task.id} babysits a pull request; review the pull request instead`;
  if (task.readOnly) return `${task.id} is read-only, so it changed nothing to review`;
  return null;
}

// The reviewer tasks of a task that `review` started, oldest round first.
function reviewTasks(run, id) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(run.dir, "tasks"));
  } catch {}
  return names
    .map((name) => (TASK_ID.test(name) ? loadTask(run, name) : null))
    .filter((t) => t?.reviews && (id === undefined || t.reviews.task === id))
    .sort((a, b) => (a.reviews.round || 0) - (b.reviews.round || 0) || String(a.startedAt).localeCompare(String(b.startedAt)));
}

// The next round's number and reviewer name: `review-TASK`, then `review-TASK-2` and on. A name
// another task already has is skipped.
function nextReview(run, id) {
  let round = Math.max(0, ...reviewTasks(run, id).map((t) => t.reviews.round || 0)) + 1;
  for (;; round++) {
    const name = round === 1 ? `review-${id}` : `review-${id}-${round}`;
    if (!TASK_ID.test(name)) die(`task id ${id} is too long to name its reviewer (${name} does not match ${TASK_ID}); write a review brief and start it by hand`, 2);
    if (!loadTask(run, name)) return { round, name };
  }
}

// ---------------------------------------------------------------------------------------------
// The diff

function gitRun(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function gitOut(cwd, args, ok = [0]) {
  const r = gitRun(cwd, args);
  if (r.error || !ok.includes(r.status)) die(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

const existsAt = (cwd, rev, rel) => gitRun(cwd, ["cat-file", "-e", `${rev}:${rel}`]).status === 0;

// `git diff --numstat -z`: each file's added and removed lines, with the old path of a rename.
function parseNumstat(out) {
  const files = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    let from = null;
    let file = m[3];
    if (!file) {
      from = parts[++i];
      file = parts[++i];
    }
    files.push({ path: file, from, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
  }
  return files;
}

// The lines of a new file, as `git diff` would count them (a binary file has none), and its size.
function countLines(file) {
  let buf;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { lines: 1, binary: false, bytes: 0 }; // a symbolic link's diff is its target
    buf = fs.readFileSync(file);
  } catch {
    return { lines: 0, binary: false, bytes: 0 };
  }
  if (buf.subarray(0, 8000).includes(0)) return { lines: 0, binary: true, bytes: buf.length };
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines++;
  if (buf.length && buf[buf.length - 1] !== 10) lines++;
  return { lines, binary: false, bytes: buf.length };
}

// The work under review: what changed since the task's work started, in its checkout (committed
// and uncommitted changes and new files), or, once that checkout is gone, on its branch.
// { base, mergeBase, dir, cwd, repo, ref, files: [{ path, from, added, deleted, binary, isNew }],
// text, unshown, commands }. `dir` is where the author worked, null once it is gone; `cwd` the top
// of its checkout, where every git command runs so that all paths are relative to the same folder,
// null for a branch; `repo` and `ref` hold the branch, null for a checkout. `unshown` lists the new
// files left out of `text` to keep the brief short, as { path, bytes }.
function changeOf(run, task) {
  const base = task.worktree?.from || run.baseCommit || die(`run ${run.id} records no base commit, so ${task.id}'s work has nothing to be compared with`);
  const authorDir = task.cd || task.worktree?.path || null;
  const top = authorDir && fs.existsSync(authorDir) ? gitRun(authorDir, ["rev-parse", "--show-toplevel"]) : null;
  if (top?.status === 0 && top.stdout.trim()) {
    const dir = top.stdout.trim();
    const mergeBase = gitRun(dir, ["merge-base", base, "HEAD"]).stdout?.trim() || die(`cannot find where the work in ${dir} parts from ${short(base)}`);
    const files = parseNumstat(gitOut(dir, ["diff", "--numstat", "-z", "-M", mergeBase])).map((f) => ({ ...f, isNew: !existsAt(dir, mergeBase, f.from || f.path) }));
    const parts = [gitOut(dir, ["diff", "--no-color", "--no-ext-diff", "-M", mergeBase])];
    let newChars = 0;
    const unshown = [];
    const untracked = gitOut(dir, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((rel) => rel && !CACHE_PATH.test(rel));
    for (const rel of untracked) {
      const counted = countLines(path.join(dir, rel));
      files.push({ path: rel, from: null, added: counted.lines, deleted: 0, binary: counted.binary, isNew: true });
      // A new file larger than the brief can hold, or past what the new files can fill, is listed,
      // not diffed: the brief names it (inlineDiff).
      if (counted.bytes > INLINE_MAX_CHARS || newChars > INLINE_MAX_CHARS) {
        unshown.push({ path: rel, bytes: counted.bytes });
        continue;
      }
      const diff = gitOut(dir, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", rel], [0, 1]);
      parts.push(diff);
      newChars += diff.length;
    }
    return {
      base, mergeBase, dir: authorDir, cwd: dir, repo: null, ref: null, files, text: parts.join(""), unshown,
      commands: [`git -C ${quote(dir)} diff ${mergeBase}`, `git -C ${quote(dir)} status --short`],
    };
  }
  const branch = task.worktree?.branch || `orch/${run.id}/${task.id}`;
  if (gitRun(run.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
    die(`${task.id}'s checkout is gone (${authorDir || "none recorded"}) and it has no branch ${branch}, so there is no diff to review`);
  }
  const mergeBase = gitRun(run.repo, ["merge-base", base, branch]).stdout?.trim() || die(`cannot find where ${branch} parts from ${short(base)}`);
  const files = parseNumstat(gitOut(run.repo, ["diff", "--numstat", "-z", "-M", mergeBase, branch])).map((f) => ({ ...f, isNew: !existsAt(run.repo, mergeBase, f.from || f.path) }));
  return {
    base, mergeBase, dir: null, cwd: null, repo: run.repo, ref: branch, files, unshown: [],
    text: gitOut(run.repo, ["diff", "--no-color", "--no-ext-diff", "-M", mergeBase, branch]),
    commands: [`git -C ${quote(run.repo)} diff ${short(base)}...${branch}`],
  };
}

// ---------------------------------------------------------------------------------------------
// The tier

// The tier the diff calls for: standard for at most STANDARD_MAX_LINES changed lines in at most
// STANDARD_MAX_FILES files, none of them a shared module; complex for anything more. A shared module
// is a changed file that another file imports: a change to it reaches code the diff does not show,
// and a new one, such as a new module under a shared library folder, becomes part of that code.
function sizeOf(change) {
  const lines = change.files.reduce((n, f) => n + f.added + f.deleted, 0);
  const files = change.files.length;
  const what = `${plural(lines, "changed line")} in ${plural(files, "file")}`;
  if (lines > STANDARD_MAX_LINES || files > STANDARD_MAX_FILES) {
    return { lines, files, shared: null, tier: "complex", text: `${what}, more than the standard tier's ${STANDARD_MAX_LINES} lines in ${STANDARD_MAX_FILES} files: complex tier` };
  }
  const shared = [];
  for (const f of change.files) {
    const by = importerOf(change, f.path) || (f.from ? importerOf(change, f.from) : null);
    if (by) shared.push({ path: f.path, importedBy: by });
  }
  if (shared.length) {
    const list = shared.map((s) => `${s.path}, imported by ${s.importedBy}`).join("; ");
    return { lines, files, shared, tier: "complex", text: `${what}, with a shared module (${list}): complex tier` };
  }
  return { lines, files, shared, tier: "standard", text: `${what}, no shared module: standard tier` };
}

// The first file of the checkout (or branch) that imports `file`, or null. It reads the relative
// imports of JavaScript and TypeScript files and the imports of Python files; other languages
// are not read, so their files never count as shared.
function importerOf(change, file) {
  const python = file.endsWith(".py");
  if (!python && !JS_FILE.test(file)) return null;
  // A package's own module is named after its folder.
  const name = path.posix.basename(file).replace(/\.[^.]+$/, "");
  const stem = python && name === "__init__" ? path.posix.basename(path.posix.dirname(file)) : name;
  if (!stem || stem === ".") return null;
  const candidates = grepFiles(change, stem).filter((rel) => rel !== file && (python ? rel.endsWith(".py") : JS_FILE.test(rel)));
  for (const rel of candidates.slice(0, MAX_IMPORTERS_READ)) {
    const text = readAt(change, rel);
    if (!text) continue;
    if (python ? pythonImports(rel, text).some((name) => pythonNames(file, name)) : jsImports(rel, text).some((target) => jsSame(target, file))) return rel;
  }
  return null;
}

// The files that mention `word`: tracked and new files of a checkout, or the files of a branch.
function grepFiles(change, word) {
  if (change.cwd) {
    return gitOut(change.cwd, ["grep", "-l", "-z", "-F", "--untracked", "-e", word], [0, 1]).split("\0").filter(Boolean);
  }
  const prefix = `${change.ref}:`;
  return gitOut(change.repo, ["grep", "-l", "-z", "-F", "-e", word, change.ref, "--"], [0, 1])
    .split("\0")
    .filter(Boolean)
    .map((rel) => (rel.startsWith(prefix) ? rel.slice(prefix.length) : rel));
}

function readAt(change, rel) {
  if (change.cwd) {
    try {
      const file = path.join(change.cwd, rel);
      return fs.statSync(file).size > MAX_READ_BYTES ? null : fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  const r = gitRun(change.repo, ["show", `${change.ref}:${rel}`]);
  return r.status === 0 && r.stdout.length <= MAX_READ_BYTES ? r.stdout : null;
}

// The paths a JavaScript or TypeScript file imports through relative specifiers, resolved against
// its own folder: `import ... from "./x.mjs"`, `export ... from`, `import("./x")`, `require("./x")`.
const JS_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(["'])([^"'\n]+)\1/gm;
function jsImports(importer, text) {
  const out = [];
  for (const m of text.matchAll(JS_SPECIFIER)) {
    if (m[2].startsWith(".")) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(importer), m[2])));
  }
  return out;
}

// Whether an import resolves to `file`: the same path, the path without its extension (or with a
// `.js` that TypeScript maps to `.ts`), or the folder whose index it is.
function jsSame(target, file) {
  const bare = (p) => p.replace(JS_FILE, "");
  return target === file || bare(target) === bare(file) || `${target}/index` === bare(file);
}

// The dotted module names a Python file imports, absolute: `import a.b`, `from a.b import c` (a.b
// and a.b.c), and relative imports resolved against the file's package.
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^)#\n]*)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.][\w. \t,]*)/gm;
function pythonImports(importer, text) {
  const names = [];
  const items = (list) => list.split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^[\w.]+$/.test(s));
  for (const m of text.matchAll(PY_IMPORT)) names.push(...items(m[1]));
  for (const m of text.matchAll(PY_FROM)) {
    let from = m[2];
    if (m[1]) {
      const pkg = path.posix.dirname(importer).split("/").filter((p) => p && p !== ".");
      from = [...pkg.slice(0, Math.max(0, pkg.length - (m[1].length - 1))), ...(m[2] ? m[2].split(".") : [])].join(".");
    }
    if (from) names.push(from);
    for (const item of items(m[3])) names.push(from ? `${from}.${item}` : item);
  }
  return names;
}

// Whether a dotted import names `file`'s module, in full or as its last parts (a package below a
// source folder such as `src/`).
function pythonNames(file, name) {
  const module = file.replace(/\.py$/, "").replace(/(^|\/)__init__$/, "").split("/").filter(Boolean).join(".");
  return Boolean(module) && (name === module || module.endsWith(`.${name}`));
}

// ---------------------------------------------------------------------------------------------
// The review brief

// Quoted text goes into a brief as it is, except that `<fill in:`, which `start` refuses as an
// unfilled marker, gets a zero-width space after its `<`.
function quoter() {
  const q = { changed: false };
  q.text = (value) => {
    const text = String(value ?? "");
    const out = text.replaceAll("<fill in:", "<​fill in:");
    if (out !== text) q.changed = true;
    return out;
  };
  return q;
}

// Markdown headings outside code fences, `by` levels lower, so that quoted text sits below the
// brief's own headings.
function demote(text, by) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        return line;
      }
      return fence ? line : line.replace(/^(#{1,6})(?=[ \t])/, (h) => "#".repeat(Math.min(6, h.length + by)));
    })
    .join("\n");
}

// A code fence longer than any run of backticks in `text`.
const fenceFor = (text) => "`".repeat(Math.max(3, ...(String(text).match(/`+/g) || []).map((m) => m.length + 1)));

// The briefs an author worked from, without the notes `start` appended: its first attempt's, and
// each later one's (a rework, a resume, a retry).
function authorBriefs(run, task) {
  const out = [];
  for (let n = 1; n <= (task.attempt || 0); n++) {
    let text;
    try {
      text = fs.readFileSync(path.join(taskDir(run, task.id), `attempt-${n}`, "orch-brief.md"), "utf8");
    } catch {
      continue;
    }
    text = text.replace(APPENDED, "").trim();
    if (text) out.push({ attempt: n, reason: attemptReasonOf(task, n), text });
  }
  return out;
}

function fileList(files) {
  const shown = files.slice(0, 30).map((f) => {
    const what = f.binary ? "binary" : `+${f.added} −${f.deleted}`;
    return `${code(f.path)} (${f.from ? `renamed from ${code(f.from)}, ` : f.isNew ? "new, " : ""}${what})`;
  });
  return `${shown.join(", ")}${files.length > shown.length ? `, and ${files.length - shown.length} more` : ""}`;
}

// A path as git prints it in a diff: in double quotes, with C escapes, when it holds unusual characters.
function unquotePath(text) {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const escapes = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };
  const bytes = [];
  for (const m of text.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
    bytes.push(m[2] !== undefined ? Buffer.from(m[2]) : /^[0-7]+$/.test(m[1]) ? Buffer.from([parseInt(m[1], 8)]) : Buffer.from(escapes[m[1]] ?? m[1]));
  }
  return Buffer.concat(bytes).toString("utf8");
}

// The path one file's diff is about: its new name, or its old one when it was deleted.
function diffPath(chunk) {
  const after = (re) => {
    const m = re.exec(chunk);
    return m ? unquotePath(m[1].replace(/\t$/, "")) : null;
  };
  const renamed = after(/^rename to (.+)$/m);
  if (renamed) return renamed;
  const to = after(/^\+\+\+ (.+)$/m);
  if (to && to !== "/dev/null") return to.replace(/^b\//, "");
  const from = after(/^--- (.+)$/m);
  if (from && from !== "/dev/null") return from.replace(/^a\//, "");
  // A binary file or a mode change has neither line: its header names the same path twice, `a/P b/P`.
  const head = /^diff --git (.+)$/m.exec(chunk)?.[1] || "";
  return !head.startsWith('"') && head.length > 5 ? head.slice(2, 2 + (head.length - 5) / 2) : head;
}

// A diff split into one part per file, in git's order: [{ path, text }]. A line that starts with
// `diff --git ` is always a file's header: the lines of a hunk start with a space, `+`, `-` or `\`.
function fileDiffs(text) {
  const starts = [...text.matchAll(/^diff --git /gm)].map((m) => m.index);
  if (!starts.length) return text ? [{ path: null, text }] : [];
  return starts.map((start, i) => {
    const part = text.slice(i ? start : 0, starts[i + 1] ?? text.length);
    return { path: diffPath(part), text: part };
  });
}

// The diff for the brief, at most INLINE_MAX_CHARS long, and the files it does not show in full:
// { text, missing: [{ path, chars, bytes, shown }] }. It never cuts silently: it takes whole files,
// in git's order, while they fit, and leaves out each one that does not; only when no file fits
// whole is the first cut short, at the end of a line. `chars` is a file's diff size, `bytes` the
// size of a new file left undiffed, `shown` how much of it the brief holds.
function inlineDiff(change) {
  const shown = [];
  const missing = [];
  let room = INLINE_MAX_CHARS;
  for (const part of fileDiffs(change.text)) {
    if (part.text.length <= room) {
      shown.push(part.text);
      room -= part.text.length;
    } else {
      missing.push({ path: part.path, chars: part.text.length, bytes: null, shown: 0, text: part.text });
    }
  }
  if (!shown.length && missing.length) {
    const first = missing[0];
    const end = first.text.lastIndexOf("\n", INLINE_MAX_CHARS - 1);
    const kept = first.text.slice(0, end > 0 ? end + 1 : INLINE_MAX_CHARS);
    shown.push(kept);
    first.shown = kept.length;
  }
  for (const f of change.unshown) missing.push({ path: f.path, chars: null, bytes: f.bytes, shown: 0 });
  return { text: shown.join(""), missing: missing.map(({ text: _t, ...m }) => m) };
}

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

// The section at the top of a review brief that names each file the diff leaves out or cuts short,
// with its size, and tells the reviewer how to read it.
function missingSection(missing, change, agent) {
  const items = missing.map((m) => {
    const f = change.files.find((x) => x.path === m.path);
    const lines = f ? (f.binary ? "binary" : f.isNew && !f.deleted ? `new, ${plural(f.added, "line")}` : `+${f.added} −${f.deleted}`) : null;
    const size = m.chars !== null ? `a ${kb(m.chars)} diff` : `${kb(m.bytes || 0)}, not diffed`;
    const what = m.shown ? `cut short: the brief shows its first ${kb(m.shown)}` : "left out";
    return `- ${code(m.path)} (${lines ? `${lines}, ` : ""}${size}): ${what}`;
  });
  const read = agent === "codex"
    ? change.cwd
      ? `Read each of them directly: \`git -C ${quote(change.cwd)} diff ${change.mergeBase} -- <file>\` shows a changed file's diff, and a new file you read in full in ${code(change.cwd)}.`
      : `Read each of them directly: \`git -C ${quote(change.repo)} diff ${change.mergeBase} ${change.ref} -- <file>\` shows its diff.`
    : change.cwd
      ? `Read each of them directly with the Read tool, in ${code(change.cwd)}, which holds the author's version; the paths are relative to that folder.`
      : "Your directory does not hold the author's version of these files, and you have no shell to see their diff: review what is shown, and list in your report each file you could not see.";
  return `## Files not shown in full

To keep this brief under about ${kb(INLINE_MAX_CHARS)}, the diff under "The change" leaves out or cuts short ${missing.length === 1 ? "this file" : `these ${missing.length} files`}:

${items.join("\n")}

${read} Review them as fully as the rest of the change.`;
}

function reviewBrief({ run, author, row, agent, change, focus, root }) {
  const q = quoter();
  const id = author.id;
  const s = [];
  s.push("You are a delegated reviewer working in this directory. Do not modify any file, commit, push, open pull requests, or start other agents. Report your findings in your final message.");
  s.push(`## Goal\n\nReview the work of task ${code(id)} (attempt ${row.attempt}, by ${author.agent}${row.model ? ` on ${row.model}` : ""}) against its brief and the code around it, and report its defects: behavior that is wrong, missing, or inconsistent with the brief or with the surrounding code.`);
  const { text: diff, missing } = inlineDiff(change);
  if (missing.length) s.push(missingSection(missing, change, agent));
  if (focus) s.push(`## Focus\n\nYour orchestrator asks you to look hardest at:\n\n${q.text(focus)}`);

  const briefs = authorBriefs(run, author);
  const [first, ...later] = briefs;
  s.push(`## The author's brief\n\nThe brief the author worked from: its goal, its done criteria and its scope are what you review against. Its instructions for the author's report were for the author; yours are under "Report" below.\n\n${first ? demote(q.text(first.text), 2) : "(no brief was recorded)"}`);
  for (const b of later) s.push(`### Later instructions to the author (attempt ${b.attempt}, ${b.reason})\n\n${demote(q.text(b.text), 3)}`);

  const lines = change.files.reduce((n, f) => n + f.added + f.deleted, 0);
  const where = change.cwd
    ? `The work is everything that changed in the author's checkout, ${code(change.cwd)}, since commit ${short(change.mergeBase)}: committed and uncommitted changes, and new files.`
    : `The work is what the author's branch ${code(change.ref)} added since commit ${short(change.mergeBase)}; its checkout is gone.`;
  const amount = `It is ${plural(lines, "changed line")} in ${plural(change.files.length, "file")}: ${fileList(change.files)}.`;
  const how = agent === "codex"
    ? `See it yourself with ${change.commands.map(code).join(", and new files with ")}${change.cwd ? " (the diff leaves new files out; the copy below has them)" : ""}. The same diff follows.`
    : change.cwd
      ? `Your read-only mode has no shell, so the diff follows. Read the changed files in full in ${code(change.cwd)}, with Read, Glob and Grep, wherever the diff's context is not enough.`
      : `Your read-only mode has no shell, so the diff follows. The files in your directory are not the author's version: rely on the diff.`;
  const fence = fenceFor(diff);
  const cutNote = missing.length
    ? `\n\nThis diff leaves out or cuts short ${plural(missing.length, "file")}, named under "Files not shown in full" at the top, with how to read them.`
    : "";
  s.push(`## The change\n\n${where} ${amount}\n\n${how}\n\n${fence}diff\n${q.text(diff).replace(/\n?$/, "\n")}${fence}${cutNote}`);

  const report = String(row.result?.finalMessage || "").trim();
  s.push(`## The author's final report\n\nWhat the author says it did and checked. Check each claim against the diff and the code; do not take it on trust.\n\n${report ? demote(q.text(report), 2) : "(the author left no final report)"}`);

  const testing = reviewTestingSection(root, run.repo, author.plan || null);
  if (testing) s.push(testing);
  const lessons = lessonsSection(run.repo);
  if (lessons) s.push(lessons);

  s.push(`## What to check

- Each goal and done criterion of the brief: implemented, connected to its callers, and covered by a test that fails without the change.
- Edits to existing tests: each must still check what it checked before.
- Error paths and edge cases: empty, missing and malformed input, failures of what the code calls, and concurrent use.
- Files changed outside the brief's scope.
- The checks the author reported: whether they cover the change, and whether their results support it.`);

  s.push(agent === "codex"
    ? "## How to confirm a finding\n\nYou run in a read-only sandbox. Run the tests, or any command that writes no file, to reproduce a finding. A command that must write may fail there: then show the defect from the code, and say that you could not run it."
    : "## How to confirm a finding\n\nYou have no shell. Show each defect from the code: the input that makes it fail, and the path the code takes on it.");

  s.push(`## Report

Report only defects you reproduced, or can show from the code. Leave out style, naming and formatting notes, and anything you only suspect. For each defect, most severe first, give:

- the file and line;
- its severity: high (wrong results, lost data, a crash or a security hole), medium (a requirement not met, or an edge case that fails), or low (a minor defect with little effect);
- a failing input: the command, input or sequence that shows it, and what happens instead of what should;
- the fix you would make.

Say plainly when you found none. Then list the commands you ran, and what you could not check.

List each defect in one line under \`unresolved\` in the \`orch-result\` block, and leave \`changed\` empty. Just before that block, put your verdict on a line of its own: \`VERDICT: changes\` when you report at least one defect, or \`VERDICT: clean\` when you report none.`);
  if (q.changed) s.push("(In the quoted text above, a zero-width space follows the `<` of each `<fill in:`, so that it is not read as a part of this brief left to fill in.)");
  return `${s.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Verdicts

// A reviewer's verdict, `clean` or `changes`, from the last verdict line of its final message; null
// when it has none.
export function verdictIn(message) {
  let verdict = null;
  for (const m of String(message || "").matchAll(VERDICT_LINE)) verdict = m[1].toLowerCase();
  return verdict;
}

// A final message's last orch-result block, parsed; null when it has none, or one that does not parse.
function resultBlock(message) {
  let last;
  for (const m of String(message || "").matchAll(ORCH_RESULT)) last = m[1];
  if (last === undefined) return null;
  try {
    const value = JSON.parse(last.trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The `unresolved` list of a final message's last orch-result block: the reviewer's findings, one
// line each.
function unresolvedIn(message) {
  const value = resultBlock(message);
  return Array.isArray(value?.unresolved) ? value.unresolved.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim()) : [];
}

// A reviewer's own lists of findings in the block, beyond `unresolved`: only the fields that name
// findings. Any other extra field, such as a summary, is not a finding, so a clean review that
// adds one stays clean. [[name, value]], without empty ones.
const FINDING_FIELDS = new Set(["findings", "defects", "issues", "problems", "bugs"]);
function otherFindingsIn(message) {
  const value = resultBlock(message);
  const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) ? !v.length : typeof v === "object" && !Object.keys(v).length);
  return value ? Object.entries(value).filter(([key, v]) => FINDING_FIELDS.has(key) && !empty(v)) : [];
}

// What a review round records as its note: the findings, in short.
function roundNote(verdict, findings) {
  if (verdict === "clean" || !findings.length) return null;
  const text = `${plural(findings.length, "finding")}: ${findings.join("; ")}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

// Record a reviewer's verdict on the attempt it reviewed as a review round of the author: the
// record `verdict` writes, with the reviewer task as the reviewer. Once per reviewer attempt: the
// marker file, created exclusively first, makes a second caller (another command at the same
// moment) record nothing. Returns the record, or null when it was recorded already.
function recordRound(run, g, reviewer, authorId, attempt, verdict, note) {
  const marker = path.join(taskDir(run, reviewer.id), `attempt-${reviewer.attempt}`, VERDICT_FILE);
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ task: authorId, attempt, verdict, at: new Date().toISOString() })}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  const rounds = reviewRoundsOf(run, authorId);
  const record = {
    round: rounds.length + 1,
    attempt,
    verdict,
    note,
    reviewer: reviewer.id,
    at: new Date().toISOString(),
    verifications: unlinkedVerifications(verificationsOf(run, authorId), rounds),
    by: g.actor,
  };
  fs.appendFileSync(reviewsPath(run, authorId), `${JSON.stringify(record)}\n`);
  recordChange(run, g, { task: authorId, attempt, action: `reviewed (${verdict})` });
  return record;
}

const recordedText = (reviewer, authorId, r) => `recorded ${reviewer}'s verdict on ${authorId}: round ${r.round} (attempt ${r.attempt}), ${r.verdict}`;

// Record the verdict line of every reviewer task of the run that finished since the last call. Runs
// before the commands that read or act on review rounds (orch.mjs), for a caller that may change
// the run: anyone else's command records nothing. Never fails the command it runs before.
export function syncReviewVerdicts(ref) {
  const run = runNamed(ref);
  if (!run) return [];
  const recorded = [];
  let g;
  for (const reviewer of reviewTasks(run)) {
    if (!reviewer.attempt || !reviewer.outDir) continue;
    if (fs.existsSync(path.join(taskDir(run, reviewer.id), `attempt-${reviewer.attempt}`, VERDICT_FILE))) continue;
    const result = readJson(path.join(reviewer.outDir, "result.json"));
    const verdict = result?.status === "completed" ? verdictIn(result.finalMessage) : null;
    if (!verdict || !loadTask(run, reviewer.reviews.task)) continue;
    // An explicit caller keeps this decision out of guard()'s memo, which the command's own guard
    // (with its --adopt) fills.
    if (g === undefined) g = mayAct(ownershipOf(run)) ? guard(run, `record ${reviewer.id}'s verdict in run ${run.id}`, { caller: callerIdentity() }) : null;
    if (!g) break;
    const r = recordRound(run, g, reviewer, reviewer.reviews.task, reviewer.reviews.attempt, verdict, roundNote(verdict, unresolvedIn(result.finalMessage)));
    if (r) {
      recorded.push(r);
      process.stderr.write(`orch: ${recordedText(reviewer.id, reviewer.reviews.task, r)}\n`);
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------------------------
// `rework`

export function cmdRework(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const author = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `resume task ${id} of run ${run.id} with a review's findings`, { adopt: args.adopt, refused: [id] });
  const note = args.note === undefined ? null : String(args.note).trim() || die("--note needs text: which findings to fix, and how", 2);
  const notReworkable = authorProblem(author);
  if (notReworkable) die(notReworkable, 2);
  const row = describe(run, author);
  if (row.state === "running" || row.state === "prepared") die(`task ${id} is ${row.state}; rework it once it finishes (${CLI} wait ${run.id} ${id})`);

  const reviewer = args.from
    ? loadTask(run, validTask(args.from)) || die(`no task ${args.from} in run ${run.id}`)
    : reviewTasks(run, id).at(-1) || die(`no review of ${id} in run ${run.id}; start one with: ${CLI} review ${run.id} ${id}`);
  if (reviewer.id === id) die("--from names the task itself; name its reviewer", 2);
  if (reviewer.reviews && reviewer.reviews.task !== id) die(`${reviewer.id} reviewed ${reviewer.reviews.task}, not ${id}`, 2);
  const rrow = describe(run, reviewer);
  if (rrow.state === "running" || rrow.state === "prepared") die(`${reviewer.id} is still reviewing ${id}; wait for it (${CLI} wait ${run.id} ${reviewer.id})`);
  if (rrow.result?.status !== "completed") die(`${reviewer.id} ended ${rrow.state} without a review to act on; resume it, or review ${id} again (${CLI} review ${run.id} ${id})`);
  // A reviewer started by hand reviewed the author's current attempt.
  const reviewed = reviewer.reviews?.attempt ?? row.attempt;
  if (reviewed !== row.attempt) die(`${reviewer.id} reviewed attempt ${reviewed} of ${id}, which is at attempt ${row.attempt} now; review it again: ${CLI} review ${run.id} ${id}`);

  const message = rrow.result.finalMessage || "";
  const verdict = verdictIn(message);
  const unresolved = unresolvedIn(message);
  const other = otherFindingsIn(message);
  if (verdict === "clean" || (!verdict && !unresolved.length && !other.length)) {
    const r = verdict === "clean" ? recordRound(run, g, reviewer, id, reviewed, "clean", null) : null;
    if (r) process.stderr.write(`orch: ${recordedText(reviewer.id, id, r)}\n`);
    die(`${reviewer.id} found nothing to fix (${verdict ? "VERDICT: clean" : "no verdict line, and no finding under unresolved"}), so there is nothing to rework. Accept ${id} instead: ${CLI} accept ${run.id} ${id} --note "<why>"`);
  }
  if (!row.session) die(`${id} has no session id recorded, so its session cannot be resumed; start it again with a brief of the findings`);

  // The round is recorded before the resume: `start` counts the attempt after a `changes` round as a rework.
  const r = recordRound(run, g, reviewer, id, reviewed, "changes", roundNote("changes", unresolved) || (verdict ? null : "no verdict line; acted on its findings"));
  const round = r || reviewRoundsOf(run, id).findLast((x) => x.reviewer === reviewer.id && x.attempt === reviewed) || null;
  const attempt = row.attempt + 1;
  const file = path.join(run.dir, "reviews", `${id}-rework-${attempt}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, reworkBrief({ run, author, reviewer, rrow, reviewed, message, unresolved, other, note }));

  // --tier passes through to `start`. Without it `start` chooses: the task keeps its tier, on either
  // agent, until two counted failures move it one tier up. A new tier needs a reason: --why, or else
  // the facts of this rework.
  const tier = args.tier || undefined;
  const why = args.why ?? (args.tier && args.tier !== author.tier ? `rework of ${reviewer.id}'s findings on attempt ${reviewed}, which ran the ${author.tier || "default"} tier, at the ${args.tier} tier` : undefined);
  let started;
  try {
    started = startTask(
      {
        _: [run.dir, id], agent: author.agent, ...(tier ? { tier } : {}), ...(why !== undefined ? { why } : {}),
        brief: file, cd: author.cd || undefined, "read-only": false, passthrough: ["--session", row.session],
      },
      { resumedBy: g.actor, reworkFrom: { ...(author.reworkFrom || {}), [attempt]: reviewer.id } },
    );
  } catch (error) {
    if (!(error instanceof StartRefused)) throw error;
    die(error.message, error.code);
  }
  recordChange(run, g, { task: id, attempt: started.task.attempt, action: "resumed" });
  const findings = unresolved.length ? plural(unresolved.length, "finding") : "its findings";
  emit(
    args,
    { task: id, from: reviewer.id, reviewed, round: round?.round ?? null, verdict: verdict || "changes", findings: unresolved, note, brief: file, started: started.task },
    [
      `${id} resumes with ${reviewer.id}'s ${findings}${note ? ", and your note" : ""} (review round ${round?.round ?? "?"} of attempt ${reviewed})`,
      `  brief: ${file}`,
      started.text,
    ].join("\n"),
  );
}

// The sections of a brief whose headings match `names`, each with the headings below it.
function sectionsOf(text, names) {
  const out = [];
  let keep = null;
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    }
    const h = !f && !fence ? /^(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(line) : null;
    if (h) {
      if (keep && h[1].length <= keep.level) {
        out.push(keep.lines.join("\n").trim());
        keep = null;
      }
      if (!keep && names.test(h[2])) {
        keep = { level: h[1].length, lines: [`## ${h[2]}`] };
        continue;
      }
    }
    if (keep) keep.lines.push(h ? `${"#".repeat(Math.min(6, h[1].length - keep.level + 2))} ${h[2]}` : line);
  }
  if (keep) out.push(keep.lines.join("\n").trim());
  return out;
}

// The reviewer's final message before its orch-result block, without its verdict line.
function findingsProse(message) {
  return String(message || "").split(/^[\t ]*```orch-result[\t ]*\r?$/m)[0].replace(VERDICT_LINE, "").trim();
}

// One finding field of the orch-result block, as Markdown: a list stays a list, one item per line.
function fieldText(value) {
  const item = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  if (Array.isArray(value)) return value.map((v) => `- ${item(v)}`).join("\n");
  if (typeof value !== "object") return String(value);
  const json = JSON.stringify(value, null, 2);
  return `${fenceFor(json)}json\n${json}\n${fenceFor(json)}`;
}

// The findings as the reviewer structured them in its orch-result block: `unresolved`, and any field
// of its own; "" when it has none. A summary in its prose may leave a finding out, so both go into
// the rework brief.
function structuredFindings(unresolved, other) {
  const parts = [];
  if (unresolved.length) parts.push(`From \`unresolved\`:\n\n${fieldText(unresolved)}`);
  for (const [key, value] of other) parts.push(`From \`${key}\`:\n\n${fieldText(value)}`);
  return parts.join("\n\n");
}

function reworkBrief({ run, author, reviewer, rrow, reviewed, message, unresolved, other, note }) {
  const q = quoter();
  const id = author.id;
  const s = [];
  s.push(`You are resuming your work on task ${code(id)} in the same session and checkout. ${code(reviewer.id)}${rrow.agent && rrow.agent !== "-" ? ` (${rrow.agent}${rrow.tier ? ` ${rrow.tier}` : ""})` : ""} reviewed attempt ${reviewed} of your work and found the defects below. Fix them.`);
  const prose = findingsProse(message);
  const listed = structuredFindings(unresolved, other);
  const findings = [
    prose ? demote(q.text(prose), 2) : "",
    listed ? `${prose ? "### As the reviewer listed them in its report block\n\n" : ""}${q.text(listed)}` : "",
  ].filter(Boolean);
  s.push(`## Findings\n\n${findings.join("\n\n")}`);
  s.push(note
    ? `## Which findings to fix\n\nYour orchestrator decided:\n\n${q.text(note)}\n\nFollow this where it differs from the findings: fix what it says to fix, and leave what it says to leave. Check each finding you fix against the code first.`
    : "## Which findings to fix\n\nAll of them. Check each against the code first: if one is wrong, change nothing for it, and say why in your report.");
  s.push("For each fix, add a test that fails without it, or change an existing one so that it does.");
  const first = authorBriefs(run, author)[0];
  const restated = first ? sectionsOf(first.text, RESTATED) : [];
  s.push(restated.length
    ? `## Your scope and gates, from your brief\n\nThese still hold.\n\n${restated.map((t) => demote(q.text(t), 1)).join("\n\n")}`
    : "## Your scope and gates\n\nThose of your brief, earlier in this session: they still hold.");
  s.push("## Report\n\nSay for each finding whether you fixed it, and the test that covers it, or why you did not. Then give the gates' results.");
  if (q.changed) s.push("(In the quoted text above, a zero-width space follows the `<` of each `<fill in:`, so that it is not read as a part of this brief left to fill in.)");
  return `${s.join("\n\n")}\n`;
}
