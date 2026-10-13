// p8: updates — the desktop app (electron-updater, GitHub releases) and the server this app is
// connected to when it runs on this computer (GET/POST /api/admin/update, local admin only).

import { signal } from "@preact/signals";
import { api } from "../api";

export interface AppUpdateState {
  /** idle | checking | latest | available | downloading | downloaded | installing | error */
  state: string;
  current: string;
  version: string;
  notes: string;
  date: string;
  progress: number;
  bytesPerSecond: number;
  error: string;
  /** false: dev build, portable .exe, non-AppImage Linux (see `reason`) */
  supported: boolean;
  reason: string;
  lastCheck: number;
  /** check daily + download in the background */
  auto: boolean;
  url: string;
}

export interface ServerUpdateState {
  current: string;
  latest?: string;
  update_available: boolean;
  can_update: boolean;
  reason?: string;
  notes?: string;
  html_url?: string;
  published_at?: string;
  asset?: string | null;
  managed?: string | null;
  error?: string;
  assets?: { name: string; size: number; url: string }[];
}

const tbw: any = (window as any).tbw;
export const hasAppUpdater = () => !!tbw?.update;

export const appUpdate = signal<AppUpdateState | null>(null);

let wired = false;
/** Start following the updater state (idempotent). */
export function watchAppUpdate() {
  if (!hasAppUpdater() || wired) return;
  wired = true;
  tbw.update.get().then((s: AppUpdateState) => (appUpdate.value = s));
  tbw.update.onState((s: AppUpdateState) => (appUpdate.value = s));
}

export const checkApp = async () => (appUpdate.value = await tbw.update.check());
export const downloadApp = async () => (appUpdate.value = await tbw.update.download());
export const installApp = async () => (appUpdate.value = await tbw.update.install());
export const setAutoUpdate = async (auto: boolean) => (appUpdate.value = await tbw.update.set({ auto }));
export const openReleasePage = () => tbw?.update?.openPage?.() ?? window.open("https://github.com/goglesquirmintontheiii/thebigweather/releases/latest", "_blank");

/** Server update status; null when the server isn't on this computer (admin API refused). */
export async function serverUpdateStatus(refresh = false): Promise<ServerUpdateState | null> {
  try {
    return await api.get(`/api/admin/update${refresh ? "?refresh=1" : ""}`);
  } catch {
    return null;
  }
}

/** Download, verify and install the latest server release, then the server restarts. */
export async function updateServer(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    return await api.send("POST", "/api/admin/update", {});
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function fmtSpeed(bps: number): string {
  if (!bps) return "";
  return bps > 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`;
}
