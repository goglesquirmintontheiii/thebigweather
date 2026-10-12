// Detection models window: small shared pieces.

import { Server, Laptop, HelpCircle } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { tmeta, targetIconUrl } from "../../ml/targets";
import { canLocal, epName, localIsMain, localState } from "../../ml/client";
import { hasDesktop } from "../../share/desktop";
import type { Ep } from "../../ml/types";
import { settings } from "../../store";

export function TIcon({ t, size = 20 }: { t: string; size?: number }) {
  return <img class="ml-ticon" src={targetIconUrl(t, size)} width={size} height={size} alt={tmeta(t).code} title={tmeta(t).name} />;
}

export function EpBadge({ ep }: { ep: Ep }) {
  const local = ep === "local" || localIsMain.value;
  return (
    <span class={`ml-ep ${local ? "local" : ""}`} title={local ? "Runs on this computer (the server built into the app)" : "Runs on the server"}>
      {local ? <Laptop size={11} /> : <Server size={11} />} {local ? "This computer" : "Server"}
    </span>
  );
}

/** Server / This computer switch */
export function WhereToggle({ value, onChange, verb = "Train" }: { value: Ep; onChange: (e: Ep) => void; verb?: string }) {
  const local = canLocal();
  const why = !hasDesktop() ? "Needs the desktop app" : localIsMain.value ? "The active server already runs in this app" : localState.value === "unavailable" ? "This build has no bundled server" : "";
  return (
    <div class="seg ml-where">
      <button class={value === "main" ? "on" : ""} onClick={() => onChange("main")} title={`${verb} on ${epName("main")}`}>
        <Server size={13} /> Server
      </button>
      <button class={value === "local" && local ? "on" : ""} disabled={!local || localState.value === "unavailable"} onClick={() => onChange("local")} title={why || `${verb} on this computer with the server built into the app (started automatically; keep the app open)`}>
        <Laptop size={13} /> This computer
      </button>
    </div>
  );
}

export function Help({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span class="ml-help" title={text}>
      <HelpCircle size={12} />
    </span>
  );
}

export function Field({ label, help, children, wide }: { label: ComponentChildren; help?: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <label class={`ml-field ${wide ? "wide" : ""}`}>
      <span class="ml-flabel">
        {label} <Help text={help} />
      </span>
      {children}
    </label>
  );
}

export const pct = (v: number | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
export const f2 = (v: number | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
export function fmtDur(s: number | undefined | null) {
  if (s == null || !Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.round((s % 86400) / 3600)} h`;
}
export function fmtDay(t?: number) {
  if (!t) return "—";
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: settings.value.utc ? "UTC" : undefined });
}

/** POD/FAR/CSI at a threshold from the reliability bins (or the server's curve). */
export function scoresAt(m: { reliability?: { p: number; obs: number; n: number }[]; curve?: { t: number; pod: number; far: number; csi: number; pofd?: number }[] } | undefined, t: number) {
  if (!m) return null;
  if (m.curve?.length) {
    let best = m.curve[0];
    for (const c of m.curve) if (Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
    return { pod: best.pod, far: best.far, csi: best.csi, pofd: best.pofd ?? NaN, alerts: NaN };
  }
  const bins = m.reliability ?? [];
  if (!bins.length) return null;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const b of bins) {
    const pos = b.obs * b.n, neg = (1 - b.obs) * b.n;
    if (b.p >= t) (tp += pos), (fp += neg);
    else (fn += pos), (tn += neg);
  }
  return { pod: tp + fn ? tp / (tp + fn) : NaN, far: tp + fp ? fp / (tp + fp) : NaN, csi: tp + fp + fn ? tp / (tp + fp + fn) : NaN, pofd: fp + tn ? fp / (fp + tn) : NaN, alerts: tp + fp };
}
