// 0.8.3: pure helpers for the animation loop and the timeline (no DOM / store imports, unit-tested).

/** Wheel/trackpad scrubbing: deltas add up and every `threshold` px is one frame step. Reversing
 * direction throws away whatever was gathered for the old direction (no "keeps going the old way
 * for a second"), steps that pile up faster than they can be shown are capped, and inertia events
 * from the old direction that arrive right after a reversal are ignored. */
export class WheelScrub {
  private acc = 0;
  private pending = 0;
  private dir = 0;
  private flipAt = -Infinity;
  constructor(
    public threshold = 40,
    /** most steps queued between two frames */
    public maxPending = 2,
    /** ms after a reversal during which old-direction events are inertia, not input */
    public flipGuardMs = 220,
  ) {}

  /** normalised pixel delta of a WheelEvent-like object (lines and pages scaled to pixels) */
  static delta(e: { deltaX: number; deltaY: number; deltaMode?: number }): number {
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    return e.deltaMode === 1 ? d * 40 : e.deltaMode === 2 ? d * 400 : d;
  }

  /** feed one event; returns the steps now waiting (signed) */
  add(delta: number, now: number): number {
    if (!delta || !Number.isFinite(delta)) return this.pending;
    const s = Math.sign(delta);
    if (this.dir && s !== this.dir) {
      // old-direction inertia right after the user reversed: ignore
      if (now - this.flipAt < this.flipGuardMs && this.prevDir === s) return this.pending;
      this.prevDir = this.dir;
      this.dir = s;
      this.flipAt = now;
      this.acc = 0;
      this.pending = 0;
    } else if (!this.dir) this.dir = s;
    this.acc += delta;
    while (Math.abs(this.acc) >= this.threshold) {
      this.acc -= s * this.threshold;
      if (Math.abs(this.pending) < this.maxPending) this.pending += s;
    }
    return this.pending;
  }
  private prevDir = 0;

  /** steps to apply now (and forget them) */
  take(): number {
    const p = this.pending;
    this.pending = 0;
    return p;
  }

  reset() {
    this.acc = 0;
    this.pending = 0;
    this.dir = 0;
    this.prevDir = 0;
    this.flipAt = -Infinity;
  }
}

/** Whether a playing loop whose last tick ran at `lastTick` has stalled (its timer chain broke). */
export function loopStalled(now: number, lastTick: number, fps: number, dwellMs: number): boolean {
  const expected = Math.max(1000 / Math.max(0.1, fps), dwellMs, 120);
  return now - lastTick > Math.max(2500, expected * 2 + 1000);
}

/** Next frame the loop should show: the first ready one after `cur` (wrapping), -1 when none.
 * A `ready` that throws counts as not ready. */
export function nextReady(cur: number, n: number, ready: (i: number) => boolean): number {
  for (let k = 1; k <= n; k++) {
    const j = (cur + k) % n;
    let ok = false;
    try {
      ok = ready(j);
    } catch {
      ok = false;
    }
    if (ok) return j === cur ? -1 : j;
  }
  return -1;
}
