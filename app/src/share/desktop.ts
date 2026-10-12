// Desktop integration (Electron, Phase 6): tray badge with the warnings covering saved points,
// "Mute alerts" from the tray, files opened through file associations, and the server bundled
// with the app ("Run the server in this app").

import { effect } from "@preact/signals";
import { settings, update, toast, uid } from "../store";
import { alerts } from "../alerts";
import { alertVisible } from "../alertstyle";
import { pointInGeometry } from "../util";
import { parsePal } from "../radar/colormaps";
import { openLocalFile } from "../radar/controller";
import type { Workspace } from "../workspaces";

const tbw: any = (window as any).tbw;
const POPOUT = location.hash.includes("popout=");

export interface LocalServerStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  url: string;
  port: number;
  pid: number;
  error: string;
  data: string;
}
export interface DesktopPrefs {
  closeToTray: boolean;
  autoStart: boolean;
  localServer: boolean;
  muted: boolean;
  platform: string;
  server: LocalServerStatus;
}

export const hasDesktop = () => !!tbw?.desktop;
export const getDesktop = (): Promise<DesktopPrefs> => tbw.desktop.get();
export const setDesktop = (p: Partial<DesktopPrefs>): Promise<DesktopPrefs> => tbw.desktop.set(p);
export const localServer = (action: "status" | "start" | "stop" | "logs" = "status"): Promise<LocalServerStatus> => tbw.localServer(action);

export const BUILTIN_ID = "builtin";

/** Start the bundled server, wait until it answers, and make it the active server. */
export async function useBuiltinServer(onStatus?: (s: string) => void): Promise<boolean> {
  let st = await localServer("start");
  if (!st.available) {
    toast(st.error || "This build has no bundled server", "error");
    return false;
  }
  onStatus?.("Starting the server…");
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${st.url}/api/health`);
      if (r.ok) {
        addBuiltinEntry(st.url, true);
        return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
    st = await localServer("status");
    if (st.error && !st.running) break;
  }
  toast(`The built-in server didn't start: ${st.error || "timeout"}`, "error");
  return false;
}

function addBuiltinEntry(url: string, activate: boolean) {
  update((s) => {
    const e = s.servers.find((x) => x.id === BUILTIN_ID);
    if (e) e.url = url;
    else s.servers.push({ id: BUILTIN_ID, name: "Built-in server", url, token: "" });
    if (activate || !s.activeServer) s.activeServer = BUILTIN_ID;
  });
}

if (tbw?.desktop && !POPOUT && !/[?&]share=/.test(location.search)) {
  // keep the built-in server entry's port current (the app picks a free port at start)
  getDesktop()
    .then((d) => {
      if (d.localServer && d.server.url) addBuiltinEntry(d.server.url, false);
      // sync mute state both ways
      if (d.muted === settings.value.audio.alerts) setDesktop({ muted: !settings.value.audio.alerts });
    })
    .catch(() => {});

  // tray: warnings that cover a saved point
  let last = "";
  effect(() => {
    const pts = settings.value.points;
    const hits: string[] = [];
    for (const f of alerts.value.values()) {
      const p = f.properties;
      if (!String(p.event).endsWith("Warning") || !alertVisible(p.event)) continue;
      if (pts.some((pt) => pointInGeometry(pt.lon, pt.lat, f.geometry))) hits.push(p.event);
    }
    const uniq = [...new Set(hits)];
    const text = uniq.slice(0, 3).join(", ") + (uniq.length > 3 ? "…" : "");
    const key = `${hits.length}|${text}`;
    if (key === last) return;
    last = key;
    tbw.tray?.update({ count: hits.length, text });
  });

  tbw.tray?.onMute((m: boolean) => {
    update((s) => (s.audio.alerts = !m));
    toast(m ? "Alert sounds muted" : "Alert sounds on");
  });
  let lastAudio = settings.value.audio.alerts;
  effect(() => {
    const a = settings.value.audio.alerts;
    if (a !== lastAudio) {
      lastAudio = a;
      setDesktop({ muted: !a }).catch(() => {});
    }
  });

  // files opened with the app (double-click / "Open with")
  tbw.onOpenFile?.((f: { name: string; data: Uint8Array }) => openAssociated(f.name, f.data));
}

export async function openAssociated(name: string, data: Uint8Array) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pal")) {
    const text = new TextDecoder().decode(data);
    const id = name.replace(/\.pal$/i, "");
    try {
      parsePal(text, id);
      update((s) => (s.customPals[id] = text));
      toast(`Imported colour table ${id} · pick it under Radar → Color table`);
    } catch (e: any) {
      toast(`Bad palette: ${e.message}`, "error");
    }
    return;
  }
  if (lower.endsWith(".tbwws")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(data));
      const list: Workspace[] = Array.isArray(j) ? j : Array.isArray(j.workspaces) ? j.workspaces : j.data ? [j] : [];
      const ok = list.filter((w) => w && typeof w.name === "string" && w.data && typeof w.data === "object");
      if (!ok.length) throw new Error("no workspaces in this file");
      update((s) => {
        for (const w of ok) {
          const nw: Workspace = { id: uid(), name: w.name, saved: w.saved || Date.now(), keys: !!(w.data as any).keybinds, data: w.data };
          const i = s.workspaces.findIndex((x) => x.name.toLowerCase() === w.name.toLowerCase());
          if (i >= 0) s.workspaces[i] = nw;
          else s.workspaces.push(nw);
        }
      });
      toast(`Imported ${ok.length} workspace${ok.length > 1 ? "s" : ""} · see Workspaces`);
    } catch (e: any) {
      toast(`Couldn't open ${name}: ${e.message}`, "error");
    }
    return;
  }
  // Level II volumes (.ar2v, .gz, .bz2, raw archive names)
  await openLocalFile(new File([data as BlobPart], name));
}
