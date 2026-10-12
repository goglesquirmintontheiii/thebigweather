// Player pop-up extras: SAME decoder log and live transcript.

import { useEffect, useRef } from "preact/hooks";
import type { LivePlayer } from "../radio";
import { saveBlob } from "../radio";
import { toast } from "../store";
import { fmtBytes } from "../util";
import { areaList, sameSound, setSameSound, type SameEntry } from "../same/monitor";
import { fipsNames } from "../same/fips";
import { ORIGINATORS } from "../same/codes";
import { showCounties } from "../same/mapshow";
import { modelStatus, quality, QUALITY_LABEL, MODELS, type Quality } from "../transcribe/client";
import { Siren, Captions, Copy, Download, Bell, BellOff, MapPin, FlaskConical, Trash2, RotateCw } from "lucide-preact";

const hm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const LVL_COLOR: Record<string, string> = { emergency: "#ff00ff", warning: "#ff3b30", watch: "#ffb020", advisory: "#4aa3ff", statement: "#4aa3ff", test: "#8a96a6", admin: "#8a96a6" };

export function ToolButtons({ p }: { p: LivePlayer }) {
  const sOn = p.same.on.value;
  const tOn = p.tx.on.value;
  return (
    <div class="rp-tools">
      <button class={`btn sm ghost rp-tool ${sOn ? "on" : ""}`} aria-pressed={sOn} title={sOn ? "Stop decoding SAME / EAS data" : "Decode SAME / EAS headers and alert tones in this stream"} onClick={() => p.same.toggle()}>
        <Siren size={12} /> SAME
      </button>
      <button class={`btn sm ghost rp-tool ${tOn ? "on" : ""}`} aria-pressed={tOn} title={tOn ? "Hide and stop the live transcript" : "Show a live transcript (speech-to-text runs on this computer)"} onClick={() => p.tx.toggle()}>
        <Captions size={12} /> Transcribe
      </button>
      {p.snap.value.mode === "plain" && (sOn || tOn) && <small class="muted rp-warnnote" title="The stream doesn't allow reading its audio (no CORS); decoders may hear silence">audio may be unreadable</small>}
    </div>
  );
}

export function SamePanel({ p }: { p: LivePlayer }) {
  const m = p.same;
  if (!m.on.value) return null;
  fipsNames.value; // re-render when county names arrive
  const tone = m.tone.value;
  const log = m.log.value;
  return (
    <div class="rp-same">
      <div class="rp-sub">
        <span class={`rp-dot ${tone ? "tone" : "on"}`} />
        <small class="muted">{tone ? <b class="rp-tonelive">{tone.kind === "nwr" ? "1050 Hz NWR tone" : "EAS 853+960 Hz tone"} · {((Date.now() - tone.since) / 1000).toFixed(0)} s</b> : m.status.value || "Starting…"}</small>
        <span class="rp-fill" />
        <button class="icon-btn" title="Play and decode a test Tornado Warning header" onClick={() => m.test()}>
          <FlaskConical size={13} />
        </button>
        <button class="icon-btn" title={sameSound.value ? "Alert sound on for warnings" : "Alert sound off"} onClick={() => setSameSound(!sameSound.value)}>
          {sameSound.value ? <Bell size={13} /> : <BellOff size={13} />}
        </button>
        <button class="icon-btn" title="Clear the log" disabled={!log.length} onClick={() => m.clear()}>
          <Trash2 size={13} />
        </button>
      </div>
      <div class="rp-samelog">
        {!log.length && <div class="muted rp-empty">No SAME data yet. Headers, attention tones and end-of-message bursts heard on this stream are listed here.</div>}
        {log.map((e) => (
          <Entry key={e.id} e={e} p={p} />
        ))}
      </div>
    </div>
  );
}

function Entry({ e, p }: { e: SameEntry; p: LivePlayer }) {
  if (e.kind === "tone")
    return (
      <div class="same-e same-minor">
        <span class="muted">{hm(e.at)}</span> Attention tone · {e.tone === "nwr" ? "1050 Hz (NWR)" : "853 + 960 Hz (EAS)"} · {e.duration.toFixed(1)} s
      </div>
    );
  if (e.kind === "eom")
    return (
      <div class="same-e same-minor">
        <span class="muted">{hm(e.at)}</span> End of message (NNNN ×{e.copies})
      </div>
    );
  const h = e.header;
  if (!h)
    return (
      <div class="same-e">
        <div class="same-top">
          <b>Unreadable header</b> <span class="muted">{hm(e.at)}</span>
        </div>
        <code class="same-raw">{e.raw}</code>
      </div>
    );
  const mins = Math.round((h.expires.getTime() - Date.now()) / 60000);
  const color = LVL_COLOR[h.level];
  return (
    <div class={`same-e lvl-${h.level}`} style={{ borderLeftColor: color }}>
      <div class="same-top">
        <b style={{ color }}>{h.eventName}</b>
        {e.test && <span class="same-tag">TEST</span>}
        <span class="rp-fill" />
        <span class="muted" title="Received">
          {hm(e.at)}
        </span>
      </div>
      <div class="same-areas">{areaList(h)}</div>
      <div class="same-meta muted">
        Expires {hm(h.expires)} {mins > 0 ? `(in ${mins} min)` : "(expired)"} · issued {h.issued.toISOString().slice(5, 16).replace("T", " ")}Z · {h.purge.slice(0, 2)}h{h.purge.slice(2)}m
      </div>
      <div class="same-meta muted">
        <span title={ORIGINATORS[h.org] ?? ""}>{h.org}</span> · {h.orgName} · sender <b>{h.sender}</b> · {e.copies}/3 copies
      </div>
      <div class="same-foot">
        <code class="same-raw" title="Raw header">
          {e.raw}
        </code>
        <button class="btn sm ghost" title="Outline these areas on the map" onClick={() => showCounties(h.locations.map((l) => l.fips), `${h.eventName} (${p.stream.call ?? p.stream.name})`, color)}>
          <MapPin size={11} /> Map
        </button>
        <button class="icon-btn" title="Copy the raw header" onClick={() => navigator.clipboard?.writeText(e.raw).then(() => toast("Copied"))}>
          <Copy size={12} />
        </button>
      </div>
    </div>
  );
}

export function TranscriptPanel({ p }: { p: LivePlayer }) {
  const t = p.tx;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = t.on.value ? t.lines.value : [];
  useEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [lines.length, t.on.value]);
  if (!t.on.value) return null;
  const ms = modelStatus.value;
  const st = t.state.value;
  const q = quality.value;
  const short = (m?: string) => (m ?? "").split("/").pop()?.replace("whisper-", "") ?? "";
  let status: any;
  if (ms.phase === "loading")
    status = (
      <span class="rp-dl">
        <span>
          {ms.total ? `Downloading ${short(ms.model)} · ${Math.round(ms.pct)}% (${fmtBytes(ms.loaded ?? 0)} / ${fmtBytes(ms.total)})` : `Loading ${short(ms.model)}…`}
        </span>
        <span class="rp-bar">
          <i style={{ width: `${ms.pct}%` }} />
        </span>
      </span>
    );
  else if (ms.phase === "error")
    status = (
      <span class="rp-err" title={ms.error}>
        {ms.error}{" "}
        <button class="btn sm ghost" onClick={() => t.retry()}>
          <RotateCw size={11} /> Retry
        </button>
      </span>
    );
  else if (ms.phase === "ready") status = `Whisper ${short(ms.model)} · ${ms.device === "webgpu" ? "WebGPU" : "WASM"}${ms.lastMs ? ` · ${(ms.lastMs / 1000).toFixed(1)} s/chunk` : ""}${st.busy ? " · transcribing…" : ""}`;
  else status = "Starting…";
  return (
    <div class="rp-tx">
      <div class="rp-sub">
        <small class="muted rp-txstat">{status}</small>
        <span class="rp-fill" />
        <select class="rp-q" value={q ?? ""} title="Model: quality vs speed" onChange={(e) => t.setQuality((e.target as HTMLSelectElement).value as Quality)}>
          {!q && <option value="">Auto</option>}
          {(Object.keys(MODELS) as Quality[]).map((k) => (
            <option value={k}>{QUALITY_LABEL[k]}</option>
          ))}
        </select>
        <button class="icon-btn" title="Copy transcript" disabled={!lines.length} onClick={() => navigator.clipboard?.writeText(t.text()).then(() => toast("Transcript copied"))}>
          <Copy size={13} />
        </button>
        <button
          class="icon-btn"
          title="Save transcript as .txt"
          disabled={!lines.length}
          onClick={() => saveBlob(new Blob([t.text() + "\n"], { type: "text/plain" }), `${(p.stream.call ?? p.stream.name).replace(/[^\w.-]+/g, "_")}_transcript_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.txt`)}
        >
          <Download size={13} />
        </button>
      </div>
      <div
        ref={box}
        class="rp-txbox"
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label="Live transcript"
        tabIndex={0}
        onScroll={(e) => {
          const b = e.currentTarget as HTMLDivElement;
          stick.current = b.scrollTop + b.clientHeight >= b.scrollHeight - 12;
        }}
      >
        {!lines.length && <span class="muted">{ms.phase === "ready" ? "Listening… speech will appear here." : "Speech will appear here once the model is ready."}</span>}
        {lines.map((l, i) => (
          <div key={i} class="rp-line">
            <span class="muted">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span> {l.text}
          </div>
        ))}
        {st.error && ms.phase !== "error" && <div class="rp-err">{st.error}</div>}
      </div>
    </div>
  );
}
