// panes/palette/a11y 0.8: accessibility runtime. Everything is off / unchanged by default.
// - classes on <html>: a11y-contrast, a11y-reduce, a11y-focus, a11y-cvd-<type>
// - larger text: every px font-size in the stylesheets becomes calc(<px> * var(--a11y-ts)), so text
//   scales on its own, independently of the UI scale (zoom)
// - colour vision: alert colours + overlay paints remapped (cvd.ts), safe UI accents (CSS)
// - reduced motion: CSS animations/transitions off, map moves jump, alert flashing off (data loops keep playing)
// - keyboard: icon buttons get aria-labels from their titles, roving arrow-key focus in rails,
//   menus and toolbars, focus kept inside open modals, Esc closes, skip links (A11yChrome.tsx)
// - live region: new warnings and the frame time when stepping are announced

import { effect, signal } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { settings, type A11ySettings } from "../store";
import { mapRef } from "../map/mapview";
import { alerts } from "../alerts";
import { frameIndex, playing } from "../anim";
import { activeTime } from "../active";
import { fmtTime } from "../util";
import { applyAlertCvd, applyMapCvd, type Cvd } from "./cvd";

export const A11Y_DEFAULTS: A11ySettings = { cvd: "off", textScale: 1, contrast: false, reduceMotion: false, focusRings: false, announce: true };
export const a11y = () => ({ ...A11Y_DEFAULTS, ...(settings.value.a11y ?? {}) });

/* ---------- live region ---------- */
export const liveMsg = signal<{ text: string; n: number; assertive?: boolean }>({ text: "", n: 0 });
let liveN = 0;
export function announce(text: string, assertive = false) {
  if (!a11y().announce) return;
  liveMsg.value = { text, n: ++liveN, assertive };
}

/* ---------- larger text: scale stylesheet font sizes ---------- */
const seen = new WeakSet<CSSStyleSheet>();
function scaleRules(rules: CSSRuleList) {
  for (const r of Array.from(rules)) {
    if (r instanceof CSSStyleRule) {
      const fs = r.style.getPropertyValue("font-size").trim();
      if (/^[\d.]+px$/.test(fs)) r.style.setProperty("font-size", `calc(${fs} * var(--a11y-ts, 1))`, r.style.getPropertyPriority("font-size"));
    } else if ((r as any).cssRules) scaleRules((r as any).cssRules);
  }
}
function scanFonts() {
  for (const sh of Array.from(document.styleSheets)) {
    if (seen.has(sh)) continue;
    try {
      scaleRules(sh.cssRules);
      seen.add(sh);
    } catch {
      /* cross-origin sheet */
    }
  }
}

/* ---------- map: reduced motion + colour vision ---------- */
let hookedMap: MLMap | null = null;
let cvdTimer = 0;
function hookMap(m: MLMap) {
  if (hookedMap === m) return;
  hookedMap = m;
  // reduced motion: animated camera moves become jumps
  for (const fn of ["flyTo", "easeTo"] as const) {
    const orig = (m as any)[fn].bind(m);
    (m as any)[fn] = (o: any, ev?: any) => (a11y().reduceMotion ? orig({ ...o, duration: 0, animate: false }, ev) : orig(o, ev));
  }
  m.on("styledata", () => {
    clearTimeout(cvdTimer);
    cvdTimer = window.setTimeout(() => mapPass(m), 250);
  });
  mapPass(m);
}
function mapPass(m: MLMap) {
  const a = a11y();
  applyMapCvd(m, a.cvd as Cvd);
  if (m.getLayer("ovl-alerts-flash")) m.setLayoutProperty("ovl-alerts-flash", "visibility", a.reduceMotion ? "none" : "visible");
}

/* ---------- aria labels for icon-only controls ---------- */
function labelOne(el: HTMLElement) {
  const auto = el.dataset.a11yAuto === "1";
  if (el.hasAttribute("aria-label") && !auto) return;
  const tag = el.tagName;
  let label = "";
  if (tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button") {
    const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (txt.length > 1 && !auto) return;
    label = el.title || el.dataset.label || "";
    if (!label) {
      const svg = el.querySelector("svg[class*='lucide-']");
      const m = svg?.getAttribute("class")?.match(/lucide-([a-z0-9-]+)/g);
      const name = m?.map((x) => x.slice(7)).find((x) => x !== "icon");
      if (name) label = name.replace(/-/g, " ");
    }
    if (txt.length === 1 && label) label = `${label} (${txt})`;
  } else if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") {
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return;
    if (el.closest("label")) return;
    label = el.title || (el as HTMLInputElement).placeholder || "";
  }
  if (label && el.getAttribute("aria-label") !== label) {
    el.setAttribute("aria-label", label);
    el.dataset.a11yAuto = "1";
  }
}
function labelTree(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches("button, a, [role=button], select, input, textarea")) labelOne(root);
  root.querySelectorAll?.<HTMLElement>("button, a[href], a[role], [role=button], select, input:not([type=hidden]), textarea").forEach(labelOne);
  // landmark-ish roles for the app chrome
  root.querySelectorAll?.<HTMLElement>(".rail:not([role])").forEach((r) => (r.setAttribute("role", "toolbar"), r.setAttribute("aria-label", "Panels"), r.setAttribute("aria-orientation", "vertical")));
  root.querySelectorAll?.<HTMLElement>(".toolbar:not([role])").forEach((r) => (r.setAttribute("role", "toolbar"), r.setAttribute("aria-label", "Map tools")));
  root.querySelectorAll?.<HTMLElement>(".tb-more:not([role])").forEach((r) => (r.setAttribute("role", "menu"), r.setAttribute("aria-label", "More tools")));
  root.querySelectorAll?.<HTMLElement>(".side-panel:not([role])").forEach((r) => (r.setAttribute("role", "region"), r.setAttribute("aria-label", r.querySelector(".panel-head h2")?.textContent ?? "Panel")));
  root.querySelectorAll?.<HTMLElement>(".cmodal:not([role])").forEach((r) => (r.setAttribute("role", "dialog"), r.setAttribute("aria-modal", r.classList.contains("popped") ? "false" : "true"), r.setAttribute("aria-label", r.querySelector(".cm-title h2")?.textContent ?? "Window")));
}

/* ---------- roving focus: arrow keys inside rails, menus and toolbars ---------- */
const ROVE = ".rail, .toolbar, .tb-more, [role=toolbar], [role=menu], [role=radiogroup], [role=tablist], .lp-list, .pp8-row";
function focusables(c: Element): HTMLElement[] {
  return Array.from(c.querySelectorAll<HTMLElement>("button:not([disabled]), [role=menuitem], [role=radio], [role=tab], a[href]")).filter((e) => e.offsetParent !== null && e.closest(ROVE) === c);
}
function onRove(e: KeyboardEvent) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (!t || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable || t.getAttribute("role") === "slider") return;
  const c = t.closest(ROVE);
  if (!c || c.closest(".cp8")) return;
  const dlg = t.closest("[role=dialog]");
  if (dlg && !dlg.contains(c)) return; // a popover inside a toolbar keeps its own keys
  const list = focusables(c);
  const i = list.indexOf(t.closest("button, [role=menuitem], [role=radio], [role=tab], a") as HTMLElement);
  if (i < 0) return;
  const r = (c as HTMLElement).getBoundingClientRect();
  const vertical = c.getAttribute("aria-orientation") === "vertical" || (c.getAttribute("aria-orientation") !== "horizontal" && r.height > r.width * 1.5);
  const prev = vertical ? "ArrowUp" : "ArrowLeft", next = vertical ? "ArrowDown" : "ArrowRight";
  let j = -1;
  if (e.key === prev) j = (i - 1 + list.length) % list.length;
  else if (e.key === next) j = (i + 1) % list.length;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = list.length - 1;
  else return; // the cross axis keeps its normal meaning (frame stepping…)
  e.preventDefault();
  e.stopPropagation();
  list[j].focus();
}

/* ---------- modals: focus trap + restore ---------- */
const MODAL = ".cmodal-back .cmodal, .cp8, [aria-modal=true]";
function topModal(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(MODAL)).filter((m) => m.offsetParent !== null || getComputedStyle(m).position === "fixed");
  return all[all.length - 1] ?? null;
}
const TABBABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
function onTrap(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const m = topModal();
  if (!m || (document.activeElement as HTMLElement | null)?.classList.contains("cp8-in")) return; // the palette's Tab switches category
  const list = Array.from(m.querySelectorAll<HTMLElement>(TABBABLE)).filter((x) => x.offsetParent !== null);
  if (!list.length) return;
  const a = document.activeElement as HTMLElement | null;
  const i = a ? list.indexOf(a) : -1;
  if (!m.contains(a) || (e.shiftKey && i === 0) || (!e.shiftKey && i === list.length - 1)) {
    e.preventDefault();
    (e.shiftKey ? list[list.length - 1] : list[0]).focus();
  }
}
let lastModal: HTMLElement | null = null;
let returnTo: HTMLElement | null = null;
function watchModal() {
  const m = topModal();
  if (m === lastModal) return;
  if (m && !m.contains(document.activeElement)) {
    returnTo = document.activeElement as HTMLElement | null;
    const f = m.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]), " + TABBABLE);
    if (!m.classList.contains("cp8")) setTimeout(() => f?.focus({ preventScroll: true }), 0);
  }
  if (!m && lastModal && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  if (!m) returnTo = null;
  lastModal = m;
}

/* ---------- announcements ---------- */
let alertPrimed = false;
const alertSeen = new Set<string>();
function watchAlerts() {
  effect(() => {
    const all = [...alerts.value.values()];
    const fresh: any[] = [];
    for (const f of all) {
      const id = f?.properties?.id;
      if (!id || alertSeen.has(id)) continue;
      alertSeen.add(id);
      if (alertPrimed && /Warning|Emergency/.test(String(f.properties.event))) fresh.push(f);
    }
    if (all.length) alertPrimed = true;
    if (fresh.length) {
      const f = fresh[0];
      const area = String(f.properties.areaDesc ?? "").split(";").slice(0, 3).join(", ");
      announce(fresh.length === 1 ? `New ${f.properties.event}${area ? ` for ${area}` : ""}` : `${fresh.length} new warnings, including ${f.properties.event}`, /Tornado|Emergency/.test(f.properties.event));
    }
  });
  let t = 0;
  effect(() => {
    void frameIndex.value;
    if (playing.peek()) return;
    clearTimeout(t);
    t = window.setTimeout(() => {
      const at = activeTime.peek();
      if (at) announce(`Frame ${fmtTime(at, true)}`);
    }, 350);
  });
}

/* ---------- start ---------- */
let started = false;
export function startA11y() {
  if (started) return;
  started = true;
  const html = document.documentElement;
  let lastCvd: Cvd = "off";
  let lastSig = "";
  let lastMap: MLMap | null = null;
  effect(() => {
    const a = a11y();
    const m0 = mapRef.value;
    const sig = JSON.stringify(a);
    if (sig === lastSig && m0 === lastMap) return;
    lastSig = sig;
    lastMap = m0;
    html.classList.toggle("a11y-contrast", a.contrast);
    html.classList.toggle("a11y-reduce", a.reduceMotion);
    html.classList.toggle("a11y-focus", a.focusRings);
    for (const k of ["deutan", "protan", "tritan"]) html.classList.toggle(`a11y-cvd-${k}`, a.cvd === k);
    html.classList.toggle("a11y-cvd", a.cvd !== "off");
    if (a.textScale !== 1) scanFonts();
    html.style.setProperty("--a11y-ts", String(a.textScale));
    // the root size directly too (inherited text did not always re-lay out from the rewritten :root rule)
    html.style.fontSize = a.textScale !== 1 ? `${(13 * a.textScale).toFixed(2)}px` : "";
    html.classList.toggle("a11y-text", a.textScale !== 1);
    if (a.cvd !== lastCvd) {
      lastCvd = a.cvd as Cvd;
      applyAlertCvd(a.cvd as Cvd);
    }
    const m = mapRef.value;
    if (m) (hookMap(m), mapPass(m));
  });
  // later stylesheets (lazy chunks)
  new MutationObserver(() => a11y().textScale !== 1 && scanFonts()).observe(document.head, { childList: true });
  // labels + modal focus
  labelTree(document.body);
  let pending: Set<Node> = new Set();
  let raf = 0;
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === "attributes") pending.add(r.target);
      else r.addedNodes.forEach((n) => n.nodeType === 1 && pending.add(n));
    }
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const list = pending;
      pending = new Set();
      for (const n of list) if ((n as Element).isConnected) labelTree(n as any);
      watchModal();
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  window.addEventListener("keydown", onRove, true);
  window.addEventListener("keydown", onTrap, true);
  // keyboard vs mouse: focus rings only for keyboard users unless "always" is on
  window.addEventListener("keydown", (e) => e.key === "Tab" && html.classList.add("kb-nav"), true);
  window.addEventListener("pointerdown", () => html.classList.remove("kb-nav"), true);
  watchAlerts();
}
