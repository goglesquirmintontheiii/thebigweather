// 0.8.1: custom pane layout grid maths (Settings → Pane layouts editor).
import assert from "node:assert/strict";
import { unitCells, merge, order, bounds, tiles, unit, sameCell } from "../src/ui/paneGrid";

export function testBoundsAnyDirection() {
  // dragging up-left from a unit cell onto a tall merged cell covers both whole
  const tall = { r: 0, c: 0, rs: 2, cs: 1 };
  assert.deepEqual(bounds(unit(1, 1), tall), { r: 0, c: 0, rs: 2, cs: 2 });
  assert.deepEqual(bounds(tall, unit(1, 1)), { r: 0, c: 0, rs: 2, cs: 2 });
  assert.deepEqual(bounds(unit(2, 2), unit(2, 2)), unit(2, 2));
}

export function testMergeKeepsATiling() {
  let cells = unitCells(3, 3);
  cells = order(merge(cells, { r: 0, c: 0, rs: 2, cs: 3 }), cells[0]);
  assert.equal(cells.length, 4);
  assert.ok(tiles(cells, 3, 3));
  assert.ok(sameCell(cells[0], { r: 0, c: 0, rs: 2, cs: 3 }), "the merged cell holding the old main stays main");
  // a merge that cuts the big cell breaks it back into units
  cells = order(merge(cells, { r: 1, c: 1, rs: 2, cs: 1 }), cells[0]);
  assert.ok(tiles(cells, 3, 3));
  assert.equal(cells.length, 5 + 2 + 1); // 5 units from the big cell, 2 untouched bottom cells, the new tall cell
}

export function testOrderMainFirst() {
  const cells = unitCells(2, 2);
  const o = order(cells, cells[3]);
  assert.ok(sameCell(o[0], unit(1, 1)));
  assert.deepEqual(o.slice(1).map((x) => [x.r, x.c]), [[0, 0], [0, 1], [1, 0]]);
}
