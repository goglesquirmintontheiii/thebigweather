// 0.8.3: wheel scrubbing accumulator, loop stall detection and frame skipping (src/animcore.ts).
import assert from "node:assert/strict";
import { WheelScrub, loopStalled, nextReady } from "../src/animcore";

export function testWheelStepsPerThreshold() {
  const w = new WheelScrub(40, 5);
  assert.equal(w.add(20, 0), 0);
  assert.equal(w.add(20, 10), 1);
  assert.equal(w.add(100, 20), 3);
  assert.equal(w.take(), 3);
  assert.equal(w.take(), 0);
  // the 20 px remainder carries on in the same direction
  assert.equal(w.add(20, 30), 1);
}

export function testWheelReversalDropsOldDirection() {
  const w = new WheelScrub(40, 2, 200);
  for (let i = 0; i < 10; i++) w.add(30, i * 16); // lots of forward scrolling, not yet taken
  assert.equal(w.add(-10, 200), 0, "reversal throws away queued forward steps and the remainder");
  assert.equal(w.add(-30, 210), -1);
  // forward inertia right after the reversal is ignored
  assert.equal(w.add(120, 230), -1);
  assert.equal(w.take(), -1);
  // a real change of mind later counts again
  assert.equal(w.add(40, 600), 1);
}

export function testWheelCapsQueuedSteps() {
  const w = new WheelScrub(40, 2);
  assert.equal(w.add(400, 0), 2, "a burst never queues more than maxPending steps");
  assert.equal(w.take(), 2);
}

export function testWheelDeltaModes() {
  assert.equal(WheelScrub.delta({ deltaX: 0, deltaY: 3, deltaMode: 1 }), 120);
  assert.equal(WheelScrub.delta({ deltaX: -50, deltaY: 10, deltaMode: 0 }), -50);
  assert.equal(WheelScrub.delta({ deltaX: 0, deltaY: 1, deltaMode: 2 }), 400);
  const w = new WheelScrub();
  assert.equal(w.add(NaN, 0), 0);
  assert.equal(w.add(0, 0), 0);
}

export function testLoopStalled() {
  assert.equal(loopStalled(1000, 900, 4, 0), false);
  assert.equal(loopStalled(5000, 1000, 4, 0), true);
  // a long pause on the last frame is not a stall
  assert.equal(loopStalled(8000, 1000, 4, 4000), false);
  assert.equal(loopStalled(12000, 1000, 4, 4000), true);
  // slow playback
  assert.equal(loopStalled(4000, 0, 0.25, 0), false);
}

export function testNextReadySkipsMissingFrames() {
  const ready = new Set([0, 3, 5]);
  assert.equal(nextReady(0, 6, (i) => ready.has(i)), 3);
  assert.equal(nextReady(3, 6, (i) => ready.has(i)), 5);
  assert.equal(nextReady(5, 6, (i) => ready.has(i)), 0);
  assert.equal(nextReady(0, 6, (i) => i === 0), -1, "only the current frame is ready");
  assert.equal(
    nextReady(0, 4, (i) => {
      if (i === 1) throw new Error("boom");
      return i === 2;
    }),
    2,
  );
}
