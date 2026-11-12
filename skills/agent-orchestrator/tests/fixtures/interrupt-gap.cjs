// Hold an interrupt's helper (steer.mjs `resume`) between the task's two relays: once it has sent
// SIGTERM to the relay's group and the relay has exited, its next read of the task's inbox writes
// TEST_GAP_MARKER and waits until `<marker>.release` exists. Only the helper process acts on it.
const fs = require('node:fs');
const marker = process.env.TEST_GAP_MARKER;
if (marker && /steer\.mjs$/.test(process.argv[1] || '') && process.argv[2] === 'resume') {
  let stopping = false;
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') stopping = true;
    return kill(pid, signal);
  };
  const read = fs.readFileSync;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  fs.readFileSync = function readFileSync(file, ...rest) {
    if (stopping && String(file).endsWith('inbox.jsonl')) {
      stopping = false;
      fs.writeFileSync(marker, '');
      while (!fs.existsSync(`${marker}.release`)) Atomics.wait(pause, 0, 0, 10);
    }
    return read.call(fs, file, ...rest);
  };
}
