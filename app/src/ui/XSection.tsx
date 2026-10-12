// Vertical cross-section of the current Level II volume: pick two points on the map (draggable
// end handles), the server samples the volume along the line (GET /api/radar/xsection) and this
// panel draws it with the active colour table, height/distance axes and a hover readout.

import { signal, effect } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { settings, tool, toast } from "../store";
import { api } from "../api";
import { mapRef, mapClickHooks } from "../map/mapview";
import { currentFrame, activeTable } from "../radar/controller";
import { rasterize, TEX_SIZE, type ColorTable } from "../radar/colormaps";
import { distance, bearing, destination, fmtValue, fmtDist } from "../util";
import { FloatPanel } from "./FloatPanel";
import { RefreshCw } from "lucide-preact";

type LL = [number, number]; // lon, lat
export const xsLine = signal<[LL, LL] | null>(null);
const firstPt = signal<LL | null>(null);
interface XsData {
  nx: number;
  nz: number;
  dist_m: number;
  ztop: number;
  scale: number;
  offset: number;
  moment: string;
  time: number;
  site: string;
  data: Uint8Array;
}
const xsData = signal<XsData | null>(null);
const xsState = signal<{ loading?: boolean; error?: string }>({});
/** 0–1 position along the line under the mouse (dot on the map) */
const xsHover = signal<number | null>(null);

export function startXSection() {
  if (settings.value.weather.kind !== "radar" || settings.value.radar.source !== "L2") {
    toast("Cross-sections need a Level II radar layer", "warn");
    return;
  }
  firstPt.value = null;
  tool.value = tool.value === "xsect" ? "none" : "xsect";
  if (tool.value === "xsect") toast("Click two points on the map");
}

export function closeXSection() {
  xsLine.value = null;
  xsData.value = null;
  firstPt.value = null;
  if (tool.value === "xsect") tool.value = "none";
}

// ---------- map: picking, line, handles ----------
let markers: maplibregl.Marker[] = [];
function handle(map: MLMap, i: 0 | 1, ll: LL) {
  const el = document.createElement("div");
  el.className = "xs-handle";
  el.textContent = i ? "B" : "A";
  const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(ll).addTo(map);
  m.on("drag", () => {
    const l = xsLine.value;
    if (!l) return;
    const p = m.getLngLat();
    const nl: [LL, LL] = [l[0], l[1]];
    nl[i] = [p.lng, p.lat];
    xsLine.value = nl;
  });
  return m;
}

function ensureLayers(map: MLMap) {
  if (!map.getSource("xs-line")) {
    map.addSource("xs-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "xs-line-case", type: "line", source: "xs-line", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#000", "line-width": 5, "line-opacity": 0.6 } });
    map.addLayer({ id: "xs-line", type: "line", source: "xs-line", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#fff", "line-width": 2.2, "line-dasharray": [3, 1.5] } });
    map.addLayer({ id: "xs-dot", type: "circle", source: "xs-line", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": "#facc15", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
  }
}

function drawMap() {
  const map = mapRef.value;
  if (!map || !(map as any).style?._loaded) return;
  ensureLayers(map);
  const l = xsLine.value;
  const f = firstPt.value;
  const feats: any[] = [];
  if (l) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: l }, properties: {} });
  const h = xsHover.value;
  if (l && h != null) {
    const d = distance(l[0][1], l[0][0], l[1][1], l[1][0]);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: destination(l[0][1], l[0][0], bearing(l[0][1], l[0][0], l[1][1], l[1][0]), d * h) }, properties: {} });
  } else if (!l && f) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: f }, properties: {} });
  (map.getSource("xs-line") as GeoJSONSource).setData({ type: "FeatureCollection", features: feats });
}

let hooked = false;
function hook() {
  const map = mapRef.value;
  if (!map || hooked) return;
  hooked = true;
  map.on("style.load", () => drawMap());
  mapClickHooks.push((e) => {
    if (tool.value !== "xsect") return false;
    const p: LL = [e.lngLat.lng, e.lngLat.lat];
    if (!firstPt.value) {
      firstPt.value = p;
      return true;
    }
    xsLine.value = [firstPt.value, p];
    firstPt.value = null;
    tool.value = "none";
    return true;
  });
}

effect(() => {
  const map = mapRef.value;
  if (!map) return;
  hook();
  const l = xsLine.value;
  void firstPt.value;
  void xsHover.value;
  drawMap();
  // handles follow the line (created once, moved while dragging)
  if (!l) {
    markers.forEach((m) => m.remove());
    markers = [];
  } else if (!markers.length) markers = [handle(map, 0, l[0]), handle(map, 1, l[1])];
  else {
    markers[0].setLngLat(l[0]);
    markers[1].setLngLat(l[1]);
  }
});
effect(() => {
  const map = mapRef.value;
  if (tool.value !== "xsect") firstPt.value = null;
  else if (map) map.getCanvas().style.cursor = "crosshair";
});

// ---------- data ----------
let timer: number | undefined;
let ctrl: AbortController | null = null;
effect(() => {
  const l = xsLine.value;
  const f = currentFrame.value;
  const product = settings.value.radar.product;
  const src = settings.value.radar.source;
  clearTimeout(timer);
  if (!l) return;
  if (src !== "L2") {
    xsState.value = { error: "Needs a Level II radar" };
    return;
  }
  if (!f?.key) {
    xsState.value = { error: "No radar volume loaded" };
    return;
  }
  timer = window.setTimeout(async () => {
    ctrl?.abort();
    ctrl = new AbortController();
    xsState.value = { loading: true };
    const ztop = 18000;
    const q = new URLSearchParams({ key: f.key, moment: product, lat1: l[0][1].toFixed(5), lon1: l[0][0].toFixed(5), lat2: l[1][1].toFixed(5), lon2: l[1][0].toFixed(5), nx: "400", nz: "120", ztop: String(ztop) });
    try {
      const buf = await api.bin(`/api/radar/xsection?${q}`, ctrl.signal);
      const dv = new DataView(buf);
      const hl = dv.getUint32(0, true);
      const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
      xsData.value = { ...h, data: new Uint8Array(buf, 4 + hl, h.nx * h.nz) };
      xsState.value = {};
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      xsState.value = { error: e?.message ?? String(e) };
    }
  }, 200);
});

// ---------- panel ----------
const kft = () => settings.value.units.distance !== "km";

function niceTicks(max: number, want: number) {
  const raw = max / want;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

function valueOf(d: XsData, raw: number, t: ColorTable): number {
  if (raw === 0) return NaN;
  if (raw === 1 && t.rf) return -9999;
  return (raw - d.offset) / (d.scale || 1);
}

const ML = 44, MB = 26, MT = 8, MR = 10;

export function XSection() {
  const l = xsLine.value;
  const d = xsData.value;
  const st = xsState.value;
  const t = activeTable.value;
  const cv = useRef<HTMLCanvasElement>(null);
  const [hov, setHov] = useState<{ x: number; y: number; text: string } | null>(null);
  const [size] = useState<[number, number]>([560, 260]);
  void settings.value.units;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const [W, H] = size;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pw = W - ML - MR, ph = H - MT - MB;
    ctx.fillStyle = "#0a0d12";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#11161d";
    ctx.fillRect(ML, MT, pw, ph);
    if (!d) return;
    // section image
    const lut = rasterize(t);
    const img = new ImageData(d.nx, d.nz);
    for (let z = 0; z < d.nz; z++)
      for (let x = 0; x < d.nx; x++) {
        const raw = d.data[z * d.nx + x];
        const o = ((d.nz - 1 - z) * d.nx + x) * 4;
        const v = valueOf(d, raw, t);
        if (Number.isNaN(v)) continue;
        if (v === -9999) {
          const rf = t.rf!;
          img.data.set([rf[0], rf[1], rf[2], rf[3]], o);
          continue;
        }
        const k = Math.max(0, Math.min(TEX_SIZE - 1, Math.floor(((v - t.min) / (t.max - t.min)) * TEX_SIZE)));
        img.data[o] = lut[k * 4];
        img.data[o + 1] = lut[k * 4 + 1];
        img.data[o + 2] = lut[k * 4 + 2];
        img.data[o + 3] = lut[k * 4 + 3];
      }
    const tmp = document.createElement("canvas");
    tmp.width = d.nx;
    tmp.height = d.nz;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, ML, MT, pw, ph);
    // axes
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.fillStyle = "#9aa6b5";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.lineWidth = 1;
    const hMax = kft() ? (d.ztop / 0.3048) / 1000 : d.ztop / 1000;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of niceTicks(hMax, 5)) {
      const y = MT + ph - (v / hMax) * ph;
      ctx.beginPath();
      ctx.moveTo(ML, y + 0.5);
      ctx.lineTo(ML + pw, y + 0.5);
      ctx.stroke();
      ctx.fillText(String(v), ML - 5, y);
    }
    ctx.save();
    ctx.translate(10, MT + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(kft() ? "kft" : "km", 0, 0);
    ctx.restore();
    const u = settings.value.units.distance;
    const f = u === "km" ? 1000 : u === "mi" ? 1609.344 : 1852;
    const dMax = d.dist_m / f;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const v of niceTicks(dMax, 6)) {
      const x = ML + (v / dMax) * pw;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, MT + ph);
      ctx.lineTo(x + 0.5, MT + ph + 4);
      ctx.stroke();
      ctx.fillText(String(Math.round(v * 10) / 10), x, MT + ph + 6);
    }
    ctx.textAlign = "left";
    ctx.fillText("A", ML, MT + ph + 15);
    ctx.textAlign = "right";
    ctx.fillText(`${u}   B`, ML + pw, MT + ph + 15);
  }, [d, t, size, settings.value.units.distance]);
  if (!l && tool.value !== "xsect") return null;
  if (!l) return null;
  const onMove = (e: MouseEvent) => {
    if (!d) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const pw = size[0] - ML - MR, ph = size[1] - MT - MB;
    const fx = (x - ML) / pw, fz = 1 - (y - MT) / ph;
    if (fx < 0 || fx > 1 || fz < 0 || fz > 1) {
      setHov(null);
      xsHover.value = null;
      return;
    }
    const ix = Math.min(d.nx - 1, Math.floor(fx * d.nx)), iz = Math.min(d.nz - 1, Math.floor(fz * d.nz));
    const v = valueOf(d, d.data[iz * d.nx + ix], t);
    const hm = fz * d.ztop;
    const hs = kft() ? `${((hm / 0.3048) / 1000).toFixed(1)} kft` : `${(hm / 1000).toFixed(1)} km`;
    setHov({ x, y, text: `${fmtValue(v, t.units, t.labels)} · ${hs} · ${fmtDist(fx * d.dist_m)}` });
    xsHover.value = fx;
  };
  const len = distance(l[0][1], l[0][0], l[1][1], l[1][0]);
  return (
    <FloatPanel
      cls="xs-panel"
      title={
        <>
          Cross-section <small class="muted">{d ? `${d.site} ${d.moment} · ${new Date(d.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined })}` : ""} · {fmtDist(len)}</small>
        </>
      }
      x={Math.max(8, window.innerWidth - size[0] - 80)}
      y={70}
      onClose={closeXSection}
      tools={
        <button class="icon-btn" title="Pick a new line" onClick={() => ((xsLine.value = null), startXSection())}>
          <RefreshCw size={13} />
        </button>
      }
    >
      <div class="xs-wrap" style={{ width: `${size[0]}px`, height: `${size[1]}px` }}>
        <canvas ref={cv} style={{ width: `${size[0]}px`, height: `${size[1]}px` }} onMouseMove={onMove as any} onMouseLeave={() => (setHov(null), (xsHover.value = null))} />
        {hov && (
          <div class="xs-tip" style={{ left: `${Math.min(hov.x + 10, size[0] - 180)}px`, top: `${Math.max(0, hov.y - 26)}px` }}>
            {hov.text}
          </div>
        )}
        {(st.loading || st.error || !d) && <div class={`xs-msg ${st.error ? "err" : ""}`}>{st.error ? st.error : "Loading…"}</div>}
      </div>
      <div class="muted small">Drag the A / B handles on the map to move the line.</div>
    </FloatPanel>
  );
}
