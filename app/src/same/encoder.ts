// SAME AFSK encoder (for the in-app self-test and the unit tests).

import { BAUD, MARK, SPACE } from "./decoder";

export interface EncodeOpts {
  fs: number;
  header: string;
  /** attention signal after the headers: "nwr" = 1050 Hz, "eas" = 853 + 960 Hz, null = none */
  tone?: "nwr" | "eas" | null;
  toneSec?: number;
  /** seconds of (silent) "voice message" between the tone and the EOM */
  messageSec?: number;
  eom?: boolean;
  amp?: number;
  /** multiply the AFSK frequencies / baud rate, to simulate a mistuned or drifting encoder */
  freqScale?: number;
  baudScale?: number;
  leadSec?: number;
}

export function encodeSame(o: EncodeOpts): Float32Array {
  const { fs } = o;
  const amp = o.amp ?? 0.5;
  const parts: Float32Array[] = [];
  const silence = (s: number) => parts.push(new Float32Array(Math.round(s * fs)));
  let ph = 0;
  const afsk = (text: string) => {
    const bytes = [...new Array(16).fill(0xab), ...[...text].map((c) => c.charCodeAt(0))];
    const baud = BAUD * (o.baudScale ?? 1);
    const nBits = bytes.length * 8;
    const n = Math.ceil((nBits / baud) * fs);
    const out = new Float32Array(n);
    const fm = MARK * (o.freqScale ?? 1);
    const fsp = SPACE * (o.freqScale ?? 1);
    for (let i = 0; i < n; i++) {
      const bi = Math.min(nBits - 1, Math.floor((i / fs) * baud));
      const bit = (bytes[bi >> 3] >> (bi & 7)) & 1; // LSB first
      ph += (2 * Math.PI * (bit ? fm : fsp)) / fs;
      out[i] = amp * Math.sin(ph);
    }
    parts.push(out);
  };
  silence(o.leadSec ?? 0.5);
  for (let r = 0; r < 3; r++) {
    afsk(o.header);
    silence(1);
  }
  if (o.tone) {
    const n = Math.round((o.toneSec ?? 8) * fs);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i / fs;
      t[i] = o.tone === "nwr" ? amp * Math.sin(2 * Math.PI * 1050 * s) : (amp / 2) * (Math.sin(2 * Math.PI * 853 * s) + Math.sin(2 * Math.PI * 960 * s));
    }
    parts.push(t);
    silence(1);
  }
  if (o.messageSec) silence(o.messageSec);
  if (o.eom) {
    for (let r = 0; r < 3; r++) {
      afsk("NNNN");
      silence(1);
    }
  }
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}
