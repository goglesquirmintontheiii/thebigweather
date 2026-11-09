// 0.8.3 inspector: pure helpers for the Inspector (placement, feature rows), the Nearest radar
// menu (ranking) and radar-site clicks in panes. No DOM / store imports so they unit-test in Node.

const R_KM = 6371.0088;
const toR = Math.PI / 180;

/** great-circle distance (km) */
export function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** longitude wrapped into [-180, 180) (the map reports e.g. -460° after panning across the antimeridian) */
export function normLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const l = (((lon + 180) % 360) + 360) % 360 - 180;
  return l === 180 ? -180 : l;
}

/** The n closest items to (lat, lon), closest first (ties keep list order; bad coordinates skipped). */
export function nearestN<T extends { lat: number; lon: number }>(list: T[], lat: number, lon: number, n: number): { item: T; km: number }[] {
  const out: { item: T; km: number; i: number }[] = [];
  const la = lat, lo = normLon(lon);
  list.forEach((s, i) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
    out.push({ item: s, km: gcKm(la, lo, s.lat, s.lon), i });
  });
  out.sort((a, b) => a.km - b.km || a.i - b.i);
  return out.slice(0, Math.max(0, n)).map(({ item, km }) => ({ item, km }));
}

/** Inspector box position inside its container: right of / below the cursor, flipped to the other
 * side near an edge and always fully inside (never clipped). */
export function inspPlace(x: number, y: number, cw: number, ch: number, bw: number, bh: number, minTop = 4): { left: number; top: number } {
  let left = x + 22;
  if (left + bw > cw - 4) left = x - 22 - bw;
  left = Math.max(4, Math.min(left, cw - bw - 4));
  let top = y + 18;
  if (top + bh > ch - 4) top = Math.max(y - 18 - bh, ch - bh - 4);
  top = Math.max(minTop, Math.min(top, ch - bh - 4));
  if (!Number.isFinite(left)) left = 4;
  if (!Number.isFinite(top)) top = minTop;
  return { left: Math.round(Math.max(4, left)), top: Math.round(Math.max(Math.min(minTop, 4), top)) };
}

/** overlay id from a rendered layer id ("o-metar-icon" → "metar", "o-file:abc-fill" → "file:abc") */
export function overlayIdOf(layerId: string): string | null {
  if (!layerId.startsWith("o-")) return null;
  if (layerId.startsWith("o-file:")) return layerId.slice(2).split("-")[0];
  const i = layerId.indexOf("-", 2);
  return i < 0 ? layerId.slice(2) : layerId.slice(2, i);
}

/** layers the Inspector looks at: overlay layers (not their text labels) plus the alert layers */
export function inspLayers(order: string[], alertLayers: string[]): string[] {
  const alerts = new Set(alertLayers);
  return order.filter((id) => alerts.has(id) || (id.startsWith("o-") && !id.endsWith("-text") && !id.endsWith("-label") && !id.endsWith("-count")));
}

export interface InspRow {
  /** overlay id ("alert" for warnings) */
  kind: string;
  title: string;
  sub?: string;
  rows: [string, string][];
  color?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A popup description (title / sub / rows) cut down to a compact Inspector entry. */
export function compactRows(kind: string, p: { title?: string; sub?: string; rows?: [string, string][]; color?: string; text?: string } | null | undefined, maxRows = 3): InspRow | null {
  if (!p || !p.title) return null;
  const rows = (p.rows ?? []).filter((r) => r && r[1] != null && String(r[1]) !== "" && String(r[1]) !== "—").slice(0, maxRows);
  const sub = p.sub ? clip(String(p.sub), 60) : undefined;
  return { kind, title: clip(String(p.title), 48), sub, rows: rows.map(([k, v]) => [clip(String(k), 18), clip(String(v), 40)]), color: p.color };
}

/** METAR: one-line weather (T/Td, wind, visibility) */
export function metarRows(p: any): [string, string][] {
  const f = (c: any) => (c == null || c === "" || !Number.isFinite(+c) ? "—" : `${Math.round((+c * 9) / 5 + 32)}°`);
  const out: [string, string][] = [["Temp / dew", `${f(p?.t)} / ${f(p?.td)}`]];
  if (p?.ws != null) out.push(["Wind", `${p.wd ?? "VRB"}° ${Math.round(+p.ws)} kt${p.wg ? ` G${Math.round(+p.wg)}` : ""}`]);
  if (p?.vis != null && Number.isFinite(+p.vis)) out.push(["Visibility", `${(+p.vis / 1.609).toFixed(1)} mi`]);
  return out;
}

/** de-duplicate entries (several layers of one overlay hit at once), keep order, cap the count */
export function dedupeRows(list: InspRow[], max = 4): InspRow[] {
  const seen = new Set<string>();
  const out: InspRow[] = [];
  for (const r of list) {
    const k = `${r.kind}|${r.title}|${r.sub ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/** R35: does a radar-site click in this pane switch only the pane? Yes when any of its links
 * (position / time / layers) is off; a fully linked pane follows the main radar. */
export function siteClickTarget(link: { pos: boolean; time: boolean; layers: boolean; radar?: boolean }, radar: boolean): "pane" | "main" {
  if (!radar) return "main";
  return radarLinked(link) ? "main" : "pane";
}

/** 0.8.4: does this pane's selected radar follow the main pane's? */
export function radarLinked(link: { pos: boolean; time: boolean; layers: boolean; radar?: boolean }): boolean {
  return link.radar ?? (link.pos && link.time && link.layers);
}

/** 0.8.4: is the radar site linked for this kind of window? A pane window has its own radar link; a full map window keeps following its position link. */
export function siteLinkOn(kind: string, link: { pos: boolean; time: boolean; layers: boolean; radar?: boolean }): boolean {
  return kind === "pane" ? radarLinked(link) : link.pos;
}
