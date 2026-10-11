// ISS and other satellites, propagated in the app (SGP4) from CelesTrak elements.

import { effect } from "@preact/signals";
import { twoline2satrec, propagate, gstime, eciToGeodetic, eciToEcf, ecfToLookAngles, degreesLat, degreesLong, type SatRec } from "satellite.js";
import { api } from "../api";
import { settings } from "../store";
import { circle } from "../util";
import { setData } from "./manager";

interface Sat {
  name: string;
  rec: SatRec;
}

let sats: Sat[] = [];
let loadedSet = "";
let tick: number | undefined;
let trackAt = 0;
let track: any[] = [];

const R = 6371;

function pick(set: string, all: { name: string; l1: string; l2: string }[]): { name: string; l1: string; l2: string }[] {
  const want = (n: string) => {
    if (n.startsWith("ISS (ZARYA)")) return true;
    if (set === "iss") return false;
    if (n.startsWith("CSS (TIANHE)") || n === "HST") return true;
    return set === "weather" && !n.startsWith("ISS") && !n.startsWith("CSS");
  };
  return all.filter((s) => want(s.name));
}

async function load(set: string) {
  const groups = set === "iss" ? ["stations"] : set === "stations" ? ["stations", "visual"] : ["stations", "visual", "weather"];
  const all: { name: string; l1: string; l2: string }[] = [];
  for (const g of groups) {
    try {
      const r = await api.get(`/api/ovl/tle?group=${g}`);
      all.push(...r.sats.map((s: any) => ({ ...s, name: g === "weather" && !s.name.startsWith("ISS") ? s.name : s.name })));
    } catch {
      /* group unavailable */
    }
  }
  const seen = new Set<string>();
  sats = pick(set, all)
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    .map((s) => ({ name: s.name.replace("ISS (ZARYA)", "ISS").replace("CSS (TIANHE)", "Tiangong").replace(/^HST$/, "Hubble"), rec: twoline2satrec(s.l1, s.l2) }));
  loadedSet = set;
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

function groundTrack(rec: SatRec): any[] {
  const out: any[] = [];
  const now = Date.now();
  for (const [from, to, past] of [[-45, 0, true], [0, 95, false]] as const) {
    let seg: [number, number][] = [];
    let prevLon: number | null = null;
    for (let m = from; m <= to; m += 1) {
      const s = satState(rec, new Date(now + m * 60_000));
      if (!s) continue;
      // split at the antimeridian
      if (prevLon !== null && Math.abs(s.lon - prevLon) > 180) {
        if (seg.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: seg }, properties: { _kind: "track", past } });
        seg = [];
      }
      seg.push([s.lon, s.lat]);
      prevLon = s.lon;
    }
    if (seg.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: seg }, properties: { _kind: "track", past } });
  }
  return out;
}

function update() {
  if (!sats.length) return;
  const now = Date.now();
  const feats: any[] = [];
  if (now - trackAt > 30_000) {
    track = sats.filter((s) => s.name === "ISS" || sats.length <= 3).flatMap((s) => groundTrack(s.rec));
    trackAt = now;
  }
  feats.push(...track);
  for (const s of sats) {
    const st = satState(s.rec);
    if (!st) continue;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [st.lon, st.lat] }, properties: { _kind: "sat", name: s.name, alt: Math.round(st.alt), speed: Math.round(st.speed), lat: st.lat, lon: st.lon } });
    if (s.name === "ISS" || sats.length <= 3) {
      // visibility footprint (where it's above the horizon)
      const rho = Math.acos(R / (R + st.alt)) * R * 1000;
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(st.lat, st.lon, rho, 96)] }, properties: { _kind: "foot", name: s.name } });
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
  const o = settings.value.ovl.iss;
  const on = !!o?.on;
  const set = o?.opts?.set ?? "iss";
  void api.base;
  clearInterval(tick);
  if (!on) return;
  (async () => {
    if (set !== loadedSet || !sats.length) await load(set);
    update();
  })();
  tick = window.setInterval(update, 1000);
});

api.on("connected", async () => {
  const o = settings.value.ovl.iss;
  if (!o?.on) return;
  await load(o.opts?.set ?? "iss");
  update();
});
