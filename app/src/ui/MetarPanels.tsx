// Pinned METAR panels: decoded observation + wind compass + sky, draggable, several at once,
// auto-refreshing (one shared fetch for all pins), and a pop-out like the camera viewer.

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { settings, toast } from "../store";
import { FloatPanel } from "./FloatPanel";
import { WindCompass, SkyGraph } from "./OverlayPopup";
import { popout, canPopout } from "../popout";
import { fmtAge } from "../util";
import { PictureInPicture2, RefreshCw } from "lucide-preact";

export const metarPins = signal<{ id: string; x: number; y: number }[]>([]);
const obs = signal<Record<string, any>>({});
const lastFetch = signal(0);
const REFRESH_MS = 120_000;

export function pinMetar(id: string) {
  if (!id) return;
  if (metarPins.value.some((p) => p.id === id)) return;
  const n = metarPins.value.length;
  metarPins.value = [...metarPins.value, { id, x: Math.max(8, Math.min(window.innerWidth - 440, 420 + ((n * 440) % 960))), y: 80 + ((n * 40) % 200) }];
  refreshMetars();
}

let busy = false;
export async function refreshMetars() {
  if (busy || !api.base) return;
  busy = true;
  try {
    const fc = await api.get("/api/ovl/metar");
    const out: Record<string, any> = {};
    const want = new Set([...metarPins.value.map((p) => p.id), ...popId]);
    for (const f of fc.features ?? []) if (want.has(f.properties?.id)) out[f.properties.id] = { ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    obs.value = out;
    lastFetch.value = Date.now();
  } catch (e: any) {
    toast(`METAR refresh failed: ${e.message}`, "warn");
  } finally {
    busy = false;
  }
}
/** a pop-out window shows this station */
const popId: string[] = [];

setInterval(() => {
  if ((metarPins.value.length || popId.length) && !(settings.value.saver && document.hidden)) refreshMetars();
}, REFRESH_MS);

const fmtT = (c: number | null | undefined) => (c == null ? "—" : settings.value.units.temp === "F" ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`);
function rh(t: number, td: number) {
  const e = (x: number) => Math.exp((17.625 * x) / (243.04 + x));
  return Math.round((100 * e(td)) / e(t));
}

function MetarBody({ id }: { id: string }) {
  const p = obs.value[id];
  void lastFetch.value;
  if (!p) return <div class="muted small">{lastFetch.value ? `No current report for ${id}` : "Loading…"}</div>;
  const rows: [string, string][] = [
    ["Temp / dew", `${fmtT(p.t)} / ${fmtT(p.td)}`],
    ["Humidity", p.t != null && p.td != null ? `${rh(p.t, p.td)}%` : "—"],
    ["Visibility", p.vis != null ? (settings.value.units.distance === "km" ? `${p.vis.toFixed(1)} km` : `${(p.vis / 1.609).toFixed(1)} mi`) : "—"],
    ["Altimeter", p.alt != null ? `${(p.alt / 33.8639).toFixed(2)} inHg · ${Math.round(p.alt)} mb` : "—"],
    ["Category", p.cat || "—"],
    ["Observed", p.time ? fmtAge(typeof p.time === "number" ? p.time : Date.parse(p.time)) : "—"],
  ];
  return (
    <div class="metar-pin">
      <div class="metar-viz">
        <WindCompass wd={p.wd} ws={p.ws} wg={p.wg} />
        {p.raw && <SkyGraph raw={p.raw} />}
      </div>
      <div class="pop-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      {p.raw && <pre class="pop-raw">{p.raw}</pre>}
    </div>
  );
}

const CAT: Record<string, string> = { VFR: "#22c55e", MVFR: "#3b82f6", IFR: "#ef4444", LIFR: "#d946ef" };

export function MetarPanels() {
  const pins = metarPins.value;
  if (!pins.length) return null;
  const close = (id: string) => (metarPins.value = metarPins.value.filter((p) => p.id !== id));
  return (
    <>
      {pins.map((pin) => {
        const p = obs.value[pin.id];
        return (
          <FloatPanel
            key={pin.id}
            cls="metar-panel"
            w={420}
            x={pin.x}
            y={pin.y}
            onClose={() => close(pin.id)}
            title={
              <>
                {p?.cat && <i class="cat-dot" style={{ background: CAT[p.cat] ?? "#94a3b8" }} />}
                {pin.id}
              </>
            }
            tools={
              <>
                <button class="icon-btn" title="Refresh" onClick={refreshMetars}>
                  <RefreshCw size={13} />
                </button>
                {canPopout() && (
                  <button class="icon-btn" title="Pop out to its own window" onClick={() => (popout({ kind: "metar", title: `METAR ${pin.id}`, width: 440, height: 600, data: { id: pin.id } }), close(pin.id))}>
                    <PictureInPicture2 size={13} />
                  </button>
                )}
              </>
            }
          >
            <MetarBody id={pin.id} />
          </FloatPanel>
        );
      })}
    </>
  );
}

/** a METAR filling a pop-out window */
export function MetarFull({ id }: { id: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!popId.includes(id)) popId.push(id);
    refreshMetars().then(() => tick((x) => x + 1));
  }, [id]);
  return (
    <div class="metar-full glass">
      <h3>{id}</h3>
      <MetarBody id={id} />
    </div>
  );
}
