// Test-only handshake at wait's first polling interval. Preserve the real 3s
// interval, but do not let its callback race a fixture mutation still in progress.
const fs = require('node:fs');
const original = global.setTimeout;
const marker = process.env.TEST_WAIT_MARKER;
let observed = false;
if (marker && process.argv[2] === 'wait') {
  global.setTimeout = (callback, ms, ...args) => {
    if (ms !== 3000 || observed) return original(callback, ms, ...args);
    observed = true;
    fs.writeFileSync(marker, '');
    return original(function released() {
      if (!fs.existsSync(`${marker}.release`)) return original(released, 10);
      callback(...args);
    }, ms);
  };
}
