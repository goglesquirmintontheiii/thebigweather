// History 0.6: "Historical Storms" window: search past warnings/watches and tropical cyclones,
// preview them on the map, and open history mode around them; plus recently opened ranges.

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { History, Search, Play, ExternalLink, Trash2, RotateCcw, Wind, TriangleAlert, Clock, Tornado, X } from "lucide-preact";
import { mapRef } from "../map/mapview";
import { api } from "../api";
import { settings, update } from "../store";
import { CenterModal } from "./CenterModal";
import { enterHistory } from "../history";
import { selectSite } from "../radar/controller";
import {
  histStormsOpen,
  beforeAfter,
  setBeforeAfter,
  openHistory,
  nearestRadar,
  bboxOf,
  bboxCenter,
  fitBox,
  showPreview,
  clearPreview,
  preview,
  catOf,
  stormAt,
  SS_COLORS,
  SS_NAMES,
  addRecent,
  replayAlert,
  alertEventSpan,
  type BBox,
} from "../histsearch";

export { histStormsOpen };
const tab = signal<"warnings" | "tropical" | "tornado" | "recent">("warnings");

// ---------- formatting ----------
const tz = () => (settings.value.utc ? "UTC" : undefined);
function fmtDate(t: number, time = true) {
  const d = new Date(t);
  const ds = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: tz() });
  if (!time) return ds;
  return `${ds} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() })}${settings.value.utc ? "Z" : ""}`;
}
function dur(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} min`;
  if (m < 2880) return `${+(m / 60).toFixed(1)} h`;
  return `${+(m / 1440).toFixed(1)} d`;
}
const isoQ = (t: number) => new Date(t).toISOString().slice(0, 19) + "Z";

/** Minutes before / after an alert or storm window (shared with "Replay this" on alerts). */
export function BeforeAfter() {
  const { before, after } = beforeAfter();
  return (
    <span class="hs-ba" title="History window around an alert or storm: minutes before it began and after it ended">
      <label>
        <span>−</span>
        <input type="number" min={0} max={1440} step={5} value={before} onChange={(e) => setBeforeAfter(+(e.target as HTMLInputElement).value)} />
      </label>
      <label>
        <span>+</span>
        <input type="number" min={0} max={1440} step={5} value={after} onChange={(e) => setBeforeAfter(undefined, +(e.target as HTMLInputElement).value)} />
      </label>
      <span class="muted small">min</span>
    </span>
  );
}

// ---------- warnings ----------
interface WarnItem {
  id: string;
  vtec: string;
  event: string;
  phen: string;
  sig: string;
  wfo: string;
  year: number;
  eventid: number;
  issue: number;
  expire: number;
  headline?: string;
  areaDesc: string;
  states: string[];
  lat: number;
  lon: number;
  bbox?: BBox;
  flags: { pds?: boolean; emergency?: boolean; damage_threat?: string; observed?: boolean; tornado_detection?: string };
  link?: string;
}
const PHEN: [string, string][] = [
  ["TO", "Tornado"],
  ["SV", "Severe Thunderstorm"],
  ["FF", "Flash Flood"],
  ["EW", "Extreme Wind"],
  ["SQ", "Snow Squall"],
  ["MA", "Special Marine"],
];
const PAGE = 100;
const thisYear = new Date().getUTCFullYear();
const YEARS = Array.from({ length: thisYear - 2001 }, (_, i) => thisYear - i);

const wForm = signal({ phen: ["TO"], sig: "W" as "W" | "A" | "", dateMode: "year" as "year" | "range" | "any", year: thisYear, from: "", to: "", state: "", wfo: "", q: "", pds: false, emergency: false, observed: false });
const wRes = signal<{ items: WarnItem[]; total?: number; offset: number; loading: boolean; error?: string; searched: boolean; note?: string }>({ items: [], offset: 0, loading: false, searched: false });
const wSel = signal<{ item: WarnItem; fc: any | null; loading: boolean; error?: string } | null>(null);

const observed = (w: WarnItem) => !!w.flags?.observed || /observed/i.test(w.flags?.tornado_detection ?? "");
const damage = (w: WarnItem) => w.flags?.damage_threat && !/^(none|base)?$/i.test(w.flags.damage_threat) ? w.flags.damage_threat : "";

async function searchWarnings(offset = 0) {
  const f = wForm.value;
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (f.q.trim()) q.set("q", f.q.trim());
  if (f.state.trim()) q.set("state", f.state.trim().toUpperCase());
  if (f.wfo.trim()) q.set("wfo", f.wfo.trim().toUpperCase().replace(/^K(?=[A-Z]{3}$)/, ""));
  if (f.phen.length) q.set("phen", f.phen.join(","));
  if (f.sig) q.set("sig", f.sig);
  let sts = NaN;
  let ets = NaN;
  if (f.dateMode === "year") {
    sts = Date.UTC(f.year, 0, 1);
    ets = Date.UTC(f.year + 1, 0, 1);
  } else if (f.dateMode === "range") {
    if (f.from) sts = Date.parse(`${f.from}T00:00:00Z`);
    if (f.to) ets = Date.parse(`${f.to}T23:59:59Z`);
  }
  // the server limits nationwide searches (no state / office) to 31 days: search the last 30 of the period
  let note: string | undefined;
  if (!f.state.trim() && !f.wfo.trim() && f.dateMode !== "any") {
    const e = Math.min(Number.isFinite(ets) ? ets : Date.now(), Date.now());
    if (!Number.isFinite(sts) || e - sts > 31 * 864e5) {
      sts = e - 30 * 864e5;
      note = "Nationwide: last 30 days of the period. Add a state or office to search further.";
    }
  }
  if (Number.isFinite(sts)) q.set("sts", isoQ(sts));
  if (Number.isFinite(ets)) q.set("ets", isoQ(ets));
  const flags = [f.pds && "pds", f.emergency && "emergency", f.observed && "observed"].filter(Boolean) as string[];
  if (flags.length) q.set("flags", flags.join(","));
  wRes.value = { ...wRes.value, loading: true, error: undefined, offset };
  try {
    const r = await api.get(`/api/hist/warnings?${q}`);
    // flags are filtered here too in case the server ignores them
    const items: WarnItem[] = (r.items ?? []).filter((w: WarnItem) => (!f.pds || w.flags?.pds) && (!f.emergency || w.flags?.emergency) && (!f.observed || observed(w)));
    wRes.value = { items, total: r.total, offset, loading: false, searched: true, note };
  } catch (e: any) {
    wRes.value = { items: [], offset, loading: false, error: e.message, searched: true };
  }
}

async function pickWarning(w: WarnItem) {
  wSel.value = { item: w, fc: null, loading: true };
  if (w.bbox) fitBox(w.bbox, 9);
  try {
    let g = await api.get(`/api/hist/warning?vtec=${encodeURIComponent(w.vtec)}&year=${w.year}`);
    const fc = g.type === "FeatureCollection" ? g : g.type === "Feature" ? { type: "FeatureCollection", features: [g] } : { type: "FeatureCollection", features: [{ type: "Feature", geometry: g, properties: {} }] };
    if (wSel.value?.item.id !== w.id) return;
    wSel.value = { item: w, fc, loading: false };
    showPreview({ kind: "warning", fc, id: w.id, pinned: false, title: w.event });
    const b = bboxOf(fc) ?? w.bbox;
    if (b) fitBox(b, 9);
  } catch (e: any) {
    if (wSel.value?.item.id === w.id) wSel.value = { item: w, fc: null, loading: false, error: e.message };
  }
}

function openWarning(w: WarnItem, fc: any | null) {
  const b = (fc && bboxOf(fc)) ?? w.bbox ?? ([w.lon - 0.3, w.lat - 0.3, w.lon + 0.3, w.lat + 0.3] as BBox);
  clearPreview(); // the replay draws the warning itself
  histStormsOpen.value = false; // (before fitting the map: no room needed for the window)
  openHistory({ label: `${w.event} · ${w.wfo} #${w.eventid}`, kind: "warning", start: w.issue, end: w.expire, center: fc ? bboxCenter(b) : [w.lon, w.lat], bbox: b, ref: `${w.vtec}|${w.year}` });
  histStormsOpen.value = false;
}

/** Small outline drawing of a GeoJSON geometry (preview inside the window). */
function Outline({ fc, w = 220, h = 150, color = "#fde047" }: { fc: any; w?: number; h?: number; color?: string }) {
  const b = bboxOf(fc);
  if (!b) return null;
  const k = Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
  const sx = (b[2] - b[0]) * k || 0.01;
  const sy = b[3] - b[1] || 0.01;
  const sc = Math.min((w - 16) / sx, (h - 16) / sy);
  const ox = (w - sx * sc) / 2;
  const oy = (h - sy * sc) / 2;
  const P = (c: number[]) => `${(ox + (c[0] - b[0]) * k * sc).toFixed(1)},${(oy + (b[3] - c[1]) * sc).toFixed(1)}`;
  const rings: number[][][] = [];
  const walk = (g: any) => {
    if (!g) return;
    if (g.type === "Polygon") rings.push(...g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach((p: any) => rings.push(...p));
  };
  for (const f of fc.features ?? []) walk(f.geometry);
  return (
    <svg class="hs-outline" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {rings.map((r, i) => (
        <polygon key={i} points={r.map(P).join(" ")} fill={color} fill-opacity={0.15} stroke={color} stroke-width={1.6} />
      ))}
    </svg>
  );
}

function FlagBadges({ w }: { w: WarnItem }) {
  return (
    <>
      {w.flags?.emergency && <span class="hs-flag emerg">EMERGENCY</span>}
      {w.flags?.pds && <span class="hs-flag pds">PDS</span>}
      {observed(w) && <span class="hs-flag obs">Observed</span>}
      {damage(w) && <span class="hs-flag dmg">{damage(w)}</span>}
    </>
  );
}

function WarningsTab() {
  const f = wForm.value;
  const r = wRes.value;
  const sel = wSel.value;
  const set = (fn: (x: typeof f) => void) => {
    const n = { ...wForm.peek(), phen: [...wForm.peek().phen] };
    fn(n);
    wForm.value = n;
  };
  useEffect(() => {
    if (!r.searched && !r.loading) searchWarnings(0);
  }, []);
  const total = r.total ?? (r.items.length === PAGE ? undefined : r.offset + r.items.length);
  const { before, after } = beforeAfter();
  return (
    <div class="hs-tab">
      <form
        class="hs-form"
        onSubmit={(e) => {
          e.preventDefault();
          searchWarnings(0);
        }}
      >
        <div class="hs-frow">
          <div class="chips">
            {PHEN.map(([id, name]) => (
              <button type="button" key={id} class={`chip ${f.phen.includes(id) ? "on" : ""}`} onClick={() => set((x) => (x.phen = x.phen.includes(id) ? x.phen.filter((p) => p !== id) : [...x.phen, id]))}>
                {name}
              </button>
            ))}
          </div>
          <div class="seg sm">
            {(
              [
                ["W", "Warnings"],
                ["A", "Watches"],
                ["", "Both"],
              ] as const
            ).map(([v, l]) => (
              <button type="button" key={v} class={f.sig === v ? "on" : ""} onClick={() => set((x) => (x.sig = v))}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div class="hs-frow">
          <label class="hs-field">
            <span>When</span>
            <select value={f.dateMode === "year" ? String(f.year) : f.dateMode} onChange={(e) => set((x) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === "range" || v === "any") x.dateMode = v;
              else ((x.dateMode = "year"), (x.year = +v));
            })}>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
              <option value="range">Date range…</option>
              <option value="any">Any time</option>
            </select>
          </label>
          {f.dateMode === "range" && (
            <>
              <input type="date" value={f.from} onInput={(e) => set((x) => (x.from = (e.target as HTMLInputElement).value))} />
              <span class="muted">to</span>
              <input type="date" value={f.to} onInput={(e) => set((x) => (x.to = (e.target as HTMLInputElement).value))} />
            </>
          )}
          <label class="hs-field">
            <span>State(s)</span>
            <input class="sm" placeholder="OK,KS" value={f.state} onInput={(e) => set((x) => (x.state = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="hs-field">
            <span>Office</span>
            <input class="xs" placeholder="OUN" value={f.wfo} onInput={(e) => set((x) => (x.wfo = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="hs-field grow">
            <Search size={13} />
            <input placeholder="Text: county, city, headline…" value={f.q} onInput={(e) => set((x) => (x.q = (e.target as HTMLInputElement).value))} />
          </label>
        </div>
        <div class="hs-frow">
          <label class="hs-check">
            <input type="checkbox" checked={f.pds} onChange={(e) => set((x) => (x.pds = (e.target as HTMLInputElement).checked))} /> PDS
          </label>
          <label class="hs-check">
            <input type="checkbox" checked={f.emergency} onChange={(e) => set((x) => (x.emergency = (e.target as HTMLInputElement).checked))} /> Emergency
          </label>
          <label class="hs-check" title="Tornado observed (vs radar indicated), where the warning says so">
            <input type="checkbox" checked={f.observed} onChange={(e) => set((x) => (x.observed = (e.target as HTMLInputElement).checked))} /> Tornado observed
          </label>
          <span class="grow" />
          <button class="btn sm" type="submit" disabled={r.loading}>
            <Search size={13} /> {r.loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      <div class="hs-split">
        <div class="hs-results">
          {r.error ? (
            <div class="hs-empty err">Search failed: {r.error}</div>
          ) : !r.items.length ? (
            <div class="hs-empty muted">{r.loading ? "Searching…" : r.searched ? `No matching alerts${r.note ? `. ${r.note}` : ""}` : ""}</div>
          ) : (
            <table class="hs-table">
              <thead>
                <tr>
                  <th>Issued</th>
                  <th>Event</th>
                  <th>Office</th>
                  <th>Area</th>
                  <th>Duration</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((w) => (
                  <tr key={w.id} class={sel?.item.id === w.id ? "on" : ""} onClick={() => pickWarning(w)} onDblClick={() => openWarning(w, sel?.item.id === w.id ? sel.fc : null)}>
                    <td class="nowrap">{fmtDate(w.issue)}</td>
                    <td class="nowrap">
                      <span class="hs-ev" data-p={w.phen} title={w.vtec}>
                        {w.event.replace(/ (Warning|Watch|Statement)$/, (m) => (m === " Warning" ? "" : m))}
                      </span>
                    </td>
                    <td class="nowrap">
                      {w.wfo} <small class="muted">#{w.eventid}</small>
                    </td>
                    <td class="hs-area" title={w.areaDesc}>
                      {w.areaDesc}
                    </td>
                    <td class="nowrap">{dur(w.expire - w.issue)}</td>
                    <td>
                      <FlagBadges w={w} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.note && r.items.length > 0 && <div class="muted small hs-note">{r.note}</div>}
          {(r.offset > 0 || r.items.length >= PAGE || (total ?? 0) > PAGE) && (
            <div class="hs-pager">
              <button class="btn sm ghost" disabled={r.offset === 0 || r.loading} onClick={() => searchWarnings(Math.max(0, r.offset - PAGE))}>
                ‹ Prev
              </button>
              <span class="muted small">
                {r.offset + 1}–{r.offset + r.items.length}
                {total != null ? ` of ${total}` : ""}
              </span>
              <button class="btn sm ghost" disabled={r.loading || (total != null ? r.offset + PAGE >= total : r.items.length < PAGE)} onClick={() => searchWarnings(r.offset + PAGE)}>
                Next ›
              </button>
            </div>
          )}
        </div>
        <aside class="hs-detail">
          {!sel ? (
            <div class="hs-empty muted">Pick an alert to preview it on the map, then open it in history mode.</div>
          ) : (
            <>
              <h3>
                {sel.item.event} <small class="muted">#{sel.item.eventid}</small>
              </h3>
              <div class="muted small">
                NWS {sel.item.wfo} · {sel.item.states?.join(", ")}
              </div>
              <div class="hs-flags">
                <FlagBadges w={sel.item} />
              </div>
              {sel.fc ? <Outline fc={sel.fc} /> : <div class="hs-outline ph">{sel.loading ? "Loading polygon…" : sel.error ? `Polygon unavailable (${sel.error})` : ""}</div>}
              <dl class="hs-dl">
                <dt>Issued</dt>
                <dd>{fmtDate(sel.item.issue)}</dd>
                <dt>Expired</dt>
                <dd>
                  {fmtDate(sel.item.expire)} <span class="muted">({dur(sel.item.expire - sel.item.issue)})</span>
                </dd>
                <dt>Replay</dt>
                <dd>
                  {fmtDate(sel.item.issue - before * 60_000)} → {fmtDate(sel.item.expire + after * 60_000)}
                </dd>
                <dt>Radar</dt>
                <dd>{(() => {
                  const c = sel.fc ? bboxCenter(bboxOf(sel.fc)!) : [sel.item.lon, sel.item.lat];
                  const n = nearestRadar(c[0], c[1]);
                  return n ? `${n.id} (${Math.round(n.km)} km)` : "—";
                })()}</dd>
              </dl>
              {sel.item.headline && <p class="hs-hl">{sel.item.headline}</p>}
              <p class="hs-areaf muted small">{sel.item.areaDesc}</p>
              <div class="hs-actions">
                <button class="btn sm" onClick={() => openWarning(sel.item, sel.fc)}>
                  <Play size={13} /> Open in history
                </button>
                {sel.item.link && (
                  <button class="btn sm ghost" onClick={() => window.open(sel.item.link, "_blank")}>
                    <ExternalLink size={13} /> IEM
                  </button>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------- tropical ----------
interface TcItem {
  id: string;
  name: string;
  basin: string;
  year: number;
  start: number;
  end: number;
  maxwind: number;
  minpres?: number;
  peak_cat?: any;
  landfalls?: { t: number; lat: number; lon: number; name?: string; vmax?: number }[] | number;
  bbox?: BBox;
}
const BASINS: [string, string][] = [
  ["al", "Atlantic"],
  ["ep", "E Pacific"],
  ["cp", "C Pacific"],
  ["wp", "W Pacific"],
  ["io", "N Indian"],
  ["sh", "Southern"],
  ["all", "All basins"],
];
const MINW: [number, string][] = [
  [0, "Any"],
  [34, "Tropical storm+"],
  [64, "Hurricane / typhoon+"],
  [96, "Major (Cat 3+)"],
  [130, "Cat 4+"],
  [137, "Cat 5"],
];
const tForm = signal({ basin: "al", yearMode: "year" as "year" | "range" | "any", year: thisYear - 1, from: thisYear - 10, to: thisYear, q: "", minwind: 64 });
const tRes = signal<{ items: TcItem[]; loading: boolean; error?: string; searched: boolean }>({ items: [], loading: false, searched: false });
const tSel = signal<{ item: TcItem; fc: any | null; loading: boolean; error?: string; win: [number, number] | null } | null>(null);

async function searchTropical() {
  const f = tForm.value;
  const q = new URLSearchParams({ basin: f.basin });
  if (f.yearMode === "year") q.set("year", String(f.year));
  else if (f.yearMode === "range") (q.set("from", String(f.from)), q.set("to", String(f.to)));
  if (f.q.trim()) q.set("q", f.q.trim());
  if (f.minwind) q.set("minwind", String(f.minwind));
  tRes.value = { ...tRes.value, loading: true, error: undefined };
  try {
    const r = await api.get(`/api/hist/tropical?${q}`);
    tRes.value = { items: r.items ?? [], loading: false, searched: true };
  } catch (e: any) {
    tRes.value = { items: [], loading: false, error: e.message, searched: true };
  }
}

const H6 = 6 * 3600_000;
/** default replay window: the 48 h around the (strongest) landfall, else around the peak */
function defaultWindow(it: TcItem, fc: any): [number, number] {
  const pts = (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Point" && f.properties?.t != null);
  const t0 = pts.length ? Math.min(...pts.map((f: any) => f.properties.t)) : it.start;
  const t1 = pts.length ? Math.max(...pts.map((f: any) => f.properties.t)) : it.end;
  // the strongest landfall (first one when intensities are unknown)
  const lfs = Array.isArray(it.landfalls) ? it.landfalls : [];
  let mid: number | undefined = lfs.length ? lfs.reduce((x, y) => ((y.vmax ?? 0) > (x.vmax ?? 0) ? y : x)).t : undefined;
  if (mid == null) mid = pts.find((f: any) => f.properties.landfall || f.properties.status === "LF" || f.properties.record === "L")?.properties.t;
  if (mid == null && pts.length) mid = pts.reduce((a: any, b: any) => ((b.properties.vmax ?? 0) > (a.properties.vmax ?? 0) ? b : a)).properties.t;
  mid ??= (t0 + t1) / 2;
  let a = Math.max(t0, mid - 24 * 3600_000);
  let b = Math.min(t1, a + 48 * 3600_000);
  a = Math.max(t0, b - 48 * 3600_000);
  return [a, b];
}

async function pickStorm(it: TcItem) {
  tSel.value = { item: it, fc: null, loading: true, win: null };
  if (it.bbox) fitBox(it.bbox, 6);
  try {
    const fc = await api.get(`/api/hist/tropical/${encodeURIComponent(it.id)}`);
    if (tSel.value?.item.id !== it.id) return;
    tSel.value = { item: it, fc, loading: false, win: defaultWindow(it, fc) };
    showPreview({ kind: "tropical", fc, id: it.id, pinned: false, title: it.name });
    const b = bboxOf(fc) ?? it.bbox;
    if (b) fitBox(b, 6);
  } catch (e: any) {
    if (tSel.value?.item.id === it.id) tSel.value = { item: it, fc: null, loading: false, error: e.message, win: [it.start, Math.min(it.end, it.start + 48 * 3600_000)] };
  }
}

function openStorm(it: TcItem, fc: any | null, win: [number, number]) {
  const [a, b] = win;
  const mid = (a + b) / 2;
  const pos = fc ? stormAt(fc, mid) : null;
  // map: the part of the track inside the window, with some margin
  const pts = (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Point" && f.properties.t >= a - H6 && f.properties.t <= b + H6);
  const bb = pts.length ? bboxOf({ type: "FeatureCollection", features: pts }) : it.bbox ?? null;
  const box = bb ? ([bb[0] - 2, bb[1] - 1.5, bb[2] + 2, bb[3] + 1.5] as BBox) : undefined;
  if (fc) showPreview({ kind: "tropical", fc, id: it.id, pinned: true, title: it.name });
  histStormsOpen.value = false;
  openHistory({ label: `${it.name} (${it.year})`, kind: "tropical", start: a, end: b, padded: true, center: pos ? [pos.lon, pos.lat] : box ? bboxCenter(box) : undefined, bbox: box, ref: it.id });
  histStormsOpen.value = false;
}

function catBadge(c: string) {
  return (
    <span class="hs-cat" style={{ background: SS_COLORS[c] }} title={SS_NAMES[c]}>
      {c.replace("C", "Cat ")}
    </span>
  );
}

/** Small track drawing (equirectangular), coloured by category. */
function TrackSvg({ fc, win, w = 300, h = 170 }: { fc: any; win: [number, number] | null; w?: number; h?: number }) {
  const pts = (fc.features ?? []).filter((f: any) => f.geometry?.type === "Point" && f.properties?.t != null).sort((a: any, b: any) => a.properties.t - b.properties.t);
  const b = bboxOf({ type: "FeatureCollection", features: pts });
  if (!b || pts.length < 2) return null;
  const k = Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
  const sx = (b[2] - b[0]) * k || 1;
  const sy = b[3] - b[1] || 1;
  const sc = Math.min((w - 20) / sx, (h - 20) / sy);
  const ox = (w - sx * sc) / 2;
  const oy = (h - sy * sc) / 2;
  const X = (c: number[]) => ox + (c[0] - b[0]) * k * sc;
  const Y = (c: number[]) => oy + (b[3] - c[1]) * sc;
  return (
    <svg class="hs-track" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {pts.slice(0, -1).map((p: any, i: number) => {
        const q = pts[i + 1];
        const inWin = !win || (q.properties.t >= win[0] && p.properties.t <= win[1]);
        return <line key={i} x1={X(p.geometry.coordinates)} y1={Y(p.geometry.coordinates)} x2={X(q.geometry.coordinates)} y2={Y(q.geometry.coordinates)} stroke={SS_COLORS[catOf(p.properties)]} stroke-width={inWin ? 3.2 : 1.6} stroke-opacity={inWin ? 1 : 0.45} stroke-linecap="round" />;
      })}
      {pts.map((p: any, i: number) => (
        <circle key={i} cx={X(p.geometry.coordinates)} cy={Y(p.geometry.coordinates)} r={1.8} fill={SS_COLORS[catOf(p.properties)]} />
      ))}
    </svg>
  );
}

/** Intensity strip over the storm's lifetime with a two-thumb window slider. */
function LifeSlider({ fc, item, win, onWin }: { fc: any; item: TcItem; win: [number, number]; onWin: (w: [number, number]) => void }) {
  const pts = (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Point" && f.properties?.t != null).sort((a: any, b: any) => a.properties.t - b.properties.t);
  const t0 = pts.length ? pts[0].properties.t : item.start;
  const t1 = pts.length ? pts[pts.length - 1].properties.t : item.end;
  const steps = Math.max(1, Math.round((t1 - t0) / H6));
  const toI = (t: number) => Math.round((t - t0) / H6);
  const toT = (i: number) => Math.min(t1, t0 + i * H6);
  const vmax = Math.max(1, ...pts.map((p: any) => p.properties.vmax ?? 0));
  const landfalls = Array.isArray(item.landfalls) ? item.landfalls : [];
  return (
    <div class="hs-life">
      <div class="hs-strip">
        {pts.map((p: any, i: number) => (
          <i key={i} style={{ left: `${((p.properties.t - t0) / (t1 - t0 || 1)) * 100}%`, height: `${Math.max(8, ((p.properties.vmax ?? 0) / vmax) * 100)}%`, background: SS_COLORS[catOf(p.properties)] }} />
        ))}
        {landfalls.map((l, i) => (
          <b key={i} class="hs-lf" style={{ left: `${((l.t - t0) / (t1 - t0 || 1)) * 100}%` }} title={`Landfall${l.name ? `: ${l.name}` : ""} ${fmtDate(l.t)}`} />
        ))}
        <span class="hs-win" style={{ left: `${((win[0] - t0) / (t1 - t0 || 1)) * 100}%`, width: `${((win[1] - win[0]) / (t1 - t0 || 1)) * 100}%` }} />
      </div>
      <div class="hs-dual">
        <input type="range" min={0} max={steps} value={toI(win[0])} onInput={(e) => onWin([Math.min(toT(+(e.target as HTMLInputElement).value), win[1] - H6), win[1]])} />
        <input type="range" min={0} max={steps} value={toI(win[1])} onInput={(e) => onWin([win[0], Math.max(toT(+(e.target as HTMLInputElement).value), win[0] + H6)])} />
      </div>
      <div class="hs-life-lbl small">
        <span>{fmtDate(win[0])}</span>
        <b>{dur(win[1] - win[0])}</b>
        <span>{fmtDate(win[1])}</span>
      </div>
    </div>
  );
}

function TropicalTab() {
  const f = tForm.value;
  const r = tRes.value;
  const sel = tSel.value;
  const set = (fn: (x: typeof f) => void) => {
    const n = { ...tForm.peek() };
    fn(n);
    tForm.value = n;
  };
  useEffect(() => {
    if (!r.searched && !r.loading) searchTropical();
  }, []);
  const yrs = useMemo(() => Array.from({ length: thisYear - 1850 }, (_, i) => thisYear - i), []);
  const peak = (it: TcItem) => catOf({ cat: it.peak_cat, vmax: it.maxwind });
  const nLand = (it: TcItem) => (Array.isArray(it.landfalls) ? it.landfalls.length : it.landfalls ?? 0);
  const tooLong = sel?.win ? sel.win[1] - sel.win[0] > 7 * 86400_000 : false;
  return (
    <div class="hs-tab">
      <form
        class="hs-form"
        onSubmit={(e) => {
          e.preventDefault();
          searchTropical();
        }}
      >
        <div class="hs-frow">
          <div class="seg sm">
            {BASINS.map(([id, l]) => (
              <button type="button" key={id} class={f.basin === id ? "on" : ""} onClick={() => set((x) => (x.basin = id))}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div class="hs-frow">
          <label class="hs-field">
            <span>Season</span>
            <select value={f.yearMode === "year" ? String(f.year) : f.yearMode} onChange={(e) => set((x) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === "range" || v === "any") x.yearMode = v;
              else ((x.yearMode = "year"), (x.year = +v));
            })}>
              {yrs.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
              <option value="range">Year range…</option>
              <option value="any">Any year</option>
            </select>
          </label>
          {f.yearMode === "range" && (
            <>
              <input class="xs" type="number" value={f.from} onChange={(e) => set((x) => (x.from = +(e.target as HTMLInputElement).value))} />
              <span class="muted">to</span>
              <input class="xs" type="number" value={f.to} onChange={(e) => set((x) => (x.to = +(e.target as HTMLInputElement).value))} />
            </>
          )}
          <label class="hs-field">
            <span>Min. intensity</span>
            <select value={String(f.minwind)} onChange={(e) => set((x) => (x.minwind = +(e.target as HTMLSelectElement).value))}>
              {MINW.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label class="hs-field grow">
            <Search size={13} />
            <input placeholder="Storm name" value={f.q} onInput={(e) => set((x) => (x.q = (e.target as HTMLInputElement).value))} />
          </label>
          <button class="btn sm" type="submit" disabled={r.loading}>
            <Search size={13} /> {r.loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      <div class="hs-split">
        <div class="hs-results">
          {r.error ? (
            <div class="hs-empty err">Search failed: {r.error}</div>
          ) : !r.items.length ? (
            <div class="hs-empty muted">{r.loading ? "Searching…" : r.searched ? "No matching storms" : ""}</div>
          ) : (
            <table class="hs-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Year</th>
                  <th>Dates</th>
                  <th>Peak</th>
                  <th>Max wind</th>
                  <th>Min pres.</th>
                  <th>Landfalls</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((it) => (
                  <tr key={it.id} class={sel?.item.id === it.id ? "on" : ""} onClick={() => pickStorm(it)}>
                    <td>
                      <b>{it.name}</b> <small class="muted">{it.basin.toUpperCase()}</small>
                    </td>
                    <td>{it.year}</td>
                    <td class="nowrap">
                      {fmtDate(it.start, false)} – {fmtDate(it.end, false).replace(/,? \d{4}$/, "")}
                    </td>
                    <td>{catBadge(peak(it))}</td>
                    <td>{it.maxwind} kt</td>
                    <td>{it.minpres ? `${it.minpres} mb` : "—"}</td>
                    <td>{nLand(it) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <aside class="hs-detail">
          {!sel ? (
            <div class="hs-empty muted">Pick a storm to draw its best track on the map.</div>
          ) : (
            <>
              <h3>
                {sel.item.name} <small class="muted">{sel.item.year}</small> {catBadge(peak(sel.item))}
              </h3>
              <div class="muted small">
                {sel.item.maxwind} kt{sel.item.minpres ? ` · ${sel.item.minpres} mb` : ""} · {fmtDate(sel.item.start, false)} – {fmtDate(sel.item.end, false)}
              </div>
              {sel.fc ? <TrackSvg fc={sel.fc} win={sel.win} /> : <div class="hs-outline ph">{sel.loading ? "Loading track…" : `Track unavailable (${sel.error})`}</div>}
              <div class="hs-legend">
                {["TD", "TS", "C1", "C2", "C3", "C4", "C5"].map((c) => (
                  <span key={c}>
                    <i style={{ background: SS_COLORS[c] }} />
                    {c.replace("C", "")}
                  </span>
                ))}
              </div>
              {sel.win && (
                <>
                  <div class="hs-sub">Replay window</div>
                  <LifeSlider fc={sel.fc} item={sel.item} win={sel.win} onWin={(w) => (tSel.value = { ...sel, win: w })} />
                  {Array.isArray(sel.item.landfalls) && sel.item.landfalls.length > 0 && (
                    <div class="chips hs-lfs">
                      {sel.item.landfalls.map((l, i) => (
                        <button key={i} class="chip" title={fmtDate(l.t)} onClick={() => (tSel.value = { ...sel, win: [Math.max(sel.item.start, l.t - 24 * 3600_000), Math.min(sel.item.end, l.t + 24 * 3600_000)] })}>
                          Landfall {l.name ?? i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  {tooLong && <p class="hist-err small">History windows are 7 days at most: the last 7 days of this window will load.</p>}
                </>
              )}
              <p class="muted small hs-note">Radar history is available for US and European landfalls only; elsewhere the track replays over the other layers.</p>
              <div class="hs-actions">
                <button class="btn sm" disabled={!sel.win} onClick={() => sel.win && openStorm(sel.item, sel.fc, sel.win)}>
                  <Play size={13} /> Open in history
                </button>
                <button class="btn sm ghost" onClick={() => ((tSel.value = null), clearPreview())}>
                  Clear map
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------- p7: generic replay-window slider (tornadoes, "Replay this" on alerts) ----------

/** Two-handle window slider over [min, max] with an optional event span marked on the strip. */
export function WindowSlider({ min, max, win, onWin, step = 5 * 60_000, event }: { min: number; max: number; win: [number, number]; onWin: (w: [number, number]) => void; step?: number; event?: [number, number] }) {
  const steps = Math.max(1, Math.round((max - min) / step));
  const toI = (t: number) => Math.round((t - min) / step);
  const toT = (i: number) => Math.min(max, min + i * step);
  const pct = (t: number) => `${((t - min) / (max - min || 1)) * 100}%`;
  return (
    <div class="hs-life hs-wslider">
      <div class="hs-strip">
        {event && <i class="hs-ev-span" style={{ left: pct(event[0]), width: `${((Math.max(event[1], event[0] + step) - event[0]) / (max - min || 1)) * 100}%`, height: "100%" }} title={`Event: ${fmtDate(event[0])} → ${fmtDate(event[1])}`} />}
        <span class="hs-win" style={{ left: pct(win[0]), width: `${((win[1] - win[0]) / (max - min || 1)) * 100}%` }} />
      </div>
      <div class="hs-dual">
        <input type="range" aria-label="Window start" min={0} max={steps} value={toI(win[0])} onInput={(e) => onWin([Math.min(toT(+(e.target as HTMLInputElement).value), win[1] - step), win[1]])} />
        <input type="range" aria-label="Window end" min={0} max={steps} value={toI(win[1])} onInput={(e) => onWin([win[0], Math.max(toT(+(e.target as HTMLInputElement).value), win[0] + step)])} />
      </div>
      <div class="hs-life-lbl small">
        <span>{fmtDate(win[0])}</span>
        <b>{dur(win[1] - win[0])}</b>
        <span>{fmtDate(win[1])}</span>
      </div>
    </div>
  );
}

// ---------- p7: tornadoes (SPC database 1950–2024) ----------
interface TorItem {
  om: number;
  date: number;
  mag: number | null;
  inj: number;
  fat: number;
  len_mi: number;
  wid_yd: number;
  st: string;
  geom: any;
  key: string;
}
/** EFU, EF0…EF5 (same as the damage-survey overlays; not imported to keep p6defs out of this module's import order) */
const EF_COLORS = ["#9ca3af", "#60a5fa", "#22c55e", "#facc15", "#f97316", "#ef4444", "#d946ef"];
const TOR_FIRST = 1950;
const TOR_LAST = 2024;
/** NEXRAD Level II archive (NCEI / AWS) starts in 1991 for the first sites. */
const L2_FIRST = Date.UTC(1991, 5, 1);
const torForm = signal({ mode: "years" as "years" | "dates", y0: 2011, y1: TOR_LAST, d0: "2013-05-20", d1: "2013-05-20", states: "", minmag: 2, minInj: 0, minFat: 0, area: "view" as "view" | "all", sort: "date" as "date" | "mag" | "fat" | "len" });
const torRes = signal<{ items: TorItem[]; total: number; capped: boolean; loading: boolean; error?: string; searched: boolean }>({ items: [], total: 0, capped: false, loading: false, searched: false });
const torSel = signal<{ item: TorItem; win: [number, number] } | null>(null);
const torShowAll = signal(true);
const TOR_LIMIT = 500;

const efOf = (t: TorItem) => (t.mag == null || t.mag < 0 ? -1 : t.mag);
const efLabel = (t: TorItem) => `${new Date(t.date).getUTCFullYear() < 2007 ? "F" : "EF"}${efOf(t) < 0 ? "U" : efOf(t)}`;
const efColor = (t: TorItem) => EF_COLORS[efOf(t) + 1] ?? EF_COLORS[0];
/** rough on-ground time: SPC has no end time; ~30 mph forward speed, at least 10 min */
const torSpan = (t: TorItem): [number, number] => [t.date, t.date + Math.max(10 * 60_000, ((t.len_mi || 0) / 30) * 3600_000)];

async function searchTornadoes() {
  const f = torForm.value;
  const q = new URLSearchParams({ minmag: String(Math.max(0, f.minmag)) });
  if (f.mode === "years") {
    q.set("from", String(Math.min(f.y0, f.y1)));
    q.set("to", String(Math.max(f.y0, f.y1)));
  } else {
    if (f.d0) q.set("from", f.d0);
    if (f.d1) q.set("to", f.d1);
  }
  const m = mapRef.value;
  if (f.area === "view" && m) {
    const b = m.getBounds();
    q.set("bbox", [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(","));
  }
  torRes.value = { ...torRes.value, loading: true, error: undefined };
  try {
    const r = await api.get(`/api/ovl/tornadohist?${q}`);
    const sts = f.states
      .toUpperCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
    let items: TorItem[] = (r.features ?? []).map((ft: any) => ({ ...ft.properties, date: +ft.properties.date, geom: ft.geometry, key: `${ft.properties.om}-${ft.properties.date}` }));
    items = items.filter((t) => (!sts.length || sts.includes(t.st)) && (t.inj ?? 0) >= f.minInj && (t.fat ?? 0) >= f.minFat);
    const total = items.length;
    sortTor(items, f.sort);
    torRes.value = { items: items.slice(0, TOR_LIMIT), total, capped: !!r.capped, loading: false, searched: true };
    torSel.value = null;
    drawTor();
  } catch (e: any) {
    torRes.value = { items: [], total: 0, capped: false, loading: false, error: e.message, searched: true };
  }
}
function sortTor(items: TorItem[], by: string) {
  const cmp: Record<string, (a: TorItem, b: TorItem) => number> = {
    date: (a, b) => b.date - a.date,
    mag: (a, b) => efOf(b) - efOf(a) || b.date - a.date,
    fat: (a, b) => b.fat - a.fat || b.inj - a.inj,
    len: (a, b) => (b.len_mi || 0) - (a.len_mi || 0),
  };
  items.sort(cmp[by] ?? cmp.date);
}

/** Selected track (bold) plus, optionally, every result (thin), coloured by rating. */
function drawTor() {
  const sel = torSel.value?.item;
  const list = torShowAll.value ? torRes.value.items : sel ? [sel] : [];
  if (!list.length) return clearPreview();
  const feats = list.map((t) => ({ type: "Feature", geometry: t.geom, properties: { _c: efColor(t), _sel: sel && t.key === sel.key ? 1 : 0 } }));
  showPreview({ kind: "tornado", fc: { type: "FeatureCollection", features: feats }, id: sel?.key ?? "tor-all", pinned: false, title: "Tornadoes" });
}

function pickTornado(t: TorItem) {
  const { before, after } = beforeAfter();
  const [a, b] = torSpan(t);
  torSel.value = { item: t, win: [a - before * 60_000, b + after * 60_000] };
  drawTor();
  const bb = bboxOf(t.geom);
  if (bb) fitBox([bb[0] - 0.15, bb[1] - 0.15, bb[2] + 0.15, bb[3] + 0.15], 10);
}

function openTornado(t: TorItem, win: [number, number]) {
  const bb = bboxOf(t.geom)!;
  const box: BBox = [bb[0] - 0.2, bb[1] - 0.2, bb[2] + 0.2, bb[3] + 0.2];
  // keep the track drawn (pinned) during the replay
  showPreview({ kind: "tornado", fc: { type: "FeatureCollection", features: [{ type: "Feature", geometry: t.geom, properties: { _c: efColor(t), _sel: 1 } }] }, id: t.key, pinned: true, title: `${efLabel(t)} tornado` });
  histStormsOpen.value = false;
  openHistory({ label: `${efLabel(t)} tornado · ${t.st} ${fmtDate(t.date, false)}`, kind: "warning", start: win[0], end: win[1], padded: true, center: bboxCenter(box), bbox: box, ref: `tor:${t.om}:${t.date}` });
}

function TornadoTab() {
  const f = torForm.value;
  const r = torRes.value;
  const sel = torSel.value;
  void torShowAll.value;
  const set = (fn: (x: typeof f) => void) => {
    const n = { ...torForm.peek() };
    fn(n);
    torForm.value = n;
  };
  const yrs = useMemo(() => Array.from({ length: TOR_LAST - TOR_FIRST + 1 }, (_, i) => TOR_LAST - i), []);
  const num = (k: "minInj" | "minFat") => (e: Event) => set((x) => (x[k] = Math.max(0, +(e.target as HTMLInputElement).value || 0)));
  const canReplay = sel && sel.item.date >= L2_FIRST;
  return (
    <div class="hs-tab">
      <form
        class="hs-form"
        onSubmit={(e) => {
          e.preventDefault();
          searchTornadoes();
        }}
      >
        <div class="hs-frow">
          <div class="seg sm">
            <button type="button" class={f.mode === "years" ? "on" : ""} onClick={() => set((x) => (x.mode = "years"))}>
              Years
            </button>
            <button type="button" class={f.mode === "dates" ? "on" : ""} onClick={() => set((x) => (x.mode = "dates"))}>
              Dates
            </button>
          </div>
          {f.mode === "years" ? (
            <>
              <select value={f.y0} onChange={(e) => set((x) => (x.y0 = +(e.target as HTMLSelectElement).value))}>
                {yrs.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <span class="muted">to</span>
              <select value={f.y1} onChange={(e) => set((x) => (x.y1 = +(e.target as HTMLSelectElement).value))}>
                {yrs.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <input type="date" min="1950-01-01" max="2024-12-31" value={f.d0} onChange={(e) => set((x) => (x.d0 = (e.target as HTMLInputElement).value))} />
              <span class="muted">to</span>
              <input type="date" min="1950-01-01" max="2024-12-31" value={f.d1} onChange={(e) => set((x) => (x.d1 = (e.target as HTMLInputElement).value))} />
            </>
          )}
          <label class="hs-field">
            <span>Rating</span>
            <select value={f.minmag} onChange={(e) => set((x) => (x.minmag = +(e.target as HTMLSelectElement).value))}>
              <option value={0}>All (F/EF0+)</option>
              <option value={1}>EF1+</option>
              <option value={2}>EF2+</option>
              <option value={3}>EF3+ (strong)</option>
              <option value={4}>EF4+ (violent)</option>
              <option value={5}>EF5</option>
            </select>
          </label>
        </div>
        <div class="hs-frow">
          <label class="hs-field">
            <span>State(s)</span>
            <input type="text" placeholder="OK, KS" size={8} value={f.states} onInput={(e) => set((x) => (x.states = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="hs-field">
            <span>Min injuries</span>
            <input type="number" min={0} step={1} value={f.minInj} onChange={num("minInj")} />
          </label>
          <label class="hs-field">
            <span>Min deaths</span>
            <input type="number" min={0} step={1} value={f.minFat} onChange={num("minFat")} />
          </label>
          <label class="hs-field">
            <span>Area</span>
            <select value={f.area} onChange={(e) => set((x) => (x.area = (e.target as HTMLSelectElement).value as any))}>
              <option value="view">Current map view</option>
              <option value="all">Anywhere (US)</option>
            </select>
          </label>
          <button class="btn sm" type="submit" disabled={r.loading}>
            <Search size={13} /> {r.loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      <div class="hs-split">
        <div class="hs-results">
          {r.error ? (
            <div class="hs-empty err">Search failed: {r.error}</div>
          ) : !r.items.length ? (
            <div class="hs-empty muted">{r.loading ? "Searching…" : r.searched ? "No matching tornadoes" : "Search the SPC tornado database (1950–2024): pick years or dates, rating, states and casualties; the current map view limits the area."}</div>
          ) : (
            <>
              <div class="hs-torbar small">
                <span class="muted">
                  {r.total.toLocaleString()} tornadoes{r.total > r.items.length ? ` · showing ${r.items.length}` : ""}
                  {r.capped ? " · server cap reached, narrow the search" : ""}
                </span>
                <span class="rp-fill" />
                <label class="hs-check">
                  <input type="checkbox" checked={torShowAll.value} onChange={(e) => ((torShowAll.value = (e.target as HTMLInputElement).checked), drawTor())} /> Show all results on map
                </label>
                <select
                  title="Sort"
                  value={f.sort}
                  onChange={(e) => {
                    set((x) => (x.sort = (e.target as HTMLSelectElement).value as any));
                    const it = [...r.items];
                    sortTor(it, (e.target as HTMLSelectElement).value);
                    torRes.value = { ...r, items: it };
                  }}
                >
                  <option value="date">Newest first</option>
                  <option value="mag">Strongest first</option>
                  <option value="fat">Most casualties</option>
                  <option value="len">Longest track</option>
                </select>
              </div>
              <table class="hs-table hs-tor">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Rating</th>
                    <th>State</th>
                    <th>Length</th>
                    <th>Width</th>
                    <th>Inj / deaths</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((t) => (
                    <tr key={t.key} class={sel?.item.key === t.key ? "on" : ""} onClick={() => pickTornado(t)} onDblClick={() => t.date >= L2_FIRST && openTornado(t, torSel.value?.win ?? torSpan(t))}>
                      <td class="nowrap">{fmtDate(t.date)}</td>
                      <td>
                        <span class="hs-ef" style={{ background: efColor(t) }}>
                          {efLabel(t)}
                        </span>
                      </td>
                      <td>{t.st}</td>
                      <td class="nowrap">{t.len_mi ? `${(+t.len_mi).toFixed(1)} mi` : "—"}</td>
                      <td class="nowrap">{t.wid_yd ? `${Math.round(+t.wid_yd)} yd` : "—"}</td>
                      <td class={t.fat ? "hs-fat" : ""}>
                        {t.inj} / {t.fat}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <aside class="hs-detail">
          {!sel ? (
            <div class="hs-empty muted">Pick a tornado to draw its track on the map, then open it in history mode (1991 and later).</div>
          ) : (
            <>
              <h3>
                <span class="hs-ef" style={{ background: efColor(sel.item) }}>
                  {efLabel(sel.item)}
                </span>{" "}
                tornado · {sel.item.st}
              </h3>
              <dl class="hs-dl">
                <dt>Touchdown</dt>
                <dd>{fmtDate(sel.item.date)}</dd>
                <dt>Path</dt>
                <dd>
                  {sel.item.len_mi ? `${(+sel.item.len_mi).toFixed(1)} mi` : "—"} long · {sel.item.wid_yd ? `${Math.round(+sel.item.wid_yd)} yd` : "—"} wide
                </dd>
                <dt>Injuries</dt>
                <dd>{sel.item.inj}</dd>
                <dt>Deaths</dt>
                <dd>{sel.item.fat}</dd>
                <dt>Radar</dt>
                <dd>{(() => {
                  const bb = bboxOf(sel.item.geom);
                  const n = bb ? nearestRadar(...bboxCenter(bb)) : null;
                  return n ? `${n.id} (${Math.round(n.km)} km)` : "—";
                })()}</dd>
              </dl>
              {canReplay ? (
                <>
                  <div class="hs-sub">Replay window</div>
                  <WindowSlider min={torSpan(sel.item)[0] - 6 * 3600_000} max={torSpan(sel.item)[1] + 6 * 3600_000} win={sel.win} event={torSpan(sel.item)} onWin={(w) => (torSel.value = { ...sel, win: w })} />
                </>
              ) : (
                <p class="muted small hs-note">Radar replay needs the NEXRAD Level II archive, which starts in 1991 (most sites 1995+): this tornado is shown on the map only.</p>
              )}
              <p class="muted small hs-note">SPC times are the touchdown (no end time): the window covers about {dur(torSpan(sel.item)[1] - torSpan(sel.item)[0])} on the ground (track length at ~30 mph) plus the before/after margins.</p>
              <div class="hs-actions">
                <button class="btn sm" disabled={!canReplay} title={canReplay ? "" : "No Level II radar archive before 1991"} onClick={() => openTornado(sel.item, sel.win)}>
                  <Play size={13} /> Open in history
                </button>
                <button class="btn sm ghost" onClick={() => ((torSel.value = null), drawTor())}>
                  Deselect
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}


// ---------- p7: "Replay this" popover on alerts ----------

/** Replay window for an alert: issue −6 h … expire +6 h (never past now), defaulting to the
 * before/after margins; Open enters history mode for exactly that window. */
export function ReplayPopover({ a, onClose }: { a: any; onClose: () => void }) {
  const span = alertEventSpan(a);
  const now = Date.now();
  const min = span.start - 6 * 3600_000;
  const max = Math.max(min + 3600_000, Math.min(span.end + 6 * 3600_000, now));
  const { before, after } = beforeAfter();
  const [win, setWin] = useState<[number, number]>(() => [Math.max(min, span.start - before * 60_000), Math.min(max, span.end + after * 60_000)]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  const tooLong = win[1] - win[0] > 7 * 86400_000;
  return (
    <div class="ad-replay-pop" role="dialog" aria-label="Replay window">
      <div class="ad-rp-head">
        <b>Replay window</b>
        <span class="rp-fill" />
        <button class="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <WindowSlider min={min} max={max} win={win} onWin={setWin} event={[span.start, Math.min(span.end, max)]} />
      <div class="ad-rp-foot">
        <span class="muted small">Shaded: the alert ({dur(span.end - span.start)}). Radar: nearest archive site.</span>
        <span class="rp-fill" />
        <button class="btn sm ghost" onClick={() => setWin([Math.max(min, span.start - before * 60_000), Math.min(max, span.end + after * 60_000)])} title={`Reset to −${before} / +${after} min`}>
          Reset
        </button>
        <button
          class="btn sm"
          onClick={() => {
            onClose();
            replayAlert(a, win);
          }}
        >
          <Play size={13} /> Open
        </button>
      </div>
      {tooLong && <p class="hist-err small">History windows are 7 days at most: the last 7 days will load.</p>}
    </div>
  );
}

// ---------- recent ----------
async function reopen(r: Settings["histRecent"][number]) {
  histStormsOpen.value = false;
  if (r.site && (settings.value.radar.site !== r.site || settings.value.weather.kind !== "radar")) selectSite(r.site);
  enterHistory(r.start, r.end);
  if (r.bbox) fitBox(r.bbox, r.kind === "tropical" ? 7 : 9);
  addRecent({ label: r.label, kind: r.kind, start: r.start, end: r.end, site: r.site, bbox: r.bbox, ref: r.ref });
  histStormsOpen.value = false;
  if (r.kind === "tropical" && r.ref) {
    try {
      const fc = await api.get(`/api/hist/tropical/${encodeURIComponent(r.ref)}`);
      showPreview({ kind: "tropical", fc, id: r.ref, pinned: true, title: r.label.replace(/ \(\d{4}\)$/, "") });
    } catch {
      /* track unavailable: replay without it */
    }
  }
}
type Settings = typeof settings.value;

function RecentTab() {
  const list = settings.value.histRecent ?? [];
  if (!list.length) return <div class="hs-empty muted">History ranges you open (from here, “Replay this” on alerts, or the history picker) are listed here.</div>;
  return (
    <div class="hs-tab">
      <table class="hs-table hs-recent">
        <thead>
          <tr>
            <th />
            <th>What</th>
            <th>Range</th>
            <th>Length</th>
            <th>Radar</th>
            <th>Opened</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={`${r.at}-${i}`} onDblClick={() => reopen(r)}>
              <td class="hs-kind">{r.kind === "tropical" ? <Wind size={14} /> : r.kind === "warning" ? <TriangleAlert size={14} /> : <Clock size={14} />}</td>
              <td>{r.label}</td>
              <td class="nowrap">
                {fmtDate(r.start)} → {fmtDate(r.end)}
              </td>
              <td>{dur(r.end - r.start)}</td>
              <td>{r.site ?? "—"}</td>
              <td class="muted small nowrap">{fmtDate(r.at)}</td>
              <td class="nowrap">
                <button class="btn sm" onClick={() => reopen(r)}>
                  <RotateCcw size={12} /> Open
                </button>
                <button class="icon-btn" title="Remove" onClick={() => update((s) => (s.histRecent = s.histRecent.filter((_, k) => k !== i)))}>
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="hs-actions">
        <button class="btn sm ghost" onClick={() => update((s) => (s.histRecent = []))}>
          <Trash2 size={13} /> Clear all
        </button>
      </div>
    </div>
  );
}

// ---------- window ----------
function switchTab(id: "warnings" | "tropical" | "tornado" | "recent") {
  tab.value = id;
  clearPreview(true);
  const w = wSel.value;
  const t = tSel.value;
  if (id === "warnings" && w?.fc) showPreview({ kind: "warning", fc: w.fc, id: w.item.id, pinned: false, title: w.item.event });
  if (id === "tropical" && t?.fc && !preview.value) showPreview({ kind: "tropical", fc: t.fc, id: t.item.id, pinned: false, title: t.item.name });
  if (id === "tornado" && !preview.value) drawTor();
}

export function HistStorms() {
  if (!histStormsOpen.value) return null;
  const close = () => {
    histStormsOpen.value = false;
    clearPreview(true);
  };
  const t = tab.value;
  void preview.value;
  return (
    <CenterModal
      cls="hstorm"
      title="Historical Storms"
      sub="Past warnings, watches, tropical cyclones and tornadoes: open history mode around them"
      icon={<History size={18} />}
      onClose={close}
      actions={
        <>
          <span class="muted small">Window</span>
          <BeforeAfter />
        </>
      }
    >
      <div class="hs-tabs">
        {(
          [
            ["warnings", "Warnings", TriangleAlert],
            ["tropical", "Tropical", Wind],
            ["tornado", "Tornadoes", Tornado],
            ["recent", "Recent", Clock],
          ] as const
        ).map(([id, l, Icon]) => (
          <button key={id} class={t === id ? "on" : ""} onClick={() => switchTab(id)}>
            <Icon size={14} /> {l}
            {id === "recent" && (settings.value.histRecent?.length ?? 0) > 0 && <small>{settings.value.histRecent.length}</small>}
          </button>
        ))}
      </div>
      {t === "warnings" && <WarningsTab />}
      {t === "tropical" && <TropicalTab />}
      {t === "tornado" && <TornadoTab />}
      {t === "recent" && <RecentTab />}
    </CenterModal>
  );
}

