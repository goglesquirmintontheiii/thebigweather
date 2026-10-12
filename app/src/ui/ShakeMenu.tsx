// "Seismographs" window: Raspberry Shake station browser (search, region/status/elevation/
// distance filters, sortable table, favourites, compare picks, map-layer toggle) with the advanced
// viewer (ShakeCenter.tsx) opening beside it.

import { useEffect, useMemo, useState } from "preact/hooks";
import { shakeOpen, shakeSel, shakeCompare, loadStations, isActive, isFav, toggleFav, shakeLayerOn, setShakeLayer, regionOf, staKey, type ShakeSta } from "../shake";
import { settings } from "../store";
import { mapRef } from "../map/mapview";
import { distance, fmtDist } from "../util";
import { CenterModal } from "./CenterModal";
import { ShakeViewer } from "./ShakeCenter";
import { AudioWaveform, Search, Star, Plus, Check, ChevronUp, ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-preact";

type Col = "fav" | "code" | "name" | "region" | "dist" | "elev" | "since";
interface Row {
  s: ShakeSta;
  k: string;
  region: string;
  d: number | null;
  active: boolean;
  fav: boolean;
}

const ELEV: [string, string, number, number][] = [
  ["any", "Any elevation", -Infinity, Infinity],
  ["lt100", "Below 100 m", -Infinity, 100],
  ["100", "100–500 m", 100, 500],
  ["500", "500–1500 m", 500, 1500],
  ["gt1500", "Above 1500 m", 1500, Infinity],
];

function Browser({ compact }: { compact: boolean }) {
  const [all, setAll] = useState<ShakeSta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [favOnly, setFavOnly] = useState(false);
  const [ref, setRef] = useState("center");
  const [maxKm, setMaxKm] = useState(0);
  const [elev, setElev] = useState("any");
  const [sort, setSort] = useState<{ c: Col; asc: boolean }>({ c: "dist", asc: true });
  const [limit, setLimit] = useState(200);
  useEffect(() => {
    loadStations()
      .then(setAll)
      .catch((e) => (setAll([]), setErr(e.message)));
  }, []);
  const favs = settings.value.shake?.favs ?? [];
  const points = settings.value.points;
  const c = mapRef.value?.getCenter();
  const origin = useMemo((): { lat: number; lon: number; name: string } | null => {
    if (ref === "center") return c ? { lat: c.lat, lon: c.lng, name: "map centre" } : null;
    if (ref === "sel" && shakeSel.value) return { lat: shakeSel.value.lat, lon: shakeSel.value.lon, name: shakeSel.value.sta };
    const p = points.find((x) => x.id === ref);
    return p ? { lat: p.lat, lon: p.lon, name: p.name } : null;
  }, [ref, c?.lat, c?.lng, points, shakeSel.value]);
  const rows = useMemo((): Row[] => (all ?? []).map((s) => ({ s, k: staKey(s), region: regionOf(s.lat, s.lon), d: null, active: isActive(s), fav: false })), [all]);
  const regions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.region, (m.get(r.region) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const qq = q.trim().toLowerCase();
  const [lo, hi] = (ELEV.find((e) => e[0] === elev) ?? ELEV[0]).slice(2) as [number, number];
  const list = useMemo(() => {
    const fs = new Set(favs);
    const out: Row[] = [];
    for (const r0 of rows) {
      const s = r0.s;
      if (activeOnly && !r0.active) continue;
      if (region && r0.region !== region) continue;
      if (favOnly && !fs.has(r0.k)) continue;
      if (elev !== "any" && !(s.elev != null && s.elev >= lo && s.elev < hi)) continue;
      if (qq && !`${r0.k} ${s.name ?? ""} ${r0.region}`.toLowerCase().includes(qq)) continue;
      const d = origin ? distance(origin.lat, origin.lon, s.lat, s.lon) : null;
      if (maxKm && d != null && d > maxKm * 1000) continue;
      out.push({ ...r0, d, fav: fs.has(r0.k) });
    }
    const k = sort.asc ? 1 : -1;
    const val = (r: Row): number | string => {
      switch (sort.c) {
        case "fav":
          return r.fav ? 0 : 1;
        case "code":
          return r.k;
        case "name":
          return (r.s.name ?? "").toLowerCase();
        case "region":
          return r.region;
        case "dist":
          return r.d ?? Infinity;
        case "elev":
          return r.s.elev ?? -Infinity;
        case "since":
          return r.s.start ? Date.parse(r.s.start) : Infinity;
      }
    };
    out.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * k || (a.d ?? 0) - (b.d ?? 0);
    });
    return out;
  }, [rows, favs, activeOnly, region, favOnly, elev, qq, origin, maxKm, sort]);
  const sel = shakeSel.value;
  const cmp = shakeCompare.value;
  const inCmp = (s: ShakeSta) => cmp.some((x) => staKey(x) === staKey(s));
  const head = (col: Col, label: any, cls = "") => (
    <th class={cls} onClick={() => setSort({ c: col, asc: sort.c === col ? !sort.asc : col !== "since" && col !== "elev" })}>
      {label}
      {sort.c === col && (sort.asc ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </th>
  );
  const elevTxt = (m?: number | null) => (m == null ? "—" : settings.value.units.distance === "km" ? `${Math.round(m)} m` : `${Math.round(m * 3.281)} ft`);
  return (
    <div class="sk-browser">
      <div class="sk-bctl">
        <div class="search">
          <Search size={14} />
          <input placeholder="Code, name or region" value={q} onInput={(e) => (setQ((e.target as HTMLInputElement).value), setLimit(200))} />
        </div>
        <select value={region} onChange={(e) => setRegion((e.target as HTMLSelectElement).value)} title="Region (approximate, from coordinates)">
          <option value="">All regions</option>
          {regions.map(([r, n]) => (
            <option key={r} value={r}>
              {r} ({n})
            </option>
          ))}
        </select>
        <select value={ref} onChange={(e) => setRef((e.target as HTMLSelectElement).value)} title="Distance from">
          <option value="center">From map centre</option>
          {sel && <option value="sel">From {sel.sta}</option>}
          {points.map((p) => (
            <option key={p.id} value={p.id}>
              From {p.name}
            </option>
          ))}
        </select>
        <select value={maxKm} onChange={(e) => setMaxKm(+(e.target as HTMLSelectElement).value)} title="Maximum distance">
          <option value={0}>Any distance</option>
          {[25, 50, 100, 250, 500, 1000, 2500].map((k) => (
            <option key={k} value={k}>
              Within {fmtDist(k * 1000)}
            </option>
          ))}
        </select>
        <select value={elev} onChange={(e) => setElev((e.target as HTMLSelectElement).value)}>
          {ELEV.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <label class="sk-chk">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly((e.target as HTMLInputElement).checked)} /> Active
        </label>
        <label class="sk-chk">
          <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly((e.target as HTMLInputElement).checked)} /> <Star size={11} /> Favourites
        </label>
      </div>
      <div class="muted small sk-count">
        {all === null ? "Loading stations…" : err ? <span class="err-text">{err}</span> : `${list.length.toLocaleString()} of ${rows.length.toLocaleString()} stations${origin ? ` · distance from ${origin.name}` : ""}`}
      </div>
      <div class="sk-tablewrap">
        <table class="sk-table">
          <thead>
            <tr>
              {head("fav", <Star size={11} />, "c")}
              {head("code", "Station")}
              {head("name", "Name")}
              {!compact && head("region", "Region")}
              {head("dist", "Dist.", "r")}
              {!compact && head("elev", "Elev.", "r")}
              {!compact && head("since", "Since", "r")}
              <th class="c" title="Add to compare" />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((r) => (
              <tr key={r.k} class={`${sel && staKey(sel) === r.k ? "on" : ""} ${r.active ? "" : "off"}`} onClick={() => (shakeSel.value = r.s)}>
                <td class="c">
                  <button class={`icon-btn ${r.fav ? "fav" : ""}`} onClick={(e) => (e.stopPropagation(), toggleFav(r.s))} title="Favourite">
                    <Star size={12} />
                  </button>
                </td>
                <td class="code">
                  <b>{r.s.sta}</b> <small class="muted">{r.s.net}</small>
                </td>
                <td class="nm">{r.s.name || <span class="muted">—</span>}</td>
                {!compact && <td class="muted">{r.region}</td>}
                <td class="r">{r.d == null ? "—" : fmtDist(r.d)}</td>
                {!compact && <td class="r">{elevTxt(r.s.elev)}</td>}
                {!compact && <td class="r muted">{r.s.start ? r.s.start.slice(0, 7) : "—"}</td>}
                <td class="c">
                  <button
                    class={`icon-btn ${inCmp(r.s) ? "on" : ""}`}
                    title={inCmp(r.s) ? "In compare view (click to remove)" : "Add to compare view"}
                    onClick={(e) => {
                      e.stopPropagation();
                      shakeCompare.value = inCmp(r.s) ? cmp.filter((x) => staKey(x) !== r.k) : [...cmp, r.s].slice(-12);
                      if (!shakeSel.value) shakeSel.value = r.s;
                    }}
                  >
                    {inCmp(r.s) ? <Check size={12} /> : <Plus size={12} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length > limit && (
          <button class="btn sm ghost sk-more" onClick={() => setLimit(limit + 300)}>
            Show more ({(list.length - limit).toLocaleString()} left)
          </button>
        )}
      </div>
    </div>
  );
}

export function ShakeMenu() {
  const [hideList, setHideList] = useState(false);
  if (!shakeOpen.value) return null;
  const st = shakeSel.value;
  const layer = shakeLayerOn();
  return (
    <CenterModal
      cls="sk sk-menu-win"
      icon={<AudioWaveform size={20} />}
      title="Seismographs"
      sub="Raspberry Shake citizen seismometers · data is at least 30 min old"
      onClose={() => (shakeOpen.value = false)}
      actions={
        <>
          {st && (
            <button class="icon-btn" title={hideList ? "Show station list" : "Hide station list"} onClick={() => setHideList(!hideList)}>
              {hideList ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          )}
          <label class="toggle compact sk-maptoggle" title="The Raspberry Shake map layer (not listed in Layers)">
            <span>Show stations on map</span>
            <input type="checkbox" checked={layer} onChange={(e) => setShakeLayer((e.target as HTMLInputElement).checked)} />
            <i />
          </label>
        </>
      }
    >
      <div class={`sk-menu ${st ? (hideList ? "solo" : "split") : ""}`}>
        {!(st && hideList) && <Browser compact={!!st} />}
        {st && <ShakeViewer st={st} onClose={() => (shakeSel.value = null)} />}
      </div>
    </CenterModal>
  );
}
