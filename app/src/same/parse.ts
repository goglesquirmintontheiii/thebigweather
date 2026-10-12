// SAME header parsing: ZCZC-ORG-EEE-PSSCCC(-PSSCCC…)+TTTT-JJJHHMM-LLLLLLLL-

import { ORIGINATORS, eventInfo, PART, STATES, MARINE, EXTRA_COUNTIES, type EventLevel } from "./codes";

export interface SameLocation {
  code: string; // PSSCCC
  part: string; // "" = whole area, else "Northwest" …
  state: string; // SS
  county: string; // CCC
  fips: string; // SSCCC
  marine: boolean;
}

export interface SameHeader {
  raw: string;
  org: string;
  orgName: string;
  event: string;
  eventName: string;
  level: EventLevel;
  locations: SameLocation[];
  purge: string; // TTTT
  purgeMin: number;
  issued: Date;
  expires: Date;
  sender: string;
}

const RX = /ZCZC-([A-Z]{3})-([A-Z0-9]{3})-((?:\d{6}-?){1,31})\+(\d{4})-(\d{7})-([^-]{1,8})-/;

/** Parse a header (leading/trailing junk is ignored). `now` resolves the year of the Julian day. */
export function parseHeader(text: string, now = new Date()): SameHeader | null {
  const m = RX.exec(text);
  if (!m) return null;
  const [, org, event, locs, purge, jjjhhmm, sender] = m;
  const pH = +purge.slice(0, 2);
  const pM = +purge.slice(2);
  const jd = +jjjhhmm.slice(0, 3);
  const hh = +jjjhhmm.slice(3, 5);
  const mm = +jjjhhmm.slice(5, 7);
  if (jd < 1 || jd > 366 || hh > 23 || mm > 59 || pM > 59) return null;
  const mk = (y: number) => new Date(Date.UTC(y, 0, 1, hh, mm) + (jd - 1) * 86400000);
  let issued = mk(now.getUTCFullYear());
  // a header from late December heard in early January (or a skewed clock)
  if (issued.getTime() - now.getTime() > 2 * 86400000) issued = mk(now.getUTCFullYear() - 1);
  else if (now.getTime() - issued.getTime() > 300 * 86400000) issued = mk(now.getUTCFullYear() + 1);
  const ev = eventInfo(event);
  const locations = locs
    .split("-")
    .filter((s) => s.length === 6)
    .map((c) => ({ code: c, part: PART[c[0]] ?? "", state: c.slice(1, 3), county: c.slice(3), fips: c.slice(1), marine: !!MARINE[c.slice(1, 3)] }));
  return {
    raw: m[0],
    org,
    orgName: ORIGINATORS[org] ?? `Unknown originator (${org})`,
    event,
    eventName: ev.name,
    level: ev.level,
    locations,
    purge,
    purgeMin: pH * 60 + pM,
    issued,
    expires: new Date(issued.getTime() + (pH * 60 + pM) * 60000),
    sender: sender.trim(),
  };
}

/** Human name for a location. `county` looks up SSCCC → county name (from the bundled geo data). */
export function locationName(l: SameLocation, county?: (fips: string) => string | undefined): string {
  const pre = l.part ? `${l.part} ` : "";
  if (l.state === "00") return `${pre}United States (all)`;
  if (l.marine) return `${pre}${MARINE[l.state]} zone ${l.county}`;
  const st = STATES[l.state];
  if (!st) return `${pre}area ${l.code}`;
  if (l.county === "000") return `${pre}${st[1]} (entire state)`;
  const n = county?.(l.fips) ?? EXTRA_COUNTIES[l.fips];
  if (!n) return `${pre}county ${l.county}, ${st[0]}`;
  const suffix = /city|borough|census area|municipality|planning region|parish/i.test(n) || l.state === "72" ? "" : l.state === "22" ? " Parish" : l.state === "02" ? "" : " Co.";
  return `${pre}${n}${suffix}, ${st[0]}`;
}

/** Build a header string (used by the encoder self-test). */
export function buildHeader(o: { org?: string; event: string; locations: string[]; purge?: string; issued?: Date; sender?: string }): string {
  const d = o.issued ?? new Date();
  const jd = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const p2 = (n: number, w = 2) => String(n).padStart(w, "0");
  const sender = (o.sender ?? "KOUN/NWS").padEnd(8, " ").slice(0, 8);
  return `ZCZC-${o.org ?? "WXR"}-${o.event}-${o.locations.join("-")}+${o.purge ?? "0030"}-${p2(jd, 3)}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}-${sender}-`;
}
