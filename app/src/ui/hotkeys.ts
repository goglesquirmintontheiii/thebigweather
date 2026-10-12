import { popup } from "../overlays/manager";
import { useEffect } from "preact/hooks";
import { tool, crosshair, update, openPanel, selectedAlert } from "../store";
import { tilts, l3Products } from "../radar/controller";
import { togglePlay, stepFrame } from "../anim";
import { locate, screenshot } from "./Toolbar";
import { settings } from "../store";
import { toggle3D } from "./View3D"; // 3D

const PRODUCTS = ["REF", "VEL", "SW", "ZDR", "RHO", "PHI"];

export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 3D: Shift+3 (plain digits pick radar products)
      if (e.shiftKey && e.code === "Digit3") {
        toggle3D();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepFrame(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          stepFrame(1);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          if (settings.value.weather.kind !== "radar") break;
          const r = settings.value.radar;
          if (r.source === "L3") {
            // same product family, next/previous tilt
            const cur = l3Products.value.find((p) => p.id === r.product);
            if (!cur) break;
            const fam = l3Products.value.filter((p) => p.code === cur.code && !!p.tdwr === !!cur.tdwr).sort((a, b) => a.tilt - b.tilt);
            const i = fam.indexOf(cur) + (e.key === "ArrowUp" ? 1 : -1);
            if (i >= 0 && i < fam.length) update((s) => (s.radar.product = fam[i].id));
            break;
          }
          const angles = [...new Set(tilts.value.filter((x) => x.moments.includes(r.product)).map((x) => x.angle))].sort((a, b) => a - b);
          if (!angles.length) break;
          let i = angles.reduce((bi, a, k) => (Math.abs(a - r.tiltAngle) < Math.abs(angles[bi] - r.tiltAngle) ? k : bi), 0);
          i = Math.max(0, Math.min(angles.length - 1, i + (e.key === "ArrowUp" ? 1 : -1)));
          update((s) => (s.radar.tiltAngle = angles[i]));
          break;
        }
        case "l":
          locate();
          break;
        case "s":
          screenshot();
          break;
        case "c":
          crosshair.value = !crosshair.value;
          break;
        case "d":
          tool.value = tool.value === "draw" ? "none" : "draw";
          break;
        case "v":
          update((s) => (s.ui.cursorValue = !s.ui.cursorValue));
          break;
        case "m":
          tool.value = tool.value === "measure" ? "none" : "measure";
          break;
        case "b":
          tool.value = tool.value === "bearing" ? "none" : "bearing";
          break;
        case "r":
          update((s) => (s.overlays.sites = !s.overlays.sites));
          break;
        case "Escape":
          tool.value = "none";
          selectedAlert.value = null;
          popup.value = null;
          openPanel.value = null;
          break;
        default:
          if (/^[1-6]$/.test(e.key) && settings.value.radar.source === "L2" && settings.value.weather.kind === "radar") update((s) => (s.radar.product = PRODUCTS[+e.key - 1]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
