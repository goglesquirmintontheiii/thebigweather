// County polygons with FIPS ids + names (TopoJSON) for the SAME decoder: names for PSSCCC
// location codes and "show on map" highlighting. Output: public/geo/counties-fips.json
import { readFileSync, writeFileSync } from "node:fs";

const us = JSON.parse(readFileSync("node_modules/us-atlas/counties-10m.json", "utf8"));
const out = { type: "Topology", bbox: us.bbox, transform: us.transform, objects: { counties: us.objects.counties }, arcs: us.arcs };
const s = JSON.stringify(out);
writeFileSync("public/geo/counties-fips.json", s);
console.log("counties-fips", (s.length / 1024).toFixed(0), "KB,", us.objects.counties.geometries.length, "counties");
