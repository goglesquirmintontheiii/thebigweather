// models 0.8 (Phase 8): model reports — what the models flagged over a time window, as a timeline
// strip + list, filtered by model / target / map view, exported as CSV or GeoJSON and shared with the
// Team room (collab notes).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { FileText, Download, Users, RefreshCw, Crosshair, MapPinned } from "lucide-preact";
import { models } from "../../ml/client";
import { reports, reportsState, loadReports, exportReports, type Report, type ReportQuery } from "../../ml/m8";
import { tmeta, LEVEL_COLOR, levelOf } from "../../ml/targets";
import { histRange } from "../../anim";
import { mapRef } from "../../map/mapview";
import { saveFile } from "../../saveio";
import { team, teamStatus, addNote } from "../../share/collab";
import { toast } from "../../store";
import { fmtTime } from "../../util";
import { TIcon } from "./common";

const SPANS: [string, string, number][] = [["6h", "6 h", 6], ["24h", "24 h", 24], ["3d", "3 days", 72], ["7d", "7 days", 168]];

export function ReportsTab() {
  const [span, setSpan] = useState<string>(histRange.value ? "hist" : "24h");
  const [inView, setInView] = useState(false);
  const [mSel, setMSel] = useState<string[]>([]);
  const [tSel, setTSel] = useState("");
  const [sel, setSel] = useState<string>("");
  const [tick, setTick] = useState(0);
  const q = useMemo<ReportQuery>(() => {
    const h = histRange.value;
    const now = Date.now();
    const hrs = SPANS.find(([k]) => k === span)?.[2] ?? 24;
    const from = span === "hist" && h ? h.start : now - hrs * 3600e3;
    const to = span === "hist" && h ? h.end : now;
    let bbox: [number, number, number, number] | null = null;
    const b = inView ? mapRef.value?.getBounds() : null;
    if (b) bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    return { from, to, bbox, models: mSel.length ? mSel : undefined };
  }, [span, inView, mSel.join(","), tick, histRange.value]);
  useEffect(() => {
    loadReports(q);
  }, [q]);
  // live: ml_report pushes land in `reports`; filter here too (time window, view, models)
  const list = reports.value.filter((r) => r.t >= q.from - 60_000 && (!tSel || r.target === tSel) && (!q.models || q.models.includes(r.model_id)) && (!q.bbox || (r.lon >= q.bbox[0] && r.lon <= q.bbox[2] && r.lat >= q.bbox[1] && r.lat <= q.bbox[3])));
  const to = Math.max(q.to, ...list.map((r) => r.t));
  const mIds = [...new Set(reports.value.map((r) => r.model_id))];
  const tIds = [...new Set(reports.value.map((r) => r.target))];
  const fly = (r: Report) => {
    setSel(r.key);
    if (Number.isFinite(r.lat)) mapRef.value?.flyTo({ center: [r.lon, r.lat], zoom: Math.max(mapRef.value.getZoom(), 7.5), duration: 800 });
  };
  const doExport = async (fmt: "csv" | "geojson") => {
    const { name, blob } = await exportReports(q, fmt, list);
    const f = await saveFile(name, blob, blob.type);
    if (f) toast(`Saved ${f}`);
  };
  const share = () => {
    if (!team.value || teamStatus.value !== "online") return;
    const top = list.slice(0, 12).map((r) => `• ${fmtTime(r.t, true)} ${tmeta(r.target).code} ${Math.round(r.prob * 100)}% · ${r.model_name}${r.site ? ` · ${r.site}` : ""}${r.text ? ` — ${r.text}` : ""}`);
    addNote(`Model reports ${fmtTime(q.from, true)} → ${fmtTime(q.to, true)}: ${list.length} report${list.length === 1 ? "" : "s"}\n${top.join("\n")}${list.length > top.length ? `\n…and ${list.length - top.length} more` : ""}`, false);
    toast(`Shared ${list.length} reports with ${team.value.name}`);
  };
  const st = reportsState.value;
  return (
    <div class="m8-reports">
      <div class="m8-rep-tools">
        <div class="seg">
          {histRange.value && (
            <button class={span === "hist" ? "on" : ""} onClick={() => setSpan("hist")} title="The history-mode window">
              History range
            </button>
          )}
          {SPANS.map(([k, l]) => (
            <button key={k} class={span === k ? "on" : ""} onClick={() => setSpan(k)}>
              {l}
            </button>
          ))}
        </div>
        <button class={`chip ${inView ? "on" : ""}`} onClick={() => setInView(!inView)} title="Only reports inside the map view">
          <MapPinned size={12} /> In map view
        </button>
        <select value={tSel} onChange={(e) => setTSel((e.target as HTMLSelectElement).value)}>
          <option value="">All targets</option>
          {tIds.map((t) => (
            <option key={t} value={t}>
              {tmeta(t).name}
            </option>
          ))}
        </select>
        <span class="m8-grow" />
        <button class="icon-btn" title="Refresh" onClick={() => setTick(tick + 1)}>
          <RefreshCw size={14} class={st.loading ? "spin" : ""} />
        </button>
        <button class="btn sm ghost" disabled={!list.length} onClick={() => doExport("csv")}>
          <Download size={13} /> CSV
        </button>
        <button class="btn sm ghost" disabled={!list.length} onClick={() => doExport("geojson")}>
          <Download size={13} /> GeoJSON
        </button>
        <button class="btn sm ghost" disabled={!list.length || teamStatus.value !== "online"} title={teamStatus.value === "online" ? `Post a summary to ${team.value?.name ?? "the team"} (Team panel)` : "Join a Team room first (Team panel)"} onClick={share}>
          <Users size={13} /> Share to Team
        </button>
      </div>
      <div class="ml-chips m8-rep-models">
        {mIds.map((id) => {
          const m = models.value.find((x) => x.id === id);
          const on = mSel.includes(id);
          const n = reports.value.filter((r) => r.model_id === id).length;
          return (
            <button key={id} class={`chip ${on ? "on" : ""}`} onClick={() => setMSel(on ? mSel.filter((x) => x !== id) : [...mSel, id])}>
              <TIcon t={m?.target ?? reports.value.find((r) => r.model_id === id)?.target ?? "custom"} size={14} /> {m?.name ?? reports.value.find((r) => r.model_id === id)?.model_name ?? id} <small>{n}</small>
            </button>
          );
        })}
      </div>
      {st.error && <div class="ml-err">{st.error}</div>}
      <Strip list={list} from={q.from} to={to} sel={sel} onPick={fly} />
      <div class="m8-rep-list">
        {list.slice(0, 400).map((r) => (
          <button key={r.key} class={`ml-dl ${sel === r.key ? "on" : ""}`} onClick={() => fly(r)}>
            <TIcon t={r.target} size={18} />
            <span class="ml-dl-p" style={{ "--lc": LEVEL_COLOR[(r.level as "low") ?? levelOf(r.prob)] ?? LEVEL_COLOR[levelOf(r.prob)] }}>
              {Math.round(r.prob * 100)}%
            </span>
            <span class="ml-dl-main">
              <span>
                <b>{tmeta(r.target).code}</b> {r.model_name}
                {r.verified === true ? <em class="m8-ver ok"> verified</em> : r.verified === false ? <em class="m8-ver no"> unverified</em> : null}
              </span>
              <small>
                {fmtTime(r.t, true)}
                {r.site ? ` · ${r.site}` : ""}
                {Number.isFinite(r.lat) ? ` · ${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}` : ""}
                {r.text ? ` · ${r.text}` : ""}
              </small>
            </span>
            <Crosshair size={13} class="muted" />
          </button>
        ))}
        {!list.length && !st.loading && (
          <div class="ml-empty">
            <FileText size={18} /> No model reports in this window.
          </div>
        )}
      </div>
    </div>
  );
}

/** the window as a strip: one dot per report (x = time, y = probability, colour = target) */
function Strip({ list, from, to, sel, onPick }: { list: Report[]; from: number; to: number; sel: string; onPick: (r: Report) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 92, pad = 26, top = 8, bot = 20;
  const span = Math.max(1, to - from);
  const x = (t: number) => pad + ((t - from) / span) * (w - pad - 8);
  const y = (p: number) => top + (1 - p) * (H - top - bot);
  // ticks: hours (≤ 1 day), 6 h (≤ 3 days), days
  const step = span <= 26 * 3600e3 ? 3 * 3600e3 : span <= 4 * 86400e3 ? 12 * 3600e3 : 86400e3;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  // per-hour counts as a faint histogram
  const nb = Math.min(120, Math.max(12, Math.round(w / 10)));
  const bins = new Array(nb).fill(0);
  for (const r of list) bins[Math.min(nb - 1, Math.max(0, Math.floor(((r.t - from) / span) * nb)))]++;
  const bmax = Math.max(1, ...bins);
  return (
    <div class="m8-strip" ref={ref}>
      <svg width={w} height={H}>
        {[0.25, 0.5, 0.75].map((p) => (
          <line key={p} x1={pad} x2={w - 8} y1={y(p)} y2={y(p)} class="m8-grid" />
        ))}
        <text x={2} y={y(1) + 4} class="m8-ax">100%</text>
        <text x={8} y={y(0.5) + 4} class="m8-ax">50%</text>
        {bins.map((b, i) => (b ? <rect key={i} x={pad + (i / nb) * (w - pad - 8)} width={Math.max(1, (w - pad - 8) / nb - 1)} y={H - bot - (b / bmax) * 22} height={(b / bmax) * 22} class="m8-hbar" /> : null))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top} y2={H - bot} class="m8-grid" />
            <text x={x(t)} y={H - 5} class="m8-ax" text-anchor="middle">
              {step >= 86400e3 ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </text>
          </g>
        ))}
        {list.map((r) => (
          <circle key={r.key} cx={x(r.t)} cy={y(r.prob)} r={sel === r.key ? 6 : 4} fill={tmeta(r.target).color} class={`m8-dot ${sel === r.key ? "on" : ""}`} onClick={() => onPick(r)}>
            <title>{`${fmtTime(r.t, true)} · ${r.model_name} · ${Math.round(r.prob * 100)}%${r.site ? ` · ${r.site}` : ""}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
