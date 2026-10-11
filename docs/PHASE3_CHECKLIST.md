# Phase 3 test checklist

I tested the code paths with sample data here: overlay drawing, popups, camera panels, the AIS decoder, the HDOB recon parser and the front parser. My build machine can't reach the live feeds, so please check them on yours. For anything that fails, send a screenshot, or the line from Settings → Sources, or the line from the server log.

## Phase 2 fixes (re-test)

- [ ] **Animation flicker:** MRMS, satellite and model loops play without blank or flashing frames. Frames that are still loading get skipped instead.
- [ ] **Empty radar frames:** they no longer show up. A frame that lacks your tilt keeps the previous picture.
- [ ] **RapidSweep beam:** the beam line sweeps smoothly instead of jumping.
- [ ] **Overlapping radars:** with Ctrl+click radars on, each spot shows the closest radar's data.
- [ ] **Overlay gear:** every layer in the Layers panel has a gear for color, opacity, size and labels, plus that layer's options.
- [ ] **Custom basemap:** Layers → Custom tile server. Try your own URL with `{s}`, the subdomains, and min/max zoom.
- [ ] **Satellite menu:** the layer menu now has a Satellite dropdown, then a Region dropdown, then Composites (built for every region) and Bands.
- [ ] **Composites:** GeoColor, True Color, Air Mass, Dust, Day Cloud Phase, Fire Temperature, Night Microphysics and Day Convection each load for CONUS, Full Disk and Meso.
- [ ] **NASA imagery:** NASA GeoColor (Full Disk region) and the Himawari layers load.
- [ ] **App RAM:** note the number after 10+ minutes of looping and switching models. It was 10 GB.

## Severe

- [ ] **SPC outlook:** Day 1–8 and categorical / tornado / wind / hail. The CIG areas show as a dashed black outline.
- [ ] **Mesoscale discussions:** click one to open the SPC text.
- [ ] **Watch outlines:** these only appear while a watch is active.
- [ ] **Storm reports:** points with T/H/W/F letters. Click for the remark. The "Last N hours" option works.
- [ ] **Lightning (GOES GLM):** flashes appear within about a minute of turning it on, and the colors age from white to red.

## Tropical

- [ ] **Hurricanes:** cones, tracks, forecast points and coastal watches/warnings. These only appear when a storm is active.
- [ ] **Tropical outlook:** development areas and X markers.
- [ ] **Recon flights:** a plane icon and a track that grows while the overlay is on. This only works while a mission is flying.

## Outlooks

- [ ] **WPC and SPC outlooks:** Excessive rainfall (days 1–5), WSSI and SPC fire weather.
- [ ] **CPC outlooks:** temperature / precipitation (6–10, 8–14, monthly, seasonal) and CPC hazards.
- [ ] **Significant river flood outlook.**

## Surface

- [ ] **Surface fronts:** the current analysis shows fronts with pips plus H/L centers, and so do forecast days 1–3.
- [ ] **METAR station plots:** dots colored by flight category, wind barbs and temperature/dewpoint. Click a station for its METAR and TAF.
- [ ] **Buoys:** click for wind, waves and temperatures. "BuoyCAM" appears on buoys that have a camera.
- [ ] **Tide stations:** zoom 5+. Click to see the next highs and lows.
- [ ] **River gauges:** flooding and action stages by default; switch to all gauges in the options.
- [ ] **NWS offices.**

## Aviation

- [ ] **SIGMETs/AIRMETs, G-AIRMETs (type and forecast hour) and PIREPs.**
- [ ] **Airports:** click one to see its TAF.
- [ ] **Flights (ADS-B):** zoom 5+. Planes rotate to their heading and refresh every 10 s.

## Cameras

- [ ] **Traffic and weather cameras:** icons differ by type: still, video, YouTube, buoy and web page. Gear → turn camera sources on or off.
- [ ] **Camera panels:** open a still (it auto-refreshes), an HLS stream (Missouri, Alabama, some Caltrans), a BuoyCAM and a Digitraffic camera. Panels drag around and you can open several.
- [ ] **My cameras:** right-click the map → Add camera here. Try a YouTube live URL, a `.m3u8` and an image URL.
- [ ] **Ship cameras:** click a ship → Add ship camera. The camera then appears in that ship's popup.

## Marine and space

- [ ] **Ships:** Finland and Norway work without a key. With an aisstream.io key (Settings → API keys), ships appear worldwide.
- [ ] **ISS:** position, ground track and footprint. Click for altitude, speed and the next pass over your first saved point.
- [ ] **Watch live:** the ISS "Watch live" button plays NASA's stream.
- [ ] **Space stations option:** the options add Tiangong and Hubble, and weather satellites.
- [ ] **Aurora forecast heatmap.**

## Hazards and fun

- [ ] **Earthquakes:** period and magnitude options. Click to open the USGS page.
- [ ] **Wildfires:** perimeters plus VIIRS hotspots.
- [ ] **Waffle House:** locations load. Turn on "Store status" and zoom into a town; it shows a green/yellow/red ring and a "closed in view" count.

## Files

- [ ] **Import:** drop a GeoJSON, KML, KMZ or GPX on the map (or Layers → My files → Import). It draws with its own style and survives a restart.
