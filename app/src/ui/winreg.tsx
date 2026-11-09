// 0.8.2 windows: every window that can pop out into its own OS window (rail tabs, centre windows,
// layer settings, floating panels), and the page a "win" pop-out shows. The pop-out runs the same
// content component; settings changes flow both ways through winsync.ts.

import { Component } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { registerPopper, POPPERS, dockBack, osCtl, type Popper } from "./winframe";
import { openPanel, settings, type PanelId } from "../store";
import { SidePanel, PANEL_TITLES } from "./Sidebar";
import { ForecastCenter, forecastOpen } from "./ForecastCenter";
import { radioOpen } from "./RadioCenter";
import { ShakeMenu } from "./ShakeMenu";
import { shakeOpen } from "../shake";
import { SoundingCenter } from "./SoundingCenter";
import { soundingReq } from "../sounding/state";
import { SpacePanel, spaceOpen } from "./SpacePanel";
import { HistStorms } from "./HistStorms";
import { histStormsOpen } from "../histsearch";
import { ModelsCenter } from "./ModelsCenter";
import { mlOpen } from "../ml/client";
import { Dashboard, dashOpen } from "./Dashboard";
import { AlertTimeline, timelineOpen } from "./AlertTimeline";
import { ServerSettings, serverSettingsOpen } from "./ServerSettings";
import { ConfigModal, configModal } from "./OverlayList";
import { ChaserPanel } from "./ChaserPanel";
import { chaseOpen } from "../chase/chase";
import { ExportPanel } from "./ExportPanel";
import { exportOpen } from "../export/export";
import { NotifyPanel, notifyOpen } from "./NotifyPanel";
import { StatsPanel } from "./StatsPanel";
import { camPanels } from "./CameraPanels";
import { pinMetar } from "./MetarPanels";
import { playStream } from "../radio";
import { startAlerts } from "../alerts";
import { api } from "../api";
import { activeServer } from "../store";
import "../winsync";
import { AlertDetail, AD_ID } from "./AlertDetail"; // 0.8.3
import { details } from "../store";
import "./WinDrop"; // 0.8.3: drag pop-outs back in
import "./winkeys"; // 0.8.3: shortcuts in pop-outs
import { Toasts } from "./Overlays"; // 0.8.2 integration: toasts (installs, capture copied, …) in pop-outs too

type Sig = { value: boolean };
const flag = (id: string, title: string, s: Sig, render: () => any, w = 1100, h = 760): Popper => ({
  id,
  title,
  w,
  h,
  isOpen: () => s.value,
  open: () => (s.value = true),
  close: () => (s.value = false),
  render,
});

/* rail tabs (side panels) */
const PANELS = Object.keys(PANEL_TITLES).filter((k) => k !== "sources");
for (const k of PANELS)
  registerPopper({
    id: `p:${k}`,
    title: PANEL_TITLES[k],
    w: 400,
    h: 760,
    isOpen: () => openPanel.value != null,
    open: () => (openPanel.value = k as PanelId),
    close: () => openPanel.peek() === k && (openPanel.value = null),
    render: () => <SidePanel />,
  });

/* centre windows */
registerPopper(flag("c:fcc", "Forecast", forecastOpen, () => <ForecastCenter />));
registerPopper({
  // the weather radio has its own pop-out page (players, scanner)
  ...flag("c:rc", "Weather radio", radioOpen, () => null),
  spec: () => ({ kind: "radiocenter", title: "Weather radio", width: 1040, height: 720 }),
});
registerPopper(flag("c:sk", "Seismographs", shakeOpen, () => <ShakeMenu />));
registerPopper({
  id: "c:snd",
  title: "Sounding",
  w: 1100,
  h: 780,
  isOpen: () => soundingReq.value != null,
  open: (a) => a && (soundingReq.value = a),
  close: () => (soundingReq.value = null),
  arg: () => soundingReq.peek(),
  render: () => <SoundingCenter />,
});
registerPopper(flag("c:d6-space", "Space weather", spaceOpen, () => <SpacePanel />));
registerPopper(flag("c:hstorm", "Historical Storms", histStormsOpen, () => <HistStorms />));
registerPopper(flag("c:mlcenter", "Detection models", mlOpen, () => <ModelsCenter />, 1200, 800));
registerPopper(flag("c:dash", "My dashboard", dashOpen, () => <Dashboard />));
registerPopper(flag("c:atl", "Alert timeline", timelineOpen, () => <AlertTimeline />));
registerPopper(flag("c:ss", "Server settings", serverSettingsOpen, () => <ServerSettings />, 900, 720));

/* layer settings windows */
registerPopper({
  id: "o:cfg",
  title: "Layer settings",
  w: 460,
  h: 640,
  isOpen: () => configModal.value != null,
  open: (a) => a && (configModal.value = a),
  close: () => (configModal.value = null),
  arg: () => configModal.peek(),
  render: () => <ConfigModal />,
});

/* floating panels */
registerPopper(flag("f:p8-chase", "Chaser toolkit", chaseOpen, () => <ChaserPanel />, 420, 640));
registerPopper(flag("f:p8-export", "Export data", exportOpen, () => <ExportPanel />, 440, 640));
registerPopper(flag("f:p8-notify", "Notifications", notifyOpen, () => <NotifyPanel />, 460, 640));
registerPopper({
  // stats: open/closed lives in settings (synced), so the main window only hides it while it's out
  id: "s:stats",
  title: "Stats",
  w: 300,
  h: 520,
  hideWhenPopped: true,
  isOpen: () => !!settings.value.panels.stats?.open || !!settings.value.panels.appstats?.open,
  open: () => {},
  close: () => {},
  render: () => <StatsPanel />,
});
/* 0.8.3: the alert info panel */
registerPopper({
  id: AD_ID,
  title: "Alert",
  w: 440,
  h: 720,
  isOpen: () => details.value != null,
  open: (a) => a?.items?.length && (details.value = a),
  close: () => (details.value = null),
  arg: () => details.peek(),
  render: () => <AlertDetail />,
});
/* older pop-out kinds (camera, METAR, radio stream): only "dock back" goes through here */
const none = { isOpen: () => true, close: () => {}, render: () => null };
registerPopper({ id: "cam", title: "Camera", ...none, open: (c) => c?.id && !camPanels.peek().some((x) => x.id === c.id) && (camPanels.value = [...camPanels.peek(), { ...c, x: 90, y: 80 }]) });
registerPopper({ id: "metar", title: "METAR", ...none, open: (a) => a?.id && pinMetar(a.id) });
registerPopper({ id: "radio", title: "Weather radio", ...none, open: (s) => s && playStream(s) });

/* ---------- the pop-out page ---------- */

class Boundary extends Component<{ children: any }, { err: string | null }> {
  state = { err: null as string | null };
  componentDidCatch(e: any) {
    this.setState({ err: String(e?.message ?? e) });
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div class="wf-poperr">
        <p>This window can't run on its own.</p>
        <small class="muted">{this.state.err}</small>
        <div>
          <button class="btn sm" onClick={dockBack}>
            Dock back
          </button>
          <button class="btn sm ghost" onClick={() => osCtl("close")}>
            Close
          </button>
        </div>
      </div>
    );
  }
}

/** a "win" pop-out: one window, filling the OS window */
export function PopWin({ id, arg }: { id: string; arg?: any }) {
  const p = POPPERS.get(id);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    api.configure(activeServer.value);
    startAlerts(); // alert lists / timelines (pop-outs don't notify)
    p?.open(arg);
    setReady(true);
  }, []);
  const open = ready && p ? p.isOpen() : true;
  useEffect(() => {
    // closed from inside (its own close button, a setting from the main window): close the OS window
    if (ready && !open) osCtl("close");
  }, [ready, open]);
  if (!p) return <div class="wf-poperr">Unknown window</div>;
  if (!ready) return null;
  return (
    <div class={`popout popout-win popout-${id.replace(/[^a-z0-9-]/gi, "_")}`}>
      <Boundary>{p.render()}</Boundary>
      <Toasts />
    </div>
  );
}
