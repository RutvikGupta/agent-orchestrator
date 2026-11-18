import test from 'node:test';
import assert from 'node:assert/strict';
import { awakeClock } from '../scripts/lib/awake-clock.mjs';

// Two clocks the test moves by hand: the wall clock, and the monotonic one that keeps counting
// through a sleep.
function clocks() {
  const at = { wall: 1_000_000, monotonic: 500 };
  const clock = awakeClock({ wall: () => at.wall, monotonic: () => at.monotonic, beatMs: 2 ** 30 });
  return {
    clock,
    // The process runs for `ms`, read once a second as the clock's own beat does.
    run(ms) { for (let left = ms; left > 0; left -= 1000) { const step = Math.min(left, 1000); at.wall += step; at.monotonic += step; clock.now(); } },
    sleep(ms) { at.wall += ms; at.monotonic += ms; },
    setWall(ms) { at.wall += ms; },
    at,
  };
}

test('the awake clock counts the time the process ran', (t) => {
  const c = clocks();
  t.after(() => c.clock.stop());
  assert.equal(c.clock.now(), 0);
  c.run(90_000);
  assert.equal(c.clock.now(), 90_000);
});

test('the awake clock leaves out a sleep, however the reads fall around it', (t) => {
  const c = clocks();
  t.after(() => c.clock.stop());
  c.run(3000);
  c.sleep(20 * 60_000);
  assert.equal(c.clock.now(), 3000, 'the first read after the sleep counted it');
  c.run(2000);
  assert.equal(c.clock.now(), 5000, 'time after the sleep was lost');
  // Several sleeps with short wakes between them, as a closed laptop has. The step in which the
  // process wakes is not counted, so each wake of 6 seconds counts as 5.
  for (let i = 0; i < 5; i++) { c.sleep(7 * 60_000); c.run(6000); }
  assert.equal(c.clock.now(), 30_000);
});

test('the awake clock leaves out a sleep that falls between its reads of the two clocks', (t) => {
  // The process is stopped after it read the wall clock and before it read the monotonic one.
  const at = { wall: 1_000_000, monotonic: 500 };
  let stopNext = false;
  const clock = awakeClock({
    wall: () => { const w = at.wall; if (stopNext) { stopNext = false; at.wall += 600_000; at.monotonic += 600_000; } return w; },
    monotonic: () => at.monotonic,
    beatMs: 2 ** 30,
  });
  t.after(() => clock.stop());
  at.wall += 1000; at.monotonic += 1000;
  assert.equal(clock.now(), 1000);
  stopNext = true;
  assert.equal(clock.now(), 1000, 'the read that the sleep cut in two counted it');
  at.wall += 1000; at.monotonic += 1000;
  assert.equal(clock.now(), 2000, 'the read after it counted the sleep');
});

test('the awake clock never runs backward when the wall clock is set back, and goes on from there', (t) => {
  const c = clocks();
  t.after(() => c.clock.stop());
  c.run(4000);
  c.setWall(-3_600_000);
  assert.equal(c.clock.now(), 4000);
  c.run(1000);
  assert.equal(c.clock.now(), 5000);
});

test('the awake clock reads itself while the process runs, so reads far apart are not taken for a sleep', async (t) => {
  // Real clocks: 2.5 seconds pass with no read by the caller, against a 1 second gap limit.
  const clock = awakeClock({ gapMs: 1000, beatMs: 50 });
  t.after(() => clock.stop());
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const read = clock.now();
  assert.ok(read >= 1000, `counted only ${read} ms of about 2500`);
});
