// 0.8.2: toolbar pins + dashboard grid maths.
import assert from "node:assert/strict";
import { togglePin, movePin, cleanPins, fitCount } from "../src/ui/tbpins";
import { defaultDash, place, compact, addWidget, setCols, normState, overlaps, cellAt, type DWidget } from "../src/ui/dashgrid";

export function testPins() {
  let p = togglePin([], "cross");
  p = togglePin(p, "cursor");
  assert.deepEqual(p, ["cross", "cursor"]);
  assert.deepEqual(movePin(p, "cursor", -1), ["cursor", "cross"]);
  assert.deepEqual(movePin(p, "cursor", 5), ["cross", "cursor"]);
  assert.deepEqual(togglePin(p, "cross"), ["cursor"]);
  assert.deepEqual(cleanPins(["a", "x", "a", "b"], (id) => id !== "x"), ["a", "b"]);
  assert.deepEqual(cleanPins(undefined, () => true), []);
}

export function testFit() {
  assert.equal(fitCount(1000, 500, 44, 3), 3);
  assert.equal(fitCount(600, 500, 44, 3), 2);
  assert.equal(fitCount(400, 500, 44, 3), 0);
  assert.equal(fitCount(588, 500, 44, 5), 2);
}

const noOverlap = (ws: DWidget[]) => ws.every((a) => ws.every((b) => !overlaps(a, b)));

export function testDefaultIsCompactAndValid() {
  const d = defaultDash();
  assert.deepEqual(compact(d.widgets), d.widgets, "today's layout has no holes");
  assert.ok(noOverlap(d.widgets));
  const n = normState(undefined);
  assert.equal(n.list.length, 1);
  assert.equal(n.list[0].name, "My dashboard");
  assert.equal(n.active, "default");
}

export function testPlacePushesAndSwaps() {
  const d = defaultDash();
  // move "cur" onto "storms" (down): cur stays where dropped, storms goes below
  const ws = place(d.widgets, "cur", 0, 1, 1, 1, 3);
  assert.ok(noOverlap(ws));
  const cur = ws.find((w) => w.id === "cur")!;
  const st = ws.find((w) => w.id === "storms")!;
  assert.equal(cur.y, 1);
  assert.ok(st.y > cur.y);
  // two 1-wide widgets in a column swap
  const col: DWidget[] = [
    { id: "a", type: "cur", x: 0, y: 0, w: 1, h: 1 },
    { id: "b", type: "aq", x: 0, y: 1, w: 1, h: 1 },
  ];
  const sw = place(col, "a", 0, 1, 1, 1, 1);
  assert.deepEqual(
    sw.map((w) => [w.id, w.y]),
    [
      ["a", 1],
      ["b", 0],
    ],
  );
  // resize radar to 3 wide at the top: everything else goes below it
  const ws2 = place(d.widgets, "radar", 0, 0, 3, 1, 3);
  assert.ok(noOverlap(ws2));
  assert.ok(ws2.filter((w) => w.id !== "radar").every((w) => w.y >= 1));
  // clamped to the grid
  const ws3 = place(d.widgets, "aq", 7, 0, 9, 1, 3);
  const aq = ws3.find((w) => w.id === "aq")!;
  assert.equal(aq.w, 3);
  assert.equal(aq.x, 0);
  assert.ok(noOverlap(ws3));
}

export function testAddAndCols() {
  let d = defaultDash();
  d = addWidget(d, "ltg", "l1");
  assert.ok(noOverlap(d.widgets));
  const l = d.widgets.find((w) => w.id === "l1")!;
  assert.equal(l.y, 3, "under the last row (the grid has no holes)");
  const two = setCols(d, 2);
  assert.ok(noOverlap(two.widgets));
  assert.ok(two.widgets.every((w) => w.x + w.w <= 2));
  const one = setCols(d, 1);
  assert.ok(one.widgets.every((w) => w.x === 0 && w.w === 1));
  assert.ok(noOverlap(one.widgets));
}

export function testNormStateRepairs() {
  const s = normState({ list: [{ id: "a", name: "", cols: 99, widgets: [{ id: "x", type: "cur", x: 9, y: -2, w: 1, h: 1 }, { id: "y", type: "nope" as any, x: 0, y: 0, w: 1, h: 1 }] }], active: "zzz" });
  assert.equal(s.active, "a");
  assert.equal(s.list[0].cols, 6);
  assert.equal(s.list[0].widgets.length, 1);
  assert.deepEqual([s.list[0].widgets[0].x, s.list[0].widgets[0].y], [5, 0]);
}

export function testCellAt() {
  // 3 columns 300 px wide, 12 px gap; rows 100 and 50 px
  assert.deepEqual(cellAt(10, 10, 3, 300, 12, [100, 50]), { x: 0, y: 0 });
  assert.deepEqual(cellAt(299, 120, 3, 300, 12, [100, 50]), { x: 2, y: 1 });
  assert.deepEqual(cellAt(150, 400, 3, 300, 12, [100, 50], 110), { x: 1, y: 3 });
  assert.deepEqual(cellAt(-5, -5, 3, 300, 12, []), { x: 0, y: 0 });
}
