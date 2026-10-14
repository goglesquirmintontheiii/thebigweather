// 0.8.1: scanner audio mix — which stations play, at what volume, muted or not (pure, tested).

export interface MixEntry {
  /** 0..1 */
  vol: number;
  mute?: boolean;
}
export interface MixCfg {
  stations: { id: string }[];
  /** play audio at all */
  audio: boolean;
  mix?: Record<string, MixEntry>;
  /** only this station is heard (the others stay connected, muted) */
  solo?: string | null;
}
export interface MixPlan {
  /** stations that need a player */
  ids: string[];
  muted: Record<string, boolean>;
  vol: Record<string, number>;
  /** the station heard alone (solo or the station that fired), if any */
  solo: string | null;
}

/** `lock`: a station that sent an alert — it joins the mix (if needed) and is heard alone. */
export function mixPlan(c: MixCfg, lock: string | null, master = 1): MixPlan {
  const have = new Set(c.stations.map((s) => s.id));
  const mix = c.mix ?? {};
  const ids = Object.keys(mix).filter((id) => have.has(id));
  if (lock && have.has(lock) && !ids.includes(lock)) ids.push(lock);
  const solo = lock && have.has(lock) ? lock : c.solo && ids.includes(c.solo) ? c.solo : null;
  const muted: Record<string, boolean> = {};
  const vol: Record<string, number> = {};
  for (const id of ids) {
    muted[id] = !c.audio || (solo ? id !== solo : !!mix[id]?.mute);
    const v = mix[id]?.vol ?? 1;
    vol[id] = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1)) * Math.max(0, Math.min(1, master));
  }
  return { ids, muted, vol, solo };
}

/** Add or remove stations from the mix (keeps volumes of those that stay). */
export function setMix(cur: Record<string, MixEntry> | undefined, ids: string[], on: boolean): Record<string, MixEntry> {
  const out: Record<string, MixEntry> = { ...(cur ?? {}) };
  for (const id of ids) {
    if (on) out[id] ??= { vol: 1 };
    else delete out[id];
  }
  return out;
}
