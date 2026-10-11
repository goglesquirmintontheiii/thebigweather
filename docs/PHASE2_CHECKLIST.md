# Phase 2 test checklist

My build box can't reach NOAA, ECMWF, NASA or the tile servers, so I tested every decoder with sample files and the UI with recorded data. These need your network. Note what fails with a screenshot or the server log line.

## Phase 1 fixes

- [ ] Arrow keys: ← → step frames, ↑ ↓ change tilt, and the map doesn't move.
- [ ] Level III: one button per product; the tilt row (T1–T4) and ↑ ↓ change tilt.
- [ ] Switch L3 between a NEXRAD and a TDWR site: data loads right away, no HTTP 403, the product stays highlighted.
- [ ] LPLA (or any offline radar) shows a short "isn't publishing" / "may be offline" message.
- [ ] RapidSweep is off on a fresh install. Turned on during weather: bar under the header and a beam line on the map.
- [ ] Ctrl+click 2–3 nearby radars: they draw together; a plain click goes back to one. The header "+N" chip clears them.
- [ ] Layers panel → Map tiles: OpenFreeMap (default) and CARTO both work for Dark, Light and Road; labels stay above the weather.
- [ ] App RAM after 10 minutes of looping (was 3.8 GB).
- [ ] On the server's own computer: "Use the server on this computer" connects without a token.
- [ ] Hovering CPU / RAM / Disk / Net in the stats panel shows details.
- [ ] FPS counter top right (Settings → FPS counter to hide).

## Layer menu

- [ ] Opens from the left of the header; search finds layers (try "hail", "cape", "band 13").
- [ ] MRMS: composite reflectivity, precip type, MESH, rotation track 24 h, QPE 24 h load and animate.
- [ ] Satellite: GOES-19 CONUS band 13 and band 2 load; switch to Meso 1; hover shows temperature.
- [ ] GeoColor and Air Mass (GIBS) load and animate; Himawari IR shows over the Pacific.
- [ ] Models: HRRR composite reflectivity and 2 m temperature; step forecast hours with → ; change the run.
- [ ] GFS and ECMWF 2 m temperature and MSLP; NBM gusts; RRFS reflectivity.
- [ ] HAFS (only during an active tropical cyclone): storm picker appears.
- [ ] NDFD: temperature and precip chance animate through the forecast.
- [ ] Surface analysis: temperature and dewpoint look reasonable near you; refreshes every few minutes.
- [ ] Units: Settings → Temp °C/°F and Precip in/mm change the legend and hover values.

## Performance (please note numbers)

- [ ] Time for the first MRMS frame and a full 12-frame loop.
- [ ] Time to open a model layer (first frame) on the VPS and on your PC.
- [ ] Server RAM and CPU while animating a model.
