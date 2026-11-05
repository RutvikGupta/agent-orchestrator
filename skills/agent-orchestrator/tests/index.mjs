// Node 22 resolves an explicit directory argument (`node --test tests/`) through this package
// entry point, so load every test file here; new *.test.mjs files are picked up automatically.
import fs from 'node:fs';

const here = new URL('./', import.meta.url);
for (const name of fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(new URL(name, here));
}
