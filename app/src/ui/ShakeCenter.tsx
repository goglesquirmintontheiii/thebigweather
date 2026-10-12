// Advanced seismograph viewer (lives in the Seismographs window, see ShakeMenu.tsx):
// stacked channels or multi-station compare with synced zoom/pan, paged time ranges up to 12 h,
// editable filters, counts or physical units, spectrogram, measure tool (peak/RMS/dominant
// frequency/PSD/rough ML), helicorder, quake P/S markers, CSV/WAV export and live refresh.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  shakeCompare,
  channels,
  liveChans,
  pickChan,
  fetchRange,
  prep,
  spectrogram,
  psd,
  winStats,
  mlRough,
  quakesIn,
  arrival,
  visibleAt,
  toCsv,
  toWav,
  playAudio,
  stopAudio,
  shakePlaying,
  filtLabel,
  staKey,
  isFav,
  toggleFav,
  FILTER_PRESETS,
  PALETTE,
  type ShakeSta,
  type ShakeChan,
  type Wave,
  type Quake,
  type FiltOpts,
} from "../shake";
import { settings } from "../store";
import { mapRef } from "../map/mapview";
import { fmtDist } from "../util";
import { saveFile, stamp } from "../saveio";
import { ExternalLink, MapPin, RefreshCw, Star, X, Ruler, Hand, Download, Play, Square, Radio, Plus, Layers2, ChartSpline, Rows3 } from "lucide-preact";

type Range = [number, number];

const tz = () => (settings.value.utc ? "UTC" : undefined);
const clock = (ms: number, sec = true) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: sec ? "2-digit" : undefined, hour12: false, timeZone: tz() });
const dayClock = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() });
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].map((s) => s * 1000);
const SPANS = [10, 30, 60, 120, 360, 720];
const spanLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
/** newest data the server will have (Raspberry Shake data is ≥30 min old) */
const latestEnd = () => Math.floor((Date.now() - 30 * 60000) / 60000) * 60000;

// ---------- units ----------

const isAccel = (u?: string | null) => /\*\*2|S2|²/i.test(u ?? "");
export function fmtAmp(v: number, phys: string | null): string {
  if (!phys) return Math.round(v).toLocaleString();
  const a = Math.abs(v);
  const acc = isAccel(phys);
  const unit = acc ? "/s²" : "/s";
  if (a === 0) return `0 m${unit}`;
  if (a < 1e-6) return `${(v * 1e9).toPrecision(3)} nm${unit}`;
  if (a < 1e-3) return `${(v * 1e6).toPrecision(3)} µm${unit}`;
  return `${(v * 1e3).toPrecision(3)} mm${unit}`;
}
const unitShort = (phys: string | null) => (!phys ? "counts" : isAccel(phys) ? "m/s²" : "m/s");

// ---------- canvas helpers ----------

function useWidth(ref: { current: HTMLElement | null }) {
  const [w, setW] = useState(800);
  useEffect(() => {
    const ro = new ResizeObserver(() => ref.current && setW(Math.max(200, ref.current.clientWidth)));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  return w;
}

function setupCanvas(c: HTMLCanvasElement, W: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  c.width = W * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, h);
  g.font = "10.5px Inter, system-ui, sans-serif";
  return g;
}

interface Interact {
  range: Range;
  setRange: (r: Range) => void;
  ext: Range;
  tool: "pan" | "measure";
  setSel: (r: Range | null) => void;
  onFocus?: () => void;
}

/** wheel = zoom around the cursor, drag = pan (or select in measure mode / with Shift), double-click = everything */
function handlers(it: Interact, L: number, W: number) {
  const { range, setRange, ext } = it;
  const span = range[1] - range[0];
  const tAt = (e: PointerEvent | WheelEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left - L) / (W - L)));
    return { f, t: range[0] + f * span };
  };
  return {
    onWheel: (e: WheelEvent) => {
      e.preventDefault();
      const { f, t } = tAt(e, e.currentTarget as HTMLElement);
      const ns = Math.max(3000, Math.min(ext[1] - ext[0], span * (e.deltaY > 0 ? 1.25 : 0.8)));
      let a = t - f * ns;
      a = Math.max(ext[0], Math.min(ext[1] - ns, a));
      setRange([a, a + ns]);
    },
    onPointerDown: (e: PointerEvent) => {
      it.onFocus?.();
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic event */
      }
      const x0 = e.clientX;
      const r0 = range;
      const measure = it.tool === "measure" || e.shiftKey;
      const t0 = tAt(e, el).t;
      if (measure) it.setSel(null);
      const move = (ev: PointerEvent) => {
        if (measure) {
          const t1 = tAt(ev, el).t;
          if (Math.abs(ev.clientX - x0) > 2) it.setSel([Math.min(t0, t1), Math.max(t0, t1)]);
          return;
        }
        const dt = ((ev.clientX - x0) / (W - L)) * (r0[1] - r0[0]);
        let a = r0[0] - dt;
        a = Math.max(ext[0], Math.min(ext[1] - (r0[1] - r0[0]), a));
        setRange([a, a + (r0[1] - r0[0])]);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    },
    onDblClick: () => setRange(ext),
  };
}

function timeAxis(g: CanvasRenderingContext2D, range: Range, L: number, W: number, y: number, top: number, labels = true) {
  const span = range[1] - range[0];
  const step = STEPS.find((s) => span / s <= 9) ?? 21600000;
  const X = (t: number) => L + ((t - range[0]) / span) * (W - L);
  const off = new Date().getTimezoneOffset() * 60000 * (settings.value.utc ? 0 : 1);
  g.fillStyle = "#8b97a6";
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.textAlign = "center";
  for (let t = Math.ceil((range[0] - off) / step) * step + off; t <= range[1]; t += step) {
    const x = X(t);
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, labels ? y - 12 : y);
    g.stroke();
    if (labels) g.fillText(clock(t, step < 60000), x, y);
  }
}

export interface Mark {
  t: number;
  color: string;
  label: string;
}

function drawMarks(g: CanvasRenderingContext2D, ms: Mark[], range: Range, L: number, W: number, top: number, bot: number) {
  const X = (t: number) => L + ((t - range[0]) / (range[1] - range[0])) * (W - L);
  g.font = "10px Inter, system-ui, sans-serif";
  g.textAlign = "left";
  ms.forEach((m, i) => {
    if (m.t < range[0] || m.t > range[1]) return;
    const x = X(m.t);
    g.strokeStyle = m.color;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bot);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = m.color;
    g.fillText(m.label, x + 3, top + 10 + (i % 2) * 12);
  });
}

function drawSel(g: CanvasRenderingContext2D, sel: Range | null, range: Range, L: number, W: number, top: number, bot: number) {
  if (!sel) return;
  const span = range[1] - range[0];
  const a = Math.max(L, L + ((sel[0] - range[0]) / span) * (W - L));
  const b = Math.min(W, L + ((sel[1] - range[0]) / span) * (W - L));
  if (b <= a) return;
  g.fillStyle = "rgba(250,204,21,.13)";
  g.fillRect(a, top, b - a, bot - top);
  g.strokeStyle = "rgba(250,204,21,.7)";
  g.beginPath();
  g.moveTo(a + 0.5, top);
  g.lineTo(a + 0.5, bot);
  g.moveTo(b - 0.5, top);
  g.lineTo(b - 0.5, bot);
  g.stroke();
}

export function visAmp(x: Float32Array, w: Wave, range: Range) {
  const i0 = Math.max(0, Math.floor(((range[0] - w.start) / 1000) * w.sr));
  const i1 = Math.min(x.length, Math.ceil(((range[1] - w.start) / 1000) * w.sr));
  let amp = 0;
  for (let i = i0; i < i1; i++) {
    const v = Math.abs(x[i]);
    if (v > amp) amp = v;
  }
  return amp;
}

interface TraceProps extends Interact {
  x: Float32Array;
  w: Wave;
  h: number;
  marks: Mark[];
  sel: Range | null;
  label: ComponentChildren;
  phys: string | null;
  amp?: number;
  focused?: boolean;
  axis?: boolean;
  color?: string;
}

const L_W = 74;

function Trace(p: TraceProps) {
  const { x, w, range, h, marks, sel, phys } = p;
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const L = L_W;
  useEffect(() => {
    const g = setupCanvas(cv.current!, W, h);
    const axis = p.axis !== false;
    const top = 4;
    const bot = axis ? h - 18 : h - 3;
    const mid = (top + bot) / 2;
    const span = range[1] - range[0];
    const cols = W - L;
    const i0 = Math.max(0, Math.floor(((range[0] - w.start) / 1000) * w.sr));
    const i1 = Math.min(x.length, Math.ceil(((range[1] - w.start) / 1000) * w.sr));
    const amp = p.amp || visAmp(x, w, range) || 1;
    const Y = (v: number) => mid - (Math.max(-amp, Math.min(amp, v)) / amp) * (bot - top) * 0.48;
    g.fillStyle = "rgba(248,113,113,.10)";
    for (const [a, b] of w.gaps) {
      const xa = L + ((a - range[0]) / span) * cols;
      const xb = L + ((b - range[0]) / span) * cols;
      if (xb > L && xa < W) g.fillRect(Math.max(L, xa), top, Math.min(W, xb) - Math.max(L, xa), bot - top);
    }
    timeAxis(g, range, L, W, axis ? h - 4 : bot, top, axis);
    drawSel(g, sel, range, L, W, top, bot);
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.beginPath();
    g.moveTo(L, mid);
    g.lineTo(W, mid);
    g.stroke();
    g.fillStyle = "#8b97a6";
    g.textAlign = "right";
    g.font = "9.5px Inter, system-ui, sans-serif";
    g.fillText(fmtAmp(amp, phys), L - 5, top + 9);
    g.fillText(unitShort(phys), L - 5, bot - 1);
    g.strokeStyle = p.color ?? "#93c5fd";
    g.lineWidth = 1;
    const per = (i1 - i0) / cols;
    g.beginPath();
    if (per > 2) {
      for (let c2 = 0; c2 < cols; c2++) {
        const a = Math.floor(i0 + c2 * per);
        const b = Math.min(i1, Math.floor(i0 + (c2 + 1) * per));
        if (b <= a) continue;
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = a; i < b; i++) {
          const v = x[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        // columns before the data start (or after its end) stay empty
        const t = w.start + (a / w.sr) * 1000;
        if (t < range[0] - 1000) continue;
        g.moveTo(L + c2 + 0.5, Y(mx));
        g.lineTo(L + c2 + 0.5, Y(mn) + 0.5);
      }
    } else {
      for (let i = i0; i < i1; i++) {
        const px = L + ((w.start + (i / w.sr) * 1000 - range[0]) / span) * cols;
        if (i === i0) g.moveTo(px, Y(x[i]));
        else g.lineTo(px, Y(x[i]));
      }
    }
    g.stroke();
    drawMarks(g, marks, range, L, W, top, bot);
  }, [x, range, W, h, marks, sel, p.amp, phys, settings.value.utc]);
  return (
    <div ref={box} class={`sk-canvas sk-trace ${p.focused ? "focus" : ""} ${p.tool === "measure" ? "measure" : ""}`}>
      <div class="sk-tlabel">{p.label}</div>
      <canvas ref={cv} style={{ width: `${W}px`, height: `${h}px` }} {...(handlers(p, L, W) as any)} />
    </div>
  );
}

function Spectro(p: Interact & { x: Float32Array; w: Wave; h: number; marks: Mark[]; sel: Range | null }) {
  const { x, w, range, h, marks } = p;
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const L = L_W;
  // p7: redraw when the panel becomes visible again (a draw while hidden/collapsed can be lost)
  const [vis, setVis] = useState(0);
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVis((v) => v + 1));
    if (box.current) io.observe(box.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!cv.current || !x.length || !(w.sr > 0)) return;
    const g = setupCanvas(cv.current, W, h);
    const top = 4;
    const bot = h - 18;
    const cols = Math.max(1, Math.floor(W - L));
    try {
    const i0 = ((range[0] - w.start) / 1000) * w.sr;
    const i1 = ((range[1] - w.start) / 1000) * w.sr;
    const nfft = w.sr >= 80 ? 256 : 128;
    const sp = spectrogram(x, i0, i1, cols, nfft);
    const rows = Math.max(1, Math.floor(bot - top));
    const img = new ImageData(cols, rows);
    const k = 255 / (sp.hi - sp.lo || 1);
    for (let yy = 0; yy < rows; yy++) {
      const b = Math.min(sp.bins - 1, Math.floor((1 - yy / rows) * sp.bins));
      for (let cc = 0; cc < cols; cc++) {
        const v = Math.max(0, Math.min(255, (sp.db[cc * sp.bins + b] - sp.lo) * k)) | 0;
        const o = (yy * cols + cc) * 4;
        img.data[o] = PALETTE[v * 3];
        img.data[o + 1] = PALETTE[v * 3 + 1];
        img.data[o + 2] = PALETTE[v * 3 + 2];
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, L, top, cols, rows);
    } catch (e) {
      g.fillStyle = "#f87171";
      g.fillText(`Spectrogram failed: ${(e as Error).message}`, L + 8, top + 16);
    }
    g.fillStyle = "#8b97a6";
    g.textAlign = "right";
    const ny = w.sr / 2;
    for (const f of [0, ny / 4, ny / 2, (3 * ny) / 4, ny]) g.fillText(`${f.toFixed(f < 10 ? 1 : 0)}`, L - 5, bot - (f / ny) * (bot - top) + 3);
    g.save();
    g.translate(12, (top + bot) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = "center";
    g.fillText("Hz", 0, 0);
    g.restore();
    timeAxis(g, range, L, W, h - 4, bot);
    drawSel(g, p.sel, range, L, W, top, bot);
    drawMarks(g, marks, range, L, W, top, bot);
  }, [x, w, range, W, h, marks, p.sel, settings.value.utc, vis]);
  return (
    <div ref={box} class="sk-canvas">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${h}px` }} {...(handlers(p, L, W) as any)} />
    </div>
  );
}

const HELI_COLORS = ["#93c5fd", "#f87171", "#86efac", "#fcd34d"];

function Heli({ x, w, lineMin, win, marks, phys }: { x: Float32Array; w: Wave; lineMin: number; win: Range; marks: Mark[]; phys: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const L = 50;
  const lineMs = lineMin * 60000;
  const t0 = Math.floor(win[0] / lineMs) * lineMs;
  const lines = Math.max(1, Math.ceil((win[1] - t0) / lineMs));
  const rowH = Math.max(18, Math.min(40, 560 / lines));
  const H = lines * rowH + 26;
  useEffect(() => {
    const g = setupCanvas(cv.current!, W, H);
    // clip at a few robust deviations so quiet lines stay readable
    const abs: number[] = [];
    const stp = Math.max(1, Math.floor(x.length / 5000));
    for (let i = 0; i < x.length; i += stp) abs.push(Math.abs(x[i]));
    abs.sort((a, b) => a - b);
    const clip = Math.max(1e-30, (abs[Math.floor(abs.length * 0.5)] ?? 1) * 12);
    const cols = W - L;
    for (let r = 0; r < lines; r++) {
      const ls = t0 + r * lineMs;
      const mid = 8 + rowH * (r + 0.5);
      g.fillStyle = "#8b97a6";
      g.textAlign = "right";
      g.fillText(clock(ls, false), L - 6, mid + 3);
      g.strokeStyle = HELI_COLORS[r % HELI_COLORS.length];
      g.beginPath();
      for (let c2 = 0; c2 < cols; c2++) {
        const ta = ls + (c2 / cols) * lineMs;
        const tb = ls + ((c2 + 1) / cols) * lineMs;
        const a = Math.max(0, Math.floor(((ta - w.start) / 1000) * w.sr));
        const b = Math.min(x.length, Math.floor(((tb - w.start) / 1000) * w.sr));
        if (b <= a) continue;
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = a; i < b; i++) {
          const v = x[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const k = (rowH * 0.9) / clip;
        g.moveTo(L + c2 + 0.5, mid - Math.min(clip, mx) * k);
        g.lineTo(L + c2 + 0.5, mid - Math.max(-clip, mn) * k + 0.5);
      }
      g.stroke();
      for (const m of marks) {
        if (m.t < ls || m.t >= ls + lineMs) continue;
        const px = L + ((m.t - ls) / lineMs) * cols;
        g.fillStyle = m.color;
        g.fillRect(px - 1, mid - rowH / 2 + 2, 2, rowH - 4);
      }
    }
    g.fillStyle = "#8b97a6";
    g.textAlign = "center";
    const tick = lineMin >= 30 ? 5 : lineMin >= 10 ? 2 : 1;
    for (let m = 0; m <= lineMin; m += tick) g.fillText(`+${m}m`, L + (m / lineMin) * cols, H - 4);
    g.textAlign = "right";
    g.fillText(`clip ±${fmtAmp(clip, phys)}`, W - 4, H - 4);
  }, [x, W, lineMin, marks, win[0], win[1], phys, settings.value.utc]);
  return (
    <div ref={box} class="sk-canvas">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${H}px` }} />
    </div>
  );
}

function PsdPlot({ f, db }: { f: Float32Array; db: Float32Array }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const H = 150;
  useEffect(() => {
    const g = setupCanvas(cv.current!, W, H);
    const L = 38, top = 6, bot = H - 16;
    const fmin = Math.max(0.05, f[1] || 0.1);
    const fmax = f[f.length - 1] || 50;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < db.length; i++) {
      if (f[i] < fmin) continue;
      lo = Math.min(lo, db[i]);
      hi = Math.max(hi, db[i]);
    }
    if (!Number.isFinite(lo)) return;
    lo = Math.floor(lo / 10) * 10;
    hi = Math.ceil(hi / 10) * 10 || lo + 10;
    const X = (fr: number) => L + (Math.log10(fr / fmin) / Math.log10(fmax / fmin)) * (W - L - 4);
    const Y = (v: number) => bot - ((v - lo) / (hi - lo || 1)) * (bot - top);
    g.strokeStyle = "rgba(255,255,255,.07)";
    g.fillStyle = "#8b97a6";
    g.textAlign = "center";
    for (const fr of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]) {
      if (fr < fmin || fr > fmax) continue;
      g.beginPath();
      g.moveTo(X(fr), top);
      g.lineTo(X(fr), bot);
      g.stroke();
      g.fillText(`${fr}`, X(fr), H - 3);
    }
    g.textAlign = "right";
    const st = (hi - lo) / 10 > 4 ? 20 : 10;
    for (let v = lo; v <= hi; v += st) {
      g.fillText(`${v}`, L - 4, Y(v) + 3);
      g.beginPath();
      g.moveTo(L, Y(v));
      g.lineTo(W, Y(v));
      g.stroke();
    }
    g.strokeStyle = "#facc15";
    g.lineWidth = 1.3;
    g.beginPath();
    let first = true;
    for (let i = 1; i < f.length; i++) {
      if (f[i] < fmin) continue;
      first ? g.moveTo(X(f[i]), Y(db[i])) : g.lineTo(X(f[i]), Y(db[i]));
      first = false;
    }
    g.stroke();
    g.fillStyle = "#8b97a6";
    g.textAlign = "left";
    g.fillText("dB · Hz (log)", L + 4, top + 9);
  }, [f, db, W]);
  return (
    <div ref={box} class="sk-canvas sk-psd">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${H}px` }} />
    </div>
  );
}

// ---------- the viewer ----------

interface TrackDef {
  key: string;
  st: ShakeSta;
  ch: ShakeChan;
}
interface TrackData {
  w?: Wave;
  err?: string;
  prog: number;
}

const CH_COLORS: Record<string, string> = { Z: "#93c5fd", N: "#86efac", E: "#fca5a5" };
const chColor = (cha: string) => CH_COLORS[cha.slice(-1)] ?? "#c4b5fd";

export function ShakeViewer({ st, onClose }: { st: ShakeSta; onClose: () => void }) {
  const [mode, setMode] = useState<"channels" | "compare" | "heli">("channels");
  const [span, setSpan] = useState(30);
  const [anchor, setAnchor] = useState<"latest" | "custom">("latest");
  const [cStart, setCStart] = useState(() => toLocalInput(latestEnd() - 3 * 3600000));
  const [cEnd, setCEnd] = useState(() => toLocalInput(latestEnd() - 2 * 3600000));
  const [live, setLive] = useState(false);
  const [liveEvery, setLiveEvery] = useState(2);
  const [nonce, setNonce] = useState(0);
  const [filt, setFilt] = useState<FiltOpts>({ detrend: true, kind: "none", lo: 1, hi: 10 });
  const [units, setUnits] = useState<"counts" | "phys">("counts");
  const [spec, setSpec] = useState(false);
  const [same, setSame] = useState(false);
  const [tool, setTool] = useState<"pan" | "measure">("pan");
  const [sel, setSel] = useState<Range | null>(null);
  const [focus, setFocus] = useState<string>("");
  const [qSel, setQSel] = useState<string | null>(null);
  const [comp, setComp] = useState("Z");
  const [chOff, setChOff] = useState<Record<string, boolean>>({});
  const [heliMin, setHeliMin] = useState(0);
  const [speed, setSpeed] = useState(200);
  const [chans, setChans] = useState<Record<string, ShakeChan[] | string>>({});
  const [data, setData] = useState<Record<string, TrackData>>({});
  const [quakes, setQuakes] = useState<Quake[]>([]);
  const [range, setRange] = useState<Range>([0, 1]);
  const [loadedAt, setLoadedAt] = useState(0);
  const cmp = shakeCompare.value;
  const sk = staKey(st);
  const stations = useMemo(() => [st, ...cmp.filter((s) => staKey(s) !== sk)], [sk, cmp]);

  // channel lists for every station in view
  useEffect(() => {
    for (const s of stations) {
      const k = staKey(s);
      if (chans[k]) continue;
      channels(s)
        .then((cs) => setChans((o) => ({ ...o, [k]: cs.length ? cs : "No channels" })))
        .catch((e) => setChans((o) => ({ ...o, [k]: e.message || "Failed" })));
    }
  }, [stations.map(staKey).join()]);

  const win = useMemo((): Range => {
    const end0 = latestEnd();
    if (anchor === "latest") return [end0 - span * 60000, end0];
    let a = Date.parse(cStart);
    let b = Date.parse(cEnd);
    if (!(a < b)) b = a + span * 60000;
    b = Math.min(b, end0);
    a = Math.max(a, b - 12 * 3600000);
    return [a, b];
  }, [anchor, span, cStart, cEnd, nonce]);

  const own = chans[sk];
  const ownList = Array.isArray(own) ? liveChans(own) : [];
  const defs: TrackDef[] = useMemo(() => {
    if (mode === "compare") {
      const out: TrackDef[] = [];
      for (const s of stations) {
        const cs = chans[staKey(s)];
        if (!Array.isArray(cs)) continue;
        const c = pickChan(cs, comp);
        if (c) out.push({ key: `${staKey(s)}.${c.loc}.${c.cha}`, st: s, ch: c });
      }
      return out;
    }
    const list = ownList.filter((c) => !chOff[`${c.loc}.${c.cha}`]);
    const ds = list.map((c) => ({ key: `${sk}.${c.loc}.${c.cha}`, st, ch: c }));
    if (mode === "heli") {
      const f = ds.find((d) => d.key === focus) ?? ds.find((d) => d.ch.cha.endsWith("Z")) ?? ds[0];
      return f ? [f] : [];
    }
    return ds;
  }, [mode, stations, chans, comp, chOff, focus]);
  const defKey = defs.map((d) => d.key).join();

  // load data (paged, cached) for every track
  useEffect(() => {
    if (!defs.length) return;
    const ac = new AbortController();
    setData((o) => {
      const n: Record<string, TrackData> = {};
      // keep the old trace while reloading only when it covers about the same window (live refresh)
      for (const d of defs) {
        const ow = o[d.key]?.w;
        n[d.key] = { w: ow && Math.abs(ow.start - win[0]) <= 10 * 60000 ? ow : undefined, prog: 0 };
      }
      return n;
    });
    // p7: results/progress of a superseded load (window or channel change) must not land on the new one —
    // a stale "100 %" used to stick while the current load's data never replaced it
    for (const d of defs)
      fetchRange(d.st, d.ch, win[0], win[1], (f) => !ac.signal.aborted && setData((o) => ({ ...o, [d.key]: { ...o[d.key], prog: Math.min(f, 0.99) } })), ac.signal)
        .then((w) => !ac.signal.aborted && setData((o) => ({ ...o, [d.key]: { w, prog: 1 } })))
        .catch((e) => e.name !== "AbortError" && !ac.signal.aborted && setData((o) => ({ ...o, [d.key]: { prog: 1, err: e.message } })));
    setLoadedAt(Date.now());
    return () => ac.abort();
  }, [defKey, win[0], win[1]]);

  // reset zoom when the window changes; keep it on live refresh
  const prevWin = useRef<Range>([0, 0]);
  useEffect(() => {
    const pw = prevWin.current;
    const wasFull = range[0] <= pw[0] + 1 && range[1] >= pw[1] - 1;
    if (wasFull || range[1] < win[0] || range[0] > win[1]) setRange(win);
    else setRange([Math.max(win[0], range[0]), Math.min(win[1], range[1])]);
    prevWin.current = win;
    setSel(null);
  }, [win[0], win[1]]);

  useEffect(() => {
    quakesIn(win[0], win[1])
      .then(setQuakes)
      .catch(() => setQuakes([]));
  }, [win[0], win[1]]);

  // live: re-anchor to the newest data every few minutes
  useEffect(() => {
    if (!live || anchor !== "latest") return;
    const t = window.setInterval(() => setNonce((n) => n + 1), liveEvery * 60000);
    return () => clearInterval(t);
  }, [live, liveEvery, anchor]);

  const physOf = (c: ShakeChan) => (units === "phys" && c.scale ? c.units || "M/S" : null);
  const xs = useMemo(() => {
    const o: Record<string, Float32Array> = {};
    for (const d of defs) {
      const w = data[d.key]?.w;
      if (w && w.samples.length) o[d.key] = prep(w, filt, units === "phys" ? d.ch.scale : null);
    }
    return o;
  }, [data, filt, units, defKey]);

  const quake = quakes.find((q) => q.id === qSel) ?? null;
  const marksFor = (s: ShakeSta): Mark[] => {
    const qs = quake ? [quake] : quakes.filter((q) => visibleAt(q, s)).slice(0, 4);
    const out: Mark[] = [];
    for (const q of qs) {
      const a = arrival(q, s);
      if (quake) out.push({ t: q.time, color: "#f472b6", label: "origin" });
      out.push({ t: a.p, color: "#22d3ee", label: `P≈ M${q.mag.toFixed(1)}` }, { t: a.s, color: "#fb923c", label: `S≈` });
    }
    return out;
  };
  const marks = useMemo(() => Object.fromEntries(stations.map((s) => [staKey(s), marksFor(s)])), [quakes, qSel, stations]);

  // compare: order by distance from the selected quake (or from the main station)
  const ordered = useMemo(() => {
    if (mode !== "compare") return defs;
    const dkm = (s: ShakeSta) => (quake ? arrival(quake, s).km : Math.hypot(s.lat - st.lat, (s.lon - st.lon) * Math.cos((st.lat * Math.PI) / 180)) * 111);
    return [...defs].sort((a, b) => dkm(a.st) - dkm(b.st));
  }, [defs, quake, mode]);

  const ampShared = useMemo(() => {
    if (!same) return 0;
    let m = 0;
    for (const d of defs) {
      const x = xs[d.key];
      const w = data[d.key]?.w;
      if (x && w) m = Math.max(m, visAmp(x, w, range));
    }
    return m;
  }, [same, xs, range]);

  const focusDef = defs.find((d) => d.key === focus) ?? defs[0];
  const fx = focusDef ? xs[focusDef.key] : undefined;
  const fw = focusDef ? data[focusDef.key]?.w : undefined;
  const mwin: Range = sel ?? range;
  const stats = useMemo(() => (fx && fw ? winStats(fx, fw.sr, fw.start, mwin[0], mwin[1]) : null), [fx, fw, mwin[0], mwin[1]]);
  const spectrum = useMemo(() => {
    if (!fx || !fw || !sel) return null;
    return psd(fx, ((sel[0] - fw.start) / 1000) * fw.sr, ((sel[1] - fw.start) / 1000) * fw.sr, fw.sr);
  }, [fx, fw, sel?.[0], sel?.[1]]);
  const fPhys = focusDef ? physOf(focusDef.ch) : null;
  const ml = stats && quake && focusDef && fPhys && !isAccel(fPhys) ? mlRough(stats.peak, stats.domF, arrival(quake, focusDef.st).hypo) : null;

  const prog = defs.length ? defs.reduce((a, d) => a + (data[d.key]?.prog ?? 0), 0) / defs.length : 1;
  const loading = prog < 1;
  const it = (k: string): Interact => ({ range, setRange, ext: win, tool, setSel, onFocus: () => setFocus(k) });

  const exportCsv = async () => {
    const cols = defs.filter((d) => xs[d.key] && data[d.key]?.w).map((d) => ({ name: `${d.st.net}.${d.st.sta}.${d.ch.loc}.${d.ch.cha}${physOf(d.ch) ? `_${unitShort(physOf(d.ch)).replace("/", "per").replace("²", "2")}` : "_counts"}`, x: xs[d.key], sr: data[d.key]!.w!.sr, start: data[d.key]!.w!.start }));
    if (!cols.length) return;
    await saveFile(`shake-${sk}-${stamp()}.csv`, toCsv(cols, mwin[0], mwin[1]), "text/csv");
  };
  const wav = () => {
    if (!fx || !fw) return null;
    return toWav(fx, ((mwin[0] - fw.start) / 1000) * fw.sr, ((mwin[1] - fw.start) / 1000) * fw.sr, fw.sr, speed);
  };

  const elev = st.elev != null ? (settings.value.units.distance === "km" ? `${Math.round(st.elev)} m` : `${Math.round(st.elev * 3.281)} ft`) : null;
  const visQ = quakes.filter((q) => stations.some((s) => visibleAt(q, s)) || q.id === qSel).slice(0, 15);
  const chH = mode === "compare" ? (defs.length > 4 ? 96 : 120) : defs.length > 3 ? 112 : 140;

  return (
    <div class="sk-viewer">
      <div class="sk-vhead">
        <div class="sk-vtitle">
          <b>{st.name || st.sta}</b> <span class="muted">{sk}</span>
          <small class="muted">
            {elev && `${elev} · `}
            {st.lat.toFixed(3)}, {st.lon.toFixed(3)} ·{" "}
            <a href={`https://stationview.raspberryshake.org/#/?sta=${encodeURIComponent(st.sta)}`} target="_blank" rel="noreferrer">
              StationView <ExternalLink size={10} />
            </a>
          </small>
        </div>
        <button class={`icon-btn ${isFav(st) ? "fav" : ""}`} title={isFav(st) ? "Remove favourite" : "Add to favourites"} onClick={() => toggleFav(st)}>
          <Star size={15} />
        </button>
        {mapRef.value && (
          <button class="icon-btn" title="Show on map" onClick={() => mapRef.value!.flyTo({ center: [st.lon, st.lat], zoom: Math.max(8, mapRef.value!.getZoom()) })}>
            <MapPin size={15} />
          </button>
        )}
        <button class="icon-btn" title="Reload" onClick={() => setNonce(nonce + 1)}>
          <RefreshCw size={15} class={loading ? "spin" : ""} />
        </button>
        <button class="icon-btn" title="Close viewer" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div class="sk-ctl">
        <div class="seg">
          {(
            [
              ["channels", "Channels", Rows3],
              ["compare", "Compare", Layers2],
              ["heli", "Helicorder", ChartSpline],
            ] as const
          ).map(([k, l, I]) => (
            <button key={k} class={mode === k ? "on" : ""} onClick={() => setMode(k)}>
              <I size={13} /> {l}
            </button>
          ))}
        </div>
        <div class="seg">
          {SPANS.map((m) => (
            <button key={m} class={span === m && anchor === "latest" ? "on" : ""} onClick={() => (setSpan(m), setAnchor("latest"))}>
              {spanLabel(m)}
            </button>
          ))}
          <button class={anchor === "custom" ? "on" : ""} onClick={() => setAnchor("custom")}>
            Custom…
          </button>
        </div>
        {anchor === "custom" && (
          <span class="sk-custom">
            <input type="datetime-local" value={cStart} onChange={(e) => setCStart((e.target as HTMLInputElement).value)} />
            <span class="muted">→</span>
            <input type="datetime-local" value={cEnd} onChange={(e) => setCEnd((e.target as HTMLInputElement).value)} />
          </span>
        )}
        {anchor === "latest" && (
          <label class={`sk-live ${live ? "on" : ""}`} title="Re-load the newest data every few minutes (Raspberry Shake data is at least 30 min old)">
            <input type="checkbox" checked={live} onChange={(e) => setLive((e.target as HTMLInputElement).checked)} />
            <Radio size={12} /> Live
            {live && (
              <select value={liveEvery} onChange={(e) => setLiveEvery(+(e.target as HTMLSelectElement).value)}>
                <option value={2}>2 min</option>
                <option value={5}>5 min</option>
              </select>
            )}
          </label>
        )}
      </div>
      <div class="sk-ctl">
        <select
          title="Filter preset"
          value=""
          onChange={(e) => {
            const p = FILTER_PRESETS[+(e.target as HTMLSelectElement).value];
            if (p) setFilt({ ...filt, ...p.f });
            (e.target as HTMLSelectElement).value = "";
          }}
        >
          <option value="">Presets…</option>
          {FILTER_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <select value={filt.kind} onChange={(e) => setFilt({ ...filt, kind: (e.target as HTMLSelectElement).value as any })} title="Filter type">
          <option value="none">No filter</option>
          <option value="bp">Band-pass</option>
          <option value="hp">High-pass</option>
          <option value="lp">Low-pass</option>
        </select>
        {(filt.kind === "bp" || filt.kind === "hp") && (
          <label class="sk-num" title="Low corner (Hz)">
            <input type="number" min={0.01} step={0.1} value={filt.lo} onChange={(e) => setFilt({ ...filt, lo: Math.max(0.01, +(e.target as HTMLInputElement).value || 0.01) })} /> Hz
          </label>
        )}
        {filt.kind === "bp" && <span class="muted">–</span>}
        {(filt.kind === "bp" || filt.kind === "lp") && (
          <label class="sk-num" title="High corner (Hz)">
            <input type="number" min={0.02} step={0.5} value={filt.hi} onChange={(e) => setFilt({ ...filt, hi: Math.max(0.02, +(e.target as HTMLInputElement).value || 1) })} /> Hz
          </label>
        )}
        <label class="sk-chk">
          <input type="checkbox" checked={filt.detrend} onChange={(e) => setFilt({ ...filt, detrend: (e.target as HTMLInputElement).checked })} /> Detrend
        </label>
        <div class="seg" title="Counts, or ground velocity/acceleration using the channel's sensitivity (approximate: flat response assumed)">
          <button class={units === "counts" ? "on" : ""} onClick={() => setUnits("counts")}>
            Counts
          </button>
          <button class={units === "phys" ? "on" : ""} onClick={() => setUnits("phys")}>
            Velocity
          </button>
        </div>
        {mode !== "heli" && (
          <>
            <label class="sk-chk">
              <input type="checkbox" checked={spec} onChange={(e) => setSpec((e.target as HTMLInputElement).checked)} /> Spectrogram
            </label>
            <label class="sk-chk" title="Same amplitude scale on every trace">
              <input type="checkbox" checked={same} onChange={(e) => setSame((e.target as HTMLInputElement).checked)} /> Same scale
            </label>
            <div class="seg" title="Drag: pan or select a window to measure (Shift+drag also selects)">
              <button class={tool === "pan" ? "on" : ""} onClick={() => setTool("pan")}>
                <Hand size={13} />
              </button>
              <button class={tool === "measure" ? "on" : ""} onClick={() => setTool("measure")}>
                <Ruler size={13} /> Measure
              </button>
            </div>
          </>
        )}
      </div>
      {mode === "channels" && ownList.length > 0 && (
        <div class="chips sk-chans">
          {ownList.map((c) => {
            const k = `${c.loc}.${c.cha}`;
            return (
              <button key={k} class={`chip ${chOff[k] ? "" : "on"}`} style={{ "--chc": chColor(c.cha) } as any} onClick={() => setChOff({ ...chOff, [k]: !chOff[k] })} title={`${c.sensor ?? ""} ${c.scale ? `· ${c.scale.toExponential(3)} counts per ${c.units ?? "unit"}` : ""}`}>
                {c.cha}
                {c.loc && c.loc !== "00" ? ` (${c.loc})` : ""} <small>{c.sr} Hz</small>
              </button>
            );
          })}
        </div>
      )}
      {mode === "compare" && (
        <div class="chips sk-chans">
          {["Z", "N", "E"].map((c) => (
            <button key={c} class={`chip ${comp === c ? "on" : ""}`} onClick={() => setComp(c)}>
              {c === "Z" ? "Vertical" : c === "N" ? "North" : "East"}
            </button>
          ))}
          <span class="muted small">
            {stations.length} station{stations.length === 1 ? "" : "s"} · add more with <Plus size={11} /> in the list · sorted by distance {quake ? `from M${quake.mag.toFixed(1)} ${quake.place}` : `from ${st.sta}`}
          </span>
          {cmp.length > 0 && (
            <button class="btn sm ghost" onClick={() => (shakeCompare.value = [])}>
              Clear
            </button>
          )}
        </div>
      )}
      {mode === "heli" && (
        <div class="chips sk-chans">
          {ownList.map((c) => {
            const k = `${sk}.${c.loc}.${c.cha}`;
            return (
              <button key={k} class={`chip ${defs[0]?.key === k ? "on" : ""}`} onClick={() => setFocus(k)}>
                {c.cha}
              </button>
            );
          })}
          <select value={heliMin} onChange={(e) => setHeliMin(+(e.target as HTMLSelectElement).value)} title="Minutes per line">
            <option value={0}>Auto lines</option>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} min / line
              </option>
            ))}
          </select>
          <span class="muted small">Use 6 h or 12 h for a longer helicorder (loaded an hour at a time and cached).</span>
        </div>
      )}

      {loading && (
        <div class="sk-prog" title="Loading (the server allows 2 h per request; longer ranges load in pieces)">
          <i style={{ width: `${Math.round(prog * 100)}%` }} />
          <span>
            Loading {spanLabel(Math.round((win[1] - win[0]) / 60000))} · {Math.round(prog * 100)}%
          </span>
        </div>
      )}

      <div class="sk-plot">
        {!defs.length && <div class="sk-msg muted">{typeof own === "string" ? own : "Loading channels…"}</div>}
        {mode === "heli" &&
          defs.map((d) => {
            const x = xs[d.key];
            const w = data[d.key]?.w;
            const lm = heliMin || Math.max(5, [5, 10, 15, 30, 60].find((m) => (win[1] - win[0]) / (m * 60000) <= 24) ?? 60);
            return x && w ? <Heli key={d.key} x={x} w={w} lineMin={lm} win={win} marks={marks[staKey(d.st)] ?? []} phys={physOf(d.ch)} /> : <div class="sk-msg muted">{data[d.key]?.err ?? "Loading…"}</div>;
          })}
        {mode !== "heli" &&
          ordered.map((d, i) => {
            const x = xs[d.key];
            const w = data[d.key]?.w;
            const err = data[d.key]?.err;
            const dist = mode === "compare" ? (quake ? arrival(quake, d.st).km * 1000 : i > 0 ? Math.hypot(d.st.lat - st.lat, (d.st.lon - st.lon) * Math.cos((st.lat * Math.PI) / 180)) * 111000 : null) : null;
            const label = (
              <>
                <b style={{ color: chColor(d.ch.cha) }}>{mode === "compare" ? d.st.sta : d.ch.cha}</b>
                {mode === "compare" && <span>{d.ch.cha}</span>}
                {dist != null && <span>{fmtDist(dist)}</span>}
                {mode === "compare" && i > 0 && (
                  <button class="icon-btn" title="Remove from compare" onClick={() => (shakeCompare.value = cmp.filter((s) => staKey(s) !== staKey(d.st)))}>
                    <X size={10} />
                  </button>
                )}
              </>
            );
            return (
              <div key={d.key} class="sk-row">
                {x && w ? (
                  <>
                    <Trace {...it(d.key)} x={x} w={w} h={chH} marks={marks[staKey(d.st)] ?? []} sel={sel} label={label} phys={physOf(d.ch)} amp={ampShared || undefined} focused={focusDef?.key === d.key && defs.length > 1} axis={i === ordered.length - 1 || spec} color={mode === "compare" ? undefined : chColor(d.ch.cha)} />
                    {spec && focusDef?.key === d.key && <Spectro {...it(d.key)} x={x} w={w} h={150} marks={marks[staKey(d.st)] ?? []} sel={sel} />}
                  </>
                ) : (
                  <div class="sk-rowmsg">
                    <div class="sk-tlabel">{label}</div>
                    <span class={err ? "err-text" : "muted"}>{err ?? `Loading… ${Math.round((data[d.key]?.prog ?? 0) * 100)}%`}</span>
                  </div>
                )}
              </div>
            );
          })}
        {mode !== "heli" && defs.length > 0 && (
          <div class="muted small sk-hint">
            {dayClock(range[0])} – {clock(range[1])} · {filtLabel(filt)}
            {units === "phys" && " · approx. ground motion (flat response)"} · wheel zoom, drag {tool === "measure" ? "select" : "pan (Shift+drag selects)"}, double-click resets
            {live && anchor === "latest" && ` · live, updated ${clock(loadedAt, false)}`}
          </div>
        )}
      </div>

      {mode !== "heli" && stats && focusDef && (
        <div class="sk-measure">
          <div class="sk-mstats">
            <label class="lbl">
              {sel ? "Selection" : "Visible window"} · {focusDef.st.sta} {focusDef.ch.cha} · {((mwin[1] - mwin[0]) / 1000).toFixed(1)} s
              {sel && (
                <button class="icon-btn" title="Clear selection" onClick={() => setSel(null)}>
                  <X size={11} />
                </button>
              )}
            </label>
            <div class="sk-kv">
              <span>Peak</span>
              <b>{fmtAmp(stats.peak, fPhys)}</b>
              <span>at</span>
              <b>{clock(stats.peakT)}</b>
              <span>RMS</span>
              <b>{fmtAmp(stats.rms, fPhys)}</b>
              <span>Peak-to-peak</span>
              <b>{fmtAmp(stats.p2p, fPhys)}</b>
              <span>Dominant freq.</span>
              <b>{stats.domF.toFixed(2)} Hz</b>
              <span title="Very rough: velocity → Wood-Anderson displacement at the dominant frequency, Hutton & Boore distance correction, single station">ML (rough)</span>
              <b>{ml != null ? `≈ ${ml.toFixed(1)}` : <span class="muted">{!quake ? "pick a quake" : !fPhys ? "needs Velocity" : "—"}</span>}</b>
            </div>
            <div class="sk-export">
              <button class="btn sm ghost" onClick={exportCsv} title="All shown traces, selected (or visible) window">
                <Download size={13} /> CSV
              </button>
              <button
                class="btn sm ghost"
                onClick={async () => {
                  const r = wav();
                  if (r) await saveFile(`shake-${focusDef.st.sta}-${focusDef.ch.cha}-x${speed}-${stamp()}.wav`, r.blob, "audio/wav");
                }}
              >
                <Download size={13} /> WAV
              </button>
              <button
                class="btn sm"
                onClick={() => {
                  if (shakePlaying.value) return stopAudio();
                  const r = wav();
                  if (r) playAudio(r.data, r.rate);
                }}
                title="Listen: the waveform sped up so it's audible"
              >
                {shakePlaying.value ? <Square size={13} /> : <Play size={13} />} Listen
              </button>
              <select value={speed} onChange={(e) => setSpeed(+(e.target as HTMLSelectElement).value)} title="Speed-up">
                {[100, 200, 300, 400].map((s) => (
                  <option key={s} value={s}>
                    ×{s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="sk-mpsd">
            {spectrum ? <PsdPlot f={spectrum.f} db={spectrum.db} /> : <div class="muted small sk-msg">Select a window ({tool === "measure" ? "drag" : "Shift+drag"} on a trace) for its spectrum (PSD).</div>}
          </div>
        </div>
      )}

      <div class="sk-quakes">
        <label class="lbl">Earthquakes that may show in this window · click to mark arrivals{mode === "compare" ? " and sort stations by distance" : ""}</label>
        {visQ.length === 0 && <div class="muted small">None found from the Earthquakes feed.</div>}
        {visQ.length > 0 && (
          <table class="sk-qt">
            <tbody>
              {visQ.map((q) => {
                const a = arrival(q, st);
                return (
                  <tr
                    key={q.id}
                    class={q.id === qSel ? "on" : ""}
                    onClick={() => {
                      const on = q.id !== qSel;
                      setQSel(on ? q.id : null);
                      if (on) setRange([Math.max(win[0], a.p - 30000), Math.min(win[1], Math.max(a.s + 90000, a.p + 60000))]);
                    }}
                    title="Mark arrivals and zoom to them"
                  >
                    <td>
                      <b>M{q.mag.toFixed(1)}</b>
                    </td>
                    <td class="l">{q.place}</td>
                    <td>{fmtDist(a.km * 1000)}</td>
                    <td>origin {clock(q.time)}</td>
                    <td class="p">P≈ {clock(a.p)}</td>
                    <td class="s">S≈ {clock(a.s)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p class="muted small">
        Data: Raspberry Shake (not for redistribution). P/S marks: crustal/Pn velocities near the source and a coarse Jeffreys–Bullen table beyond 10°, rough. Velocity uses the channel sensitivity only (no instrument response correction). ML is a single-station estimate, rough.
      </p>
    </div>
  );
}
