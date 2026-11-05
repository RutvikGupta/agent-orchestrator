// Force the real read-result/check-PID interleaving without changing CLI code.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const original = fs.readFileSync;
let triggered = false;
fs.readFileSync = function (file, ...args) {
  if (triggered || file !== process.env.TEST_RACE_RESULT) return original.call(this, file, ...args);
  triggered = true;
  try {
    return original.call(this, file, ...args);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.writeFileSync(process.env.TEST_RACE_RELEASE, '');
    const deadline = Date.now() + 8000;
    for (;;) {
      const probe = spawnSync('ps', ['-p', process.env.TEST_RACE_PID, '-o', 'command='], { encoding: 'utf8' });
      if (probe.status !== 0 || !probe.stdout.includes('relay.mjs')) break;
      if (Date.now() >= deadline) throw new Error('relay did not exit after release');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    // Preserve the absent result observed before the relay published and exited.
    throw error;
  }
};
