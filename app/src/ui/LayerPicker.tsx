// Floating weather-layer dropdown (left of the header): switch layers without opening a panel.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { settings, update } from "../store";
import { gridLayers, GIBS, activeLabel, selectWeather, gridDef, type GridLayerDef } from "../weather";
import { currentSite } from "../radar/controller";
import { Layers, ChevronDown, Search, Radar, Satellite, Grid3x3, CloudSun, Thermometer, CalendarClock, FastForward } from "lucide-preact";

type Cat = "radar" | "future" | "mrms" | "sat" | "models" | "ndfd" | "obs";
const CATS: { id: Cat; name: string; icon: any }[] = [
  { id: "radar", name: "Radar", icon: Radar },
  { id: "future", name: "Future", icon: FastForward },
  { id: "mrms", name: "MRMS", icon: Grid3x3 },
  { id: "sat", name: "Satellite", icon: Satellite },
  { id: "models", name: "Models", icon: CloudSun },
  { id: "ndfd", name: "Forecast", icon: CalendarClock },
  { id: "obs", name: "Surface", icon: Thermometer },
];

function catOf(d: GridLayerDef): Cat {
  return ({ mrms: "mrms", goes: "sat", model: "models", ndfd: "ndfd", metar: "obs", future: "future" } as const)[d.source];
}

function currentCat(): Cat {
  const w = settings.value.weather;
  if (w.kind === "radar") return "radar";
  if (w.kind === "gibs") return "sat";
  const d = gridDef(w.id);
  return d ? catOf(d) : "radar";
}

export function LayerPicker() {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<Cat>(currentCat());
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const lbl = activeLabel.value;

  useEffect(() => {
    if (!open) return;
    setCat(currentCat());
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => {
    fn();
    setOpen(false);
    setQ("");
  };

  return (
    <div class="lp" ref={ref}>
      <button class={`lp-btn glass ${open ? "on" : ""}`} onClick={() => setOpen(!open)} title="Weather layer">
        <Layers size={15} />
        <span class="lp-txt">
          <small>{lbl.group}</small>
          <b>{lbl.title}</b>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div class="lp-pop glass">
          <div class="search">
            <Search size={14} />
            <input autoFocus value={q} placeholder="Search layers" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
          {q.trim() ? (
            <SearchResults q={q} pick={pick} />
          ) : (
            <div class="lp-body">
              <div class="lp-cats">
                {CATS.map((c) => (
                  <button key={c.id} class={`lp-cat ${cat === c.id ? "on" : ""}`} onClick={() => setCat(c.id)}>
                    <c.icon size={15} />
                    {c.name}
                  </button>
                ))}
              </div>
              <div class="lp-list">
                {cat === "radar" && <RadarList pick={pick} />}
                {cat === "sat" && <SatList pick={pick} />}
                {cat === "models" && <ModelList pick={pick} />}
                {(cat === "mrms" || cat === "ndfd" || cat === "obs") && <GroupedList cat={cat} pick={pick} />}
                {cat === "future" && <FutureList pick={pick} />}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Pick = (fn: () => void) => void;

function Item({ on, name, sub, onClick }: { on: boolean; name: string; sub?: string; onClick: () => void }) {
  return (
    <button class={`lp-item ${on ? "on" : ""}`} onClick={onClick}>
      <span>{name}</span>
      {sub && <small>{sub}</small>}
    </button>
  );
}

function isGrid(id: string) {
  const w = settings.value.weather;
  return w.kind === "grid" && w.id === id;
}

function RadarList({ pick }: { pick: Pick }) {
  const w = settings.value.weather;
  const r = settings.value.radar;
  const tdwr = currentSite.value?.type === "TDWR";
  const set = (src: "L2" | "L3") =>
    pick(() =>
      update((s) => {
        s.weather = { kind: "radar" };
        if (s.radar.source !== src) {
          s.radar.source = src;
          s.radar.product = src === "L2" ? "REF" : tdwr ? "TZL" : "N0B";
        }
      }),
    );
  return (
    <>
      <label class="lbl">Single-site radar · {r.site}</label>
      <Item on={w.kind === "radar" && r.source === "L2"} name="Level II" sub="Full resolution · all tilts · RapidSweep" onClick={() => set("L2")} />
      <Item on={w.kind === "radar" && r.source === "L3"} name="Level III" sub="Derived products · precip · hydro class" onClick={() => set("L3")} />
      <label class="lbl">Future radar</label>
      {gridLayers.value
        .filter((d) => d.source === "future" && d.cmap === "REF")
        .map((d) => (
          <Item key={d.id} on={isGrid(d.id)} name={d.name.replace("Future Radar · ", "") + " future radar"} sub="Model-simulated" onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
        ))}
      <label class="lbl">Radar mosaics</label>
      {["mrms/cref", "mrms/bref", "mrms/lowalt", "mrms/seamless"].map((id) => {
        const d = gridDef(id);
        return d ? <Item key={id} on={isGrid(id)} name={d.name} sub="MRMS · CONUS" onClick={() => pick(() => selectWeather({ kind: "grid", id }))} /> : null;
      })}
    </>
  );
}

const FUTURE_SUB: Record<string, string> = {
  "future/radar6": "HRRR every 15 min",
  "future/radar24": "HRRR hourly (RRFS / NAM backup)",
  "future/radar72": "RRFS hourly (NAM / GFS backup)",
  "future/snow48": "Total from now · RRFS (HRRR backup)",
};

function FutureList({ pick }: { pick: Pick }) {
  const defs = gridLayers.value.filter((d) => d.source === "future");
  if (!defs.length) return <div class="muted small">Connect to a server to list layers.</div>;
  return (
    <>
      <label class="lbl">From now forward · model forecasts</label>
      {defs.map((d) => (
        <Item key={d.id} on={isGrid(d.id)} name={d.name} sub={FUTURE_SUB[d.id]} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
      ))}
    </>
  );
}

function GroupedList({ cat, pick }: { cat: Cat; pick: Pick }) {
  const defs = gridLayers.value.filter((d) => catOf(d) === cat);
  const groups = [...new Set(defs.map((d) => d.group))];
  if (!defs.length) return <div class="muted small">Connect to a server to list layers.</div>;
  return (
    <>
      {groups.map((g) => (
        <div key={g}>
          <label class="lbl">{g.replace(/^MRMS · /, "")}</label>
          {defs
            .filter((d) => d.group === g)
            .map((d) => (
              <Item key={d.id} on={isGrid(d.id)} name={d.name} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
            ))}
        </div>
      ))}
    </>
  );
}

const SATS = [
  { id: "19", name: "GOES-19 (East)" },
  { id: "18", name: "GOES-18 (West)" },
  { id: "himawari", name: "Himawari-9 (NASA imagery)" },
];
const REGIONS: Record<string, string> = { conus: "CONUS", full: "Full Disk", meso1: "Mesoscale 1", meso2: "Mesoscale 2" };

function SatList({ pick }: { pick: Pick }) {
  const goes = gridLayers.value.filter((d) => d.source === "goes");
  const w = settings.value.weather;
  // current selection → satellite / region
  const cur = w.kind === "grid" && w.id.startsWith("goes/") ? w.id.split("/") : w.kind === "gibs" ? [w.id.startsWith("himawari") ? "himawari" : w.id.includes("west") ? "18" : "19", "full"] : [];
  const curSat = cur[0] === "goes" ? cur[1] : cur[0];
  const curReg = cur[0] === "goes" ? cur[2] : cur[1];
  const [sat, setSat] = useState(curSat ?? "19");
  const [reg, setReg] = useState(curReg ?? "conus");
  const inSector = goes.filter((d) => d.id.startsWith(`goes/${sat}/${reg}/`));
  const rgbs = inSector.filter((d) => d.cmap === "RGB");
  const bands = inSector.filter((d) => d.cmap !== "RGB");
  const gibs = GIBS.filter((g) => (sat === "himawari" ? g.id.startsWith("himawari") : reg === "full" && g.id.startsWith(sat === "19" ? "goes-east" : "goes-west")));
  return (
    <>
      <label class="lbl">Satellite</label>
      <select value={sat} onChange={(e) => setSat((e.target as HTMLSelectElement).value)}>
        {SATS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {sat !== "himawari" && (
        <>
          <label class="lbl">Region</label>
          <select value={reg} onChange={(e) => setReg((e.target as HTMLSelectElement).value)}>
            {Object.entries(REGIONS).map(([id, name]) => (
              <option key={id} value={id}>
                {id === "conus" && sat === "18" ? "PACUS (West CONUS)" : name}
              </option>
            ))}
          </select>
        </>
      )}
      {rgbs.length > 0 && (
        <>
          <label class="lbl">Composites</label>
          <div class="lp-grid">
            {rgbs.map((d) => (
              <Item key={d.id} on={isGrid(d.id)} name={d.name} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
            ))}
          </div>
        </>
      )}
      {gibs.length > 0 && (
        <>
          <label class="lbl">NASA imagery (GIBS)</label>
          <div class="lp-grid">
            {gibs.map((x) => (
              <Item key={x.id} on={w.kind === "gibs" && w.id === x.id} name={x.name} onClick={() => pick(() => selectWeather({ kind: "gibs", id: x.id }))} />
            ))}
          </div>
        </>
      )}
      {bands.length > 0 && (
        <>
          <label class="lbl">Bands · values on hover</label>
          <div class="lp-grid">
            {bands.map((d) => (
              <Item key={d.id} on={isGrid(d.id)} name={d.name} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
            ))}
          </div>
        </>
      )}
      {sat !== "himawari" && !goes.length && <div class="muted small">Connect to a server to list GOES layers.</div>}
    </>
  );
}

function ModelList({ pick }: { pick: Pick }) {
  const defs = gridLayers.value.filter((d) => d.source === "model");
  const models = [...new Map(defs.map((d) => [d.model!, d.group.replace("Models · ", "")])).entries()];
  const w = settings.value.weather;
  const cur = w.kind === "grid" ? gridDef(w.id)?.model : undefined;
  const [model, setModel] = useState(cur ?? models[0]?.[0]);
  const vars = defs.filter((d) => d.model === model);
  // keep the same variable when switching model
  const curVar = w.kind === "grid" ? w.id.split("/")[2] : undefined;
  if (!defs.length) return <div class="muted small">Connect to a server to list models.</div>;
  return (
    <div class="lp-models">
      <div class="lp-mcol">
        {models.map(([id, name]) => (
          <button key={id} class={`lp-item ${model === id ? "on" : ""} ${cur === id ? "cur" : ""}`} onClick={() => setModel(id)}>
            <span>{name}</span>
          </button>
        ))}
      </div>
      <div class="lp-vcol">
        {vars.map((d) => (
          <Item key={d.id} on={isGrid(d.id)} name={d.name} sub={curVar && d.id.endsWith(`/${curVar}`) && !isGrid(d.id) ? "same field" : undefined} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
        ))}
      </div>
    </div>
  );
}

function SearchResults({ q, pick }: { q: string; pick: Pick }) {
  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const out: { key: string; name: string; sub: string; on: boolean; go: () => void }[] = [];
    const w = settings.value.weather;
    if (match("radar level ii l2 nexrad")) out.push({ key: "l2", name: "Level II radar", sub: "Radar", on: false, go: () => update((s) => ((s.weather = { kind: "radar" }), (s.radar.source = "L2"), (s.radar.product = "REF"))) });
    if (match("radar level iii l3 nexrad")) out.push({ key: "l3", name: "Level III radar", sub: "Radar", on: false, go: () => update((s) => ((s.weather = { kind: "radar" }), (s.radar.source = "L3"), (s.radar.product = currentSite.value?.type === "TDWR" ? "TZL" : "N0B"))) });
    for (const d of gridLayers.value) if (match(`${d.name} ${d.group} ${d.id}`)) out.push({ key: d.id, name: d.name, sub: d.group, on: w.kind === "grid" && w.id === d.id, go: () => selectWeather({ kind: "grid", id: d.id }) });
    for (const g of GIBS) if (match(`${g.name} ${g.group}`)) out.push({ key: g.id, name: g.name, sub: g.group, on: w.kind === "gibs" && w.id === g.id, go: () => selectWeather({ kind: "gibs", id: g.id }) });
    return out.slice(0, 60);
  }, [q, gridLayers.value]);
  if (!items.length) return <div class="muted small lp-empty">No matching layers</div>;
  return (
    <div class="lp-results">
      {items.map((it) => (
        <Item key={it.key} on={it.on} name={it.name} sub={it.sub} onClick={() => pick(it.go)} />
      ))}
    </div>
  );
}
