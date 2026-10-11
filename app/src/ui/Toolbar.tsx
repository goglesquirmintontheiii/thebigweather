import { tool, crosshair, toast, settings, update } from "../store";
import { playing, togglePlay, frameCount } from "../anim";
import { mapRef, measureTotal, measurePts, describeBearing, bearingInfo } from "../map/mapview";
import { fmtDist } from "../util";
import { Play, Pause, LocateFixed, Camera, Compass, Crosshair, Ruler, RadioTower, PenTool, MousePointer2 } from "lucide-preact";
import * as maplibregl from "maplibre-gl";

let locMarker: maplibregl.Marker | null = null;

export async function locate() {
  const map = mapRef.value;
  if (!map) return;
  const show = (lat: number, lon: number, approx: boolean) => {
    locMarker?.remove();
    const el = document.createElement("div");
    el.className = `me-marker ${approx ? "approx" : ""}`;
    locMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), approx ? 8 : 10) });
    if (approx) toast("Approximate location (from IP)", "info");
  };
  const ipFallback = async () => {
    try {
      const r = await fetch("https://ipwho.is/").then((x) => x.json());
      if (r.success !== false && r.latitude) return show(r.latitude, r.longitude, true);
    } catch {
      /* next */
    }
    const home = settings.value.points[0];
    if (home) return show(home.lat, home.lon, false);
    toast("Couldn't get your location", "warn");
  };
  if (!("geolocation" in navigator)) return ipFallback();
  navigator.geolocation.getCurrentPosition(
    (p) => show(p.coords.latitude, p.coords.longitude, false),
    () => ipFallback(),
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 },
  );
}

export async function screenshot() {
  const tbw = (window as any).tbw;
  if (tbw?.capture) {
    const path = await tbw.capture();
    if (path) toast(`Saved ${path}`);
    return;
  }
  // browser fallback: map canvas only
  const map = mapRef.value;
  if (!map) return;
  map.once("render", () => {
    map.getCanvas().toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `TBW_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
      a.click();
    });
  });
  map.triggerRepaint();
}

export function Toolbar() {
  const t = tool.value;
  void measurePts.value;
  void bearingInfo.value;
  const btn = (on: boolean, title: string, onClick: () => void, icon: any, disabled = false) => (
    <button class={`tb ${on ? "on" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  );
  return (
    <div class="toolbar-wrap">
      {t === "measure" && (
        <div class="tool-readout glass">
          {measurePts.value.length < 2 ? "Click points to measure · right-click to finish" : `Total ${fmtDist(measureTotal())}`}
        </div>
      )}
      {t === "bearing" && bearingInfo.value && <div class="tool-readout glass">From {settings.value.radar.site}: {describeBearing()}</div>}
      <div class="toolbar glass">
        {btn(playing.value, "Play / pause loop (Space)", togglePlay, playing.value ? <Pause size={19} /> : <Play size={19} />, frameCount.value < 2)}
        {btn(false, "My location (L)", locate, <LocateFixed size={19} />)}
        {btn(false, "Screenshot (S)", screenshot, <Camera size={19} />)}
        {btn(t === "bearing", "Distance & direction from radar (B)", () => (tool.value = t === "bearing" ? "none" : "bearing"), <Compass size={19} />)}
        {btn(crosshair.value, "Center crosshair value (C)", () => (crosshair.value = !crosshair.value), <Crosshair size={19} />)}
        {btn(settings.value.ui.cursorValue, "Show the value under the mouse (V) · or hold Shift", () => update((s) => (s.ui.cursorValue = !s.ui.cursorValue)), <MousePointer2 size={19} />)}
        {btn(t === "measure", "Measure distance (M)", () => (tool.value = t === "measure" ? "none" : "measure"), <Ruler size={19} />)}
        {btn(settings.value.overlays.sites, "Show/hide radar sites (R)", () => update((s) => (s.overlays.sites = !s.overlays.sites)), <RadioTower size={19} />)}
        {btn(false, "Drawing mode — coming in phase 4", () => toast("Drawing mode arrives in phase 4"), <PenTool size={19} />, false)}
      </div>
    </div>
  );
}
