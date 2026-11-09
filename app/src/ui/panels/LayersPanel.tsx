// Layers menu. 0.8.4: laid out like Settings: search + category chips on top, folding categories
// below (a list on the left when maximized or popped out). Rows come from OverlayList.tsx.
import { useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { settings, update } from "../../store";
import { showRadar } from "../../radar/controller";
import { Toggle } from "./RadarPanel";
import { activeLabel, selectWeather } from "../../weather";
import { LayerGroupList, LayerHits, LayerMine, layerItems } from "../OverlayList";
import { LAYER_CATS, catCounts, groupsOfCat, type LayerCat } from "../layercats";
import { queryWords } from "../setfilter";
import { Search, X, ChevronRight, Star, TriangleAlert, CloudRain, Plane, Leaf, Camera } from "lucide-preact";
import { Slider, smoothLabel } from "../controls";
import "./settings083.css";

const ICONS: Record<string, any> = { mine: Star, alerts: TriangleAlert, wx: CloudRain, travel: Plane, env: Leaf, more: Camera };

const LS_CAT = "tbw.layers.cat";
function savedCat(): string | null {
  try {
    const v = localStorage.getItem(LS_CAT);
    if (v === "none") return null;
    return v && LAYER_CATS.some((c) => c.id === v) ? v : "mine";
  } catch {
    return "mine";
  }
}
/** open category (null: all folded) */
const openCat = signal<string | null>(savedCat());
const query = signal("");
function setCat(id: string | null) {
  openCat.value = id;
  try {
    localStorage.setItem(LS_CAT, id ?? "none");
  } catch {
    /* private mode */
  }
}

function WeatherLayer() {
  const s = settings.value;
  return (
    <section class="lyr-weather">
      <label class="lbl">Weather layer</label>
      <div class="row">
        <b>{activeLabel.value.title}</b>
        <span class="muted small">{activeLabel.value.group}</span>
      </div>
      <p class="muted small">Change it from the layer menu in the header or the product dropdown on the map.</p>
      {s.weather.kind === "radar" ? (
        <Toggle label="Show radar" on={showRadar.value} set={(v) => (showRadar.value = v)} />
      ) : (
        <>
          <div class="row">
            <span>Frames</span>
            <input type="range" min={2} max={36} value={s.grid.frames} onChange={(e) => update((x) => (x.grid.frames = +(e.target as HTMLInputElement).value))} />
            <span class="val">{s.grid.frames}</span>
          </div>
          <div class="row">
            <span>Opacity</span>
            <input type="range" min={10} max={100} value={Math.round(s.grid.opacity * 100)} onInput={(e) => update((x) => (x.grid.opacity = +(e.target as HTMLInputElement).value / 100))} />
            <span class="val">{Math.round(s.grid.opacity * 100)}%</span>
          </div>
          {s.weather.kind === "grid" && (
            <>
              <div class="row">
                <span>Detail</span>
                <input type="range" min={50} max={150} step={25} value={Math.round(s.grid.quality * 100)} onChange={(e) => update((x) => (x.grid.quality = +(e.target as HTMLInputElement).value / 100))} />
                <span class="val">{Math.round(s.grid.quality * 100)}%</span>
              </div>
              <Slider label="Smoothing" value={s.grid.smooth} min={0} max={1} step={0.05} fmt={smoothLabel} set={(v) => update((x) => (x.grid.smooth = v))} />
            </>
          )}
          <button class="btn sm ghost" onClick={() => selectWeather({ kind: "radar" })}>
            Back to radar
          </button>
        </>
      )}
    </section>
  );
}

export function LayersPanel() {
  const cur = openCat.value;
  const q = query.value;
  const words = queryWords(q);
  const searching = words.length > 0;
  const root = useRef<HTMLDivElement>(null);
  const all = layerItems();
  const textOf = (i: { name: string; desc: string; group: string }) => `${i.name} ${i.desc} ${i.group}`;
  const counts = catCounts(all.map((i) => ({ group: i.group, on: i.on, text: textOf(i) })), words);
  const hits = searching ? all.filter((i) => words.every((w) => textOf(i).toLowerCase().includes(w))) : [];
  const present = all.map((i) => i.group);
  const go = (id: string) => {
    query.value = "";
    setCat(id);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`.s83-cat[data-cat="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const body = (c: LayerCat) =>
    c.id === "mine" ? (
      <>
        <WeatherLayer />
        <LayerMine />
      </>
    ) : (
      <LayerGroupList groups={groupsOfCat(c, present)} />
    );
  return (
    <div class={`s83${searching ? " s83-searching" : ""}`} ref={root}>
      <div class="s83-in">
        <div class="s83-bar">
          <div class="s83-search">
            <Search size={13} />
            <input
              type="search"
              placeholder="Search layers"
              value={q}
              aria-label="Search layers"
              onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && q) {
                  e.stopPropagation();
                  query.value = "";
                }
              }}
            />
            {q && (
              <button class="icon-btn" title="Clear" onClick={() => (query.value = "")}>
                <X size={12} />
              </button>
            )}
          </div>
          <div class="s83-chips" role="tablist">
            {LAYER_CATS.map((c) => {
              const Icon = ICONS[c.id];
              const n = searching ? counts[c.id].hits : counts[c.id].on;
              return (
                <button key={c.id} role="tab" aria-selected={!searching && cur === c.id} class={`s83-chip${!searching && cur === c.id ? " on" : ""}${searching && !n ? " dim" : ""}`} title={c.name} onClick={() => go(c.id)}>
                  <Icon size={15} />
                  <span class="s83-chip-l">{c.name}</span>
                  {n > 0 && <i class="s83-n">{n}</i>}
                </button>
              );
            })}
          </div>
        </div>
        <div class="s83-cats">
          {searching ? (
            <LayerHits hits={hits} filter={q.trim()} />
          ) : (
            LAYER_CATS.map((c) => {
              const Icon = ICONS[c.id];
              const open = cur === c.id;
              return (
                <details
                  key={c.id}
                  class="s83-cat"
                  data-cat={c.id}
                  open={open}
                  onToggle={(e) => {
                    const o = (e.currentTarget as HTMLDetailsElement).open;
                    if (o && openCat.peek() !== c.id) setCat(c.id);
                    else if (!o && openCat.peek() === c.id) setCat(null);
                  }}
                >
                  <summary class="s83-head">
                    <Icon size={16} />
                    <span>
                      <b>{c.name}</b>
                      <small>{c.sub}</small>
                    </span>
                    <ChevronRight size={14} class="s83-chev" />
                  </summary>
                  {open && <div class="s83-body stack">{body(c)}</div>}
                </details>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
