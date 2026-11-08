// 0.8.2: map panes — per-pane layers, frame picking / preload order, product search.
import assert from "node:assert/strict";
import { paneLayerOn, nearestFrame, nearestReady, preloadOrder, dropPane } from "../src/map/panesync";
import { filterGroups, flatItems, stepIndex } from "../src/ui/productFilter";

export function testPaneLayerResolution() {
  // linked panes follow the main map, unlinked ones show only their default, overrides always win
  assert.equal(paneLayerOn(true, true, undefined), true);
  assert.equal(paneLayerOn(false, true, undefined), false);
  assert.equal(paneLayerOn(true, false, undefined), false);
  assert.equal(paneLayerOn(false, false, undefined, true), true); // state lines in unlinked panes
  assert.equal(paneLayerOn(true, true, false), false);
  assert.equal(paneLayerOn(false, false, true), true);
}

export function testNearestFrame() {
  const fs = [{ time: 100 }, { time: 200 }, { time: 300 }];
  assert.equal(nearestFrame(fs, 0), fs[2]); // unlinked time: newest
  assert.equal(nearestFrame(fs, 190), fs[1]);
  assert.equal(nearestFrame(fs, 1000), fs[2]);
  assert.equal(nearestFrame([], 5), undefined);
}

export function testNearestReadyNeverStalls() {
  const fs = [{ time: 100, k: "a" }, { time: 200, k: "b" }, { time: 300, k: "c" }, { time: 400, k: "d" }];
  const ready = new Set(["a", "c"]);
  // wanted frame (d) still loading: show the nearest loaded one (c), not nothing
  assert.equal(nearestReady(fs, 400, (f) => ready.has(f.k))?.k, "c");
  assert.equal(nearestReady(fs, 190, (f) => ready.has(f.k))?.k, "a");
  assert.equal(nearestReady(fs, 0, (f) => ready.has(f.k))?.k, "c"); // newest wanted
  assert.equal(nearestReady(fs, 300, () => false), undefined);
}

export function testPreloadOrderFollowsPlayback() {
  assert.deepEqual(preloadOrder(5, 3, "all"), [4, 0, 1, 2]); // plays 4, then wraps to 0…
  assert.deepEqual(preloadOrder(5, 4, "none"), [0]);
  assert.deepEqual(preloadOrder(10, 0, "near"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(preloadOrder(1, 0, "all"), []);
  const long = preloadOrder(100, 50, "all");
  assert.equal(long.length, 33); // 30 ahead + 3 back
  assert.equal(long[0], 51);
  assert.deepEqual(long.slice(-3), [49, 48, 47]);
  assert.deepEqual(preloadOrder(4, -1, "all"), [0, 1, 2]); // unknown index: from the newest
}

export function testDropPaneShiftsLaterPanes() {
  assert.deepEqual(dropPane({ 1: "a", 2: "b", 3: "c" }, 2), { 1: "a", 2: "c" });
  assert.deepEqual(dropPane(undefined, 1), {});
}

const GROUPS = [
  { label: "Level II · KTLX", items: [{ value: "r:L2:REF", label: "Reflectivity", hint: "1" }, { value: "r:L2:VEL", label: "Velocity", hint: "2" }] },
  { label: "MRMS - Hail", items: [{ value: "g:mrms/mesh", label: "Max hail size (MESH)" }, { value: "g:mrms/mesh24", label: "Max hail 24h" }] },
  { label: "MRMS - Rotation", items: [{ value: "g:mrms/rot24", label: "Rotation track 24h" }] },
];

export function testProductSearch() {
  assert.equal(flatItems(filterGroups(GROUPS, "")).length, 5);
  assert.deepEqual(flatItems(filterGroups(GROUPS, "max hail")).map((i) => i.value), ["g:mrms/mesh", "g:mrms/mesh24"]);
  assert.deepEqual(flatItems(filterGroups(GROUPS, "ROT 24")).map((i) => i.value), ["g:mrms/rot24"]);
  // a group name matches its items; empty groups are dropped
  const r = filterGroups(GROUPS, "level ii");
  assert.equal(r.length, 1);
  assert.equal(r[0].items.length, 2);
  assert.equal(filterGroups(GROUPS, "nothing like this").length, 0);
  // word starts only: "vel" is Velocity, not every item under "Level II"
  assert.deepEqual(flatItems(filterGroups(GROUPS, "vel")).map((i) => i.value), ["r:L2:VEL"]);
  assert.deepEqual(flatItems(filterGroups(GROUPS, "mrms hail")).map((i) => i.value), ["g:mrms/mesh", "g:mrms/mesh24"]);
}

export function testArrowKeysWrap() {
  assert.equal(stepIndex(-1, 1, 3), 0);
  assert.equal(stepIndex(-1, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(0, 1, 0), -1);
}
