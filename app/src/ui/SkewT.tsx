// Skew-T log-p diagram and hodograph (canvas).

import { useEffect, useRef, useState } from "preact/hooks";
import { type Level, type Parcel, type Kin, atP, zAtP, dryT, moistT, tdOf, uv, windAtZ } from "../sounding/thermo";

const P_BOT = 1050;
const P_TOP = 100;
const TMIN = -40;
const TMAX = 50;

function useWidth(ref: { current: HTMLElement | null }, init: number) {
  const [w, setW] = useState(init);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

function setup(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** Wind barb at (x, y): staff toward where the wind comes from. */
export function barb(g: CanvasRenderingContext2D, x: number, y: number, wd: number, ws: number, len = 26) {
  g.save();
  g.translate(x, y);
  g.rotate((wd * Math.PI) / 180);
  if (ws < 2.5) {
    g.beginPath();
    g.arc(0, 0, 3.5, 0, Math.PI * 2);
    g.stroke();
    g.restore();
    return;
  }
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len);
  g.stroke();
  let v = Math.round(ws / 5) * 5;
  let pos = -len;
  const step = 4.5;
  while (v >= 50) {
    g.beginPath();
    g.moveTo(0, pos);
    g.lineTo(10, pos + 3);
    g.lineTo(0, pos + 6);
    g.closePath();
    g.fill();
    pos += 7;
    v -= 50;
  }
  while (v >= 10) {
    g.beginPath();
    g.moveTo(0, pos);
    g.lineTo(11, pos - 4);
    g.stroke();
    pos += step;
    v -= 10;
  }
  if (v >= 5) {
    if (pos === -len) pos += step;
    g.beginPath();
    g.moveTo(0, pos);
    g.lineTo(6, pos - 2.2);
    g.stroke();
  }
  g.restore();
}

export interface SkewTProps {
  levels: Level[];
  parcel: Parcel | null;
  tempUnit: "F" | "C";
}

export function SkewT({ levels: L, parcel, tempUnit }: SkewTProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const w = useWidth(wrap, 640);
  const h = Math.max(420, Math.min(760, Math.round(w * 0.98)));
  const [hp, setHp] = useState<number | null>(null);
  const pad = { l: 46, r: 64, t: 10, b: 26 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const lnB = Math.log(P_BOT), lnT = Math.log(P_TOP);
  const y = (p: number) => pad.t + (ph * (Math.log(p) - lnT)) / (lnB - lnT);
  const x = (t: number, p: number) => pad.l + ((t - TMIN) / (TMAX - TMIN)) * pw + (pad.t + ph - y(p)) * (pw / ph);
  const pOf = (yy: number) => Math.exp(lnT + ((yy - pad.t) / ph) * (lnB - lnT));

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = setup(c, w, h);
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, pw, ph);
    g.clip();
    g.fillStyle = "rgba(8,12,18,0.55)";
    g.fillRect(pad.l, pad.t, pw, ph);
    const line = (pts: [number, number][], color: string, width = 1, dash: number[] = []) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b)));
      g.stroke();
      g.setLineDash([]);
    };
    // isobars
    for (const p of [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]) line([[pad.l, y(p)], [pad.l + pw, y(p)]], "rgba(148,163,184,0.25)");
    // isotherms
    for (let t = -120; t <= 50; t += 10) line([[x(t, P_BOT), y(P_BOT)], [x(t, P_TOP), y(P_TOP)]], t === 0 ? "rgba(96,165,250,0.6)" : "rgba(148,163,184,0.16)", t === 0 ? 1.2 : 1);
    // dry adiabats
    for (let th = 250; th <= 460; th += 10) {
      const pts: [number, number][] = [];
      for (let p = P_BOT; p >= P_TOP; p -= 10) pts.push([x(dryT(p, th), p), y(p)]);
      line(pts, "rgba(251,146,60,0.18)");
    }
    // moist adiabats
    for (let t0 = -10; t0 <= 36; t0 += 4) {
      const pts: [number, number][] = [];
      let t = moistT(1000, t0, P_BOT);
      let pp = P_BOT;
      for (let p = P_BOT; p >= 200; p -= 10) {
        t = moistT(pp, t, p);
        pp = p;
        pts.push([x(t, p), y(p)]);
      }
      line(pts, "rgba(74,222,128,0.17)", 1, [4, 3]);
    }
    // mixing ratio lines
    g.font = "9px system-ui, sans-serif";
    for (const wg of [1, 2, 4, 7, 10, 16, 24]) {
      const pts: [number, number][] = [];
      for (let p = P_BOT; p >= 600; p -= 25) pts.push([x(tdOf(p, wg / 1000), p), y(p)]);
      line(pts, "rgba(45,212,191,0.22)", 1, [2, 3]);
      const [lx, ly] = pts[pts.length - 1];
      g.fillStyle = "rgba(45,212,191,0.55)";
      g.fillText(String(wg), lx - 4, ly - 3);
    }
    if (L.length > 1) {
      // CAPE / CIN shading between the parcel and the environment
      if (parcel) {
        const tr = parcel.trace;
        for (let i = 1; i < tr.length; i++) {
          const a = tr[i - 1], b = tr[i];
          if (parcel.elP != null && b.p < parcel.elP - 1) break;
          const ea = atP(L, a.p, (l) => l.t), eb = atP(L, b.p, (l) => l.t);
          if (ea == null || eb == null) continue;
          const pos = a.t + b.t > ea + eb;
          if (!pos && (a.p <= (parcel.lfcP ?? 0) || parcel.lfcP == null)) continue;
          g.fillStyle = pos ? "rgba(248,113,113,0.22)" : "rgba(96,165,250,0.18)";
          g.beginPath();
          g.moveTo(x(a.t, a.p), y(a.p));
          g.lineTo(x(b.t, b.p), y(b.p));
          g.lineTo(x(eb, b.p), y(b.p));
          g.lineTo(x(ea, a.p), y(a.p));
          g.closePath();
          g.fill();
        }
        line(tr.map((q) => [x(q.t, q.p), y(q.p)] as [number, number]), "rgba(255,255,255,0.85)", 1.4, [6, 4]);
      }
      // traces
      const tdPts = L.filter((l) => l.td != null).map((l) => [x(l.td!, l.p), y(l.p)] as [number, number]);
      line(tdPts, "#34d399", 2.4);
      line(L.map((l) => [x(l.t, l.p), y(l.p)] as [number, number]), "#f87171", 2.4);
      // wet-bulb is implied; parcel levels
      if (parcel) {
        g.font = "bold 10px system-ui, sans-serif";
        const mark = (p: number | null, lbl: string, col: string) => {
          if (p == null || p < P_TOP) return;
          const yy = y(p);
          const xx = x(atP(L, p, (l) => l.t) ?? 0, p);
          g.strokeStyle = col;
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(xx + 8, yy);
          g.lineTo(xx + 26, yy);
          g.stroke();
          g.fillStyle = col;
          g.fillText(lbl, xx + 29, yy + 3.5);
        };
        mark(parcel.lclP, "LCL", "#4ade80");
        mark(parcel.lfcP, "LFC", "#facc15");
        mark(parcel.elP, "EL", "#c084fc");
      }
    }
    // hover line
    if (hp != null) line([[pad.l, y(hp)], [pad.l + pw, y(hp)]], "rgba(255,255,255,0.5)", 1, [3, 3]);
    g.restore();
    // frame + labels
    g.strokeStyle = "rgba(148,163,184,0.5)";
    g.lineWidth = 1;
    g.strokeRect(pad.l + 0.5, pad.t + 0.5, pw, ph);
    g.fillStyle = "#cbd5e1";
    g.font = "10px system-ui, sans-serif";
    g.textAlign = "right";
    for (const p of [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100]) {
      if (p > P_BOT) continue;
      g.fillText(String(p), pad.l - 4, y(p) + 3.5);
      const z = L.length ? zAtP(L, p) : null;
      if (z != null && z >= 0) {
        g.fillStyle = "rgba(148,163,184,0.8)";
        g.fillText(`${(z / 1000).toFixed(1)}k`, pad.l - 4, y(p) + 14);
        g.fillStyle = "#cbd5e1";
      }
    }
    g.textAlign = "center";
    for (let t = TMIN; t <= TMAX; t += 10) g.fillText(`${t}°`, x(t, P_BOT), h - 10);
    g.textAlign = "left";
    // wind barbs on the right
    const bx = pad.l + pw + 30;
    g.strokeStyle = "#e2e8f0";
    g.fillStyle = "#e2e8f0";
    g.lineWidth = 1.3;
    let lastY = 1e9;
    for (const l of L) {
      if (l.wd == null || l.ws == null || l.p < P_TOP) continue;
      const yy = y(l.p);
      if (lastY - yy < 16) continue;
      lastY = yy;
      barb(g, bx, yy, l.wd, l.ws);
    }
  }, [L, parcel, w, h, hp]);

  const onMove = (e: MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const yy = e.clientY - r.top;
    if (yy < pad.t || yy > pad.t + ph || !L.length) return setHp(null);
    setHp(Math.max(L[L.length - 1].p, Math.min(L[0].p, pOf(yy))));
  };
  const rd = hp != null && L.length ? readout(L, parcel, hp) : null;
  const T = (c: number | null) => (c == null ? "—" : tempUnit === "F" ? `${Math.round(c * 1.8 + 32)}°F` : `${c.toFixed(1)}°C`);
  return (
    <div class="skewt" ref={wrap}>
      <canvas ref={cv} onMouseMove={onMove as any} onMouseLeave={() => setHp(null)} />
      {rd && (
        <div class="skewt-read glass">
          <b>{Math.round(rd.p)} hPa</b> · {rd.z != null ? `${(rd.z / 1000).toFixed(2)} km` : "—"}
          <br />
          <span class="c-t">T {T(rd.t)}</span> <span class="c-td">Td {T(rd.td)}</span>
          {rd.pt != null && (
            <>
              {" "}
              <span class="muted">Parcel {T(rd.pt)}</span>
            </>
          )}
          <br />
          {rd.wd != null && rd.ws != null ? `${String(Math.round(rd.wd)).padStart(3, "0")}° ${Math.round(rd.ws)} kt` : "—"}
        </div>
      )}
    </div>
  );
}

function readout(L: Level[], parcel: Parcel | null, p: number) {
  const u = atP(L, p, (l) => (l.wd != null && l.ws != null ? uv(l.wd, l.ws)[0] : null));
  const v = atP(L, p, (l) => (l.wd != null && l.ws != null ? uv(l.wd, l.ws)[1] : null));
  let pt: number | null = null;
  if (parcel) {
    const tr = parcel.trace;
    for (let i = 1; i < tr.length; i++)
      if (p <= tr[i - 1].p && p >= tr[i].p) {
        pt = tr[i - 1].t + ((tr[i].t - tr[i - 1].t) * (tr[i - 1].p - p)) / (tr[i - 1].p - tr[i].p || 1);
        break;
      }
  }
  return {
    p,
    z: zAtP(L, p),
    t: atP(L, p, (l) => l.t),
    td: atP(L, p, (l) => l.td),
    ws: u != null && v != null ? Math.hypot(u, v) : null,
    wd: u != null && v != null ? ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 : null,
    pt,
  };
}

const BANDS: [number, number, string][] = [
  [0, 1000, "#f87171"],
  [1000, 3000, "#4ade80"],
  [3000, 6000, "#facc15"],
  [6000, 9000, "#38bdf8"],
];

export function Hodograph({ levels: L, kin }: { levels: Level[]; kin: Kin }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const w = Math.min(340, useWidth(wrap, 300));
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = setup(c, w, w);
    g.clearRect(0, 0, w, w);
    const pts: { z: number; u: number; v: number }[] = [];
    const topZ = L.length ? Math.min(9000, L[L.length - 1].z - L[0].z) : 0;
    for (let z = 0; z <= topZ; z += 250) {
      const q = windAtZ(L, z);
      if (q) pts.push({ z, u: q[0], v: q[1] });
    }
    const mx = Math.max(40, ...pts.map((q) => Math.hypot(q.u, q.v)), ...(kin.rm ? [Math.hypot(...kin.rm), Math.hypot(...kin.lm!)] : []));
    const R = Math.ceil(mx / 10) * 10;
    const cx = w / 2, cy = w / 2, s = (w / 2 - 14) / R;
    g.fillStyle = "rgba(8,12,18,0.55)";
    g.fillRect(0, 0, w, w);
    g.strokeStyle = "rgba(148,163,184,0.22)";
    g.fillStyle = "rgba(148,163,184,0.7)";
    g.font = "9px system-ui, sans-serif";
    for (let r = 10; r <= R; r += 10) {
      g.beginPath();
      g.arc(cx, cy, r * s, 0, Math.PI * 2);
      g.stroke();
      if (r % 20 === 0 || R <= 40) g.fillText(`${r}`, cx + r * s * 0.707 + 2, cy + r * s * 0.707 + 8);
    }
    g.strokeStyle = "rgba(148,163,184,0.4)";
    g.beginPath();
    g.moveTo(0, cy);
    g.lineTo(w, cy);
    g.moveTo(cx, 0);
    g.lineTo(cx, w);
    g.stroke();
    const X = (u: number) => cx + u * s, Y = (v: number) => cy - v * s;
    g.lineWidth = 2.6;
    g.lineCap = "round";
    for (let i = 1; i < pts.length; i++) {
      const band = BANDS.find(([a, b]) => pts[i].z > a && pts[i].z <= b);
      g.strokeStyle = band?.[2] ?? "#94a3b8";
      g.beginPath();
      g.moveTo(X(pts[i - 1].u), Y(pts[i - 1].v));
      g.lineTo(X(pts[i].u), Y(pts[i].v));
      g.stroke();
    }
    g.font = "bold 9px system-ui, sans-serif";
    g.fillStyle = "#e2e8f0";
    for (const k of [1000, 3000, 6000, 9000]) {
      const q = pts.find((p) => p.z === k);
      if (!q) continue;
      g.beginPath();
      g.arc(X(q.u), Y(q.v), 2.5, 0, Math.PI * 2);
      g.fill();
      g.fillText(`${k / 1000}`, X(q.u) + 4, Y(q.v) - 3);
    }
    const mark = (p: [number, number] | null, lbl: string, col: string) => {
      if (!p) return;
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(X(p[0]), Y(p[1]), 4.5, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = col;
      g.fillText(lbl, X(p[0]) + 7, Y(p[1]) + 3);
    };
    mark(kin.rm, "RM", "#fb7185");
    mark(kin.lm, "LM", "#60a5fa");
    if (kin.mean6) {
      g.fillStyle = "#cbd5e1";
      g.fillRect(X(kin.mean6[0]) - 3, Y(kin.mean6[1]) - 3, 6, 6);
    }
    g.fillStyle = "rgba(203,213,225,0.8)";
    g.font = "9px system-ui, sans-serif";
    g.fillText("kt", 4, 11);
  }, [L, kin, w]);
  return (
    <div class="hodo" ref={wrap}>
      <canvas ref={cv} />
      <div class="hodo-key">
        {BANDS.map(([a, b, c]) => (
          <span key={a} style={{ color: c }}>
            {a / 1000}–{b / 1000} km
          </span>
        ))}
      </div>
    </div>
  );
}

