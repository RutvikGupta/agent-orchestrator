// Record and list verified lessons in the user's personal recipes folder.
import fs from "node:fs";
import path from "node:path";
import { loadRun } from "../runs.mjs";
import { readLessons } from "../lessons.mjs";
import { die, emit } from "../util.mjs";

export function cmdLesson(args) {
  const repo = args.repo ? path.resolve(args.repo) : loadRun(args._[0]).repo;
  const text = args._.slice(args.repo ? 0 : 1).join(" ").trim();
  if (args.list && text) die("--list cannot be combined with lesson text", 2);
  if (!args.list && (!text || /[\r\n]/.test(text))) die("lesson TEXT is required and must be one line", 2);
  const evidence = args.evidence?.trim();
  if (!args.list && (!evidence || /[\r\n]/.test(evidence))) die("--evidence is required and must be one line", 2);
  const { file, content, lessons } = readLessons(repo);
  if (args.list) {
    emit(args, { file, lessons }, lessons.map((lesson) => `${lesson.line}: ${lesson.raw}`).join("\n"));
    return;
  }
  if (lessons.some((lesson) => lesson.text === text)) {
    emit(args, { file, added: false, count: lessons.length }, `lesson already recorded: ${text}`);
    return;
  }
  const source = [process.env.AGENT_ORCH_RUN, process.env.AGENT_ORCH_TASK].filter(Boolean).join("/");
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${content && !content.endsWith("\n") ? "\n" : ""}- ${text} (evidence: ${evidence}; ${date}${source ? `, ${source}` : ""})\n`);
  const count = lessons.length + 1;
  if (count > 30) process.stderr.write(`warning: ${file} has ${count} lessons; prune the file\n`);
  emit(args, { file, added: true, count }, `recorded lesson in ${file}`);
}
