// Hold one process at the moment it writes one file, so a test can act exactly there. The process
// is the one whose script (argv[1]) matches TEST_PAUSE_SCRIPT and, when TEST_PAUSE_SUB is set, whose
// first argument (argv[2]) equals it. The file is the first one written whose path matches
// TEST_PAUSE_FILE and, when TEST_PAUSE_TEXT is set, whose content holds that text. The process
// writes its PID to TEST_PAUSE_MARKER and waits until `<marker>.release` exists: before the write, or
// after it with TEST_PAUSE_AFTER=1. A file written through a temporary file and a rename (writeJson)
// is matched by its final name, and counts as written once it is renamed.
const fs = require('node:fs');
const { TEST_PAUSE_SCRIPT: script, TEST_PAUSE_SUB: sub, TEST_PAUSE_FILE: file, TEST_PAUSE_TEXT: text, TEST_PAUSE_MARKER: marker } = process.env;
if (marker && script && file && new RegExp(script).test(process.argv[1] || '') && (!sub || process.argv[2] === sub)) {
  const after = process.env.TEST_PAUSE_AFTER === '1';
  const wanted = new RegExp(file);
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let done = false, renaming = null;
  const pause = () => {
    done = true;
    write.call(fs, marker, String(process.pid));
    while (!fs.existsSync(`${marker}.release`)) Atomics.wait(sleep, 0, 0, 10);
  };
  const write = fs.writeFileSync, rename = fs.renameSync;
  fs.writeFileSync = function writeFileSync(target, data, ...rest) {
    const name = String(target), temporary = /\.\d+\.tmp$/.test(name);
    const hit = !done && wanted.test(name.replace(/\.\d+\.tmp$/, '')) && (!text || String(data).includes(text));
    if (hit && temporary) renaming = name;
    else if (hit && !after) pause();
    const result = write.call(fs, target, data, ...rest);
    if (hit && !temporary && after) pause();
    return result;
  };
  fs.renameSync = function renameSync(from, to) {
    const hit = !done && renaming === String(from);
    if (hit && !after) pause();
    const result = rename.call(fs, from, to);
    if (hit && after) pause();
    return result;
  };
}
