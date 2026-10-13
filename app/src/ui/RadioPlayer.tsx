// Floating media-player windows for radio streams: DVR seek bar, jump back, go live, record.

import { useEffect, useRef, useState } from "preact/hooks";
import { players, closePlayer, setPlayerCompact, nowPlaying, type PlayerWin } from "../radio";
import { X, Play, Pause, RotateCcw, Radio, Circle, Square, Download, Volume2, VolumeX, Minimize2, Maximize2, Siren, Captions } from "lucide-preact";
import { openPanel } from "../store";
import { fmtBytes } from "../util";
import { ToolButtons, SamePanel, TranscriptPanel } from "./RadioTools";
import { toDb, dbPos } from "../audio/levels"; // radio/dash 0.8
import type { LivePlayer, PlayerSnap } from "../radio"; // radio/dash 0.8

let z = 60;

const mmss = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function Player({ w }: { w: PlayerWin }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zi, setZ] = useState(++z);
  const [vol, setVol] = useState(w.p.audio.volume);
  const [muted, setMuted] = useState(false);
  const p = w.p;
  const s = p.snap.value;
  useEffect(() => {
    p.setMuted(muted);
  }, [muted]);
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,.rp-txbox,.rp-samelog,.rp-wave")) return;
    const el = ref.current!;
    setZ(++z);
    const ox = e.clientX - el.offsetLeft;
    const oy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - ox))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - oy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const seekable = s.mode !== "plain" && s.end > s.start;
  const behind = Math.max(0, s.end - s.cur);
  const live = seekable ? behind < 4 : s.status === "playing";
  const paused = s.status === "paused";
  const st = s.status === "connecting" ? "Connecting…" : s.status === "reconnecting" ? "Reconnecting…" : s.status === "buffering" ? "Buffering…" : s.status === "error" ? s.note ?? "Error" : null;
  return (
    <div ref={ref} class="rp glass" style={{ left: `${w.x}px`, top: `${w.y}px`, zIndex: zi }} onPointerDown={onDown as any}>
      <div class="rp-head">
        <Radio size={14} />
        <span class="rp-title" title={p.stream.url}>
          <b>{p.stream.call ?? p.stream.name}</b>
          {p.stream.call && <small class="muted"> {p.stream.name}</small>}
        </span>
        <span class={`rp-live ${live && !paused ? "on" : ""}`} title={live ? "At the live edge" : "Behind live"}>
          {live ? "LIVE" : `−${mmss(behind)}`}
        </span>
        <button class="icon-btn rp-compact" title="Compact: shrink to the small player (playback, SAME and transcript keep running)" onClick={() => setPlayerCompact(w.id, true)}>
          <Minimize2 size={14} />
        </button>
        <button class="icon-btn" title="Close" onClick={() => closePlayer(w.id)}>
          <X size={14} />
        </button>
      </div>
      <div class="rp-seek">
        <WaveSeek p={p} s={s} seekable={seekable} />
        <div class="rp-times muted">
          <span>{seekable ? `−${mmss(s.end - s.start)}` : ""}</span>
          <span>{st ?? (seekable ? `${mmss(s.end - s.start)} buffered` : s.note ?? "")}</span>
          <span>live</span>
        </div>
      </div>
      <div class="rp-ctl">
        <button class="icon-btn" title="Back 30 s" disabled={!seekable} onClick={() => p.back(30)}>
          <RotateCcw size={14} />
          <small>30</small>
        </button>
        <button class="icon-btn" title="Back 10 s" disabled={!seekable} onClick={() => p.back(10)}>
          <RotateCcw size={14} />
          <small>10</small>
        </button>
        <button class="rp-play" title={paused ? "Play" : "Pause"} onClick={() => p.toggle()}>
          {paused ? <Play size={18} /> : <Pause size={18} />}
        </button>
        <button class={`btn sm ghost ${live ? "" : "rp-golive"}`} disabled={!seekable || live} onClick={() => p.live()}>
          Go live
        </button>
        <span class="rp-fill" />
        <button class="icon-btn" title={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <LiveMeter p={p} />
        <input class="rp-vol" type="range" min={0} max={1} step={0.05} value={vol} onInput={(e) => (setVol(+(e.target as HTMLInputElement).value), p.setVolume(+(e.target as HTMLInputElement).value))} title="Volume" />
      </div>
      <div class="rp-rec">
        {s.rec ? (
          <button class="btn sm rp-recbtn on" onClick={() => p.recStop()} title="Stop and save the recording">
            <Square size={11} /> Stop · {mmss(s.recSecs)} · {fmtBytes(s.recBytes)}
          </button>
        ) : (
          <button class="btn sm ghost rp-recbtn" disabled={!p.canRecord || s.status === "error"} onClick={() => p.recStart()} title="Record from now">
            <Circle size={11} class="rec-dot" /> Record
          </button>
        )}
        {s.mode === "dvr" && (
          <button class="btn sm ghost" title="Save everything buffered so far" disabled={!s.end} onClick={() => p.saveBuffer()}>
            <Download size={12} /> Save buffer
          </button>
        )}
        <small class="muted rp-info">{s.mode === "dvr" ? `${s.type.replace("audio/", "").toUpperCase()} · ${s.kbps} kbps` : s.mode === "hls" ? "HLS" : s.mode === "plain" ? "Plain" : ""}</small>
      </div>
      <ToolButtons p={p} />
      <SamePanel p={p} />
      <TranscriptPanel p={p} />
    </div>
  );
}

/** p7: the big player shrunk to a small bar, like the simple player; decoders keep running. */
function MiniPlayer({ w }: { w: PlayerWin }) {
  const p = w.p;
  const s = p.snap.value;
  const [vol, setVol] = useState(p.audio.volume || 1);
  const seekable = s.mode !== "plain" && s.end > s.start;
  const behind = Math.max(0, s.end - s.cur);
  const live = seekable ? behind < 4 : s.status === "playing";
  const paused = s.status === "paused";
  const dot = s.status === "playing" ? "playing" : s.status === "error" ? "error" : "loading";
  const sOn = p.same.on.value;
  const tOn = p.tx.on.value;
  const tone = sOn ? p.same.tone.value : null;
  const st = s.status === "playing" ? (live ? "Live" : `−${mmss(behind)} behind live`) : s.status === "error" ? s.note ?? "Error" : s.status === "paused" ? "Paused" : "Connecting…";
  return (
    <div class="now-playing rp-mini glass">
      <span class={`np-dot ${dot}`} />
      <div class="np-name">
        <b>{p.stream.call ?? p.stream.name}</b>
        <small class="muted">
          {st}
          {s.rec && <span class="rp-mini-rec"> · ● REC</span>}
        </small>
      </div>
      {sOn && (
        <span class={`rp-ind ${tone ? "tone" : ""}`} title={tone ? "Alert tone on air" : "SAME decoder running"}>
          <Siren size={10} />
        </span>
      )}
      {tOn && (
        <span class="rp-ind" title="Transcribing">
          <Captions size={10} />
        </span>
      )}
      <button class="icon-btn" title={paused ? "Play" : "Pause"} onClick={() => p.toggle()}>
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <input type="range" min={0} max={1} step={0.05} value={vol} title="Volume" onInput={(e) => (setVol(+(e.target as HTMLInputElement).value), p.setVolume(+(e.target as HTMLInputElement).value))} />
      <button class="icon-btn rp-expand" title="Expand to the full player (seek, record, SAME, transcript)" onClick={() => setPlayerCompact(w.id, false)}>
        <Maximize2 size={13} />
      </button>
      <button class="icon-btn" title="Close" onClick={() => closePlayer(w.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

export function RadioPlayers() {
  const minis = players.value.filter((w) => w.compact);
  // sits under the simple player bar when that one is showing too
  const top = 12 + (nowPlaying.value && openPanel.value !== "radio" ? 62 : 0);
  return (
    <>
      {players.value.map((w) => (w.compact ? null : <Player key={w.id} w={w} />))}
      {minis.length > 0 && (
        <div class="rp-minis" style={{ top: `${top}px` }}>
          {minis.map((w) => (
            <MiniPlayer key={w.id} w={w} />
          ))}
        </div>
      )}
    </>
  );
}

/* ---------- radio/dash 0.8: waveform seek bar + live level meter ---------- */

function cssVar(name: string, fb: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

/** DVR seek bar drawn as the levels heard so far (peak light, RMS solid), played part in accent. */
function WaveSeek({ p, s, seekable }: { p: LivePlayer; s: PlayerSnap; seekable: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const t0 = s.start;
  const t1 = Math.max(s.start + 0.1, s.end);
  const ver = p.levels.version;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || 360;
    const H = c.clientHeight || 34;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const mid = H / 2;
    const accent = cssVar("--accent", "#4aa3ff");
    g.fillStyle = "rgba(255,255,255,0.045)";
    g.beginPath();
    (g as any).roundRect ? (g as any).roundRect(0, 0, W, H, 6) : g.rect(0, 0, W, H);
    g.fill();
    const span = t1 - t0;
    const curX = seekable ? ((s.cur - t0) / span) * W : W;
    const step = 2;
    for (let x = 0; x < W; x += step) {
      const a = t0 + (x / W) * span;
      const b = t0 + ((x + step) / W) * span;
      const lv = seekable ? p.levels.span(a, b) : null;
      const played = x <= curX;
      if (!lv) {
        g.fillStyle = "rgba(255,255,255,0.10)";
        g.fillRect(x, mid - 0.5, step - 0.5, 1);
        continue;
      }
      // perceptual scale: dB (−48…0) mapped to the half height
      const hp = Math.max(1, ((Math.max(-48, toDb(lv[0])) + 48) / 48) * (mid - 2));
      const hr = Math.max(0.5, ((Math.max(-48, toDb(lv[1])) + 48) / 48) * (mid - 2));
      g.globalAlpha = played ? 0.45 : 0.22;
      g.fillStyle = lv[0] >= 0.98 ? "#f87171" : played ? accent : "#9aa7b6";
      g.fillRect(x, mid - hp, step - 0.5, hp * 2);
      g.globalAlpha = played ? 1 : 0.5;
      g.fillStyle = played ? accent : "#9aa7b6";
      g.fillRect(x, mid - hr, step - 0.5, hr * 2);
      g.globalAlpha = 1;
    }
    if (seekable) {
      g.fillStyle = "#fff";
      g.fillRect(Math.round(curX) - 1, 1, 2, H - 2);
      g.beginPath();
      g.arc(Math.min(W - 5, Math.max(5, curX)), mid, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }, [t0, t1, s.cur, ver, seekable]);
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { x, t: t0 + (x / r.width) * (t1 - t0) };
  };
  const down = (e: PointerEvent) => {
    if (!seekable) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    p.seek(at(e).t);
  };
  const move = (e: PointerEvent) => {
    const h = at(e);
    setHover(h);
    if (seekable && e.buttons & 1) p.seek(h.t);
  };
  const key = (e: KeyboardEvent) => {
    if (!seekable) return;
    const d = e.key === "ArrowLeft" ? -5 : e.key === "ArrowRight" ? 5 : e.key === "PageDown" ? -30 : e.key === "PageUp" ? 30 : 0;
    if (d) p.seek(s.cur + d);
    else if (e.key === "End") p.live();
    else if (e.key === "Home") p.seek(t0);
    else return;
    e.preventDefault();
  };
  return (
    <div
      class={`rp-wave ${seekable ? "" : "off"}`}
      role="slider"
      tabIndex={seekable ? 0 : -1}
      aria-label="Seek (audio levels heard so far)"
      aria-valuemin={0}
      aria-valuemax={Math.round(t1 - t0)}
      aria-valuenow={Math.round(s.cur - t0)}
      aria-valuetext={`${mmss(Math.max(0, s.end - s.cur))} behind live`}
      aria-disabled={!seekable}
      title={seekable ? "Seek through what has played so far (levels drawn as heard)" : "Seeking not available for this stream"}
      onPointerDown={down as any}
      onPointerMove={move as any}
      onPointerLeave={() => setHover(null)}
      onKeyDown={key as any}
    >
      <canvas ref={cv} />
      {hover && seekable && (
        <span class="rp-wave-tip" style={{ left: `${hover.x}px` }}>
          −{mmss(Math.max(0, s.end - hover.t))}
        </span>
      )}
    </div>
  );
}

/** Small live peak/RMS meter (dBFS), from the same tap. */
function LiveMeter({ p }: { p: LivePlayer }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 60) return;
      last = now;
      const c = cv.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const W = 64, H = 10;
      if (c.width !== W * dpr) (c.width = W * dpr), (c.height = H * dpr);
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const L = p.levels.live;
      const stale = now - L.t > 400;
      const pk = stale ? -60 : toDb(L.peak);
      const rm = stale ? -60 : toDb(L.rms);
      const hold = stale ? -60 : toDb(L.hold);
      g.clearRect(0, 0, W, H);
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(0, 0, W, H);
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "#22c55e");
      grad.addColorStop(0.7, "#84cc16");
      grad.addColorStop(0.85, "#facc15");
      grad.addColorStop(1, "#ef4444");
      g.fillStyle = grad;
      g.globalAlpha = 0.45;
      g.fillRect(0, 1, dbPos(pk) * W, H - 2);
      g.globalAlpha = 1;
      g.fillRect(0, 3, dbPos(rm) * W, H - 6);
      g.fillStyle = "#fff";
      g.fillRect(Math.min(W - 1, dbPos(hold) * W), 0, 1.5, H);
      if (tip.current) tip.current.title = stale ? "Level meter (starts a few seconds after playback)" : `Peak ${pk.toFixed(0)} dBFS · RMS ${rm.toFixed(0)} dBFS`;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [p]);
  return (
    <span ref={tip} class="rp-meter" aria-hidden="true">
      <canvas ref={cv} />
    </span>
  );
}
/* ---------- end radio/dash 0.8 ---------- */
