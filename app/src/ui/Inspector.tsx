// radar 0.6: Inspector — every Level II moment at the cursor (RadarScope-style), plus beam geometry
// and the hail / TDS / rotation flags at that spot. Toggle: toolbar "…" menu or the I key.
// Also the "last strike" chip for lightning near saved points.
// 0.8.3 inspector: works in every map pane (that pane's radar, frame and tilt), shows compact info
// for the map objects under the cursor (METARs, cameras, alerts, lightning, tropical tracks, quakes,
// reports, any overlay), and has a fixed width so values never spill out of the box.

import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { signal, effect, untracked } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { settings, update } from "../store";
import { hover, mapRef } from "../map/mapview";
import { paneInsp, paneView, paneMap } from "../map/panes";
import { ALERT_HIT_LAYERS } from "../map/baselayers";
import { alerts } from "../alerts";
import { overlayDef } from "../overlays/defs";
import { sampleAt, type Sweep } from "../radar/sweep";
import { inspData, INSPECT_MOMENTS, paneInspFor, type InspData } from "../radar/inspector";
import { currentFrame, displaySweep, activeTable } from "../radar/controller";
import { dealiased } from "../radar/dealias";
import { hailClass, HAIL_LABEL, HAIL_COLOR, mmToIn } from "../radar/hailfuzzy";
import { meshReady, meshAt, swathGrid } from "../radar/hail";
import { tdsHits } from "../radar/tds";
import { ltgNearPoints } from "../radar/lightning";
import { inspPlace, inspLayers, overlayIdOf, compactRows, metarRows, dedupeRows, type InspRow } from "../radar/insp083";
import { distance, fmtDist, speedFactor, fmtTime, fmtValue } from "../util";
import { activeLegend } from "../active";
import { fmtGrid } from "../util";
import { myKind } from "../linkwin";
import { Zap } from "lucide-preact";

export function toggleInspector() {
  update((s) => (s.radar6 = { ...s.radar6, inspector: !s.radar6?.inspector }));
}

const NAMES: Record<string, string> = { REF: "Reflectivity", VEL: "Velocity", SW: "Spectrum width", ZDR: "ZDR", RHO: "CC", PHI: "PhiDP", KDP: "KDP", CREF: "Composite refl.", ET: "Echo tops", VIL: "VIL" };

function fmt(m: string, v: number): string {
  if (Number.isNaN(v)) return "—";
  if (v === -9999) return "RF";
  const spd = () => {
    const k = speedFactor();
    return `${(v * k).toFixed(Math.abs(v * k) < 10 ? 1 : 0)} ${settings.value.units.speed}`;
  };
  switch (m) {
    case "REF":
    case "CREF":
      return `${v.toFixed(1)} dBZ`;
    case "VEL":
    case "SW":
      return spd();
    case "ZDR":
      return `${v.toFixed(2)} dB`;
    case "RHO":
      return v.toFixed(3);
    case "PHI":
      return `${v.toFixed(0)}°`;
    case "KDP":
      return `${v.toFixed(2)} °/km`;
    case "ET":
      return settings.value.units.distance === "km" ? `${v.toFixed(1)} km` : `${(v * 3.28084).toFixed(1)} kft`;
    case "VIL":
      return `${v.toFixed(1)} kg/m²`;
  }
  return v.toFixed(2);
}

const hStr = (m: number) => (settings.value.units.distance === "km" ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m * 3.28084).toLocaleString()} ft`);
const compass = (az: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(az / 22.5) % 16];

function inPoly(lon: number, lat: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function useInspectorKey(on = true) {
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === "i" || e.key === "I") toggleInspector();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
}

/* ---------- 0.8.3 inspector: map objects under the cursor ---------- */
/** compact rows for the objects under the cursor on one map (0 = main map, n = pane n) */
export const inspFeats = signal<{ pane: number; rows: InspRow[] } | null>(null);

function alertRow(a: any): InspRow | null {
  const p = a?.properties;
  if (!p?.event) return null;
  const end = Date.parse(p.ends ?? p.expires);
  const rows: [string, string][] = [];
  if (Number.isFinite(end)) rows.push(["Until", fmtTime(end, true)]);
  if (p.severity && p.severity !== "Unknown") rows.push(["Severity", String(p.severity)]);
  if (p.areaDesc) rows.push(["Area", String(p.areaDesc)]);
  return compactRows("alert", { title: p.event, rows, color: p.color });
}

function featureRows(m: MLMap, x: number, y: number): InspRow[] {
  let order: string[];
  try {
    order = m.getLayersOrder();
  } catch {
    return [];
  }
  const al = ALERT_HIT_LAYERS.filter((l) => order.includes(l));
  const layers = inspLayers(order, al);
  if (!layers.length) return [];
  const r = 3; // small box: a few pixels around the cursor
  const feats = m.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers });
  const points: InspRow[] = [];
  const areas: InspRow[] = [];
  const alertRows: { pr: number; row: InspRow }[] = [];
  const seenAlert = new Set<string>();
  for (const f of feats) {
    const lid = f.layer.id;
    const props = f.properties ?? {};
    try {
      if (al.includes(lid)) {
        const id = String(props.id);
        if (seenAlert.has(id)) continue;
        seenAlert.add(id);
        const a = alerts.value.get(id);
        const row = alertRow(a);
        if (row) alertRows.push({ pr: +a.properties.priority || 0, row });
        continue;
      }
      const oid = overlayIdOf(lid);
      if (!oid || oid.startsWith("file:")) continue;
      const def = overlayDef(oid);
      const p = def?.click?.(props);
      if (!p) continue;
      const area = f.layer.type === "fill" || f.layer.type === "line" || f.layer.type === "fill-extrusion";
      let row: InspRow | null;
      if (oid === "metar" && p.kind === "metar") row = { ...compactRows(oid, p, 0)!, rows: metarRows(props) };
      else if (p.kind === "camera") row = compactRows(oid, { title: p.title, sub: p.sub ?? "Camera", rows: [] });
      else row = compactRows(oid, p, area ? 2 : 3);
      if (row) (area ? areas : points).push(row);
    } catch {
      /* odd feature properties: skip */
    }
  }
  alertRows.sort((a, b) => b.pr - a.pr);
  return dedupeRows([...points, ...alertRows.map((a) => a.row), ...areas], 4);
}

// throttled (~10/s, trailing) and only while the Inspector is on
let fq = { last: 0, timer: 0 as number | undefined, want: null as { pane: number; x: number; y: number } | null };
function runFeats() {
  const w = fq.want;
  fq.timer = undefined;
  if (!w) return;
  fq.last = performance.now();
  const m = w.pane ? paneMap(w.pane) : mapRef.peek();
  const rows = m ? featureRows(m, w.x, w.y) : [];
  const cur = inspFeats.peek();
  if (cur?.pane === w.pane && JSON.stringify(cur.rows) === JSON.stringify(rows)) return;
  inspFeats.value = { pane: w.pane, rows };
}
function wantFeats(pane: number, x: number, y: number) {
  fq.want = { pane, x, y };
  if (fq.timer !== undefined) return;
  const wait = 100 - (performance.now() - fq.last);
  fq.timer = window.setTimeout(runFeats, Math.max(0, wait));
}
effect(() => {
  const on = !!settings.value.radar6?.inspector;
  const h = hover.value;
  const p = paneInsp.value;
  untracked(() => {
    if (!on || (!h && !p)) {
      fq.want = null;
      if (inspFeats.peek()) inspFeats.value = null;
      return;
    }
    if (p) wantFeats(p.idx, p.x, p.y);
    else if (h) wantFeats(0, h.x, h.y);
  });
});

/* ---------- the box ---------- */
interface Src {
  pane: number;
  x: number;
  y: number;
  lat: number;
  lon: number;
  /** container size (the box stays inside it) */
  cw: number;
  ch: number;
  minTop: number;
  site: string;
  /** Level II radar on this map */
  l2: boolean;
  product: string;
  key?: string;
  disp?: Sweep;
  data: InspData | null;
  /** this map's own product value (non-Level II maps) */
  value?: { v: string; sub?: string } | null;
}

const BOX_W = 268; // fixed width (CSS .r6-insp): values never push the box wider or spill out of it
let lastH = 260;

export function Inspector() {
  useInspectorKey();
  if (!settings.value.radar6?.inspector) return null;
  const h = hover.value;
  if (!h) return null;
  const r = settings.value.radar;
  const radar = settings.value.weather.kind === "radar";
  const l2 = radar && r.source === "L2";
  let value: Src["value"] = null;
  if (!l2) {
    const L = activeLegend.value;
    const ok = L && Number.isFinite(h.value) && h.value > -9000;
    value = ok ? { v: L!.grid ? fmtGrid(h.value, L!.units, L!.table.labels) : fmtValue(h.value, activeTable.value.units, activeTable.value.labels) } : null;
  }
  const disp = displaySweep.value;
  return (
    <InspectorBox
      src={{ pane: 0, x: h.x, y: h.y, lat: h.lat, lon: h.lon, cw: window.innerWidth, ch: window.innerHeight, minTop: 48, site: r.site, l2, product: r.product, key: currentFrame.value?.key, disp: l2 ? disp : undefined, data: l2 ? inspData.value : null, value }}
    />
  );
}

/** the Inspector inside map pane `idx` (rendered in the pane box) */
export function PaneInspector({ idx }: { idx: number }) {
  useInspectorKey(myKind === "pane" && idx === 1); // a pane window has no main Inspector (I key)
  if (!settings.value.radar6?.inspector) return null;
  const p = paneInsp.value;
  if (!p || p.idx !== idx) return null;
  const v = paneView(idx);
  if (!v) return null;
  const cfg = v.cfg;
  const el = paneMap(idx)?.getContainer();
  const l2 = cfg?.weather.kind === "radar" && (cfg.source ?? "L2") === "L2";
  const tilt = cfg?.tilt ?? settings.value.radar.tiltAngle;
  const data = l2 ? paneInspFor(idx, v.key, tilt) : null;
  return (
    <InspectorBox
      src={{
        pane: idx,
        x: p.x,
        y: p.y,
        lat: p.lat,
        lon: p.lon,
        cw: el?.clientWidth ?? 400,
        ch: el?.clientHeight ?? 300,
        minTop: 4,
        site: (cfg?.weather.kind === "radar" && cfg.site) || settings.value.radar.site,
        l2,
        product: cfg?.product ?? "REF",
        key: v.key,
        disp: l2 ? v.sweep : undefined,
        data,
        value: l2 ? null : v.valueAt(p.lat, p.lon),
      }}
    />
  );
}

function InspectorBox({ src }: { src: Src }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const hh = ref.current?.offsetHeight;
    if (hh) lastH = hh;
  });
  const fr = inspFeats.value;
  const feats = fr && fr.pane === src.pane ? fr.rows : [];
  const pos = inspPlace(src.x, src.y, src.cw, src.ch, BOX_W, lastH, src.minTop);
  const style = { left: `${pos.left}px`, top: `${pos.top}px` };
  const featBlock = feats.length > 0 && (
    <div class="i83-feats">
      {feats.map((f, i) => (
        <div key={i} class="i83-feat" style={f.color ? { borderLeftColor: f.color } : undefined}>
          <div class="i83-ft" title={f.sub ? `${f.title} · ${f.sub}` : f.title}>
            <b>{f.title}</b>
            {f.sub && <span class="muted"> · {f.sub}</span>}
          </div>
          {f.rows.map(([k, v]) => (
            <div class="i83-row" key={k}>
              <span>{k}</span>
              <b title={v}>{v}</b>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
  if (!src.l2) {
    return (
      <div ref={ref} class="r6-insp glass" style={style}>
        <div class="r6-insp-head">Inspector</div>
        {featBlock}
        {src.value && (
          <div class="i83-row">
            <span>Value</span>
            <b title={src.value.v}>{src.value.v}</b>
          </div>
        )}
        {src.value?.sub && <div class="muted small i83-ell">{src.value.sub}</div>}
        <div class="muted small">All radar moments need Level II.</div>
      </div>
    );
  }
  return (
    <div ref={ref} class="r6-insp glass" style={style}>
      <RadarRows src={src} featBlock={featBlock} />
    </div>
  );
}

function RadarRows({ src, featBlock }: { src: Src; featBlock: any }) {
  const h = { lat: src.lat, lon: src.lon };
  const d = src.data;
  const key = src.key;
  const sw: Record<string, Sweep | undefined> = { ...(d?.key === key ? d?.sweeps : {}) };
  // the product on screen: use the displayed sweep (dealiased velocity, live partial)
  const disp = src.disp;
  if (disp && INSPECT_MOMENTS.includes(src.product)) sw[src.product] = disp;
  else if (sw.VEL && settings.value.radar6?.dealias) sw.VEL = dealiased(sw.VEL);
  const val: Record<string, number> = {};
  let geo: { range: number; az: number; height: number } | null = null;
  for (const m of INSPECT_MOMENTS) {
    const s = sw[m];
    if (!s) continue;
    const x = sampleAt(s, h.lat, h.lon);
    if (!x) continue;
    val[m] = x.value;
    if (m === src.product || (!geo && m === "REF")) geo = { range: x.range, az: x.az, height: x.height };
  }
  const radarH = (sw.REF ?? disp)?.height ?? 0;
  const lv = d?.levels;
  // flags (hail grids and debris hits follow the main map's frame)
  const mainFrame = key === currentFrame.value?.key;
  const flags: { t: string; c: string }[] = [];
  if (geo && lv) {
    const cls = hailClass(val.REF, val.ZDR, val.RHO, radarH + geo.height - lv.h0);
    if (cls) flags.push({ t: `Hail ${HAIL_LABEL[cls]} (HSDA)`, c: HAIL_COLOR[cls] });
  }
  const mg = key ? meshReady.get(key) : undefined;
  const mesh = mg ? meshAt(mg, h.lat, h.lon) : NaN;
  if (mesh >= 6) flags.push({ t: `MESH ${mmToIn(mesh).toFixed(2)} in`, c: "#fb923c" });
  const sg = mainFrame ? swathGrid : null;
  const swv = sg ? meshAt(sg, h.lat, h.lon) : NaN;
  if (swv >= 6) flags.push({ t: `Swath max ${mmToIn(swv).toFixed(2)} in`, c: "#fbbf24" });
  const th = tdsHits.value;
  if (th && th.key === key) for (const x of th.hits) if (x.poly.length >= 3 && inPoly(h.lon, h.lat, x.poly)) flags.push({ t: `Possible debris (${Math.round(x.conf * 100)}%)`, c: "#e879f9" });
  for (const f of d?.key === key ? d?.rot ?? [] : []) {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties ?? {};
    if (distance(lat, lon, h.lat, h.lon) <= ((p.diam_km ?? 2) / 2 + 1) * 1000) flags.push({ t: `${String(p.kind ?? "rot").toUpperCase()} · Vrot ${Math.round((p.vrot ?? 0) * speedFactor())} ${settings.value.units.speed}`, c: p.kind === "tvs" ? "#ff2d2d" : p.kind === "meso" ? "#facc15" : "#cbd5e1" });
  }
  const loading = !d || d.key !== key || d.loading;
  const cell = (s: string) => <b title={s}>{s}</b>;
  return (
    <>
      <div class="r6-insp-head">
        <b>{src.site}</b> {disp ? `${disp.elevation.toFixed(1)}°` : ""} {loading && <span class="r6-spin" />}
      </div>
      {featBlock}
      <div class="i83-grid">
        {INSPECT_MOMENTS.map((m) => {
          const miss = !!d && d.key === key && d.missing.includes(m) && !sw[m];
          return (
            <div key={m} class={`i83-row ${m === src.product ? "cur" : ""}`}>
              <span>{NAMES[m]}</span>
              {cell(sw[m] ? fmt(m, val[m] ?? NaN) : miss ? "n/a" : "…")}
            </div>
          );
        })}
        {geo && (
          <>
            <div class="i83-row sep">
              <span>Range / az</span>
              {cell(`${fmtDist(geo.range)} · ${Math.round(geo.az)}° ${compass(geo.az)}`)}
            </div>
            <div class="i83-row">
              <span>Beam height</span>
              {cell(`${hStr(geo.height)} ARL`)}
            </div>
            {lv && (
              <div class="i83-row">
                <span>0 °C level</span>
                {cell(hStr(lv.h0 - radarH))}
              </div>
            )}
          </>
        )}
      </div>
      {flags.length > 0 && (
        <div class="r6-insp-flags">
          {flags.map((f) => (
            <span style={{ borderColor: f.c, color: f.c }}>{f.t}</span>
          ))}
        </div>
      )}
      {settings.value.radar6?.dealias && sw.VEL && <div class="muted small">Velocity dealiased</div>}
    </>
  );
}

/** Toolbar chip: the most recent GLM strike within N mi of a saved point. */
export function LightningChip() {
  const l = ltgNearPoints.value;
  if (!settings.value.radar6?.ltgWatch || !l.length) return null;
  const top = l[0];
  const mins = Math.max(0, Math.round((Date.now() - top.t) / 60_000));
  const tip = l.map((x) => `${x.name}: ${x.count} strike${x.count > 1 ? "s" : ""}, nearest ${fmtDist(x.km * 1000)}, last ${Math.round((Date.now() - x.t) / 60_000)} min ago`).join("\n");
  return (
    <button
      class="tb r6-ltg-chip"
      title={`Lightning within ${settings.value.radar6.ltgMi} mi of saved points (GOES GLM, last 30 min)\n${tip}`}
      onClick={() => {
        const p = settings.value.points.find((x) => x.id === top.id);
        const m = mapRef.value;
        if (p && m) m.flyTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), 9) });
        const o = settings.value.ovl.glm;
        if (!o?.on) update((s) => (s.ovl.glm = { ...s.ovl.glm, on: true }));
      }}
    >
      <Zap size={15} />
      <span>
        {top.name} · {fmtDist(top.km * 1000)} · {mins} min
      </span>
    </button>
  );
}
