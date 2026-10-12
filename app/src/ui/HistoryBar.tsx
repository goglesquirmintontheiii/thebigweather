// Historical mode picker (start/end date-time, quick presets) and the timeline's history badge.

import { useState } from "preact/hooks";
import { CalendarClock, X, Play, Radio, History } from "lucide-preact";
import { settings, update } from "../store";
import { histRange, histPicker, enterHistory, exitHistory, hiddenLive, replayState, HIST_MAX_MS } from "../history";
import { gridDef } from "../weather";
import { spanLabel, fpsLabel } from "./Timeline";
import { FPS_STEPS, frameCount } from "../anim";
import { histStormsOpen, BeforeAfter } from "./HistStorms";
import { ovlStatus } from "../overlays/manager";
import { addRecent } from "../histsearch";

const pad = (n: number) => String(n).padStart(2, "0");

/** ms → value for <input type="datetime-local"> in UTC or local time */
function toInput(ms: number, utc: boolean) {
  const d = new Date(ms);
  return utc
    ? d.toISOString().slice(0, 16)
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromInput(v: string, utc: boolean) {
  return v ? Date.parse(utc ? `${v}:00Z` : v) : NaN;
}

/** "Oct 11 19:00 → 01:00" (date on the end only when it differs) */
export function rangeLabel(start: number, end: number) {
  const utc = settings.value.utc;
  const tz = utc ? "UTC" : undefined;
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz });
  const hm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  return `${day(start)} ${hm(start)} → ${day(end) !== day(start) ? day(end) + " " : ""}${hm(end)}${utc ? "Z" : ""}`;
}

const LENGTHS: [number, string][] = [
  [60, "1 h"],
  [180, "3 h"],
  [360, "6 h"],
  [720, "12 h"],
  [1440, "1 d"],
  [4320, "3 d"],
];

export function HistoryPicker() {
  const utc = settings.value.utc;
  const h = histRange.value;
  const now = Date.now();
  const end0 = h?.end ?? Math.floor((now - 3600_000) / 300_000) * 300_000;
  const start0 = h?.start ?? end0 - 3 * 3600_000;
  const [s, setS] = useState(toInput(start0, utc));
  const [e, setE] = useState(toInput(end0, utc));
  const a = fromInput(s, utc);
  const b = fromInput(e, utc);
  const span = (b - a) / 60_000;
  const err = !(a < b) ? "Start must be before end" : b > now + 60_000 ? "End is in the future" : b - a > HIST_MAX_MS ? "7 days at most" : "";
  const setLen = (min: number) => setS(toInput((Number.isFinite(b) ? b : end0) - min * 60_000, utc));
  const setEnd = (t: number) => {
    const len = Number.isFinite(span) && span > 0 ? span : 180;
    setE(toInput(t, utc));
    setS(toInput(t - len * 60_000, utc));
  };
  const w = settings.value.weather;
  const d = w.kind === "grid" ? gridDef(w.id) : undefined;
  const forecast = d && (d.source === "model" || d.source === "ndfd" || d.source === "future");
  const r = settings.value.radar;
  const hidden = hiddenLive.value;
  const round = (t: number) => Math.floor(t / 300_000) * 300_000;
  const metarOn = !!settings.value.ovl.metar?.on;
  const metarErr = ovlStatus.value.metar?.error;
  return (
    <div class="hist-pop glass" onKeyDown={(ev) => ev.key === "Escape" && (histPicker.value = false)}>
      <div class="hist-head">
        <CalendarClock size={15} />
        <b>History</b>
        <span class="muted small">{utc ? "UTC" : "local time"}</span>
        <button class="btn sm ghost hist-storms-link" onClick={() => ((histStormsOpen.value = true), (histPicker.value = false))} title="Search past warnings and tropical storms">
          <History size={13} /> Historical Storms
        </button>
        <button class="icon-btn" onClick={() => (histPicker.value = false)} title="Close">
          <X size={14} />
        </button>
      </div>
      <label class="hist-row">
        <span>From</span>
        <input type="datetime-local" value={s} max={toInput(now, utc)} onInput={(ev) => setS((ev.target as HTMLInputElement).value)} />
      </label>
      <label class="hist-row">
        <span>To</span>
        <input type="datetime-local" value={e} max={toInput(now, utc)} onInput={(ev) => setE((ev.target as HTMLInputElement).value)} />
      </label>
      <div class="hist-row">
        <span>Length</span>
        <div class="chips">
          {LENGTHS.map(([m, l]) => (
            <button key={l} class={`chip ${Math.round(span) === m ? "on" : ""}`} onClick={() => setLen(m)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div class="hist-row">
        <span>Ending</span>
        <div class="chips">
          <button class="chip" onClick={() => setEnd(round(Date.now()))}>
            Now
          </button>
          <button class="chip" onClick={() => setEnd((Number.isFinite(b) ? b : end0) - 3600_000)}>
            −1 h
          </button>
          <button class="chip" onClick={() => setEnd((Number.isFinite(b) ? b : end0) - 86400_000)}>
            −1 d
          </button>
          {Number.isFinite(b) && b + 3600_000 <= now && (
            <button class="chip" onClick={() => setEnd(b + 3600_000)}>
              +1 h
            </button>
          )}
        </div>
      </div>
      <HistPlayback />
      <div class="hist-notes muted small">
        {err ? <span class="hist-err">{err}</span> : <span>{spanLabel(Math.round(span))} · warnings, reports, watches and MDs replay with the loop</span>}
        {w.kind === "radar" && r.source === "L3" && <span>Level III has no archive: Level II is used.</span>}
        {forecast && <span>Forecast layers keep their own runs.</span>}
        {hidden.length > 0 && <span>Live-only, hidden: {hidden.join(", ")}</span>}
        {metarOn && <span class={metarErr && h ? "hist-err" : ""}>{metarErr && h ? "METAR archive unavailable" : "METARs replay hourly from the archive."}</span>}
      </div>
      <div class="hist-foot">
        {h && (
          <button class="btn sm ghost" onClick={exitHistory}>
            <Radio size={13} /> Back to live
          </button>
        )}
        <button class="btn sm" disabled={!!err} onClick={() => (enterHistory(a, b), addRecent({ label: "Custom range", kind: "range", start: a, end: Math.min(b, Date.now()), site: settings.value.weather.kind === "radar" ? settings.value.radar.site : undefined }))}>
          <Play size={13} /> Load
        </button>
      </div>
    </div>
  );
}

const STEPS: [number, string][] = [
  [0, "Every volume"],
  [5, "5 min"],
  [10, "10 min"],
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 h"],
];

/** History playback: independent of the live loop settings (Timeline → Loop). */
function HistPlayback() {
  const hs = settings.value.hist;
  const fi = Math.max(0, FPS_STEPS.findIndex((f) => f >= hs.fps));
  const set = (fn: (x: typeof hs) => void) => update((s) => fn(s.hist));
  return (
    <div class="hist-play">
      <div class="hist-sub">
        Playback <span class="muted small">history only · the live loop keeps its own settings</span>
      </div>
      <div class="hist-row">
        <span>Frame step</span>
        <div class="chips">
          {STEPS.map(([m, l]) => (
            <button key={m} class={`chip ${hs.step === m ? "on" : ""}`} onClick={() => set((x) => (x.step = m))} title={m ? `One frame every ${l} (nearest volume)` : "Every radar volume / every frame the layer has"}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div class="hist-row">
        <span>Max frames</span>
        <input type="range" min={10} max={400} step={10} value={hs.maxFrames} onInput={(e) => set((x) => (x.maxFrames = +(e.target as HTMLInputElement).value))} />
        <span class="val">{hs.maxFrames}</span>
      </div>
      <div class="hist-row">
        <span>Speed</span>
        <input type="range" min={0} max={FPS_STEPS.length - 1} value={fi} onInput={(e) => set((x) => (x.fps = FPS_STEPS[+(e.target as HTMLInputElement).value]))} />
        <span class="val">{fpsLabel(hs.fps)}</span>
      </div>
      <div class="hist-row">
        <span>Pause on last</span>
        <input type="range" min={0} max={5000} step={250} value={hs.dwellMs} onInput={(e) => set((x) => (x.dwellMs = +(e.target as HTMLInputElement).value))} />
        <span class="val">{(hs.dwellMs / 1000).toFixed(hs.dwellMs % 1000 ? 2 : 0)} s</span>
      </div>
      <div class="hist-row">
        <span>Alert / storm</span>
        <BeforeAfter />
      </div>
    </div>
  );
}

/** Mounted in the bottom dock: the picker pops up above the timeline. */
export function HistoryBar() {
  return histPicker.value ? <HistoryPicker /> : null;
}

/** Timeline badge while history mode is on: range (opens the picker) + replay status. */
export function HistoryBadge() {
  const h = histRange.value;
  if (!h) return null;
  const rs = replayState.value;
  const hidden = hiddenLive.value;
  const tip = [rs.loading ? "Loading warnings…" : rs.error ? `Warnings: ${rs.error}` : `${rs.warnings} warnings in window`, hidden.length ? `Live-only, hidden: ${hidden.join(", ")}` : ""].filter(Boolean).join("\n");
  return (
    <button class={`tl-btn hist-badge ${histPicker.value ? "on" : ""}`} onClick={() => (histPicker.value = !histPicker.value)} title={`${tip}\nClick to change`}>
      <b>HISTORY</b>
      <span>{rangeLabel(h.start, h.end)}</span>
      <span class="muted">· {frameCount.value} fr · {fpsLabel(settings.value.hist.fps)}</span>
      {rs.loading && <i class="hist-dot" />}
    </button>
  );
}
