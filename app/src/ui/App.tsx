import { useEffect, useRef } from "preact/hooks";
import { createMap } from "../map/mapview";
import { settings } from "../store";
import { startAlerts } from "../alerts";
import { Rail, SidePanel } from "./Sidebar";
import { TopBar } from "./Header";
import { Toolbar } from "./Toolbar";
import { Timeline } from "./Timeline";
import { HistoryBar } from "./HistoryBar"; // history
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
import { ShortcutsDialog } from "./Shortcuts"; // legend, panes, keys
// center modals (forecast, radio, seismograph) + radio players
import { ForecastCenter } from "./ForecastCenter";
import { RadioCenter } from "./RadioCenter";
import { RadioPlayers } from "./RadioPlayer";
import { ShakeCenter } from "./ShakeCenter";
import "../shake";
// layers 0.5: more overlays, rotation scan bar, storm table
import "../overlays/moredefs";
import { ScanBar } from "./ScanBar";
import { StormTable } from "./LayerExtras";
// intl & forecast tools
import { SoundingCenter } from "./SoundingCenter";
import { IntlLegend } from "./IntlLegend";
import "../intl/sites";
// workflow
import "../theme";
import "../saver";
import "../overlays/cambadges";
import { XSection } from "./XSection";
import { MetarPanels } from "./MetarPanels";
import { TrackPanel } from "./TrackPanel";

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
      <ScanBar /> {/* layers 0.5 */}
      <StormTable /> {/* layers 0.5 */}
      <FpsMeter />
      <Rail />
      <SidePanel />
      <Legend />
      <IntlLegend /> {/* intl & forecast tools */}
      <View3D /> {/* 3D */}
      <div class="bottom-dock">
        <HistoryBar />
        <Timeline />
        <Toolbar />
      </div>
      <StatusBar />
      <StatsPanel />
      <AlertDetail />
      <OverlayPopup />
      <CameraPanels />
      <XSection /> {/* workflow */}
      <MetarPanels /> {/* workflow */}
      <TrackPanel /> {/* workflow */}
      <ConfigModal />
      <ForecastCenter />
      <SoundingCenter /> {/* intl & forecast tools */}
      <RadioCenter />
      <ShakeCenter />
      <RadioPlayers />
      {openPanel.value !== "radio" && <NowPlaying compact />}
      <AddCameraDialog />
      <ContextMenu />
      <ShortcutsDialog />
      <Toasts />
      {noServer && <ConnectDialog />}
    </div>
  );
}
