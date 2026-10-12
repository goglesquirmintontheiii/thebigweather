// Info panel: alerts (and watches, storms, MDs) under a click, with arrows to step through them.

import { details, type DetailItem } from "../store";
import { alerts } from "../alerts";
import { fmtTime } from "../util";
import { zoomToGeometry } from "./panels/AlertsPanel";
import { X, Maximize2, ChevronLeft, ChevronRight, ExternalLink } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { History } from "lucide-preact"; // history 0.6
import { replayAlert, beforeAfter } from "../histsearch"; // history 0.6

function AlertBody({ id, nav }: { id: string; nav: any }) {
  const a = alerts.value.get(id);
  if (!a) return <OvlBody p={{ title: "Alert expired", rows: [] }} nav={nav} />;
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
          {nav}
        </div>
        {/* history 0.6: replay this alert's event ± before/after */}
        <button class="btn sm ghost ad-replay" title={`Replay this in history mode: from ${beforeAfter().before} min before it began to ${beforeAfter().after} min after it ended, on the nearest radar (change in Historical Storms)`} onClick={() => replayAlert(a)}>
          <History size={13} /> Replay this
        </button>
        <button class="icon-btn" title="Zoom to" onClick={() => zoomToGeometry(a.geometry)}>
          <Maximize2 size={15} />
        </button>
        <button class="icon-btn" title="Close (Esc)" onClick={() => (details.value = null)}>
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

function OvlBody({ p, nav }: { p: any; nav: any }) {
  return (
    <div class="alert-detail glass" style={{ "--c": p.color ?? "#94a3b8" }}>
      <div class="ad-head">
        <span class="bar" />
        <div>
          <h3>{p.title}</h3>
          {p.sub && <div class="muted small">{p.sub}</div>}
          {nav}
        </div>
        <button class="icon-btn" title="Close (Esc)" onClick={() => (details.value = null)}>
          <X size={16} />
        </button>
      </div>
      {p.rows?.length > 0 && (
        <div class="facts wide">
          {p.rows.map(([k, v]: [string, string]) => (
            <span key={k}>
              <small>{k}</small>
              <b>{v}</b>
            </span>
          ))}
        </div>
      )}
      <div class="ad-body">
        {p.text && <pre>{p.text}</pre>}
        <div class="pop-actions">
          {[...(p.links ?? []), ...(p.link ? [p.link] : [])].map(([label, url]: [string, string]) => (
            <button key={url} class="btn sm ghost" onClick={() => window.open(url, "_blank")}>
              <ExternalLink size={13} /> {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function label(it: DetailItem) {
  if (it.kind === "alert") return alerts.value.get(it.id)?.properties.event ?? "Alert";
  return it.p.title;
}

export function AlertDetail() {
  const d = details.value;
  useEffect(() => {
    if (!d || d.items.length < 2) return;
    const key = (e: KeyboardEvent) => {
      const tg = (e.target as HTMLElement)?.tagName;
      if (tg === "INPUT" || tg === "TEXTAREA" || tg === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
      // (`,` / `.` belong to the legend filter)
      if (e.key === "[") step(-1);
      if (e.key === "]") step(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [d?.items.length]);
  if (!d || !d.items.length) return null;
  const i = Math.min(d.i, d.items.length - 1);
  const it = d.items[i];
  const n = d.items.length;
  const nav =
    n > 1 ? (
      <div class="ad-nav" title={d.items.map((x, k) => `${k + 1}. ${label(x)}`).join("\n")}>
        <button class="icon-btn" onClick={() => step(-1)} title="Previous ( [ )">
          <ChevronLeft size={16} />
        </button>
        <span>
          {i + 1}/{n}
        </span>
        <button class="icon-btn" onClick={() => step(1)} title="Next ( ] )">
          <ChevronRight size={16} />
        </button>
      </div>
    ) : null;
  return it.kind === "alert" ? <AlertBody id={it.id} nav={nav} /> : <OvlBody p={it.p} nav={nav} />;
}

function step(dir: number) {
  const d = details.value;
  if (!d) return;
  details.value = { ...d, i: (d.i + dir + d.items.length) % d.items.length };
}
