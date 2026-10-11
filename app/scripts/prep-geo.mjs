// Builds the bundled offline boundary layers from us-atlas / world-atlas.
import { readFileSync, writeFileSync } from "node:fs";
import { feature, mesh } from "topojson-client";

const round = (g) => JSON.parse(JSON.stringify(g, (k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)));
const out = (name, g) => {
  const s = JSON.stringify(round(g));
  writeFileSync(`public/geo/${name}.json`, s);
  console.log(name, (s.length / 1024).toFixed(0), "KB");
};

const us = JSON.parse(readFileSync("node_modules/us-atlas/counties-10m.json", "utf8"));
out("counties", { type: "Feature", properties: {}, geometry: mesh(us, us.objects.counties, (a, b) => a !== b && ((a.id / 1000) | 0) === ((b.id / 1000) | 0)) });
out("states", { type: "Feature", properties: {}, geometry: mesh(us, us.objects.states, (a, b) => a !== b) });

const world = JSON.parse(readFileSync("node_modules/world-atlas/countries-50m.json", "utf8"));
out("land", feature(world, world.objects.land));
out("borders", { type: "Feature", properties: {}, geometry: mesh(world, world.objects.countries, (a, b) => a !== b) });
