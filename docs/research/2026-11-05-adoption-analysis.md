# What to adopt from a framework discussion and from Conductor

November 2026. Analysis only; nothing here is built yet. Two research agents gathered the sources:

- **The discussion:** an r/AI_Agents thread on agent frameworks, plus a comment the user highlighted about "contracts and receipts".
- **Conductor:** `conductor-oss/conductor`, inspected at commit `2e415372`, for its loops and workflow graphs.

## The thread

- **Evidence:** it holds little firm evidence. The post has 8 points, and the substantive framework comparison has 3.
- **Frameworks:** LangGraph is recommended for explicit state machines (but has boilerplate), CrewAI for quick role-based prototypes (with debugging and latency complaints), and AutoGen for research and debate (with token overhead). The OpenAI and Claude SDKs get praise for handoffs. All of these target agent applications, not coordinating coding agents on one machine.
- **The highlighted comment's core claim:** clean contracts and receipts matter more than the framework. The loop it describes is spec, clarify, plan, implement a small diff, test, review, accept or reject, then update state. It wants each model to have one job, structured state passed between steps, and seven receipts shown.

### The seven receipts, against this tool

| Receipt | Today | Gap |
| --- | --- | --- |
| Task each model got | `plan.json` and each attempt's `orch-brief.md` | The details panel doesn't show the brief |
| Context it received | The saved brief; messages and replies | No view of loaded instructions, resumed history or file versions |
| Files changed | `touchedFiles`, `orch-result.changed`, scope violations | Not an independent per-task diff on a dirty checkout |
| Tests run | `orch-result.checks` | Not tied to an exit code, a commit, or the coordinator's rerun |
| Failures | `status`, `result`, logs, details panel | No failure history across attempts |
| What was accepted | `accept` stores attempt, commit and time | No rationale, verifier, evidence link or rejection record |
| Model per step | Agent, model, tier and `--why` on every task | Coordinator-side clarify, plan and review aren't attributed |

The rest of the loop is mostly in place:

- **Already covered:** plan goals and acceptance criteria act as the spec; scoped worktrees, real gates, and cross-model review for risky changes exist.
- **Missing:** a clarification record, and a structured verdict for each review round.
- **Portability:** briefs, scope and `orch-result` are shared between Claude and Codex. They are adapted, not interchangeable: instruction loading, read-only tooling and web access differ.

## Conductor

- **Loops:** `DO_WHILE` runs a body, then evaluates a condition; it has no built-in iteration cap. Each iteration's tasks get suffixed names (`task__1`, `task__2`) with their outputs kept, and `keepLastN` limits the history it retains. Retries and timeouts are set per task and are separate from iterations. Recovery relies on persisted state on a server.
- **Graphs:** one graph shaped by the definition, with live status overlaid (green done, red failed, amber skipped, gray running).
  - Loops are drawn as containers, and forks as branches into joins.
  - Past iterations are picked in a side panel, not drawn as extra nodes.
  - The current UI uses React, Reaflow (Apache-2.0) and ELK (EPL-2.0); the legacy UI used dagre-d3.
- **Loops this tool runs today, implicitly:**
  - review, rework and re-review, managed by the coordinator;
  - one automatic transient retry in `wait`;
  - `pr-watch` until a pull request lands;
  - each agent's own fix-and-test cycles.

## Recommendations, ranked

1. **Plan graph view (M).** Draw the run's plan as a graph: tasks as nodes, `dependsOn` as edges, and live phase and attention on each node, with attempt badges that open history. Keep the session tree. Use hand-written SVG to stay dependency-free. Dagre (MIT, 17 KB gzipped) is the fallback if the layout gets hard.
2. **Receipts in the details panel (S to M).**
   - Show the task's brief, its context sources and an attempt selector: duration, tokens, failure reason and report for each attempt.
   - Record a rationale and the verifier on `accept`, and record rejections explicitly.
3. **Verified checks and review-round history (M).**
   - Tie each check to the tested commit and to its exit code or the coordinator's rerun.
   - Record each review round's verdict and evidence, separately from infrastructure retries.
4. **Stuck-loop detection (M).** Flag an agent that keeps running the same failing command, and put it in the attention lane. Leave the intervention to the coordinator.
5. **Requirement traceability (M).** Give acceptance criteria stable ids, carry them into briefs and review verdicts, and require a disposition for each before `accept`.
6. **Clarification record (S).** Before dispatch, record the assumptions made and the questions resolved, or "none needed".
7. **Bounded review-loop container, later (L).** For example:
   - `{type: "loop", body: [fix, test, review], until: review verdict clean, maxIterations: 2}`.
   - `dispatch` would create the iterations under unique names and keep their results.
   - When the iterations run out, control returns to the coordinator.
   - Build this only after item 3 exists.

## Not to adopt

- Migrating to LangGraph, CrewAI, AutoGen or a provider SDK: they solve a different problem, and each adds dependencies.
- Conductor's server, database, queues, workers or React editor stack.
- Arbitrary JavaScript loop conditions, cyclic `dependsOn`, or replaying completed publishing actions.
- A round limit on pull-request babysitting: it must watch until the pull request lands or needs the user.
