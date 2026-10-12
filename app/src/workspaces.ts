// Saved workspaces ("Chase day", "Winter"…): a named snapshot of the view, weather layer, radar
// settings, overlays and their options, panes, basemap, legend gates and (optionally) keybinds.

import { settings, update, uid, toast, type Settings } from "./store";
import { mapRef } from "./map/mapview";
import { saveFile, pickTextFile } from "./saveio";

/** settings groups a workspace captures */
const KEYS = ["weather", "radar", "grid", "extraSites", "ovl", "overlays", "panes", "basemap", "basemapProvider", "gates", "tables", "anim", "view3d", "srv"] as const;
type Snap = Partial<Pick<Settings, (typeof KEYS)[number] | "keybinds" | "view">>;

export interface Workspace {
  id: string;
  name: string;
  saved: number;
  keys: boolean;
  data: Snap;
}

export function captureWorkspace(name: string, withKeys = false): Workspace {
  const s = settings.value;
  const data: any = {};
  for (const k of KEYS) if ((s as any)[k] !== undefined) data[k] = structuredClone((s as any)[k]);
  const m = mapRef.value;
  data.view = m ? { center: [m.getCenter().lng, m.getCenter().lat], zoom: m.getZoom() } : s.view;
  if (withKeys) data.keybinds = structuredClone(s.keybinds);
  return { id: uid(), name: name.trim() || "Workspace", saved: Date.now(), keys: withKeys, data };
}

export function saveWorkspace(name: string, withKeys = false) {
  const w = captureWorkspace(name, withKeys);
  update((s) => {
    const i = s.workspaces.findIndex((x) => x.name.toLowerCase() === w.name.toLowerCase());
    if (i >= 0) s.workspaces[i] = { ...w, id: s.workspaces[i].id };
    else s.workspaces.push(w);
  });
  toast(`Saved workspace “${w.name}”`);
}

export function overwriteWorkspace(id: string) {
  const old = settings.value.workspaces.find((w) => w.id === id);
  if (!old) return;
  const w = captureWorkspace(old.name, old.keys);
  update((s) => (s.workspaces = s.workspaces.map((x) => (x.id === id ? { ...w, id } : x))));
  toast(`Updated “${old.name}”`);
}

export function applyWorkspace(id: string) {
  const w = settings.value.workspaces.find((x) => x.id === id);
  if (!w) return;
  update((s) => {
    for (const [k, v] of Object.entries(w.data)) {
      if (k === "view" || v === undefined) continue;
      const cur = (s as any)[k];
      // merge object groups so settings added after the save keep their defaults
      (s as any)[k] = cur && typeof cur === "object" && !Array.isArray(cur) && typeof v === "object" && !Array.isArray(v) && k !== "ovl" && k !== "gates" && k !== "tables" && k !== "keybinds" ? { ...cur, ...structuredClone(v) } : structuredClone(v);
    }
    if (w.data.view) s.view = w.data.view;
  });
  const v = w.data.view;
  if (v) mapRef.value?.jumpTo({ center: v.center, zoom: v.zoom });
  toast(`Workspace “${w.name}”`);
}

export function deleteWorkspace(id: string) {
  update((s) => (s.workspaces = s.workspaces.filter((w) => w.id !== id)));
}

export function renameWorkspace(id: string, name: string) {
  if (!name.trim()) return;
  update((s) => (s.workspaces = s.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() } : w))));
}

export async function exportWorkspaces(ids?: string[]) {
  const list = settings.value.workspaces.filter((w) => !ids || ids.includes(w.id));
  if (!list.length) return toast("No workspaces to export", "warn");
  const name = list.length === 1 ? `workspace-${list[0].name.replace(/[^\w-]+/g, "_")}.json` : "workspaces.json";
  const f = await saveFile(name, JSON.stringify({ tbw: "workspaces", version: 1, workspaces: list }, null, 1), "application/json");
  if (f) toast(`Saved ${f}`);
}

export async function importWorkspaces() {
  const f = await pickTextFile(".json,application/json");
  if (!f) return;
  try {
    const j = JSON.parse(f.text);
    const list: Workspace[] = Array.isArray(j) ? j : Array.isArray(j.workspaces) ? j.workspaces : j.data ? [j] : [];
    const ok = list.filter((w) => w && typeof w.name === "string" && w.data && typeof w.data === "object");
    if (!ok.length) throw new Error("no workspaces in this file");
    update((s) => {
      for (const w of ok) {
        const nw: Workspace = { id: uid(), name: w.name, saved: w.saved || Date.now(), keys: !!w.data.keybinds, data: w.data };
        const i = s.workspaces.findIndex((x) => x.name.toLowerCase() === w.name.toLowerCase());
        if (i >= 0) s.workspaces[i] = nw;
        else s.workspaces.push(nw);
      }
    });
    toast(`Imported ${ok.length} workspace${ok.length > 1 ? "s" : ""}`);
  } catch (e: any) {
    toast(`Import failed: ${e?.message ?? e}`, "error");
  }
}
