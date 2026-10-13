// data 0.8: charts register what they last drew (Meteogram LineChart) so they can be re-drawn as
// SVG for export — same layout as the canvas: y grid + labels, day separators, band, lines / bars.

export interface ChartSnap {
  title: string;
  unit: string;
  t: number[];
  series: { name: string; color: string; v: (number | null | undefined)[]; bar?: boolean; dash?: boolean; width?: number }[];
  band?: { lo: (number | null | undefined)[]; hi: (number | null | undefined)[]; color: string };
  range: [number, number];
  w: number;
  h: number;
  tz?: string;
  utc: boolean;
  fmt: (v: number) => string;
  el: HTMLCanvasElement;
}
export const chartRegistry = new Map<string, ChartSnap>();
let seq = 0;
/** a stable id per chart component */
export const newChartId = () => `c${++seq}`;
export function registerChart(id: string, s: ChartSnap) {
  chartRegistry.set(id, s);
  // forget charts no longer on screen
  for (const [k, v] of chartRegistry) if (!v.el.isConnected && k !== id) chartRegistry.delete(k);
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
export function chartSvg(id: string): string | null {
  const c = chartRegistry.get(id);
  if (!c || c.t.length < 1) return null;
  const { w, h, t, range } = c;
  const L = 40, R = 10, top = c.title ? 18 : 8, bottom = h - 16;
  const t0 = t[0], t1 = t[t.length - 1];
  const x = (tt: number) => L + (t1 > t0 ? ((tt - t0) / (t1 - t0)) * (w - L - R) : 0);
  const y = (v: number) => bottom - ((v - range[0]) / (range[1] - range[0] || 1)) * (bottom - top);
  const f = (n: number) => +n.toFixed(1);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, system-ui, sans-serif" font-size="10">`);
  out.push(`<rect width="100%" height="100%" fill="#0f141b"/>`);
  const span = range[1] - range[0];
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const stp = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
  for (let v = Math.ceil(range[0] / stp) * stp; v <= range[1] + 1e-9; v += stp) {
    out.push(`<line x1="${L}" x2="${w - R}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="rgba(255,255,255,0.08)"/>`);
    out.push(`<text x="${L - 4}" y="${f(y(v) + 3)}" text-anchor="end" fill="#8b97a6">${esc(c.fmt(v))}</text>`);
  }
  const tz = c.utc ? "UTC" : c.tz;
  let last = "";
  t.forEach((tt, i) => {
    const k = new Date(tt).toLocaleDateString("en-CA", { timeZone: tz });
    if (k === last) return;
    last = k;
    if (i > 0) out.push(`<line x1="${f(x(tt))}" x2="${f(x(tt))}" y1="${top}" y2="${bottom}" stroke="rgba(255,255,255,0.14)"/>`);
    out.push(`<text x="${f(x(tt) + 3)}" y="${h - 4}" fill="#9aa6b5">${esc(new Date(tt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: tz }))}</text>`);
  });
  if (c.title) out.push(`<text x="${L}" y="11" fill="#c4cdd8" font-weight="600" font-size="10.5">${esc(c.title)}${c.unit ? ` (${esc(c.unit)})` : ""}</text>`);
  if (c.band) {
    const up: string[] = [], dn: string[] = [];
    t.forEach((tt, i) => c.band!.hi[i] != null && up.push(`${f(x(tt))},${f(y(c.band!.hi[i]!))}`));
    for (let i = t.length - 1; i >= 0; i--) if (c.band.lo[i] != null) dn.push(`${f(x(t[i]))},${f(y(c.band.lo[i]!))}`);
    if (up.length) out.push(`<polygon points="${[...up, ...dn].join(" ")}" fill="${c.band.color}"/>`);
  }
  const bars = c.series.filter((s) => s.bar);
  const bw = Math.max(1.5, ((w - L - R) / Math.max(1, t.length)) * 0.7);
  for (const s of c.series) {
    if (s.bar) {
      const k = bars.indexOf(s);
      s.v.forEach((v, i) => {
        if (v == null || !(v > 0)) return;
        const bx = x(t[i]) - bw / 2 + (k * bw) / bars.length;
        out.push(`<rect x="${f(bx)}" y="${f(y(v))}" width="${f(bw / bars.length)}" height="${f(y(Math.max(range[0], 0)) - y(v))}" fill="${s.color}"/>`);
      });
      continue;
    }
    let d = "";
    let pen = false;
    s.v.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return void (pen = false);
      d += `${pen ? "L" : "M"}${f(x(t[i]))},${f(y(v))}`;
      pen = true;
    });
    if (d) out.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.6}"${s.dash ? ' stroke-dasharray="4 3"' : ""}><title>${esc(s.name)}</title></path>`);
  }
  // legend
  let lx = w - R;
  for (const s of [...c.series].reverse()) {
    const tw = s.name.length * 5.6 + 16;
    lx -= tw;
    out.push(`<rect x="${f(lx)}" y="4" width="8" height="8" fill="${s.color}"/><text x="${f(lx + 11)}" y="11" fill="#c4cdd8">${esc(s.name)}</text>`);
    if (lx < L + 140) break;
  }
  out.push("</svg>");
  return out.join("\n");
}
