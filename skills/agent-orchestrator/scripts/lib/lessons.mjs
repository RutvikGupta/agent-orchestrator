// Personal repository lessons and the recipe matching shared by briefs and lesson recording.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.mjs";

export const recipesDir = () => process.env.AGENT_ORCH_RECIPES_DIR || path.join(HOME, ".agents", "orch-recipes");

// The user's recipe for the repository, picked as worktree-prep picks it: the first *.json file in
// AGENT_ORCH_RECIPES_DIR (default ~/.agents/orch-recipes) whose `match` is the repository's path,
// else the first whose `match` is its folder name.
export function recipeFor(repo, notes = []) {
  const dir = recipesDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const recipes = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) recipes.push({ ...value, file });
    } catch (error) {
      notes.push(`cannot read ${file}: ${error.message}`);
    }
  }
  return recipes.find((r) => r.match === repo) || recipes.find((r) => r.match === path.basename(repo)) || null;
}

export function readLessons(repo) {
  repo = path.resolve(repo);
  const recipe = recipeFor(repo);
  const key = recipe ? path.basename(recipe.file, ".json") : path.basename(repo);
  if (!key || key === "." || key === "..") throw new Error("repository has no usable lesson key");
  const file = path.join(recipesDir(), "lessons", `${key}.md`);
  let content = "";
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const lessons = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.startsWith("- ")) continue;
    const text = line.slice(2).replace(/ \(evidence: .*\)$/, "").trim();
    if (text) lessons.push({ text, line: index + 1, raw: line });
  }
  return { file, content, lessons };
}
