# Plan audit (before Phase 5)

I checked every item in PLAN.md against the build after Phase 4. This lists what was missing and what happened to it in 0.5.0.

## Missing, now added in 0.5.0

| Plan item | Where it is now |
|---|---|
| Rotation highlights | Layers → Severe: "Rotation (selected radar)" (own couplet detector on Level II) and "Rotation scan" (all US radars, from NWS storm attributes) |
| Storm cell tracking with motion arrows and ETAs to saved points | Layers → Severe → Storm tracks (storm table in its gear) |
| Level III hail / TVS / meso attribute table | Storm table (same NWS storm-attribute data) |
| Vertical cross-sections | Toolbar … → Cross-section (Level II and European volumes) |
| 3D volume view | Toolbar cube / Shift+3 (Level II volumes, MRMS 3D) |
| Storm-relative velocity | SRV control with Level II velocity |
| Derived Level II products (composite, echo tops, VIL) | Radar product list |
| Spaghetti models | Layers → Tropical (NHC ATCF a-decks) |
| Recon center fixes | Layers → Tropical (vortex messages) |
| Raspberry Shake nodes | Layers → Hazards, with a seismograph window |
| Volcanic activity | Layers → Hazards (USGS alert levels) |
| CDC/ATSDR Social Vulnerability Index | Layers → Environment |
| SWPC Kp | Aurora layer gear |
| NOHRSC snow | Layers → Environment (snow depth / SWE) |
| Drought monitor | Layers → Environment |
| HRRR smoke | Models → HRRR → Smoke (near-surface and vertically integrated) |
| Wind particle animation | Layers → Surface → Wind particles |
| Air quality (AirNow files) | Layers → Environment |
| NWS HeatRisk | Layers → Environment |
| NOAA HMS fire / smoke | Layers → Hazards / Environment |
| Meteosat (MTG/MSG) | Layer menu → Satellite → Meteosat (EUMETView WMS) |
| VIIRS / MODIS polar passes, VIIRS Day/Night Band, GPM IMERG | Layer menu → Satellite → Polar orbiters & global (NASA GIBS) |
| Models GEFS, CMC (GDPS, HRDPS), ICON | Layer menu → Models (GEFS mean, GDPS, HRDPS, ICON-EU) |
| Model soundings (Skew-T + hodograph), observed soundings | Right-click → Sounding here |
| Ensemble plumes | Forecast window → Ensembles |
| Case study mode | Historical mode (toolbar) |
| Export loops as GIF/MP4 | Toolbar … → Export loop |
| Saved workspaces | Toolbar … → Workspaces |
| Full hotkeys / keybinds | Layer shortcuts and the `?` dialog |
| Bandwidth-saver mode | Settings → Data use |
| Themes | Settings → Appearance (accent, UI scale, panel opacity) |
| Draggable / pop-out METAR panels | METAR popup → Pin |
| GPS track recording + distance to chasers | Toolbar … → GPS track |
| Camera icons: recording red dot, 360° badge | Camera markers |
| Traffic | Layers → Traffic (TomTom key) |

## Still not done, and why

| Plan item | Reason |
|---|---|
| Power outages | No keyless public source with national coverage. |
| Cycloneport stations | No public data feed. |
| Hazcams | No public API (fire-camera networks like ALERTCalifornia have no open feed list). |
| Mesonets (Oklahoma, West Texas, NY State, Kentucky) | Their real-time data needs agreements or a Synoptic key. Synoptic support is still possible later with your key. |
| Wind profilers, ocean currents | The NOAA profiler and current feeds need accounts or have no usable public endpoint. |
| SST | Partly covered: GHRSST MUR in Satellite → Polar orbiters & global. |
| GK-2A | KMA data needs a key. The AWS copy (`noaa-gk2a-pds`) is raw netCDF that would need its own decoder. |
| ASCAT ocean winds | No keyless tiled source. |
| MTG lightning imager | EUMETView has an accumulated-flash layer (in the Meteosat list), but there are no raw flashes without an EUMETSAT account. |
| ECMWF ENS, HREF, SREF grids | Plumes for ECMWF and GFS ensembles come from Open-Meteo. Full ensemble grids are very large; GEFS mean is added. |
| ICON global | Only on an icosahedral grid; ICON-EU is used instead. |
| Hail swath accumulation | MRMS MESH tracks cover this (MRMS → hail). |
| Dealiased velocity | The rotation detector unfolds locally. A full display dealiaser is still to do. |
| Offline basemap regions | Not started. |
| Auto-update | No release host (you get zips). |
| Mixed-DPI scaling | Electron handles this per window; the UI scale setting helps on high-DPI screens. |
| US university / niche radars | Phase 5 plan item. None of them publish data openly (images only, or not at all). |
| Australia (BoM), South Korea (KMA) radar | BoM's open FTP has radar images only, under licence terms. KMA needs a key. |
| UK, Italy, Austria, Portugal, Hungary, Slovenia and others | Not in the open OPERA set. The UK Met Office needs a key. |
