import { useState } from "preact/hooks";
import { alerts, sortedAlerts } from "../../alerts";
import { selectedAlert, settings } from "../../store";
import { mapRef } from "../../map/mapview";
import { fmtTime, pointInGeometry } from "../../util";

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
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 120, maxZoom: 10, duration: 600 });
}

export function AlertsPanel() {
  const [filter, setFilter] = useState<"warnings" | "all" | "mine" | "view">("warnings");
  void alerts.value;
  let list = sortedAlerts();
  const pts = settings.value.points;
  if (filter === "warnings") list = list.filter((a) => String(a.properties.event).endsWith("Warning"));
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
  const counts = new Map<string, number>();
  for (const a of list) counts.set(a.properties.event, (counts.get(a.properties.event) ?? 0) + 1);
  return (
    <div class="stack">
      <div class="seg">
        {(["warnings", "view", "mine", "all"] as const).map((f) => (
          <button key={f} class={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "warnings" ? "Warnings" : f === "view" ? "In view" : f === "mine" ? "My points" : "All"}
          </button>
        ))}
      </div>
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
            >
              <span class="bar" />
              <span class="ev">
                {p.event}
                {p.tag && <span class="atag">{p.tag}</span>}
              </span>
              <span class="area">{p.areaDesc}</span>
              <span class="exp">until {fmtTime(Date.parse(p.ends ?? p.expires))}</span>
            </button>
          );
        })}
        {!list.length && <div class="muted">Nothing active here.</div>}
      </div>
    </div>
  );
}
