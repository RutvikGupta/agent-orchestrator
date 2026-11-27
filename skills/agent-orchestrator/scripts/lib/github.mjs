import { spawnSync } from "node:child_process";

// Reports may repeat the same PR as a link and as "PR #123".
export function taskPullRequest(task, report) {
  const urls = new Set();
  const numbers = new Set();
  const recorded = String(task.pr?.number ?? task.pr ?? "");
  if (/^[1-9]\d*$/.test(recorded)) numbers.add(recorded);
  for (const m of String(report || "").matchAll(/\b(?:PR|pull request)\s+#([1-9]\d*)\b/gi)) numbers.add(m[1]);
  for (const value of [task.pr?.url ?? task.pr, report]) {
    for (const m of String(value || "").matchAll(/https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)(?![\w-])/gi)) {
      urls.add(m[0].toLowerCase().replace(/^http:/, "https:"));
      numbers.add(m[1]);
    }
  }
  return numbers.size === 1 && urls.size <= 1 ? [...numbers][0] : null;
}

export function viewPullRequest(repo, number) {
  const result = spawnSync("gh", ["pr", "view", number, "--json", "state,mergedAt,headRefOid,commits"], {
    cwd: repo, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") return { error: "GitHub CLI (gh) is missing" };
  if (result.error) return { error: `gh pr view failed: ${result.error.message}` };
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    return { error: `gh pr view failed${detail ? `: ${detail}` : ` (exit ${result.status ?? result.signal})`}` };
  }
  let pr;
  try {
    pr = JSON.parse(result.stdout);
  } catch {
    return { error: "gh pr view returned invalid JSON" };
  }
  return { pr };
}
