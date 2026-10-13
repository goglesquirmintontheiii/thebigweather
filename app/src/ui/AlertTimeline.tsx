// radio/dash 0.8: alert timeline — every warning, watch, mesoscale discussion, storm report and model
// detection for an area (the map view, or a saved point + radius) on a zoomable horizontal
// timeline, one lane per kind. Live alerts plus the history feeds (sbwhist, watchhist, mcdhist,
// lsrhist) and model reports (/api/ml/reports). Click an item for details, "Show on map", or
// "Replay" (history mode around it).

import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChartGantt, RefreshCw, ZoomIn, ZoomOut, Play, MapPin, X } from "lucide-preact";
import { api } from "../api";
import { settings } from "../store";
import { alerts, decorateAlert, alertColor } from "../alerts";
import { mapRef } from "../map/mapview";
import { pointInGeometry, distance, fmtDist } from "../util";
import { CenterModal } from "./CenterModal";
import { openHistory, bboxOf, bboxCenter, fitBox, showPreview, type BBox } from "../histsearch";
import { histRange } from "../history";

export const timelineOpen = signal(false);

type Lane = "tor" | "svr" | "ffw" | "warn" | "adv" | "watch" | "md" | "lsr" | "ml";
const LANES: { id: Lane; name: string; color: string }[] = [
  { id: "tor", name: "Tornado warnings", color: "#ff1744" },
  { id: "svr", name: "Severe t-storm warnings", color: "#ffa500" },
  { id: "ffw", name: "Flash flood warnings", color: "#16a34a" },
  { id: "warn", name: "Other warnings", color: "#f472b6" },
  { id: "adv", name: "Advisories & statements", color: "#94a3b8" },
  { id: "watch", name: "Watches", color: "#facc15" },
  { id: "md", name: "Mesoscale discussions", color: "#3b82f6" },
  { id: "lsr", name: "Storm reports", color: "#22d3ee" },
  { id: "ml", name: "Model detections", color: "#c084fc" },
];

interface Item {
  key: string;
  lane: Lane;
  t0: number;
  t1: number;
  point: boolean;
  title: string;
  sub?: string;
  color: string;
  geom?: any;
  props: any;
  src: string;
}

const RANGES: [number, string][] = [
  [6, "6 h"],
  [24, "24 h"],
  [72, "3 days"],
  [168, "7 days"],
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + "Z";
const tms = (v: any) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) : NaN);

function warnLane(ev: string): Lane {
  const e = ev.toLowerCase();
  if (e.includes("tornado warning")) return "tor";
  if (e.includes("severe thunderstorm warning")) return "svr";
  if (e.includes("flash flood warning")) return "ffw";
  if (e.endsWith("warning") || e.includes("emergency")) return "warn";
  if (e.endsWith("watch")) return "watch";
  return "adv";
}
function lsrColor(t: string) {
  const u = t.toUpperCase();
  return u.includes("TORNADO") ? "#ef4444" : u.includes("FUNNEL") ? "#f87171" : u.includes("HAIL") ? "#22c55e" : u.includes("WIND") || u.includes("WND") ? "#3b82f6" : u.includes("FLOOD") ? "#15803d" : u.includes("SNOW") ? "#a5b4fc" : "#9ca3af";
}

// ---------- area ----------
interface Area {
  kind: "view" | "point";
  bbox: BBox;
  pt?: { lat: number; lon: number; r: number; name: string };
}
function inArea(a: Area, geom: any, lon?: number, lat?: number): boolean {
  if (geom?.type === "Point") [lon, lat] = geom.coordinates;
  if (lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat)) {
    if (a.pt) return distance(a.pt.lat, a.pt.lon, lat, lon) <= a.pt.r;
    return lon >= a.bbox[0] && lon <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3];
  }
  if (!geom) return false;
  const b = bboxOf(geom);
  if (!b) return false;
  if (b[2] < a.bbox[0] || b[0] > a.bbox[2] || b[3] < a.bbox[1] || b[1] > a.bbox[3]) return false;
  if (!a.pt) return true;
  if (pointInGeometry(a.pt.lon, a.pt.lat, geom)) return true;
  // any vertex within the radius
  let hit = false;
  const walk = (c: any) => {
    if (hit) return;
    if (typeof c[0] === "number") hit = distance(a.pt!.lat, a.pt!.lon, c[1], c[0]) <= a.pt!.r;
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return hit;
}

// ---------- data ----------
async function feed(name: string, from: number, to: number): Promise<any[]> {
  const r = await api.get(`/api/ovl/${name}?sts=${iso(from)}&ets=${iso(to)}`);
  return r?.features ?? [];
}

async function loadItems(from: number, to: number, area: Area): Promise<{ items: Item[]; errors: string[] }> {
  const items: Item[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const add = (it: Item) => {
    if (seen.has(it.key) || it.t1 < from || it.t0 > to) return;
    seen.add(it.key);
    items.push(it);
  };
  const warnItem = (f: any, src: string) => {
    const p = f.properties ?? {};
    const ev = String(p.event ?? p.ps ?? "Alert");
    const t0 = tms(p.t0 ?? p.onset ?? p.effective ?? p.sent ?? p.issue);
    const t1 = tms(p.t1 ?? p.ends ?? p.expires ?? p.expire);
    if (!Number.isFinite(t0)) return;
    if (!inArea(area, f.geometry)) return;
    const lane = warnLane(ev);
    add({ key: `w:${p.vtec_id ?? p.id ?? `${ev}${t0}`}`, lane, t0, t1: Number.isFinite(t1) ? t1 : t0 + 3600_000, point: false, title: ev, sub: p.senderName ?? p.wfo ?? "", color: p.color ?? alertColor(ev), geom: f.geometry, props: p, src });
  };
  // live alerts first (they carry the richest text)
  for (const a of alerts.value.values()) warnItem(a, "live");
  const jobs: [string, (fs: any[]) => void][] = [
    ["sbwhist", (fs) => fs.forEach((f) => f.geometry && warnItem(decorateAlert(f), "history"))],
    [
      "watchhist",
      (fs) =>
        fs.forEach((f) => {
          const p = f.properties ?? {};
          if (!inArea(area, f.geometry)) return;
          const tor = String(p.type ?? p.sel ?? "").toUpperCase().includes("TOR");
          const t0 = tms(p.t0 ?? p.issue), t1 = tms(p.t1 ?? p.expire);
          if (!Number.isFinite(t0)) return;
          add({ key: `wa:${p.num ?? p.number ?? t0}`, lane: "watch", t0, t1: Number.isFinite(t1) ? t1 : t0 + 4 * 3600_000, point: false, title: `${tor ? "Tornado" : "Severe T-storm"} Watch ${p.num ?? p.number ?? ""}`, sub: p.is_pds ? "PDS" : "", color: tor ? "#ff1744" : "#facc15", geom: f.geometry, props: p, src: "history" });
        }),
    ],
    [
      "mcdhist",
      (fs) =>
        fs.forEach((f) => {
          const p = f.properties ?? {};
          if (!inArea(area, f.geometry)) return;
          const t0 = tms(p.t0 ?? p.issue), t1 = tms(p.t1 ?? p.expire);
          if (!Number.isFinite(t0)) return;
          add({ key: `md:${p.num ?? t0}`, lane: "md", t0, t1: Number.isFinite(t1) ? t1 : t0 + 2 * 3600_000, point: false, title: `MD ${p.num ?? ""}`, sub: p.concerning ?? "", color: "#3b82f6", geom: f.geometry, props: p, src: "history" });
        }),
    ],
    [
      "lsrhist",
      (fs) =>
        fs.forEach((f) => {
          const p = f.properties ?? {};
          if (!inArea(area, f.geometry)) return;
          const t = tms(p.t ?? p.valid);
          if (!Number.isFinite(t)) return;
          const ty = String(p.typetext ?? "Report");
          add({ key: `lsr:${p.id ?? `${t}${f.geometry?.coordinates}`}`, lane: "lsr", t0: t, t1: t, point: true, title: `${ty}${p.mag != null && p.mag !== "" ? ` ${p.mag} ${p.unit ?? ""}` : ""}`, sub: [p.city, p.st].filter(Boolean).join(", "), color: lsrColor(ty), geom: f.geometry, props: p, src: "history" });
        }),
    ],
  ];
  await Promise.all([
    ...jobs.map(([name, fn]) =>
      feed(name, from, to)
        .then(fn)
        .catch((e) => errors.push(`${name}: ${e.message}`)),
    ),
    api
      .get(`/api/ml/reports?from=${Math.round(from)}&to=${Math.round(to)}&bbox=${area.bbox.map((v) => v.toFixed(3)).join(",")}`)
      .then((r: any) => {
        const list = Array.isArray(r) ? r : r?.reports ?? r?.features ?? [];
        for (const x of list) {
          const p = x?.properties ?? x ?? {};
          const g = x?.geometry?.type === "Point" ? x.geometry.coordinates : null;
          // server Report: first_t / last_t, max_prob, track [{t, lat, lon, prob}]
          const tp = Array.isArray(p.track) && p.track.length ? p.track[p.track.length - 1] : null;
          const lon = +(p.lon ?? g?.[0] ?? tp?.lon), lat = +(p.lat ?? g?.[1] ?? tp?.lat);
          const t = tms(p.t ?? p.first_t ?? p.time ?? p.issued);
          const t1 = tms(p.last_t) ?? t;
          if (!Number.isFinite(t) || !inArea(area, null, lon, lat)) continue;
          let prob = +(p.prob ?? p.max_prob);
          if (prob > 1) prob /= 100;
          const line = Array.isArray(p.track) && p.track.length > 1 ? { type: "LineString", coordinates: p.track.map((q: any) => [q.lon, q.lat]) } : null;
          add({ key: `ml:${p.id ?? x?.id ?? `${p.model_id}${t}${lon}`}`, lane: "ml", t0: t, t1: Number.isFinite(t1) && t1 > t ? t1 : t, point: !(Number.isFinite(t1) && t1 > t), title: `${p.model_name ?? "Model"} · ${p.target ?? ""}`, sub: Number.isFinite(prob) ? `${Math.round(prob * 100)}%` : "", color: "#c084fc", geom: line ?? { type: "Point", coordinates: [lon, lat] }, props: p, src: "ml" });
        }
      })
      .catch((e) => (e?.status === 404 ? null : errors.push(`model reports: ${e.message}`))),
  ]);
  return { items: items.sort((a, b) => a.t0 - b.t0), errors };
}

// ---------- layout ----------
const ROW_H = 18;
function stack(items: Item[], pxPerMs: number): Map<string, number> {
  const rows: number[] = [];
  const out = new Map<string, number>();
  for (const it of items) {
    const x0 = it.t0 * pxPerMs;
    const x1 = Math.max(x0 + (it.point ? 10 : 6), it.t1 * pxPerMs) + (it.point ? 0 : 2);
    let r = rows.findIndex((end) => end <= x0);
    if (r < 0) {
      r = rows.length;
      rows.push(0);
    }
    rows[r] = x1;
    out.set(it.key, r);
  }
  return out;
}

function ticks(from: number, to: number, pph: number): { t: number; major: boolean; label: string }[] {
  const stepH = [1, 2, 3, 6, 12, 24].find((h) => h * pph >= 64) ?? 24;
  const utc = settings.value.utc;
  const tz = utc ? "UTC" : undefined;
  const out: { t: number; major: boolean; label: string }[] = [];
  const t0 = Math.floor(from / 3600_000) * 3600_000;
  for (let t = t0; t <= to; t += 3600_000) {
    const d = new Date(t);
    const h = utc ? d.getUTCHours() : d.getHours();
    if (h % stepH !== 0) continue;
    const major = h === 0;
    out.push({ t, major, label: major ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : d.toLocaleTimeString(undefined, { hour: "numeric", timeZone: tz }) });
  }
  return out;
}

// ---------- UI ----------
export function AlertTimeline() {
  if (!timelineOpen.value) return null;
  return <Body />;
}

function Body() {
  const pts = settings.value.points;
  const [areaSel, setAreaSel] = useState<string>("view");
  const [radius, setRadius] = useState(80);
  const [hours, setHours] = useState(24);
  const [pph, setPph] = useState(60);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [data, setData] = useState<{ items: Item[]; errors: string[]; loading: boolean; area?: Area }>({ items: [], errors: [], loading: true });
  const [sel, setSel] = useState<Item | null>(null);
  const [nonce, setNonce] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const to = useMemo(() => Date.now(), [hours, nonce, areaSel, radius]);
  const from = to - hours * 3600_000;
  const area = useMemo((): Area => {
    const p = pts.find((x) => x.id === areaSel);
    if (p) {
      const r = radius * 1000;
      const dLat = r / 111_000, dLon = r / (111_000 * Math.cos((p.lat * Math.PI) / 180));
      return { kind: "point", bbox: [p.lon - dLon, p.lat - dLat, p.lon + dLon, p.lat + dLat], pt: { lat: p.lat, lon: p.lon, r, name: p.name } };
    }
    const m = mapRef.value;
    const b = m?.getBounds();
    return { kind: "view", bbox: b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : [-180, -90, 180, 90] };
  }, [areaSel, radius, nonce]);
  useEffect(() => {
    let dead = false;
    setData((d) => ({ ...d, loading: true }));
    loadItems(from, to, area).then((r) => !dead && setData({ ...r, loading: false, area }));
    return () => {
      dead = true;
    };
  }, [from, to, area]);
  // keep the item list fresh with live alerts
  useEffect(() => {
    const t = window.setInterval(() => setNonce((n) => n + 1), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  const width = Math.max(600, (hours * pph) | 0);
  const pxPerMs = pph / 3600_000;
  const xAt = (t: number) => (t - from) * pxPerMs;
  const shown = data.items.filter((i) => !off[i.lane]);
  const lanes = useMemo(() => {
    return LANES.map((l) => {
      const its = shown.filter((i) => i.lane === l.id);
      const rows = stack(its, pxPerMs);
      const n = Math.max(1, ...[...rows.values()].map((r) => r + 1));
      return { ...l, its, rows, n };
    });
  }, [data, off, pph, hours]);
  // start scrolled to "now"
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s) s.scrollLeft = s.scrollWidth;
  }, [hours, data.loading]);
  const zoom = (f: number, anchorX?: number) => {
    const s = scroller.current;
    const ax = anchorX ?? (s ? s.clientWidth / 2 : 0);
    const tAt = s ? from + (s.scrollLeft + ax) / pxPerMs : to;
    const np = Math.max(6, Math.min(600, pph * f));
    setPph(np);
    requestAnimationFrame(() => {
      if (s) s.scrollLeft = (tAt - from) * (np / 3600_000) - ax;
    });
  };
  const tk = ticks(from, to, pph);
  const hr = histRange.value;
  const replay = (it: Item) => {
    const b = it.geom ? bboxOf(it.geom) : null;
    const pad = it.point ? 45 * 60_000 : 20 * 60_000;
    timelineOpen.value = false;
    openHistory({ label: it.title, kind: "warning", start: it.t0 - pad, end: (it.point ? it.t0 : it.t1) + pad, padded: true, center: b ? bboxCenter(b) : undefined, bbox: b ? [b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3] : undefined, ref: it.key });
  };
  const showOnMap = (it: Item) => {
    const b = it.geom ? bboxOf(it.geom) : null;
    if (!b) return;
    if (it.geom.type !== "Point") showPreview({ kind: "warning", fc: { type: "FeatureCollection", features: [{ type: "Feature", geometry: it.geom, properties: {} }] }, id: it.key, pinned: false, title: it.title });
    fitBox(it.geom.type === "Point" ? [b[0] - 0.4, b[1] - 0.3, b[2] + 0.4, b[3] + 0.3] : [b[0] - 0.2, b[1] - 0.2, b[2] + 0.2, b[3] + 0.2], 9);
  };
  const counts = Object.fromEntries(LANES.map((l) => [l.id, data.items.filter((i) => i.lane === l.id).length]));
  return (
    <CenterModal
      cls="atl"
      icon={<ChartGantt size={19} />}
      title="Alert timeline"
      sub={`${data.items.length} items · ${area.pt ? `within ${fmtDist(area.pt.r)} of ${area.pt.name}` : "current map view"} · last ${RANGES.find((r) => r[0] === hours)?.[1] ?? `${hours} h`}${data.loading ? " · loading…" : ""}`}
      onClose={() => (timelineOpen.value = false)}
      actions={
        <>
          <select value={areaSel} onChange={(e) => setAreaSel((e.target as HTMLSelectElement).value)} title="Area">
            <option value="view">Map view</option>
            {pts.map((p) => (
              <option key={p.id} value={p.id}>
                Near {p.name}
              </option>
            ))}
          </select>
          {areaSel !== "view" && (
            <select value={radius} onChange={(e) => setRadius(+(e.target as HTMLSelectElement).value)} title="Radius">
              {[25, 50, 80, 150, 300].map((k) => (
                <option key={k} value={k}>
                  {fmtDist(k * 1000)}
                </option>
              ))}
            </select>
          )}
          <div class="seg">
            {RANGES.map(([h, l]) => (
              <button key={h} class={hours === h ? "on" : ""} onClick={() => setHours(h)}>
                {l}
              </button>
            ))}
          </div>
          <button class="icon-btn" title="Zoom out (Ctrl+wheel)" onClick={() => zoom(1 / 1.6)}>
            <ZoomOut size={15} />
          </button>
          <button class="icon-btn" title="Zoom in (Ctrl+wheel)" onClick={() => zoom(1.6)}>
            <ZoomIn size={15} />
          </button>
          <button class="icon-btn" title="Reload (map view: uses the current view)" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw size={15} class={data.loading ? "spin" : ""} />
          </button>
        </>
      }
    >
      <div class="atl-wrap">
        <div class="atl-lanes">
          <div class="atl-axis-h" />
          {lanes.map((l) => (
            <button key={l.id} class={`atl-lname ${off[l.id] ? "off" : ""}`} style={{ height: `${l.n * ROW_H + 8}px` }} title={off[l.id] ? "Show this lane" : "Hide this lane"} onClick={() => setOff({ ...off, [l.id]: !off[l.id] })}>
              <i style={{ background: l.color }} />
              <span>{l.name}</span>
              <small class="muted">{counts[l.id]}</small>
            </button>
          ))}
        </div>
        <div
          ref={scroller}
          class="atl-scroll"
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left);
          }}
        >
          <div class="atl-canvas" style={{ width: `${width}px` }}>
            <div class="atl-axis">
              {tk.map((t) => (
                <span key={t.t} class={`atl-tick ${t.major ? "major" : ""}`} style={{ left: `${xAt(t.t)}px` }}>
                  {t.label}
                </span>
              ))}
            </div>
            <div class="atl-grid">
              {tk.map((t) => (
                <i key={t.t} class={t.major ? "major" : ""} style={{ left: `${xAt(t.t)}px` }} />
              ))}
              {hr && hr.end > from && <b class="atl-hist" style={{ left: `${xAt(Math.max(from, hr.start))}px`, width: `${xAt(Math.min(to, hr.end)) - xAt(Math.max(from, hr.start))}px` }} title="History mode range" />}
              <i class="atl-now" style={{ left: `${xAt(Date.now())}px` }} title="Now" />
            </div>
            {lanes.map((l) => (
              <div key={l.id} class={`atl-lane ${off[l.id] ? "off" : ""}`} style={{ height: `${l.n * ROW_H + 8}px` }}>
                {l.its.map((it) => {
                  const x0 = xAt(it.t0);
                  const w = it.point ? 0 : Math.max(6, xAt(it.t1) - x0);
                  const top = 4 + (l.rows.get(it.key) ?? 0) * ROW_H;
                  return it.point ? (
                    <button key={it.key} class={`atl-pt ${sel?.key === it.key ? "sel" : ""}`} style={{ left: `${x0 - 5}px`, top: `${top + 3}px`, background: it.color }} title={`${it.title} · ${new Date(it.t0).toLocaleString()}`} onClick={() => setSel(it)} />
                  ) : (
                    <button key={it.key} class={`atl-bar ${sel?.key === it.key ? "sel" : ""} ${it.src === "live" && it.t1 > Date.now() ? "active" : ""}`} style={{ left: `${x0}px`, width: `${w}px`, top: `${top}px`, background: it.color }} title={`${it.title}${it.sub ? ` · ${it.sub}` : ""}`} onClick={() => setSel(it)}>
                      {w > 60 && <span>{it.title}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {data.errors.length > 0 && <div class="muted small atl-errs">Some feeds failed: {data.errors.join(" · ")}</div>}
      {!data.loading && !data.items.length && <div class="muted small">Nothing in this area and time range. Zoom the map out or pick a longer range.</div>}
      {sel && (
        <div class="atl-detail" style={{ borderLeftColor: sel.color }}>
          <div class="atl-dhead">
            <b style={{ color: sel.color }}>{sel.title}</b>
            {sel.sub && <span class="muted">{sel.sub}</span>}
            <span class="rp-fill" />
            <button class="btn sm" onClick={() => replay(sel)} title="History mode around this item (radar, warnings, reports at the time)">
              <Play size={12} /> Replay
            </button>
            {sel.geom && (
              <button class="btn sm ghost" onClick={() => showOnMap(sel)}>
                <MapPin size={12} /> Show on map
              </button>
            )}
            <button class="icon-btn" onClick={() => setSel(null)} title="Close">
              <X size={14} />
            </button>
          </div>
          <div class="atl-dmeta muted small">
            {new Date(sel.t0).toLocaleString(undefined, { timeZone: settings.value.utc ? "UTC" : undefined })}
            {!sel.point && ` → ${new Date(sel.t1).toLocaleString(undefined, { timeZone: settings.value.utc ? "UTC" : undefined })} (${Math.round((sel.t1 - sel.t0) / 60000)} min)`}
            {" · "}
            {sel.src === "live" ? "live" : sel.src === "ml" ? "model report" : "archive"}
            {area.pt && sel.geom?.type === "Point" && ` · ${fmtDist(distance(area.pt.lat, area.pt.lon, sel.geom.coordinates[1], sel.geom.coordinates[0]))} from ${area.pt.name}`}
          </div>
          <div class="atl-dtext">{sel.props.headline ?? sel.props.areaDesc ?? sel.props.remark ?? sel.props.concerning ?? sel.props.text ?? ""}</div>
        </div>
      )}
      <div class="muted small atl-help">
        Ctrl+wheel zooms (hours ↔ days); click a lane name to hide it; bars are warnings/watches/MDs from issue to expiry, dots are reports and model detections.
      </div>
    </CenterModal>
  );
}

(window as any).__tbwTimeline = { timelineOpen };
