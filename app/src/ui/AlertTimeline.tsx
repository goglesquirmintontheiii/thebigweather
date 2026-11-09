// radio/dash 0.8: alert timeline — every warning, watch, mesoscale discussion, storm report and model
// detection for an area (the map view, or a saved point + radius) on a zoomable horizontal
// timeline, one lane per kind. Live alerts plus the history feeds (sbwhist, watchhist, mcdhist,
// lsrhist) and model reports (/api/ml/reports). Click an item for details, "Show on map", or
// "Replay" (history mode around it).

import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChartGantt, RefreshCw, ZoomIn, ZoomOut, Play, MapPin, X, Search } from "lucide-preact";
import { api } from "../api";
import { settings } from "../store";
import { alerts, decorateAlert, alertOwnColor } from "../alerts";
import { alertStyle } from "../alertstyle"; // 0.8.3
import { groupItems, applyFilter, cycleFilter, typeChips, spanEnd, packRows, vtecKey, searchText, searchWords, searchItems, type TypeFilter } from "../atlgroup"; // 0.8.3, 0.8.4 search
import { mapRef } from "../map/mapview";
import { pointInGeometry, distance, fmtDist } from "../util";
import { CenterModal } from "./CenterModal";
import { openHistory, bboxOf, bboxCenter, fitBox, showPreview, type BBox } from "../histsearch";
import { histRange } from "../history";
import "./alerts083.css"; // 0.8.3

export const timelineOpen = signal(false);

/* 0.8.3: lanes are alert types (one group per type, labelled at its start), plus MDs, storm
 * reports and model detections; colours follow Alerts → layer options (same as the map). */
const KIND_COLOR: Record<string, string> = { md: "#3b82f6", lsr: "#22d3ee", ml: "#c084fc" };
const typeColor = (type: string, own?: string) => KIND_COLOR[type] ?? alertStyle(type, own).color;

interface Item {
  key: string;
  /** 0.8.3: group — the alert type, or "md" / "lsr" / "ml" */
  type: string;
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
  // 0.8.3: live alerts may start later (winter storm warning from tomorrow): no upper bound for them
  const add = (it: Item) => {
    if (seen.has(it.key) || it.t1 < from || (it.src !== "live" && it.t0 > to)) return;
    seen.add(it.key);
    items.push(it);
  };
  const liveVtec = new Set<string>();
  const warnItem = (f: any, src: string) => {
    const p = f.properties ?? {};
    const ev = String(p.event ?? p.ps ?? "Alert");
    const t0 = tms(p.t0 ?? p.onset ?? p.effective ?? p.sent ?? p.issue);
    const t1 = tms(p.t1 ?? p.ends ?? p.expires ?? p.expire);
    if (!Number.isFinite(t0)) return;
    if (!inArea(area, f.geometry)) return;
    // 0.8.3: an archived copy of a live warning shows once (live segments sharing a VTEC all stay)
    const vk = vtecKey(p.vtec);
    if (vk && src === "live") liveVtec.add(vk);
    else if (vk && liveVtec.has(vk)) return;
    // 0.8.3: colour from the user's alert style (as on the map)
    add({ key: `w:${p.vtec_id ?? p.id ?? `${ev}${t0}`}`, type: ev, t0, t1: Number.isFinite(t1) ? t1 : t0 + 3600_000, point: false, title: ev, sub: p.senderName ?? p.wfo ?? "", color: typeColor(ev, alertOwnColor(p)), geom: f.geometry, props: p, src });
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
          const type = tor ? "Tornado Watch" : "Severe Thunderstorm Watch";
          add({ key: `wa:${p.num ?? p.number ?? t0}`, type, t0, t1: Number.isFinite(t1) ? t1 : t0 + 4 * 3600_000, point: false, title: `${tor ? "Tornado" : "Severe T-storm"} Watch ${p.num ?? p.number ?? ""}`, sub: p.is_pds ? "PDS" : "", color: typeColor(type), geom: f.geometry, props: p, src: "history" });
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
          add({ key: `md:${p.num ?? t0}`, type: "md", t0, t1: Number.isFinite(t1) ? t1 : t0 + 2 * 3600_000, point: false, title: `MD ${p.num ?? ""}`, sub: p.concerning ?? "", color: "#3b82f6", geom: f.geometry, props: p, src: "history" });
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
          add({ key: `lsr:${p.id ?? `${t}${f.geometry?.coordinates}`}`, type: "lsr", t0: t, t1: t, point: true, title: `${ty}${p.mag != null && p.mag !== "" ? ` ${p.mag} ${p.unit ?? ""}` : ""}`, sub: [p.city, p.st].filter(Boolean).join(", "), color: lsrColor(ty), geom: f.geometry, props: p, src: "history" });
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
          add({ key: `ml:${p.id ?? x?.id ?? `${p.model_id}${t}${lon}`}`, type: "ml", t0: t, t1: Number.isFinite(t1) && t1 > t ? t1 : t, point: !(Number.isFinite(t1) && t1 > t), title: `${p.model_name ?? "Model"} · ${p.target ?? ""}`, sub: Number.isFinite(prob) ? `${Math.round(prob * 100)}%` : "", color: "#c084fc", geom: line ?? { type: "Point", coordinates: [lon, lat] }, props: p, src: "ml" });
        }
      })
      .catch((e) => (e?.status === 404 ? null : errors.push(`model reports: ${e.message}`))),
  ]);
  return { items: items.sort((a, b) => a.t0 - b.t0), errors };
}

// ---------- layout ----------
const ROW_H = 18;
/** 0.8.3: label column width (sticky on the left of the scroller) */
const LW = 210;

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

const FKEY = "tbw.atl.filter";
function loadFilter(): TypeFilter {
  try {
    const v = JSON.parse(localStorage.getItem(FKEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function Body() {
  const pts = settings.value.points;
  const [areaSel, setAreaSel] = useState<string>("view");
  const [radius, setRadius] = useState(80);
  const [hours, setHours] = useState(24);
  const [pph, setPph] = useState(60);
  // 0.8.3: type filter (chips: only / hidden), kept between sessions
  const [filt, setFiltS] = useState<TypeFilter>(loadFilter);
  const setFilt = (f: TypeFilter) => {
    setFiltS(f);
    try {
      localStorage.setItem(FKEY, JSON.stringify(f));
    } catch {
      /* private mode */
    }
  };
  const [data, setData] = useState<{ items: Item[]; errors: string[]; loading: boolean; area?: Area }>({ items: [], errors: [], loading: true });
  const [sel, setSel] = useState<Item | null>(null);
  const [nonce, setNonce] = useState(0);
  // 0.8.4: search bar (revealed by the magnifier button)
  const [searchOn, setSearchOn] = useState(false);
  const [q, setQ] = useState("");
  const searchEl = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOn) searchEl.current?.focus();
  }, [searchOn]);
  const closeSearch = () => {
    setSearchOn(false);
    setQ("");
  };
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
  // 0.8.3: the canvas reaches past "now" as far as the active alerts go (max 7 days)
  const end = useMemo(() => spanEnd(data.items, to), [data.items, to]);
  const pxPerMs = pph / 3600_000;
  const width = Math.max(600, Math.ceil((end - from) * pxPerMs));
  const xAt = (t: number) => (t - from) * pxPerMs;
  const styleKey = settings.value.alertCfg; // colours follow Alerts → layer options
  const texts = useMemo(() => new Map(data.items.map((it) => [it.key, searchText(it)])), [data.items]);
  const found = useMemo(() => searchItems(data.items, searchWords(q), (it) => texts.get(it.key) ?? ""), [data.items, texts, q]);
  const chips = useMemo(() => typeChips(found), [found, styleKey]);
  const groups = useMemo(
    () =>
      groupItems(applyFilter(found, filt)).map((g) => {
        const rows = packRows(g.items, pxPerMs);
        let n = 1;
        for (const r of rows.values()) n = Math.max(n, r + 1);
        return { ...g, rows, n };
      }),
    [found, filt, pph, styleKey],
  );
  const nShown = groups.reduce((a, g) => a + g.items.length, 0);
  const nFilt = Object.keys(filt).length;
  // start with "now" three quarters across
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s) s.scrollLeft = Math.max(0, xAt(Date.now()) - (s.clientWidth - LW) * 0.75);
  }, [hours, data.loading]);
  const zoom = (f: number, anchorX?: number) => {
    const s = scroller.current;
    const ax = Math.max(LW, anchorX ?? (s ? LW + (s.clientWidth - LW) / 2 : LW));
    const tAt = s ? from + (s.scrollLeft + ax - LW) / pxPerMs : to;
    const np = Math.max(6, Math.min(600, pph * f));
    setPph(np);
    requestAnimationFrame(() => {
      if (s) s.scrollLeft = (tAt - from) * (np / 3600_000) - ax + LW;
    });
  };
  const tk = ticks(from, end, pph);
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
  const now = Date.now();
  return (
    <CenterModal
      cls="atl"
      icon={<ChartGantt size={19} />}
      title="Alert timeline"
      sub={`${nShown === data.items.length ? data.items.length : `${nShown} of ${data.items.length}`} items · ${area.pt ? `within ${fmtDist(area.pt.r)} of ${area.pt.name}` : "current map view"} · last ${RANGES.find((r) => r[0] === hours)?.[1] ?? `${hours} h`}${data.loading ? " · loading…" : ""}`}
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
          <button class={`icon-btn ${searchOn ? "on" : ""}`} title="Search" aria-pressed={searchOn} onClick={() => (searchOn ? closeSearch() : setSearchOn(true))}>
            <Search size={15} />
          </button>
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
      {searchOn && (
        <div class="atl-search">
          <Search size={13} />
          <input
            ref={searchEl}
            type="search"
            placeholder="Type, city, state, area, description…"
            aria-label="Search the timeline"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (q) setQ("");
              else closeSearch();
            }}
          />
          {q && (
            <button class="icon-btn" title="Clear" onClick={() => setQ("")}>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {/* 0.8.3: type filter — click: only this type (add more), again: hide it, again: normal */}
      {chips.length > 0 && (
        <div class="atl-chips" role="group" aria-label="Filter by type">
          <span class="muted small atl-chips-h">Types</span>
          {chips.map((c) => {
            const st = filt[c.type];
            return (
              <button
                key={c.type}
                class={`atl-chip ${st ?? ""}`}
                aria-pressed={!!st}
                title={st === "in" ? "Only checked types are shown · click to hide this type" : st === "out" ? "Hidden · click to show again" : "Click: show only this type (pick more to add them); again: hide it"}
                onClick={() => setFilt(cycleFilter(filt, c.type))}
              >
                <i style={{ background: c.color }} />
                <span>{c.name}</span>
                <small>{c.n}</small>
              </button>
            );
          })}
          {nFilt > 0 && (
            <button class="btn xs ghost" onClick={() => setFilt({})} title="Show every type">
              Reset
            </button>
          )}
        </div>
      )}
      <div class="atl-wrap">
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
          <div class="atl-canvas" style={{ width: `${width + LW}px` }}>
            <div class="atl-grid" style={{ left: `${LW}px`, width: `${width}px` }}>
              {tk.map((t) => (
                <i key={t.t} class={t.major ? "major" : ""} style={{ left: `${xAt(t.t)}px` }} />
              ))}
              {hr && hr.end > from && <b class="atl-hist" style={{ left: `${xAt(Math.max(from, hr.start))}px`, width: `${xAt(Math.min(end, hr.end)) - xAt(Math.max(from, hr.start))}px` }} title="History mode range" />}
              <b class="atl-future" style={{ left: `${xAt(now)}px`, width: `${Math.max(0, xAt(end) - xAt(now))}px` }} />
              <i class="atl-now" style={{ left: `${xAt(now)}px` }} title="Now" />
            </div>
            <div class="atl-row atl-head">
              <div class="atl-lname atl-corner" />
              <div class="atl-axis" style={{ width: `${width}px` }}>
                {tk.map((t) => (
                  <span key={t.t} class={`atl-tick ${t.major ? "major" : ""}`} style={{ left: `${xAt(t.t)}px` }}>
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
            {groups.map((g) => (
              <div key={g.type} class="atl-row" style={{ height: `${g.n * ROW_H + 8}px` }}>
                <div class="atl-lname">
                  <button class="atl-lname-in" title={`${g.name} · ${g.items.length}\nClick to hide this type`} onClick={() => setFilt({ ...filt, [g.type]: "out" })}>
                    <i style={{ background: g.color }} />
                    <span>{g.name}</span>
                    <small class="muted">{g.items.length}</small>
                  </button>
                </div>
                <div class="atl-lane" style={{ width: `${width}px` }}>
                  {g.items.map((it) => {
                    const x0 = xAt(it.t0);
                    const w = it.point ? 0 : Math.max(6, xAt(it.t1) - x0);
                    const top = 4 + (g.rows.get(it.key) ?? 0) * ROW_H;
                    return it.point ? (
                      <button key={it.key} class={`atl-pt ${sel?.key === it.key ? "sel" : ""}`} style={{ left: `${x0 - 5}px`, top: `${top + 3}px`, background: it.color }} title={`${it.title} · ${new Date(it.t0).toLocaleString()}`} onClick={() => setSel(it)} />
                    ) : (
                      <button key={it.key} class={`atl-bar ${sel?.key === it.key ? "sel" : ""} ${it.src === "live" && it.t1 > now ? "active" : ""}`} style={{ left: `${x0}px`, width: `${w}px`, top: `${top}px`, background: it.color }} title={`${it.title}${it.sub ? ` · ${it.sub}` : ""}`} onClick={() => setSel(it)}>
                        {w > 60 && <span>{it.type === it.title ? it.props.areaDesc || it.sub || it.title : it.title}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {!groups.length && data.items.length > 0 && <div class="muted small atl-none">{searchWords(q).length && !found.length ? `Nothing matches “${q.trim()}”.` : "Every type is filtered out."}</div>}
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
      <div class="muted small atl-help">Ctrl+wheel zooms (hours ↔ days); click a type's name to hide it; bars run from issue to expiry (past "now" for active alerts), dots are reports and model detections.</div>
    </CenterModal>
  );
}

(window as any).__tbwTimeline = { timelineOpen };
