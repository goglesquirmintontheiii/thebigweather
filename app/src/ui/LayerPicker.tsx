// Floating weather-layer dropdown (left of the header): switch layers without opening a panel.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { settings, update } from "../store";
import { gridLayers, GIBS, activeLabel, selectWeather, gridDef, isWaterDef, type GridLayerDef } from "../weather";
import { currentSite } from "../radar/controller";
import { Layers, ChevronDown, Search, Radar, Satellite, Grid3x3, CloudSun, Thermometer, CalendarClock, FastForward, Globe, Waves } from "lucide-preact";
import { intlSources, intlErrors, intlListLoading, loadIntlList, selectIntl, flyForGrid, intlRegion, INTL_REGIONS, INTL_NAMES, groupOf, allIdOf, groupName, errKey, curPrecip, setIntlPrecip, type IntlSource, type Precip } from "../intl/radar"; // intl & forecast tools
import { noLevel3 } from "../intl/sites";
import { BrainCircuit } from "lucide-preact"; // models 0.7
import { predLayers, predModelId, predModelName, runState, mlOpen, mlTab, refreshGridCatalog, loadRun } from "../ml/client"; // models 0.7
import { fmtTime } from "../util"; // models 0.7

type Cat = "radar" | "world" | "future" | "mrms" | "sat" | "models" | "ndfd" | "obs" | "water" /* data 0.6 */ | "mine" /* models 0.7 */;
const CATS: { id: Cat; name: string; icon: any }[] = [
  { id: "radar", name: "Radar", icon: Radar },
  { id: "world", name: "World", icon: Globe },
  { id: "future", name: "Future", icon: FastForward },
  { id: "mrms", name: "MRMS", icon: Grid3x3 },
  { id: "sat", name: "Satellite", icon: Satellite },
  { id: "models", name: "Models", icon: CloudSun },
  { id: "ndfd", name: "Forecast", icon: CalendarClock },
  { id: "obs", name: "Surface", icon: Thermometer },
  { id: "water", name: "Water", icon: Waves }, // data 0.6: flooding + marine
  { id: "mine", name: "My models", icon: BrainCircuit }, // models 0.7
];

function catOf(d: GridLayerDef): Cat {
  if ((d.source as string) === "mlpred" || d.id.startsWith("mlpred/")) return "mine"; // models 0.7
  if (isWaterDef(d)) return "water"; // data 0.6
  if (d.source === "nowcast") return "future"; // data 0.6
  return ({ mrms: "mrms", goes: "sat", model: "models", ndfd: "ndfd", metar: "obs", future: "future", opera: "world", cwa: "world" } as const)[d.source as "mrms"] ?? (d.group === "International radar" ? "world" : "mrms");
}

function currentCat(): Cat {
  const w = settings.value.weather;
  if (w.kind === "radar") return "radar";
  if (w.kind === "gibs") return "sat";
  if (w.kind === "intl") return "world";
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
                {cat === "world" && <WorldList pick={pick} />}
                {cat === "sat" && <SatList pick={pick} />}
                {cat === "models" && <ModelList pick={pick} />}
                {(cat === "mrms" || cat === "ndfd" || cat === "obs") && <GroupedList cat={cat} pick={pick} />}
                {cat === "future" && <FutureList pick={pick} />}
                {cat === "water" && <WaterList pick={pick} />}
                {cat === "mine" && <MineList pick={pick} />}
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
      {!noLevel3(currentSite.value) && <Item on={w.kind === "radar" && r.source === "L3"} name="Level III" sub="Derived products · precip · hydro class" onClick={() => set("L3")} />}
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
  const now = gridLayers.value.filter((d) => d.source === "nowcast"); // data 0.6
  if (!defs.length && !now.length) return <div class="muted small">Connect to a server to list layers.</div>;
  return (
    <>
      {now.length > 0 && <label class="lbl">Nowcast · next hour (forecast)</label>}
      {now.map((d) => (
        <Item key={d.id} on={isGrid(d.id)} name={d.name} sub="Extrapolated · forecast frames" onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
      ))}
      <label class="lbl">From now forward · model forecasts</label>
      {defs.map((d) => (
        <Item key={d.id} on={isGrid(d.id)} name={d.name} sub={FUTURE_SUB[d.id]} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
      ))}
    </>
  );
}

/* ---------- models 0.7: "My models" — prediction grids from my models (mlpred/*) ---------- */
function MineList({ pick }: { pick: Pick }) {
  useEffect(() => {
    refreshGridCatalog();
    loadRun();
  }, []);
  const defs = predLayers.value;
  const times = new Map<string, number[]>();
  for (const st of Object.values(runState.value)) for (const l of st?.layers ?? []) times.set(l.layer_id, l.valid_times);
  const byModel = new Map<string, GridLayerDef[]>();
  for (const d of defs) {
    const k = predModelId(d.id);
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k)!.push(d);
  }
  const span = (id: string) => {
    const t = times.get(id) ?? [];
    if (!t.length) return "Prediction frames";
    const a = Math.min(...t), b = Math.max(...t);
    return a === b ? `Valid ${fmtTime(a, true)}` : `${t.length} valid times · ${fmtTime(a, true)} → ${fmtTime(b, true)}`;
  };
  return (
    <>
      {[...byModel.entries()].map(([mid, ds]) => (
        <div key={mid}>
          <label class="lbl">{predModelName(ds[0].id)}</label>
          {ds.map((d) => (
            <Item key={d.id} on={isGrid(d.id)} name={d.name} sub={span(d.id)} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
          ))}
        </div>
      ))}
      {!defs.length && (
        <div class="muted small lp-note">
          No predictions yet. Run a temperature, precipitation, storm, instability, tropical or flood model (
          <a onClick={() => pick(() => ((mlTab.value = "run"), (mlOpen.value = true)))}>Detection models → Run</a>) and its forecast appears here as a weather layer.
        </div>
      )}
    </>
  );
}
/* ---------- end models 0.7 ---------- */

/* ---------- data 0.6: flooding & marine ---------- */
function WaterList({ pick }: { pick: Pick }) {
  const defs = gridLayers.value.filter(isWaterDef);
  const groups = [...new Set(defs.map((d) => d.group))].sort((a, b) => (/flood|flash|hydro/i.test(a) ? -1 : 0) - (/flood|flash|hydro/i.test(b) ? -1 : 0));
  const w = settings.value.weather;
  const sst = GIBS.filter((g) => g.id === "sst-mur" || g.id === "sst-anom");
  return (
    <>
      {groups.map((g) => (
        <div key={g}>
          <label class="lbl">{g.replace(/^(MRMS|Models) · /, "")}</label>
          <div class="lp-grid">
            {defs
              .filter((d) => d.group === g)
              .map((d) => (
                <Item key={d.id} on={isGrid(d.id)} name={d.name} onClick={() => pick(() => selectWeather({ kind: "grid", id: d.id }))} />
              ))}
          </div>
        </div>
      ))}
      {!defs.length && <div class="muted small">No flooding or wave layers on this server yet.</div>}
      <label class="lbl">Sea surface (NASA)</label>
      <div class="lp-grid">
        {sst.map((x) => (
          <Item key={x.id} on={w.kind === "gibs" && w.id === x.id} name={x.name} sub="Daily" onClick={() => pick(() => selectWeather({ kind: "gibs", id: x.id }))} />
        ))}
      </div>
      <div class="muted small lp-note">Wave arrows and contours: layer settings under the legend.</div>
    </>
  );
}
/* ---------- end data 0.6 ---------- */

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
  { id: "meteosat", name: "Meteosat (Europe / Africa)" },
  { id: "polar", name: "Polar orbiters & global (NASA)" },
];
const REGIONS: Record<string, string> = { conus: "CONUS", full: "Full Disk", meso1: "Mesoscale 1", meso2: "Mesoscale 2" };

function SatList({ pick }: { pick: Pick }) {
  const goes = gridLayers.value.filter((d) => d.source === "goes");
  const w = settings.value.weather;
  // current selection → satellite / region
  const cur = w.kind === "grid" && w.id.startsWith("goes/") ? w.id.split("/") : w.kind === "gibs" ? [GIBS.find((g) => g.id === w.id)?.sat ?? "19", "full"] : [];
  const curSat = cur[0] === "goes" ? cur[1] : cur[0];
  const curReg = cur[0] === "goes" ? cur[2] : cur[1];
  const [sat, setSat] = useState(curSat ?? "19");
  const [reg, setReg] = useState(curReg ?? "conus");
  const inSector = goes.filter((d) => d.id.startsWith(`goes/${sat}/${reg}/`));
  const rgbs = inSector.filter((d) => d.cmap === "RGB");
  const bands = inSector.filter((d) => d.cmap !== "RGB");
  const imageOnly = sat === "himawari" || sat === "meteosat" || sat === "polar";
  const gibs = GIBS.filter((g) => g.sat === sat && (imageOnly || reg === "full"));
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
      {!imageOnly && (
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
          <label class="lbl">{sat === "meteosat" ? "EUMETSAT imagery" : "NASA imagery (GIBS)"}</label>
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
      {!imageOnly && !goes.length && <div class="muted small">Connect to a server to list GOES layers.</div>}
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
    for (const x of intlSources.value) if (match(`${x.name} ${x.region} ${intlRegion(x.id)} world radar`)) out.push({ key: `intl:${x.id}`, name: x.name, sub: `World radar · ${intlRegion(x.id, x.region)}`, on: w.kind === "intl" && w.id === x.id, go: () => selectIntl(x.id) });
    for (const all of new Set(intlSources.value.filter((x) => groupOf(x)).map(allIdOf))) {
      const reg = intlRegion(all);
      if (match(`${groupName(all)} ${reg} world radar ${all}`)) out.push({ key: `intl:${all}`, name: groupName(all), sub: `World radar · ${reg}`, on: w.kind === "intl" && w.id === all, go: () => selectIntl(all) });
    }
    for (const g of GIBS) if (match(`${g.name} ${g.group}`)) out.push({ key: g.id, name: g.name, sub: g.group, on: w.kind === "gibs" && w.id === g.id, go: () => selectWeather({ kind: "gibs", id: g.id }) });
    return out.slice(0, 60);
  }, [q, gridLayers.value, intlSources.value]);
  if (!items.length) return <div class="muted small lp-empty">No matching layers</div>;
  return (
    <div class="lp-results">
      {items.map((it) => (
        <Item key={it.key} on={it.on} name={it.name} sub={it.sub} onClick={() => pick(it.go)} />
      ))}
    </div>
  );
}

// ---------- intl & forecast tools: world radar ----------

function WItem({ on, name, sub, onClick, err, tip }: { on: boolean; name: string; sub?: string; onClick?: () => void; err?: string; tip?: string }) {
  return (
    <button class={`lp-item ${on ? "on" : ""} ${err ? "lp-off" : ""}`} aria-disabled={!!err} title={err ? `Unavailable: ${err}` : tip} onClick={err ? undefined : onClick}>
      <span>{name}</span>
      {(sub || err) && <small>{err ? "unavailable" : sub}</small>}
    </button>
  );
}

/** short label of a per-radar source in the group grid */
function radarLabel(x: IntlSource): { name: string; sub?: string } {
  if (x.site) return { name: x.site.name, sub: `${x.site.id}${x.site.province ? ` · ${x.site.province}` : ""}` };
  return { name: x.id.slice(x.id.indexOf("_") + 1).toUpperCase() };
}

/** "All … radars" + one button per radar, with a rain / snow switch when the radars have both. */
function RadarGroup({ all, list, pick }: { all: string; list: IntlSource[]; pick: Pick }) {
  const w = settings.value.weather;
  const onIntl = (id: string) => w.kind === "intl" && w.id === id;
  const snow = list.some((x) => x.frames_snow);
  const inGroup = w.kind === "intl" && (w.id === all || list.some((x) => x.id === w.id));
  const [pref, setPref] = useState<Precip>(inGroup ? curPrecip() : "rain");
  const precip: Precip = inGroup ? curPrecip() : pref;
  const choose = (p: Precip) => (setPref(p), inGroup && setIntlPrecip(p));
  const kind = list[0]?.kind === "image" ? "images" : "tiles";
  const src = all.startsWith("smn") ? "SMN" : all.startsWith("eccc") ? "ECCC / GeoMet" : "";
  return (
    <>
      <div class="lp-gall">
        <WItem on={onIntl(all)} name={groupName(all)} sub={`${list.length} radars${src ? ` · ${src}` : ""} ${kind}${snow ? ` · ${precip}` : ""}`} onClick={() => pick(() => selectIntl(all, snow ? precip : undefined))} />
        {snow && (
          <div class="seg sm lp-precip" title="Rain or snow rate">
            {(["rain", "snow"] as Precip[]).map((p) => (
              <button key={p} class={precip === p ? "on" : ""} onClick={() => choose(p)}>
                {p === "rain" ? "Rain" : "Snow"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class={`lp-grid ${list.some((x) => x.site) ? "lp-sites" : "lp-smn"}`}>
        {list.map((x) => {
          const l = radarLabel(x);
          return <WItem key={x.id} on={onIntl(x.id)} name={l.name} sub={l.sub} tip={x.name} onClick={() => pick(() => selectIntl(x.id, snow ? precip : undefined))} />;
        })}
      </div>
    </>
  );
}

function WorldList({ pick }: { pick: Pick }) {
  useEffect(() => {
    loadIntlList();
  }, []);
  const w = settings.value.weather;
  const srcs = intlSources.value;
  const errs = intlErrors.value;
  const grids = gridLayers.value.filter((d) => catOf(d) === "world");
  const onIntl = (id: string) => w.kind === "intl" && w.id === id;
  const grouped = srcs.filter((x) => groupOf(x));
  const kindSub = (k: string) => (k === "image" ? "Images" : k === "wms" ? "WMS tiles" : "Tiles");
  return (
    <>
      {INTL_REGIONS.map((reg) => {
        const g = grids.filter((d) => intlRegion(d.id, d.id.startsWith("cwa") ? "Asia" : "Europe") === reg);
        const r = srcs.filter((x) => !groupOf(x) && intlRegion(x.id, x.region) === reg);
        const bad = Object.entries(errs).filter(([k]) => k !== "_all" && intlRegion(k) === reg && !srcs.some((x) => x.id === k || errKey(x.id) === k));
        const groups = [...new Set(grouped.filter((x) => intlRegion(x.id, x.region) === reg).map(allIdOf))];
        if (!g.length && !r.length && !bad.length && !groups.length) return null;
        return (
          <div key={reg}>
            <label class="lbl">World radar · {reg}</label>
            {g.map((d) => (
              <Item key={d.id} on={isGrid(d.id)} name={d.name.replace(/^(Europe|Taiwan) · /, (m) => (reg === "Asia" ? m : ""))} sub="Gridded · values on hover" onClick={() => pick(() => (selectWeather({ kind: "grid", id: d.id }), flyForGrid(d.id)))} />
            ))}
            {r.map((x) => (
              <WItem key={x.id} on={onIntl(x.id)} name={x.name} sub={`${kindSub(x.kind)} · every ${x.step_min} min`} tip={`${x.attribution}${x.license_note ? ` · ${x.license_note}` : ""}`} onClick={() => pick(() => selectIntl(x.id))} />
            ))}
            {groups.map((all) => (
              <RadarGroup key={all} all={all} list={grouped.filter((x) => allIdOf(x) === all)} pick={pick} />
            ))}
            {bad.map(([k, e]) => (
              <WItem key={k} on={false} name={INTL_NAMES[k] ?? k} err={e} />
            ))}
          </div>
        );
      })}
      {intlListLoading.value && !srcs.length && <div class="muted small">Loading world radar…</div>}
      {errs._all && !srcs.length && <div class="muted small" title={errs._all}>World radar needs a newer server.</div>}
      <div class="muted small lp-note">No cursor values on image radars. Credits in the map attribution.</div>
    </>
  );
}
