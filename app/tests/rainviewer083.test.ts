// 0.8.3 / 0.8.4: RainViewer radar markers: view culling, native-site dedupe, region filter, cap (src/intl/rvcore.ts).
import assert from "node:assert/strict";
import { rvVisible, rvRegion, type RvRadar } from "../src/intl/rvcore";

const R = (id: string, lat: number, lon: number, country: string, extra: Partial<RvRadar> = {}): RvRadar => ({ id, source: `rv_${id}`, name: id, country, lat, lon, range_km: 250, ...extra });

const list = [R("AU022", -37.85, 144.75, "AU"), R("AU032", -34.26, 150.87, "AU"), R("NZAU2", -36.9, 174.8, "NZ"), R("ESMA2", 40.5, -3.7, "ES")];

export function testRegions() {
  assert.equal(rvRegion("AU"), "OC");
  assert.equal(rvRegion("de"), "EU");
  assert.equal(rvRegion("CA"), "CA");
  assert.equal(rvRegion("BR"), "SA");
  assert.equal(rvRegion("MX"), "CB");
  assert.equal(rvRegion("MU"), "AF");
  assert.equal(rvRegion("CN"), "AS");
  assert.equal(rvRegion(""), "OT");
}

export function testViewCulling() {
  const aus = { w: 140, s: -40, e: 155, n: -30 };
  const v = rvVisible(list, aus, [], new Set());
  assert.deepEqual(v.map((r) => r.id), ["AU022", "AU032"], "only radars in view");
  // across the antimeridian (MapLibre gives east > 180)
  const pac = { w: 170, s: -40, e: 190, n: -30 };
  assert.deepEqual(rvVisible(list, pac, [], new Set()).map((r) => r.id), ["NZAU2"]);
  // the selected radar stays even out of view
  assert.ok(rvVisible(list, aus, [], new Set(), "rv_ESMA2").some((r) => r.id === "ESMA2"));
}

export function testNativeDedupeAndHiddenRegions() {
  const eu = { w: -10, s: 35, e: 5, n: 45 };
  assert.equal(rvVisible(list, eu, [{ lat: 40.45, lon: -3.75 }], new Set()).length, 0, "Stormiq already has this radar (ODIM)");
  assert.equal(rvVisible(list, eu, [{ lat: 50, lon: 8 }], new Set()).length, 1);
  assert.equal(rvVisible(list, eu, [], new Set(["EU"])).length, 0);
  // one chip hides one region only
  const world = { w: -179, s: -80, e: 179, n: 80 };
  assert.deepEqual(rvVisible(list, world, [], new Set(["OC"])).map((r) => r.id), ["ESMA2"]);
}

export function testCapNearestFirst() {
  const many = Array.from({ length: 50 }, (_, i) => R(`X${i}`, -30 + i * 0.1, 140 + i * 0.1, "AU"));
  const v = rvVisible(many, { w: 130, s: -40, e: 160, n: -20 }, [], new Set(), "", 10);
  assert.equal(v.length, 10);
  // the view centre is (-30, 145): the radars nearest it are X20…X30
  assert.ok(v.every((r) => +r.id.slice(1) >= 20), v.map((r) => r.id).join(","));
}
