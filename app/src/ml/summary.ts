// 0.8.1: probability vs confidence, and one plain sentence per detection.
//
// probability = what the model says about the event (calibrated output; regression models give a
//   value instead, e.g. dBZ, °C, mm).
// confidence  = how far to trust that number here and now, from the server (0–1): the model's
//   validation skill, how well its probabilities matched reality at this probability
//   (calibration), how much of its input data was available (missing sources, non-US
//   dropouts), whether the place is inside the region it was trained on, and (ensembles)
//   how much the members agree. Older servers send none: confidence is then unknown.

import type { Detection } from "./types";

// no app imports (unit-tested in node): the map layer plugs in the app's time format
const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
export const summaryFmt = { time: (ms: number) => `${new Date(ms).toISOString().slice(11, 16)}Z` };
const fmtTime = (ms: number) => summaryFmt.time(ms);

export const CONF_HELP = "Probability: the model's chance of the event. Confidence: how far to trust that number here — model skill, calibration at this probability, input data available, inside the training region, ensemble agreement.";

/** "high" / "moderate" / "low" / "very low" */
export function confWord(c: number | undefined): string {
  if (c == null || !Number.isFinite(c)) return "unknown";
  return c >= 0.75 ? "high" : c >= 0.5 ? "moderate" : c >= 0.3 ? "low" : "very low";
}
export const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
/** "64% (moderate)" or "unknown" */
export function confText(c: number | undefined): string {
  return c == null || !Number.isFinite(c) ? "unknown" : `${pct(c)} (${confWord(c)})`;
}
/** the confidence used for gates / filters: unknown passes (older servers) */
export const confOf = (d: { confidence?: number }) => (d.confidence != null && Number.isFinite(d.confidence) ? d.confidence : 1);

const EVENT: Record<string, string> = {
  tornado: "produces a tornado",
  supercell: "is a supercell",
  hail: "produces large hail",
  sighail: "produces significant (2 in+) hail",
  wind: "produces damaging winds",
  debris: "is lofting tornado debris",
  flash_flood: "causes flash flooding",
  wildfire: "is an active wildfire",
  tropical_genesis: "becomes a tropical cyclone",
  tropical_possible: "develops into a tropical cyclone",
};
const AREA_EVENT: Record<string, string> = {
  flood_forecast: "flooding",
  flash_flood: "flash flooding",
  tropical_forecast: "tropical development",
  tropical_genesis: "tropical cyclone formation",
  tropical_possible: "tropical cyclone formation",
  outlook: "severe weather",
};
const amount = (p: number) => (p >= 0.7 ? "a high amount of" : p >= 0.4 ? "a moderate amount of" : "some");
const fmtStrength = (v: number, u?: string) => {
  const uu = (u ?? "").trim();
  if (/^ef$/i.test(uu)) return `EF${Math.round(v)}`;
  if (uu === "%") return `${Math.round(v > 1 ? v : v * 100)}%`;
  return `${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${uu ? ` ${uu}` : ""}`;
};
function when(d: Detection): string {
  if (d.valid_from && d.valid_to) return ` from ${fmtTime(d.valid_from)} to ${fmtTime(d.valid_to)}`;
  if (d.valid_to) return ` until ${fmtTime(d.valid_to)}`;
  return "";
}

/** One sentence: what the model predicts, its probability (or value) and the confidence. */
export function summarize(d: Detection): string {
  const c = `, with a confidence of ${confText(d.confidence)}`;
  const p = pct(d.prob);
  const x = d.extra ?? {};
  const cells = d.storm_cells && d.storm_cells > 1 ? ` (${d.storm_cells} cells)` : "";
  switch (d.target) {
    case "storm_intensify": {
      const lead = Math.round(x.lead_min ?? 30);
      const now = x.ref_max;
      const to = now != null ? `from ${Math.round(now)} dBZ to ${Math.round(now + (x.dref ?? 5))}+ dBZ` : "further";
      return `It is predicted this storm${cells} will intensify ${to} over the next ${lead} minutes (${p} chance)${c}.`;
    }
    case "storm_track": {
      const tr = d.track ?? [];
      const last = tr[tr.length - 1];
      if (!last) return `Storm track forecast${c}.`;
      const dir = d.motion ? `move ${compass(d.motion.dir)} at ${Math.round(d.motion.kt)} kt` : last.speed_kt != null ? `move at ${Math.round(last.speed_kt)} kt` : "move";
      const st = last.strength != null ? ` with a strength of ${fmtStrength(last.strength, last.strength_units)}` : "";
      const cone = last.cone_km ? ` (±${Math.round(last.cone_km)} km)` : "";
      return `This storm${cells} is predicted to ${dir}, reaching the end of its track${cone} in ${Math.round(last.lead_min)} minutes${st}${c}.`;
    }
    case "instability":
      return `There is ${amount(d.prob)} instability here (${p} probability)${when(d)}${c}.`;
    case "storm_forecast":
      return d.value != null ? `Storms reaching ${Math.round(d.value)} dBZ are forecast here${when(d)}${c}.` : `There is a ${p} chance of storms here${when(d)}${c}.`;
    case "temp_forecast":
      return d.value != null ? `The temperature is forecast to reach ${d.value.toFixed(1)} °C here${when(d)}${c}.` : `Temperature forecast${when(d)}${c}.`;
    case "precip_forecast":
      return d.value != null ? `Up to ${d.value.toFixed(1)} mm of precipitation is forecast here${when(d)}${c}.` : `There is a ${p} chance of precipitation here${when(d)}${c}.`;
  }
  if (d.kind === "area" || AREA_EVENT[d.target]) {
    const ev = AREA_EVENT[d.target] ?? "the event";
    if (d.value != null && d.prob >= 0.999) return `${ev[0].toUpperCase()}${ev.slice(1)} up to ${d.value.toFixed(1)} is forecast here${when(d)}${c}.`;
    return `There is a ${p} chance of ${ev} in this area${when(d)}${c}.`;
  }
  const ev = EVENT[d.target] ?? `matches “${d.model_name}”`;
  const ref = x.ref_max != null ? `this ${Math.round(x.ref_max)} dBZ storm` : "this storm";
  return `There is a ${p} chance ${ref}${cells} ${ev}${c}.`;
}
