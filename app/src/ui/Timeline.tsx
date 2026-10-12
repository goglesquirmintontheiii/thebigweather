// Bottom timeline: frame ticks (click, drag or scroll to scrub), loading bars, speed, frame count
// or time span, and the history picker.

import { useRef, useState, useEffect } from "preact/hooks";
import { frameIndex, playing, stepFrame, historyEnd, FPS_STEPS } from "../anim";
import { liveSweep, pinned, backToLatest } from "../radar/controller";
import { activeFrames, isForecast, loadProgress } from "../active";
import { settings, update } from "../store";
import { fmtTime } from "../util";
import { gridDef } from "../weather";
import { SkipBack, SkipForward, History, SlidersHorizontal, X } from "lucide-preact";

/** "90" → "1.5 h" style label for a span in minutes. */
export function spanLabel(m: number) {
  if (m % 1440 === 0) return `${m / 1440} d`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  if (m > 120) return `${+(m / 60).toFixed(1)} h`;
  return `${m} min`;
}

const UNITS: [string, number][] = [
  ["min", 1],
  ["hours", 60],
  ["days", 1440],
];

function fpsLabel(f: number) {
  return f < 1 ? `${f} fps` : `${f % 1 ? f.toFixed(1) : f} fps`;
}

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function HistoryBox({ close }: { close: () => void }) {
  const utc = settings.value.utc;
  const now = Date.now();
  const cur = historyEnd.value ?? now - 3600_000;
  const [val, setVal] = useState(utc ? new Date(cur).toISOString().slice(0, 16) : toLocalInput(cur));
  const w = settings.value.weather;
  const d = w.kind === "grid" ? gridDef(w.id) : undefined;
  const forecast = d && (d.source === "model" || d.source === "ndfd" || d.source === "future");
  const metar = d?.source === "metar";
  const go = (ms: number) => {
    historyEnd.value = Math.min(ms, Date.now());
    playing.value = false;
    close();
  };
  if (forecast) return <p class="muted small">History isn't available for forecasts. Pick an earlier run from the header instead.</p>;
  return (
    <div class="tl-hist">
      <div class="row">
        <input type="datetime-local" value={val} max={utc ? new Date(now).toISOString().slice(0, 16) : toLocalInput(now)} onInput={(e) => setVal((e.target as HTMLInputElement).value)} />
        <button class="btn sm" onClick={() => go(utc ? Date.parse(`${val}:00Z`) : Date.parse(val))}>
          <History size={13} /> Load
        </button>
      </div>
      <div class="chips">
        {[
          [1, "−1 h"],
          [3, "−3 h"],
          [6, "−6 h"],
          [24, "−1 day"],
        ].map(([h, l]) => (
          <button key={l} class="chip" onClick={() => go((historyEnd.value ?? Date.now()) - +h * 3600_000)}>
            {l}
          </button>
        ))}
        {historyEnd.value && (
          <button class="chip" onClick={() => go(historyEnd.value! + 3600_000)}>
            +1 h
          </button>
        )}
      </div>
      <p class="muted small">
        {w.kind === "radar" ? "Level II archive back to 1991." : metar ? "METAR analysis keeps only recent hours." : "Satellite and MRMS archives on AWS."} Times in {utc ? "UTC" : "local time"}.
      </p>
    </div>
  );
}

function FramesBox() {
  const s = settings.value;
  const a = s.anim;
  const radar = s.weather.kind === "radar";
  const count = radar ? s.radar.frames : s.grid.frames;
  const setCount = (n: number) => update((x) => (radar ? (x.radar.frames = n) : (x.grid.frames = n)));
  const [unit, setUnit] = useState(a.minutes % 1440 === 0 ? 1440 : a.minutes % 60 === 0 ? 60 : 1);
  const [val, setVal] = useState(String(a.minutes / unit));
  useEffect(() => setVal(String(+(a.minutes / unit).toFixed(2))), [a.minutes, unit]);
  const apply = (v: string, u: number) => update((x) => (x.anim.minutes = Math.max(5, Math.min(10080, Math.round((+v || 1) * u)))));
  const fi = Math.max(0, FPS_STEPS.findIndex((f) => f >= a.fps));
  return (
    <div class="tl-frames">
      <div class="row">
        <span>Frames by</span>
        <div class="seg sm">
          <button class={a.mode === "count" ? "on" : ""} onClick={() => update((x) => (x.anim.mode = "count"))}>
            Count
          </button>
          <button class={a.mode === "time" ? "on" : ""} onClick={() => update((x) => (x.anim.mode = "time"))}>
            Time
          </button>
        </div>
      </div>
      {a.mode === "count" ? (
        <div class="row">
          <span>Frames</span>
          <input type="range" min={2} max={radar ? 120 : 72} value={count} onChange={(e) => setCount(+(e.target as HTMLInputElement).value)} />
          <input class="num" type="number" min={1} max={radar ? 200 : 240} value={count} onChange={(e) => setCount(Math.max(1, +(e.target as HTMLInputElement).value || 1))} />
        </div>
      ) : (
        <>
          <div class="row">
            <span>Length</span>
            <input class="num" type="number" min={unit === 1 ? 5 : 0.25} step={unit === 1 ? 5 : unit === 60 ? 0.5 : 0.25} value={val} onInput={(e) => setVal((e.target as HTMLInputElement).value)} onChange={(e) => apply((e.target as HTMLInputElement).value, unit)} />
            <select value={String(unit)} onChange={(e) => setUnit(+(e.target as HTMLSelectElement).value)}>
              {UNITS.map(([l, u]) => (
                <option key={u} value={u}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {isForecast.value && <p class="muted small">Forecast layers always show the whole run.</p>}
        </>
      )}
      <div class="row">
        <span>Speed</span>
        <input type="range" min={0} max={FPS_STEPS.length - 1} value={fi} onInput={(e) => update((x) => (x.anim.fps = FPS_STEPS[+(e.target as HTMLInputElement).value]))} />
        <span class="val">{fpsLabel(a.fps)}</span>
      </div>
      <div class="row">
        <span>Pause on last</span>
        <input type="range" min={0} max={5000} step={250} value={a.dwellMs} onInput={(e) => update((x) => (x.anim.dwellMs = +(e.target as HTMLInputElement).value))} />
        <span class="val">{(a.dwellMs / 1000).toFixed(a.dwellMs % 1000 ? 2 : 0)} s</span>
      </div>
    </div>
  );
}

export function Timeline() {
  const fs = activeFrames.value;
  const [pop, setPop] = useState<null | "frames" | "hist">(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const wheelAcc = useRef(0);
  const hist = historyEnd.value;
  const prog = loadProgress.value;
  const showBars = settings.value.ui.loadBars;
  if (fs.length < 1 && !hist) return null;
  const idx = Math.min(frameIndex.value, Math.max(0, fs.length - 1));
  const cur = fs[idx];
  const n = fs.length;
  const radar = settings.value.weather.kind === "radar";
  const setFromX = (clientX: number) => {
    const el = track.current;
    if (!el || n < 1) return;
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
    playing.value = false;
    if (i !== frameIndex.value) frameIndex.value = i;
  };
  return (
    <div class="timeline-wrap">
      {pop && (
        <div class="tl-pop glass">
          <div class="tl-pop-head">
            <b>{pop === "hist" ? "History" : "Animation"}</b>
            <button class="icon-btn" onClick={() => setPop(null)}>
              <X size={14} />
            </button>
          </div>
          {pop === "hist" ? <HistoryBox close={() => setPop(null)} /> : <FramesBox />}
        </div>
      )}
      <div class={`timeline glass ${hist ? "history" : ""}`}>
        {showBars && (
          <div class="tl-bars" title={`${prog.done}/${prog.total} frames loaded`}>
            <i class="tl-anim" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%`, opacity: prog.done < prog.total ? 1 : 0 }} />
            {prog.current && <i class="tl-cur" />}
          </div>
        )}
        <button class="icon-btn" onClick={() => stepFrame(-1)} title="Previous frame (←)">
          <SkipBack size={14} />
        </button>
        <div
          ref={track}
          class={`ticks ${n > 60 ? "dense" : ""}`}
          title="Click, drag or scroll to move through the loop"
          onPointerDown={(e) => {
            drag.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            setFromX(e.clientX);
          }}
          onPointerMove={(e) => drag.current && setFromX(e.clientX)}
          onPointerUp={() => (drag.current = false)}
          onPointerCancel={() => (drag.current = false)}
          onWheel={(e) => {
            e.preventDefault();
            wheelAcc.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            // one frame per notch (trackpads send many small deltas)
            while (Math.abs(wheelAcc.current) >= 40) {
              stepFrame(wheelAcc.current > 0 ? 1 : -1);
              wheelAcc.current -= Math.sign(wheelAcc.current) * 40;
            }
          }}
        >
          {fs.map((f, i) => (
            <span key={f.key} class={`tick ${i === idx ? "on" : ""} ${f.state === "ok" ? "ok" : f.state === "err" ? "err" : ""} ${f.live ? "live" : ""}`} title={`${f.label ? f.label + " · " : ""}${fmtTime(f.time, true)}`} />
          ))}
          {radar && liveSweep.value && <span class="tick live-partial" title="Sweep in progress" />}
        </div>
        <span class="tl-time">
          {isForecast.value && cur?.label ? <b class="tl-fh">{cur.label}</b> : null}
          {cur ? fmtTime(cur.time, isForecast.value) : "—"}
        </span>
        <button class="icon-btn" onClick={() => stepFrame(1)} title="Next frame (→)">
          <SkipForward size={14} />
        </button>
        <span class="tl-sep" />
        <button class={`tl-btn ${pop === "frames" ? "on" : ""}`} onClick={() => setPop(pop === "frames" ? null : "frames")} title="Frames, time span and speed">
          <SlidersHorizontal size={13} />
          <span>{settings.value.anim.mode === "time" ? spanLabel(settings.value.anim.minutes) : `${n}`}</span>
          <span class="muted">· {fpsLabel(settings.value.anim.fps)}</span>
        </button>
        <button class={`tl-btn ${pop === "hist" || hist ? "on" : ""}`} onClick={() => setPop(pop === "hist" ? null : "hist")} title="Load history">
          <History size={13} />
          {hist ? <span>{fmtTime(hist, true)}</span> : null}
        </button>
        {(hist || (radar && pinned.value)) && (
          <button class="tl-btn live" onClick={() => backToLatest()} title="Back to live data">
            Live
          </button>
        )}
      </div>
    </div>
  );
}
