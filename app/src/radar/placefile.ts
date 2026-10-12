// radar 0.6: GRLevelX placefile parser.
// Statements (one per line, ";" comments): Title, Refresh (min), RefreshSeconds, Threshold (nm),
// Color r g b [a], Font n, px, flags, "face", IconFile n, w, h, hotX, hotY, "url",
// Icon lat,lon,angle,file,icon[,"hover"], Text lat,lon,font,"text"[,"hover"], Place lat,lon,"text",
// Line width,flags[,"hover"] … End:, Triangles … End:, Polygon … End:, Image "url" … End:,
// Object lat,lon … End: (inside: x,y pixel offsets, y up), TimeRange start end.

export interface PfIconFile {
  n: number;
  w: number;
  h: number;
  hx: number;
  hy: number;
  url: string;
}
export interface PfFont {
  n: number;
  size: number;
  flags: number;
  face: string;
}
type RGBA = [number, number, number, number];
interface Base {
  thr: number;
  tr?: [number, number];
  hover?: string;
}
/** a point plus a screen-pixel offset (x right, y up) — objects use offsets, plain items 0,0 */
export interface PfIcon extends Base {
  t: "icon";
  lat: number;
  lon: number;
  ox: number;
  oy: number;
  angle: number;
  file: number;
  icon: number;
}
export interface PfText extends Base {
  t: "text";
  lat: number;
  lon: number;
  ox: number;
  oy: number;
  font: number;
  text: string;
  color: RGBA;
}
export interface PfLine extends Base {
  t: "line";
  /** lat, lon, ox, oy */
  pts: [number, number, number, number][];
  width: number;
  color: RGBA;
}
export interface PfPoly extends Base {
  t: "poly";
  rings: [number, number][][];
  color: RGBA;
}
export interface PfImage extends Base {
  t: "image";
  url: string;
  /** lat, lon, u, v */
  pts: [number, number, number, number][];
}
export type PfItem = PfIcon | PfText | PfLine | PfPoly | PfImage;

export interface Placefile {
  title: string;
  /** seconds, 0 = none */
  refresh: number;
  iconFiles: Map<number, PfIconFile>;
  fonts: Map<number, PfFont>;
  items: PfItem[];
  warnings: string[];
  hasObjects: boolean;
  hasTime: boolean;
}

/** split on commas outside quotes; strips quotes */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = false, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (!q && !quoted && !cur.trim()) cur = "";
      q = !q;
      quoted = true;
      continue;
    }
    if (c === "," && !q) {
      out.push(quoted ? cur : cur.trim());
      cur = "";
      quoted = false;
      continue;
    }
    if (!q && quoted && /\s/.test(c)) continue;
    cur += c;
  }
  if (cur.length || out.length) out.push(quoted ? cur : cur.trim());
  return out;
}

const num = (s: string | undefined, d = 0) => {
  const v = parseFloat(s ?? "");
  return Number.isFinite(v) ? v : d;
};
const hoverText = (s: string | undefined) => (s ? s.replace(/\\n/g, "\n").trim() : undefined);

export function parsePlacefile(text: string): Placefile {
  const pf: Placefile = { title: "", refresh: 0, iconFiles: new Map(), fonts: new Map(), items: [], warnings: [], hasObjects: false, hasTime: false };
  let color: RGBA = [255, 255, 255, 255];
  let thr = 999; // nm, file-wide default
  let tr: [number, number] | undefined;
  // open blocks
  let obj: { lat: number; lon: number; thr: number } | null = null;
  let block: { kind: "line" | "tri" | "poly" | "image"; item: any; inObj: boolean } | null = null;
  let triBuf: [number, number][] = [];
  let triColor: RGBA | null = null;

  const closeBlock = () => {
    if (!block) return;
    const it = block.item;
    if (block.kind === "line" && it.pts.length >= 2) pf.items.push(it);
    else if (block.kind === "poly") {
      const rings = it.rings.filter((r: any[]) => r.length >= 3);
      if (rings.length) pf.items.push({ ...it, rings });
    } else if (block.kind === "tri" && it.rings.length) pf.items.push(it);
    else if (block.kind === "image" && it.pts.length >= 3) pf.items.push(it);
    block = null;
  };

  const lines = text.replace(/\r/g, "").split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    let raw = lines[ln];
    const semi = raw.indexOf(";");
    if (semi >= 0 && !raw.slice(0, semi).includes('"')) raw = raw.slice(0, semi);
    else if (semi === 0) continue;
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      // a vertex inside a block
      if (!block) continue;
      const a = splitArgs(line).map((x) => x.trim());
      const p0 = num(a[0], NaN), p1 = num(a[1], NaN);
      if (!Number.isFinite(p0) || !Number.isFinite(p1)) continue;
      // inside an Object, vertices are pixel offsets (x, y) from the object's position
      const [lat, lon, ox, oy] = block.inObj && obj ? [obj.lat, obj.lon, p0, p1] : [p0, p1, 0, 0];
      const col: RGBA | null = a.length >= 5 ? [num(a[2]), num(a[3]), num(a[4]), a.length >= 6 ? num(a[5], 255) : 255] : null;
      if (block.kind === "line") block.item.pts.push([lat, lon, ox, oy]);
      else if (block.kind === "poly") {
        // a coloured vertex after the first starts a new contour (holes/islands)
        if (col && block.item.rings[block.item.rings.length - 1].length) block.item.rings.push([]);
        if (col && block.item.rings.length === 1) block.item.color = col;
        block.item.rings[block.item.rings.length - 1].push([lon, lat]);
      } else if (block.kind === "tri") {
        if (col && !triBuf.length) triColor = col;
        triBuf.push([lon, lat]);
        if (triBuf.length === 3) {
          block.item.rings.push(triBuf);
          if (triColor) block.item.colors.push(triColor);
          triBuf = [];
          triColor = null;
        }
      } else if (block.kind === "image") block.item.pts.push([lat, lon, num(a[2]), num(a[3])]);
      continue;
    }
    const key = m[1].toLowerCase();
    const rest = m[2];
    const a = splitArgs(rest);
    const T = obj ? obj.thr : thr;
    switch (key) {
      case "title":
        pf.title = rest.trim();
        break;
      case "refresh":
        pf.refresh = Math.max(0, num(a[0]) * 60);
        break;
      case "refreshseconds":
        pf.refresh = Math.max(0, num(a[0]));
        break;
      case "threshold":
        if (obj) obj.thr = num(a[0], 999);
        else thr = num(a[0], 999);
        break;
      case "color": {
        const c = rest.trim().split(/[\s,]+/).map((x) => num(x));
        if (c.length >= 3) color = [c[0], c[1], c[2], c.length >= 4 ? c[3] : 255];
        break;
      }
      case "font":
        pf.fonts.set(num(a[0], 1), { n: num(a[0], 1), size: num(a[1], 12), flags: num(a[2]), face: a[3] ?? "" });
        break;
      case "iconfile":
        pf.iconFiles.set(num(a[0], 1), { n: num(a[0], 1), w: num(a[1], 16), h: num(a[2], 16), hx: num(a[3]), hy: num(a[4]), url: (a[5] ?? "").trim() });
        break;
      case "timerange": {
        const parts = rest.trim().split(/\s+/);
        const t0 = Date.parse(parts[0]), t1 = Date.parse(parts[1]);
        tr = Number.isFinite(t0) && Number.isFinite(t1) ? [t0, t1] : undefined;
        if (tr) pf.hasTime = true;
        break;
      }
      case "object":
        closeBlock();
        obj = { lat: num(a[0]), lon: num(a[1]), thr };
        pf.hasObjects = true;
        break;
      case "end":
        if (block) closeBlock();
        else obj = null;
        break;
      case "icon": {
        const [lat, lon, ox, oy] = obj ? [obj.lat, obj.lon, num(a[0]), num(a[1])] : [num(a[0]), num(a[1]), 0, 0];
        pf.items.push({ t: "icon", lat, lon, ox, oy, angle: num(a[2]), file: num(a[3], 1), icon: num(a[4], 1), hover: hoverText(a[5]), thr: T, tr });
        break;
      }
      case "text": {
        const [lat, lon, ox, oy] = obj ? [obj.lat, obj.lon, num(a[0]), num(a[1])] : [num(a[0]), num(a[1]), 0, 0];
        pf.items.push({ t: "text", lat, lon, ox, oy, font: num(a[2], 1), text: (a[3] ?? "").replace(/\\n/g, "\n"), hover: hoverText(a[4]), color, thr: T, tr });
        break;
      }
      case "place":
        pf.items.push({ t: "text", lat: num(a[0]), lon: num(a[1]), ox: 0, oy: 0, font: 1, text: a[2] ?? "", color, thr: T, tr });
        break;
      case "line":
        closeBlock();
        block = { kind: "line", inObj: !!obj, item: { t: "line", pts: [], width: Math.max(0.5, num(a[0], 1)), color, hover: hoverText(a[2]), thr: T, tr } };
        break;
      case "polygon":
        closeBlock();
        block = { kind: "poly", inObj: !!obj, item: { t: "poly", rings: [[]], color, thr: T, tr } };
        break;
      case "triangles":
        closeBlock();
        triBuf = [];
        triColor = null;
        block = { kind: "tri", inObj: !!obj, item: { t: "poly", rings: [], colors: [], color, thr: T, tr, _tri: true } };
        break;
      case "image":
        closeBlock();
        block = { kind: "image", inObj: false, item: { t: "image", url: (a[0] ?? "").trim(), pts: [], thr: T, tr } };
        break;
      default:
        if (pf.warnings.length < 20) pf.warnings.push(`line ${ln + 1}: unknown "${m[1]}"`);
    }
  }
  closeBlock();
  return pf;
}

/** Does this text look like a placefile? */
export function looksLikePlacefile(text: string): boolean {
  const head = text.slice(0, 8000);
  return /^\s*(Title|Refresh|RefreshSeconds|Threshold|IconFile|Object|Icon|Color|Polygon|Triangles|Font|Place)\s*:/im.test(head) && !/^\s*[{<]/.test(head);
}
