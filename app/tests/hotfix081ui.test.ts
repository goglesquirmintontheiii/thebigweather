// 0.8.1: identify clustering, rail order merging, merged stats layout.
import assert from "node:assert/strict";
import { featurePoint, collectPoints, extentOf, gridCluster, ringRadius, cellFor } from "../src/overlays/identifyCore";
import { mergeOrder, moveBy, dropAt, isDefaultOrder, mergedLayout, MINI_MAX_H, COMPACT_MAX_H } from "../src/ui/uiorder";

export function testFeaturePoint() {
  assert.deepEqual(featurePoint({ type: "Point", coordinates: [-97, 35] }), [-97, 35]);
  assert.deepEqual(featurePoint({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]] }), [1, 2]);
  assert.deepEqual(featurePoint({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[3, 3], [4, 5]]] }), [2, 2.5]);
  assert.equal(featurePoint(null), null);
  assert.equal(featurePoint({ type: "Point", coordinates: [NaN, 1] }), null);
}

export function testCollectAndExtent() {
  const feats = [
    { geometry: { type: "Point", coordinates: [1, 2] } },
    { geometry: null },
    { geometry: { type: "Point", coordinates: [5, -3] }, properties: { point_count: 10 } },
  ];
  const c = collectPoints(feats);
  assert.equal(c.n, 2);
  assert.equal(c.total, 11, "pre-clustered points count by point_count");
  assert.deepEqual(extentOf(c.pts, c.n), [1, -3, 5, 2]);
  // sampling a huge layer keeps the total about right
  const many = Array.from({ length: 100000 }, (_, i) => ({ geometry: { type: "Point", coordinates: [i % 360 - 180, 0] } }));
  const m = collectPoints(many, 40000);
  assert.ok(m.n <= 40000);
  assert.ok(Math.abs(m.total - 100000) / 100000 < 0.05);
}

export function testGridCluster() {
  // three items close together + one far away → two groups
  const xy = [100, 100, 104, 98, 110, 105, 600, 400];
  const cl = gridCluster(xy, null, 4, 800, 600, 56);
  assert.equal(cl.length, 2);
  assert.equal(cl[0].n, 3);
  assert.ok(Math.abs(cl[0].x - 104.67) < 0.1);
  assert.equal(cl[1].n, 1);
  // off-screen items are ignored
  assert.equal(gridCluster([-500, 10, 10, 10], null, 2, 800, 600).length, 1);
  // points straddling a cell border merge into one ring
  const b = gridCluster([54, 10, 58, 10], null, 2, 800, 600, 56, 0);
  assert.equal(b.length, 1);
  assert.equal(b[0].n, 2);
  // a dense grid of 10k points stays a few hundred rings at most
  const dense: number[] = [];
  for (let i = 0; i < 10000; i++) dense.push((i * 7.3) % 1200, (i * 3.1) % 800);
  const d = gridCluster(dense, null, 10000, 1200, 800, cellFor(10000));
  assert.ok(d.length < 250, `rings: ${d.length}`);
  assert.equal(d.reduce((a, c) => a + c.n, 0), 10000);
  // ring size grows with the count but is capped
  assert.ok(ringRadius(1) < ringRadius(10) && ringRadius(10) < ringRadius(1000));
  assert.equal(ringRadius(1e9), 36);
}

export function testRailOrder() {
  const def = ["radar", "layers", "map", "sep", "forecast", "radio"];
  assert.deepEqual(mergeOrder(undefined, def), def);
  // saved order kept, unknown ids dropped, new ids placed at their default index
  const saved = ["radio", "radar", "gone", "map", "sep", "forecast"];
  assert.deepEqual(mergeOrder(saved, def), ["radio", "layers", "radar", "map", "sep", "forecast"]);
  const def2 = ["newfirst", ...def, "newlast"];
  assert.deepEqual(mergeOrder(saved, def2), ["newfirst", "radio", "layers", "radar", "map", "sep", "forecast", "newlast"]);
  assert.deepEqual(moveBy(def, "map", -1), ["radar", "map", "layers", "sep", "forecast", "radio"]);
  assert.deepEqual(moveBy(def, "radar", -1), def);
  assert.deepEqual(moveBy(def, "radio", 5), def);
  assert.deepEqual(dropAt(def, "radio", "layers", false), ["radar", "radio", "layers", "map", "sep", "forecast"]);
  assert.deepEqual(dropAt(def, "radar", "map", true), ["layers", "map", "radar", "sep", "forecast", "radio"]);
  assert.ok(isDefaultOrder(def.slice(), def));
  assert.ok(!isDefaultOrder(moveBy(def, "map", 1), def));
}

export function testMergedLayout() {
  assert.equal(mergedLayout(undefined, false), "compact");
  assert.equal(mergedLayout(undefined, true), "mini");
  assert.equal(mergedLayout(MINI_MAX_H - 1, false), "mini");
  assert.equal(mergedLayout(MINI_MAX_H, true), "compact");
  assert.equal(mergedLayout(COMPACT_MAX_H - 1, false), "compact");
  assert.equal(mergedLayout(COMPACT_MAX_H + 100, true), "full");
}
