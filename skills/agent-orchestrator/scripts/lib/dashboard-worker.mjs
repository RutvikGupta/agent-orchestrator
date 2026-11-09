// Board construction and its process/transcript reads never run on the HTTP thread.
import path from "node:path";
import { buildDashboardState } from "./dashboard-state.mjs";
import { heavyStatus } from "./heavy.mjs";
import { watchExternalAgents } from "./external.mjs";
import { readProcessesInBackground } from "./runs.mjs";
import { readVendorStatusInBackground } from "./vendor-status.mjs";

readProcessesInBackground();
readVendorStatusInBackground();
watchExternalAgents();
// The HTTP server owns this process; never outlive its IPC connection.
process.on("disconnect", () => process.exit(0));
let heavy = null, heavyAt = 0;
process.on("message", () => {
  try {
    const state = buildDashboardState();
    const ids = new Set();
    for (const section of state) for (const task of section.tasks) {
      for (const id of [task.session, task.outDir && path.basename(task.outDir, ".jsonl")]) if (id) ids.add(id);
    }
    if (!heavy || Date.now() - heavyAt >= 5000) {
      heavy = heavyStatus();
      heavyAt = Date.now();
    }
    const running = state.some((section) => section.tasks.some((task) => !task.main && task.state === "running" && task.phase !== "parked"));
    // Only the serialized board crosses IPC: the server serves it as is, and parses it only to
    // check escalations.
    process.send({ body: JSON.stringify(state), heavyBody: JSON.stringify(heavy), heavyAt, ids: [...ids], running });
  } catch (error) {
    process.send({ error: String(error?.message || error) });
  }
});
