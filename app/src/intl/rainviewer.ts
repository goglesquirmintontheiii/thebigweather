// 0.8.3: RainViewer single-site radars (Australia, New Zealand, Japan, Korea, Russia, …) on the map
// as radar sites: a distinct marker per radar (only those in view; none where Stormiq already has
// the radar natively), click → its recent images animate as a georeferenced image overlay through
// the international radar layer (`rv_<id>` sources, fetched one at a time from the server).

import { signal, effect } from "@preact/signals";
import * as maplibregl from "maplibre-gl";
import { api } from "../api";
import { settings, toast } from "../store";
import { sites } from "../radar/controller";
import { intlMap, intlSource, loadIntlSource, selectIntl } from "./radar";
import { hiddenRegions } from "./sites";
import { rvRadars, rvVisible, type RvRadar } from "./rvcore";
import "./rainviewer.css";

export { rvRadars, type RvRadar } from "./rvcore";

export const rvError = signal<string | null>(null);
const busy = signal<string | null>(null);

let loadedAt = 0;
let loading: Promise<void> | null = null;
export function loadRvRadars(force = false): Promise<void> {
  if (!api.base) return Promise.resolve();
  if (loading) return loading;
  if (!force && Date.now() - loadedAt < 30 * 60_000 && rvRadars.value.length) return Promise.resolve();
  loading = api
    .get<{ radars: RvRadar[]; error?: string | null }>("/api/rainviewer/radars")
    .then((r) => {
      loadedAt = Date.now();
      rvRadars.value = (r.radars ?? []).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      rvError.value = r.error ?? null;
    })
    .catch((e) => {
      // an older server has no RainViewer: stay quiet
      rvError.value = e?.message ?? String(e);
      loadedAt = Date.now();
    })
    .finally(() => (loading = null));
  return loading;
}

/** Show one RainViewer radar (fetches its frames, then selects it as an international radar). */
export async function selectRv(r: RvRadar) {
  const id = r.source || `rv_${r.id}`;
  busy.value = id;
  try {
    await loadIntlSource(id);
    selectIntl(id);
  } catch (e: any) {
    toast(`${r.name || r.id}: ${e?.message ?? e}`, "warn");
  } finally {
    busy.value = null;
  }
}

// ---------- markers ----------

const markers = new Map<string, maplibregl.Marker>();
const viewTick = signal(0);

function el(r: RvRadar): HTMLElement {
  const b = document.createElement("button");
  b.className = "site-marker intl-site rv-site";
  b.textContent = r.id;
  b.title = `${r.name || r.id}${r.state ? `, ${r.state}` : ""}${r.country_name ? ` · ${r.country_name}` : ""} (${r.id}) · RainViewer`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    selectRv(r);
  });
  return b;
}

let hooked = false;
effect(() => {
  const m = intlMap.value;
  const on = settings.value.overlays.sites;
  const list = rvRadars.value;
  void viewTick.value;
  const w = settings.value.weather;
  const sel = w.kind === "intl" ? w.id : "";
  const wait = busy.value;
  if (!m) return;
  if (!hooked) {
    hooked = true;
    m.on("moveend", () => viewTick.value++);
  }
  if (on && !loadedAt) loadRvRadars();
  const b = m.getBounds();
  const shown = on ? rvVisible(list, { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }, sites.peek(), hiddenRegions(), sel) : [];
  const ids = new Set(shown.map((r) => r.source));
  for (const [id, mk] of markers) if (!ids.has(id)) (mk.remove(), markers.delete(id));
  for (const r of shown) {
    let mk = markers.get(r.source);
    if (!mk) {
      mk = new maplibregl.Marker({ element: el(r), anchor: "center" }).setLngLat([r.lon, r.lat]).addTo(m);
      markers.set(r.source, mk);
    }
    const e = mk.getElement();
    e.classList.toggle("selected", sel === r.source);
    e.classList.toggle("loading", wait === r.source);
  }
});

// a RainViewer radar picked in an earlier session: its frames aren't in the full list
effect(() => {
  const w = settings.value.weather;
  if (w.kind === "intl" && w.id.startsWith("rv_") && api.base && !intlSource(w.id) && busy.peek() !== w.id) {
    busy.value = w.id;
    loadIntlSource(w.id)
      .catch((e) => console.warn("RainViewer radar", e))
      .finally(() => (busy.value = null));
  }
});

api.on("connected", () => {
  if (settings.value.overlays.sites) loadRvRadars(true);
});

(window as any).__tbwRv = { rvRadars, loadRvRadars, selectRv };
