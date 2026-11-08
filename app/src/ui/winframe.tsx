// 0.8.2 windows: the one title-bar button group every window uses (side panels, centre windows,
// floating panels, cameras, radio players, layer settings, pop-out OS windows):
//   [pop-out] [● close] [● minimize] [● maximize / restore]   (Mac-style, glyphs on hover)
// plus the shared window state: minimized windows (chips in the tray, bottom left), maximized
// windows, the Esc stack (Esc closes only the top window), the open/close animation switch and the
// registry of windows that can pop out into their own OS window (filled by winreg.tsx).

import "./winframe.css";
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { PictureInPicture2, SquareArrowDownLeft } from "lucide-preact";
import { popoutSpec, popout, canPopout, type PopoutSpec } from "../popout";
import { settings } from "../store";
import { perf } from "../perf";
import { raise, topOf } from "./wincore";

/* ---------- pop-out OS windows ---------- */

/** pop-out kinds that run frameless, with the shared title bar drawn by the page */
export const OS_FRAMELESS = ["camera", "radio", "metar", "radiocenter", "win"];
/** this page is a frameless pop-out window */
export const IN_OS_WIN = !!popoutSpec && OS_FRAMELESS.includes(popoutSpec.kind);
/** the window id a pop-out shows ("win" pop-outs; the radio centre is "c:rc") */
const OLD_KIND_WIN: Record<string, string> = { radiocenter: "c:rc", camera: "cam", metar: "metar", radio: "radio" };
export const POP_WIN: string | null = !popoutSpec ? null : popoutSpec.kind === "win" ? String(popoutSpec.data?.id ?? "") : OLD_KIND_WIN[popoutSpec.kind] ?? null;
const tbw = () => (window as any).tbw as any;
/** OS window control (pop-outs only): close / min / max; resolves to "is maximized" */
export async function osCtl(a: "close" | "min" | "max"): Promise<boolean> {
  try {
    const r = tbw()?.win?.ctl ? await tbw().win.ctl(a) : null;
    if (r == null && a === "close") window.close();
    return !!r;
  } catch {
    if (a === "close") window.close();
    return false;
  }
}
/** the pop-out OS window is maximized */
export const osMax = signal(false);
if (IN_OS_WIN) {
  document.documentElement.classList.add("wf-oswin");
  try {
    tbw()?.win?.onMax?.((v: boolean) => (osMax.value = v));
  } catch {
    /* browser */
  }
}

/** A window that can open in its own OS window. */
export interface Popper {
  id: string;
  title: string;
  w?: number;
  h?: number;
  isOpen: () => boolean;
  /** open it (in this window), with the argument `arg()` gave */
  open: (arg?: any) => void;
  close: () => void;
  /** state to carry over (e.g. which sounding, which layer) */
  arg?: () => any;
  /** content of the pop-out window */
  render: () => any;
  /** pop out another way (an older pop-out kind) */
  spec?: () => PopoutSpec;
  /** keep it open in this window but hidden while popped (state kept in settings) */
  hideWhenPopped?: boolean;
}
export const POPPERS = new Map<string, Popper>();
export function registerPopper(p: Popper) {
  POPPERS.set(p.id, p);
}
/** windows open in their own OS window right now: id → last seen */
export const popped = signal<Record<string, number>>({});
export const isPopped = (id: string) => !!popped.value[id];
export const canPop = (id: string) => canPopout() && POPPERS.has(id);

/** Open window `id` in its own OS window (focuses it when it's already out). */
export function popWindow(id: string) {
  const p = POPPERS.get(id);
  if (!p) return;
  const spec: PopoutSpec = p.spec?.() ?? { kind: "win", title: p.title, width: p.w ?? 900, height: p.h ?? 640, data: { id, arg: p.arg?.() } };
  popout(spec);
  popped.value = { ...popped.peek(), [id]: Date.now() + 12_000 }; // until the window says "here" (winsync.ts)
  forget(id);
  if (!p.hideWhenPopped) p.close();
}
/** set by winsync.ts: tell the main window to take this window back */
export let dockImpl: (id: string, arg: any) => void = () => {};
export function setDockImpl(fn: (id: string, arg: any) => void) {
  dockImpl = fn;
}
/** pop-out window: put the window back into the main window and close this one */
export function dockBack() {
  if (!POP_WIN) return void osCtl("close");
  const p = POPPERS.get(POP_WIN);
  dockImpl(POP_WIN, p?.arg ? p.arg() : popoutSpec?.kind === "win" ? popoutSpec.data?.arg : popoutSpec?.data);
  setTimeout(() => osCtl("close"), 60);
}

/* ---------- animations ---------- */

/** open/close animations allowed (Settings → Performance → Animations, Accessibility → Reduce motion) */
export const animOn = () => perf.value.anim && !settings.value.a11y?.reduceMotion;
export const ANIM_MS = 200;
let ghosts: HTMLElement | null = null;
/** Fade a copy of a window out after it closed (the real one is gone at once). */
export function ghostOut(el: HTMLElement | null | undefined) {
  if (!el || !el.isConnected || !animOn()) return;
  try {
    if (!ghosts || !ghosts.isConnected) {
      ghosts = document.createElement("div");
      ghosts.className = "wf-ghosts";
      document.body.appendChild(ghosts);
    }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const g = el.cloneNode(true) as HTMLElement;
    g.classList.add("wf-ghost");
    g.setAttribute("aria-hidden", "true");
    g.removeAttribute("id");
    ghosts.appendChild(g);
    setTimeout(() => g.remove(), ANIM_MS + 30);
  } catch {
    /* cosmetic */
  }
}

/* ---------- minimized / maximized ---------- */

export interface MinItem {
  id: string;
  title: string;
}
export const minimized = signal<MinItem[]>([]);
const restorers = new Map<string, () => void>();
const minClosers = new Map<string, () => void>();
export const isMin = (id: string) => minimized.value.some((m) => m.id === id);
/** Collapse a window to a chip in the tray. `restore` reopens it (default: just shows it again). */
export function minimize(id: string, title: string, restore?: () => void, close?: () => void) {
  if (restore) restorers.set(id, restore);
  else restorers.delete(id);
  if (close) minClosers.set(id, close);
  else minClosers.delete(id);
  const t = (title || "Window").trim().slice(0, 40);
  minimized.value = [...minimized.peek().filter((m) => m.id !== id), { id, title: t }];
}
export function unminimize(id: string) {
  if (minimized.peek().some((m) => m.id === id)) minimized.value = minimized.peek().filter((m) => m.id !== id);
  restorers.delete(id);
  minClosers.delete(id);
}
export function restoreWin(id: string) {
  const r = restorers.get(id);
  unminimize(id);
  r?.();
  raiseWin(id);
}
function closeMin(id: string) {
  const c = minClosers.get(id);
  unminimize(id);
  c?.();
}
export const maxed = signal<Record<string, true>>({});
export const isMax = (id: string) => !!maxed.value[id];
export function toggleMax(id: string, on = !maxed.peek()[id]) {
  const m = { ...maxed.peek() };
  if (on) m[id] = true;
  else delete m[id];
  maxed.value = m;
}
/** a window closed: drop its minimized / maximized state */
export function forget(id: string) {
  unminimize(id);
  if (maxed.peek()[id]) toggleMax(id, false);
}

/** Rail / menu click on a window's button: restore it when minimized, focus it when popped out. */
export function winAware(id: string, click: () => void) {
  return () => {
    if (minimized.peek().some((m) => m.id === id)) return restoreWin(id);
    if (popped.peek()[id] && POPPERS.has(id)) return popWindow(id);
    click();
  };
}

/* ---------- Esc closes the top window ---------- */

let stack: string[] = [];
const closers = new Map<string, () => void>();
export function raiseWin(id: string) {
  if (closers.has(id)) stack = raise(stack, id);
}
/** Register a window for Esc while `active` (open, not minimized). */
export function useEscClose(id: string, close: () => void, active: boolean) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    closers.set(id, () => ref.current());
    stack = raise(stack, id);
    return () => {
      closers.delete(id);
      stack = stack.filter((x) => x !== id);
    };
  }, [id, active]);
}
if (typeof window !== "undefined" && !IN_OS_WIN)
  // registered at load, before the global hotkeys: a window on top swallows Esc (the side panel stays)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLInputElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") && t.value) return;
    const top = topOf(stack, (id) => !closers.has(id));
    if (!top) return;
    e.stopImmediatePropagation();
    closers.get(top)?.();
  });

/* ---------- the button group ---------- */

export interface WinButtonsProps {
  onClose: () => void;
  /** minimize (in-app); pop-out OS windows minimize the OS window */
  onMin?: () => void;
  /** maximize / restore (in-app) */
  onZoom?: () => void;
  zoomed?: boolean;
  /** pop out to an OS window (in-app); in a pop-out the same button docks back */
  onPop?: () => void;
  /** this frame is the pop-out OS window's own frame */
  os?: boolean;
  closeTitle?: string;
}
const stop = (e: Event) => e.stopPropagation();

export function WinButtons({ onClose, onMin, onZoom, zoomed, onPop, os, closeTitle }: WinButtonsProps) {
  const zoomedNow = os ? osMax.value : !!zoomed;
  const min = os ? () => osCtl("min") : onMin;
  const zoom = os ? () => osCtl("max").then((v) => (osMax.value = v)) : onZoom;
  const pop = os ? (POP_WIN ? dockBack : undefined) : onPop;
  // a pop-out's red button closes the OS window (after the content's own close)
  const close = os
    ? () => {
        try {
          onClose();
        } finally {
          osCtl("close");
        }
      }
    : onClose;
  return (
    <div class="wf-btns" onPointerDown={stop} onDblClick={stop} onMouseDown={stop}>
      {pop && (
        <button class="wf-pop" title={os ? "Dock back into the main window" : "Pop out to its own window"} aria-label={os ? "Dock back" : "Pop out"} onClick={pop}>
          {os ? <SquareArrowDownLeft size={13} /> : <PictureInPicture2 size={13} />}
        </button>
      )}
      <span class="wf-lights">
        <button class="wf-l wf-close" title={closeTitle ?? (os ? "Close window" : "Close (Esc)")} aria-label="Close" onClick={close}>
          <i>×</i>
        </button>
        <button class="wf-l wf-min" title="Minimize" aria-label="Minimize" disabled={!min} onClick={min}>
          <i>−</i>
        </button>
        <button class="wf-l wf-zoom" title={zoomedNow ? "Restore size" : "Maximize"} aria-label={zoomedNow ? "Restore size" : "Maximize"} disabled={!zoom} onClick={zoom}>
          <i>⤢</i>
        </button>
      </span>
    </div>
  );
}

/** double-click on a title bar (not on its buttons / inputs) */
export const onBarDbl = (fn: () => void) => (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest?.("button,input,select,textarea,a,label,.wf-btns")) return;
  fn();
};
/** the text of a title (for the minimized chip) */
export function titleText(title: ComponentChildren, el?: Element | null, sel = "h2,h3,.fpanel-title,.cam-title,.rp-title,span"): string {
  if (typeof title === "string" || typeof title === "number") return String(title);
  return el?.querySelector(sel)?.textContent?.trim() || "Window";
}

/* ---------- tray of minimized windows (bottom left) ---------- */

export function MinTray() {
  const l = minimized.value;
  if (!l.length) return null;
  return (
    <div class="wf-tray" role="toolbar" aria-label="Minimized windows">
      {l.map((m) => (
        <span key={m.id} class="wf-chip glass">
          <button class="wf-chip-main" title={`Restore ${m.title}`} onClick={() => restoreWin(m.id)}>
            <i class="wf-chip-dot" />
            {m.title}
          </button>
          <button class="wf-chip-x" title="Close" aria-label={`Close ${m.title}`} onClick={() => closeMin(m.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
