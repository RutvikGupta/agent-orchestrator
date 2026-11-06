import { runHeavy } from "../heavy.mjs";
import { die } from "../util.mjs";

export async function cmdHeavy(args) {
  if (!args.passthrough.length || args._.length) die("heavy [--label TEXT] -- COMMAND [ARG...]", 2);
  try { process.exitCode = await runHeavy(args.passthrough, { label: args.label }); }
  catch (error) { die(error.message, 2); }
}
