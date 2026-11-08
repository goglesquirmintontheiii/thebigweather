// Info panel: alerts (and watches, storms, MDs) under a click, with arrows to step through them.

import { details, type DetailItem } from "../store";
import { alerts } from "../alerts";
import { fmtTime } from "../util";
import { zoomToGeometry, alertTypeMenu } from "./panels/AlertsPanel"; // 0.8.2: alertTypeMenu
import { Maximize2, ChevronLeft, ChevronRight, ExternalLink } from "lucide-preact";
import { useEffect, useLayoutEffect } from "preact/hooks";
import { WinButtons, IN_OS_WIN, POP_WIN, isMin, isMax, minimize, unminimize, toggleMax, forget, canPop, popWindow, onBarDbl } from "./winframe"; // 0.8.3
import { History } from "lucide-preact"; // history 0.6
import { beforeAfter } from "../histsearch"; // history 0.6
import { useState } from "preact/hooks"; // p7
import { ReplayPopover } from "./HistStorms"; // p7: replay window popover
import { Languages } from "lucide-preact"; // 0.8.3
import { settings } from "../store"; // 0.8.3
import { api } from "../api"; // 0.8.3
import { offerTranslate } from "../trlang"; // 0.8.3
import "./alerts083.css"; // 0.8.3

/* ---------- 0.8.3: Translate non-English alert text (server: free endpoint → glossary fallback) ---------- */
type TrRes = { parts?: string[]; engine?: string; engine_name?: string; partial?: boolean; error?: string };
const trCache = new Map<string, TrRes>();

function AlertText({ p }: { p: any }) {
  const cfg = settings.value.alertCfg;
  const lang = offerTranslate(cfg.trShow, p);
  const engine = cfg.trEngine ?? "mymemory";
  const ck = `${p.id}|${engine}|${p.sent ?? ""}`;
  const [res, setRes] = useState<TrRes | null>(() => trCache.get(ck) ?? null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const body = p.description || (p.headline && p.headline !== p.event ? p.headline : "");
  const run = async () => {
    if (res) return setOn(!on);
    setBusy(true);
    setErr("");
    try {
      const r: TrRes = await api.send("POST", "/api/alerts/translate", { parts: [p.areaDesc ?? "", body, p.instruction ?? "", p.event ?? ""], from: lang === "auto" ? "" : lang, engine });
      trCache.set(ck, r);
      setRes(r);
      setOn(true);
    } catch (e: any) {
      setErr(e?.status === 404 ? "Update the server to translate" : e.message);
    } finally {
      setBusy(false);
    }
  };
  const t = on && res?.parts ? res.parts : null;
  return (
    <>
      {t?.[3] && t[3] !== p.event && <p class="hl">{t[3]}</p>}
      <p class="area">{t?.[0] || p.areaDesc}</p>
      {lang && (
        <div class="ad-tr">
          <button class={`btn sm ghost ${on ? "on" : ""}`} onClick={run} disabled={busy} title={on ? "Show the original text" : "Translate to English"}>
            <Languages size={13} /> {busy ? "Translating…" : on ? "Original" : "Translate"}
          </button>
          {on && res && (
            <span class={`muted ad-tr-note ${res.error ? "ad-tr-err" : ""}`} title={res.error ? `${res.engine_name ?? "Service"} failed: ${res.error}` : undefined}>
              {res.partial ? `Glossary (partial)${res.error ? " · service unavailable" : ""}` : `Machine translation · ${res.engine_name}`}
            </span>
          )}
          {err && <span class="ad-tr-note ad-tr-err">{err}</span>}
        </div>
      )}
      <pre>{t?.[1] || body}</pre>
      {p.instruction && <pre class="instr">{t?.[2] || p.instruction}</pre>}
    </>
  );
}

/** 0.8.3: the info panel's window frame (title bar with the window buttons) */
type Frame = { cls: string; bar: any };

function AlertBody({ id, nav, fr }: { id: string; nav: any; fr: Frame }) {
  const a = alerts.value.get(id);
  const [replay, setReplay] = useState(false); // p7 (before the early return: stable hook order)
  if (!a) return <OvlBody p={{ title: "Alert expired", rows: [] }} nav={nav} fr={fr} />;
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
    <div class={`alert-detail glass${fr.cls}`} style={{ "--c": p.color }}>
      {fr.bar}
      {/* 0.8.2: right-click → layer options for this type */}
      <div
        class="ad-head"
        onContextMenu={(e) => {
          e.preventDefault();
          alertTypeMenu.value = { x: e.clientX, y: e.clientY, types: [p.event] };
        }}
      >
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
        <button class="btn sm ghost ad-replay" title={`Replay in history mode: pick the window (default ${beforeAfter().before} min before it began to ${beforeAfter().after} min after it ended), on the nearest radar`} aria-expanded={replay} onClick={() => setReplay(!replay)}>
          <History size={13} /> Replay
        </button>
        {replay && <ReplayPopover a={a} onClose={() => setReplay(false)} />}
        <button class="icon-btn" title="Zoom to" onClick={() => zoomToGeometry(a.geometry)}>
          <Maximize2 size={15} />
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
        <AlertText key={p.id} p={p} /> {/* 0.8.3: area, text, instruction + Translate */}
        {/* 0.8.2: Canada / international: source, unmapped areas, links */}
        {p.geom_note && <p class="muted small">{p.geom_note}</p>}
        {p.attribution && <p class="muted small ad-attr">Source: {p.attribution}</p>}
        {(p.link || p.cap_url) && (
          <div class="pop-actions">
            {p.link && (
              <button class="btn sm ghost" onClick={() => window.open(p.link, "_blank")}>
                <ExternalLink size={13} /> Details
              </button>
            )}
            {p.cap_url && (
              <button class="btn sm ghost" onClick={() => window.open(p.cap_url, "_blank")}>
                <ExternalLink size={13} /> CAP message
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OvlBody({ p, nav, fr }: { p: any; nav: any; fr: Frame }) {
  return (
    <div class={`alert-detail glass${fr.cls}`} style={{ "--c": p.color ?? "#94a3b8" }}>
      {fr.bar}
      <div class="ad-head">
        <span class="bar" />
        <div>
          <h3>{p.title}</h3>
          {p.sub && <div class="muted small">{p.sub}</div>}
          {nav}
        </div>
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

/** 0.8.3: window id of the info panel (it can pop out, minimize, maximize) */
export const AD_ID = "a:detail";

export function AlertDetail() {
  const d = details.value;
  const os = IN_OS_WIN && POP_WIN === AD_ID;
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
  // 0.8.3: a newly clicked alert brings a minimized panel back
  useEffect(() => {
    if (d && !os && isMin(AD_ID)) unminimize(AD_ID);
  }, [d]);
  useLayoutEffect(() => {
    if (!d && !os) forget(AD_ID);
  }, [!d]);
  if (!d || !d.items.length) return null;
  const i = Math.min(d.i, d.items.length - 1);
  const it = d.items[i];
  const n = d.items.length;
  /* 0.8.3: window title bar (close · minimize · maximize · pop out), like every other window */
  const close = () => (details.value = null);
  const max = !os && isMax(AD_ID);
  const zoom = () => toggleMax(AD_ID);
  const fr: Frame = {
    cls: `${!os && isMin(AD_ID) ? " wf-minimized" : ""}${max ? " wf-max" : ""}${os ? " wf-osframe" : ""}`,
    bar: (
      <div class="ad-wbar wf-bar" onDblClick={os ? undefined : (onBarDbl(zoom) as any)}>
        <WinButtons os={os} onClose={close} onMin={() => minimize(AD_ID, label(it), undefined, close)} onZoom={zoom} zoomed={max} onPop={!os && canPop(AD_ID) ? () => popWindow(AD_ID) : undefined} />
        <span class="ad-wtitle">{it.kind === "alert" ? "Alert" : "Details"}</span>
      </div>
    ),
  };
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
  return it.kind === "alert" ? <AlertBody id={it.id} nav={nav} fr={fr} /> : <OvlBody p={it.p} nav={nav} fr={fr} />;
}

function step(dir: number) {
  const d = details.value;
  if (!d) return;
  details.value = { ...d, i: (d.i + dir + d.items.length) % d.items.length };
}
