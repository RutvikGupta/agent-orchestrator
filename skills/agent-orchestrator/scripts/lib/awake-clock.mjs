// A clock for timing work and pacing it: the milliseconds that passed while this process could
// run. It leaves out the time the machine slept or the process was stopped, and a wall clock that
// was set backward. Measured on the wall clock, a build that was in flight when a laptop went to
// sleep seems to have taken as long as the sleep, and anything paced by that time then waits as long
// again.
//
// The wall clock gives the steps. A monotonic clock that keeps counting through sleep finds the
// gaps: it is read at least once a second while the process runs, so a longer step between two
// reads means the process did not run in between, and the wall-clock step beside it is not counted.
import { performance } from "node:perf_hooks";

export function awakeClock({ wall = () => Date.now(), monotonic = () => performance.now(), gapMs = 5000, beatMs = 1000 } = {}) {
  // Both clocks at one instant. The process can be stopped between two reads; the monotonic clock,
  // read before and after the wall clock, shows when it was, and the reads are taken again.
  const both = () => {
    for (let tries = 0; ; tries++) {
      const before = monotonic(), w = wall(), after = monotonic();
      if (after - before <= gapMs || tries >= 3) return { w, m: after };
    }
  };
  let last = both(), awake = 0;
  const now = () => {
    const next = both(), step = next.w - last.w, ran = next.m - last.m <= gapMs;
    last = next;
    if (ran && step > 0) awake += step;
    return awake;
  };
  // Without this, the only reads would be the caller's, and two of them minutes apart would look
  // like a sleep.
  const beat = setInterval(function awakeBeat() { now(); }, beatMs);
  beat.unref?.();
  return { now, stop: () => clearInterval(beat) };
}
