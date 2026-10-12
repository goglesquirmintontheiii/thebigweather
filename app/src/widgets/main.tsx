// workflow 0.6: desktop widget page (widget.html?kind=…&id=…). A small Preact view that talks to the
// server directly (api.ts with the stored server URL/token). No MapLibre or app bundle here.

import { render } from "preact";
import { settings } from "../store";
import "../api";
import "./widget.css";

const q = new URLSearchParams(location.search);
const kind = q.get("kind") ?? "clock";
const id = q.get("id") ?? "";

// follow settings changes made in the main window
window.addEventListener("storage", (e) => {
  if (e.key !== "tbw.settings.v1" || !e.newValue) return;
  try {
    const v = JSON.parse(e.newValue);
    settings.value = { ...settings.value, ...v, wf6: { ...settings.value.wf6, ...v.wf6 } };
  } catch {
    /* ignore */
  }
});
const light = () => {
  const m = settings.value.wf6?.themeMode;
  return m === "light" || (m === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
};
document.documentElement.dataset.theme = light() ? "light" : "dark";
if (q.get("bg") === "1") document.documentElement.classList.add("wg-bg");

import("./views").then(({ WidgetApp }) => render(<WidgetApp kind={kind} id={id} />, document.getElementById("root")!));
