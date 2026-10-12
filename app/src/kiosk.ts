// workflow 0.6: wall / kiosk mode — full screen, no chrome, cycles through chosen workspaces every
// N seconds with a large clock and an alert banner. Mouse/keyboard input pauses cycling; it
// resumes after the idle timeout. Esc (or the Exit button) leaves. `--kiosk` on the command line
// (Electron) or `#kiosk` in the URL starts in kiosk mode.

import { signal } from "@preact/signals";
import { settings, toast, toasts } from "./store";
import { applyWorkspace } from "./workspaces";

export const kiosk = signal(false);
export const kioskPaused = signal(false);
export const kioskIdx = signal(0);
let timer: number | undefined;
let idleTimer: number | undefined;
let lastInput = 0;

function cycle() {
  clearTimeout(timer);
  if (!kiosk.value) return;
  const k = settings.value.wf6.kiosk;
  const list = k.workspaces.filter((id) => settings.value.workspaces.some((w) => w.id === id));
  timer = window.setTimeout(() => {
    if (!kiosk.value) return;
    if (!kioskPaused.value && list.length > 1) {
      kioskIdx.value = (kioskIdx.value + 1) % list.length;
      applyWorkspace(list[kioskIdx.value]);
      // the workspace toast isn't needed on a wall display
      setTimeout(() => (toasts.value = toasts.value.filter((t) => !t.text.startsWith("Workspace “"))), 50);
    }
    cycle();
  }, Math.max(5, k.seconds) * 1000);
}

function onInput() {
  if (!kiosk.value) return;
  const now = Date.now();
  if (now - lastInput < 400) return;
  lastInput = now;
  kioskPaused.value = true;
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => (kioskPaused.value = false), Math.max(10, settings.value.wf6.kiosk.resume) * 1000);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && kiosk.value) exitKiosk();
  else onInput();
}

export function enterKiosk() {
  if (kiosk.value) return;
  kiosk.value = true;
  kioskPaused.value = false;
  document.documentElement.classList.add("kiosk");
  const io = (window as any).tbw?.wf6;
  if (io?.fullscreen) io.fullscreen(true);
  else document.documentElement.requestFullscreen?.().catch(() => {});
  const list = settings.value.wf6.kiosk.workspaces;
  if (list.length) {
    kioskIdx.value = 0;
    applyWorkspace(list[0]);
  } else toast("Kiosk: pick workspaces to cycle in the … menu → Kiosk settings (showing the current view)", "info", 6000);
  window.addEventListener("pointermove", onInput, true);
  window.addEventListener("pointerdown", onInput, true);
  window.addEventListener("wheel", onInput, true);
  window.addEventListener("keydown", onKey, true);
  cycle();
}

export function exitKiosk() {
  if (!kiosk.value) return;
  kiosk.value = false;
  clearTimeout(timer);
  clearTimeout(idleTimer);
  document.documentElement.classList.remove("kiosk");
  const io = (window as any).tbw?.wf6;
  if (io?.fullscreen) io.fullscreen(false);
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.removeEventListener("pointermove", onInput, true);
  window.removeEventListener("pointerdown", onInput, true);
  window.removeEventListener("wheel", onInput, true);
  window.removeEventListener("keydown", onKey, true);
}

/** Start in kiosk mode when asked on the command line / URL. */
export async function kioskFromArgs() {
  let on = location.hash.includes("kiosk");
  try {
    const argv: string[] = (await (window as any).tbw?.wf6?.argv?.()) ?? [];
    if (argv.includes("--kiosk")) on = true;
  } catch {
    /* browser */
  }
  if (on) setTimeout(enterKiosk, 1500);
}
