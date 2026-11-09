// 0.8.3 plugins: sidebar (rail) buttons that plugins add — one per plugin panel (addPanel) and any
// tbw.addRailButton(). A panel's button opens it again after it was closed (and closes it when open).
// Right-click: open the plugin in the Plugins tab.

import { useState } from "preact/hooks";
import { Puzzle } from "lucide-preact";
import { pluginRail, isPanelOpen, type PluginRailButton } from "./host";
import { installedMeta } from "./market";
import { visibleRail } from "./marketcore";
import { settings } from "../store";
import { winAware } from "../ui/winframe";
import { isMin, isPopped } from "../ui/winframe";
import { openPanel } from "../store";
import { pluginDetail, pluginsTab } from "./PluginsPanel";

function Img({ src }: { src?: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img class="plg-rail-img" src={src} alt="" onError={() => setBad(true)} /> : <Puzzle size={20} />;
}

export function PluginRailButtons() {
  const list = visibleRail(pluginRail.value, settings.value.wf6.plugins);
  if (!list.length) return null;
  const meta = installedMeta.value;
  return (
    <>
      <div class="rail-sep plg-rail-sep" />
      {list.map((b: PluginRailButton) => {
        const wid = b.panel ? `f:plg:${b.panel}` : "";
        const away = !!wid && (isMin(wid) || isPopped(wid));
        const on = b.panel ? isPanelOpen(b.panel) && !isMin(wid) : !!b.on?.();
        return (
          <button
            key={b.id}
            class={`rail-btn plg-rail-btn ${on ? "on" : ""}${away ? " wf-away" : ""}`}
            title={`${b.title}${b.panel ? (on ? " (close)" : " (open)") : ""}`}
            aria-label={b.title}
            onClick={wid ? winAware(wid, b.click) : b.click}
            onContextMenu={(e) => {
              e.preventDefault();
              pluginsTab.value = "installed";
              pluginDetail.value = { id: b.pid };
              openPanel.value = "plugins";
            }}
          >
            <Img src={b.icon ?? meta[b.pid]?.icon} />
          </button>
        );
      })}
    </>
  );
}
