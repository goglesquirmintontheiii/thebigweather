// 0.8.4: the warning for using something whose data source is switched off, and the watcher
// that raises it when the selected weather layer or basemap needs a disabled source.

import { effect } from "@preact/signals";
import { X } from "lucide-preact";
import { settings } from "../store";
import { dismissDsWarning, dsOff, dsWarning, warnDisabled } from "../datasrc";
import { basemapSource, intlDataSource } from "../datasrcCore";
import { gridDef, GIBS } from "../weather";
import { currentSite } from "../radar/controller";
import { jumpToSetting } from "../a11y/jump";

/** which toggle the selected weather layer needs */
function weatherSource(): string | null {
  const s = settings.value;
  const w = s.weather;
  if (w.kind === "radar") {
    const site: any = currentSite.value;
    if (site?.type === "ODIM") return String(site.source ?? "").startsWith("fmi") ? "fmi" : "opera";
    return s.radar.source === "L3" ? "nexrad-l3" : "nexrad-l2";
  }
  if (w.kind === "grid") return (gridDef(w.id) as any)?.ds ?? null;
  if (w.kind === "intl") return intlDataSource(w.id);
  const g = GIBS.find((x) => x.id === w.id);
  return g ? (g.wms ? "eumetview" : "gibs") : null;
}

effect(() => {
  const off = dsOff.value;
  const s = settings.value;
  const ws = weatherSource();
  if (ws && off.has(ws)) warnDisabled(ws, "weather layer");
  const bs = basemapSource(s.basemap, s.basemapProvider);
  if (bs && off.has(bs)) warnDisabled(bs, "basemap");
});

export function DataSourceWarning() {
  const w = dsWarning.value;
  if (!w) return null;
  return (
    <div class="ds-warn glass" role="alert" title={w.name}>
      <span>
        {w.text}{" "}
        <button
          class="linklike"
          onClick={() => {
            dismissDsWarning();
            jumpToSetting(`ds-${w.id}`);
          }}
        >
          Enable it here
        </button>{" "}
        to use it.
      </span>
      <button class="icon-btn" title="Dismiss" onClick={dismissDsWarning}>
        <X size={13} />
      </button>
    </div>
  );
}
