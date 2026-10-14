// 0.8.1: notification templates, timelapse length helpers, scanner audio mix.
import assert from "node:assert/strict";
import { renderTpl, applyTpl, SAMPLE, DEFAULT_TITLE, DEFAULT_BODY } from "../src/notifytpl";
import { toMinutes, splitLen, fmtLen, toLocalInput, fromLocalInput } from "../src/tlen";
import { mixPlan, setMix } from "../src/same/mixplan";

export function testTemplates() {
  const m = { title: "Tornado near Home", body: "Tornado Warning covers Home", rule: "Tornado near Home", level: "urgent", url: "https://x.example/a", vars: { event: "Tornado Warning", place: "Home", area: "A County" } };
  // no template / default template: today's message
  assert.deepEqual(applyTpl(m), { title: m.title, body: m.body });
  assert.deepEqual(applyTpl(m, { title_tpl: DEFAULT_TITLE, body_tpl: DEFAULT_BODY }), { title: m.title, body: m.body });
  assert.deepEqual(applyTpl(m, { title_tpl: "  ", body_tpl: "" }), { title: m.title, body: m.body });
  // placeholders, unknown names kept, missing known ones blank, fallbacks like the server
  assert.equal(renderTpl("{event} at {point}: {area} [{headline}] {link} {nope} {severity}", m, "t"), "Tornado Warning at Home: A County [] https://x.example/a {nope} urgent");
  assert.equal(renderTpl("{time}", m, "2026-10-14 12:00"), "2026-10-14 12:00");
  // rule beats channel
  assert.deepEqual(applyTpl(m, { title_tpl: "C {event}", body_tpl: "C" }, { body_tpl: "R {rule}" }, "t"), { title: "C Tornado Warning", body: "R Tornado near Home" });
  assert.ok(renderTpl("{headline}", SAMPLE).startsWith("Tornado Warning issued"));
}

export function testTimelapseLength() {
  assert.equal(toMinutes(2, 1440), 2880);
  assert.equal(toMinutes(1, 1), 5, "at least 5 min");
  assert.equal(toMinutes(1000, 10080), 366 * 1440, "at most a year");
  assert.deepEqual(splitLen(1440), [1, 1440]);
  assert.deepEqual(splitLen(10080 * 2), [2, 10080]);
  assert.deepEqual(splitLen(90), [90, 1]);
  assert.deepEqual(splitLen(180), [3, 60]);
  assert.equal(fmtLen(1440), "1 day");
  assert.equal(fmtLen(360), "6 hours");
  assert.equal(fmtLen(10080), "1 week");
  const t = new Date(2026, 9, 20, 18, 30).getTime();
  assert.equal(toLocalInput(t), "2026-10-20T18:30");
  assert.equal(fromLocalInput("2026-10-20T18:30"), t);
  assert.equal(fromLocalInput("nope"), null);
}

export function testScannerMix() {
  const stations = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cfg = { stations, audio: true, mix: { a: { vol: 0.5 }, b: { vol: 1, mute: true }, gone: { vol: 1 } } };
  let p = mixPlan(cfg, null, 0.8);
  assert.deepEqual(p.ids, ["a", "b"]);
  assert.deepEqual(p.muted, { a: false, b: true });
  assert.equal(p.vol.a, 0.4);
  assert.equal(p.solo, null);
  // solo
  p = mixPlan({ ...cfg, solo: "b" }, null);
  assert.deepEqual(p.muted, { a: true, b: false });
  // a station that fires joins the mix and is heard alone
  p = mixPlan(cfg, "c");
  assert.deepEqual(p.ids, ["a", "b", "c"]);
  assert.deepEqual(p.muted, { a: true, b: true, c: false });
  assert.equal(p.solo, "c");
  // audio off: everything connected but muted (silent watching)
  p = mixPlan({ ...cfg, audio: false }, "c");
  assert.ok(Object.values(p.muted).every(Boolean));
  // add / remove keeps volumes
  const m2 = setMix({ a: { vol: 0.3 } }, ["a", "b"], true);
  assert.deepEqual(m2, { a: { vol: 0.3 }, b: { vol: 1 } });
  assert.deepEqual(setMix(m2, ["a"], false), { b: { vol: 1 } });
}
