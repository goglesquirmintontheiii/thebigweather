// panes/palette/a11y 0.8: skip links, the screen-reader live region, and Settings → Accessibility.

import { settings, update, type A11ySettings } from "../store";
import { Toggle } from "../ui/panels/RadarPanel";
import { a11y, liveMsg, A11Y_DEFAULTS, announce } from "./a11y";
import { openPalette } from "../ui/CommandPalette";

function focusSel(sel: string) {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return;
  if (!el.hasAttribute("tabindex") && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|CANVAS)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
  el.focus();
}

/** Visually hidden until focused (first Tab stop). */
export function SkipLinks() {
  const link = (label: string, fn: () => void) => (
    <a
      href="#"
      class="skip8"
      onClick={(e) => {
        e.preventDefault();
        fn();
      }}
    >
      {label}
    </a>
  );
  return (
    <nav class="skip8-nav" aria-label="Skip links">
      {link("Skip to map", () => (focusSel(".pane.main .maplibregl-canvas"), announce("Map focused. Arrow keys pan, plus and minus zoom.")))}
      {link("Skip to map tools", () => focusSel(".toolbar button"))}
      {link("Skip to panels", () => focusSel(".rail button"))}
      {link("Search everything (Ctrl+K)", () => openPalette())}
    </nav>
  );
}

export function LiveRegion() {
  const m = liveMsg.value;
  return (
    <>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {!m.assertive && m.text ? <span key={m.n}>{m.text}</span> : null}
      </div>
      <div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {m.assertive && m.text ? <span key={m.n}>{m.text}</span> : null}
      </div>
    </>
  );
}

export function AccessibilitySection() {
  const a = a11y();
  const set = (p: Partial<A11ySettings>) => update((x) => (x.a11y = { ...A11Y_DEFAULTS, ...(x.a11y ?? {}), ...p }));
  return (
    <section data-set="a11y">
      <label class="lbl">Accessibility</label>
      <div class="row">
        <span>Colour vision</span>
        <select
          value={a.cvd}
          aria-label="Colour vision palette"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value as A11ySettings["cvd"];
            update((x) => {
              x.a11y = { ...A11Y_DEFAULTS, ...(x.a11y ?? {}), cvd: v };
              if (v !== "off") x.colorblind = true; // radar colour tables too
            });
          }}
        >
          <option value="off">Standard colours</option>
          <option value="deutan">Deuteranopia-safe (red–green)</option>
          <option value="protan">Protanopia-safe (red–green, reds dark)</option>
          <option value="tritan">Tritanopia-safe (blue–yellow)</option>
        </select>
      </div>
      {a.cvd !== "off" && <div class="muted small">Radar tables use the colour-blind set; alert colours, overlay colours, legends and status accents are remapped. Turn “Colorblind-friendly tables” off under Units & time to keep standard radar tables.</div>}
      <div class="row">
        <span>Text size</span>
        <input type="range" min={100} max={150} step={5} value={Math.round(a.textScale * 100)} aria-label="Text size" onChange={(e) => set({ textScale: +(e.target as HTMLInputElement).value / 100 })} />
        <span class="val">{Math.round(a.textScale * 100)}%</span>
      </div>
      <div class="a11y-sizes" role="radiogroup" aria-label="Text size presets">
        {[1, 1.15, 1.3, 1.5].map((v) => (
          <button key={v} role="radio" aria-checked={a.textScale === v} class={`pp8-chip ${a.textScale === v ? "on" : ""}`} onClick={() => set({ textScale: v })}>
            {v === 1 ? "Normal" : `${Math.round(v * 100)}%`}
          </button>
        ))}
      </div>
      <Toggle label="High contrast" on={a.contrast} set={(v) => set({ contrast: v })} hint="Opaque black panels, white text, strong outlines" />
      <Toggle label="Reduce motion" on={a.reduceMotion} set={(v) => set({ reduceMotion: v })} hint="No pulsing, blinking or animated map moves (radar loops still play)" />
      <Toggle label="Always show focus rings" on={a.focusRings} set={(v) => set({ focusRings: v })} hint="Otherwise rings show only while using the keyboard" />
      <Toggle label="Screen-reader announcements" on={a.announce} set={(v) => set({ announce: v })} hint="New warnings and the frame time when stepping" />
      <div class="muted small">
        Keyboard: Tab moves between controls, arrow keys move within the side rail, toolbars and menus, Esc closes, Ctrl+K searches everything. The first Tab stop is “Skip to map”.
      </div>
      {JSON.stringify({ ...A11Y_DEFAULTS, ...(settings.value.a11y ?? {}) }) !== JSON.stringify(A11Y_DEFAULTS) && (
        <button class="btn sm ghost" onClick={() => update((x) => (x.a11y = { ...A11Y_DEFAULTS }))}>
          Reset accessibility
        </button>
      )}
    </section>
  );
}
