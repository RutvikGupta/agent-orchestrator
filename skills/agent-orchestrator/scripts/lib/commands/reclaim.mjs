import { reclaim, reclaimText } from "../reclaim.mjs";
import { die, emit } from "../util.mjs";

export function cmdReclaim(args) {
  if (args._.length) die("reclaim [--dry-run] [--json]", 2);
  try {
    const result = reclaim({ dryRun: Boolean(args["dry-run"]) });
    emit(args, result, reclaimText(result));
    if (result.daemons.some((d) => d.action === "failed")) process.exitCode = 1;
  } catch (error) { die(error.message); }
}
