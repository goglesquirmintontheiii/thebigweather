// User keyboard shortcuts for toggling layers: "Ctrl+Shift+K", or two-key chords like "G R"
// (second key within 800 ms). Stored in settings.keybinds (layer id → combo).

import { signal } from "@preact/signals";
import { settings, update, toast } from "./store";
import { OVERLAYS, overlayDef } from "./overlays/defs";
import { fileOverlays } from "./overlays/files";

export const CHORD_MS = 800;
export const BASE_LAYERS: Record<string, string> = { alerts: "Weather alerts", sites: "Radar sites", points: "My points", counties: "County lines", states: "State lines", labels: "Place labels", rings: "Range rings" };

/** shortcuts dialog (`?`) */
export const shortcutsOpen = signal(false);

const MODS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/** One key press as a step string ("Ctrl+Alt+G"), or null for a lone modifier. */
export function stepOf(e: KeyboardEvent): string | null {
  if (MODS.has(e.key)) return null;
  let key: string;
  let shiftable = true;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.code.startsWith("Numpad") && /^\d$/.test(e.key)) key = `Num${e.key}`;
  else if (e.key === " ") key = "Space";
  else if (e.key.length === 1) {
    // punctuation: the character itself already reflects Shift
    key = e.key;
    shiftable = false;
  } else key = e.key;
  const m: string[] = [];
  if (e.ctrlKey) m.push("Ctrl");
  if (e.altKey) m.push("Alt");
  if (e.shiftKey && shiftable) m.push("Shift");
  if (e.metaKey) m.push("Meta");
  return [...m, key].join("+");
}

export function layerName(id: string): string {
  if (id.startsWith("base:")) return BASE_LAYERS[id.slice(5)] ?? id.slice(5);
  if (id.startsWith("file:")) return fileOverlays.value.find((f) => `file:${f.id}` === id)?.name ?? "File";
  return overlayDef(id)?.name ?? id;
}

/** every layer a shortcut can toggle */
export function allLayers(): { id: string; name: string; group: string }[] {
  return [
    ...Object.entries(BASE_LAYERS).map(([k, n]) => ({ id: `base:${k}`, name: n, group: "Map" })),
    ...OVERLAYS.filter((o) => !o.hidden).map((o) => ({ id: o.id, name: o.name, group: o.group })),
    ...fileOverlays.value.map((f) => ({ id: `file:${f.id}`, name: f.name, group: "My files" })),
  ];
}

export function isLayerOn(id: string): boolean {
  if (id.startsWith("base:")) return !!(settings.value.overlays as any)[id.slice(5)];
  return !!settings.value.ovl[id]?.on;
}

export function toggleLayer(id: string) {
  const on = !isLayerOn(id);
  update((s) => {
    if (id.startsWith("base:")) (s.overlays as any)[id.slice(5)] = on;
    else s.ovl[id] = { ...(s.ovl[id] ?? {}), on };
  });
  toast(`${layerName(id)} ${on ? "on" : "off"}`, "info", 1500);
}

/** Human-readable conflicts for a combo (built-in keys, other bindings). */
export function conflictsFor(combo: string, id: string, builtins: [string, string][]): string[] {
  const out: string[] = [];
  const first = combo.split(" ")[0];
  for (const [k, what] of builtins) if (k === combo || k === first) out.push(`${fmtCombo(k)} is built in: ${what}`);
  for (const [other, c] of Object.entries(settings.value.keybinds ?? {})) {
    if (other === id) continue;
    const of = c.split(" ")[0];
    if (c === combo) out.push(`Already toggles ${layerName(other)}`);
    else if (c === first || of === combo) out.push(`Overlaps ${fmtCombo(c)} (${layerName(other)})`);
  }
  return out;
}

export function fmtCombo(c: string) {
  return c
    .split(" ")
    .map((s) => s.replace(/Arrow(Left|Right|Up|Down)/, (_, d) => ({ Left: "←", Right: "→", Up: "↑", Down: "↓" })[d as "Left"]))
    .join(" then ");
}

export function setKeybind(id: string, combo: string | null) {
  update((s) => {
    s.keybinds = { ...(s.keybinds ?? {}) };
    if (combo) s.keybinds[id] = combo;
    else delete s.keybinds[id];
  });
}

// ---------- global handler (called first by ui/hotkeys.ts) ----------
let pending: { step: string; timer: number } | null = null;

export function handleKeybind(e: KeyboardEvent): boolean {
  const binds = Object.entries(settings.value.keybinds ?? {});
  if (!binds.length) return false;
  const step = stepOf(e);
  if (!step) return false;
  if (pending) {
    const chord = `${pending.step} ${step}`;
    clearTimeout(pending.timer);
    pending = null;
    const hit = binds.find(([, c]) => c === chord);
    if (hit) {
      e.preventDefault();
      toggleLayer(hit[0]);
      return true;
    }
  }
  const singles = binds.filter(([, c]) => c === step);
  const prefix = binds.some(([, c]) => c.startsWith(`${step} `));
  if (prefix) {
    e.preventDefault();
    pending = {
      step,
      timer: window.setTimeout(() => {
        pending = null;
        for (const [id] of singles) toggleLayer(id);
      }, CHORD_MS),
    };
    return true;
  }
  if (singles.length) {
    e.preventDefault();
    for (const [id] of singles) toggleLayer(id);
    return true;
  }
  return false;
}
