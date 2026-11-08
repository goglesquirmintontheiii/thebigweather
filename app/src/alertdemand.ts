// 0.8.2: tells the server which Canada / international alert sources this app wants. The server
// only fetches sources someone asked for (Canada while its switch is on; international ones while
// the map looks at that country or the International alerts tab is open).

import { signal, effect } from "@preact/signals";
import { api } from "./api";
import { settings, connection } from "./store";
import { mapRef } from "./map/mapview";
import { sourcesInView, type BBox, type SrcInfo } from "./alertlist";
import { regionOn } from "./alertstyle";

export interface AlertSource extends SrcInfo {
  name: string;
  country: string;
  attribution: string;
  url: string;
  active?: boolean;
  count?: number;
  error?: string | null;
  age_s?: number | null;
}

/** sources the server offers (empty on servers older than 0.8.2) */
export const alertSources = signal<AlertSource[]>([]);
/** the Alerts tab shows International (asks for every international source) */
export const intlTabOpen = signal(false);

let started = false;
let lastSent = "";
let lastAt = 0;
let timer: number | undefined;

async function loadSources() {
  try {
    const r = await api.get("/api/alerts/sources");
    alertSources.value = r.sources ?? [];
  } catch {
    alertSources.value = [];
  }
}

function wanted(): string[] {
  const out: string[] = [];
  if (regionOn("ca") && alertSources.peek().some((s) => s.region === "ca")) out.push("ca");
  if (!regionOn("intl")) return out;
  if (intlTabOpen.peek()) return [...out, "intl"];
  const m = mapRef.peek();
  if (m) {
    const b = m.getBounds();
    const view: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    out.push(...sourcesInView(alertSources.peek(), view));
  }
  return out;
}

/** Send the wish list when it changed, and every 4 minutes while anything is wanted. */
export function pingAlertDemand(force = false) {
  if (connection.peek() !== "online") return;
  const w = wanted();
  const sig = w.join(",");
  if (!w.length) {
    lastSent = sig;
    return;
  }
  if (!force && sig === lastSent && Date.now() - lastAt < 240_000) return;
  lastSent = sig;
  lastAt = Date.now();
  api.send("POST", "/api/alerts/want", { sources: w }).catch(() => {});
}

export function startAlertDemand() {
  if (started) return;
  started = true;
  api.on("connected", () => loadSources().then(() => pingAlertDemand(true)));
  if (connection.peek() === "online") loadSources().then(() => pingAlertDemand(true));
  window.setInterval(() => pingAlertDemand(), 60_000);
  let hooked: unknown = null;
  effect(() => {
    const m = mapRef.value;
    if (!m || hooked === m) return;
    hooked = m;
    m.on("moveend", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => pingAlertDemand(), 2500);
    });
  });
  effect(() => {
    void intlTabOpen.value;
    void settings.value.alertCfg.regions;
    pingAlertDemand();
  });
}

/** Refresh the source list (status, counts) — the International tab's footer. */
export const refreshAlertSources = loadSources;
