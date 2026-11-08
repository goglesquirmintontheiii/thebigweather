import { useEffect, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { signal } from "@preact/signals";
import { alerts, sortedAlerts } from "../../alerts";
import { selectedAlert, settings, update } from "../../store";
import { mapRef } from "../../map/mapview";
import { fmtTime, pointInGeometry } from "../../util";
/* 0.8.2: United States / Canada / International tabs, sort + type filter, Timelines menu, right-click → layer options */
import { regionOf, REGIONS, REGION_LABEL, SORT_LABEL, sortAlerts, typeCounts, filterTypes, type AlertRegion, type SortKey } from "../../alertlist";
import { regionOn } from "../../alertstyle";
import { alertSources, intlTabOpen, refreshAlertSources } from "../../alertdemand";
import { openAlertLayerOptions } from "../AlertConfig";
import { timelineOpen } from "../AlertTimeline";
import { ChartGantt, SquareArrowOutUpRight, SlidersHorizontal } from "lucide-preact";
import "../alerts082.css";
import "../alerts083.css"; // 0.8.3

export function zoomToGeometry(g: any) {
  const map = mapRef.value;
  if (!map || !g) return;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c: any) => {
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
    } else c.forEach(walk);
  };
  walk(g.coordinates);
  if (g.type === "Point") map.flyTo({ center: g.coordinates, zoom: Math.max(map.getZoom(), 5), duration: 600 }); // 0.8.2: unmapped areas
  else map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 120, maxZoom: 10, duration: 600 });
}

/* ---------- 0.8.2: per-viewer choices (tab, sort) ---------- */
function readPref<T extends string>(k: string, ok: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(k) as T | null;
    return v && ok.includes(v) ? v : def;
  } catch {
    return def;
  }
}
function savePref(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* */
  }
}
const SORTS: SortKey[] = ["priority", "time", "type", "name"];

/** "Warnings" filter: NWS by type; elsewhere also yellow / orange / red levels (national feeds
 * often name the hazard only: "Heavy Rain"). */
function warningish(p: any): boolean {
  if (String(p.event).endsWith("Warning")) return true;
  return regionOf(p) !== "us" && ["red", "orange", "yellow"].includes(p.level);
}

/** Right-click menu on an alert (tab row or map): layer options for its type. */
export const alertTypeMenu = signal<{ x: number; y: number; types: string[] } | null>(null);

export function AlertTypeMenu() {
  const m = alertTypeMenu.value;
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.(".al-typemenu")) alertTypeMenu.value = null;
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (alertTypeMenu.value = null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [m]);
  if (!m) return null;
  return createPortal(
    <div class="ctx glass al-typemenu" style={{ left: `${Math.min(m.x, window.innerWidth - 260)}px`, top: `${Math.min(m.y, window.innerHeight - 40 * m.types.length - 20)}px` }}>
      {m.types.map((t) => (
        <button
          key={t}
          onClick={() => {
            alertTypeMenu.value = null;
            openAlertLayerOptions(t);
          }}
        >
          <SlidersHorizontal size={13} /> Layer options for "{t}"...
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** "Timelines" button with its menu. */
function Timelines() {
  // 0.8.3: a plain button at the top of the tab (was a one-item menu) that opens the timeline window
  const on = timelineOpen.value;
  return (
    <div class="al-top">
      <button class={`btn sm ghost al-tlbtn ${on ? "on" : ""}`} aria-pressed={on} onClick={() => (timelineOpen.value = !on)} title={on ? "Close the alert timeline" : "Open the alert timeline window"}>
        <ChartGantt size={13} /> Timelines <SquareArrowOutUpRight size={12} />
      </button>
    </div>
  );
}

export function AlertsPanel() {
  const [filter, setFilter] = useState<"warnings" | "all" | "mine" | "view">("warnings");
  const [region, setRegionS] = useState<AlertRegion>(() => readPref("tbw.alerts.region", REGIONS, "us"));
  const [sort, setSortS] = useState<SortKey>(() => readPref("tbw.alerts.sort", SORTS, "priority"));
  const [type, setType] = useState("");
  const setRegion = (r: AlertRegion) => (setRegionS(r), savePref("tbw.alerts.region", r), setType(""));
  const setSort = (s: SortKey) => (setSortS(s), savePref("tbw.alerts.sort", s));
  // 0.8.2: the International tab asks the server for every international source while it shows
  useEffect(() => {
    intlTabOpen.value = region === "intl";
    if (region === "intl") refreshAlertSources();
    return () => {
      intlTabOpen.value = false;
    };
  }, [region]);
  void alerts.value;
  const all = sortedAlerts();
  const byRegion: Record<AlertRegion, any[]> = { us: [], ca: [], intl: [] };
  for (const a of all) byRegion[regionOf(a.properties)].push(a);
  let list = byRegion[region];
  const pts = settings.value.points;
  if (filter === "warnings") list = list.filter((a) => warningish(a.properties));
  if (filter === "mine") list = list.filter((a) => pts.some((p) => pointInGeometry(p.lon, p.lat, a.geometry)));
  if (filter === "view" && mapRef.value) {
    const b = mapRef.value.getBounds();
    list = list.filter((a) => {
      let hit = false;
      const walk = (c: any) => {
        if (hit) return;
        if (typeof c[0] === "number") hit = b.contains([c[0], c[1]]);
        else c.forEach(walk);
      };
      if (a.geometry) walk(a.geometry.coordinates);
      return hit;
    });
  }
  const types = typeCounts(list);
  const typeSel = type && types.some(([t]) => t === type) ? type : "";
  list = sortAlerts(filterTypes(list, typeSel ? [typeSel] : []), sort);
  const off = !regionOn(region);
  const srcs = alertSources.value.filter((s) => s.region === region);
  const failing = srcs.filter((s) => s.active && s.error);
  return (
    <div class="stack">
      <Timelines />
      <div class="seg al-regions">
        {REGIONS.map((r) => (
          <button key={r} class={region === r ? "on" : ""} onClick={() => setRegion(r)}>
            {REGION_LABEL[r]}
            {byRegion[r].length > 0 && <small class="al-n">{byRegion[r].length}</small>}
          </button>
        ))}
      </div>
      <div class="seg">
        {(["warnings", "view", "mine", "all"] as const).map((f) => (
          <button key={f} class={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "warnings" ? "Warnings" : f === "view" ? "In view" : f === "mine" ? "My points" : "All"}
          </button>
        ))}
      </div>
      <div class="al-tools">
        <label class="al-pick" title="Sort by">
          <span class="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label class="al-pick" title="Filter by type">
          <span class="muted small">Type</span>
          <select value={typeSel} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
            <option value="">All types</option>
            {types.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </select>
        </label>
      </div>
      {off && (
        <div class="al-off muted small">
          {REGION_LABEL[region]} alerts are off.{" "}
          <button class="linkish" onClick={() => update((s) => (s.alertCfg = { ...s.alertCfg, regions: { ...(s.alertCfg.regions ?? {}), [region]: true } }))}>
            Turn on
          </button>
        </div>
      )}
      <div class="muted small">{list.length} active</div>
      <div class="alert-list">
        {list.slice(0, 300).map((a) => {
          const p = a.properties;
          return (
            <button
              key={p.id}
              class="alert-row"
              style={{ "--c": p.color }}
              onClick={() => {
                selectedAlert.value = p.id;
                zoomToGeometry(a.geometry);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                alertTypeMenu.value = { x: e.clientX, y: e.clientY, types: [p.event] };
              }}
            >
              <span class="bar" />
              <span class="ev">
                {p.event}
                {p.tag && <span class="atag">{p.tag}</span>}
                {region === "intl" && p.country && <span class="al-cc">{p.country}</span>}
              </span>
              <span class="area">{p.areaDesc}</span>
              <span class="exp">until {fmtTime(Date.parse(p.ends ?? p.expires))}</span>
            </button>
          );
        })}
        {!list.length && <div class="muted">{region === "intl" && !srcs.length ? "This server has no international alert sources (update the server)." : "Nothing active here."}</div>}
      </div>
      {region !== "us" && srcs.length > 0 && (
        <div class="al-attr muted small">
          {region === "ca" ? "Alerts: Environment and Climate Change Canada." : `Alerts: MeteoAlarm (EUMETNET) and ${srcs.length - srcs.filter((s) => s.id.startsWith("ma-")).length} national weather services' official CAP feeds. Fetched while the map looks there or this tab is open.`}
          {failing.length > 0 && <div title={failing.map((s) => `${s.name}: ${s.error}`).join("\n")}>{failing.length} source{failing.length === 1 ? "" : "s"} not answering.</div>}
        </div>
      )}
    </div>
  );
}
