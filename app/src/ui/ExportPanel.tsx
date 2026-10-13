// data 0.8: "Export data" panel — the weather layer on screen (gridded frame → CSV / GeoJSON /
// NetCDF, Level II sweep → NetCDF), visible overlays (CSV / GeoJSON / KML) and charts / the
// cross-section as images. Opened from Toolbar → … and from a layer's settings window.

import { useEffect, useState } from "preact/hooks";
import { FileDown, Image as ImageIcon, RefreshCw } from "lucide-preact";
import { settings } from "../store";
import { FloatPanel } from "./FloatPanel";
import { OVERLAYS, overlayDef } from "../overlays/defs";
import { exportOpen, exportFocus, exportBusy, exportOverlay, exportGrid, exportRadarNc, gridFrameNow, radarSweepNow, canvasItems, exportCanvas, type CanvasItem } from "../export/export";
import { gridDef } from "../weather";
import { fmtTime } from "../util";

export function ExportPanel() {
  if (!exportOpen.value) return null;
  return (
    <FloatPanel title={<><FileDown size={14} /> Export data</>} x={Math.max(16, window.innerWidth / 2 - 210)} y={90} w={420} cls="p8-export" onClose={() => ((exportOpen.value = false), (exportFocus.value = null))}>
      <Body />
    </FloatPanel>
  );
}

function Body() {
  const [via, setVia] = useState<"client" | "server">("client");
  const [area, setArea] = useState<"view" | "full">("view");
  const [items, setItems] = useState<CanvasItem[]>([]);
  const refresh = () => setItems(canvasItems());
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);
  const w = settings.value.weather;
  const g = gridFrameNow();
  const r = radarSweepNow();
  const focus = exportFocus.value;
  const ovs = OVERLAYS.filter((d) => settings.value.ovl[d.id]?.on && !d.raster && !d.hidden);
  if (focus && !ovs.some((d) => d.id === focus) && overlayDef(focus)) ovs.unshift(overlayDef(focus)!);
  const busy = exportBusy.value;
  return (
    <div class="p8-export-body">
      {busy && <div class="p8-busy small">Exporting {busy}…</div>}
      <section>
        <label class="lbl">Weather layer on screen</label>
        {w.kind === "grid" && g && (
          <>
            <div class="small">
              <b>{g.name}</b> <span class="muted">· {fmtTime(g.time, true)}{gridDef(g.layer)?.units ? ` · ${gridDef(g.layer)!.units}` : ""}</span>
            </div>
            <div class="row">
              <div class="seg sm">
                <button class={area === "view" ? "on" : ""} onClick={() => setArea("view")}>
                  Map view
                </button>
                <button class={area === "full" ? "on" : ""} onClick={() => setArea("full")}>
                  Whole grid
                </button>
              </div>
              <button class="btn sm" disabled={!!busy} onClick={() => exportGrid("csv", area)}>
                CSV
              </button>
              <button class="btn sm" disabled={!!busy} onClick={() => exportGrid("geojson", area)}>
                GeoJSON
              </button>
              <button class="btn sm" disabled={!!busy} onClick={() => exportGrid("nc", area)}>
                NetCDF
              </button>
            </div>
            <div class="muted small">The frame on the timeline, at the grid's native resolution (server export). CSV = lat, lon, value rows.</div>
          </>
        )}
        {w.kind === "radar" && (
          <>
            {r ? (
              <div class="small">
                <b>
                  {r.site} {r.moment}
                </b>{" "}
                <span class="muted">
                  · {r.elev.toFixed(1)}° · {fmtTime(r.time, true)}
                </span>
              </div>
            ) : (
              <div class="muted small">{settings.value.radar.source === "L3" ? "Level III products: export the sweep from Level II instead." : "No Level II sweep loaded yet."}</div>
            )}
            <div class="row">
              <button class="btn sm" disabled={!r || !!busy} onClick={exportRadarNc}>
                Sweep → NetCDF
              </button>
            </div>
            <div class="muted small">CF-style polar sweep (azimuth × range) of the tilt and moment on screen.</div>
          </>
        )}
        {(w.kind === "gibs" || w.kind === "intl") && <div class="muted small">Image-only layers have no values to export — use the screenshot button.</div>}
      </section>
      <section>
        <div class="row">
          <label class="lbl">Overlays</label>
          <div class="seg sm" title="Convert the loaded data here, or ask the server for its own CSV / KML">
            <button class={via === "client" ? "on" : ""} onClick={() => setVia("client")}>
              From map
            </button>
            <button class={via === "server" ? "on" : ""} onClick={() => setVia("server")}>
              From server
            </button>
          </div>
        </div>
        {!ovs.length && <div class="muted small">Turn on an overlay to export it.</div>}
        <div class="p8-ovl-list">
          {ovs.map((d) => (
            <div key={d.id} class={`p8-ovl-row ${focus === d.id ? "focus" : ""}`}>
              <span>{d.name}</span>
              {(["csv", "geojson", "kml"] as const).map((f) => (
                <button key={f} class="btn xs ghost" disabled={!!busy} onClick={() => exportOverlay(d.id, f, via)}>
                  {f === "geojson" ? "GeoJSON" : f.toUpperCase()}
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section>
        <div class="row">
          <label class="lbl">
            <ImageIcon size={11} /> Charts & cross-section
          </label>
          <button class="icon-btn" title="Look again for charts on screen" onClick={refresh}>
            <RefreshCw size={12} />
          </button>
        </div>
        {!items.length && <div class="muted small">Open a cross-section, the forecast window (Models / confidence charts) or a sounding to export it.</div>}
        <div class="p8-ovl-list">
          {items.map((it) => (
            <div key={it.id} class="p8-ovl-row">
              <span>{it.name}</span>
              <button class="btn xs ghost" onClick={() => exportCanvas(it, "png")}>
                PNG
              </button>
              <button class="btn xs ghost" disabled={!it.svg} title={it.svg ? "Vector (re-drawn)" : "PNG only for this item"} onClick={() => exportCanvas(it, "svg")}>
                SVG
              </button>
            </div>
          ))}
        </div>
        <div class="muted small">Forecast charts export as SVG (re-drawn as vectors); the cross-section and Skew-T are PNG only (raster images).</div>
      </section>
    </div>
  );
}
