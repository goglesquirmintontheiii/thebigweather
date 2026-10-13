// models 0.7: probability gate cards for the model layers (bottom-right, stacked above the weather
// legend). Two handles hide features below / above a probability, exactly like the radar legend
// gate: drag, scroll to nudge (Shift = 5%), live map update (MapLibre setFilter, no refetch).
// "Scrub" locks the window width so dragging a handle (or the window itself) sweeps it through the
// probabilities; ▶ sweeps it automatically. The outlook card also holds the category legend, day /
// hazard selectors, a custom valid range and the probability-grid toggle.

import { useEffect, useRef, useState } from "preact/hooks";
import { Eye, EyeOff, X, MoveHorizontal, Play, Pause, Grid3x3, SlidersHorizontal } from "lucide-preact";
import { settings } from "../../store";
import { gateDrag, type Gate } from "../../gate";
import { isOn } from "../../overlays/manager";
import { probGate, setProbGate, pgKey, scrub, PG_DET, PG_OUT } from "../../ml/probgate";
import { detProbs } from "../../overlays/mldefs";
import { outProbs, outOpts, setOutOpt, CATS, CAT_FILL, CAT_LINE, CAT_NAME, HAZARDS, DAYS, outlookData, probGridOn, toggleProbGrid, outlookModels } from "../../ml/outlook";
import { LEVEL_COLOR } from "../../ml/targets";
import { mkey } from "../../ml/client";
import { fmtTime } from "../../util";

/** keep the stack just above the weather legend (and the contour/barb dock when it's there) */
function useAnchor() {
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 12, bottom: 14 });
  useEffect(() => {
    const upd = () => {
      let top = Infinity, right = 12;
      for (const sel of [".legend:not(.top)", ".d6-lines"]) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el || !el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        if (r.top < top) (top = r.top), (right = Math.round(window.innerWidth - r.right));
      }
      const app = document.querySelector<HTMLElement>(".app")?.getBoundingClientRect();
      const H = app?.bottom ?? window.innerHeight;
      const next = Number.isFinite(top) ? { right, bottom: Math.round(H - top + 6) } : { right: 12, bottom: 14 };
      setPos((p) => (p.right === next.right && p.bottom === next.bottom ? p : next));
    };
    upd();
    const t = setInterval(upd, 600);
    window.addEventListener("resize", upd);
    return () => (clearInterval(t), window.removeEventListener("resize", upd));
  }, []);
  return pos;
}

export function ProbGates() {
  void settings.value.ovl;
  const det = isOn(PG_DET);
  const out = isOn(PG_OUT);
  const pos = useAnchor();
  if (!det && !out) return null;
  return (
    <div class="mlg-stack" style={{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }}>
      {out && <OutlookCard />}
      {det && <GateBar layer={PG_DET} title="Model detections" probs={detProbs.value} unit="detections" />}
    </div>
  );
}

const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`;
const P = (v: number) => `${Math.round(v * 100)}%`;
const GRAD = `linear-gradient(90deg, #64748b 0%, ${LEVEL_COLOR.low} 30%, ${LEVEL_COLOR.med} 55%, ${LEVEL_COLOR.high} 80%, #ff2ab4 100%)`;

export function GateBar({ layer, title, probs, unit, compact }: { layer: string; title?: string; probs: number[]; unit: string; compact?: boolean }) {
  const key = pgKey(layer);
  const { lo, hi, on, g } = probGate(layer);
  const saved: Gate = settings.value.gates?.[key] ?? {};
  const sc = !!scrub.value[layer];
  const bar = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | undefined>(undefined);
  useEffect(() => () => clearInterval(playRef.current), []);

  const fracAt = (e: { clientX: number }) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const snap = (v: number) => Math.round(v * 100) / 100;
  /** normalise: handles at the ends of the scale mean "no cut" */
  const norm = (l: number, h: number): Gate => ({ lo: l <= 0.004 ? undefined : snap(l), hi: h >= 0.996 ? undefined : snap(h), off: undefined });
  const commit = (n: Gate) => setProbGate(layer, n);
  const live = (n: Gate) => (gateDrag.value = { key, g: n });
  const end = () => {
    const d = gateDrag.peek();
    gateDrag.value = null;
    if (d && d.key === key) commit(d.g);
  };
  /** move the whole window (scrub) so its low edge is at `l` */
  const shift = (l: number, w: number) => {
    const L = Math.max(0, Math.min(1 - w, l));
    return norm(L, L + w);
  };

  const startDrag = (which: "lo" | "hi" | "win") => (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    stopPlay();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    const l0 = lo, h0 = hi, w = h0 - l0, f0 = fracAt(e);
    const move = (ev: PointerEvent) => {
      const f = fracAt(ev);
      setTip(f);
      if (which === "win" || sc) {
        const anchor = which === "hi" ? f - w : which === "lo" ? f : l0 + (f - f0);
        live(shift(anchor, w));
      } else if (which === "lo") live(norm(Math.min(f, h0), h0));
      else live(norm(l0, Math.max(f, l0)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setTip(null);
      end();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    if (which !== "win") move(e);
  };
  const nudge = (which: "lo" | "hi" | "win", d: number) => {
    const c = probGate(layer);
    if (which === "win" || sc) return commit(shift(c.lo + d, c.hi - c.lo));
    if (which === "lo") commit(norm(Math.max(0, Math.min(c.hi, c.lo + d)), c.hi));
    else commit(norm(c.lo, Math.min(1, Math.max(c.lo, c.hi + d))));
  };
  const wheel = (which: "lo" | "hi" | "win") => (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    nudge(which, (e.deltaY < 0 ? 0.01 : -0.01) * (e.shiftKey ? 5 : 1));
  };
  function stopPlay() {
    if (playRef.current === undefined) return;
    clearInterval(playRef.current);
    playRef.current = undefined;
    setPlaying(false);
    end();
  }
  const play = () => {
    if (playing) return stopPlay();
    const c = probGate(layer);
    const w = c.on && c.hi - c.lo < 0.99 ? c.hi - c.lo : 0.2;
    let l = c.on && c.hi < 0.999 ? c.lo : 0;
    setPlaying(true);
    live(shift(l, w));
    playRef.current = window.setInterval(() => {
      l += 0.01;
      if (l + w > 1.0001) l = 0;
      live(shift(l, w));
    }, 90);
  };

  const n = probs.length;
  const inside = probs.filter((p) => p >= lo - 1e-9 && p <= hi + 1e-9).length;
  const text = !on ? "All" : g.lo !== undefined && g.hi !== undefined ? `${Math.round(lo * 100)}–${P(hi)}` : g.lo !== undefined ? `≥ ${P(lo)}` : `≤ ${P(hi)}`;
  // distribution ticks (one per 2%)
  const hist = new Array(50).fill(0);
  for (const p of probs) hist[Math.min(49, Math.floor(p * 50))]++;
  const hmax = Math.max(1, ...hist);
  return (
    <div class={`mlg glass ${compact ? "compact" : ""} ${on ? "on" : ""} ${g.off ? "paused" : ""}`}>
      {title && (
        <div class="mlg-head">
          <b>{title}</b>
          <span class={`mlg-txt ${on ? "on" : ""}`}>{text}</span>
          <span class="mlg-n" title={`${inside} of ${n} ${unit} inside the window`}>
            {inside}/{n}
          </span>
          <span class="mlg-btns">
            <button class={`lg-btn ${sc ? "on" : ""}`} title="Scrub: lock the window width — dragging a handle (or the window) sweeps it through the probabilities" onClick={() => (scrub.value = { ...scrub.value, [layer]: !sc })}>
              <MoveHorizontal size={12} />
            </button>
            <button class={`lg-btn ${playing ? "on" : ""}`} title={playing ? "Stop the sweep" : "Sweep the window through the probabilities"} onClick={play}>
              {playing ? <Pause size={11} /> : <Play size={11} />}
            </button>
            {(on || g.off) && (
              <button class="lg-btn" title={saved.off ? "Gate paused — click to apply" : "Gate on — click to pause"} onClick={() => commit({ ...saved, off: saved.off ? undefined : true })}>
                {saved.off ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            )}
            {(on || g.off) && (
              <button class="lg-btn" title="Reset (show everything)" onClick={() => (stopPlay(), commit({}))}>
                <X size={11} />
              </button>
            )}
          </span>
        </div>
      )}
      <div class="mlg-bar lbar" ref={bar} onWheel={wheel("win") as any}>
        <div class="bar" style={{ background: GRAD }} />
        <div class="mlg-hist">
          {hist.map((h, i) => (h ? <i key={i} style={{ left: `${i * 2}%`, height: `${3 + (h / hmax) * 11}px` }} /> : null))}
        </div>
        {on && !g.off && lo > 0 && <div class="lg-mask" style={{ left: 0, width: pct(lo) }} />}
        {on && !g.off && hi < 1 && <div class="lg-mask" style={{ left: pct(hi), width: pct(1 - hi) }} />}
        {on && !g.off && <div class="mlg-win" style={{ left: pct(lo), width: pct(hi - lo) }} onPointerDown={startDrag("win") as any} title="Drag to move the window" />}
        <div class={`lg-h lo ${g.lo !== undefined && !g.off ? "set" : ""}`} style={{ left: pct(lo) }} title="Hide below (drag, scroll)" onPointerDown={startDrag("lo") as any} onWheel={wheel("lo") as any} />
        <div class={`lg-h hi ${g.hi !== undefined && !g.off ? "set" : ""}`} style={{ left: pct(hi) }} title="Hide above (drag, scroll)" onPointerDown={startDrag("hi") as any} onWheel={wheel("hi") as any} />
        {tip !== null && (
          <div class="lg-tip" style={{ left: pct(Math.max(0.08, Math.min(0.92, tip))) }}>
            {text}
          </div>
        )}
      </div>
      <div class="lticks">
        {[0, 25, 50, 75, 100].map((v) => (
          <span key={v}>{v}%</span>
        ))}
      </div>
    </div>
  );
}

function OutlookCard() {
  const o = outOpts();
  const d = outlookData.value;
  const [more, setMore] = useState(false);
  const feats: any[] = d.fc?.features ?? [];
  const count = (c: string) => feats.filter((f) => f.properties.cat === c).length;
  const toLocal = (t?: number) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
  const fromLocal = (v: string) => (v ? String(new Date(v).getTime()) : undefined);
  const models = outlookModels.value;
  return (
    <div class="mlg glass mlo">
      <div class="mlg-head">
        <b>Model outlook</b>
        {models.length > 1 ? (
          <select class="mlo-model" value={o.model} onChange={(e) => setOutOpt("model", (e.target as HTMLSelectElement).value)}>
            {models.map((m) => (
              <option key={mkey(m)} value={mkey(m)}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span class="mlg-txt">{models[0]?.name ?? ""}</span>
        )}
        <span class="mlg-btns">
          <button class={`lg-btn ${probGridOn.value ? "on" : ""}`} disabled={!d.prob_layer} title={d.prob_layer ? "Probability grid as the weather layer" : "This model sends no probability grid"} onClick={toggleProbGrid}>
            <Grid3x3 size={12} />
          </button>
          <button class={`lg-btn ${more ? "on" : ""}`} title="Hazard and valid range" onClick={() => setMore(!more)}>
            <SlidersHorizontal size={12} />
          </button>
        </span>
      </div>
      <div class="seg mlo-days">
        {DAYS.map(([k, l]) => (
          <button key={k} class={o.day === k ? "on" : ""} onClick={() => setOutOpt("day", k)}>
            {l.replace("Custom range", "Range")}
          </button>
        ))}
      </div>
      {(more || o.day === "custom") && (
        <div class="mlo-more">
          <div class="seg mlo-haz">
            {HAZARDS.map(([k, l]) => (
              <button key={k} class={o.hazard === k ? "on" : ""} onClick={() => setOutOpt("hazard", k)}>
                {l.replace(" severe", "")}
              </button>
            ))}
          </div>
          {o.day === "custom" && (
            <div class="mlo-range">
              <input type="datetime-local" value={toLocal(o.from)} onChange={(e) => setOutOpt("from", fromLocal((e.target as HTMLInputElement).value))} />
              <span>→</span>
              <input type="datetime-local" value={toLocal(o.to)} onChange={(e) => setOutOpt("to", fromLocal((e.target as HTMLInputElement).value))} />
            </div>
          )}
        </div>
      )}
      <div class="mlo-cats">
        {CATS.map((c) => (
          <span key={c} class={`mlo-cat ${count(c) ? "" : "none"}`} title={`${CAT_NAME[c]}${count(c) ? ` · ${count(c)} area${count(c) > 1 ? "s" : ""}` : ""}`}>
            <i style={{ background: CAT_FILL[c], borderColor: CAT_LINE[c] }} />
            {c}
          </span>
        ))}
      </div>
      <div class="mlo-valid muted">
        {d.loading ? "Loading…" : d.err ? <span class="mlo-err">{d.err}</span> : d.valid_from ? `Valid ${fmtTime(d.valid_from, true)}${d.valid_to ? ` → ${fmtTime(d.valid_to, true)}` : ""} · ${o.hazard === "any" ? "any severe" : o.hazard}` : feats.length ? "" : "No risk areas"}
      </div>
      <GateBar layer={PG_OUT} title="Probability" probs={outProbs.value} unit="areas" compact />
    </div>
  );
}
