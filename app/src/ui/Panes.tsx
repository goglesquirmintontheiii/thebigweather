// Multi-pane layout: the main map plus up to three extra panes, and the layout picker.

import { useEffect, useRef, useState } from "preact/hooks";
import { settings, update, openPanel, type PaneCfg } from "../store";
import { mountPane, paneConfigured, paneStatus, resizePanes } from "../map/panes";
import { L2_MOMENTS, l3Products, sites } from "../radar/controller";
import { gridLayers, GIBS, selectWeather } from "../weather";
import { fmtTime } from "../util";
import { LayoutGrid, Columns2, Rows2, Square, Grid2x2, Link2, Link2Off, AppWindow, MonitorSmartphone } from "lucide-preact";
import { popout, canPopout } from "../popout";
import { mapRef } from "../map/mapview";
import { linkOn, linkLayers, peers, isSecondWindow, setLink } from "../linkwin";

/** Product dropdown options: Level II moments, Level III families (for the site's radar type), gridded layers. */
function ProductOptions({ site, current }: { site: string; current?: string }) {
  const tdwr = sites.value.find((x) => x.id === site)?.type === "TDWR";
  const l3 = l3Products.value.filter((p) => !!p.tdwr === tdwr);
  const cur = l3Products.value.find((p) => p.id === current);
  const fams = new Map<string, typeof l3>();
  for (const p of l3) {
    const k = `${p.code}|${p.name}`;
    fams.set(k, [...(fams.get(k) ?? []), p].sort((a, b) => a.tilt - b.tilt));
  }
  const groups = [...new Set(gridLayers.value.map((l) => l.group))];
  return (
    <>
      <optgroup label={`Level II · ${site}`}>
        {L2_MOMENTS.map((m, i) => (
          <option key={m.id} value={`r:L2:${m.id}`}>
            {m.name}
            {i < 6 ? `  (${i + 1})` : ""}
          </option>
        ))}
      </optgroup>
      {fams.size > 0 && (
        <optgroup label={`Level III · ${site}`}>
          {[...fams.values()].map((f) => {
            const pick = f.find((p) => p.id === current) ?? f.find((p) => p.tilt === cur?.tilt) ?? f[0];
            return (
              <option key={pick.id} value={`r:L3:${pick.id}`}>
                {f[0].name}
                {f.length > 1 ? ` ${pick.tilt.toFixed(1)}°` : ""}
              </option>
            );
          })}
        </optgroup>
      )}
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
    </>
  );
}

/** Link toggle for a second map window (shown when another map window is open). */
function LinkControls() {
  if (!(peers.value > 0 || isSecondWindow || linkOn.value)) return null;
  return (
    <>
      <button class={`ph-btn ${linkOn.value ? "on" : ""}`} title={linkOn.value ? "Linked with the other window: view, time, radar site (click to unlink)" : "Link with the other map window (view, time, radar site)"} onClick={() => setLink(!linkOn.value)}>
        {linkOn.value ? <Link2 size={13} /> : <Link2Off size={13} />}
        <span>Link</span>
      </button>
      {linkOn.value && (
        <label class="ph-chk" title="Also sync overlay layers (Layers menu)">
          <input type="checkbox" checked={linkLayers.value} onChange={(e) => setLink(true, (e.target as HTMLInputElement).checked)} />
          Sync layers
        </label>
      )}
    </>
  );
}

/** Publish the header's bottom edge as --hdr-b so the pane dropdowns and the scan bar sit just
 * below it (the header wraps on narrow windows), and slide the header right when the side panel
 * would cover its left end (narrow windows with a panel open). */
function useHeaderVar() {
  const panel = openPanel.value;
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".topbar");
    if (!el) return;
    let busy = false;
    const upd = () => {
      if (busy) return;
      busy = true;
      const sp = document.querySelector(".side-panel");
      const pr = sp ? sp.getBoundingClientRect().right + 10 : 0;
      el.style.left = "";
      el.style.maxWidth = "";
      const w = el.offsetWidth;
      const cx = window.innerWidth / 2;
      if (pr && cx - w / 2 < pr) {
        el.style.maxWidth = `${Math.max(320, window.innerWidth - pr - 12)}px`;
        el.style.left = `${pr + el.offsetWidth / 2}px`;
      }
      document.documentElement.style.setProperty("--hdr-b", `${Math.round(el.getBoundingClientRect().bottom + 6)}px`);
      requestAnimationFrame(() => (busy = false));
    };
    upd();
    const t = setTimeout(upd, 250); // after the panel's open animation
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    window.addEventListener("resize", upd);
    return () => (clearTimeout(t), ro.disconnect(), window.removeEventListener("resize", upd));
  }, [panel]);
}

/** Product dropdown for the main map (top-centre of its pane, just below the header). */
export function MainPaneHead() {
  const s = settings.value;
  const w = s.weather;
  const value = w.kind === "radar" ? `r:${s.radar.source}:${s.radar.product}` : w.kind === "grid" ? `g:${w.id}` : `x:${w.id}`;
  const pick = (v: string) => {
    if (v.startsWith("g:")) return selectWeather({ kind: "grid", id: v.slice(2) });
    if (!v.startsWith("r:")) return;
    const [, src, prod] = v.split(":");
    update((x) => {
      x.weather = { kind: "radar" };
      x.radar.source = src as "L2" | "L3";
      x.radar.product = prod;
    });
  };
  return (
    <div class={`pane-head main-head glass ${openPanel.value ? "shift" : ""}`}>
      <select value={value} onChange={(e) => pick((e.target as HTMLSelectElement).value)} title="Product (1–6 for Level II)">
        {w.kind === "gibs" && <option value={value}>{GIBS.find((g) => g.id === w.id)?.name ?? w.id}</option>}
        <ProductOptions site={s.radar.site} current={s.radar.product} />
      </select>
      <LinkControls />
    </div>
  );
}

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
  const value = cfg.weather.kind === "grid" ? `g:${cfg.weather.id}` : `r:${cfg.source ?? "L2"}:${cfg.product ?? "REF"}`;
  const set = (v: string) => {
    const [, src, prod] = v.split(":");
    const next: PaneCfg = v.startsWith("g:") ? { weather: { kind: "grid", id: v.slice(2) } } : { weather: { kind: "radar" }, source: src as "L2" | "L3", product: prod, tilt: settings.value.radar.tiltAngle, site: cfg.site };
    update((s) => {
      while (s.panes.list.length < idx) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
      s.panes.list[idx - 1] = next;
    });
    paneConfigured(idx, next);
  };
  return (
    <div class="pane">
      <div ref={ref} class="pane-map" />
      <div class="pane-head glass">
        <select value={value} onChange={(e) => set((e.target as HTMLSelectElement).value)} title="Product for this pane">
          <ProductOptions site={cfg.site ?? settings.value.radar.site} current={cfg.product} />
        </select>
        <span class="pane-time" title={st.error ?? ""}>{st.loading ? "Loading…" : st.error ? st.error : st.time ? fmtTime(st.time, true) : ""}</span>
      </div>
    </div>
  );
}

/** The main map element plus extra panes in a grid. */
export function PaneGrid({ mapEl }: { mapEl: any }) {
  const layout = settings.value.panes.layout;
  const n = PANE_COUNT[layout] ?? 0;
  useHeaderVar();
  useEffect(() => {
    // make sure every pane has a config
    if (settings.value.panes.list.length < n) update((s) => {
      while (s.panes.list.length < n) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
    });
    const t = setTimeout(resizePanes, 30);
    return () => clearTimeout(t);
  }, [layout]);
  return (
    <div class={`panes layout-${layout} ${openPanel.value ? "panel-open" : ""}`}>
      <div class="pane main">
        <div ref={mapEl} class="map" />
        <MainPaneHead />
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
          {(peers.value > 0 || linkOn.value) && (
            <button class={`tb sm ${linkOn.value ? "on" : ""}`} title={linkOn.value ? "Map windows linked (click to unlink)" : "Link the other map window: view, time, radar site"} onClick={() => setLink(!linkOn.value)}>
              <MonitorSmartphone size={16} />
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
