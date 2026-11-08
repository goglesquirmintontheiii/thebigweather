// 0.8.3 3d: height-surface helpers (value → height, max-pooling decimation, mesh, picking).
import assert from "node:assert/strict";
import { heightMapFor, heightOf, binRaster, binSweep, buildMesh, raySurface, fieldAt, pool, isVelocityTable, surfaceable, liveVersion, sideFor, SURF_TOP, SURF_N, MESH_STRIDE } from "../src/radar/surface3dcore";

const REF = { id: "REF", name: "Reflectivity", units: "dBZ", min: -30, max: 80 };
const VEL = { id: "VEL", name: "Velocity", units: "m/s", min: -64, max: 64 };
const ET = { id: "ET", name: "Echo Tops", units: "kft", min: 0, max: 70 };
const VIL = { id: "VIL", name: "VIL", units: "kg/m²", min: 0, max: 80 };

export function testHeightMapping() {
  const r = heightMapFor(REF, false);
  assert.equal(r.lo, 5, "reflectivity starts at 5 dBZ, not the table's −30");
  assert.equal(heightOf(0, r), 0);
  assert.equal(heightOf(80, r), SURF_TOP);
  assert.equal(heightOf(200, r), SURF_TOP, "clamped at the top");
  assert.ok(Math.abs(heightOf(42.5, r) - SURF_TOP / 2) < 1e-6);
  assert.equal(heightOf(NaN, r), 0);
  // velocity: height from |v|, symmetric
  const v = heightMapFor(VEL, true);
  assert.equal(v.lo, 0);
  assert.equal(heightOf(-32, v), heightOf(32, v));
  assert.ok(Math.abs(heightOf(-32, v) - SURF_TOP / 2) < 1e-6);
  // echo tops are heights already: 35 kft → 10.668 km
  const e = heightMapFor(ET, false);
  assert.equal(e.perUnit, 304.8);
  assert.ok(Math.abs(heightOf(35, e) - 35 * 304.8) < 1e-6);
  // VIL: plain linear scale from 0
  const l = heightMapFor(VIL, false);
  assert.equal(heightOf(40, l), SURF_TOP / 2);
}

export function testPoolKeepsStrongest() {
  const a = new Float32Array([NaN, NaN]);
  pool(a, 0, 10, false);
  pool(a, 0, 30, false);
  pool(a, 0, 20, false);
  assert.equal(a[0], 30);
  pool(a, 1, 20, true);
  pool(a, 1, -35, true);
  pool(a, 1, 30, true);
  assert.equal(a[1], -35, "velocity keeps the sign of the largest |v|");
}

function raster(w: number, h: number, vals: (x: number, y: number) => number | null) {
  const data = new Uint16Array(w * h);
  // value = offset + (raw - 1) * scale, raw 0 = no data
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = vals(x, y);
    data[y * w + x] = v === null ? 0 : Math.round(v * 10) + 1;
  }
  return { w, h, x0: 0.2, y0: 0.3, x1: 0.3, y1: 0.4, data, scale: 0.1, offset: 0, rgba: undefined };
}

export function testBinRasterDecimatesByMax() {
  // 1000×800 raster with a single 1-pixel spike: max-pooling must keep it after decimation
  const r = raster(1000, 800, (x, y) => (x === 517 && y === 333 ? 75 : x < 50 ? null : 10));
  const f = binRaster(r, 200, false)!;
  assert.equal(f.nx, 200);
  assert.equal(f.ny, 160);
  assert.ok(f.nx * f.ny <= SURF_N.hi * SURF_N.hi);
  let max = -Infinity, nan = 0;
  for (const v of f.v) v === v ? (max = Math.max(max, v)) : nan++;
  assert.ok(Math.abs(max - 75) < 1e-4, "spike survives");
  assert.equal(nan, 10 * 160, "no-data columns stay empty");
  // the spike lands in the right cell
  const at = fieldAt(f, 0.2 + (517.5 / 1000) * 0.1, 0.3 + (333.5 / 800) * 0.1);
  assert.ok(Math.abs(at - 75) < 1e-4);
  // a small raster is not upsampled
  assert.equal(binRaster(raster(50, 40, () => 1), 200, false)!.nx, 50);
  // RGB composites have no values
  assert.equal(binRaster({ ...raster(4, 4, () => 1), rgba: new Uint8Array(64) }, 200, false), null);
}

export function testBinSweepPlacesEcho() {
  // 360 radials × 400 gates of 250 m; one strong cell 50 km due north, −40 m/s inbound
  const nrad = 360, ngates = 400, gate = 250, firstGate = 0;
  const az = new Float32Array(nrad).map((_, i) => i + 0.5);
  const data = new Uint8Array(nrad * ngates);
  for (let r = 0; r < nrad; r++) for (let g = 0; g < ngates; g++) {
    const north = az[r] < 3 || az[r] > 357;
    const rangeKm = (g * gate) / 1000;
    // value = (raw - offset) / scale with offset 129, scale 2: raw 49 → −40, raw 149 → 10
    data[r * ngates + g] = north && rangeKm > 48 && rangeKm < 52 ? 49 : 149;
  }
  const sw = { nrad, ngates, firstGate, gate, elevation: 0.5, lat: 35, lon: -97, az, data, lut: null, offset: 129, scale: 2 };
  const f = binSweep(sw as any, 200, true);
  assert.equal(f.nx, 200);
  // the cell 50 km north of the radar holds −40
  const lat = 35 + (50_000 / 6371000) * (180 / Math.PI);
  const my = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
  const mx = (-97 + 180) / 360;
  assert.equal(fieldAt(f, mx, my), -40);
  // far east is +10, beyond 100 km (the sweep's range) is empty
  const east = mx + 60_000 / (2 * Math.PI * 6371000 * Math.cos((35 * Math.PI) / 180));
  assert.equal(fieldAt(f, east, 0.5 - Math.log(Math.tan(Math.PI / 4 + (35 * Math.PI) / 360)) / (2 * Math.PI)), 10);
  assert.ok(Number.isNaN(fieldAt(f, f.x0 + 1e-6, f.y0 + 1e-6)), "corner outside the range ring");
  assert.ok(f.valid > 0);
}

export function testMeshAndPick() {
  // 4×3 field, one empty node: quads touching any valid node are drawn
  const v = new Float32Array([10, 20, 30, 40, 50, NaN, 60, 70, 80, 80, 80, 80]);
  const f = { nx: 4, ny: 3, x0: 0.5, y0: 0.5, x1: 0.5004, y1: 0.5003, v, valid: 11 };
  const hm = heightMapFor(VIL, false);
  const m = buildMesh(f, hm);
  assert.equal(m.verts.length, 12 * MESH_STRIDE);
  assert.equal(m.idx.length, 3 * 2 * 6, "every quad has a valid corner");
  for (const i of m.idx) assert.ok(i < 12);
  assert.equal(m.verts[5 * MESH_STRIDE + 4], 0, "empty node flagged");
  assert.equal(m.verts[5 * MESH_STRIDE + 2], 0, "empty node on the ground");
  assert.equal(m.maxH, heightOf(80, hm));
  // a vertical ray onto node (2,2) = 80 hits at its height
  const x = 0.5 + 2.5 * 0.0001, y = 0.5 + 2.5 * 0.0001;
  const hit = raySurface(f, hm, [x, y, 20000 * 4], [x, y, -10], 4)!;
  assert.equal(hit.value, 80);
  assert.equal(hit.h, heightOf(80, hm));
  // a ray outside misses
  assert.equal(raySurface(f, hm, [0.6, 0.6, 1000], [0.6, 0.6, -1], 4), null);
}

export function testSourceHelpers() {
  assert.ok(isVelocityTable("VEL") && isVelocityTable("SRV") && !isVelocityTable("REF"));
  assert.ok(surfaceable({ units: "dBZ" }));
  assert.ok(!surfaceable({ units: "", labels: { 1: "Rain" } }), "categorical (HCA) has no height");
  assert.ok(!surfaceable(null));
  assert.equal(liveVersion("live:KTLX:12", 3), "&v=3");
  assert.equal(liveVersion("KTLX20260101_000000_V06", 3), "");
  assert.equal(sideFor("lo"), SURF_N.lo);
  assert.equal(sideFor("hi"), SURF_N.hi);
}
