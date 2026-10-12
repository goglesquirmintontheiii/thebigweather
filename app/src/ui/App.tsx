import { useEffect, useRef } from "preact/hooks";
import { createMap } from "../map/mapview";
import { settings } from "../store";
import { startAlerts } from "../alerts";
import { Rail, SidePanel } from "./Sidebar";
import { TopBar } from "./Header";
import { Toolbar } from "./Toolbar";
import { Timeline } from "./Timeline";
import { HistoryBar } from "./HistoryBar"; // history
import { HistStorms } from "./HistStorms"; // history 0.6
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
import { ShakeMenu } from "./ShakeMenu"; // shake/stats/server 0.6
import { ServerSettings } from "./ServerSettings"; // shake/stats/server 0.6
import "../shake";
// layers 0.5: more overlays, rotation scan bar, storm table
import "../overlays/moredefs";
// radar 0.6: Level II analysis layers, placefiles, inspector
import "../radar/r6defs";
import "../radar/placefiles";
import { isPlacefileFile, addPlacefileFile } from "../radar/placefiles";
import { Inspector } from "./Inspector";
import { PlacefileHover } from "./PlacefilePanel";
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
/* data 0.6 */
import "../overlays/p6defs";
import "../overlays/p7defs"; // p7: power outages
import "../grid/contours";
import { LinesControl } from "./LinesControl";
import { SpacePanel } from "./SpacePanel";
/* end data 0.6 */
/* workflow 0.6 */
import { Wf6Overlays } from "./Wf6Overlays";
import { startRules } from "../rules/engine";
import { startWidgets } from "../widgets/manager";
import { startPlugins } from "../plugins/host";
import { kioskFromArgs, kiosk } from "../kiosk";
import { popoutSpec } from "../popout";
import { shareParam } from "../share/share";
/* end workflow 0.6 */
// share & collab (Phase 6)
import { SharePanel } from "./SharePanel";
import { CollabPanel } from "./CollabPanel";
import "../share/desktop";

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    createMap(mapEl.current!);
    startAlerts();
    loadFiles();
    (window as any).__tbwImport = importFile;
    /* workflow 0.6: main window only (not the mini radar / map pop-outs, not share viewers) */
    if (!popoutSpec && !shareParam) {
      startRules();
      startWidgets();
      startPlugins();
      kioskFromArgs();
    }
  }, []);
  useHotkeys();
  const noServer = settings.value.servers.length === 0;

  return (
    <div
      class={`app${kiosk.value ? " kiosk" : ""}` /* workflow 0.6 */}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        for (const f of [...(e.dataTransfer?.files ?? [])]) {
          if (isMapFile(f)) importFile(f);
          else isPlacefileFile(f).then((pf) => (pf ? addPlacefileFile(f) : openLocalFile(f))); // radar 0.6: placefiles
        }
      }}
    >
      <PaneGrid mapEl={mapEl} />
      <Crosshair />
      <CursorValue />
      <Inspector /> {/* radar 0.6 */}
      <PlacefileHover /> {/* radar 0.6 */}
      <TopBar />
      <ScanBar /> {/* layers 0.5 */}
      <StormTable /> {/* layers 0.5 */}
      <FpsMeter />
      <Rail />
      <SidePanel />
      <Legend />
      <LinesControl /> {/* data 0.6 */}
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
      <Wf6Overlays /> {/* workflow 0.6 */}
      <SharePanel /> {/* share & collab */}
      <CollabPanel /> {/* share & collab */}
      <ConfigModal />
      <ForecastCenter />
      <SpacePanel /> {/* data 0.6 */}
      <SoundingCenter /> {/* intl & forecast tools */}
      <RadioCenter />
      <HistStorms /> {/* history 0.6 */}
      <ShakeMenu /> {/* shake/stats/server 0.6 */}
      <ServerSettings /> {/* shake/stats/server 0.6 */}
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
