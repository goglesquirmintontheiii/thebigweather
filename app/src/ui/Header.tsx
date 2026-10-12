import { settings, update, connection } from "../store";
import { currentFrame, currentSite, liveSweep, liveState, pinned, backToLatest, frames, frameIndex, playingRec } from "../radar/controller";
import { gridRuns, gridRun, gridStorms, setRun, setStorm } from "../grid/controller";
import { activeTime, activeFrame, activeLoading, activeError, isForecast } from "../active";
import { activeLabel, gridDef } from "../weather";
import { fmtTime, fmtAge } from "../util";
import { Zap, History, Loader, X } from "lucide-preact";
import { LayerPicker } from "./LayerPicker";
import { Btn3D } from "./View3D"; // 3D button (only for layers with 3D data)

// the radar product is picked from the dropdown on the map (ui/Panes.tsx MainPaneHead)

export function TopBar() {
  return (
    <div class="topbar">
      <LayerPicker />
      <Header />
    </div>
  );
}

function runLabel(id: string) {
  // YYYYMMDDHH
  const d = new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10)));
  return `${id.slice(8, 10)}Z ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

function TimeBlock({ t, forecast }: { t: number; forecast?: string }) {
  const age = t ? (Date.now() - t) / 60000 : 999;
  const ageClass = pinned.value && settings.value.weather.kind === "radar" ? "hist" : forecast ? "fcst" : age < 8 ? "fresh" : age < 20 ? "stale" : "old";
  return (
    <div class={`hdr-time ${ageClass}`}>
      {activeLoading.value && <Loader size={13} class="spin" />}
      {forecast && <span class="hdr-fh">{forecast}</span>}
      <span>{t ? fmtTime(t, Math.abs(age) > 600) : "—"}</span>
      {t > 0 && !forecast && !(pinned.value && settings.value.weather.kind === "radar") && <span class="hdr-age">{fmtAge(t)}</span>}
    </div>
  );
}

function GridHeader() {
  const w = settings.value.weather;
  const lbl = activeLabel.value;
  const t = activeTime.value;
  void lbl;
  const f = activeFrame.value;
  const def = w.kind === "grid" ? gridDef(w.id) : undefined;
  const runs = gridRuns.value;
  const storms = gridStorms.value;
  return (
    <div class="header glass">
      {def?.source === "model" && runs.length > 0 && (
        <div class="hdr-site">
          <span class="hdr-id sm">{lbl.group.replace(/^Models · /, "")} run</span>
          <select class="hdr-sel" value={w.kind === "grid" ? w.run ?? gridRun.value ?? "" : ""} onChange={(e) => setRun((e.target as HTMLSelectElement).value || undefined)} title="Model run">
            {runs.map((r, i) => (
              <option key={r.id} value={i === 0 ? "" : r.id}>
                {runLabel(r.id)}
                {i === 0 ? " (latest)" : ""}
              </option>
            ))}
          </select>
          {storms.length > 0 && (
            <select class="hdr-sel" value={(w.kind === "grid" && w.storm) || storms[0]} onChange={(e) => setStorm((e.target as HTMLSelectElement).value)} title="Storm">
              {storms.map((s) => (
                <option key={s} value={s}>
                  {s.toUpperCase()}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <Btn3D />
      <TimeBlock t={t} forecast={isForecast.value ? f?.label ?? "Fcst" : undefined} />
      {activeError.value && <div class="hdr-err">{activeError.value}</div>}
    </div>
  );
}

function RadarHeader() {
  const r = settings.value.radar;
  const site = currentSite.value;
  const f = currentFrame.value;
  const sweep = liveSweep.value && frameIndex.value === frames.value.length - 1 ? liveSweep.value : f?.sweep;
  const t = sweep?.start ?? f?.time ?? 0;
  const liveOn = r.source === "L2" && r.live && !pinned.value;
  const ls = liveState.value;
  const expected = sweep ? (sweep.nrad > 400 ? 720 : 360) : 720;
  const pct = liveOn && ls && !ls.complete ? Math.min(100, (ls.radials / expected) * 100) : null;
  const extra = settings.value.extraSites;

  return (
    <div class="header glass">
      <div class="hdr-site">
        <span class="hdr-id">{r.site}</span>
        <span class="hdr-name">{site ? [site.name, site.state].filter(Boolean).join(", ") || site.type : ""}</span>
        {extra.length > 0 && (
          <button class="chip extra" title={`Also showing ${extra.join(", ")} — click to clear`} onClick={() => update((s) => (s.extraSites = []))}>
            +{extra.length} <X size={11} />
          </button>
        )}
      </div>
      {sweep && (
        <div class="hdr-prod">
          <span class="hdr-tilt">{sweep.elevation.toFixed(1)}°</span>
          {sweep.vcp ? <span class="hdr-vcp">VCP {sweep.vcp}</span> : null}
        </div>
      )}
      <Btn3D />
      <TimeBlock t={t} />
      {pinned.value && (
        <button class="chip hist" onClick={backToLatest} title="Back to latest">
          <History size={12} /> {playingRec.value ? `Recording: ${playingRec.value}` : "History"} · latest
        </button>
      )}
      {liveOn && (
        <span class={`live-dot ${connection.value === "online" ? "on" : ""}`} title={pct !== null ? `RapidSweep: ${ls!.elev.toFixed(1)}° tilt ${Math.round(pct)}% scanned` : "RapidSweep live data"}>
          <Zap size={11} /> {pct !== null ? `${ls!.elev.toFixed(1)}° ${Math.round(pct)}%` : "LIVE"}
        </span>
      )}
      {activeError.value && <div class="hdr-err">{activeError.value}</div>}
      {pct !== null && <div class="sweep-prog" style={{ width: `${pct}%` }} />}
    </div>
  );
}

export function Header() {
  return settings.value.weather.kind === "radar" ? <RadarHeader /> : <GridHeader />;
}
