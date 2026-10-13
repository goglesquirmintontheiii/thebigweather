// panes/palette/a11y 0.8: open Settings and scroll to one section or control (command palette,
// "Edit layouts" in the panes menu). Targets are found by a data-set anchor, else by label text.

import { openPanel } from "../store";

/** anchor id ("pane-layouts", "a11y"…) or the visible label of a toggle/row/section */
export function jumpToSetting(target: string, panel: "settings" | string = "settings") {
  openPanel.value = panel as any;
  let tries = 0;
  const find = (): HTMLElement | null => {
    const root = document.querySelector<HTMLElement>(".side-panel .panel-body");
    if (!root) return null;
    const a = root.querySelector<HTMLElement>(`[data-set="${CSS.escape(target)}"]`);
    if (a) return a;
    const want = target.trim().toLowerCase();
    const cands = root.querySelectorAll<HTMLElement>("label.toggle > span:first-child, .lbl, .row > span:first-child, h3, h4, summary, button");
    for (const el of cands) if ((el.textContent ?? "").trim().toLowerCase() === want) return el.closest<HTMLElement>("label, .row, section, details") ?? el;
    for (const el of cands) if ((el.textContent ?? "").trim().toLowerCase().startsWith(want)) return el.closest<HTMLElement>("label, .row, section, details") ?? el;
    return null;
  };
  const go = () => {
    const el = find();
    if (!el) {
      if (++tries < 20) setTimeout(go, 60);
      return;
    }
    // open a collapsed <details> on the way
    let d = el.closest("details");
    while (d) {
      (d as HTMLDetailsElement).open = true;
      d = d.parentElement?.closest("details") ?? null;
    }
    el.scrollIntoView({ block: "center", behavior: document.documentElement.classList.contains("a11y-reduce") ? "auto" : "smooth" });
    el.classList.remove("set-flash");
    void el.offsetWidth;
    el.classList.add("set-flash");
    setTimeout(() => el.classList.remove("set-flash"), 1800);
    const f = el.matches("input, select, button, textarea") ? el : el.querySelector<HTMLElement>("input, select, button, textarea");
    f?.focus({ preventScroll: true });
  };
  setTimeout(go, 30);
}
