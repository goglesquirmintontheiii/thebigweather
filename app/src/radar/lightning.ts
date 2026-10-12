// radar 0.6: lightning proximity from the GOES GLM feed (/api/ovl/glm: points with `age` in seconds).
// `lightningNear` is the helper the rules engine uses; `ltgNearPoints` drives the "last strike"
// chip for saved points (polled only while the option is on and there are saved points).

import { signal, effect } from "@preact/signals";
import { api } from "../api";
import { settings } from "../store";
import { distance } from "../util";

interface Strike {
  lat: number;
  lon: number;
  t: number;
}
let feed: { at: number; minutes: number; strikes: Strike[] } | null = null;
let pending: Promise<Strike[]> | null = null;

/** GLM flashes from the last `minutes` (max 30), shared by every caller for 20 s. */
export async function glmStrikes(minutes = 30): Promise<Strike[]> {
  const m = Math.min(30, Math.max(1, Math.ceil(minutes)));
  const now = Date.now();
  if (feed && now - feed.at < 20_000 && feed.minutes >= m) return feed.strikes.filter((s) => s.t >= now - m * 60_000);
  if (!pending) {
    pending = api
      .get(`/api/ovl/glm?minutes=30`)
      .then((fc: any) => {
        const at = Date.now();
        const strikes = ((fc?.features ?? []) as any[]).map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], t: at - (f.properties?.age ?? 0) * 1000 }));
        feed = { at, minutes: 30, strikes };
        return strikes;
      })
      .finally(() => (pending = null));
  }
  const all = await pending;
  return all.filter((s) => s.t >= Date.now() - m * 60_000);
}

export interface Near {
  count: number;
  nearest_km: number | null;
  last_t: number | null;
  /** nearest strike: distance (m), bearing from the point (deg), age (ms) — for callers that want them */
  dist?: number;
  brg?: number;
  age?: number;
}

/** Strikes within `km` of a point in the last `minutes`. */
export async function lightningNear(lat: number, lon: number, km: number, minutes: number): Promise<Near> {
  return nearIn(await glmStrikes(minutes), lat, lon, km, minutes);
}

function nearIn(strikes: Strike[], lat: number, lon: number, km: number, minutes: number): Near {
  const since = Date.now() - minutes * 60_000;
  let count = 0, nearest = Infinity, last = 0, nLat = 0, nLon = 0;
  // cheap box test first (most strikes are far away)
  const dLat = km / 110.57, dLon = km / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  for (const s of strikes) {
    if (s.t < since || Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLon) continue;
    const d = distance(lat, lon, s.lat, s.lon) / 1000;
    if (d > km) continue;
    count++;
    if (d < nearest) (nearest = d), (nLat = s.lat), (nLon = s.lon);
    if (s.t > last) last = s.t;
  }
  if (!count) return { count, nearest_km: null, last_t: null };
  const y = Math.sin(((nLon - lon) * Math.PI) / 180) * Math.cos((nLat * Math.PI) / 180);
  const x = Math.cos((lat * Math.PI) / 180) * Math.sin((nLat * Math.PI) / 180) - Math.sin((lat * Math.PI) / 180) * Math.cos((nLat * Math.PI) / 180) * Math.cos(((nLon - lon) * Math.PI) / 180);
  return { count, nearest_km: nearest, last_t: last, dist: nearest * 1000, brg: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, age: Date.now() - last };
}

/** Synchronous variant on the last fetched feed (null if nothing fetched yet). */
export function lightningNearCached(lat: number, lon: number, km: number, minutes: number): Near | null {
  return feed ? nearIn(feed.strikes, lat, lon, km, minutes) : null;
}

// ---------- saved points watch ----------
export const ltgNearPoints = signal<{ id: string; name: string; km: number; t: number; count: number }[]>([]);
let timer: number | undefined;

async function poll() {
  const pts = settings.value.points;
  const km = (settings.value.radar6?.ltgMi ?? 10) * 1.609344;
  try {
    const strikes = await glmStrikes(30);
    const out = [];
    for (const p of pts) {
      const n = nearIn(strikes, p.lat, p.lon, km, 30);
      if (n.count && n.nearest_km != null && n.last_t) out.push({ id: p.id, name: p.name, km: n.nearest_km, t: n.last_t, count: n.count });
    }
    ltgNearPoints.value = out.sort((a, b) => b.t - a.t);
  } catch {
    /* feed unavailable */
  }
}

let wsig = "";
effect(() => {
  const want = !!settings.value.radar6?.ltgWatch && settings.value.points.length > 0;
  const s = `${want}|${settings.value.points.map((p) => `${p.lat},${p.lon}`).join(";")}|${settings.value.radar6?.ltgMi}`;
  void api.base;
  if (s === wsig) return;
  wsig = s;
  clearInterval(timer);
  if (!want) {
    ltgNearPoints.value = [];
    return;
  }
  setTimeout(poll, 3000);
  timer = window.setInterval(() => !document.hidden && poll(), 60_000);
});

(window as any).__tbwLightning = { lightningNear, lightningNearCached }; // radar 0.6: rules engine / console
