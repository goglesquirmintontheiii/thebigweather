// 0.8.2: Recordings tab sections (Camera, YouTube & video, Radar, Imported & other) and their
// remembered collapsed state. Pure helpers (no DOM) so they can be unit tested.

export interface RecLike {
  kind: string;
  imported?: boolean;
  bytes?: number;
  camera?: { kind?: string; url?: string } | null;
}

export type RecGroupId = "camera" | "video" | "radar" | "other";

/** Section order in the Recordings tab (Timelapses follow as their own section). */
export const REC_GROUPS: { id: RecGroupId; label: string }[] = [
  { id: "camera", label: "Camera" },
  { id: "video", label: "YouTube & video" },
  { id: "radar", label: "Radar" },
  { id: "other", label: "Imported & other" },
];

export function recGroup(r: RecLike): RecGroupId {
  if (r.imported) return "other";
  if (r.kind === "radar") return "radar";
  if (r.kind === "camera") {
    const k = r.camera?.kind ?? "";
    const u = r.camera?.url ?? "";
    if (k === "yt" || k === "hls" || /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(u)) return "video";
    if (k === "img") return "camera";
  }
  return "other";
}

/** Recordings split into sections (in REC_GROUPS order, list order kept), with count and size. */
export function groupRecs<T extends RecLike>(list: T[]): { id: RecGroupId; label: string; items: T[]; bytes: number }[] {
  return REC_GROUPS.map((g) => {
    const items = list.filter((r) => recGroup(r) === g.id);
    return { ...g, items, bytes: items.reduce((a, r) => a + (r.bytes ?? 0), 0) };
  });
}

const KEY = "tbw.recSections";

/** Collapsed sections, remembered per viewer (localStorage may be unavailable). */
export function loadCollapsed(store?: Pick<Storage, "getItem">): Set<string> {
  try {
    const v = JSON.parse((store ?? globalThis.localStorage)?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(s: Set<string>, store?: Pick<Storage, "setItem">) {
  try {
    (store ?? globalThis.localStorage)?.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* private mode / blocked storage */
  }
}

export const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
