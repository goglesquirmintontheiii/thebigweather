// Historical mode: a chosen date/time window drives every weather layer's timeline, and warnings,
// storm reports, watches and MDs are replayed at the frame time. Live data comes back on exit.

import { signal, computed, effect } from "@preact/signals";
import { api } from "./api";
import { settings, update, toast } from "./store";
import { histRange, setHistory } from "./anim";
import { activeTime } from "./active";
import { setReplayAlerts, decorateAlert } from "./alerts";
import { l3Products, L2_MOMENTS } from "./radar/controller";
import { OVERLAYS, type OverlayDef } from "./overlays/defs";

export { histRange };
/** the picker is open */
export const histPicker = signal(false);
/** Longest window (the server's replay feeds allow 7 days). */
export const HIST_MAX_MS = 7 * 86400_000;

/** Time of the frame on screen, for replaying alerts and overlays (0 when live). */
export const histTime = computed(() => {
  const h = histRange.value;
  if (!h) return 0;
  const t = activeTime.value;
  return t >= h.start - 3600_000 && t <= h.end + 3600_000 ? t : h.end;
});

export function enterHistory(start: number, end: number) {
  end = Math.min(end, Date.now());
  if (!(start < end)) return toast("Start must be before end", "warn");
  if (end - start > HIST_MAX_MS) start = end - HIST_MAX_MS;
  setHistory(start, end);
  histPicker.value = false;
}

export function exitHistory() {
  setHistory(null, null);
  histPicker.value = false;
}

// ---------- overlays: which replay, which stay, which are live-only ----------

/** Overlays replayed from a history feed: `span` = active t0 ≤ T < t1, `report` = t ≤ T,
 * `valid` = fetched for the frame time. Keyed by overlay id or feed name. */
export const HIST_FEEDS: Record<string, { feed: string; kind: "span" | "report" | "valid"; param?: "valid" | "time"; roundMs?: number; errNote?: string }> = {
  lsr: { feed: "lsrhist", kind: "report" },
  watchbox: { feed: "watchhist", kind: "span" },
  mcd: { feed: "mcdhist", kind: "span" },
  stormattr: { feed: "stormattr", kind: "valid" },
  // history 0.6: archived METARs nearest the frame time (hourly, cached per hour)
  metar: { feed: "metar", kind: "valid", param: "time", roundMs: 3600_000, errNote: "METAR archive unavailable" },
};
/** Reference layers that don't change with time (kept in history mode). */
const STATIC = new Set(["wfo", "airports", "nwr", "search"]);

export function histFeedFor(def: OverlayDef | undefined) {
  if (!def) return undefined;
  return HIST_FEEDS[def.id] ?? HIST_FEEDS[def.feed ?? ""];
}

/** Can this overlay be shown in history mode? (imported files: yes) */
export function histAllowed(id: string): boolean {
  if (id.startsWith("file:")) return true;
  const def = OVERLAYS.find((d) => d.id === id);
  return STATIC.has(id) || !!histFeedFor(def);
}

/** Names of the overlays switched on that history mode hides. */
export const hiddenLive = computed(() => {
  return OVERLAYS.filter((d) => settings.value.ovl[d.id]?.on && !histAllowed(d.id)).map((d) => d.name);
});

// ---------- replay feeds (fetched once per window) ----------
const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + "Z";
const feedCache = new Map<string, Promise<any>>();

/** A history feed for the current window (cached). `valid` feeds take the frame time instead. */
export function histFeed(feed: string, at?: number, param: "valid" | "time" = "valid"): Promise<any> {
  const h = histRange.value;
  if (!h) return Promise.resolve({ type: "FeatureCollection", features: [] });
  const q = at != null ? (param === "time" ? `time=${at}` : `valid=${iso(at)}`) : `sts=${iso(h.start)}&ets=${iso(h.end)}`;
  const k = `${feed}?${q}`;
  let p = feedCache.get(k);
  if (!p) {
    p = api.get(`/api/ovl/${feed}?${q}`).catch((e) => {
      feedCache.delete(k);
      throw e;
    });
    feedCache.set(k, p);
    if (feedCache.size > 60) feedCache.delete(feedCache.keys().next().value!);
  }
  return p;
}

/** Replay status for the timeline badge. */
export const replayState = signal<{ warnings: number; loading: boolean; error?: string }>({ warnings: 0, loading: false });
const sbw = signal<any[] | null>(null);

let sbwKey = "";
effect(() => {
  const h = histRange.value;
  const k = h && api.base ? `${h.start}-${h.end}` : "";
  if (k === sbwKey) return;
  sbwKey = k;
  sbw.value = null;
  if (!k) return;
  replayState.value = { warnings: 0, loading: true };
  histFeed("sbwhist").then(
    (fc) => {
      if (sbwKey !== k) return;
      const fs = (fc.features ?? []).filter((f: any) => f.geometry && f.properties?.t0 != null).map((f: any) => decorateAlert(f));
      sbw.value = fs;
      replayState.value = { warnings: fs.length, loading: false };
    },
    (e) => {
      if (sbwKey !== k) return;
      sbw.value = [];
      replayState.value = { warnings: 0, loading: false, error: e.message };
    },
  );
});

// warnings in effect at the frame time replace the live alerts (same map styling and panels)
let shownIds: string | null = null;
effect(() => {
  const h = histRange.value;
  const list = sbw.value;
  const T = histTime.value;
  if (!h) {
    if (shownIds !== null) setReplayAlerts(null);
    shownIds = null;
    return;
  }
  const act = (list ?? []).filter((f) => f.properties.t0 <= T && T < f.properties.t1);
  const ids = act.map((f) => f.properties.id).join(",");
  if (ids === shownIds) return;
  shownIds = ids;
  setReplayAlerts(act);
});

// ---------- Level III has no archive: use Level II while in history mode ----------
let savedL3: { product: string; tiltAngle: number } | null = null;
let wasOn = false;
effect(() => {
  const on = !!histRange.value;
  if (on === wasOn) return;
  wasOn = on;
  const r = settings.peek().radar;
  if (on && r.source === "L3") {
    const p = l3Products.peek().find((x) => x.id === r.product);
    savedL3 = { product: r.product, tiltAngle: r.tiltAngle };
    const moment = p && L2_MOMENTS.some((m) => m.id === p.cmap) ? p.cmap : "REF";
    update((s) => {
      s.radar.source = "L2";
      s.radar.product = moment;
      s.radar.tiltAngle = p?.tilt ?? s.radar.tiltAngle;
    });
    toast("Level III has no archive: using Level II", "info");
  } else if (!on && savedL3) {
    const sv = savedL3;
    savedL3 = null;
    if (settings.peek().radar.source === "L2")
      update((s) => {
        s.radar.source = "L3";
        s.radar.product = sv.product;
        s.radar.tiltAngle = sv.tiltAngle;
      });
  }
});

// ---------- history 0.6: the whole event behind a replayed warning segment ----------
/** Issue/expire of the event a (replayed or live) alert belongs to: all replayed segments of the
 * same VTEC event, else the alert's own times. */
export function alertSpan(p: any): { start: number; end: number } {
  const t = (v: any) => (typeof v === "number" ? v : v ? Date.parse(v) : NaN);
  let start = [p.t0, p.onset, p.effective, p.sent].map(t).find((x) => Number.isFinite(x)) ?? Date.now();
  let end = [p.ends, p.expires, p.t1].map(t).find((x) => Number.isFinite(x)) ?? start + 3600_000;
  const vid = p.vtec_id;
  if (vid && sbw.peek())
    for (const f of sbw.peek()!) {
      if (f.properties.vtec_id !== vid) continue;
      start = Math.min(start, f.properties.t0);
      end = Math.max(end, f.properties.t1);
    }
  return { start, end: Math.max(end, start + 60_000) };
}
