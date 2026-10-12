import { tool, crosshair, toast, settings, update } from "../store";
import { playing, togglePlay, frameCount } from "../anim";
import { mapRef, measureTotal, measurePts, describeBearing, bearingInfo } from "../map/mapview";
import { fmtDist } from "../util";
import { Play, Pause, LocateFixed, Camera, Compass, Crosshair, Ruler, RadioTower, PenTool, MousePointer2 } from "lucide-preact";
import * as maplibregl from "maplibre-gl";
import { DrawBar } from "./DrawBar";
import { PaneButton } from "./Panes";
import { ScreenRecButton } from "./ScreenRecButton";
import { CalendarClock } from "lucide-preact"; // history
import { histRange, histPicker, exitHistory } from "../history"; // history
// workflow
import { useState } from "preact/hooks";
import { Film, Bookmark, Slice, Route, Leaf, Ellipsis } from "lucide-preact";
import { loopDialog, loopProgress } from "../loopexport";
import { LoopExportDialog } from "./LoopExport";
import { SrvControl } from "./SrvControl";
import { WorkspaceMenu } from "./panels/WorkspacePanel";
import { startXSection, xsLine } from "./XSection";
import { trackPanel, recording } from "../gps";
import { Share2, Users } from "lucide-preact"; // share & collab
import { shareDialog } from "../share/share"; // share & collab
import { teamOpen, team, unread } from "../share/collab"; // share & collab

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
  const [wsOpen, setWsOpen] = useState(false); // workflow
  const [more, setMore] = useState(false);
  void measurePts.value;
  void bearingInfo.value;
  const btn = (on: boolean, title: string, onClick: () => void, icon: any, disabled = false) => (
    <button class={`tb ${on ? "on" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  );
  const item = (on: boolean, label: string, key: string, onClick: () => void, icon: any, disabled = false) => (
    <button class={`tb-more-item ${on ? "on" : ""}`} onClick={onClick} disabled={disabled}>
      {icon}
      <span>{label}</span>
      {key && <kbd>{key}</kbd>}
    </button>
  );
  // a tool inside the menu is active
  const moreOn = t === "bearing" || t === "xsect" || crosshair.value || settings.value.ui.cursorValue || !!xsLine.value || trackPanel.value || loopDialog.value || !!loopProgress.value;
  return (
    <div class="toolbar-wrap">
      {t === "measure" && (
        <div class="tool-readout glass">
          {measurePts.value.length < 2 ? "Click points to measure · right-click to finish" : `Total ${fmtDist(measureTotal())}`}
        </div>
      )}
      {t === "draw" && <DrawBar />}
      {t === "bearing" && bearingInfo.value && <div class="tool-readout glass">From {settings.value.radar.site}: {describeBearing()}</div>}
      {/* workflow */ t === "xsect" && <div class="tool-readout glass">Cross-section: click two points · Esc to cancel</div>}
      <SrvControl />
      <LoopExportDialog />
      {wsOpen && (
        <>
          <div class="ws-scrim" onPointerDown={() => setWsOpen(false)} />
          <WorkspaceMenu onClose={() => setWsOpen(false)} />
        </>
      )}
      {more && (
        <>
          <div class="ws-scrim" onPointerDown={() => setMore(false)} />
          <div class="tb-more glass" onClick={() => setMore(false)}>
            {item(t === "bearing", "Distance & direction", "B", () => (tool.value = t === "bearing" ? "none" : "bearing"), <Compass size={16} />)}
            {item(crosshair.value, "Center crosshair value", "C", () => (crosshair.value = !crosshair.value), <Crosshair size={16} />)}
            {item(settings.value.ui.cursorValue, "Value under mouse", "V", () => update((s) => (s.ui.cursorValue = !s.ui.cursorValue)), <MousePointer2 size={16} />)}
            {item(settings.value.overlays.sites, "Radar sites", "R", () => update((s) => (s.overlays.sites = !s.overlays.sites)), <RadioTower size={16} />)}
            {/* workflow */ item(t === "xsect" || !!xsLine.value, "Cross-section (Level II)", "", startXSection, <Slice size={16} />)}
            {item(loopDialog.value || !!loopProgress.value, "Export loop (GIF / MP4)", "", () => (loopDialog.value = !loopDialog.value), <Film size={16} />, frameCount.value < 1 || !!loopProgress.value)}
            {item(trackPanel.value, recording.value ? "GPS track · recording" : "GPS track & chasers", "", () => (trackPanel.value = !trackPanel.value), <Route size={16} />)}
            {item(wsOpen, "Workspaces", "", () => setWsOpen(!wsOpen), <Bookmark size={16} />)}
            {/* share & collab */ item(shareDialog.value, "Share live view", "", () => (shareDialog.value = !shareDialog.value), <Share2 size={16} class="p6-owner" />)}
            {item(teamOpen.value, team.value ? `Team · ${team.value.name}${unread.value ? ` (${unread.value})` : ""}` : "Team (live collaboration)", "", () => (teamOpen.value = !teamOpen.value), <Users size={16} class="p6-owner" />)}
          </div>
        </>
      )}
      <div class="toolbar glass">
        {btn(playing.value, "Play / pause loop (Space)", togglePlay, playing.value ? <Pause size={19} /> : <Play size={19} />, frameCount.value < 2)}
        {/* history */ btn(!!histRange.value || histPicker.value, histRange.value ? "Historical mode on · click for live" : "Historical mode", () => (histRange.value ? exitHistory() : (histPicker.value = !histPicker.value)), <CalendarClock size={19} />)}
        {btn(false, "My location (L)", locate, <LocateFixed size={19} />)}
        {btn(false, "Screenshot (S)", screenshot, <Camera size={19} />)}
        <ScreenRecButton />
        {btn(t === "measure", "Measure distance (M)", () => (tool.value = t === "measure" ? "none" : "measure"), <Ruler size={19} />)}
        <PaneButton />
        {btn(t === "draw", "Drawing mode (D)", () => (tool.value = t === "draw" ? "none" : "draw"), <PenTool size={19} />)}
        {btn(
          more || moreOn,
          "More tools",
          () => setMore(!more),
          <span class="tb-ic">
            <Ellipsis size={19} />
            {recording.value && <i class="tb-dot rec" />}
          </span>,
        )}
        {settings.value.saver && btn(true, "Bandwidth saver on · click to turn off", () => update((s) => (s.saver = false)), <Leaf size={19} />)}
      </div>
    </div>
  );
}

/* ---------- workflow: automation hook (screenshots / console) ---------- */
import { pinMetar } from "./MetarPanels";
import { stormCells, stormPrepare } from "../overlays/stormcells";
import { recs } from "./panels/RecordPanel";
import { openPanel } from "../store";
import { tracks, startTrack } from "../gps";
(window as any).__tbwWf = { loopDialog, startXSection, xsLine, pinMetar, trackPanel, recording, tracks, startTrack, stormCells, stormPrepare, recs, openPanel, update, settings };
