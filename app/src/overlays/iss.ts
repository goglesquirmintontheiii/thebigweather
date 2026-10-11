// ISS and other satellites, propagated in the app (SGP4) from CelesTrak elements.

import { effect, signal } from "@preact/signals";
import { twoline2satrec, propagate, gstime, eciToGeodetic, eciToEcf, ecfToLookAngles, degreesLat, degreesLong, type SatRec } from "satellite.js";
import { api } from "../api";
import { settings } from "../store";
import { destination } from "../util";
import { setData, onClearSelection } from "./manager";
import { onSelectSat } from "./defs";

interface Sat {
  name: string;
  rec: SatRec;
  station: boolean;
}

let sats: Sat[] = [];
let loadedSig = "";
let tick: number | undefined;
let trackAt = 0;
let track: any[] = [];
/** satellite whose trail is shown (clicked) */
export const selectedSat = signal<string | null>(null);

const R = 6371;

type Opts = { iss: string; tiangong: string; hubble: string; others: string; ring: string; trail: string; isstrack: string };
function opts(): Opts {
  const o = settings.value.ovl.iss?.opts ?? {};
  // older settings used a single "set" option
  const set = o.set;
  return {
    iss: o.iss ?? "1",
    tiangong: o.tiangong ?? (set === "stations" || set === "weather" ? "1" : "0"),
    hubble: o.hubble ?? (set === "stations" || set === "weather" ? "1" : "0"),
    others: o.others ?? (set === "weather" ? "1" : "0"),
    ring: o.ring ?? "small",
    trail: o.trail ?? "20",
    isstrack: o.isstrack ?? "1",
  };
}

async function load(o: Opts) {
  const groups = ["stations"];
  if (o.hubble === "1" || o.others === "1") groups.push("visual");
  if (o.others === "1") groups.push("weather");
  const all: { name: string; l1: string; l2: string; g: string }[] = [];
  for (const g of groups) {
    try {
      const r = await api.get(`/api/ovl/tle?group=${g}`);
      all.push(...r.sats.map((s: any) => ({ ...s, g })));
    } catch {
      /* group unavailable */
    }
  }
  const seen = new Set<string>();
  const want = (n: string, g: string) => {
    if (n.startsWith("ISS (ZARYA)")) return o.iss === "1";
    if (n.startsWith("CSS (TIANHE)")) return o.tiangong === "1";
    if (n === "HST") return o.hubble === "1";
    // "all stations + weather satellites": every crewed module/station plus the weather group
    return o.others === "1" && (g === "weather" || (g === "stations" && !n.startsWith("ISS") && !n.startsWith("CSS")));
  };
  sats = all
    .filter((s) => want(s.name, s.g))
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    .slice(0, 400)
    .map((s) => ({
      name: s.name.replace("ISS (ZARYA)", "ISS").replace("CSS (TIANHE)", "Tiangong").replace(/^HST$/, "Hubble"),
      rec: twoline2satrec(s.l1, s.l2),
      station: /^(ISS \(ZARYA\)|CSS \(TIANHE\)|HST)$/.test(s.name),
    }));
  trackAt = 0;
}

export function satState(rec: SatRec, when = new Date()) {
  const pv = propagate(rec, when);
  if (!pv || !pv.position || typeof pv.position === "boolean") return null;
  const gmst = gstime(when);
  const g = eciToGeodetic(pv.position as any, gmst);
  const v = pv.velocity as any;
  return { lat: degreesLat(g.latitude), lon: degreesLong(g.longitude), alt: g.height, speed: Math.hypot(v.x, v.y, v.z) * 3600, eci: pv.position as any, gmst };
}

/** Line segments between two times (minutes from now), split at the antimeridian. */
function path(rec: SatRec, from: number, to: number, props: Record<string, unknown>, stepMin = 0.5): any[] {
  const out: any[] = [];
  const now = Date.now();
  let seg: [number, number][] = [];
  let prevLon: number | null = null;
  for (let m = from; m <= to + 1e-9; m += stepMin) {
    const s = satState(rec, new Date(now + m * 60_000));
    if (!s) continue;
    if (prevLon !== null && Math.abs(s.lon - prevLon) > 180) {
      if (seg.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: seg }, properties: props });
      seg = [];
    }
    seg.push([s.lon, s.lat]);
    prevLon = s.lon;
  }
  if (seg.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: seg }, properties: props });
  return out;
}

/** Circle with longitudes kept continuous around the center (no wrap across ±180, which would
 * turn the polygon inside out and cover the whole map). */
function ring(lat: number, lon: number, radiusM: number, n = 72): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    let [x, y] = destination(lat, lon, (i / n) * 360, radiusM);
    while (x - lon > 180) x -= 360;
    while (x - lon < -180) x += 360;
    pts.push([x, y]);
  }
  return pts;
}

function update() {
  if (!sats.length) return setData("iss", { type: "FeatureCollection", features: [] });
  const o = opts();
  const now = Date.now();
  const feats: any[] = [];
  const sel = selectedSat.value;
  if (now - trackAt > 20_000) {
    track = [];
    const iss = sats.find((s) => s.name === "ISS");
    if (iss && o.isstrack === "1") track.push(...path(iss.rec, -45, 0, { _kind: "track", past: true }, 1), ...path(iss.rec, 0, 95, { _kind: "track", past: false }, 1));
    trackAt = now;
  }
  feats.push(...track);
  const selSat = sel ? sats.find((s) => s.name === sel) : undefined;
  if (selSat) {
    const mins = Math.max(1, +o.trail || 20);
    feats.push(...path(selSat.rec, -mins, 0, { _kind: "trail" }, Math.max(0.25, mins / 120)));
    feats.push(...path(selSat.rec, 0, Math.min(mins, 45), { _kind: "ahead" }, Math.max(0.25, mins / 120)));
  }
  for (const s of sats) {
    const st = satState(s.rec);
    if (!st) continue;
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
      properties: { _kind: "sat", name: s.name, station: s.station, sel: s.name === sel, alt: Math.round(st.alt), speed: Math.round(st.speed), lat: st.lat, lon: st.lon },
    });
    if (s.station && o.ring !== "off") {
      // small marker ring by default; the full footprint shows where it's above the horizon
      const rho = o.ring === "foot" ? Math.acos(R / (R + st.alt)) * R * 1000 : 120_000;
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring(st.lat, st.lon, rho)] }, properties: { _kind: "foot", name: s.name } });
    }
  }
  setData("iss", { type: "FeatureCollection", features: feats });
}

/** Next time the satellite rises above `minEl` degrees for an observer (within 36 hours). */
export function nextPass(name: string, lat: number, lon: number, minEl = 10): { start: number; maxEl: number; end: number } | null {
  const s = sats.find((x) => x.name === name);
  if (!s) return null;
  const obs = { latitude: (lat * Math.PI) / 180, longitude: (lon * Math.PI) / 180, height: 0.1 };
  let t = Date.now();
  const end = t + 36 * 3_600_000;
  let start = 0;
  let maxEl = 0;
  for (; t < end; t += 20_000) {
    const st = satState(s.rec, new Date(t));
    if (!st) continue;
    const look = ecfToLookAngles(obs, eciToEcf(st.eci, st.gmst));
    const el = (look.elevation * 180) / Math.PI;
    if (el >= minEl) {
      if (!start) start = t;
      maxEl = Math.max(maxEl, el);
    } else if (start) {
      return { start, maxEl, end: t };
    }
  }
  return null;
}

effect(() => {
  const on = !!settings.value.ovl.iss?.on;
  const o = opts();
  const sig = `${o.iss}${o.tiangong}${o.hubble}${o.others}`;
  void api.base;
  void selectedSat.value;
  clearInterval(tick);
  if (!on) {
    selectedSat.value = null;
    return;
  }
  trackAt = 0;
  (async () => {
    if (sig !== loadedSig || !sats.length) {
      loadedSig = sig;
      await load(o);
    }
    update();
  })();
  tick = window.setInterval(update, sats.length > 60 ? 3000 : 1000);
});

api.on("connected", async () => {
  if (!settings.value.ovl.iss?.on) return;
  await load(opts());
  update();
});

onSelectSat((name) => (selectedSat.value = name));
onClearSelection(() => {
  if (selectedSat.value) selectedSat.value = null;
});
