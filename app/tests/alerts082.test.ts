// 0.8.2: Alerts tab helpers (regions, sort / filter, levels, view → sources, nearest radar) and the
// SAME decoder keeping a long header's three copies together.
import assert from "node:assert/strict";
import { regionOf, sortAlerts, typeCounts, filterTypes, levelColor, LEVEL_COLORS, sourcesInView, nearest, radarFamily, distKm, bboxHit } from "../src/alertlist";
import { SameDecoder, type SameEvent } from "../src/same/decoder";
import { encodeSame } from "../src/same/encoder";
import { buildHeader } from "../src/same/parse";

const a = (id: string, event: string, area: string, sent: string, priority: number) => ({ properties: { id, event, areaDesc: area, sent, priority } });
const LIST = [a("1", "Tornado Warning", "Cleveland, OK", "2026-11-07T10:00:00Z", 100), a("2", "Flood Watch", "Adams, WA", "2026-11-07T12:00:00Z", 40), a("3", "Wind Advisory", "Bexar, TX", "2026-11-07T11:00:00Z", 25), a("4", "Flood Watch", "Zavala, TX", "2026-11-07T09:00:00Z", 40)];

export function testRegions() {
  assert.equal(regionOf({}), "us");
  assert.equal(regionOf({ region: "ca" }), "ca");
  assert.equal(regionOf({ country: "CA" }), "ca");
  assert.equal(regionOf({ country: "DE" }), "intl");
  assert.equal(regionOf({ region: "intl", country: "US" }), "intl");
  assert.equal(regionOf({ country: "US" }), "us");
}

export function testSorts() {
  const ids = (k: any) => sortAlerts(LIST, k).map((x) => x.properties.id).join("");
  assert.equal(ids("priority"), "1243"); // ties: newest first
  assert.equal(ids("time"), "2314");
  assert.equal(ids("type"), "2413"); // Flood Watch ×2 (newest first), Tornado, Wind
  assert.equal(ids("name"), "2314"); // Adams, Bexar, Cleveland, Zavala
  assert.equal(LIST[0].properties.id, "1", "sorting copies");
}

export function testTypeFilter() {
  assert.deepEqual(typeCounts(LIST), [["Flood Watch", 2], ["Tornado Warning", 1], ["Wind Advisory", 1]]);
  assert.equal(filterTypes(LIST, ["Flood Watch"]).length, 2);
  assert.equal(filterTypes(LIST, []).length, 4);
}

export function testLevels() {
  assert.equal(levelColor("orange"), LEVEL_COLORS.orange);
  assert.equal(levelColor("unknown", "Extreme"), LEVEL_COLORS.red);
  assert.equal(levelColor(undefined, "Moderate"), LEVEL_COLORS.yellow);
  assert.equal(levelColor(undefined, undefined), LEVEL_COLORS.unknown);
}

export function testSourcesInView() {
  const srcs = [
    { id: "ma-de", region: "intl", bbox: [5.8, 47.2, 15.1, 55.1] as [number, number, number, number] },
    { id: "ma-fr", region: "intl", bbox: [-5.3, 41.3, 9.6, 51.2] as [number, number, number, number] },
    { id: "nz", region: "intl", bbox: [166, -47.4, 178.7, -34.3] as [number, number, number, number] },
    { id: "eccc", region: "ca", bbox: [-141, 41, -52, 83] as [number, number, number, number] },
    { id: "off", region: "intl", enabled: false, bbox: [5, 47, 15, 55] as [number, number, number, number] },
  ];
  assert.deepEqual(sourcesInView(srcs, [7, 48, 12, 52]), ["ma-de", "ma-fr"]);
  assert.deepEqual(sourcesInView(srcs, [-100, 30, -80, 45]), []); // US view: none (Canada is asked for separately)
  assert.deepEqual(sourcesInView(srcs, [-180, -80, 180, 80]), []); // whole world: none (cheap)
  assert.deepEqual(sourcesInView(srcs, [170, -45, 200, -30]), ["nz"]); // across the antimeridian
  assert.ok(bboxHit([0, 0, 1, 1], [1, 1, 2, 2]));
}

export function testNearestRadar() {
  const sites = [
    { id: "KTLX", type: "NEXRAD", lat: 35.33, lon: -97.28 },
    { id: "TOKC", type: "TDWR", lat: 35.28, lon: -97.51 },
    { id: "KINX", type: "NEXRAD", lat: 36.18, lon: -95.56 },
    { id: "deess", type: "ODIM", lat: 51.4, lon: 6.97 },
  ];
  assert.ok(Math.abs(distKm(0, 0, 0, 1) - 111.2) < 0.5);
  // Level II: no TDWR (unless the current site is one); ODIM volumes count
  const l2 = radarFamily(sites, "L2", sites[0]);
  assert.deepEqual(l2.map((s) => s.id), ["KTLX", "KINX", "deess"]);
  assert.equal(nearest(l2, 35.25, -97.5)?.item.id, "KTLX");
  assert.equal(nearest(l2, 51, 7)?.item.id, "deess");
  // Level III: NEXRAD + TDWR
  const l3 = radarFamily(sites, "L3", sites[0]);
  assert.equal(nearest(l3, 35.25, -97.5)?.item.id, "TOKC");
  assert.equal(nearest([], 0, 0), null);
  // on a TDWR, Level II keeps TDWRs
  assert.ok(radarFamily(sites, "L2", sites[1]).some((s) => s.id === "TOKC"));
}

export function testSameLongHeaderStaysOneGroup() {
  // 31 locations: each burst lasts ~4 s, longer than the old 4.5 s start-to-start group window
  const locs = Array.from({ length: 31 }, (_, i) => `0400${String(i * 2 + 1).padStart(2, "0")}`);
  const now = new Date(Date.UTC(2026, 4, 20, 22, 5));
  const hdr = buildHeader({ event: "TOR", locations: locs, purge: "0045", issued: new Date(Date.UTC(2026, 4, 20, 22, 3)), sender: "KOUN/NWS" });
  const fs = 24000;
  const x = encodeSame({ fs, header: hdr, tone: "nwr", toneSec: 1, eom: false });
  const ev: SameEvent[] = [];
  const d = new SameDecoder(fs, (e) => ev.push(e), () => now);
  let firstAt = -1;
  for (let i = 0; i < x.length; i += 1024) {
    d.push(x.subarray(i, i + 1024));
    if (firstAt < 0 && ev.some((e) => e.type === "header")) firstAt = i / fs;
  }
  const h = ev.filter((e) => e.type === "header") as Extract<SameEvent, { type: "header" }>[];
  assert.equal(h.length, 1, JSON.stringify(h.map((e) => e.copies)));
  assert.equal(h[0].copies, 2); // two identical copies: out without waiting for the third
  assert.equal(h[0].raw, hdr);
  assert.ok(h[0].header && h[0].header.locations.length === 31);
  // out as soon as the second copy ends (~9.7 s), before the third one (~14.9 s)
  assert.ok(firstAt > 9 && firstAt < 11, `emitted at ${firstAt}`);
}
