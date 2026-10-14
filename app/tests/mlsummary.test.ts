// 0.8.1: detection summaries (probability + confidence in one sentence).
import assert from "node:assert/strict";
import { summarize, confWord, confText, confOf } from "../src/ml/summary";
import type { Detection } from "../src/ml/types";

const base: Detection = { key: "k", ep: "main", model_id: "m", model_name: "My model", target: "hail", prob: 0.62, level: "med", site: "KTLX", t: Date.UTC(2026, 4, 1, 22, 0), lat: 35, lon: -97 };

export function testConfidenceWords() {
  assert.equal(confWord(0.8), "high");
  assert.equal(confWord(0.55), "moderate");
  assert.equal(confWord(0.31), "low");
  assert.equal(confWord(0.1), "very low");
  assert.equal(confWord(undefined), "unknown");
  assert.equal(confText(0.584), "58% (moderate)");
  // unknown confidence (older servers) passes a confidence gate
  assert.equal(confOf({}), 1);
  assert.equal(confOf({ confidence: 0.2 }), 0.2);
}

export function testEveryTargetHasASentence() {
  const targets = ["tornado", "supercell", "hail", "sighail", "wind", "debris", "flash_flood", "wildfire", "custom", "storm_intensify", "instability", "temp_forecast", "precip_forecast", "storm_forecast", "tropical_forecast", "tropical_genesis", "tropical_possible", "outlook", "flood_forecast", "storm_track"];
  for (const target of targets) {
    const s = summarize({ ...base, target, confidence: 0.7, track: target === "storm_track" ? [{ lead_min: 60, lat: 35.2, lon: -96.6, speed_kt: 30, strength: 55, strength_units: "dBZ", cone_km: 12 }] : undefined });
    assert.ok(s.length > 20 && s.endsWith("."), `${target}: ${s}`);
    assert.ok(s.includes("70% (moderate)"), `${target} shows the confidence: ${s}`);
    assert.ok(!s.includes("undefined") && !s.includes("NaN"), `${target}: ${s}`);
  }
}

export function testIntensifyAndTrackDetails() {
  const s = summarize({ ...base, target: "storm_intensify", confidence: 0.81, extra: { ref_max: 52, lead_min: 30, dref: 5 }, storm_cells: 3 });
  assert.match(s, /will intensify from 52 dBZ to 57\+ dBZ over the next 30 minutes \(62% chance\)/);
  assert.match(s, /3 cells/);
  const t = summarize({ ...base, target: "storm_track", prob: 1, confidence: 0.4, motion: { dir: 67, kt: 32 }, track: [{ lead_min: 30, lat: 35.1, lon: -96.8 }, { lead_min: 60, lat: 35.2, lon: -96.6, strength: 55, strength_units: "dBZ", cone_km: 14 }] });
  assert.match(t, /move ENE at 32 kt/);
  assert.match(t, /60 minutes with a strength of 55 dBZ/);
  assert.match(t, /40% \(low\)/);
  const a = summarize({ ...base, target: "instability", kind: "area", prob: 0.75, confidence: 0.5, valid_from: Date.UTC(2026, 4, 1, 18), valid_to: Date.UTC(2026, 4, 1, 21) });
  assert.match(a, /There is a high amount of instability here \(75% probability\) from 18:00Z to 21:00Z/);
}
