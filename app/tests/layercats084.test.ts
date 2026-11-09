// 0.8.4: Layers tab categories.
import assert from "node:assert/strict";
import { LAYER_CATS, catOfGroup, groupsOfCat, catCounts } from "../src/ui/layercats";

export function testEveryGroupHasOneCategory() {
  const groups = LAYER_CATS.flatMap((c) => c.groups);
  assert.equal(new Set(groups).size, groups.length, "no group in two categories");
  for (const g of ["Alerts & warnings", "Severe", "Tropical", "Precipitation & winter", "Outlooks", "Observations", "Aviation", "Marine", "Hazards", "Environment & health", "Traffic & roads", "Cameras", "Space", "Chasers & reports", "Reference", "My files", "Fun"]) assert.ok(groups.includes(g), g);
  assert.equal(catOfGroup("Aviation"), "travel");
  assert.equal(catOfGroup("Brand new group"), "more");
}

export function testUnknownGroupsStayVisible() {
  const more = LAYER_CATS.find((c) => c.id === "more")!;
  const g = groupsOfCat(more, ["Aviation", "Brand new group", "Brand new group"]);
  assert.deepEqual(g.filter((x) => x === "Brand new group").length, 1);
  assert.ok(g.indexOf("Brand new group") < g.indexOf("Reference"));
  assert.deepEqual(groupsOfCat(LAYER_CATS[3], ["Brand new group"]), LAYER_CATS[3].groups);
}

export function testCounts() {
  const items = [
    { group: "Aviation", on: true, text: "Airspace categories" },
    { group: "Marine", on: false, text: "Buoys" },
    { group: "Severe", on: true, text: "Lightning" },
  ];
  const c = catCounts(items, ["air"]);
  assert.deepEqual(c.travel, { hits: 1, on: 1 });
  assert.deepEqual(c.alerts, { hits: 0, on: 1 });
  assert.equal(c.mine.on, 2);
}
