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
/* detection models */
import { ModelsCenter } from "./ModelsCenter";
import "../overlays/mldefs";
/* end detection models */
/* radio/dash 0.8 */
import "../overlays/p8adefs";
import { Dashboard } from "./Dashboard";
import { AlertTimeline } from "./AlertTimeline";
/* end radio/dash 0.8 */
/* data 0.8 */
import "../overlays/p8defs";
import "../chase/chase";
import { ChaserPanel } from "./ChaserPanel";
import { ExportPanel } from "./ExportPanel";
import { NotifyPanel } from "./NotifyPanel";
import { P8LayerDock } from "./LayerPicker";
/* end data 0.8 */

/* panes/palette/a11y 0.8 */
import { PaneWindowApp } from "./Panes";
import { CommandPalette } from "./CommandPalette";
import { SkipLinks, LiveRegion } from "../a11y/A11yUI";
import { startA11y } from "../a11y/a11y";
/* end panes/palette/a11y 0.8 */

export function App() {
  /* panes 0.8: a pane window shows only its map pane (popoutSpec never changes, so hooks stay stable) */
  if (popoutSpec?.kind === "pane") return <PaneWindowApp />;
  return <MainApp />;
}

function MainApp() {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    createMap(mapEl.current!);
    startAlerts();
    loadFiles();
    startA11y(); // panes/palette/a11y 0.8
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
      <SkipLinks /> {/* panes/palette/a11y 0.8 */}
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
      <P8LayerDock /> {/* data 0.8 */}
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
      <ModelsCenter /> {/* detection models */}
      <Dashboard /> {/* radio/dash 0.8 */}
      <AlertTimeline /> {/* radio/dash 0.8 */}
      <ChaserPanel /> {/* data 0.8 */}
      <ExportPanel /> {/* data 0.8 */}
      <NotifyPanel /> {/* data 0.8 */}
      <ShakeMenu /> {/* shake/stats/server 0.6 */}
      <ServerSettings /> {/* shake/stats/server 0.6 */}
      <RadioPlayers />
      {openPanel.value !== "radio" && <NowPlaying compact />}
      <AddCameraDialog />
      <ContextMenu />
      <ShortcutsDialog />
      <Toasts />
      <CommandPalette /> {/* panes/palette/a11y 0.8 */}
      <LiveRegion /> {/* panes/palette/a11y 0.8 */}
      {noServer && <ConnectDialog />}
    </div>
  );
}
