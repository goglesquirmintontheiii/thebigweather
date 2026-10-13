// radio/dash 0.8: audio level track for the waveform seek bar.
import assert from "node:assert/strict";
import { LevelTrack, BIN, toDb, dbPos } from "../src/audio/levels";

function sine(n: number, amp: number) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * 1050 * i) / 8000);
  return x;
}

export function testBinsPeakAndRms() {
  const L = new LevelTrack();
  // 1 s of a 0.5 sine fed in 50 ms blocks at media times 10.0 … 10.95, then 1 s of silence
  for (let k = 0; k < 20; k++) L.feed(sine(400, 0.5), 10 + k * 0.05);
  for (let k = 0; k < 20; k++) L.feed(new Float32Array(400), 11 + k * 0.05);
  L.feed(new Float32Array(400), 12.5); // flush
  const loud = L.span(10, 10.9)!;
  assert.ok(Math.abs(loud[0] - 0.5) < 0.01, `peak ${loud[0]}`);
  assert.ok(Math.abs(loud[1] - 0.5 / Math.SQRT2) < 0.02, `rms ${loud[1]}`);
  const quiet = L.span(11.1, 11.9)!;
  assert.equal(quiet[0], 0);
  assert.equal(L.span(30, 40), null, "never heard → no levels");
  assert.ok(L.version > 0);
}

export function testPruneAndLive() {
  const L = new LevelTrack();
  for (let t = 0; t < 20; t += BIN) L.feed(sine(200, 0.2), t);
  L.prune(10);
  assert.equal(L.span(0, 9.7), null);
  assert.ok(L.span(10.5, 12));
  assert.ok(L.live.peak > 0.19 && L.live.rms > 0.1);
  assert.equal(Math.round(toDb(0.5)), -6);
  assert.equal(dbPos(-60), 0);
  assert.equal(dbPos(0), 1);
}
