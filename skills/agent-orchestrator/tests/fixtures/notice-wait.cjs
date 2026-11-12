// Tell a test what a finish watcher (finish-notice.mjs) did once its relay was gone. The first time
// it schedules a timer, which it does only to wait for a process it found alive, it writes its PID to
// TEST_NOTICE_MARKER; when it exits, it writes `<marker>.exit`. Only the watcher process acts on it.
//
// With TEST_NOTICE_BARRIER, a folder, the watcher also stops right after its first read of a resume
// claim (resume-<k>.json), which it reads last before it takes over a notice an interrupt left
// taken: it writes an empty file named after its PID there and waits until `go` exists in it. So a
// test lets several watchers take the same notice over at once.
const fs = require('node:fs');
const path = require('node:path');
const marker = process.env.TEST_NOTICE_MARKER;
const barrier = process.env.TEST_NOTICE_BARRIER;
if (/finish-notice\.mjs$/.test(process.argv[1] || '')) {
  if (marker) {
    const schedule = global.setTimeout;
    let told = false;
    global.setTimeout = function setTimeout(...args) {
      if (!told) {
        told = true;
        fs.writeFileSync(marker, String(process.pid));
      }
      return schedule(...args);
    };
    process.on('exit', () => fs.writeFileSync(`${marker}.exit`, String(process.pid)));
  }
  if (barrier) {
    const read = fs.readFileSync;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    fs.readFileSync = function readFileSync(file, ...rest) {
      const result = read.call(fs, file, ...rest);
      if (!held && /resume-\d+\.json$/.test(String(file))) {
        held = true;
        fs.writeFileSync(path.join(barrier, String(process.pid)), '');
        while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(pause, 0, 0, 10);
      }
      return result;
    };
  }
}
