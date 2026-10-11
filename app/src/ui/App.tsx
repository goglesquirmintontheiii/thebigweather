import { useEffect, useRef } from "preact/hooks";
import { createMap } from "../map/mapview";
import { settings } from "../store";
import { startAlerts } from "../alerts";
import { Rail, SidePanel } from "./Sidebar";
import { TopBar } from "./Header";
import { Toolbar } from "./Toolbar";
import { Timeline } from "./Timeline";
import { Legend } from "./Legend";
import { StatusBar, Crosshair, FpsMeter } from "./Readouts";
import { StatsPanel } from "./StatsPanel";
import { AlertDetail } from "./AlertDetail";
import { Toasts, ContextMenu } from "./Overlays";
import { ConnectDialog } from "./ConnectDialog";
import { useHotkeys } from "./hotkeys";
import { openLocalFile } from "../radar/controller";

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    createMap(mapEl.current!);
    startAlerts();
  }, []);
  useHotkeys();
  const noServer = settings.value.servers.length === 0;

  return (
    <div
      class="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) openLocalFile(f);
      }}
    >
      <div ref={mapEl} class="map" />
      <Crosshair />
      <TopBar />
      <FpsMeter />
      <Rail />
      <SidePanel />
      <Legend />
      <div class="bottom-dock">
        <Timeline />
        <Toolbar />
      </div>
      <StatusBar />
      <StatsPanel />
      <AlertDetail />
      <ContextMenu />
      <Toasts />
      {noServer && <ConnectDialog />}
    </div>
  );
}
