// GitHub through the user's gh login: JSON calls, and the pull-request snapshot that `pr-watch`
// compares with the last state it reported.

import { spawnSync } from "node:child_process";
import { shortText, slug } from "./format.mjs";

const CHECK_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function ghJson(cwd, argv) {
  const r = spawnSync("gh", argv, { cwd, encoding: "utf8", timeout: 60000 });
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { error: shortText(r.stderr || r.stdout || `gh exited ${r.status}`, 200) };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch {
    return { error: "gh returned invalid JSON" };
  }
}

export function prSnapshot(cwd, ref) {
  const fields = "number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,statusCheckRollup,comments,reviews";
  const pr = ghJson(cwd, ["pr", "view", ref, "--json", fields]);
  if (pr.error) return { ref, error: pr.error };
  const p = pr.value;
  const checks = { total: 0, passed: 0, pending: 0, failed: [] };
  for (const c of p.statusCheckRollup || []) {
    const done = c.__typename === "StatusContext" ? !["PENDING", "EXPECTED"].includes(c.state) : c.status === "COMPLETED";
    checks.total += 1;
    if (!done) checks.pending += 1;
    else if (CHECK_FAILED.has(c.conclusion) || CHECK_FAILED.has(c.state)) checks.failed.push(c.name || c.context || "check");
    else checks.passed += 1;
  }
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(p.url || "");
  let unresolvedThreads = null;
  if (m) {
    const query = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}";
    const t = ghJson(cwd, ["api", "graphql", "-f", `query=${query}`, "-f", `o=${m[1]}`, "-f", `r=${m[2]}`, "-F", `n=${m[3]}`]);
    const nodes = t.value?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (Array.isArray(nodes)) unresolvedThreads = nodes.filter((n) => !n.isResolved).length;
  }
  return {
    ref,
    key: m ? `${m[1]}_${m[2]}_${m[3]}` : slug(ref),
    repo: m ? `${m[1]}/${m[2]}` : null,
    number: p.number,
    url: p.url,
    title: p.title,
    state: p.state,
    draft: p.isDraft,
    mergeable: p.mergeable,
    mergeState: p.mergeStateStatus,
    reviewDecision: p.reviewDecision || null,
    head: p.headRefOid,
    branch: p.headRefName,
    base: p.baseRefName,
    checks,
    comments: (p.comments || []).length,
    reviews: (p.reviews || []).length,
    unresolvedThreads,
  };
}

// What changed since the last reported state that needs the orchestrator; empty means keep waiting.
export function prAttention(s, seen) {
  const sameHead = seen?.head === s.head;
  const why = [];
  if (s.state !== "OPEN") why.push(`the pull request is ${s.state.toLowerCase()}; confirm whether its changes reached ${s.base}`);
  const failedBefore = new Set(sameHead ? seen.checks.failed : []);
  const newlyFailed = s.checks.failed.filter((name) => !failedBefore.has(name));
  if (newlyFailed.length) why.push(`check failed: ${newlyFailed.join(", ")}`);
  if (s.mergeable === "CONFLICTING" && !(sameHead && seen.mergeable === "CONFLICTING")) why.push(`conflicts with ${s.base}`);
  if (s.checks.total && !s.checks.pending && !(sameHead && seen.checks.total && !seen.checks.pending)) {
    why.push(s.checks.failed.length ? "every check finished, some failed" : "every check passed");
  }
  if (seen) {
    if (s.comments > seen.comments) why.push(`${s.comments - seen.comments} new comment(s)`);
    if (s.reviews > seen.reviews) why.push(`${s.reviews - seen.reviews} new review(s)`);
    if ((s.unresolvedThreads ?? 0) > (seen.unresolvedThreads ?? 0)) why.push(`unresolved review threads: ${seen.unresolvedThreads ?? 0} → ${s.unresolvedThreads}`);
    if (s.reviewDecision !== seen.reviewDecision) why.push(`review decision: ${seen.reviewDecision || "none"} → ${s.reviewDecision || "none"}`);
  } else if (s.unresolvedThreads) {
    why.push(`${s.unresolvedThreads} unresolved review thread(s)`);
  }
  return why;
}

export function prText(reports) {
  return reports
    .map((s) => {
      if (s.error) return `${s.ref}: cannot read the pull request: ${s.error}`;
      const c = s.checks;
      const checks = c.total ? `${c.passed} passed, ${c.failed.length} failed${c.failed.length ? ` (${c.failed.join(", ")})` : ""}, ${c.pending} pending` : "none reported";
      return [
        `PR #${s.number} ${s.state}${s.draft ? " (draft)" : ""} · ${s.repo || ""} · ${s.branch} → ${s.base} @ ${String(s.head).slice(0, 8)} · ${s.url}`,
        `  checks: ${checks} · review: ${s.reviewDecision || "none"} · unresolved threads: ${s.unresolvedThreads ?? "?"} · mergeable: ${s.mergeable} (${s.mergeState})`,
        s.attention.length ? `  needs you: ${s.attention.join("; ")}` : "  nothing new",
      ].join("\n");
    })
    .join("\n");
}
