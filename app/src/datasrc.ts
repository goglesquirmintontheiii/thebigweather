// 0.8.4: data sources that can be switched off (Settings → Data sources). The server owns the
// list and stops its own requests; this module knows what's off, gates what the app fetches
// itself (basemaps, satellite imagery), and raises the "this source is disabled" warning.

import { signal } from "@preact/signals";
import { api } from "./api";
import { toast } from "./store";
import { warnText } from "./datasrcCore";

export interface DataSource {
  id: string;
  name: string;
  group: string;
  enabled: boolean;
}

export const dataSources = signal<DataSource[]>([]);
/** overlay feed → data source */
export const feedSources = signal<Record<string, string>>({});
export const dsOff = signal<ReadonlySet<string>>(new Set());
/** the warning on screen */
export const dsWarning = signal<{ id: string; text: string; name: string } | null>(null);

export const dsIsOff = (id: string | null | undefined) => !!id && dsOff.value.has(id);

function setOff(off: string[]) {
  const nextOff = new Set(off);
  // a source back on may warn again next time
  for (const k of [...warned]) if (!nextOff.has(k.split("|")[0])) warned.delete(k);
  dsOff.value = nextOff;
  dataSources.value = dataSources.peek().map((s) => ({ ...s, enabled: !nextOff.has(s.id) }));
}

async function load() {
  try {
    const r = await api.get("/api/datasources");
    feedSources.value = r.feeds ?? {};
    dataSources.value = r.sources ?? [];
    setOff((r.sources ?? []).filter((s: DataSource) => !s.enabled).map((s: DataSource) => s.id));
  } catch {
    /* older server, or a shared view: nothing to gate */
  }
}

api.on("connected", load);
api.on("hello", (m) => Array.isArray(m.ds_off) && setOff(m.ds_off));
api.on("datasources", (m) => Array.isArray(m.off) && setOff(m.off));

export async function setDataSource(id: string, enabled: boolean) {
  try {
    const r = await api.send("PUT", "/api/datasources", { id, enabled });
    setOff(r.off ?? []);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

let timer: number | undefined;
const warned = new Set<string>();
const queue: { id: string; text: string; name: string }[] = [];

function next() {
  clearTimeout(timer);
  const w = queue.shift() ?? null;
  dsWarning.value = w;
  if (w) timer = window.setTimeout(next, 10000);
}

/** close the warning; another waiting one shows next */
export const dismissDsWarning = () => next();

/** Warn once per source and kind of thing until the source is switched back on. */
export function warnDisabled(id: string, kind: string) {
  const key = `${id}|${kind}`;
  if (warned.has(key)) return;
  warned.add(key);
  const name = dataSources.peek().find((s) => s.id === id)?.name ?? id;
  queue.push({ id, text: warnText(kind), name });
  if (!dsWarning.peek()) next();
}
