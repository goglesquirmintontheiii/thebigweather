// data 0.6: contours (isobars, isotherms, heights…) and wind barbs drawn as vector layers over the
// gridded weather layer. The server traces / thins them (/api/grid/contours, /api/grid/barbs); the
// app labels them in the user's units and follows the timeline frame. Barb glyphs (0–200 kt in
// 5 kt steps) are drawn once on a canvas and registered as map images ("wb-<kt>"), also used by
// the personal weather station layer.

import { signal, effect, computed } from "@preact/signals";
import type { Map as MLMap, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import { api } from "../api";
import { settings, update, DATA6_DEFAULTS, type Data6Settings } from "../store";
import { gridDef, gridLayers, type GridLayerDef } from "../weather";
import { activeTime } from "../active";
import { mapRef } from "../map/mapview";

export const linesStatus = signal<{ contours?: string; barbs?: string; loading?: boolean }>({});

export function d6(): Data6Settings {
  return { ...DATA6_DEFAULTS, ...(settings.value.data6 ?? {}) };
}
export function setD6(fn: (d: Data6Settings) => void) {
  update((s) => {
    const d = { ...DATA6_DEFAULTS, ...(s.data6 ?? {}) };
    fn(d);
    s.data6 = d;
  });
}

// ---------- barb glyphs ----------

const PR = 2; // pixel ratio of the glyphs
const SZ = 38; // css px

/** One barb, staff pointing up (wind from the north); rotate by the direction it blows from. */
function drawBarb(kt: number): ImageData {
  const n = SZ * PR;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.scale(PR, PR);
  g.strokeStyle = g.fillStyle = "#fff";
  g.lineWidth = 1.7;
  g.lineCap = "round";
  const cx = SZ / 2;
  const cy = SZ / 2;
  if (kt < 3) {
    g.beginPath();
    g.arc(cx, cy, 3.6, 0, Math.PI * 2);
    g.stroke();
    return g.getImageData(0, 0, n, n);
  }
  const top = 1.2;
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx, top);
  g.stroke();
  let left = Math.round(kt / 5) * 5;
  let y = top;
  const fl = 9.5; // feather length
  const step = 3.2;
  // pennants (50), full barbs (10), half barb (5) on the right of the staff (northern hemisphere)
  while (left >= 50) {
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + fl, y + 1.6);
    g.lineTo(cx, y + 4.2);
    g.closePath();
    g.fill();
    y += 5;
    left -= 50;
  }
  while (left >= 10) {
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + fl, y - 3);
    g.stroke();
    y += step;
    left -= 10;
  }
  if (left >= 5) {
    if (y === top) y += step; // a lone half barb sits a little in from the end
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + fl / 2, y - 1.5);
    g.stroke();
  }
  return g.getImageData(0, 0, n, n);
}

function drawArrow(): ImageData {
  const n = SZ * PR;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.scale(PR, PR);
  g.strokeStyle = g.fillStyle = "#fff";
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(SZ / 2, SZ - 4);
  g.lineTo(SZ / 2, 6);
  g.stroke();
  g.beginPath();
  g.moveTo(SZ / 2, 2);
  g.lineTo(SZ / 2 - 4.5, 9);
  g.lineTo(SZ / 2 + 4.5, 9);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, n, n);
}

const glyphs = new Map<string, ImageData>();
function glyph(id: string): ImageData | null {
  let im = glyphs.get(id);
  if (im) return im;
  if (id === "wb-arrow") im = drawArrow();
  else {
    const kt = +id.slice(3);
    if (!Number.isFinite(kt) || kt < 0 || kt > 200 || kt % 5) return null;
    im = drawBarb(kt);
  }
  glyphs.set(id, im);
  return im;
}

/** Register every barb glyph (and the arrow) on a map; missing ones are also added on demand. */
export function registerBarbs(m: MLMap) {
  for (let kt = 0; kt <= 200; kt += 5) {
    const id = `wb-${kt}`;
    if (!m.hasImage(id)) m.addImage(id, glyph(id)!, { pixelRatio: PR, sdf: true });
  }
  if (!m.hasImage("wb-arrow")) m.addImage("wb-arrow", glyph("wb-arrow")!, { pixelRatio: PR, sdf: true });
}
const hooked = new WeakSet<MLMap>();
export function hookBarbs(m: MLMap) {
  if (hooked.has(m)) return;
  hooked.add(m);
  m.on("styleimagemissing", (e: any) => {
    const id = String(e.id ?? "");
    if (!id.startsWith("wb-") || m.hasImage(id)) return;
    const im = glyph(id);
    if (im) m.addImage(id, im, { pixelRatio: PR, sdf: true });
  });
  m.on("style.load", () => registerBarbs(m));
  if (m.isStyleLoaded()) registerBarbs(m);
}
/** icon-image expression for a speed in knots (rounded to 5 kt, capped at 200) */
export const barbIcon = (kt: any): any => ["concat", "wb-", ["to-string", ["min", 200, ["*", 5, ["round", ["/", ["max", 0, ["to-number", kt, 0]], 5]]]]]];

// ---------- presets & units ----------

type Kind = "temp" | "pres" | "hgt" | "wind" | "precip" | "wave" | "other";
function kindOf(d: GridLayerDef | undefined): Kind {
  if (!d) return "other";
  const v = d.id.split("/").pop() ?? "";
  const u = d.units;
  if (u === "°C" || u === "K") return "temp";
  if (u === "hPa" || u === "mb" || v.includes("mslp")) return "pres";
  if (/^hgt|thick/.test(v) || (u === "m" && /height|thickness/i.test(d.name) && !/wave/i.test(d.name))) return "hgt";
  if (/wave|swell|htsgw|swh/i.test(`${v} ${d.name}`) && (u === "m" || u === "ft")) return "wave";
  if (u === "m/s" || u === "kt") return "wind";
  if (u === "mm") return "precip";
  return "other";
}

/** display value from a layer value */
export function toDisplay(d: GridLayerDef | undefined, x: number): number {
  const u = settings.value.units;
  switch (kindOf(d)) {
    case "temp":
      return u.temp === "F" ? (d?.units === "K" ? (x - 273.15) * 1.8 + 32 : x * 1.8 + 32) : d?.units === "K" ? x - 273.15 : x;
    case "wind":
      if (d?.units === "kt") return x;
      return u.speed === "kt" ? x * 1.94384 : u.speed === "mph" ? x * 2.23694 : u.speed === "km/h" ? x * 3.6 : x;
    case "precip":
      return u.precip === "in" ? x / 25.4 : x;
    case "hgt":
      return x / 10; // decametres
    case "wave":
      return u.distance === "km" ? x : x * 3.28084;
    default:
      return x;
  }
}
/** layer value from a display value (affine, so works for intervals with `delta`) */
function fromDisplay(d: GridLayerDef | undefined, x: number, delta: boolean): number {
  const u = settings.value.units;
  switch (kindOf(d)) {
    case "temp": {
      const k = d?.units === "K" ? 273.15 : 0;
      if (u.temp === "F") return delta ? x / 1.8 : (x - 32) / 1.8 + k;
      return delta ? x : x + k;
    }
    case "wind":
      if (d?.units === "kt") return x;
      return u.speed === "kt" ? x / 1.94384 : u.speed === "mph" ? x / 2.23694 : u.speed === "km/h" ? x / 3.6 : x;
    case "precip":
      return u.precip === "in" ? x * 25.4 : x;
    case "hgt":
      return x * 10;
    case "wave":
      return u.distance === "km" ? x : x / 3.28084;
    default:
      return x;
  }
}
export function displayUnit(d: GridLayerDef | undefined): string {
  const u = settings.value.units;
  switch (kindOf(d)) {
    case "temp":
      return `°${u.temp}`;
    case "wind":
      return u.speed;
    case "precip":
      return u.precip;
    case "hgt":
      return "dam";
    case "wave":
      return u.distance === "km" ? "m" : "ft";
    default:
      return d?.units ?? "";
  }
}

/** default interval / base in display units, or null to let the server choose */
export function preset(d: GridLayerDef | undefined): { interval: number; base: number } | null {
  const u = settings.value.units;
  const v = d?.id.split("/").pop() ?? "";
  switch (kindOf(d)) {
    case "pres":
      return { interval: 4, base: 1000 };
    case "hgt":
      return { interval: 6, base: 540 };
    case "temp":
      return u.temp === "F" ? { interval: 5, base: 32 } : { interval: v.includes("850") || v.includes("500") ? 5 : 2, base: 0 };
    case "wind":
      return u.speed === "m/s" ? { interval: 5, base: 0 } : u.speed === "km/h" ? { interval: 20, base: 0 } : { interval: 10, base: 0 };
    case "precip":
      return u.precip === "in" ? { interval: 0.25, base: 0 } : { interval: 5, base: 0 };
    case "wave":
      return u.distance === "km" ? { interval: 1, base: 0 } : { interval: 2, base: 0 };
  }
  if (d?.units === "%") return { interval: 20, base: 0 };
  if (d?.units === "J/kg") return { interval: 500, base: 0 };
  if (d?.units === "m²/s²") return { interval: 100, base: 0 };
  if (d?.units === "dBZ") return { interval: 10, base: 0 };
  if (d?.units === "s") return { interval: 2, base: 0 };
  return null;
}

const fmtNum = (x: number, step: number) => {
  const dp = step >= 1 || !step ? 0 : step >= 0.1 ? 1 : 2;
  return (Math.round(x * 10 ** dp) / 10 ** dp).toFixed(dp);
};

// ---------- what to draw ----------

/** current gridded layer and the contour field (same model) */
export const linesTarget = computed(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid") return null;
  const d = gridDef(w.id);
  if (!d || d.cmap === "RGB") return null;
  const o = d6();
  let cid = w.id;
  if (o.cfield && d.source === "model" && d.model) {
    const alt = `model/${d.model}/${o.cfield}`;
    if (gridLayers.value.some((l) => l.id === alt)) cid = alt;
  }
  /* data 0.8: severe parameter layers (svr/<src>/<param>) contour their siblings; barbs from the source model */
  if (w.id.startsWith("svr/")) {
    const src = w.id.split("/")[1];
    const alt = o.cfield ? `svr/${src}/${o.cfield}` : "";
    if (alt && gridLayers.value.some((l) => l.id === alt)) cid = alt;
    return { layer: d, cdef: gridDef(cid)!, model: d.model ?? src, wave: false, svr: true };
  }
  /* end data 0.8 */
  return { layer: d, cdef: gridDef(cid)!, model: d.source === "model" ? d.model : undefined, wave: !!d.model && /wave/.test(d.model), svr: false };
});

/** fields of the current model that can be contoured over it */
export function contourFields(): GridLayerDef[] {
  const t = linesTarget.value;
  if (t?.svr) return gridLayers.value.filter((l) => l.id.startsWith(`svr/${t.layer.id.split("/")[1]}/`)); // data 0.8
  if (!t?.model) return t ? [t.layer] : [];
  return gridLayers.value.filter((l) => l.model === t.model && l.cmap !== "RGB");
}

// ---------- map layers ----------

const EMPTY: any = { type: "FeatureCollection", features: [] };
let map: MLMap | null = null;
let cData: any = EMPTY;
let bData: any = EMPTY;

function before(m: MLMap): string | undefined {
  if (m.getLayer("ovl-counties")) return "ovl-counties";
  return m.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
}

function ensureLayers(m: MLMap) {
  if (!m.getStyle()) return;
  const o = d6();
  const b = before(m);
  if (!m.getSource("d6-contours")) m.addSource("d6-contours", { type: "geojson", data: cData });
  if (!m.getSource("d6-barbs")) m.addSource("d6-barbs", { type: "geojson", data: bData });
  const specs: LayerSpecification[] = [
    {
      id: "d6-cline",
      type: "line",
      source: "d6-contours",
      layout: { "line-join": "round", visibility: o.contours ? "visible" : "none" },
      paint: { "line-color": ["coalesce", ["get", "_col"], o.ccolor], "line-width": ["case", ["to-boolean", ["get", "major"]], 2, 1], "line-opacity": ["case", ["to-boolean", ["get", "major"]], 0.95, 0.7] },
    } as LayerSpecification,
    {
      id: "d6-clabel",
      type: "symbol",
      source: "d6-contours",
      layout: {
        visibility: o.contours && o.labels ? "visible" : "none",
        "symbol-placement": "line",
        "symbol-spacing": 280,
        "text-field": ["get", "_lbl"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["case", ["to-boolean", ["get", "major"]], 11.5, 10],
        "text-keep-upright": true,
        "text-max-angle": 35,
      },
      paint: { "text-color": ["coalesce", ["get", "_col"], o.ccolor], "text-halo-color": "rgba(0,0,0,.85)", "text-halo-width": 1.4 },
    } as LayerSpecification,
    {
      id: "d6-barb",
      type: "symbol",
      source: "d6-barbs",
      layout: {
        visibility: o.barbs ? "visible" : "none",
        "icon-image": ["coalesce", ["get", "_icon"], barbIcon(["get", "speed_kt"])],
        "icon-rotate": ["to-number", ["get", "_rot"], 0],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": 1,
      },
      paint: { "icon-color": o.bcolor, "icon-halo-color": "rgba(0,0,0,.7)", "icon-halo-width": 0.8 },
    } as LayerSpecification,
  ];
  for (const s of specs) {
    if (m.getLayer(s.id)) {
      // keep it current (style / visibility from the settings)
      const l: any = s;
      for (const [k, v] of Object.entries(l.layout ?? {})) m.setLayoutProperty(s.id, k as any, v as any);
      for (const [k, v] of Object.entries(l.paint ?? {})) m.setPaintProperty(s.id, k as any, v as any);
    } else m.addLayer(s, b);
  }
}

function setSrc(id: string, fc: any) {
  (map?.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
}

// ---------- fetching ----------

const cache = new Map<string, any>();
function remember(k: string, v: any) {
  cache.set(k, v);
  if (cache.size > 80) cache.delete(cache.keys().next().value!);
}

function viewBox(m: MLMap): string {
  const b = m.getBounds();
  const pw = (b.getEast() - b.getWest()) * 0.1;
  const ph = (b.getNorth() - b.getSouth()) * 0.1;
  return [Math.max(-180, b.getWest() - pw), Math.max(-85, b.getSouth() - ph), Math.min(180, b.getEast() + pw), Math.min(85, b.getNorth() + ph)].map((x) => x.toFixed(2)).join(",");
}

let gen = 0;
async function refresh() {
  const m = map;
  const t = linesTarget.value;
  const o = d6();
  const T = activeTime.value;
  if (!m || !m.getStyle()) return;
  ensureLayers(m);
  if (!t || !api.base || (!o.contours && !o.barbs)) {
    cData = bData = EMPTY;
    setSrc("d6-contours", EMPTY);
    setSrc("d6-barbs", EMPTY);
    linesStatus.value = {};
    return;
  }
  const g = ++gen;
  const bbox = viewBox(m);
  const st: { contours?: string; barbs?: string; loading?: boolean } = { loading: true };
  linesStatus.value = { ...linesStatus.value, loading: true };
  const jobs: Promise<void>[] = [];
  if (o.contours) {
    const cd = t.cdef;
    const p = preset(cd);
    const iv = o.interval && o.interval > 0 ? o.interval : p?.interval;
    const base = o.base != null && Number.isFinite(o.base) ? o.base : p?.base;
    const q = new URLSearchParams({ layer: cd.id, ...(T ? { time: String(T) } : {}), bbox, smooth: "1", zoom: m.getZoom().toFixed(1) });
    if (iv) q.set("interval", String(+fromDisplay(cd, iv, true).toPrecision(6)));
    if (iv && base != null) q.set("base", String(+fromDisplay(cd, base, false).toPrecision(6)));
    const url = `/api/grid/contours?${q}`;
    jobs.push(
      (cache.has(url) ? Promise.resolve(cache.get(url)) : api.get(url).then((fc) => (remember(url, fc), fc)))
        .then((fc) => {
          if (g !== gen) return;
          const feats = (fc?.features ?? []).map((f: any) => {
            const v = Number(f.properties?.value);
            return { ...f, properties: { ...f.properties, _lbl: Number.isFinite(v) ? fmtNum(toDisplay(cd, v), iv ?? 1) : "" } };
          });
          cData = { type: "FeatureCollection", features: feats };
          setSrc("d6-contours", cData);
          st.contours = `${feats.length} lines · ${cd.name}${iv ? ` · every ${iv} ${displayUnit(cd)}` : ""}`;
        })
        .catch((e) => {
          if (g === gen) st.contours = `Contours: ${e.message}`;
        }),
    );
  } else setSrc("d6-contours", (cData = EMPTY));
  if (o.barbs) {
    if (!t.model) {
      st.barbs = "Barbs need a model layer";
      setSrc("d6-barbs", (bData = EMPTY));
    } else {
      const q = new URLSearchParams({ layer: t.model, level: t.wave ? "sfc" : o.blevel, ...(T ? { time: String(T) } : {}), bbox, spacing_px: "40", zoom: m.getZoom().toFixed(1) });
      const url = `/api/grid/barbs?${q}`;
      jobs.push(
        (cache.has(url) ? Promise.resolve(cache.get(url)) : api.get(url).then((fc) => (remember(url, fc), fc)))
          .then((fc) => {
            if (g !== gen) return;
            const feats = (fc?.features ?? []).map((f: any) => {
              const p = f.properties ?? {};
              let dir = Number(p.dir);
              let kt = Number(p.speed_kt);
              if ((!Number.isFinite(dir) || !Number.isFinite(kt)) && Number.isFinite(+p.u) && Number.isFinite(+p.v)) {
                kt = Math.hypot(+p.u, +p.v) * 1.94384;
                dir = ((Math.atan2(-p.u, -p.v) * 180) / Math.PI + 360) % 360; // direction it blows from
              }
              // waves: an arrow pointing where they go
              return { ...f, properties: { ...p, speed_kt: kt, _rot: t.wave ? (dir + 180) % 360 : dir, ...(t.wave ? { _icon: "wb-arrow" } : {}) } };
            });
            bData = { type: "FeatureCollection", features: feats };
            setSrc("d6-barbs", bData);
            st.barbs = `${feats.length} ${t.wave ? "arrows" : "barbs"}${t.wave ? "" : ` · ${o.blevel === "10m" ? "10 m" : `${o.blevel} hPa`} (kt)`}`;
          })
          .catch((e) => {
            if (g === gen) st.barbs = `Barbs: ${e.message}`;
          }),
      );
    }
  } else setSrc("d6-barbs", (bData = EMPTY));
  await Promise.all(jobs);
  if (g === gen) linesStatus.value = { contours: st.contours, barbs: st.barbs };
}

let timer: number | undefined;
function soon(ms = 120) {
  clearTimeout(timer);
  timer = window.setTimeout(refresh, ms);
}

function attach(m: MLMap) {
  map = m;
  hookBarbs(m);
  m.on("style.load", () => {
    ensureLayers(m);
    soon(0);
  });
  m.on("moveend", () => soon(300));
  if (m.isStyleLoaded()) ensureLayers(m);
  soon(0);
}

let attached = false;
effect(() => {
  const m = mapRef.value;
  if (!m || attached) return;
  attached = true;
  attach(m);
});

effect(() => {
  void activeTime.value;
  void linesTarget.value;
  void settings.value.data6;
  void settings.value.units;
  void api.base;
  soon(settings.value.data6?.contours || settings.value.data6?.barbs ? 60 : 0);
});

// console / screenshot handle
(window as any).__tbwLines = { refresh, linesStatus, setD6, registerBarbs };
