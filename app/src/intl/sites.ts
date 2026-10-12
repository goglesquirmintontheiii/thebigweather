// Non-US single-site radars (European ODIM volumes, Canada…): regions, the "Radar sites" filter
// and keeping Level III off for sites that have no Level III.

import { computed, effect } from "@preact/signals";
import { settings, update } from "../store";
import { sites, currentSite, type Site } from "../radar/controller";

/** Fields the server adds for non-NEXRAD sites. */
export type AnySite = Site & { country?: string; region?: string; kind?: string };

export type SiteRegion = "US" | "CA" | "EU" | "OT";
export const REGION_NAMES: Record<SiteRegion, string> = { US: "US", CA: "Canada", EU: "Europe", OT: "Other" };

export function siteRegion(s: AnySite | undefined): SiteRegion {
  if (!s) return "US";
  const c = (s.country ?? "").toUpperCase();
  if (s.region === "EU" || s.kind === "odim") return c === "CA" ? "CA" : "EU";
  if (c === "CA") return "CA";
  if (!c || c === "US" || s.type === "NEXRAD" || s.type === "TDWR") return "US";
  return "OT";
}

/** Sites without Level III products (ODIM volumes). */
export function noLevel3(s: AnySite | undefined): boolean {
  return !!s && (s.kind === "odim" || s.region === "EU" || (!!s.country && s.country.toUpperCase() !== "US" && s.type !== "NEXRAD" && s.type !== "TDWR"));
}

/** Regions present in the site list (the filter only shows when there's more than one). */
export const siteRegions = computed<SiteRegion[]>(() => {
  const set = new Set<SiteRegion>();
  for (const s of sites.value as AnySite[]) set.add(siteRegion(s));
  return (["US", "CA", "EU", "OT"] as SiteRegion[]).filter((r) => set.has(r));
});

/** Hidden regions, stored with the base "sites" layer options. */
export function hiddenRegions(): Set<string> {
  const v = settings.value.ovl["base:sites"]?.opts?.hideRegions ?? "";
  return new Set(v.split(",").filter(Boolean));
}

export function toggleRegion(r: SiteRegion) {
  const h = hiddenRegions();
  if (h.has(r)) h.delete(r);
  else h.add(r);
  update((s) => {
    const o = (s.ovl["base:sites"] = { ...(s.ovl["base:sites"] ?? {}) });
    o.opts = { ...(o.opts ?? {}), hideRegions: [...h].join(",") };
  });
}

export function siteShown(s: AnySite): boolean {
  if (s.id === settings.value.radar.site) return true;
  const h = hiddenRegions();
  return !h.size || !h.has(siteRegion(s));
}

/** Case-insensitive site search (ODIM ids are five letters, sometimes lowercase). */
export function siteMatches(s: AnySite, q: string): boolean {
  const qq = q.trim().toUpperCase();
  if (!qq) return true;
  return s.id.toUpperCase().includes(qq) || !!s.name?.toUpperCase().includes(qq) || s.state?.toUpperCase() === qq || (s.country ?? "").toUpperCase() === qq;
}

// a site without Level III can't stay on a Level III product
effect(() => {
  const s = currentSite.value as AnySite | undefined;
  if (s && noLevel3(s) && settings.value.radar.source === "L3")
    update((x) => {
      x.radar.source = "L2";
      x.radar.product = "REF";
    });
});
