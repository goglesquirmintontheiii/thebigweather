// 0.8.3 inspector: nearest-radar ranking, Inspector placement / feature rows, pane site clicks.
import assert from "node:assert/strict";
import { nearestN, normLon, inspPlace, overlayIdOf, inspLayers, compactRows, metarRows, dedupeRows, siteClickTarget, gcKm } from "../src/radar/insp083";

const SITES = [
  { id: "KTLX", lat: 35.333, lon: -97.278 },
  { id: "KINX", lat: 36.175, lon: -95.564 },
  { id: "KFDR", lat: 34.362, lon: -98.976 },
  { id: "KVNX", lat: 36.741, lon: -98.128 },
  { id: "BAD", lat: NaN, lon: 0 },
  { id: "KAMA", lat: 35.233, lon: -101.709 },
];

export function testNearestRanking() {
  const r = nearestN(SITES, 35.4, -97.5, 3);
  assert.deepEqual(r.map((x) => x.item.id), ["KTLX", "KVNX", "KFDR"]);
  assert.ok(r[0].km < r[1].km && r[1].km <= r[2].km);
  assert.ok(Math.abs(r[0].km - gcKm(35.4, -97.5, 35.333, -97.278)) < 1e-9);
  // fewer sites than asked, bad coordinates skipped
  assert.equal(nearestN(SITES, 0, 0, 10).length, 5);
  assert.deepEqual(nearestN([], 1, 2, 3), []);
  assert.deepEqual(nearestN(SITES, 35, -97, 0), []);
}

export function testNearestWrappedLongitude() {
  // the map reports longitudes past ±180 after panning across the world; same answer
  const a = nearestN(SITES, 35.4, -97.5, 3).map((x) => x.item.id);
  const b = nearestN(SITES, 35.4, -97.5 + 720, 3).map((x) => x.item.id);
  assert.deepEqual(a, b);
  assert.equal(normLon(190), -170);
  assert.equal(normLon(-190), 170);
  assert.equal(normLon(180), -180);
  assert.equal(normLon(-457.5), -97.5);
}

export function testNearestTiesKeepOrder() {
  const l = [
    { id: "A", lat: 10, lon: 10 },
    { id: "B", lat: 10, lon: 10 },
  ];
  assert.deepEqual(nearestN(l, 0, 0, 2).map((x) => x.item.id), ["A", "B"]);
}

export function testInspPlaceStaysInside() {
  const W = 1000, H = 700, bw = 268, bh = 300;
  for (const x of [0, 10, 500, 700, 730, 760, 990, 1000])
    for (const y of [0, 50, 400, 690]) {
      const p = inspPlace(x, y, W, H, bw, bh, 48);
      assert.ok(p.left >= 4 && p.left + bw <= W - 4, `x ${x}: ${p.left}`);
      assert.ok(p.top >= 4 && p.top + bh <= H - 4, `y ${y}: ${p.top}`);
    }
  // right of the cursor when there is room, flipped near the right edge
  assert.equal(inspPlace(100, 100, W, H, bw, bh).left, 122);
  assert.equal(inspPlace(900, 100, W, H, bw, bh).left, 900 - 22 - bw);
  // a pane smaller than the box: pinned to the left edge
  assert.equal(inspPlace(50, 50, 200, 150, bw, bh).left, 4);
}

export function testLayerIds() {
  assert.equal(overlayIdOf("o-metar-icon"), "metar");
  assert.equal(overlayIdOf("o-glm"), "glm");
  assert.equal(overlayIdOf("o-file:abc-fill"), "file:abc");
  assert.equal(overlayIdOf("ovl-alerts-fill"), null);
  const order = ["bg", "o-metar-icon", "o-metar-text", "o-cameras-count", "o-cameras-icon", "ovl-alerts-fill", "o-nhc-label", "o-nhc-cone"];
  assert.deepEqual(inspLayers(order, ["ovl-alerts-fill"]), ["o-metar-icon", "o-cameras-icon", "ovl-alerts-fill", "o-nhc-cone"]);
}

export function testCompactRows() {
  const r = compactRows("quakes", { title: "M 4.2 – 10 km N of Somewhere, a very long place name for the inspector box", rows: [["Depth", "8 km"], ["When", "—"], ["Felt", ""], ["Mag", "4.2"], ["X", "1"], ["Y", "2"]] }, 3)!;
  assert.ok(r.title.length <= 48 && r.title.endsWith("…"));
  assert.deepEqual(r.rows, [["Depth", "8 km"], ["Mag", "4.2"], ["X", "1"]]); // empty / dash values dropped
  assert.equal(compactRows("x", null), null);
  assert.equal(compactRows("x", { title: "" }), null);
  const m = metarRows({ t: 20, td: 10, wd: 180, ws: 12.4, wg: 21, vis: 16.09 });
  assert.deepEqual(m, [["Temp / dew", "68° / 50°"], ["Wind", "180° 12 kt G21"], ["Visibility", "10.0 mi"]]);
  assert.deepEqual(metarRows({}), [["Temp / dew", "— / —"]]);
  const d = dedupeRows([{ kind: "a", title: "T", rows: [] }, { kind: "a", title: "T", rows: [] }, { kind: "b", title: "T", rows: [] }, { kind: "c", title: "1", rows: [] }, { kind: "c", title: "2", rows: [] }], 3);
  assert.deepEqual(d.map((x) => x.kind + x.title), ["aT", "bT", "c1"]);
}

export function testSiteClickTarget() {
  const all = { pos: true, time: true, layers: true };
  assert.equal(siteClickTarget(all, true), "main");
  assert.equal(siteClickTarget({ ...all, pos: false }, true), "pane");
  assert.equal(siteClickTarget({ ...all, layers: false }, true), "pane");
  assert.equal(siteClickTarget({ ...all, time: false }, true), "pane");
  assert.equal(siteClickTarget({ pos: false, time: false, layers: false }, false), "main"); // not a radar pane
}
