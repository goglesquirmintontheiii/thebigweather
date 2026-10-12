// Detection models: small canvas charts for the model detail (threshold curve, ROC, reliability).
// Thin 2 px lines, recessive grid, legend + direct labels, hover crosshair with a readout.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Metrics } from "../../ml/types";
import { scoresAt } from "./common";

const C = { pod: "#1e9be6", far: "#c87204", csi: "#a66ae8", grid: "rgba(255,255,255,.07)", axis: "rgba(255,255,255,.22)", text: "#8b97a6", ink: "#e7edf4", diag: "rgba(255,255,255,.18)" };
const PAD = { l: 34, r: 34, t: 10, b: 26 };

type Draw = (c: CanvasRenderingContext2D, w: number, h: number, X: (v: number) => number, Y: (v: number) => number) => void;

function useCanvas(draw: Draw, deps: any[], hover?: number | null) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const paint = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr;
      cv.height = h * dpr;
      const c = cv.getContext("2d")!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      const X = (v: number) => PAD.l + v * (w - PAD.l - PAD.r);
      const Y = (v: number) => h - PAD.b - v * (h - PAD.t - PAD.b);
      // grid + axes
      c.font = "10px Inter, system-ui, sans-serif";
      c.fillStyle = C.text;
      c.strokeStyle = C.grid;
      c.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = i / 4;
        c.beginPath();
        c.moveTo(X(0), Y(v) + 0.5);
        c.lineTo(X(1), Y(v) + 0.5);
        c.stroke();
        c.textAlign = "right";
        c.textBaseline = "middle";
        c.fillText(v.toFixed(2).replace(/^0/, "").replace(/^1\.00$/, "1"), X(0) - 5, Y(v));
        c.textAlign = "center";
        c.textBaseline = "top";
        c.fillText(v.toFixed(2).replace(/^0/, "").replace(/^1\.00$/, "1"), X(v), Y(0) + 6);
      }
      draw(c, w, h, X, Y);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [...deps, hover]);
  return ref;
}

function line(c: CanvasRenderingContext2D, pts: [number, number][], col: string, X: (v: number) => number, Y: (v: number) => number, dash: number[] = []) {
  const ok = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (ok.length < 2) return;
  c.strokeStyle = col;
  c.lineWidth = 2;
  c.lineJoin = "round";
  c.setLineDash(dash);
  c.beginPath();
  ok.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
  c.stroke();
  c.setLineDash([]);
}
function endLabel(c: CanvasRenderingContext2D, txt: string, col: string, x: number, y: number) {
  c.fillStyle = C.ink;
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.font = "600 10px Inter, system-ui, sans-serif";
  c.fillText(txt, x + 5, y);
  c.fillStyle = col;
  c.fillRect(x - 1, y - 1, 3, 3);
}

/** POD / FAR / CSI against the decision threshold, with the current threshold marked. */
export function ThresholdChart({ m, thr, onPick }: { m: Metrics; thr: number; onPick?: (t: number) => void }) {
  const [hov, setHov] = useState<number | null>(null);
  const curve: { t: number; pod: number; far: number; csi: number }[] = [];
  for (let t = 0.02; t <= 0.981; t += 0.02) {
    const s = scoresAt(m, t);
    if (s) curve.push({ t, pod: s.pod, far: s.far, csi: s.csi });
  }
  const ref = useCanvas(
    (c, _w, _h, X, Y) => {
      const labs: { k: string; col: string; x: number; y: number; ly: number }[] = [];
      for (const [k, col] of [["pod", C.pod], ["far", C.far], ["csi", C.csi]] as const) {
        line(c, curve.map((p) => [p.t, p[k]]), col, X, Y);
        const last = [...curve].reverse().find((p) => Number.isFinite(p[k]));
        if (last) labs.push({ k: k.toUpperCase(), col, x: X(last.t), y: Y(last[k]), ly: Y(last[k]) });
      }
      // direct labels without collisions (min 11 px apart)
      labs.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labs.length; i++) labs[i].ly = Math.max(labs[i].ly, labs[i - 1].ly + 11);
      for (const l of labs) endLabel(c, l.k, l.col, l.x, l.ly);
      // current threshold
      c.strokeStyle = "#fff";
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(X(thr) + 0.5, Y(1));
      c.lineTo(X(thr) + 0.5, Y(0));
      c.stroke();
      c.setLineDash([]);
      if (hov != null) {
        c.strokeStyle = C.axis;
        c.beginPath();
        c.moveTo(X(hov) + 0.5, Y(1));
        c.lineTo(X(hov) + 0.5, Y(0));
        c.stroke();
      }
    },
    [m, thr, curve.length],
    hov,
  );
  const s = hov != null ? scoresAt(m, hov) : null;
  if (!curve.length) return <div class="ml-chart-empty">No calibration data</div>;
  return (
    <div class="ml-chart">
      <div class="ml-chart-head">
        <b>Scores vs threshold</b>
        <span class="ml-legend">
          <i style={{ background: C.pod }} /> POD <i style={{ background: C.far }} /> FAR <i style={{ background: C.csi }} /> CSI
        </span>
      </div>
      <canvas
        ref={ref}
        onMouseMove={(e) => {
          const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
          const v = (e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r);
          setHov(v >= 0 && v <= 1 ? v : null);
        }}
        onMouseLeave={() => setHov(null)}
        onClick={() => hov != null && onPick?.(Math.round(hov * 100) / 100)}
        title={onPick ? "Click to set the threshold" : undefined}
      />
      {s && hov != null && (
        <div class="ml-tip">
          t {hov.toFixed(2)} · POD {(s.pod * 100).toFixed(0)}% · FAR {(s.far * 100).toFixed(0)}% · CSI {s.csi.toFixed(2)}
        </div>
      )}
    </div>
  );
}

/** ROC: POD vs POFD swept over thresholds. */
export function RocChart({ m }: { m: Metrics }) {
  const pts: [number, number][] = [[1, 1]];
  for (let t = 0.01; t <= 0.991; t += 0.01) {
    const s = scoresAt(m, t);
    if (s && Number.isFinite(s.pofd)) pts.push([s.pofd, s.pod]);
  }
  pts.push([0, 0]);
  const ref = useCanvas(
    (c, _w, _h, X, Y) => {
      line(c, [[0, 0], [1, 1]], C.diag, X, Y, [4, 4]);
      // area under the curve
      c.fillStyle = "rgba(30,155,230,.12)";
      c.beginPath();
      c.moveTo(X(0), Y(0));
      for (const [x, y] of [...pts].reverse()) c.lineTo(X(x), Y(y));
      c.lineTo(X(1), Y(0));
      c.closePath();
      c.fill();
      line(c, pts, C.pod, X, Y);
      c.fillStyle = C.text;
      c.font = "10px Inter, system-ui, sans-serif";
      c.textAlign = "right";
      c.fillText("false-alarm rate (POFD) →", X(1), Y(0) - 8);
    },
    [m],
  );
  if (pts.length < 4) return <div class="ml-chart-empty">No ROC data</div>;
  return (
    <div class="ml-chart">
      <div class="ml-chart-head">
        <b>ROC</b>
        <span class="muted">AUC {m.auc != null ? m.auc.toFixed(3) : "—"}</span>
      </div>
      <canvas ref={ref} />
    </div>
  );
}

/** Reliability: observed frequency vs forecast probability; dot size = samples. */
export function ReliabilityChart({ m }: { m: Metrics }) {
  const bins = (m.reliability ?? []).filter((b) => b.n > 0);
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const ref = useCanvas(
    (c, _w, _h, X, Y) => {
      line(c, [[0, 0], [1, 1]], C.diag, X, Y, [4, 4]);
      // sample histogram along the bottom
      c.fillStyle = "rgba(255,255,255,.09)";
      for (const b of bins) {
        const hh = (Math.log1p(b.n) / Math.log1p(maxN)) * 0.22;
        c.fillRect(X(b.p) - 4, Y(hh), 8, Y(0) - Y(hh));
      }
      line(c, bins.map((b) => [b.p, b.obs]), C.csi, X, Y);
      for (const b of bins) {
        c.fillStyle = C.csi;
        c.strokeStyle = "#0b0e13";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(X(b.p), Y(b.obs), 4, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
      c.fillStyle = C.text;
      c.font = "10px Inter, system-ui, sans-serif";
      c.textAlign = "right";
      c.fillText("forecast probability →", X(1), Y(0) - 8);
    },
    [m],
  );
  if (!bins.length) return <div class="ml-chart-empty">No reliability data</div>;
  return (
    <div class="ml-chart">
      <div class="ml-chart-head">
        <b>Reliability</b>
        <span class="muted">Brier {m.brier != null ? m.brier.toFixed(3) : "—"}</span>
      </div>
      <canvas ref={ref} />
    </div>
  );
}
