// "Record now" for the radar(s) on screen: one server recording per site (main + extra radars),
// started and stopped together from the timeline.

import { signal, computed } from "@preact/signals";
import { api } from "./api";
import { settings, toast } from "./store";
import { sites, l3For } from "./radar/controller";
import { recs, loadRecs, stopRec } from "./ui/panels/RecordPanel";

const KEY = "tbw.radarrec";

function load(): { ids: string[]; start: number } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}
function save(v: { ids: string[]; start: number } | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off */
  }
}

/** recordings started from the timeline (survives reloads) */
export const radarRec = signal<{ ids: string[]; start: number } | null>(load());

/** still running? (cleared once the server says they all ended) */
export const radarRecActive = computed(() => {
  const r = radarRec.value;
  if (!r) return false;
  const list = recs.value;
  // until the list is loaded, trust what we started
  if (!list.length) return true;
  return r.ids.some((id) => {
    const x = list.find((q) => q.id === id);
    return !x || x.status === "recording" || x.status === "scheduled";
  });
});

/** What "Record" would capture right now: sites and product. */
export function radarRecPlan() {
  const r = settings.value.radar;
  const list = [r.site, ...settings.value.extraSites.filter((s) => s !== r.site)];
  return list.map((site) => {
    const tdwr = sites.value.find((s) => s.id === site)?.type === "TDWR";
    const products = r.source === "L3" ? [l3For(r.product, tdwr)] : [r.product];
    return { site, source: r.source, products };
  });
}

export async function startRadarRec(minutes: number) {
  const plan = radarRecPlan();
  const now = Date.now();
  const ids: string[] = [];
  for (const p of plan) {
    try {
      const res = await api.send("POST", "/api/rec", { kind: "radar", start: 0, end: minutes ? now + minutes * 60_000 : null, radar: p });
      const id = res?.id ?? res?.rec?.id;
      if (id) ids.push(id);
    } catch (e: any) {
      toast(`${p.site}: ${e.message}`, "error", 7000);
    }
  }
  if (!ids.length) return;
  radarRec.value = { ids, start: now };
  save(radarRec.value);
  toast(`Recording ${plan.map((p) => p.site).join(", ")}`);
  loadRecs();
}

/** the server ended them (timed): forget */
export function forgetRadarRec() {
  radarRec.value = null;
  save(null);
}

export async function stopRadarRec() {
  const r = radarRec.value;
  radarRec.value = null;
  save(null);
  if (!r) return;
  await Promise.all(r.ids.map((id) => stopRec(id)));
  toast("Radar recording stopped");
}

export function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
