// 0.8.2 dev-only feedback capture: gathers element / area / page information from the DOM.

import { settings, openPanel } from "../store";
import { mapRef } from "../map/mapview";
import { lastHello } from "../api";

export const OWN = "data-devcap"; // the tool's own nodes (never captured)
const isOwn = (el: Element | null) => !!el?.closest?.(`[${OWN}]`);

const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/* ---------- console errors (last 30 s) ---------- */
const errs: { t: number; m: string }[] = [];
let hooked = false;
export function hookErrors() {
  if (hooked) return;
  hooked = true;
  const push = (m: string) => {
    errs.push({ t: Date.now(), m: clip(m, 200) });
    if (errs.length > 20) errs.shift();
  };
  const ce = console.error.bind(console);
  console.error = (...a: any[]) => {
    try {
      push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "object" ? safeJson(x) : String(x))).join(" "));
    } catch {
      /* ignore */
    }
    ce(...a);
  };
  window.addEventListener("error", (e) => push(`${e.message}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => push(`Unhandled: ${(e.reason as any)?.message ?? e.reason}`));
}
const safeJson = (x: any) => {
  try {
    return JSON.stringify(x).slice(0, 200);
  } catch {
    return String(x);
  }
};
export const recentErrors = () => {
  const t0 = Date.now() - 30_000;
  return errs
    .filter((e) => e.t >= t0)
    .slice(-5)
    .map((e) => e.m);
};

/* ---------- element helpers ---------- */
const IMPLICIT: Record<string, string> = { BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox", H1: "heading", H2: "heading", H3: "heading", H4: "heading", IMG: "img", NAV: "navigation", ASIDE: "complementary", LABEL: "label", DIALOG: "dialog", LI: "listitem", UL: "list", OL: "list", TABLE: "table", CANVAS: "canvas" };
export function roleOf(el: Element): string {
  const r = el.getAttribute("role");
  if (r) return r;
  if (el.tagName === "INPUT") {
    const t = (el as HTMLInputElement).type;
    return t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : t === "range" ? "slider" : t === "button" || t === "submit" ? "button" : "textbox";
  }
  if (el.tagName === "A" && !(el as HTMLAnchorElement).href) return "";
  return IMPLICIT[el.tagName] ?? "";
}

/** accessible-ish name: aria-label, labelledby, <label>, title, alt, placeholder, then text */
export function nameOf(el: Element, n = 120): string {
  const a = el.getAttribute("aria-label");
  if (a) return clip(a, n);
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    const t = lb
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (t.trim()) return clip(t, n);
  }
  if ((el as HTMLInputElement).labels?.length) {
    const t = [...(el as HTMLInputElement).labels!].map((l) => l.textContent).join(" ");
    if (t.trim()) return clip(t, n);
  }
  const wrapLabel = el.closest("label");
  if (wrapLabel && wrapLabel !== el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
    const t = wrapLabel.textContent;
    if (t?.trim()) return clip(t, n);
  }
  const field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  // visible text first (buttons, links, labels), then title / alt / placeholder
  const t = field ? "" : ((el as HTMLElement).innerText ?? el.textContent);
  if (t?.trim()) return clip(t, n);
  for (const k of ["title", "alt", "placeholder"]) {
    const v = el.getAttribute(k);
    if (v) return clip(v, n);
  }
  // a control in a ".row" with a label span before it (the app's common settings layout)
  if (field) {
    const prev = el.previousElementSibling;
    if (prev && /^(SPAN|LABEL)$/.test(prev.tagName) && prev.textContent?.trim()) return clip(prev.textContent, n);
  }
  const svgTitle = el.querySelector("title")?.textContent;
  return clip(svgTitle, n);
}

/** a short CSS path that finds the element again */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  let e: Element | null = el;
  for (let depth = 0; e && e.nodeType === 1 && depth < 6; depth++) {
    if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) {
      parts.unshift(`#${e.id}`);
      break;
    }
    let s = e.tagName.toLowerCase();
    const cls = [...e.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !/^(on|active|open|hover|focus|sel|selected|dragging|drop-\w+)$/.test(c)).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const p: Element | null = e.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === e!.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    parts.unshift(s);
    if (e === document.body) break;
    e = p;
  }
  return parts.join(" > ");
}

const HEADS = "h1,h2,h3,h4,legend,.lbl,.panel-head h2,.cm-title h2,.fpanel-title,summary";
/** headings of the sections the element is in, outermost first */
export function sectionsOf(el: Element): string[] {
  const out: string[] = [];
  let e: Element | null = el;
  while (e && e !== document.body) {
    // a heading among the previous siblings (settings "label then controls" layout)
    let p = e.previousElementSibling;
    for (let i = 0; p && i < 12; i++, p = p.previousElementSibling) {
      if (p.matches(HEADS) || p.querySelector?.(":scope > " + HEADS.split(",").join(",:scope > "))) {
        const h = p.matches(HEADS) ? p : p.querySelector(HEADS);
        const t = clip(h?.textContent, 60);
        if (t) out.push(t);
        break;
      }
    }
    // a container's own first heading
    if (e.parentElement && /^(SECTION|ASIDE|FIELDSET|DIALOG|DETAILS)$/.test(e.parentElement.tagName)) {
      const h = e.parentElement.querySelector(HEADS);
      if (h && !h.contains(el)) {
        const t = clip(h.textContent, 60);
        if (t) out.push(t);
      }
    }
    e = e.parentElement;
  }
  return [...new Set(out.reverse())].slice(-5);
}

const CONTAINERS = ".cmodal,.side-panel,.fpanel,[role=dialog],dialog,.modal,nav.rail,.toolbar,header,.ctx,.popup,.maplibregl-popup";
function containerName(c: Element): string {
  const h = c.querySelector(".cm-title h2,.panel-head h2,.fpanel-title,.ctx-title,h2,h3,[role=heading]");
  return clip(h?.textContent || c.getAttribute("aria-label") || c.getAttribute("title"), 80);
}
export function containersOf(el: Element): { tag: string; name: string; cls?: string }[] {
  const out: { tag: string; name: string; cls?: string }[] = [];
  let e: Element | null = el.closest(CONTAINERS);
  while (e) {
    out.unshift({ tag: e.tagName.toLowerCase(), name: containerName(e), cls: [...e.classList].filter((c) => c !== "glass").slice(0, 2).join(".") });
    e = e.parentElement?.closest(CONTAINERS) ?? null;
  }
  return out;
}

function componentOf(el: Element): string {
  const dc = el.closest("[data-c]") as HTMLElement | null;
  if (dc?.dataset.c) return dc.dataset.c;
  const names: string[] = [];
  let e: Element | null = el;
  while (e && names.length < 3 && e !== document.body) {
    const c = [...e.classList].find((x) => x.length > 2 && !/^(glass|row|on|btn|sm|ghost|icon-btn|muted|small)$/.test(x));
    if (c) names.unshift(c);
    e = e.parentElement;
  }
  return names.join(" > ");
}

function trimHtml(el: Element): string {
  let h = el.outerHTML
    .replace(/<svg\b[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/\s(style|d|points|transform)="[^"]{40,}"/g, ' $1="…"')
    .replace(/\s+/g, " ");
  if (h.length > 600) h = h.slice(0, 599) + "…";
  return h;
}

export function elementInfo(el: Element) {
  const within = el.parentElement?.closest("a,button,label,[role=button],[role=tab],[role=menuitem],li");
  const inp = el as HTMLInputElement;
  let value: string | undefined;
  if (el.tagName === "INPUT" && (inp.type === "checkbox" || inp.type === "radio")) value = inp.checked ? "checked" : "unchecked";
  else if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && inp.type !== "password") value = clip(el.tagName === "SELECT" ? `${inp.value} (${(el as HTMLSelectElement).selectedOptions[0]?.text ?? ""})` : inp.value, 120);
  return {
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    name: nameOf(el),
    role: roleOf(el),
    value,
    disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || undefined,
    sections: sectionsOf(el),
    within: within ? { tag: within.tagName.toLowerCase(), name: nameOf(within, 80), href: (within as HTMLAnchorElement).href || undefined } : undefined,
    component: componentOf(el),
    html: trimHtml(el),
  };
}

/* ---------- area ---------- */
const INTERACTIVE = "a[href],button,input,select,textarea,[role=button],[role=tab],[role=checkbox],[role=slider],[role=menuitem],[tabindex]:not([tabindex='-1'])";
function ownText(el: Element): string {
  let t = "";
  for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
  return clip(t, 80);
}
function visible(el: Element, r: DOMRect) {
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}
/** elements inside or partly inside the area (viewport CSS px), most useful first, ≤ 60 */
export function areaElements(a: { x: number; y: number; w: number; h: number }) {
  const all = document.body.querySelectorAll("*");
  const hits: { el: Element; score: number; r: DOMRect }[] = [];
  for (const el of all) {
    if (isOwn(el) || (el.closest("svg") !== null && el.tagName.toLowerCase() !== "svg")) continue;
    if (/^(SCRIPT|STYLE|LINK|META|BR|HTML|BODY|HEAD|OPTION)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.right < a.x || r.bottom < a.y || r.left > a.x + a.w || r.top > a.y + a.h) continue;
    if (!visible(el, r)) continue;
    const inter = el.matches(INTERACTIVE);
    const txt = ownText(el);
    const media = /^(IMG|CANVAS|SVG|VIDEO)$/i.test(el.tagName);
    if (!inter && !txt && !media && !el.getAttribute("title") && !el.getAttribute("aria-label")) continue;
    // elements that enclose the whole area (map, panels) are context, listed in "containers"
    if (!txt && r.left <= a.x && r.top <= a.y && r.right >= a.x + a.w && r.bottom >= a.y + a.h) continue;
    // skip text inside an interactive element (the control carries its name)
    if (!inter && el.parentElement?.closest(INTERACTIVE)) continue;
    const covers = r.width * r.height > a.w * a.h * 4; // huge containers (the map) matter less
    hits.push({ el, r, score: (inter ? 3 : 0) + (txt ? 2 : 0) + (media ? 1 : 0) - (covers ? 3 : 0) });
  }
  const top = hits
    .map((h, i) => ({ ...h, i }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, 60)
    .sort((x, y) => x.i - y.i);
  return top.map((h, k) => {
    const name = nameOf(h.el);
    const text = ownText(h.el);
    return {
      n: k + 1,
      tag: h.el.tagName.toLowerCase(),
      name,
      text: text && text !== name ? text : undefined,
      role: roleOf(h.el),
      box: { x: Math.round(h.r.left - a.x), y: Math.round(h.r.top - a.y), w: Math.round(h.r.width), h: Math.round(h.r.height) },
    };
  });
}

/* ---------- page ---------- */
const visibleEls = (sel: string) => [...document.querySelectorAll(sel)].filter((e) => !isOwn(e) && (e as HTMLElement).offsetParent !== null);
export async function pageInfo() {
  const s = settings.peek();
  const w = s.weather as any;
  const m = mapRef.peek();
  let center: [number, number] | undefined;
  let zoom: number | undefined;
  try {
    const c = m?.getCenter();
    if (c) center = [+c.lng.toFixed(4), +c.lat.toFixed(4)];
    if (m) zoom = +m.getZoom().toFixed(2);
  } catch {
    /* map not ready */
  }
  const win = visibleEls(".cmodal .cm-title h2").pop();
  const dlg = visibleEls("[role=dialog],dialog[open],.modal").pop();
  const tabs = visibleEls(".seg button.on,[role=tab][aria-selected=true],.tabs .on,.tab.on")
    .map((e) => clip((e as HTMLElement).innerText, 30))
    .filter(Boolean)
    .slice(0, 8);
  let info: any = null;
  try {
    info = await (window as any).tbw?.info?.();
  } catch {
    /* browser */
  }
  return {
    app: { version: info?.version ?? "", platform: info?.platform ?? (navigator.userAgent.includes("Windows") ? "win32" : navigator.platform), server: lastHello.peek()?.version ?? "" },
    page: {
      path: openPanel.peek() ? `rail:${openPanel.peek()}` : "map",
      heading: clip(win?.textContent, 80),
      dialog: dlg ? clip(dlg.querySelector("h1,h2,h3,.title")?.textContent ?? dlg.getAttribute("aria-label"), 80) : undefined,
      tabs,
      viewport: { w: innerWidth, h: innerHeight },
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      map: m ? { center, zoom, layer: w.kind === "radar" ? `radar:${s.radar.source}/${s.radar.product}` : `${w.kind}:${w.id ?? ""}`, panes: document.querySelectorAll(".maplibregl-map").length } : undefined,
    },
  };
}
