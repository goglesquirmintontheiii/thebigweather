import { settings, update, connection } from "../store";
import { currentFrame, currentSite, tilts, l3Products, L2_MOMENTS, loading, radarError, liveSweep, liveState, pinned, backToLatest, frames, frameIndex } from "../radar/controller";
import { fmtTime, fmtAge } from "../util";
import { Zap, History, Loader } from "lucide-preact";

const QUICK_L2 = ["REF", "VEL", "SW", "ZDR", "RHO", "PHI"];
const LABEL: Record<string, string> = { REF: "REF", VEL: "VEL", SW: "SW", ZDR: "ZDR", RHO: "CC", PHI: "PHI", CFP: "CFP" };

export function Header() {
  const r = settings.value.radar;
  const site = currentSite.value;
  const f = currentFrame.value;
  const sweep = liveSweep.value && frameIndex.value === frames.value.length - 1 ? liveSweep.value : f?.sweep;
  const t = sweep?.start ?? f?.time ?? 0;
  const age = t ? (Date.now() - t) / 60000 : 999;
  const ageClass = pinned.value ? "hist" : age < 8 ? "fresh" : age < 20 ? "stale" : "old";
  const prodName = r.source === "L2" ? L2_MOMENTS.find((m) => m.id === r.product)?.name : l3Products.value.find((p) => p.id === r.product)?.name;
  const available = new Set(tilts.value.flatMap((t) => t.moments));
  const liveOn = r.source === "L2" && r.live && !pinned.value;
  const partial = liveSweep.value && !liveSweep.value.complete && liveState.value;

  return (
    <div class="header glass">
      <div class="hdr-site">
        <span class="hdr-id">{r.site}</span>
        <span class="hdr-name">{site ? [site.name, site.state].filter(Boolean).join(", ") || site.type : ""}</span>
      </div>
      <div class="hdr-prod">
        <span class="hdr-pname">{prodName ?? r.product}</span>
        {sweep && <span class="hdr-tilt">{sweep.elevation.toFixed(1)}°</span>}
        {sweep?.vcp ? <span class="hdr-vcp">VCP {sweep.vcp}</span> : null}
      </div>
      <div class={`hdr-time ${ageClass}`}>
        {loading.value && <Loader size={13} class="spin" />}
        <span>{t ? fmtTime(t, age > 600) : "—"}</span>
        {t > 0 && !pinned.value && <span class="hdr-age">{fmtAge(t)}</span>}
        {pinned.value && (
          <button class="chip hist" onClick={backToLatest} title="Back to latest">
            <History size={12} /> History · latest
          </button>
        )}
        {liveOn && (
          <span class={`live-dot ${connection.value === "online" ? "on" : ""}`} title="RapidSweep live data">
            <Zap size={11} /> {partial ? `${Math.round(Math.min(100, (liveState.value!.radials / (sweep!.nrad > 400 ? 720 : 360)) * 100))}%` : "LIVE"}
          </span>
        )}
      </div>
      {r.source === "L2" && (
        <div class="quick-products">
          {QUICK_L2.map((m) => (
            <button
              key={m}
              class={`qp ${r.product === m ? "on" : ""} ${available.size && !available.has(m) ? "na" : ""}`}
              onClick={() => update((s) => (s.radar.product = m))}
              title={L2_MOMENTS.find((x) => x.id === m)?.name}
            >
              {LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {radarError.value && <div class="hdr-err">{radarError.value}</div>}
    </div>
  );
}
