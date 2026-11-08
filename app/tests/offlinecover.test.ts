// 0.8.2: offline areas — polygon tile cover, ref counts and the Download / Update / Delete diff.
import assert from "node:assert/strict";
import { coverTiles, countCover, tileInPoly, refCounts, planChange, neededKeys, tileKey, toTile, pointInPoly, type LngLat } from "../src/offline/cover";

const T = [{ url: "https://tiles.example.org/t/{z}/{x}/{y}.pbf", maxzoom: 14 }];
const area = (poly: LngLat[], maxz: number, minz = 0, extra: string[] = []) => ({ poly, minz, maxz, templates: T, extra });

/** brute force: tile intersects polygon ⇔ a tile corner is inside, a vertex is inside the tile, or edges cross */
function brute(poly: LngLat[], z: number): Set<string> {
  const pts = poly.map((p) => toTile(p, z));
  const out = new Set<string>();
  const n = 2 ** z;
  const segX = (a: number[], b: number[], c: number[], d: number[]) => {
    const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  const inside = (p: number[]) => {
    let r = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r;
    }
    return r;
  };
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      const c = [[x + 0.5, y + 0.5], [x + 0.01, y + 0.01], [x + 0.99, y + 0.01], [x + 0.99, y + 0.99], [x + 0.01, y + 0.99]];
      let hit = c.some(inside) || pts.some((p) => p[0] > x && p[0] < x + 1 && p[1] > y && p[1] < y + 1);
      const sides = [[c[1], c[2]], [c[2], c[3]], [c[3], c[4]], [c[4], c[1]]];
      for (let i = 0; !hit && i < pts.length; i++) for (const [a, b] of sides) if (segX(pts[i], pts[(i + 1) % pts.length], a, b)) hit = true;
      if (hit) out.add(`${x}/${y}`);
    }
  return out;
}

export function testCoverIsPolygonNotBbox() {
  // a thin diagonal sliver across Kansas → Missouri: its bbox is much bigger than its tile cover
  const sliver: LngLat[] = [[-101, 37], [-94.6, 40], [-94.4, 39.8], [-100.8, 36.8]];
  for (const z of [5, 7, 9]) {
    const got = new Set([...coverTiles(sliver, z)].map(([x, y]) => `${x}/${y}`));
    const want = brute(sliver, z);
    for (const k of want) assert.ok(got.has(k), `z${z}: missing ${k}`);
    // allowed to over-cover only tiles touching the outline (edges exactly on tile lines)
    assert.ok(got.size <= want.size * 1.15 + 2, `z${z}: ${got.size} vs ${want.size}`);
  }
  const z = 9;
  const [a, b] = [toTile([-101, 40], z), toTile([-94.4, 36.8], z)];
  const bboxTiles = (Math.floor(b[0]) - Math.floor(a[0]) + 1) * (Math.floor(b[1]) - Math.floor(a[1]) + 1);
  assert.ok(countCover(sliver, z, z) < bboxTiles / 3, `sliver ${countCover(sliver, z, z)} vs bbox ${bboxTiles}`);
}

export function testConcavePolygon() {
  // a "U": the notch in the middle is not covered
  const u: LngLat[] = [[-100.2, 30.1], [-90.3, 30.1], [-90.3, 40.1], [-92.1, 40.1], [-92.1, 32.1], [-98.1, 32.1], [-98.1, 40.1], [-100.2, 40.1]];
  const z = 8;
  const got = new Set([...coverTiles(u, z)].map(([x, y]) => `${x}/${y}`));
  assert.deepEqual([...got].sort(), [...brute(u, z)].sort());
  const [nx, ny] = toTile([-95, 37], z);
  assert.ok(!tileInPoly(u, z, Math.floor(nx), Math.floor(ny)), "notch tile");
  const [ix, iy] = toTile([-99, 37], z);
  assert.ok(tileInPoly(u, z, Math.floor(ix), Math.floor(iy)), "arm tile");
  assert.ok(pointInPoly([-99, 35], u) && !pointInPoly([-95, 35], u));
}

export function testCountsPerZoom() {
  const box: LngLat[] = [[-100, 30], [-90, 30], [-90, 40], [-100, 40]];
  assert.equal(countCover(box, 0, 0), 1);
  // a tiny polygon is one tile per zoom
  const tiny: LngLat[] = [[-95.001, 35.001], [-95.0005, 35.001], [-95.0005, 35.0015]];
  assert.equal(countCover(tiny, 0, 10), 11);
}

export function testRefCountsAndMaxZoomWins() {
  const a = area([[-100, 30], [-95, 30], [-95, 35], [-100, 35]], 8);
  const b = area([[-97, 32], [-92, 32], [-92, 37], [-97, 37]], 6, 0, ["https://tiles.example.org/fonts/a/0-255.pbf"]);
  const rc = refCounts([a, b]);
  // the zoom-0 tile is needed by both
  assert.equal(rc.get(tileKey("https://tiles.example.org/t/0/0/0.pbf")), 2);
  // overlap at z7/z8 is only needed by `a` (b stops at z6): max zoom over covering polygons
  const k8 = [...rc.keys()].filter((k) => k.includes("/t/8/"));
  assert.ok(k8.length > 0 && k8.every((k) => rc.get(k) === 1));
  const n = neededKeys([a, b]);
  assert.ok(n.has("tiles.example.org/fonts/a/0-255.pbf"));
}

export function testDownloadDeleteUpdateDiff() {
  const a = area([[-100, 30], [-95, 30], [-95, 35], [-100, 35]], 7);
  const b = area([[-97, 32], [-92, 32], [-92, 37], [-97, 37]], 7);
  // Download b with a already stored: only the tiles a doesn't have
  const dl = planChange([a], [a, b]);
  assert.equal(dl.del.length, 0);
  const aKeys = neededKeys([a]);
  assert.ok(dl.add.length > 0 && dl.add.every((u) => !aKeys.has(tileKey(u))));
  assert.equal(dl.add.length, neededKeys([a, b]).size - aKeys.size);
  // Delete a: only the tiles b doesn't need go
  const del = planChange([a, b], [b]);
  assert.equal(del.add.length, 0);
  const bKeys = neededKeys([b]);
  assert.ok(del.del.length > 0 && del.del.every((k) => !bKeys.has(k)));
  assert.equal(del.del.length, aKeys.size - [...aKeys].filter((k) => bKeys.has(k)).length);
  // Update: stretch b east and raise its max zoom; the old western part shrinks away
  const b2 = { ...b, poly: [[-96, 32], [-90, 32], [-90, 37], [-96, 37]] as LngLat[], maxz: 8 };
  const up = planChange([a, b], [a, b2]);
  const after = neededKeys([a, b2]);
  const before = neededKeys([a, b]);
  assert.ok(up.add.every((u) => after.has(tileKey(u)) && !before.has(tileKey(u))));
  assert.ok(up.del.every((k) => before.has(k) && !after.has(k)));
  assert.ok(up.add.some((u) => u.includes("/t/8/")), "new zoom level fetched");
  // tiles still inside `a` are never deleted
  assert.ok(up.del.every((k) => !aKeys.has(k)));
  // applying the plan gives exactly the new set
  const store = new Set(before);
  up.del.forEach((k) => store.delete(k));
  up.add.forEach((u) => store.add(tileKey(u)));
  assert.deepEqual([...store].sort(), [...after].sort());
  // no change → nothing to do
  const none = planChange([a, b], [a, b]);
  assert.equal(none.add.length + none.del.length, 0);
}

export function testTileKeyStable() {
  assert.equal(tileKey("https://a.basemaps.cartocdn.com/x/1/2/3@2x.png?k=1"), "basemaps.cartocdn.com/x/1/2/3@2x.png");
  assert.equal(tileKey("https://tiles.openfreemap.org/planet/20250101_001001_pt/5/6/7.pbf"), "tiles.openfreemap.org/planet/5/6/7.pbf");
}
