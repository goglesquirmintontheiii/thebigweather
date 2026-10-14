// 0.8.1: crash-loop guard (pure functions; main.cjs keeps the state in <userData>/crashguard.json).
// A start that never became "stable" (window alive for STABLE_MS) counts as a failed start, so does a
// renderer crash within that time. Two failed starts in a row → the next start is in safe mode.

const STABLE_MS = 60_000;
const FAILS_FOR_SAFE = 2;

/** @typedef {{ fails: number, pending: number }} GuardState */

/** @param {any} s @returns {GuardState} */
function norm(s) {
  return { fails: Math.max(0, Number(s && s.fails) || 0), pending: Number(s && s.pending) || 0 };
}

/**
 * App start. `pending` set = the previous start didn't reach stable and didn't report a crash
 * (killed, frozen and force-closed, main process died) → that start failed.
 * @param {any} state @param {number} now @param {{ flag?: boolean }} [opt]
 * @returns {{ safe: boolean, reason: string, state: GuardState }}
 */
function onStart(state, now, opt = {}) {
  const s = norm(state);
  const fails = s.pending ? s.fails + 1 : s.fails;
  const crashLoop = fails >= FAILS_FOR_SAFE;
  return { safe: !!opt.flag || crashLoop, reason: opt.flag ? "flag" : crashLoop ? "crash" : "", state: { fails, pending: now } };
}

/** The window stayed up long enough: a good start. @returns {GuardState} */
function onStable() {
  return { fails: 0, pending: 0 };
}

/**
 * The renderer died. Within the startup window it counts as a failed start (and clears `pending`
 * so the same start isn't counted twice); later crashes don't feed the loop guard.
 * @param {any} state @param {number} now @param {number} loadedAt
 * @returns {{ state: GuardState, early: boolean }}
 */
function onCrash(state, now, loadedAt) {
  const s = norm(state);
  const early = !loadedAt || now - loadedAt < STABLE_MS;
  if (!early) return { state: s, early };
  return { state: { fails: s.fails + 1, pending: 0 }, early };
}

/** A clean quit before reaching stable is not a failure. @returns {GuardState} */
function onCleanQuit(state) {
  const s = norm(state);
  return { fails: s.fails, pending: 0 };
}

/**
 * Settings for a safe start: one map (no panes), no satellite imagery or 3D. Same logic as the copy
 * in preload.cjs (the sandboxed preload can't require this file) — keep them in sync.
 * @param {any} s
 */
function safeSettings(s) {
  const o = { ...(s || {}) };
  o.panes = { ...((s && s.panes) || {}), layout: "1" };
  const w = (s && s.weather) || {};
  if (w.kind === "gibs" || (w.kind === "grid" && /^goes\//.test(String(w.id || "")))) o.weather = { kind: "radar" };
  if (o.view3d) o.view3d = { ...o.view3d, on: false };
  return o;
}

module.exports = { STABLE_MS, FAILS_FOR_SAFE, onStart, onStable, onCrash, onCleanQuit, safeSettings };
