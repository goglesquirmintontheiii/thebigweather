import { selectedAlert } from "../store";
import { alerts } from "../alerts";
import { fmtTime } from "../util";
import { zoomToGeometry } from "./panels/AlertsPanel";
import { X, Maximize2 } from "lucide-preact";

export function AlertDetail() {
  const id = selectedAlert.value;
  if (!id) return null;
  const a = alerts.value.get(id);
  if (!a) return null;
  const p = a.properties;
  const fl = p.flags ?? {};
  const facts: [string, string][] = [];
  if (fl.tornado_detection) facts.push(["Tornado", fl.tornado_detection]);
  if (fl.tornado_damage_threat) facts.push(["Damage threat", fl.tornado_damage_threat]);
  if (fl.thunderstorm_damage_threat) facts.push(["Damage threat", fl.thunderstorm_damage_threat]);
  if (fl.flash_flood_damage_threat) facts.push(["Flood threat", fl.flash_flood_damage_threat]);
  if (fl.max_hail) facts.push(["Max hail", `${fl.max_hail} in`]);
  if (fl.max_wind) facts.push(["Max wind", fl.max_wind]);
  return (
    <div class="alert-detail glass" style={{ "--c": p.color }}>
      <div class="ad-head">
        <span class="bar" />
        <div>
          <h3>{p.event}</h3>
          {p.tag && <span class="atag big">{p.tag}</span>}
          <div class="muted small">
            {p.senderName} · until {fmtTime(Date.parse(p.ends ?? p.expires), true)}
          </div>
        </div>
        <button class="icon-btn" title="Zoom to" onClick={() => zoomToGeometry(a.geometry)}>
          <Maximize2 size={15} />
        </button>
        <button class="icon-btn" onClick={() => (selectedAlert.value = null)}>
          <X size={16} />
        </button>
      </div>
      {facts.length > 0 && (
        <div class="facts">
          {facts.map(([k, v]) => (
            <span key={k + v}>
              <small>{k}</small>
              <b>{v}</b>
            </span>
          ))}
        </div>
      )}
      <div class="ad-body">
        {p.nws_headline && <p class="hl">{p.nws_headline}</p>}
        <p class="area">{p.areaDesc}</p>
        <pre>{p.description}</pre>
        {p.instruction && <pre class="instr">{p.instruction}</pre>}
      </div>
    </div>
  );
}
