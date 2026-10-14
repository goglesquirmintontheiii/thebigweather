// 0.8.1 perf: frame-cache byte budget, performance presets, crash-loop guard.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ByteLRU } from "../src/grid/budget";
import { resolvePerf, autoPreset, fitImage, radarSmooth, softwareGpu, DEFAULT_PERF, PRESETS } from "../src/perfcore";

const require = createRequire(import.meta.url);
const guard = require("../electron/crashguard.cjs");

export function testBudgetEvictsOldestByBytes() {
  const b = new ByteLRU(100);
  const gone: string[] = [];
  const ev = (id: string) => () => void gone.push(id);
  b.set("a", 40, ev("a"));
  b.set("b", 40, ev("b"));
  b.touch("a"); // b is now the oldest
  b.set("c", 40, ev("c"));
  assert.deepEqual(gone, ["b"]);
  assert.equal(b.total, 80);
  assert.ok(b.has("a") && b.has("c") && !b.has("b"));
}

export function testBudgetKeepsRefusingAndNewest() {
  const b = new ByteLRU(50);
  const gone: string[] = [];
  b.set("screen", 30, () => false); // on screen: refuses
  b.set("x", 30, () => void gone.push("x"));
  // over the cap, but the only other entry refuses and the newest is kept
  assert.equal(b.total, 60);
  assert.deepEqual(gone, []);
  b.set("y", 30, () => void gone.push("y"));
  assert.deepEqual(gone, ["x"]);
  assert.ok(b.has("screen") && b.has("y"));
  // a single frame bigger than the cap still stays (never an empty map)
  const c = new ByteLRU(10);
  c.set("big", 100, () => true);
  assert.ok(c.has("big"));
}

export function testBudgetReplaceAndPrefixAndCap() {
  const b = new ByteLRU(1000);
  let evicted = 0;
  b.set("pane1|k", 100, () => void evicted++);
  b.set("pane1|k", 200, () => void evicted++); // replace: not an eviction
  assert.equal(b.total, 200);
  assert.equal(evicted, 0);
  b.set("pane2|k", 300, () => void evicted++);
  b.deletePrefix("pane1|");
  assert.equal(b.total, 300);
  b.set("main|a", 300, () => void evicted++);
  b.setCap(400); // shrinking evicts down to the cap
  assert.equal(evicted, 1);
  assert.ok(b.total <= 400);
}

export function testPresetsAndAuto() {
  // a strong PC (or unknown hardware) = Quality = today's look
  assert.equal(autoPreset({ cores: 32, memGB: 8, gpu: "NVIDIA GeForce RTX 5090" }), "quality");
  assert.equal(autoPreset({}), "quality");
  assert.equal(autoPreset({ cores: 4, memGB: 8, gpu: "Intel UHD" }), "balanced");
  assert.equal(autoPreset({ cores: 16, memGB: 8, gpu: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" }), "low");
  assert.ok(softwareGpu("llvmpipe (LLVM 15.0.7, 256 bits)"));
  assert.ok(!softwareGpu("AMD Radeon RX 7900 XTX"));
  const q = resolvePerf(DEFAULT_PERF, { cores: 24, memGB: 8 });
  assert.equal(q.preset, "quality");
  assert.equal(q.pixelRatio, 1);
  assert.equal(q.maxFps, 0);
  assert.equal(q.radarQ, "high");
  assert.equal(q.anim, true);
  // hand-set options override the preset; nonsense is sanitised
  const o = resolvePerf({ preset: "balanced", over: { maxFps: 30, pixelRatio: 0.1 as number, cacheMB: 1 }, hud: false }, {});
  assert.equal(o.maxFps, 30);
  assert.equal(o.pixelRatio, 0.5);
  assert.equal(o.cacheMB, 64);
  assert.equal(o.prefetch, PRESETS.balanced.prefetch);
  // safe mode = Low-end whatever was chosen
  const s = resolvePerf({ preset: "quality", over: { maxPanes: 8 }, hud: false }, {}, true);
  assert.equal(s.preset, "low");
  assert.equal(s.maxPanes, PRESETS.low.maxPanes);
}

export function testFitImageAndSmoothing() {
  // fits: unchanged
  assert.deepEqual(fitImage(1600, 900, 2400, 12, 4, 1024 ** 3), { w: 1600, h: 900 });
  // size cap keeps the aspect ratio
  assert.deepEqual(fitImage(2400, 1200, 1200, 1, 2, 1e12), { w: 1200, h: 600 });
  // a 24-frame RGB loop at 2400² is 553 MB: with a 220 MB budget each frame shrinks to fit
  const f = fitImage(2400, 2400, 2400, 24, 4, 220 * 1024 ** 2);
  assert.ok(f.w * f.h * 4 * 24 <= 220 * 1024 ** 2 * 1.01, `${f.w}x${f.h}`);
  assert.ok(f.w > 1400);
  assert.equal(radarSmooth(0.75, "high"), 0.75);
  assert.equal(radarSmooth(0.75, "med"), 0.5);
  assert.equal(radarSmooth(0.75, "low"), 0);
}

export function testCrashLoopGuard() {
  const t0 = 1_000_000;
  // first start ever: normal
  let r = guard.onStart({}, t0);
  assert.equal(r.safe, false);
  // it crashes 10 s after loading: one failed start
  let c = guard.onCrash(r.state, t0 + 15_000, t0 + 5_000);
  assert.equal(c.early, true);
  assert.equal(c.state.fails, 1);
  // second start: still normal; then the app is killed while starting (no crash event)
  r = guard.onStart(c.state, t0 + 60_000);
  assert.equal(r.safe, false);
  // third start sees the pending (killed) start → 2 failures in a row → safe mode
  r = guard.onStart(r.state, t0 + 120_000);
  assert.equal(r.safe, true);
  assert.equal(r.reason, "crash");
  // reaching stable resets everything
  assert.deepEqual(guard.onStable(), { fails: 0, pending: 0 });
  r = guard.onStart(guard.onStable(), t0 + 200_000);
  assert.equal(r.safe, false);
  // a crash long after start doesn't feed the loop guard
  c = guard.onCrash(r.state, t0 + 900_000, t0 + 205_000);
  assert.equal(c.early, false);
  assert.equal(c.state.fails, 0);
  // a clean quit within the first minute isn't a failure
  r = guard.onStart(guard.onCleanQuit({ fails: 1, pending: t0 }), t0 + 1_000_000);
  assert.equal(r.state.fails, 1);
  assert.equal(r.safe, false);
  // --safe-mode
  assert.equal(guard.onStart({}, t0, { flag: true }).safe, true);
  assert.equal(guard.onStart({}, t0, { flag: true }).reason, "flag");
  // garbage state file
  assert.equal(guard.onStart("nonsense", t0).safe, false);
}

export function testSafeSettings() {
  const s = { panes: { layout: "4", list: [{ weather: { kind: "grid", id: "goes/19/full/13" } }] }, weather: { kind: "grid", id: "goes/19/full/geocolor" }, view3d: { on: true, res: "hi" }, radar: { site: "KTLX" } };
  const o = guard.safeSettings(s);
  assert.equal(o.panes.layout, "1");
  assert.equal(o.panes.list.length, 1, "pane configs kept for Restore");
  assert.deepEqual(o.weather, { kind: "radar" });
  assert.equal(o.view3d.on, false);
  assert.equal(o.radar.site, "KTLX");
  assert.equal(s.panes.layout, "4", "input untouched");
  // radar / MRMS main layers stay
  assert.deepEqual(guard.safeSettings({ weather: { kind: "grid", id: "mrms/lowalt" } }).weather, { kind: "grid", id: "mrms/lowalt" });
}
