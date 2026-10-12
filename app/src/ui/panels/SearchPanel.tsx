import { useState } from "preact/hooks";
import { api } from "../../api";
import { mapRef } from "../../map/mapview";
import { settings, update, toast } from "../../store";
import { setData } from "../../overlays/manager";
import { Search, MapPin, ChevronRight, X } from "lucide-preact";
import { distance, fmtDist } from "../../util";
import { LngLatBounds } from "maplibre-gl";

const PRESETS: [string, string][] = [
  ["hospital", "Hospitals"],
  ["shelter", "Shelters"],
  ["storm_shelter", "Storm shelters"],
  ["fuel", "Gas"],
  ["grocery", "Groceries"],
  ["hotel", "Hotels"],
  ["pharmacy", "Pharmacies"],
  ["police", "Police"],
  ["fire", "Fire stations"],
  ["school", "Schools"],
  ["charging", "EV charging"],
  ["airport", "Airports"],
];

export const searchResults: { current: any[] } = { current: [] };

export function SearchPanel() {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mq, setMq] = useState("");
  const [open, setOpen] = useState(true);
  const [found, setFound] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** sort by distance from: "" = map centre, else a saved point id */
  const [near, setNear] = useState("");
  const pts = settings.value.points;
  const nearPt = pts.find((p) => p.id === near);
  const origin = (): [number, number] | null => {
    if (nearPt) return [nearPt.lat, nearPt.lon];
    const c = mapRef.value?.getCenter();
    return c ? [c.lat, c.lng] : null;
  };
  const o = origin();
  const dist = (lat: number, lon: number) => (o ? distance(o[0], o[1], lat, lon) : 0);
  const byDist = <T,>(list: T[], ll: (x: T) => [number, number]) => (o ? [...list].sort((a, b) => dist(...ll(a)) - dist(...ll(b))) : list);
  const fLL = (f: any): [number, number] => [f.geometry.coordinates[1], f.geometry.coordinates[0]];
  const place = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.get(`/api/ovl/geocode?q=${encodeURIComponent(q.trim())}`);
      setPlaces(r.results);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const go = (p: any) => {
    const m = mapRef.value;
    if (!m) return;
    if (p.bbox?.length === 4) {
      const [s, n, w, e] = p.bbox;
      if (Math.abs(n - s) > 0.001) return m.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 13, duration: 900 });
    }
    m.flyTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), 11) });
  };
  const mapSearch = async (query: string) => {
    const m = mapRef.value;
    if (!m || !query.trim()) return;
    let b = m.getBounds();
    // near a saved point: search a view-sized box around it
    if (nearPt) {
      const hw = Math.min(1.5, (b.getEast() - b.getWest()) / 2);
      const hh = Math.min(1.2, (b.getNorth() - b.getSouth()) / 2);
      b = new LngLatBounds([nearPt.lon - hw, nearPt.lat - hh], [nearPt.lon + hw, nearPt.lat + hh]);
    }
    setBusy(true);
    setErr(null);
    try {
      const fc = await api.get(`/api/ovl/overpass?q=${encodeURIComponent(query.trim())}&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(3)).join(",")}`);
      setFound(fc.features);
      searchResults.current = fc.features;
      update((s) => (s.ovl.search = { ...(s.ovl.search ?? {}), on: true }));
      setData("search", fc);
      if (!fc.features.length) toast("Nothing found in view", "info");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const clear = () => {
    setFound(null);
    setData("search", { type: "FeatureCollection", features: [] });
    update((s) => (s.ovl.search = { ...(s.ovl.search ?? {}), on: false }));
  };
  return (
    <div class="stack">
      <section>
        <label class="lbl">Go to a place</label>
        <div class="search">
          <Search size={14} />
          <input placeholder="City, address or ZIP" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && place()} />
        </div>
        {places &&
          byDist(places, (p: any) => [p.lat, p.lon]).map((p, i) => (
            <button key={i} class="search-hit" onClick={() => go(p)}>
              <MapPin size={13} />
              <span>
                <b>{p.name || p.label.split(",")[0]}</b>
                <small class="muted">{p.label}</small>
              </span>
              {o && <small class="hit-dist">{fmtDist(dist(p.lat, p.lon))}</small>}
            </button>
          ))}
        {places && !places.length && <div class="muted small">No matches.</div>}
      </section>
      <section>
        <button class="ovl-ghead" onClick={() => setOpen(!open)}>
          <ChevronRight size={13} class={open ? "rot" : ""} />
          <span>Find on the map ({nearPt ? `around ${nearPt.name}` : "in view"})</span>
        </button>
        {open && (
          <>
            <div class="row near-row">
              <span>Near</span>
              <select value={near} onChange={(e) => setNear((e.target as HTMLSelectElement).value)} title="Sort results by distance from">
                <option value="">Map centre</option>
                {pts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div class="chips">
              {PRESETS.map(([k, l]) => (
                <button key={k} class="chip" disabled={busy} onClick={() => mapSearch(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div class="search">
              <Search size={14} />
              <input placeholder="Name, or a tag like amenity=cafe" value={mq} onInput={(e) => setMq((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && mapSearch(mq)} />
            </div>
          </>
        )}
        {busy && <div class="muted small">Searching…</div>}
        {err && <div class="err-text small">{err}</div>}
        {found && (
          <>
            <div class="row">
              <span class="muted small">{found.length} found</span>
              <button class="btn xs ghost" onClick={clear}>
                <X size={12} /> Clear
              </button>
            </div>
            {byDist(found, fLL)
              .slice(0, 80)
              .map((f, i) => (
                <button key={i} class="search-hit" onClick={() => mapRef.value?.flyTo({ center: f.geometry.coordinates, zoom: Math.max(mapRef.value.getZoom(), 14) })}>
                  <MapPin size={13} />
                  <span>
                    <b>{f.properties.name}</b>
                    <small class="muted">{[f.properties.kind, f.properties.addr].filter(Boolean).join(" · ")}</small>
                  </span>
                  {o && <small class="hit-dist">{fmtDist(dist(...fLL(f)))}</small>}
                </button>
              ))}
          </>
        )}
        <p class="muted small">Search data © OpenStreetMap contributors (Nominatim, Overpass).</p>
      </section>
    </div>
  );
}

void settings;
