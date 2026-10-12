// Share links (Phase 6). Owner side: create / list / delete links and keep "live" links updated
// with the current view. Viewer side: a page opened with ?share=<id> loads the shared workspace
// with a scoped read-only token and runs in viewer mode (no settings, recording or drawing).

import { signal, effect } from "@preact/signals";
import { api } from "../api";
import { settings, update, openPanel, tool, toast } from "../store";
import { mapRef } from "../map/mapview";
import { drawings } from "../map/draw";
import { captureWorkspace, type Workspace } from "../workspaces";

/** `?share=<id>` when this page is a shared view. */
export const shareParam: string | null = (() => {
  try {
    const v = new URLSearchParams(location.search).get("share");
    return v && /^[a-z0-9]{4,32}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
})();

export interface ShareInfo {
  id: string;
  name: string;
  url: string;
  created: number;
  updated: number;
  expires: number;
  live: boolean;
  views: number;
}

/** Viewer mode state (null = normal app). */
export const viewer = signal<{ id: string; name: string; live: boolean; updated: number; expires: number; server: string; follow: boolean; error?: string } | null>(null);
export const shareDialog = signal(false);

// ---------- workspace snapshot used for sharing ----------

/** The current view (or a saved workspace) plus the drawings on the map. */
export function shareSnapshot(src: "current" | string): Workspace | null {
  let w: Workspace | null;
  if (src === "current") w = captureWorkspace("Current view");
  else w = structuredClone(settings.value.workspaces.find((x) => x.id === src) ?? null);
  if (!w) return null;
  delete (w.data as any).keybinds;
  (w.data as any).drawings = structuredClone(drawings.value);
  return w;
}

// ---------- owner side ----------

const LIVE_KEY = "tbw.share.live";
type LiveRec = { id: string; src: string; until: number };
function liveRecs(): LiveRec[] {
  try {
    return (JSON.parse(localStorage.getItem(LIVE_KEY) || "[]") as LiveRec[]).filter((r) => !r.until || r.until > Date.now());
  } catch {
    return [];
  }
}
function saveLive(list: LiveRec[]) {
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify(list));
  } catch {
    /* */
  }
}

export async function createShare(o: { name: string; src: "current" | string; hours: number; live: boolean }): Promise<ShareInfo> {
  const w = shareSnapshot(o.src);
  if (!w) throw new Error("workspace not found");
  const r = await api.send<ShareInfo>("POST", "/api/share", { name: o.name || w.name, workspace: w, expires_h: o.hours, live: o.live });
  if (o.live) saveLive([...liveRecs(), { id: r.id, src: o.src, until: r.expires }]);
  return r;
}

export const listShares = () => api.get<ShareInfo[]>("/api/shares");

export async function deleteShare(id: string) {
  await api.send("DELETE", `/api/share/${encodeURIComponent(id)}`, {});
  saveLive(liveRecs().filter((r) => r.id !== id));
}

/** Live links follow the owner's view: push the snapshot a few seconds after it changes. */
let pushTimer: number | undefined;
const lastPushed = new Map<string, string>();
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(async () => {
    const recs = liveRecs();
    if (!recs.length) return;
    const dead: string[] = [];
    for (const r of recs) {
      const w = shareSnapshot(r.src);
      if (!w) continue;
      w.saved = 0; // don't let the timestamp alone count as a change
      const body = JSON.stringify(w.data);
      if (lastPushed.get(r.id) === body) continue;
      try {
        await api.send("PUT", `/api/share/${r.id}`, { workspace: w });
        lastPushed.set(r.id, body);
      } catch (e: any) {
        if (e?.status === 404) dead.push(r.id);
      }
    }
    if (dead.length) saveLive(liveRecs().filter((r) => !dead.includes(r.id)));
  }, 3000);
}

if (!shareParam) {
  effect(() => {
    void settings.value;
    void drawings.value;
    schedulePush();
  });
  // map moves don't touch settings: listen on the map itself
  effect(() => {
    const m = mapRef.value;
    if (!m) return;
    const h = () => schedulePush();
    m.on("moveend", h);
    return () => m.off("moveend", h);
  });
}

// ---------- viewer side ----------

/** Same merge rules as applyWorkspace (workspaces.ts), without toasts or the map jump. */
function mergeWorkspace(s: any, data: any) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === "view" || k === "drawings" || k === "keybinds" || v === undefined) continue;
    const cur = s[k];
    s[k] = cur && typeof cur === "object" && !Array.isArray(cur) && typeof v === "object" && !Array.isArray(v) && !["weather", "ovl", "gates", "tables"].includes(k) ? { ...cur, ...structuredClone(v as any) } : structuredClone(v);
  }
  if (data?.view) s.view = data.view;
  if (Array.isArray(data?.drawings)) {
    s.drawKeep = true;
    s.drawings = data.drawings;
  }
}

async function fetchShare(id: string, poll: boolean) {
  const r = await fetch(`${location.origin}/api/share/${encodeURIComponent(id)}`, { headers: poll ? { "x-tbw-share-poll": "1" } : {}, cache: "no-store" });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* */
    }
    throw new Error(msg);
  }
  return r.json();
}

/** Load the shared workspace before the app renders. Never throws (shows the error in the banner). */
export async function initViewer(): Promise<void> {
  const id = shareParam!;
  document.documentElement.classList.add("tbw-viewer");
  try {
    const j = await fetchShare(id, false);
    update((s) => {
      s.servers = [{ id: "share", name: j.server || "Shared view", url: location.origin, token: j.token }];
      s.activeServer = "share";
      mergeWorkspace(s, j.workspace?.data);
      s.radar.live = s.radar.live && !s.saver;
    });
    viewer.value = { id, name: j.name, live: !!j.live, updated: j.updated, expires: j.expires, server: j.server, follow: true };
    document.title = `${j.name} · TheBigWeather`;
    if (j.live) startPolling(id);
  } catch (e: any) {
    viewer.value = { id, name: "Shared view", live: false, updated: 0, expires: 0, server: "", follow: false, error: e?.message ?? String(e) };
    // keep the connect dialog away: this page belongs to the share, not to a server setup
    update((s) => {
      s.servers = [{ id: "share", name: "Shared view", url: location.origin, token: "" }];
      s.activeServer = "share";
    });
  }
  openPanel.value = null;
  // viewer mode: no drawing tools
  effect(() => {
    if (tool.value === "draw") tool.value = "none";
    const p = openPanel.value as string | null;
    if (p && ["settings", "record", "files", "workspaces"].includes(p)) openPanel.value = null;
  });
}

function startPolling(id: string) {
  window.setInterval(async () => {
    const v = viewer.value;
    if (!v || document.hidden) return;
    try {
      const j = await fetchShare(id, true);
      if (j.updated === v.updated) return;
      const data = j.workspace?.data ?? {};
      update((s) => {
        const keepView = s.view;
        mergeWorkspace(s, data);
        if (!v.follow) s.view = keepView;
      });
      if (Array.isArray(data.drawings)) drawings.value = data.drawings;
      if (v.follow && data.view) mapRef.value?.easeTo({ center: data.view.center, zoom: data.view.zoom, duration: 800 });
      viewer.value = { ...v, name: j.name, updated: j.updated, expires: j.expires };
    } catch (e: any) {
      viewer.value = { ...v, error: e?.message ?? String(e) };
      toast(`Shared view: ${e?.message ?? e}`, "warn");
    }
  }, 20000);
}
