// 0.8.3: alert timeline grouping / type filter, Translate button rules, lightning legend window.
import assert from "node:assert/strict";
import { groupItems, typeRank, cycleFilter, passes, applyFilter, typeChips, spanEnd, packRows, vtecKey, searchText, searchWords, searchItems, foldText, type GItem } from "../src/atlgroup";
import { alertLang, offerTranslate, scriptLang, looksSpanish } from "../src/trlang";
import { ltgWindow, ltgPaint, ltgFilter, ltgSpan, ltgTicks } from "../src/radar/ltgpaint";

const H = 3600_000;
const it = (key: string, type: string, t0 = 0, t1 = t0 + H, color = "#fff"): GItem => ({ key, type, t0, t1, color });

export function testGroupsByTypeInPriorityOrder() {
  const items = [it("a", "Wind Advisory"), it("b", "Tornado Warning"), it("c", "lsr", 5, 5), it("d", "Winter Storm Warning"), it("e", "Tornado Warning", 2 * H), it("f", "Flood Watch"), it("g", "Severe Thunderstorm Warning"), it("h", "md"), it("i", "Special Weather Statement"), it("j", "Blizzard Warning")];
  const g = groupItems(items);
  assert.deepEqual(
    g.map((x) => x.type),
    ["Tornado Warning", "Severe Thunderstorm Warning", "Blizzard Warning", "Winter Storm Warning", "Flood Watch", "Wind Advisory", "Special Weather Statement", "md", "lsr"],
  );
  assert.equal(g[0].items.length, 2, "same type together");
  assert.deepEqual(
    g[0].items.map((x) => x.key),
    ["b", "e"],
  );
  assert.equal(g.find((x) => x.type === "md")!.name, "Mesoscale discussions");
  assert.ok(typeRank("Flash Flood Warning") < typeRank("Winter Storm Warning"));
  assert.ok(typeRank("Tornado Watch") < typeRank("Flood Watch"));
  // every item kept (no cap)
  const many = Array.from({ length: 640 }, (_, i) => it(`k${i}`, ["Flood Warning", "Wind Advisory", "Winter Storm Warning"][i % 3], i * 1000));
  assert.equal(
    groupItems(many).reduce((a, x) => a + x.items.length, 0),
    640,
  );
}

export function testGroupColourFromFirstItemOrLane() {
  const g = groupItems([it("a", "Flood Warning", 0, H, "#00ff00"), it("b", "Flood Warning", 0, H, "#00ff00")]);
  assert.equal(g[0].color, "#00ff00");
  const g2 = groupItems([it("a", "lsr", 0, 0, "#ef4444")], (t) => (t === "lsr" ? "#22d3ee" : undefined));
  assert.equal(g2[0].color, "#22d3ee");
}

export function testTypeFilterOnlyAndHide() {
  let f = {};
  assert.ok(passes(f, "Tornado Warning"));
  f = cycleFilter(f, "Tornado Warning"); // only
  assert.deepEqual(f, { "Tornado Warning": "in" });
  assert.ok(passes(f, "Tornado Warning"));
  assert.ok(!passes(f, "Wind Advisory"));
  f = cycleFilter(f, "Flood Warning"); // only both
  assert.ok(passes(f, "Flood Warning") && passes(f, "Tornado Warning") && !passes(f, "Wind Advisory"));
  f = cycleFilter(f, "Tornado Warning"); // now hidden
  assert.equal((f as any)["Tornado Warning"], "out");
  assert.ok(!passes(f, "Tornado Warning"));
  f = cycleFilter(f, "Tornado Warning"); // back to normal
  assert.ok(!("Tornado Warning" in f));
  const hide = cycleFilter(cycleFilter({}, "Wind Advisory"), "Wind Advisory");
  const items = [it("a", "Wind Advisory"), it("b", "Flood Warning"), it("c", "Wind Advisory")];
  assert.deepEqual(
    applyFilter(items, hide).map((x) => x.key),
    ["b"],
  );
  // chips count every type, filtered or not
  assert.deepEqual(
    typeChips(items).map((c) => [c.type, c.n]),
    [
      ["Flood Warning", 1],
      ["Wind Advisory", 2],
    ],
  );
}

export function testSpanReachesActiveAlerts() {
  const now = 1_000 * H;
  assert.equal(spanEnd([], now), now + 2 * H);
  assert.equal(spanEnd([it("a", "Winter Storm Warning", now + 20 * H, now + 40 * H)], now), now + 40 * H);
  assert.equal(spanEnd([it("a", "Flood Warning", now - H, now + 30 * 24 * H)], now), now + 7 * 24 * H, "capped");
}

export function testVtecKeyMatchesLiveAndArchive() {
  assert.equal(vtecKey("/O.NEW.KOUN.TO.W.0012.260515T2010Z-260515T2100Z/"), "OUN.TO.W.12");
  assert.equal(vtecKey(["/O.CON.KOUN.TO.W.0012.000000T0000Z-260515T2100Z/"]), "OUN.TO.W.12");
  assert.equal(vtecKey("OUN.TO.W.0012"), "OUN.TO.W.12");
  assert.equal(vtecKey("/O.NEW.PAFC.WS.A.0003.261108T0000Z-261109T0000Z/"), "AFC.WS.A.3");
  assert.equal(vtecKey(undefined), null);
  assert.equal(vtecKey("Flood Warning"), null);
}

export function testRowPacking() {
  const px = 60 / H; // 60 px per hour
  const rows = packRows([it("a", "x", 0, H), it("b", "x", 0.5 * H, 2 * H), it("c", "x", 2.2 * H, 3 * H)], px);
  assert.equal(rows.get("a"), 0);
  assert.equal(rows.get("b"), 1);
  assert.equal(rows.get("c"), 0);
}

export function testTranslateOffer() {
  const ru = { lang: "en", event: "Wind", description: "Сильный ветер, порывы 25 м/с" };
  assert.equal(scriptLang(ru.description), "ru");
  assert.equal(alertLang(ru), "ru", "Russian text in an 'en' CAP document");
  assert.equal(offerTranslate(undefined, ru), "ru", "default: Russian alerts");
  assert.equal(offerTranslate("off", ru), null);
  const es = { lang: "es-ES", description: "Lluvias intensas" };
  assert.equal(offerTranslate(undefined, es), "es", "default: Russian and Spanish (0.8.4)");
  assert.equal(offerTranslate("all", es), "es");
  const en = { lang: "en-GB", description: "Heavy rain" };
  assert.equal(offerTranslate("all", en), null);
  assert.equal(offerTranslate("all", { description: "Heavy rain" }), null);
  assert.equal(offerTranslate("all", { description: "大雨警報" }), "auto");
  assert.equal(offerTranslate("all", { lang: "el", description: "Ισχυρές βροχές" }), "el");
}

export function testLightningWindow() {
  assert.equal(ltgSpan("10"), 600);
  assert.equal(ltgSpan(undefined), 900);
  assert.deepEqual(ltgWindow(600, null), [0, 600]);
  assert.deepEqual(ltgWindow(600, [0.5, 1]), [300, 600]);
  assert.deepEqual(ltgWindow(600, [0.8, 0.2]), [480, 480], "clamped");
  assert.equal(ltgFilter(600, null), null);
  assert.deepEqual(ltgFilter(600, [0.5, 1]), ["all", [">=", ["to-number", ["get", "age"], 0], 299.5], ["<=", ["to-number", ["get", "age"], 0], 600.5]]);
  // full span: same ramp as before (white at 0, ~1 min yellow, dark red at the span)
  const full = ltgPaint([0, 900], 1).color as any[];
  assert.deepEqual(full.slice(3), [0, "#ffffff", 60, "#fff59d", 270, "#ffb300", 585, "#f4511e", 900, "#8d2a1a"]);
  // a window of older flashes: its newest edge is the brightest
  const old = ltgPaint([600, 900], 0.8);
  assert.equal((old.color as any[])[3], 600);
  assert.equal((old.color as any[])[4], "#ffffff");
  assert.equal((old.opacity as any[])[1], 0.8);
  const stops = (old.color as any[]).slice(3).filter((_, i) => i % 2 === 0);
  assert.ok(stops.every((v, i) => i === 0 || v > stops[i - 1]), "stops ascend");
  // zero-width window still gives ascending stops
  const z = (ltgPaint([300, 300], 1).color as any[]).slice(3).filter((_, i) => i % 2 === 0);
  assert.ok(z.every((v, i) => i === 0 || v > z[i - 1]));
  assert.deepEqual(ltgTicks(600), ["now", "2.5 min", "5 min", "7.5 min", "10 min"]);
}

// 0.8.4: timeline search
export function testTimelineSearch() {
  const a = { key: "a", type: "Tornado Warning", title: "Tornado Warning", props: { areaDesc: "Cleveland, OK; McClain, OK", description: "Radar indicated rotation near Norman.", senderName: "NWS Norman OK" } };
  const b = { key: "b", type: "Aviso de tormenta", title: "Aviso de tormenta", props: { areaDesc: "Mérida, Yucatán", description: "Lluvias fuertes" } };
  const c = { key: "c", type: "lsr", title: "Hail 1.00 in", sub: "Dallas, TX", props: { city: "Dallas", st: "TX", remark: "Quarter hail" } };
  const find = (q: string) => searchItems([a, b, c], searchWords(q), searchText).map((x) => x.key);
  assert.deepEqual(find(""), ["a", "b", "c"]);
  assert.deepEqual(find("tornado"), ["a"]);
  assert.deepEqual(find("cleveland"), ["a"], "county / city");
  assert.deepEqual(find("oklahoma"), ["a"], "state name from its code");
  assert.deepEqual(find("texas hail"), ["c"], "every word must match");
  assert.deepEqual(find("rotation norman"), ["a"], "description");
  assert.deepEqual(find("yucatan"), ["b"], "accents ignored");
  assert.deepEqual(find("storm reports"), ["c"], "lane name");
  assert.deepEqual(find("nothing-here"), []);
  assert.equal(foldText("MÉRIDA"), "merida");
}

// 0.8.4: Spanish alerts get the Translate button, labelled or not
export function testSpanishAlerts() {
  const smn = "Se prevén lluvias muy fuertes con descargas eléctricas y granizo en la zona norte de Sonora";
  const nws = "The National Weather Service in Las Vegas has issued a Flood Warning for the Los Angeles River until 5 PM. Heavy rain is expected.";
  assert.equal(alertLang({ lang: "es-MX", description: "Lluvia" }), "es");
  assert.equal(alertLang({ description: smn }), "es", "no language given");
  assert.equal(alertLang({ lang: "en", description: smn }), "es", "labelled English");
  assert.equal(alertLang({ lang: "en", description: nws }), "");
  assert.equal(alertLang({ headline: "Flood Warning for El Paso" }), "");
  assert.ok(!looksSpanish(nws));
  assert.equal(offerTranslate(undefined, { lang: "es-MX", description: smn }), "es");
  assert.equal(offerTranslate("ru", { description: smn }), "es");
  assert.equal(offerTranslate("off", { description: smn }), null);
  assert.equal(offerTranslate(undefined, { lang: "fr", description: "Vent fort" }), null, "other languages still need 'every non-English'");
  assert.equal(offerTranslate("all", { lang: "fr", description: "Vent fort" }), "fr");
}
