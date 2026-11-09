// 0.8.4: pure helpers for data-source gating and cache budgets (no store/DOM, unit tested).

/** which toggle a basemap needs (null: nothing to switch off) */
export function basemapSource(b: string, provider?: string): string | null {
  if (b === "offline" || b.startsWith("custom:")) return null;
  if (b.startsWith("faa_")) return "faa-charts";
  if (b === "google") return "google";
  if (b === "terrain" || b === "satellite") return "esri";
  return (provider ?? "openfreemap") === "openfreemap" ? "openfreemap" : "carto";
}

/** which toggle an international radar layer needs */
export function intlDataSource(id: string): string | null {
  if (id.startsWith("rainviewer")) return "rainviewer";
  if (id.startsWith("geomet") || id === "eccc" || id.startsWith("eccc")) return "eccc";
  for (const p of ["jma", "dwd", "pagasa", "smn"]) if (id.startsWith(p)) return p;
  return null;
}

export function warnText(kind: string): string {
  return `Data source for this ${kind} is disabled.`;
}

const UNITS: [string, number][] = [
  ["TB", 1024 ** 4],
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024],
];

/** "1.5 GB", "512m", "800000" → bytes (null if it can't be read). */
export function parseBytes(text: string): number | null {
  const m = /^\s*([\d.,]+)\s*([kmgt]?)i?b?\s*$/i.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(v) || v < 0) return null;
  const mul = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] ?? 1;
  return Math.round(v * mul);
}

/** Text for a budget textbox: the largest unit that reads cleanly. */
export function fmtBudget(b: number): string {
  if (b < 1024) return `${Math.round(b)} B`;
  for (const [u, n] of UNITS) if (b >= n) return `${+(b / n).toFixed(2)} ${u}`;
  return `${Math.round(b)} B`;
}
