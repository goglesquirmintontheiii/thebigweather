// radio/dash 0.8: "Seismic events" layer — shaking the server detected across Raspberry Shake
// stations (/api/ovl/shakeevents?min_ml&min_stations&hours → {t, lat?, lon?, stations, max_amp,
// est_ml?, usgs_id?, kind: "usgs"|"local"}), optionally with lines to the stations that recorded
// it. Click: the Seismographs viewer opens at that time with those stations compared. Toggled and
// configured from the Seismographs window (and Layers → Hazards). Imported once from App.tsx.

import type { LayerSpecification } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef } from "./defs";
import { settings } from "../store";
import { isOn, refreshOverlay } from "./manager";
import { loadStations, openShakeAt, staKey, type ShakeSta } from "../shake";

const font = ["Noto Sans Regular"];
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };

let staMap: Map<string, ShakeSta> | null = null;
let staLoading = false;
function stations(): Map<string, ShakeSta> | null {
  if (staMap || staLoading) return staMap;
  staLoading = true;
  loadStations()
    .then((all) => {
      staMap = new Map(all.flatMap((s) => [[staKey(s), s] as [string, ShakeSta], [s.sta, s] as [string, ShakeSta]]));
      if (isOn("shakeevents")) refreshOverlay("shakeevents");
    })
    .catch(() => (staLoading = false));
  return null;
}

/** a station entry → {key, lon, lat, amp?, t?} */
function staOf(x: any): { key: string; lon: number; lat: number; amp?: number; t?: number } | null {
  const key = typeof x === "string" ? x : x?.net && x?.sta ? `${x.net}.${x.sta}` : String(x?.id ?? x?.key ?? x?.sta ?? "");
  let lon = typeof x === "object" ? +x?.lon : NaN;
  let lat = typeof x === "object" ? +x?.lat : NaN;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    const s = stations()?.get(key) ?? stations()?.get(key.split(".").pop() ?? "");
    if (!s) return null;
    lon = s.lon;
    lat = s.lat;
  }
  return { key, lon, lat, amp: typeof x === "object" ? x?.amp ?? x?.max_amp : undefined, t: typeof x === "object" ? x?.t : undefined };
}

export function prepareShakeEvents(raw: any, o: Record<string, string>) {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : (raw?.features ?? []).map((f: any) => ({ ...(f.properties ?? {}), ...(f.geometry?.type === "Point" ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : {}) }));
  const feats: any[] = [];
  const lines = o.lines !== "off";
  const now = Date.now();
  list.forEach((e, i) => {
    const t = typeof e.t === "number" ? e.t : Date.parse(e.t);
    const sts = (Array.isArray(e.stations) ? e.stations : []).map(staOf).filter(Boolean) as NonNullable<ReturnType<typeof staOf>>[];
    let lon = +e.lon, lat = +e.lat, approx = 0;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      if (!sts.length) return;
      // no location: the middle of the stations that felt it
      lon = sts.reduce((a, s) => a + s.lon, 0) / sts.length;
      lat = sts.reduce((a, s) => a + s.lat, 0) / sts.length;
      approx = 1;
    }
    const ml = Number.isFinite(+e.est_ml) ? +e.est_ml : null;
    const id = e.id ?? e.usgs_id ?? `ev${i}-${t}`;
    const props = {
      _k: "ev",
      id,
      t,
      age_h: (now - t) / 3600_000,
      est_ml: ml,
      max_amp: e.max_amp ?? null,
      n: e.stations?.length ?? sts.length,
      kind: e.kind ?? (e.usgs_id ? "usgs" : "local"),
      usgs_id: e.usgs_id ?? "",
      place: e.place ?? "",
      approx,
      _lbl: ml != null ? `M${ml.toFixed(1)}` : `${e.stations?.length ?? sts.length} sta`,
      _sz: ml != null ? ml : Math.min(4, Math.log10(Math.max(10, +e.max_amp || 10)) - 0.5),
      _stations: JSON.stringify(e.stations ?? []),
    };
    feats.push({ type: "Feature", id: i, geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
    if (lines)
      for (const s of sts) {
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[lon, lat], [s.lon, s.lat]] }, properties: { _k: "ln", kind: props.kind, ev: id } });
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { _k: "st", kind: props.kind, ev: id, sta: s.key } });
      }
  });
  return { type: "FeatureCollection", features: feats, _count: list.length };
}

const COLOR: any = ["match", ["get", "kind"], "usgs", "#fb923c", "#c084fc"];

export const shakeEventsDef: OverlayDef = {
  id: "shakeevents",
  name: "Seismic events (Shake network)",
  group: "Hazards",
  refresh: 120,
  options: [
    { key: "min_ml", label: "Min. level", choices: [["0", "Any"], ["1", "M1+"], ["2", "M2+"], ["3", "M3+"], ["4", "M4+"]], def: "0" },
    { key: "min_stations", label: "Min. stations", choices: [["1", "1"], ["2", "2"], ["3", "3"], ["5", "5"], ["8", "8"]], def: "2" },
    { key: "hours", label: "Period", choices: [["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"]], def: "24" },
    { key: "lines", label: "Station lines", choices: [["on", "Show"], ["off", "Hide"]], def: "on" },
  ],
  style: { opacity: 0.9, size: 1, labels: true },
  prepare: prepareShakeEvents,
  layers: (s, st) =>
    [
      { id: `${s}-ln`, type: "line", source: s, filter: ["==", ["get", "_k"], "ln"], paint: { "line-color": COLOR, "line-width": 1.2, "line-opacity": st.opacity * 0.65, "line-dasharray": [2, 2] } },
      { id: `${s}-st`, type: "circle", source: s, filter: ["==", ["get", "_k"], "st"], paint: { "circle-radius": 3, "circle-color": "#1e1033", "circle-stroke-color": COLOR, "circle-stroke-width": 1.5, "circle-opacity": st.opacity } },
      {
        id: `${s}-halo`,
        type: "circle",
        source: s,
        filter: ["all", ["==", ["get", "_k"], "ev"], ["<", ["get", "age_h"], 1]],
        paint: { "circle-radius": ["*", st.size, ["interpolate", ["linear"], ["get", "_sz"], 0, 10, 3, 18, 6, 32]], "circle-color": COLOR, "circle-opacity": 0.18, "circle-stroke-width": 0 },
      },
      {
        id: `${s}-ev`,
        type: "circle",
        source: s,
        filter: ["==", ["get", "_k"], "ev"],
        paint: {
          "circle-radius": ["*", st.size, ["interpolate", ["linear"], ["get", "_sz"], 0, 4, 3, 9, 6, 18]],
          "circle-color": COLOR,
          "circle-opacity": ["*", st.opacity, ["interpolate", ["linear"], ["get", "age_h"], 0, 0.95, 24, 0.55, 168, 0.3]],
          "circle-stroke-color": ["case", ["==", ["get", "approx"], 1], "#fff", "#000"],
          "circle-stroke-width": ["case", ["==", ["get", "approx"], 1], 1.5, 1],
        },
      },
      ...(st.labels ? [{ id: `${s}-lbl`, type: "symbol", source: s, filter: ["==", ["get", "_k"], "ev"], layout: { "text-field": ["get", "_lbl"], "text-font": font, "text-size": 10.5, "text-offset": [0, 1.25], "text-anchor": "top", "text-optional": true }, paint: halo }] : []),
    ] as LayerSpecification[],
  click: (p) => {
    if (p._k !== "ev") return { title: p.sta ? `Station ${p.sta}` : "Seismograph", sub: "Recorded this event" };
    let sts: any[] = [];
    try {
      sts = JSON.parse(p._stations || "[]");
    } catch {
      /* */
    }
    const t = +p.t;
    openShakeAt(t, sts);
    const when = new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });
    return {
      title: p.est_ml != null && p.est_ml !== "" ? `M${(+p.est_ml).toFixed(1)} seismic event` : "Seismic event",
      sub: p.kind === "usgs" ? `Matched to USGS ${p.usgs_id}` : `Local detection${p.approx ? " (no location: shown between the stations)" : ""}`,
      color: p.kind === "usgs" ? "#fb923c" : "#c084fc",
      rows: [
        ["Time", when],
        ["Stations", `${p.n}`],
        ["Max amplitude", p.max_amp != null && p.max_amp !== "" ? `${Math.round(+p.max_amp).toLocaleString()} counts` : "—"],
        ...(p.place ? [["Place", String(p.place)] as [string, string]] : []),
      ],
      ...(p.usgs_id ? { link: ["USGS event page", `https://earthquake.usgs.gov/earthquakes/eventpage/${p.usgs_id}`] as [string, string] } : {}),
      text: "Opened in the Seismographs viewer with these stations compared.",
    };
  },
  note: "Shaking detected by the server across Raspberry Shake stations: orange = matched to a USGS earthquake, violet = local detections (white ring = no location, drawn between the stations). Click one to open its seismograms. Detection runs on the server.",
};

if (!overlayDef("shakeevents")) {
  let i = OVERLAYS.findIndex((o) => o.id === "shake");
  if (i < 0) i = OVERLAYS.findIndex((o) => o.id === "quakes");
  OVERLAYS.splice(i < 0 ? OVERLAYS.length : i + 1, 0, shakeEventsDef);
}

(window as any).__tbwP8a = { prepareShakeEvents };
