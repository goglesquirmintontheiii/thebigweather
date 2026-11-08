// 0.8.3: RainViewer radar markers: view culling, native-site dedupe, region filter, cap (src/intl/rvcore.ts).
import assert from "node:assert/strict";
import { rvVisible, rvRegion, type RvRadar } from "../src/intl/rvcore";

const R = (id: string, lat: number, lon: number, country: string, extra: Partial<RvRadar> = {}): RvRadar => ({ id, source: `rv_${id}`, name: id, country, lat, lon, range_km: 250, listed: true, ...extra });

const list = [R("AU02", -37.85, 144.75, "AU"), R("AU03", -34.26, 150.87, "AU"), R("NZ01", -36.9, 174.8, "NZ"), R("DL01", 52.6, 13.9, "DE"), R("GONE", -33, 151, "AU", { listed: false })];

export function testRegions() {
  assert.equal(rvRegion("AU"), "OT");
  assert.equal(rvRegion("de"), "EU");
  assert.equal(rvRegion("CA"), "CA");
}

export function testViewCulling() {
  const aus = { w: 140, s: -40, e: 155, n: -30 };
  const v = rvVisible(list, aus, [], new Set());
  assert.deepEqual(v.map((r) => r.id), ["AU02", "AU03"], "only listed radars in view");
  // across the antimeridian (MapLibre gives east > 180)
  const pac = { w: 170, s: -40, e: 190, n: -30 };
  assert.deepEqual(rvVisible(list, pac, [], new Set()).map((r) => r.id), ["NZ01"]);
  // the selected radar stays even out of view
  assert.ok(rvVisible(list, aus, [], new Set(), "rv_DL01").some((r) => r.id === "DL01"));
}

export function testNativeDedupeAndHiddenRegions() {
  const eu = { w: 5, s: 45, e: 20, n: 56 };
  assert.equal(rvVisible(list, eu, [{ lat: 52.65, lon: 13.85 }], new Set()).length, 0, "Stormiq already has this radar (ODIM)");
  assert.equal(rvVisible(list, eu, [{ lat: 50, lon: 8 }], new Set()).length, 1);
  assert.equal(rvVisible(list, eu, [], new Set(["EU"])).length, 0);
}

export function testCapNearestFirst() {
  const many = Array.from({ length: 50 }, (_, i) => R(`X${i}`, -30 + i * 0.1, 140 + i * 0.1, "AU"));
  const v = rvVisible(many, { w: 130, s: -40, e: 160, n: -20 }, [], new Set(), "", 10);
  assert.equal(v.length, 10);
  // the view centre is (-30, 145): the radars nearest it are X20…X30
  assert.ok(v.every((r) => +r.id.slice(1) >= 20), v.map((r) => r.id).join(","));
}
