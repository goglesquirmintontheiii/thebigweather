// Storm-relative velocity: the storm motion subtracted from Level II velocity on the GPU
// (RadarLayer): v_srv = v − |M|·cos(az − dir_to). Motion is user-set, automatic (mean motion of
// tracked storm cells near the radar) or taken from a clicked storm cell.

import { computed, signal } from "@preact/signals";
import { settings, update, toast } from "../store";
import { stormCells } from "../overlays/stormcells";
import { distance } from "../util";
import { currentSite } from "./controller";

/** SRV can apply: Level II velocity on screen */
export const srvAvailable = computed(() => {
  const r = settings.value.radar;
  return settings.value.weather.kind === "radar" && r.source === "L2" && r.product === "VEL";
});

/** mean motion of cells within 250 km of the radar ({dir_to, m/s}) */
export const autoMotion = computed<{ dir: number; speed: number; n: number } | null>(() => {
  const site = currentSite.value;
  const cells = stormCells.value.cells;
  if (!cells.length) return null;
  let u = 0, v = 0, n = 0, cnt = 0;
  for (const c of cells) {
    const p = c.p;
    if (p.dir_to == null || !(p.sknt > 0)) continue;
    if (site && distance(site.lat, site.lon, c.lat, c.lon) > 250_000) continue;
    const ms = p.sknt / 1.943844;
    const a = (p.dir_to * Math.PI) / 180;
    // stronger cells count more (they're what you'd look at in SRV)
    const w = 1 + Math.max(0, (p.max_dbz ?? 40) - 40) / 10;
    u += Math.sin(a) * ms * w;
    v += Math.cos(a) * ms * w;
    n += w;
    cnt++;
  }
  if (!n) return null;
  u /= n;
  v /= n;
  return { dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, speed: Math.hypot(u, v), n: cnt };
});

/** motion used by the renderer, or null when SRV is off */
export const srvMotion = computed<{ dir: number; speed: number } | null>(() => {
  const s = settings.value.srv;
  if (!s?.on || !srvAvailable.value) return null;
  if (s.mode === "auto") {
    const a = autoMotion.value;
    if (a) return { dir: a.dir, speed: a.speed };
  }
  return { dir: s.dir, speed: s.speed };
});

/** waiting for a click on a storm cell */
export const srvPicking = signal(false);

/** Map click while picking: take the nearest tracked cell's motion. Returns true if handled. */
export function srvPickAt(lat: number, lon: number, pxPerM: number): boolean {
  if (!srvPicking.value) return false;
  srvPicking.value = false;
  let best: any = null, bd = Infinity;
  for (const c of stormCells.value.cells) {
    if (c.p.dir_to == null || !(c.p.sknt > 0)) continue;
    const d = distance(lat, lon, c.lat, c.lon);
    if (d < bd) ((bd = d), (best = c));
  }
  if (!best || bd * pxPerM > 60) {
    toast("No moving storm cell there (turn on Storm cells)", "warn");
    return true;
  }
  useCellMotion(best.p);
  return true;
}

export function useCellMotion(p: any) {
  if (p?.dir_to == null || !(p.sknt > 0)) return;
  update((s) => (s.srv = { ...s.srv, on: true, mode: "cell", dir: Math.round(p.dir_to), speed: +(p.sknt / 1.943844).toFixed(1) }));
  toast(`SRV: cell ${p.storm_id ?? ""} motion`);
}
