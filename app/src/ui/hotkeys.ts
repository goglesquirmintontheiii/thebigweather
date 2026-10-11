import { useEffect } from "preact/hooks";
import { tool, crosshair, update, openPanel, selectedAlert } from "../store";
import { togglePlay, frames, frameIndex, playing, tilts } from "../radar/controller";
import { locate, screenshot } from "./Toolbar";
import { settings } from "../store";

const PRODUCTS = ["REF", "VEL", "SW", "ZDR", "RHO", "PHI"];

export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = frames.value.length;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          playing.value = false;
          if (n) frameIndex.value = (frameIndex.value - 1 + n) % n;
          break;
        case "ArrowRight":
          playing.value = false;
          if (n) frameIndex.value = (frameIndex.value + 1) % n;
          break;
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const r = settings.value.radar;
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
          openPanel.value = null;
          break;
        default:
          if (/^[1-6]$/.test(e.key) && settings.value.radar.source === "L2") update((s) => (s.radar.product = PRODUCTS[+e.key - 1]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
