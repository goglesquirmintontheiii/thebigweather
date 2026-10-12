// County FIPS → name / polygon, from the bundled us-atlas county topology (geo/counties-fips.json,
// built by scripts/prep-fips.mjs). Loaded on first use of the SAME decoder.

import { signal } from "@preact/signals";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { EXTRA_COUNTIES } from "./codes";

export const fipsNames = signal<Map<string, string> | null>(null);
let topo: Topology | null = null;
let loading: Promise<void> | null = null;

export function loadFips(): Promise<void> {
  loading ??= fetch("geo/counties-fips.json")
    .then((r) => r.json())
    .then((t: Topology) => {
      topo = t;
      const m = new Map<string, string>(Object.entries(EXTRA_COUNTIES));
      for (const g of (t.objects.counties as GeometryCollection<{ name: string }>).geometries) if (g.id != null) m.set(String(g.id), (g.properties as { name?: string } | undefined)?.name ?? "");
      fipsNames.value = m;
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

export const countyName = (fips: string) => fipsNames.value?.get(fips);

/** GeoJSON polygons for the given 5-digit FIPS codes (a state code with county 000 = the whole state). */
export async function countyFeatures(fips: string[]): Promise<GeoJSON.FeatureCollection> {
  await loadFips();
  if (!topo) return { type: "FeatureCollection", features: [] };
  const want = new Set(fips);
  const states = new Set(fips.filter((f) => f.endsWith("000")).map((f) => f.slice(0, 2)));
  const all = states.has("00");
  const col = topo.objects.counties as GeometryCollection<{ name: string }>;
  const sel = { ...col, geometries: col.geometries.filter((g) => all || want.has(String(g.id)) || states.has(String(g.id).slice(0, 2))) };
  return feature(topo, sel) as unknown as GeoJSON.FeatureCollection;
}
