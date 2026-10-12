// Extra controls in some layers' settings windows (storm table, Kp, traffic key), plus the
// floating storm table.

import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { settings, update } from "../store";
import { api } from "../api";
import { mapRef } from "../map/mapview";
import { ovlStatus, ovlMeta, refreshOverlay } from "../overlays/manager";
import type { FeedMeta } from "../overlays/roadtraffic";
import { stormCells, cellFlags, hasTvs, mesoRank, hasHail, fmtKt } from "../overlays/stormcells";
import { siteFor } from "../overlays/rotation";
import { NO_KEY } from "../overlays/traffic";
import { configModal } from "./OverlayList";
import { compass } from "../util";
import { Table2, X } from "lucide-preact";
import { spaceOpen } from "./SpacePanel"; // data 0.6

export const stormTableOpen = signal(false);

// ---------- Kp (aurora) ----------

const kpColor = (k: number) => (k >= 8 ? "#a855f7" : k >= 6 ? "#ef4444" : k >= 5 ? "#f97316" : k >= 4 ? "#facc15" : "#22c55e");

function KpBox() {
  const [kp, setKp] = useState<any>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get("/api/ovl/kp")
        .then((v) => alive && setKp(v))
        .catch((e) => alive && setKp({ error: e.message }));
    load();
    const t = window.setInterval(load, 600_000);
    return () => ((alive = false), clearInterval(t));
  }, []);
  if (kp === undefined) return <div class="muted small">Loading Kp…</div>;
  if (kp.error || kp.kp == null) return <div class="muted small">Kp unavailable{kp.error ? ` (${kp.error})` : ""}</div>;
  const series: [number, number][] = kp.series ?? [];
  const W = 480;
  const H = 80;
  const bw = series.length ? W / series.length : W;
  const y = (k: number) => H - 12 - (Math.min(9, k) / 9) * (H - 16);
  const days = series.filter(([t]) => new Date(t).getUTCHours() === 0);
  return (
    <div class="kp-box">
      <div class="kp-now">
        <span class="kp-badge" style={{ background: kpColor(kp.kp) }}>
          Kp {Number(kp.kp).toFixed(1)}
        </span>
        <b class={kp.g !== "G0" ? "kp-g on" : "kp-g"}>{kp.g === "G0" ? "No storm (G0)" : `${kp.g} geomagnetic storm`}</b>
        <small class="muted">{kp.t ? new Date(kp.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""}</small>
      </div>
      {series.length > 0 && (
        <svg class="kp-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
          {[5, 7].map((k) => (
            <g key={k}>
              <line x1="0" x2={W} y1={y(k)} y2={y(k)} stroke="rgba(255,255,255,.12)" stroke-dasharray="3 3" />
              <text x={W - 2} y={y(k) - 2} text-anchor="end" font-size="8" fill="#8b97a6">
                {k === 5 ? "G1" : "G3"}
              </text>
            </g>
          ))}
          {series.map(([t, k], i) => (
            <rect key={t} x={i * bw + 0.6} y={y(k)} width={Math.max(1, bw - 1.2)} height={H - 12 - y(k)} rx="1.5" fill={kpColor(k)} opacity="0.9">
              <title>{`${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} · Kp ${k}`}</title>
            </rect>
          ))}
          {days.map(([t]) => {
            const i = series.findIndex((s) => s[0] === t);
            return (
              <text key={t} x={i * bw + 1} y={H - 2} font-size="8.5" fill="#8b97a6">
                {new Date(t).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
              </text>
            );
          })}
        </svg>
      )}
      <div class="muted small">3-hourly planetary K, last 3 days (SWPC). Kp 5+ = geomagnetic storm; aurora reaches lower latitudes as Kp rises.</div>
    </div>
  );
}

/** Rendered inside a layer's settings window. */
export function LayerExtra({ id }: { id: string }) {
  if (id === "aurora")
    return (
      <section>
        <label class="lbl">Geomagnetic activity</label>
        <KpBox />
        {/* data 0.6 */}
        <button class="btn sm" style={{ marginTop: "8px" }} title="Shortcut: the Space weather window also has its own sidebar button (sun)" onClick={() => ((spaceOpen.value = true), (configModal.value = null))}>
          Space weather: sun, solar wind, alerts
        </button>
      </section>
    );
  if (id === "stormattr")
    return (
      <section>
        <button class="btn sm" onClick={() => ((stormTableOpen.value = true), (configModal.value = null))} disabled={!stormCells.value.cells.length}>
          <Table2 size={13} /> Storm table
        </button>
        {!stormCells.value.cells.length && <span class="muted small"> Turn the layer on first</span>}
      </section>
    );
  if (id === "roadwork" || id === "trafficflow")
    return (
      <section>
        <label class="lbl">Sources</label>
        <FeedSources id={id} />
      </section>
    );
  if (id === "traffic") {
    const st = ovlStatus.value.traffic;
    const inc = ovlStatus.value.trafficinc;
    return (
      <section>
        {st?.note === NO_KEY && <p class="err-text small">{NO_KEY}</p>}
        {settings.value.ovl.traffic?.opts?.inc === "1" && <p class="muted small">Incidents: {inc?.error ?? inc?.note ?? (inc?.count != null ? `${inc.count} in view` : "—")}</p>}
      </section>
    );
  }
  return null;
}

// ---------- keyless traffic: per-source status ----------

const ago = (s: number | null) => (s == null ? "never" : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

function FeedSources({ id }: { id: string }) {
  const m: FeedMeta | undefined = ovlMeta.value[id];
  if (!settings.value.ovl[id]?.on) return <div class="muted small">Turn the layer on to see its sources.</div>;
  if (!m) return <div class="muted small">{ovlStatus.value[id]?.note ?? "Loading…"}</div>;
  if (!m.sources.length) return <div class="muted small">No source has reported yet (the first fetch can take a few seconds).</div>;
  const bad = m.sources.filter((s) => s.error).length;
  const list = [...m.sources].sort((a, b) => +!!b.error - +!!a.error || a.name.localeCompare(b.name));
  return (
    <div class="feed-srcs">
      <div class="muted small">
        {m.sources.length} sources{bad ? ` · ${bad} failing` : " · all OK"}
        {m.total != null ? ` · ${m.total.toLocaleString()} in this area` : ""}
        {m.truncated ? " (only the most severe shown)" : ""}
      </div>
      {list.map((s) => (
        <div key={s.id} class={`feed-src ${s.error ? "bad" : ""}`} title={s.error ?? `${s.id}`}>
          <i class="dot" />
          <span>{s.name}</span>
          <small class="muted">{s.error ? "error" : `${s.count.toLocaleString()} · ${ago(s.age)}`}</small>
          {s.error && <small class="err-text feed-err">{s.error}</small>}
        </div>
      ))}
      <button class="btn xs ghost" onClick={() => refreshOverlay(id)}>
        Refresh now
      </button>
    </div>
  );
}

// ---------- storm table ----------

export function StormTable() {
  const [flagged, setFlagged] = useState(true);
  if (!stormTableOpen.value) return null;
  const { cells, t } = stormCells.value;
  const list = cells.filter((c) => !flagged || hasTvs(c.p) || mesoRank(c.p) >= 5 || hasHail(c.p)).slice(0, 200);
  const go = (c: { lon: number; lat: number }) => {
    const m = mapRef.value;
    m?.flyTo({ center: [c.lon, c.lat], zoom: Math.max(m.getZoom(), 9) });
  };
  return (
    <div class="storm-table glass">
      <div class="st-head">
        <b>Storm cells</b>
        <small class="muted">
          {list.length} of {cells.length}
          {t ? ` · ${new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
        </small>
        <label class="st-flag">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged((e.target as HTMLInputElement).checked)} /> Flagged only
        </label>
        <button class="icon-btn" title="Close" onClick={() => (stormTableOpen.value = false)}>
          <X size={14} />
        </button>
      </div>
      <div class="st-body">
        <table>
          <thead>
            <tr>
              <th>Cell</th>
              <th>Threat</th>
              <th>dBZ</th>
              <th>Top</th>
              <th>VIL</th>
              <th>Hail</th>
              <th>Moving</th>
              <th>ETA</th>{/* workflow */}
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const p = c.p;
              return (
                <tr key={`${p.nexrad}-${p.storm_id}`} class={hasTvs(p) ? "tvs" : mesoRank(p) >= 5 ? "meso" : ""} onClick={() => go(c)}>
                  <td>
                    <b>{siteFor(p.nexrad)}</b> {p.storm_id}
                  </td>
                  <td class="fl">{cellFlags(p) || "—"}</td>
                  <td>{p.max_dbz ?? "—"}</td>
                  <td>{p.top != null ? `${Math.round(p.top)}k` : "—"}</td>
                  <td>{p.vil ?? "—"}</td>
                  <td>{p.posh != null ? `${p.posh}%` : "—"}</td>
                  <td>{p.dir_to != null && p.sknt ? `${compass(p.dir_to)} ${fmtKt(p.sknt)}` : "—"}</td>
                  <td class="fl">{p._eta || "—"}</td>{/* workflow */}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!list.length && <div class="muted small" style={{ padding: "10px" }}>No cells{flagged ? " with rotation or hail" : ""}.</div>}
      </div>
    </div>
  );
}

// automation hook (screenshots / console)
(window as any).__tbwLayers = {
  setOn: (id: string, v: boolean) => update((s) => (s.ovl[id] = { ...(s.ovl[id] ?? {}), on: v })),
  refresh: (id: string) => refreshOverlay(id),
  config: (id: string | null) => (configModal.value = id),
  stormTable: (v: boolean) => (stormTableOpen.value = v),
};
