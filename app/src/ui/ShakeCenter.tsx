// Seismograph window for a Raspberry Shake station: waveform (min/max envelope, zoom/pan,
// detrend, band-pass), spectrogram, helicorder, nearby-quake P/S estimates, station search.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { shakeSel, shakeOpen, loadStations, channels, waveform, prep, spectrogram, quakesFor, FILTERS, PALETTE, type ShakeSta, type ShakeChan, type Wave, type QuakeHit } from "../shake";
import { settings } from "../store";
import { mapRef } from "../map/mapview";
import { distance, fmtDist } from "../util";
import { CenterModal } from "./CenterModal";
import { Activity, Search, RefreshCw, ExternalLink, MapPin, Crosshair } from "lucide-preact";

type Range = [number, number];

const tz = () => (settings.value.utc ? "UTC" : undefined);
const clock = (ms: number, sec = true) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: sec ? "2-digit" : undefined, hour12: false, timeZone: tz() });
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

function useWidth(ref: { current: HTMLElement | null }) {
  const [w, setW] = useState(800);
  useEffect(() => {
    const ro = new ResizeObserver(() => ref.current && setW(Math.max(200, ref.current.clientWidth)));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  return w;
}

/** wheel = zoom around the cursor, drag = pan, double-click = everything */
function zoomPan(range: Range, setRange: (r: Range) => void, ext: Range, L: number, W: number) {
  const span = range[1] - range[0];
  return {
    onWheel: (e: WheelEvent) => {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left - L) / (W - L)));
      const at = range[0] + f * span;
      const ns = Math.max(4000, Math.min(ext[1] - ext[0], span * (e.deltaY > 0 ? 1.25 : 0.8)));
      let a = at - f * ns;
      a = Math.max(ext[0], Math.min(ext[1] - ns, a));
      setRange([a, a + ns]);
    },
    onPointerDown: (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const r0 = range;
      const move = (ev: PointerEvent) => {
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

function timeAxis(g: CanvasRenderingContext2D, range: Range, L: number, W: number, y: number, top: number) {
  const span = range[1] - range[0];
  const step = STEPS.find((s) => span / s <= 9) ?? 7200000;
  const X = (t: number) => L + ((t - range[0]) / span) * (W - L);
  const off = new Date().getTimezoneOffset() * 60000 * (settings.value.utc ? 0 : 1);
  g.fillStyle = "#8b97a6";
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.textAlign = "center";
  for (let t = Math.ceil((range[0] - off) / step) * step + off; t <= range[1]; t += step) {
    const x = X(t);
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, y - 12);
    g.stroke();
    g.fillText(clock(t, step < 60000), x, y);
  }
}

function markers(g: CanvasRenderingContext2D, qs: QuakeHit[], range: Range, L: number, W: number, top: number, bot: number) {
  const X = (t: number) => L + ((t - range[0]) / (range[1] - range[0])) * (W - L);
  g.font = "10px Inter, system-ui, sans-serif";
  g.textAlign = "left";
  for (const q of qs) {
    for (const [k, t, c] of [["P", q.p, "#22d3ee"], ["S", q.s, "#fb923c"]] as const) {
      if (t < range[0] || t > range[1]) continue;
      const x = X(t);
      g.strokeStyle = c;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x, bot);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = c;
      g.fillText(`${k}≈ M${q.mag.toFixed(1)}`, x + 3, top + (k === "P" ? 10 : 23));
    }
  }
}

function Trace({ x, w, range, setRange, quakes, h }: { x: Float32Array; w: Wave; range: Range; setRange: (r: Range) => void; quakes: QuakeHit[]; h: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const L = 56;
  const ext: Range = [w.start, w.start + (x.length / w.sr) * 1000];
  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, h);
    g.font = "10.5px Inter, system-ui, sans-serif";
    const top = 4;
    const bot = h - 18;
    const mid = (top + bot) / 2;
    const span = range[1] - range[0];
    const cols = W - L;
    const i0 = Math.max(0, Math.floor(((range[0] - w.start) / 1000) * w.sr));
    const i1 = Math.min(x.length, Math.ceil(((range[1] - w.start) / 1000) * w.sr));
    let amp = 1;
    for (let i = i0; i < i1; i++) {
      const v = Math.abs(x[i]);
      if (v > amp) amp = v;
    }
    const Y = (v: number) => mid - (v / amp) * (bot - top) * 0.48;
    // gaps
    g.fillStyle = "rgba(248,113,113,.10)";
    for (const [a, b] of w.gaps) {
      const xa = L + ((a - range[0]) / span) * cols;
      const xb = L + ((b - range[0]) / span) * cols;
      if (xb > L && xa < W) g.fillRect(Math.max(L, xa), top, Math.min(W, xb) - Math.max(L, xa), bot - top);
    }
    timeAxis(g, range, L, W, h - 4, top);
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.beginPath();
    g.moveTo(L, mid);
    g.lineTo(W, mid);
    g.stroke();
    g.fillStyle = "#8b97a6";
    g.textAlign = "right";
    g.fillText(`${Math.round(amp).toLocaleString()}`, L - 5, top + 9);
    g.fillText(`-${Math.round(amp).toLocaleString()}`, L - 5, bot);
    g.fillText("counts", L - 5, mid + 3);
    g.strokeStyle = "#93c5fd";
    g.lineWidth = 1;
    const per = (i1 - i0) / cols;
    g.beginPath();
    if (per > 2) {
      // min/max envelope per pixel column
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
    markers(g, quakes, range, L, W, top, bot);
  }, [x, range, W, h, quakes, settings.value.utc]);
  return (
    <div ref={box} class="sk-canvas">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${h}px` }} {...(zoomPan(range, setRange, ext, L, W) as any)} />
    </div>
  );
}

function Spectro({ x, w, range, setRange, quakes, h }: { x: Float32Array; w: Wave; range: Range; setRange: (r: Range) => void; quakes: QuakeHit[]; h: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const L = 56;
  const ext: Range = [w.start, w.start + (x.length / w.sr) * 1000];
  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, h);
    g.font = "10.5px Inter, system-ui, sans-serif";
    const top = 4;
    const bot = h - 18;
    const cols = Math.max(1, Math.floor(W - L));
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
    // putImageData ignores the transform: draw through a scratch canvas
    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, L, top, cols, rows);
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
    markers(g, quakes, range, L, W, top, bot);
  }, [x, range, W, h, quakes, settings.value.utc]);
  return (
    <div ref={box} class="sk-canvas">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${h}px` }} {...(zoomPan(range, setRange, ext, L, W) as any)} />
    </div>
  );
}

const HELI_COLORS = ["#93c5fd", "#f87171", "#86efac", "#fcd34d"];

function Heli({ x, w, minutes, quakes }: { x: Float32Array; w: Wave; minutes: number; quakes: QuakeHit[] }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useWidth(box);
  const H = 460;
  const L = 50;
  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = "10.5px Inter, system-ui, sans-serif";
    const lines = 12;
    const lineMs = minutes * 60000;
    const end = w.start + (x.length / w.sr) * 1000;
    const t0 = Math.ceil(end / lineMs - 0.01) * lineMs - lines * lineMs;
    const rowH = (H - 22) / lines;
    // clip at a few robust deviations so quiet lines stay readable
    const abs: number[] = [];
    const stp = Math.max(1, Math.floor(x.length / 5000));
    for (let i = 0; i < x.length; i += stp) abs.push(Math.abs(x[i]));
    abs.sort((a, b) => a - b);
    const clip = Math.max(1, (abs[Math.floor(abs.length * 0.5)] ?? 1) * 12);
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
      for (const q of quakes)
        for (const [t, col] of [[q.p, "#22d3ee"], [q.s, "#fb923c"]] as const) {
          if (t < ls || t >= ls + lineMs) continue;
          const px = L + ((t - ls) / lineMs) * cols;
          g.fillStyle = col;
          g.fillRect(px - 1, mid - rowH / 2 + 2, 2, rowH - 4);
        }
    }
    g.fillStyle = "#8b97a6";
    g.textAlign = "center";
    for (let m = 0; m <= minutes; m += minutes >= 10 ? 2 : 1) g.fillText(`+${m}m`, L + (m / minutes) * cols, H - 4);
  }, [x, W, minutes, quakes, settings.value.utc]);
  return (
    <div ref={box} class="sk-canvas">
      <canvas ref={cv} style={{ width: `${W}px`, height: `${H}px` }} />
    </div>
  );
}

function StationSearch() {
  const [all, setAll] = useState<ShakeSta[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    loadStations().then(setAll).catch(() => setAll([]));
  }, []);
  const c = mapRef.value?.getCenter();
  const qq = q.trim().toLowerCase();
  const hits = useMemo(() => (all && qq ? all.filter((s) => `${s.net}.${s.sta} ${s.name ?? ""}`.toLowerCase().includes(qq)).slice(0, 30) : []), [all, qq]);
  const near = useMemo(() => (all && c ? all.map((s) => ({ s, d: distance(c.lat, c.lng, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 10) : []), [all, c?.lat, c?.lng]);
  const cur = shakeSel.value;
  const item = (s: ShakeSta, d?: number) => (
    <button key={`${s.net}.${s.sta}`} class={`sk-st ${cur?.sta === s.sta && cur?.net === s.net ? "on" : ""}`} onClick={() => (shakeSel.value = s)}>
      <b>{s.sta}</b>
      <small class="muted">{s.name || s.net}</small>
      {d != null && <small class="muted sk-d">{fmtDist(d)}</small>}
    </button>
  );
  return (
    <div class="sk-side">
      <div class="search">
        <Search size={14} />
        <input placeholder="Station code or name" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      {all === null && <div class="muted small">Loading stations…</div>}
      {qq ? (
        <>
          <label class="lbl">Matches · {hits.length}</label>
          {hits.map((s) => item(s))}
        </>
      ) : (
        near.length > 0 && (
          <>
            <label class="lbl">
              <Crosshair size={10} /> Nearest to map center
            </label>
            {near.map(({ s, d }) => item(s, d))}
          </>
        )
      )}
    </div>
  );
}

export function ShakeCenter() {
  if (!shakeOpen.value || !shakeSel.value) return null;
  return <ShakeBody st={shakeSel.value} />;
}

function ShakeBody({ st }: { st: ShakeSta }) {
  const [chans, setChans] = useState<ShakeChan[] | null>(null);
  const [cha, setCha] = useState("");
  const [dur, setDur] = useState(30);
  const [from, setFrom] = useState<"latest" | "custom">("latest");
  const [custom, setCustom] = useState(() => {
    const d = new Date(Date.now() - 3 * 3600000);
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [filter, setFilter] = useState("none");
  const [view, setView] = useState<"wave" | "spec" | "both" | "heli">("wave");
  const [heliMin, setHeliMin] = useState(5);
  const [wave, setWave] = useState<Wave | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<Range>([0, 1]);
  const [quakes, setQuakes] = useState<QuakeHit[]>([]);
  const [nonce, setNonce] = useState(0);
  const key = `${st.net}.${st.sta}`;
  useEffect(() => {
    setChans(null);
    setWave(null);
    setErr(null);
    channels(st)
      .then((cs) => {
        const live = cs.filter((c) => !c.end || Date.parse(c.end) > Date.now() - 86400000);
        const list = live.length ? live : cs;
        setChans(list);
        const pick = ["EHZ", "SHZ", "HHZ", "ENZ"].map((z) => list.find((c) => c.cha === z)).find(Boolean) ?? list[0];
        setCha(pick ? `${pick.loc}.${pick.cha}` : "");
        if (!list.length) setErr("No channels for this station");
      })
      .catch((e) => setErr(e.message));
  }, [key]);
  const ch = chans?.find((c) => `${c.loc}.${c.cha}` === cha);
  const minutes = view === "heli" ? 12 * heliMin : dur;
  const win = useMemo((): Range => {
    const latest = Math.floor((Date.now() - 30 * 60000) / 60000) * 60000;
    const end = from === "latest" ? latest : Math.min(latest, Date.parse(custom) + minutes * 60000);
    return [end - minutes * 60000, end];
  }, [from, custom, minutes, nonce]);
  useEffect(() => {
    if (!ch) return;
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    waveform(st, ch, win[0], win[1], ac.signal)
      .then((w) => {
        setWave(w);
        setRange([w.start, w.start + (w.samples.length / w.sr) * 1000]);
        if (!w.samples.length) setErr("No data in this window");
      })
      .catch((e) => e.name !== "AbortError" && setErr(e.message))
      .finally(() => setBusy(false));
    quakesFor(st, win[0], win[1])
      .then(setQuakes)
      .catch(() => setQuakes([]));
    return () => ac.abort();
  }, [ch?.cha, ch?.loc, win[0], win[1], key]);
  const x = useMemo(() => (wave ? prep(wave, filter) : null), [wave, filter]);
  const elev = st.elev != null ? (settings.value.units.distance === "km" ? `${Math.round(st.elev)} m` : `${Math.round(st.elev * 3.281)} ft`) : null;
  const visQ = quakes.filter((q) => wave && q.p <= win[1] && q.s >= win[0] - 60000);
  return (
    <CenterModal
      cls="sk"
      icon={<Activity size={20} />}
      title={
        <>
          Seismograph · {st.name || st.sta} <small class="muted">{key}</small>
        </>
      }
      sub={
        <>
          {elev && `${elev} · `}
          {st.lat.toFixed(3)}, {st.lon.toFixed(3)} ·{" "}
          <a href={`https://stationview.raspberryshake.org/#/?sta=${encodeURIComponent(st.sta)}`} target="_blank" rel="noreferrer">
            StationView <ExternalLink size={10} />
          </a>
        </>
      }
      onClose={() => (shakeOpen.value = false)}
      actions={
        <>
          {mapRef.value && (
            <button class="icon-btn" title="Show on map" onClick={() => (mapRef.value!.flyTo({ center: [st.lon, st.lat], zoom: Math.max(8, mapRef.value!.getZoom()) }), (shakeOpen.value = false))}>
              <MapPin size={15} />
            </button>
          )}
          <button class="icon-btn" title="Reload" onClick={() => setNonce(nonce + 1)}>
            <RefreshCw size={15} class={busy ? "spin" : ""} />
          </button>
        </>
      }
    >
      <div class="sk-grid">
        <StationSearch />
        <div class="sk-main">
          <div class="sk-ctl">
            <select value={cha} onChange={(e) => setCha((e.target as HTMLSelectElement).value)} title="Channel">
              {(chans ?? []).map((c) => (
                <option key={`${c.loc}.${c.cha}`} value={`${c.loc}.${c.cha}`}>
                  {c.cha}
                  {c.loc && c.loc !== "00" ? ` (${c.loc})` : ""} · {c.sr} Hz
                </option>
              ))}
            </select>
            {view !== "heli" && (
              <div class="seg">
                {[30, 60, 120].map((m) => (
                  <button key={m} class={dur === m ? "on" : ""} onClick={() => setDur(m)}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </button>
                ))}
              </div>
            )}
            <select value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value as any)} title="Window">
              <option value="latest">Latest data</option>
              <option value="custom">From…</option>
            </select>
            {from === "custom" && <input type="datetime-local" value={custom} onChange={(e) => setCustom((e.target as HTMLInputElement).value)} />}
            <select value={filter} onChange={(e) => setFilter((e.target as HTMLSelectElement).value)} title="Band-pass filter">
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <div class="seg">
              {(
                [
                  ["wave", "Waveform"],
                  ["spec", "Spectrogram"],
                  ["both", "Both"],
                  ["heli", "Helicorder"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} class={view === k ? "on" : ""} onClick={() => setView(k)}>
                  {l}
                </button>
              ))}
            </div>
            {view === "heli" && (
              <select value={heliMin} onChange={(e) => setHeliMin(+(e.target as HTMLSelectElement).value)}>
                <option value={5}>12 × 5 min</option>
                <option value={10}>12 × 10 min</option>
              </select>
            )}
          </div>
          <div class="sk-plot">
            {err && <div class="sk-msg err-text">{err}</div>}
            {!err && !x && <div class="sk-msg muted">{busy || !chans ? "Loading…" : "No data"}</div>}
            {x && wave && x.length > 0 && (
              <>
                {(view === "wave" || view === "both") && <Trace x={x} w={wave} range={range} setRange={setRange} quakes={visQ} h={view === "both" ? 200 : 380} />}
                {(view === "spec" || view === "both") && <Spectro x={x} w={wave} range={range} setRange={setRange} quakes={visQ} h={view === "both" ? 200 : 380} />}
                {view === "heli" && <Heli x={x} w={wave} minutes={heliMin} quakes={visQ} />}
                {view !== "heli" && (
                  <div class="muted small sk-hint">
                    {clock(range[0])} – {clock(range[1])} · {wave.sr} Hz · detrended{filter !== "none" ? `, ${FILTERS.find((f) => f.id === filter)?.label}` : ""} · wheel to zoom, drag to pan, double-click to reset
                  </div>
                )}
              </>
            )}
          </div>
          <div class="sk-quakes">
            <label class="lbl">Earthquakes in this window (approximate P/S arrivals)</label>
            {visQ.length === 0 && <div class="muted small">None found from the Earthquakes feed.</div>}
            {visQ.length > 0 && (
              <table class="sk-qt">
                <tbody>
                  {visQ.map((q) => (
                    <tr key={q.id} onClick={() => wave && setRange([Math.max(wave.start, q.p - 30000), Math.min(wave.start + (wave.samples.length / wave.sr) * 1000, Math.max(q.s + 90000, q.p + 60000))])} title="Zoom to the arrivals">
                      <td>
                        <b>M{q.mag.toFixed(1)}</b>
                      </td>
                      <td class="l">{q.place}</td>
                      <td>{fmtDist(q.km * 1000)}</td>
                      <td>origin {clock(q.time)}</td>
                      <td class="p">P≈ {clock(q.p)}</td>
                      <td class="s">S≈ {clock(q.s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p class="muted small">Data: Raspberry Shake (not for redistribution). Arrival marks use straight-line distance at ~6 km/s (P) and ~3.5 km/s (S): rough, worse for far quakes.</p>
        </div>
      </div>
    </CenterModal>
  );
}
