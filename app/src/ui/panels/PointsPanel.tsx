import { settings, update } from "../../store";
import { addPointAt, mapRef } from "../../map/mapview";
import { Plus, Trash2, Bell, BellOff } from "lucide-preact";
import { Megaphone } from "lucide-preact"; // workflow 0.6
import { runBriefing } from "../../briefing"; // workflow 0.6

const COLORS = ["#4cc9f0", "#f72585", "#ffd166", "#06d6a0", "#ff8c42", "#c77dff"];

export function PointsPanel() {
  const pts = settings.value.points;
  return (
    <div class="stack">
      <p class="muted small">Alerts for your points can notify you. Right-click the map to add a point there.</p>
      <button
        class="btn"
        onClick={() => {
          const c = mapRef.value?.getCenter();
          if (c) addPointAt(c.lat, c.lng);
        }}
      >
        <Plus size={14} /> Add at map center
      </button>
      {pts.map((p, i) => (
        <div key={p.id} class="point-row">
          <button
            class="swatch"
            style={{ background: p.color }}
            title="Change color"
            onClick={() => update((s) => (s.points[i].color = COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length]))}
          />
          <input value={p.name} onChange={(e) => update((s) => (s.points[i].name = (e.target as HTMLInputElement).value))} />
          <button class="icon-btn" title={p.notify ? "Notifications on" : "Notifications off"} onClick={() => update((s) => (s.points[i].notify = !p.notify))}>
            {p.notify ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
          <button class="icon-btn" title="Go to" onClick={() => mapRef.value?.flyTo({ center: [p.lon, p.lat], zoom: Math.max(mapRef.value.getZoom(), 9) })}>
            ⌖
          </button>
          {/* workflow 0.6: spoken briefing for this point */}
          <button class="icon-btn" title="Briefing (spoken summary)" onClick={() => runBriefing(p.id)}>
            <Megaphone size={14} />
          </button>
          <button class="icon-btn danger" title="Delete" onClick={() => update((s) => s.points.splice(i, 1))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!pts.length && <div class="muted">No points yet.</div>}
    </div>
  );
}
