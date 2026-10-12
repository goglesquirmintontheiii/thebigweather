// Per-player SAME monitor: runs the decoder on the player's audio tap and keeps a message log.

import { signal } from "@preact/signals";
import { toast } from "../store";
import { playAlertSound } from "../sound";
import type { AudioTap } from "../audio/tap";
import { SameDecoder, type SameEvent } from "./decoder";
import { encodeSame } from "./encoder";
import { buildHeader, locationName, type SameHeader } from "./parse";
import { loadFips, countyName } from "./fips";

export const SAME_RATE = 24000;

export type SameEntry =
  | { id: number; kind: "header"; at: Date; header: SameHeader | null; raw: string; copies: number; test: boolean }
  | { id: number; kind: "eom"; at: Date; copies: number }
  | { id: number; kind: "tone"; at: Date; tone: "nwr" | "eas"; duration: number };

let nextId = 1;
/** Shared "play a sound on warnings" preference (per viewer). */
export const sameSound = signal(readPref());
function readPref() {
  try {
    return localStorage.getItem("tbw.same.sound") !== "0";
  } catch {
    return true;
  }
}
export function setSameSound(v: boolean) {
  sameSound.value = v;
  try {
    localStorage.setItem("tbw.same.sound", v ? "1" : "0");
  } catch {
    /* */
  }
}

export function areaList(h: SameHeader, max = 99): string {
  const names = h.locations.map((l) => locationName(l, countyName));
  return names.length > max ? `${names.slice(0, max).join("; ")} +${names.length - max} more` : names.join("; ");
}

export class SameMonitor {
  on = signal(false);
  log = signal<SameEntry[]>([]);
  tone = signal<{ kind: "nwr" | "eas"; since: number } | null>(null);
  status = signal("");
  private dec: SameDecoder | null = null;
  private unsub: (() => void) | null = null;
  private testing = false;

  constructor(
    private label: () => string,
    private getTap: () => Promise<AudioTap | null>,
  ) {}

  async start() {
    if (this.on.value) return;
    this.on.value = true;
    loadFips();
    this.dec = new SameDecoder(SAME_RATE, (e) => this.event(e));
    const tap = await this.getTap().catch(() => null);
    if (!this.on.value) return;
    if (!tap) {
      this.status.value = "Audio tap unavailable: test only";
      return;
    }
    this.unsub = tap.subscribe(SAME_RATE, (x) => this.dec?.push(x));
    this.status.value = tap.running ? `Listening (${tap.kind})` : "Audio engine suspended: click play";
  }

  stop() {
    this.on.value = false;
    this.unsub?.();
    this.unsub = null;
    this.dec = null;
    this.tone.value = null;
    this.status.value = "";
  }

  toggle() {
    if (this.on.value) this.stop();
    else this.start();
  }

  clear() {
    this.log.value = [];
  }

  /** Encode a test Tornado Warning (3 Oklahoma counties) and decode it through the same path. */
  async test(event = "TOR", locations = ["040027", "040087", "140109"]) {
    if (this.testing) return;
    this.testing = true;
    try {
      if (!this.on.value) await this.start();
      const hdr = buildHeader({ event, locations, purge: "0045", sender: "KOUN/NWS" });
      const x = encodeSame({ fs: SAME_RATE, header: hdr, tone: "nwr", toneSec: 2, messageSec: 0.5, eom: true, amp: 0.45 });
      this.nextIsTest = true;
      const tap = await this.getTap().catch(() => null);
      if (tap?.running) {
        await tap.playClip(x, SAME_RATE, 0.25);
        await new Promise((r) => setTimeout(r, 400)); // tap blocks still in flight
      } else {
        // no running audio engine: decode the clip directly
        for (let i = 0; i < x.length; i += 4096) this.dec?.push(x.subarray(i, i + 4096));
      }
      // let the 3-burst group time out
      this.dec?.push(new Float32Array(SAME_RATE * 5));
    } finally {
      this.testing = false;
      setTimeout(() => (this.nextIsTest = false), 1000);
    }
  }
  private nextIsTest = false;

  private add(e: SameEntry) {
    this.log.value = [e, ...this.log.value].slice(0, 200);
  }

  private event(e: SameEvent) {
    const at = new Date();
    if (e.type === "tone-start") this.tone.value = { kind: e.kind, since: Date.now() };
    else if (e.type === "tone-end") {
      this.tone.value = null;
      if (e.duration >= 1) this.add({ id: nextId++, kind: "tone", at, tone: e.kind, duration: e.duration });
    } else if (e.type === "eom") this.add({ id: nextId++, kind: "eom", at, copies: e.copies });
    else if (e.type === "header") {
      const test = this.nextIsTest;
      this.add({ id: nextId++, kind: "header", at, header: e.header, raw: e.raw, copies: e.copies, test });
      const h = e.header;
      if (h) {
        const loud = h.level === "warning" || h.level === "emergency";
        toast(`${test ? "[TEST] " : ""}${this.label()} SAME: ${h.eventName} for ${areaList(h, 4)}`, loud ? "alert" : "info", loud ? 12000 : 6000);
        if (loud && sameSound.value) playAlertSound(h.eventName);
      }
    }
  }
}
