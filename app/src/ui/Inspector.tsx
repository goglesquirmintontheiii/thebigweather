// radar 0.6: Inspector — every Level II moment at the cursor (RadarScope-style), plus beam geometry
// and the hail / TDS / rotation flags at that spot. Toggle: toolbar "…" menu or the I key.
// Also the "last strike" chip for lightning near saved points.

import { useEffect } from "preact/hooks";
import { settings, update } from "../store";
import { hover, mapRef } from "../map/mapview";
import { sampleAt, type Sweep } from "../radar/sweep";
import { inspData, INSPECT_MOMENTS } from "../radar/inspector";
import { currentFrame, displaySweep } from "../radar/controller";
import { dealiased } from "../radar/dealias";
import { hailClass, HAIL_LABEL, HAIL_COLOR, mmToIn } from "../radar/hailfuzzy";
import { meshReady, meshAt, swathGrid } from "../radar/hail";
import { tdsHits } from "../radar/tds";
import { ltgNearPoints } from "../radar/lightning";
import { distance, fmtDist, speedFactor } from "../util";
import { Zap } from "lucide-preact";

export function toggleInspector() {
  update((s) => (s.radar6 = { ...s.radar6, inspector: !s.radar6?.inspector }));
}

const NAMES: Record<string, string> = { REF: "Reflectivity", VEL: "Velocity", SW: "Spectrum width", ZDR: "ZDR", RHO: "CC", PHI: "PhiDP", KDP: "KDP", CREF: "Composite refl.", ET: "Echo tops", VIL: "VIL" };

function fmt(m: string, v: number): string {
  if (Number.isNaN(v)) return "—";
  if (v === -9999) return "RF";
  const spd = () => {
    const k = speedFactor();
    return `${(v * k).toFixed(Math.abs(v * k) < 10 ? 1 : 0)} ${settings.value.units.speed}`;
  };
  switch (m) {
    case "REF":
    case "CREF":
      return `${v.toFixed(1)} dBZ`;
    case "VEL":
    case "SW":
      return spd();
    case "ZDR":
      return `${v.toFixed(2)} dB`;
    case "RHO":
      return v.toFixed(3);
    case "PHI":
      return `${v.toFixed(0)}°`;
    case "KDP":
      return `${v.toFixed(2)} °/km`;
    case "ET":
      return settings.value.units.distance === "km" ? `${v.toFixed(1)} km` : `${(v * 3.28084).toFixed(1)} kft`;
    case "VIL":
      return `${v.toFixed(1)} kg/m²`;
  }
  return v.toFixed(2);
}

const hStr = (m: number) => (settings.value.units.distance === "km" ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m * 3.28084).toLocaleString()} ft`);
const compass = (az: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(az / 22.5) % 16];

function inPoly(lon: number, lat: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function useInspectorKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === "i" || e.key === "I") toggleInspector();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Inspector() {
  useInspectorKey();
  if (!settings.value.radar6?.inspector) return null;
  const h = hover.value;
  if (!h) return null;
  const r = settings.value.radar;
  const W = window.innerWidth, H = window.innerHeight;
  const left = h.x + 300 > W ? h.x - 290 : h.x + 22;
  const top = Math.min(h.y + 18, H - 420);
  const style = { left: `${Math.max(4, left)}px`, top: `${Math.max(48, top)}px` };
  if (r.source !== "L2" || settings.value.weather.kind !== "radar") {
    return (
      <div class="r6-insp glass" style={style}>
        <div class="r6-insp-head">Inspector</div>
        <div class="muted small">Needs Level II radar (switch the source to Level II).</div>
      </div>
    );
  }
  const d = inspData.value;
  const key = currentFrame.value?.key;
  const sw: Record<string, Sweep | undefined> = { ...(d?.key === key ? d?.sweeps : {}) };
  // the product on screen: use the displayed sweep (dealiased velocity, live partial)
  const disp = displaySweep.value;
  if (disp && INSPECT_MOMENTS.includes(r.product)) sw[r.product] = disp;
  else if (sw.VEL && settings.value.radar6?.dealias) sw.VEL = dealiased(sw.VEL);
  const val: Record<string, number> = {};
  let geo: { range: number; az: number; height: number } | null = null;
  for (const m of INSPECT_MOMENTS) {
    const s = sw[m];
    if (!s) continue;
    const x = sampleAt(s, h.lat, h.lon);
    if (!x) continue;
    val[m] = x.value;
    if (m === r.product || (!geo && m === "REF")) geo = { range: x.range, az: x.az, height: x.height };
  }
  const radarH = (sw.REF ?? disp)?.height ?? 0;
  const lv = d?.levels;
  // flags
  const flags: { t: string; c: string }[] = [];
  if (geo && lv) {
    const cls = hailClass(val.REF, val.ZDR, val.RHO, radarH + geo.height - lv.h0);
    if (cls) flags.push({ t: `Hail ${HAIL_LABEL[cls]} (HSDA)`, c: HAIL_COLOR[cls] });
  }
  const mg = key ? meshReady.get(key) : undefined;
  const mesh = mg ? meshAt(mg, h.lat, h.lon) : NaN;
  if (mesh >= 6) flags.push({ t: `MESH ${mmToIn(mesh).toFixed(2)} in`, c: "#fb923c" });
  const sg = swathGrid;
  const swv = sg ? meshAt(sg, h.lat, h.lon) : NaN;
  if (swv >= 6) flags.push({ t: `Swath max ${mmToIn(swv).toFixed(2)} in`, c: "#fbbf24" });
  const th = tdsHits.value;
  if (th && th.key === key) for (const x of th.hits) if (x.poly.length >= 3 && inPoly(h.lon, h.lat, x.poly)) flags.push({ t: `Possible debris (${Math.round(x.conf * 100)}%)`, c: "#e879f9" });
  for (const f of d?.key === key ? d?.rot ?? [] : []) {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties ?? {};
    if (distance(lat, lon, h.lat, h.lon) <= ((p.diam_km ?? 2) / 2 + 1) * 1000) flags.push({ t: `${String(p.kind ?? "rot").toUpperCase()} · Vrot ${Math.round((p.vrot ?? 0) * speedFactor())} ${settings.value.units.speed}`, c: p.kind === "tvs" ? "#ff2d2d" : p.kind === "meso" ? "#facc15" : "#cbd5e1" });
  }
  const loading = !d || d.key !== key || d.loading;
  return (
    <div class="r6-insp glass" style={style}>
      <div class="r6-insp-head">
        <b>{r.site}</b> {disp ? `${disp.elevation.toFixed(1)}°` : ""} {loading && <span class="r6-spin" />}
      </div>
      <table>
        <tbody>
          {INSPECT_MOMENTS.map((m) => {
            const miss = !!d && d.key === key && d.missing.includes(m) && !sw[m];
            return (
              <tr key={m} class={m === r.product ? "cur" : ""}>
                <td>{NAMES[m]}</td>
                <td>{sw[m] ? fmt(m, val[m] ?? NaN) : miss ? "n/a" : "…"}</td>
              </tr>
            );
          })}
          {geo && (
            <>
              <tr class="sep">
                <td>Range / az</td>
                <td>
                  {fmtDist(geo.range)} · {Math.round(geo.az)}° {compass(geo.az)}
                </td>
              </tr>
              <tr>
                <td>Beam height</td>
                <td>
                  {hStr(geo.height)} ARL{lv ? ` · 0 °C ${hStr(lv.h0 - radarH)}` : ""}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      {flags.length > 0 && (
        <div class="r6-insp-flags">
          {flags.map((f) => (
            <span style={{ borderColor: f.c, color: f.c }}>{f.t}</span>
          ))}
        </div>
      )}
      {settings.value.radar6?.dealias && sw.VEL && <div class="muted small">Velocity dealiased</div>}
    </div>
  );
}

/** Toolbar chip: the most recent GLM strike within N mi of a saved point. */
export function LightningChip() {
  const l = ltgNearPoints.value;
  if (!settings.value.radar6?.ltgWatch || !l.length) return null;
  const top = l[0];
  const mins = Math.max(0, Math.round((Date.now() - top.t) / 60_000));
  const tip = l.map((x) => `${x.name}: ${x.count} strike${x.count > 1 ? "s" : ""}, nearest ${fmtDist(x.km * 1000)}, last ${Math.round((Date.now() - x.t) / 60_000)} min ago`).join("\n");
  return (
    <button
      class="tb r6-ltg-chip"
      title={`Lightning within ${settings.value.radar6.ltgMi} mi of saved points (GOES GLM, last 30 min)\n${tip}`}
      onClick={() => {
        const p = settings.value.points.find((x) => x.id === top.id);
        const m = mapRef.value;
        if (p && m) m.flyTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), 9) });
        const o = settings.value.ovl.glm;
        if (!o?.on) update((s) => (s.ovl.glm = { ...s.ovl.glm, on: true }));
      }}
    >
      <Zap size={15} />
      <span>
        {top.name} · {fmtDist(top.km * 1000)} · {mins} min
      </span>
    </button>
  );
}
