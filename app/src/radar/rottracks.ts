// radar 0.6: rotation tracks. The server's rotation detector is run on every Level II volume of the
// loop (one request at a time, cached per volume key); detections are linked frame to frame
// (within ~10 km per 5 min, gaps up to 12 min) into tracks coloured by rotational velocity.

import { effect, signal } from "@preact/signals";
import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { settings } from "../store";
import { setData, ovlStatus } from "../overlays/manager";
import { frames } from "./controller";
import { rotationFor } from "./r6data";
import { distance, speedFactor } from "../util";
import type { Style, Popup } from "../overlays/defs";

const on = () => !!settings.value.ovl.rottracks?.on;
const status = (s: { loading?: boolean; error?: string; count?: number; note?: string }) => (ovlStatus.value = { ...ovlStatus.value, rottracks: s });

interface Det {
  lon: number;
  lat: number;
  t: number;
  vrot: number;
  kind: string;
}
export interface RotTrack {
  id: number;
  pts: Det[];
  maxV: number;
  tvs: number;
}
export const rotTracks = signal<RotTrack[]>([]);

const RANK: Record<string, number> = { weak: 0, meso: 1, tvs: 2 };

/** Greedy frame-to-frame linking. */
export function linkTracks(perFrame: { t: number; dets: Det[] }[]): RotTrack[] {
  const tracks: RotTrack[] = [];
  let id = 0;
  for (const fr of perFrame.sort((a, b) => a.t - b.t)) {
    const used = new Set<RotTrack>();
    for (const d of fr.dets.slice().sort((a, b) => b.vrot - a.vrot)) {
      let best: RotTrack | null = null;
      let bd = Infinity;
      for (const tr of tracks) {
        if (used.has(tr)) continue;
        const last = tr.pts[tr.pts.length - 1];
        const dt = d.t - last.t;
        if (dt <= 0 || dt > 12 * 60_000) continue;
        const lim = 10_000 * Math.max(1, dt / 300_000);
        const dist = distance(last.lat, last.lon, d.lat, d.lon);
        if (dist <= lim && dist < bd) (bd = dist), (best = tr);
      }
      if (best) {
        best.pts.push(d);
        best.maxV = Math.max(best.maxV, d.vrot);
        if (d.kind === "tvs") best.tvs++;
        used.add(best);
      } else {
        const tr = { id: ++id, pts: [d], maxV: d.vrot, tvs: d.kind === "tvs" ? 1 : 0 };
        tracks.push(tr);
        used.add(tr);
      }
    }
  }
  return tracks;
}

function fc(tracks: RotTrack[]) {
  const k = speedFactor();
  const u = settings.value.units.speed;
  const feats: any[] = [];
  for (const tr of tracks) {
    const props = { id: tr.id, maxV: tr.maxV, n: tr.pts.length, tvs: tr.tvs, t0: tr.pts[0].t, t1: tr.pts[tr.pts.length - 1].t, len: tr.pts.reduce((a, p, i) => (i ? a + distance(tr.pts[i - 1].lat, tr.pts[i - 1].lon, p.lat, p.lon) : 0), 0) };
    for (let i = 1; i < tr.pts.length; i++) {
      const a = tr.pts[i - 1], b = tr.pts[i];
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }, properties: { ...props, v: Math.max(a.vrot, b.vrot) } });
    }
    tr.pts.forEach((p, i) => {
      const end = i === tr.pts.length - 1;
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { ...props, v: p.vrot, kind: p.kind, end: end ? 1 : 0, _lbl: end && tr.pts.length > 1 ? `max ${Math.round(tr.maxV * k)} ${u}` : "" } });
    });
  }
  return { type: "FeatureCollection", features: feats };
}

let gen = 0;
let sig = "";
async function build() {
  const g = ++gen;
  const min = RANK[settings.value.ovl.rottracks?.opts?.min ?? "meso"] ?? 1;
  const fs = frames.value.slice();
  const per: { t: number; dets: Det[] }[] = [];
  let done = 0, errs = 0;
  status({ loading: true, note: `0/${fs.length} scans` });
  // newest first, one request at a time
  for (const f of [...fs].reverse()) {
    if (g !== gen || !on()) return;
    try {
      const r = await rotationFor(f.key);
      const t = r.t ?? f.time;
      per.push({
        t,
        dets: (r.features ?? [])
          .filter((x: any) => (RANK[x.properties?.kind] ?? 0) >= min)
          .map((x: any) => ({ lon: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], t: x.properties?.t ?? t, vrot: x.properties?.vrot ?? 0, kind: x.properties?.kind ?? "weak" })),
      });
    } catch {
      errs++;
    }
    done++;
    if (g !== gen) return;
    if (done % 3 === 0 || done === fs.length) {
      const tr = linkTracks(per.map((p) => ({ ...p, dets: p.dets.map((d) => ({ ...d })) })));
      rotTracks.value = tr;
      setData("rottracks", fc(tr));
      status({ loading: done < fs.length, count: tr.length, note: `${tr.filter((x) => x.pts.length > 1).length} tracks · ${done}/${fs.length} scans${errs ? ` · ${errs} failed` : ""}` });
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

let timer: number | undefined;
effect(() => {
  const active = on();
  const src = settings.value.radar.source;
  const s = `${frames.value.map((f) => f.key).join(",")}|${settings.value.ovl.rottracks?.opts?.min ?? ""}|${settings.value.units.speed}`;
  if (!active) {
    gen++;
    sig = "";
    rotTracks.value = [];
    return;
  }
  if (src !== "L2") {
    setData("rottracks", { type: "FeatureCollection", features: [] });
    status({ note: "Level II only" });
    return;
  }
  if (s === sig) return;
  sig = s;
  clearTimeout(timer);
  timer = window.setTimeout(build, 500);
});

const VCOL: ExpressionSpecification = ["step", ["get", "v"], "#9ca3af", 10, "#facc15", 15, "#fb923c", 20, "#ef4444", 25, "#e11d48", 30, "#d946ef", 40, "#ffffff"];
export function rotTrackLayers(s: string, st: Style): LayerSpecification[] {
  return [
    { id: `${s}-casing`, type: "line", source: s, filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": 7 * st.size, "line-opacity": 0.55 * st.opacity } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": VCOL, "line-width": ["interpolate", ["linear"], ["get", "v"], 10, 3 * st.size, 35, 6 * st.size], "line-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["case", ["==", ["get", "end"], 1], 5.5 * st.size, 3 * st.size], "circle-color": VCOL, "circle-stroke-color": ["case", ["==", ["get", "kind"], "tvs"], "#ff2d2d", "#000"], "circle-stroke-width": ["case", ["==", ["get", "kind"], "tvs"], 2.2, 1], "circle-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "end"], 1]], layout: { "text-field": ["get", "_lbl"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.5 } } as LayerSpecification]
      : []),
  ];
}

export function rotTrackClick(p: any): Popup {
  const k = speedFactor();
  const u = settings.value.units.speed;
  const tf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });
  const mi = settings.value.units.distance !== "km";
  const len = +p.len / 1000;
  return {
    title: `Rotation track #${p.id}`,
    sub: `${p.n} detections${+p.tvs ? ` · ${p.tvs} TVS` : ""}`,
    color: "#ef4444",
    rows: [
      ["Max rotational vel.", `${Math.round(+p.maxV * k)} ${u}`],
      ["This point", `${Math.round(+p.v * k)} ${u}${p.kind ? ` · ${String(p.kind).toUpperCase()}` : ""}`],
      ["Time", `${tf(+p.t0)} – ${tf(+p.t1)}`],
      ["Length", mi ? `${(len / 1.609).toFixed(1)} mi` : `${len.toFixed(1)} km`],
    ],
  };
}
