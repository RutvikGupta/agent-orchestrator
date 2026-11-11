// Gate wait's first configured polling interval until the fixture mutation finishes.
const fs = require('node:fs');
const original = global.setTimeout;
const marker = process.env.TEST_WAIT_MARKER;
const configured = Number(process.env.AGENT_ORCH_WAIT_POLL_MS);
const interval = Number.isFinite(configured) && configured > 0 ? configured : 3000;
let observed = false;
if (marker && process.argv[2] === 'wait') {
  global.setTimeout = (callback, ms, ...args) => {
    if (ms !== interval || observed) return original(callback, ms, ...args);
    observed = true;
    fs.writeFileSync(marker, '');
    return original(function released() {
      if (!fs.existsSync(`${marker}.release`)) return original(released, 10);
      callback(...args);
    }, ms);
  };
}
