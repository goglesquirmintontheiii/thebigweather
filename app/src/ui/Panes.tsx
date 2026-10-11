// Multi-pane layout: the main map plus up to three extra panes, and the layout picker.

import { useEffect, useRef, useState } from "preact/hooks";
import { settings, update, type PaneCfg } from "../store";
import { mountPane, paneConfigured, paneStatus, resizePanes } from "../map/panes";
import { L2_MOMENTS } from "../radar/controller";
import { gridLayers } from "../weather";
import { fmtTime } from "../util";
import { LayoutGrid, Columns2, Rows2, Square, Grid2x2, Link2, Link2Off, AppWindow } from "lucide-preact";
import { popout, canPopout } from "../popout";
import { mapRef } from "../map/mapview";

export const PANE_COUNT: Record<string, number> = { "1": 0, "2": 1, "2v": 1, "3": 2, "4": 3 };

function defaultCfg(i: number): PaneCfg {
  const second = ["VEL", "ZDR", "RHO"][i - 1] ?? "VEL";
  return { weather: { kind: "radar" }, product: second, source: "L2", tilt: 0.5 };
}

function PaneBox({ idx }: { idx: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => mountPane(idx, ref.current!), [idx]);
  const cfg = settings.value.panes.list[idx - 1] ?? defaultCfg(idx);
  const st = paneStatus.value[idx] ?? {};
  const value = cfg.weather.kind === "grid" ? `g:${cfg.weather.id}` : `r:${cfg.product ?? "REF"}`;
  const set = (v: string) => {
    const next: PaneCfg = v.startsWith("g:") ? { weather: { kind: "grid", id: v.slice(2) } } : { weather: { kind: "radar" }, source: "L2", product: v.slice(2), tilt: settings.value.radar.tiltAngle };
    update((s) => {
      while (s.panes.list.length < idx) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
      s.panes.list[idx - 1] = next;
    });
    paneConfigured(idx, next);
  };
  const groups = [...new Set(gridLayers.value.map((l) => l.group))];
  return (
    <div class="pane">
      <div ref={ref} class="pane-map" />
      <div class="pane-head glass">
        <select value={value} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
          <optgroup label={`Radar · ${settings.value.radar.site}`}>
            {L2_MOMENTS.map((m) => (
              <option key={m.id} value={`r:${m.id}`}>
                {m.name}
              </option>
            ))}
          </optgroup>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {gridLayers.value
                .filter((l) => l.group === g)
                .map((l) => (
                  <option key={l.id} value={`g:${l.id}`}>
                    {l.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <span class="pane-time">{st.loading ? "Loading…" : st.error ? st.error : st.time ? fmtTime(st.time, true) : ""}</span>
      </div>
    </div>
  );
}

/** The main map element plus extra panes in a grid. */
export function PaneGrid({ mapEl }: { mapEl: any }) {
  const layout = settings.value.panes.layout;
  const n = PANE_COUNT[layout] ?? 0;
  useEffect(() => {
    // make sure every pane has a config
    if (settings.value.panes.list.length < n) update((s) => {
      while (s.panes.list.length < n) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
    });
    const t = setTimeout(resizePanes, 30);
    return () => clearTimeout(t);
  }, [layout]);
  return (
    <div class={`panes layout-${layout}`}>
      <div class="pane main">
        <div ref={mapEl} class="map" />
      </div>
      {Array.from({ length: n }, (_, i) => (
        <PaneBox key={`${layout}-${i + 1}`} idx={i + 1} />
      ))}
    </div>
  );
}

const LAYOUTS: [PaneCfgLayout, any, string][] = [
  ["1", Square, "One map"],
  ["2", Columns2, "Two side by side"],
  ["2v", Rows2, "Two stacked"],
  ["3", LayoutGrid, "Three"],
  ["4", Grid2x2, "Four"],
];
type PaneCfgLayout = "1" | "2" | "2v" | "3" | "4";

export function PaneButton() {
  const [open, setOpen] = useState(false);
  const p = settings.value.panes;
  const Icon = LAYOUTS.find((l) => l[0] === p.layout)?.[1] ?? Square;
  return (
    <div class="pane-btn-wrap">
      {open && (
        <div class="pane-pop glass">
          {LAYOUTS.map(([k, I, t]) => (
            <button key={k} class={`tb sm ${p.layout === k ? "on" : ""}`} title={t} onClick={() => (update((s) => (s.panes.layout = k)), setOpen(false))}>
              <I size={16} />
            </button>
          ))}
          <span class="tl-sep" />
          {canPopout() && (
            <button
              class="tb sm"
              title="Open another map window (its own layers; good for a second monitor)"
              onClick={() => {
                const m = mapRef.value;
                const c = m?.getCenter();
                popout({ kind: "map", title: "TheBigWeather · map", width: 1100, height: 750, data: { view: { center: c ? [c.lng, c.lat] : settings.value.view.center, zoom: m?.getZoom() ?? 6 }, panes: { layout: "1", sync: true, list: [] } } });
                setOpen(false);
              }}
            >
              <AppWindow size={16} />
            </button>
          )}
          <button class={`tb sm ${p.sync ? "on" : ""}`} title={p.sync ? "Panes move together (click to unlink)" : "Panes move on their own (click to link)"} onClick={() => update((s) => (s.panes.sync = !s.panes.sync))}>
            {p.sync ? <Link2 size={16} /> : <Link2Off size={16} />}
          </button>
        </div>
      )}
      <button class={`tb ${p.layout !== "1" ? "on" : ""}`} title="Map panes (dual / quad)" onClick={() => setOpen(!open)}>
        <Icon size={19} />
      </button>
    </div>
  );
}
