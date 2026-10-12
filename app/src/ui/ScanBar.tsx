// "Rotation scan" bar under the header: scan every US radar for tornadic rotation or supercells.

import { useEffect, useState } from "preact/hooks";
import { settings } from "../store";
import { mapRef } from "../map/mapview";
import { scanMode, scanHits, scanState, runScan, clearScan, goToHit, type ScanMode } from "../overlays/rotation";
import { distance, fmtDist } from "../util";
import { Tornado, CloudLightning, ChevronDown, X, Loader, AlertTriangle } from "lucide-preact";

/** follow the header's height (it wraps on narrow windows) */
function useHeaderBottom() {
  const [y, setY] = useState(62);
  useEffect(() => {
    const el = document.querySelector(".topbar");
    if (!el) return;
    const upd = () => setY(Math.round(el.getBoundingClientRect().bottom + 6));
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return y;
}

/** re-render when the map stops moving (distances are from the map center) */
function useMapCenter() {
  const [, set] = useState(0);
  useEffect(() => {
    const m = mapRef.value;
    if (!m) return;
    const f = () => set((n) => n + 1);
    m.on("moveend", f);
    return () => void m.off("moveend", f);
  }, [mapRef.value]);
  return mapRef.value?.getCenter();
}

export function ScanBar() {
  const show = !!settings.value.ovl.rotscan?.on;
  const top = useHeaderBottom();
  const [open, setOpen] = useState(false);
  const c = useMapCenter();
  if (!show) return null;
  const mode = scanMode.value;
  const st = scanState.value;
  const hits = scanHits.value;
  const btn = (m: ScanMode, label: string, Icon: any) => (
    <button class={`scan-btn ${m} ${mode === m ? "on" : ""}`} onClick={() => (runScan(m), setOpen(true))} disabled={st.busy && mode === m} title={m === "tor" ? "TVS, or mesocyclone strength rank 10+" : "Mesocyclone (rank 5+) with ≥ 50 dBZ, POSH ≥ 30% or VIL ≥ 40"}>
      <Icon size={14} /> {label}
    </button>
  );
  const age = st.t ? Math.round((Date.now() - st.t) / 60000) : null;
  return (
    <div class="scanbar" style={{ top: `${top}px` }}>
      <div class="scan-row glass">
        {btn("tor", "Tornadic rotation", Tornado)}
        {btn("sc", "Supercells", CloudLightning)}
        {mode && (
          <>
            <span class="scan-sep" />
            {st.busy ? (
              <Loader size={13} class="spin muted" />
            ) : st.error ? (
              <span class="scan-err" title={st.error}>
                <AlertTriangle size={13} /> Scan failed
              </span>
            ) : (
              <button class={`scan-count ${hits.length ? "hit" : ""}`} onClick={() => setOpen(!open)} title="List">
                <b>{hits.length}</b> found{age != null && age > 0 ? ` · ${age} min ago` : ""}
                {hits.length > 0 && <ChevronDown size={13} class={open ? "rot180" : ""} />}
              </button>
            )}
            <button class="icon-btn" title="Clear" onClick={() => (clearScan(), setOpen(false))}>
              <X size={14} />
            </button>
          </>
        )}
      </div>
      {mode && open && hits.length > 0 && (
        <div class="scan-list glass">
          {hits.slice(0, 60).map((h) => (
            <button key={`${h.site}-${h.id}-${h.lon}`} class="scan-item" onClick={() => goToHit(h)}>
              <span class={`scan-dot ${h.p.tvs && h.p.tvs !== "NONE" ? "tvs" : mode}`} />
              <b>{h.site}</b>
              <span class="muted sid">{h.id}</span>
              <span class="str">{h.strength}</span>
              <span class="muted dist">{c ? fmtDist(distance(c.lat, c.lng, h.lat, h.lon)) : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
