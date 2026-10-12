import { useEffect, useRef } from "preact/hooks";
import { createMap } from "../map/mapview";
import { settings } from "../store";
import { startAlerts } from "../alerts";
import { Rail, SidePanel } from "./Sidebar";
import { TopBar } from "./Header";
import { Toolbar } from "./Toolbar";
import { Timeline } from "./Timeline";
import { Legend } from "./Legend";
import { StatusBar, Crosshair, FpsMeter, CursorValue } from "./Readouts";
import { StatsPanel } from "./StatsPanel";
import { AlertDetail } from "./AlertDetail";
import { Toasts, ContextMenu, AddCameraDialog } from "./Overlays";
import { ConnectDialog } from "./ConnectDialog";
import { useHotkeys } from "./hotkeys";
import { openLocalFile } from "../radar/controller";
import { OverlayPopup } from "./OverlayPopup";
import { CameraPanels } from "./CameraPanels";
import { ConfigModal } from "./OverlayList";
import { PaneGrid } from "./Panes";
import { NowPlaying } from "./panels/RadioPanel";
import { openPanel } from "../store";
import { importFile, isMapFile, loadFiles } from "../overlays/files";
import "../overlays/iss";
import "../overlays/mycams";
import { View3D } from "./View3D"; // 3D
// center modals (forecast, radio, seismograph) + radio players
import { ForecastCenter } from "./ForecastCenter";
import { RadioCenter } from "./RadioCenter";
import { RadioPlayers } from "./RadioPlayer";
import { ShakeCenter } from "./ShakeCenter";
import "../shake";

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    createMap(mapEl.current!);
    startAlerts();
    loadFiles();
    (window as any).__tbwImport = importFile;
  }, []);
  useHotkeys();
  const noServer = settings.value.servers.length === 0;

  return (
    <div
      class="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        for (const f of [...(e.dataTransfer?.files ?? [])]) {
          if (isMapFile(f)) importFile(f);
          else openLocalFile(f);
        }
      }}
    >
      <PaneGrid mapEl={mapEl} />
      <Crosshair />
      <CursorValue />
      <TopBar />
      <FpsMeter />
      <Rail />
      <SidePanel />
      <Legend />
      <View3D /> {/* 3D */}
      <div class="bottom-dock">
        <Timeline />
        <Toolbar />
      </div>
      <StatusBar />
      <StatsPanel />
      <AlertDetail />
      <OverlayPopup />
      <CameraPanels />
      <ConfigModal />
      <ForecastCenter />
      <RadioCenter />
      <ShakeCenter />
      <RadioPlayers />
      {openPanel.value !== "radio" && <NowPlaying compact />}
      <AddCameraDialog />
      <ContextMenu />
      <Toasts />
      {noServer && <ConnectDialog />}
    </div>
  );
}
