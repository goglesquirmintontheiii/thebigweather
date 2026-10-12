// Storm-relative velocity control: shown above the toolbar while Level II velocity is on screen.

import { settings, update } from "../store";
import { srvAvailable, srvMotion, autoMotion, srvPicking, srvPickAt } from "../radar/srv";
import { mapRef, mapClickHooks } from "../map/mapview";
import { compass, speedFactor } from "../util";
import { Crosshair } from "lucide-preact";

mapClickHooks.push((e) => {
  if (!srvPicking.value) return false;
  const m = mapRef.value!;
  const mpp = (40075016.686 * Math.cos((e.lngLat.lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom());
  return srvPickAt(e.lngLat.lat, e.lngLat.lng, 1 / mpp);
});

export function SrvControl() {
  if (!srvAvailable.value) return null;
  const s = settings.value.srv;
  const m = srvMotion.value;
  const a = autoMotion.value;
  const f = speedFactor();
  const u = settings.value.units.speed;
  const set = (p: Partial<typeof s>) => update((x) => (x.srv = { ...x.srv, ...p }));
  return (
    <div class={`srv-ctl glass ${s.on ? "on" : ""}`}>
      <button class={`chip ${s.on ? "on" : ""}`} title="Storm-relative velocity" onClick={() => set({ on: !s.on })}>
        SRV
      </button>
      {s.on && (
        <>
          <div class="seg sm">
            {(["auto", "cell", "manual"] as const).map((k) => (
              <button key={k} class={s.mode === k ? "on" : ""} onClick={() => set({ mode: k })}>
                {k === "auto" ? "Auto" : k === "cell" ? "Cell" : "Manual"}
              </button>
            ))}
          </div>
          {s.mode === "cell" && (
            <button class={`icon-btn ${srvPicking.value ? "on" : ""}`} title="Click a storm cell to use its motion" onClick={() => (srvPicking.value = !srvPicking.value)}>
              <Crosshair size={14} />
            </button>
          )}
          {s.mode !== "auto" ? (
            <>
              <label title="Direction the storm moves toward">
                <input type="number" min={0} max={359} step={5} value={s.dir} onInput={(e) => set({ dir: ((+(e.target as HTMLInputElement).value % 360) + 360) % 360, mode: "manual" })} />°
              </label>
              <label>
                <input type="number" min={0} max={200} step={1} value={Math.round(s.speed * f)} onInput={(e) => set({ speed: +(e.target as HTMLInputElement).value / f, mode: "manual" })} /> {u}
              </label>
            </>
          ) : (
            <span class="muted small">{a ? `mean of ${a.n} cells` : "no cell tracks · using manual"}</span>
          )}
          {m && (
            <span class="srv-arrow" title="Storm motion">
              <i style={{ transform: `rotate(${m.dir}deg)` }}>↑</i> {compass(m.dir)} {Math.round(m.speed * f)} {u}
            </span>
          )}
          {srvPicking.value && <span class="muted small">Click a cell…</span>}
        </>
      )}
    </div>
  );
}
