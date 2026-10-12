// workflow 0.6: desktop widgets (Rainmeter-style) — the main window's side. Each widget is a small
// frameless, transparent OS window (Electron) showing widget.html?kind=…&id=…; positions are
// remembered by the main process per widget. In a browser, widgets open as popup windows.

import { effect } from "@preact/signals";
import { settings, update, uid, toast, type WidgetCfg, type WidgetKind } from "../store";

export const WIDGET_KINDS: { kind: WidgetKind; name: string; w: number; h: number; note: string }[] = [
  { kind: "radar", name: "Mini radar", w: 300, h: 300, note: "MRMS composite loop around a point" },
  { kind: "current", name: "Current conditions", w: 300, h: 190, note: "Temperature, feels-like, wind and the next hours" },
  { kind: "alerts", name: "Alert ticker", w: 520, h: 64, note: "Scrolling warnings for your points" },
  { kind: "countdown", name: "Storm arrival", w: 280, h: 130, note: "Countdown to the next storm cell's arrival" },
  { kind: "lightning", name: "Nearest lightning", w: 260, h: 130, note: "Nearest GOES GLM flash, distance and age" },
  { kind: "clock", name: "Clock + radar age", w: 260, h: 120, note: "Local/UTC time and how old the radar is" },
];

const io = () => (window as any).tbw?.wf6 as { widgetOpen(c: any): Promise<boolean>; widgetClose(id: string): Promise<void>; widgetSet(id: string, o: any): Promise<void>; onWidgetClosed?(cb: (id: string) => void): void } | undefined;
export const canNativeWidgets = () => !!io()?.widgetOpen;

const popups = new Map<string, Window>();

function url(w: WidgetCfg) {
  return `widget.html?kind=${w.kind}&id=${encodeURIComponent(w.id)}`;
}

function open(w: WidgetCfg) {
  const k = WIDGET_KINDS.find((x) => x.kind === w.kind)!;
  const e = io();
  if (e) return e.widgetOpen({ id: w.id, url: url(w), width: k.w, height: k.h, opacity: w.opacity, onTop: w.onTop, locked: w.locked, title: k.name });
  const win = popups.get(w.id);
  if (win && !win.closed) return win.focus();
  const p = window.open(url(w), `tbw-widget-${w.id}`, `popup=yes,width=${k.w},height=${k.h}`);
  if (!p) return toast("The browser blocked the widget window (allow pop-ups)", "warn");
  popups.set(w.id, p);
}
function close(id: string) {
  const e = io();
  if (e) return e.widgetClose(id);
  popups.get(id)?.close();
  popups.delete(id);
}

export function addWidget(kind: WidgetKind) {
  const w: WidgetCfg = { id: uid(), kind, point: settings.value.points[0]?.id ?? "", opacity: 1, onTop: true, locked: false, open: true, zoom: 7 };
  update((s) => s.wf6.widgets.push(w));
}
export function setWidget(id: string, fn: (w: WidgetCfg) => void) {
  update((s) => {
    const w = s.wf6.widgets.find((x) => x.id === id);
    if (w) fn(w);
  });
}
export function removeWidget(id: string) {
  close(id);
  update((s) => (s.wf6.widgets = s.wf6.widgets.filter((w) => w.id !== id)));
}

let started = false;
/** Open/close/configure widget windows to match the settings (also restores them at startup). */
export function startWidgets() {
  if (started || /widget\.html$/.test(location.pathname) || location.hash.includes("popout=")) return;
  started = true;
  io()?.onWidgetClosed?.((id) => setWidget(id, (w) => (w.open = false)));
  const shown = new Map<string, string>();
  effect(() => {
    const list = settings.value.wf6.widgets;
    for (const [id] of shown) if (!list.some((w) => w.id === id && w.open)) (close(id), shown.delete(id));
    for (const w of list) {
      if (!w.open) continue;
      const sig = `${w.opacity}|${w.onTop}|${w.locked}`;
      const prev = shown.get(w.id);
      if (prev === undefined) open(w);
      else if (prev !== sig) io()?.widgetSet(w.id, { opacity: w.opacity, onTop: w.onTop, locked: w.locked });
      shown.set(w.id, sig);
    }
  });
}
