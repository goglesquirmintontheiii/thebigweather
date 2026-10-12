// Floating media-player windows for radio streams: DVR seek bar, jump back, go live, record.

import { useEffect, useRef, useState } from "preact/hooks";
import { players, closePlayer, type PlayerWin } from "../radio";
import { X, Play, Pause, RotateCcw, Radio, Circle, Square, Download, Volume2, VolumeX } from "lucide-preact";
import { fmtBytes } from "../util";
import { ToolButtons, SamePanel, TranscriptPanel } from "./RadioTools";

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
    if ((e.target as HTMLElement).closest("button,input,select,.rp-txbox,.rp-samelog")) return;
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
        <button class="icon-btn" title="Close" onClick={() => closePlayer(w.id)}>
          <X size={14} />
        </button>
      </div>
      <div class="rp-seek">
        <input type="range" min={s.start} max={Math.max(s.start + 0.1, s.end)} step={0.1} value={s.cur} disabled={!seekable} onInput={(e) => p.seek(+(e.target as HTMLInputElement).value)} title="Seek through what has played so far" />
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

export function RadioPlayers() {
  return (
    <>
      {players.value.map((w) => (
        <Player key={w.id} w={w} />
      ))}
    </>
  );
}
