// 0.8.4: data source gating helpers and cache budget text.
import assert from "node:assert/strict";
import { basemapSource, intlDataSource, parseBytes, fmtBudget, warnText } from "../src/datasrcCore";

export function testBasemapSources() {
  assert.equal(basemapSource("dark", "openfreemap"), "openfreemap");
  assert.equal(basemapSource("dark", "carto"), "carto");
  assert.equal(basemapSource("road"), "openfreemap");
  assert.equal(basemapSource("satellite"), "esri");
  assert.equal(basemapSource("terrain", "carto"), "esri");
  assert.equal(basemapSource("google"), "google");
  assert.equal(basemapSource("faa_sec"), "faa-charts");
  assert.equal(basemapSource("offline"), null);
  assert.equal(basemapSource("custom:abc"), null);
}

export function testIntlSources() {
  assert.equal(intlDataSource("rainviewer_ir"), "rainviewer");
  assert.equal(intlDataSource("geomet_snow"), "eccc");
  assert.equal(intlDataSource("dwd"), "dwd");
  assert.equal(intlDataSource("opera-all"), null);
}

export function testWarning() {
  assert.equal(warnText("basemap"), "Data source for this basemap is disabled.");
}

export function testParseBytes() {
  assert.equal(parseBytes("1.5 GB"), 1.5 * 1024 ** 3);
  assert.equal(parseBytes("512m"), 512 * 1024 ** 2);
  assert.equal(parseBytes("512MiB"), 512 * 1024 ** 2);
  assert.equal(parseBytes("800000"), 800000);
  assert.equal(parseBytes("2 tb"), 2 * 1024 ** 4);
  assert.equal(parseBytes("1,5 kb"), 1536);
  assert.equal(parseBytes("abc"), null);
  assert.equal(parseBytes(""), null);
}

export function testFormatRoundTrips() {
  for (const b of [1536, 5 * 1024 ** 2, 1.25 * 1024 ** 3, 700]) assert.equal(parseBytes(fmtBudget(b)), b);
  assert.equal(fmtBudget(512 * 1024 ** 2), "512 MB");
  assert.equal(fmtBudget(1024 ** 3), "1 GB");
}
