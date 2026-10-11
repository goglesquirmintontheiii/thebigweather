# TheBigWeather — Plan

## Ground rules from the user
- UI text should be kept short, uncluttered.
- UI inspired by **RadarOmega**, with features from **RadarScope**.
- More features = better, but must run well on the user's PC (96GB DDR5, Ryzen 9850X3D, NVMe) **and** on a 4-vCore / 16GB VPS (reduced functionality OK on low end). Use high-end hardware well, but don't continuously max it out.
- Android app is **planned only** — do NOT build until the user asks.

## Stack (agreed)
| Part | Choice | Why |
|---|---|---|
| Server | **Rust** (tokio + axum) | Fast decode/render, low RAM, single binary; runs on 4-vCore VPS |
| Desktop UI | **TypeScript + MapLibre GL + custom WebGL2 layers** | GPU radar rendering, instant colormap changes |
| Desktop shell | **Electron → `.AppImage`** (user approved) | Chromium WebGL more reliable on Linux than WebKitGTK; true OS windows for multi-monitor |
| Android (later) | Capacitor wrapping same UI with mobile layout | Shared code |
| Storage | SQLite (WAL) + NVMe file cache with size limits | No DB server |

## Core architecture
- **Server sends data, not pictures.** Server decodes radar/model/MRMS/satellite into compact quantized binary (zstd). Client colors it on the GPU (RadarScope style) → instant custom colormaps, exact crosshair readouts, smoothing toggle, small transfers.
- **Hardware profiles** auto-detected at startup:
  - **Full** (PC): continuous ingest of chosen radars, all model hours, live chunk streaming, deep cache. Worker threads capped ~60% of cores by default (adjustable).
  - **Lite** (VPS): on-demand fetching, fewer model hours, smaller cache, live chunks for 1–2 radars.
- **WebSocket push** for new sweeps, alerts, chunks, server stats — no client polling.
- **`start.sh`**: installs deps, builds/downloads binary, creates config, picks profile, step-by-step console output, then runs. Optional systemd service install.
- **Connection/auth:** VPS has a domain → public HTTPS via **Caddy** (auto Let's Encrypt cert, set up by `start.sh`). Apps authenticate with a token (paste or QR pairing). Apps can save multiple servers (VPS, home PC) and switch between them.
- **Storage defaults:** radar cache auto-sizes to free disk with low-disk warning. Recordings never auto-deleted. VPS has no bandwidth cap. User records sparingly.
- **Source health + fallbacks:** status light per source, retries, backup sources.
- **Hot-updatable source definitions:** camera lists/simple feed URLs live in config files, fixable without rebuild.
- **Auto-update** for AppImage and server.
- **Offline basemap regions** (for chasing with poor signal).
- **Settings export/sync** between desktop and Android.
- **Colorblind-safe palettes**, units, timezone (UTC/local).
- **Attribution/licensing page.**
- **API-key settings page.** Missing keys just disable that source.
- Build-environment note: Claude's cloud workspace can't reach NOAA/DWD etc. Live data is first tested on the user's machine; each phase ships with a quick test checklist.

## Basemaps (one at a time)
Terrain, Satellite, Dark, Light, Road network, Dark roadmap, Google satellite.
- Google satellite: Google ToS forbids direct tile scraping → support via **Google Map Tiles API (key)**; Esri World Imagery / NASA imagery as keyless alternatives.

## Weather layers (one visible at a time)
- **NEXRAD Level II** — AWS public S3 for history; chunks bucket for **RapidSweep-style** live sweeps.
- **NEXRAD Level III** — NWS public sources.
- **TDWR** (45 FAA Terminal Doppler radars) — first-class radars. 150 m Doppler gate resolution; 1-min updates for some products in hazardous mode. Level II + Level III via NWS/NCEI/tgftp.
- **MRMS** (AWS): reflectivity, winter weather, 1/2/4/24h/current hail, 2/24h rotation, 30min/1h lightning prob, severe hail prob, VIL, 1/6/24/48/72h precip accumulation.
- **Models:** HRRR, RRFS (verify operational status), NAM 3km/12km, RAP, GFS, ECMWF open data, GEFS, CMC/RDPS/HRDPS, ICON, NBM, **HAFS-A/B** (HWRF & HMON are retired — HAFS replaces them). Ensembles: GEFS, ECMWF ENS, HREF, SREF.
- **METAR-interpolated** layers (temp, wind, etc.).
- **Satellite:** GOES-19, GOES-18, Himawari-9 (regional/sub-regional/full disk; GeoColor-style, all ABI bands, SWIR, WV, LWIR), GLM lightning. Plus **Meteosat (MTG/MSG** incl. MTG lightning imager; EUMETView WMS keyless for imagery, EUMETSAT account for raw), **GK-2A**, **VIIRS/MODIS** polar passes incl. VIIRS Day/Night Band (NASA GIBS, keyless), **GPM IMERG**, **ASCAT** ocean winds, **NOAA HMS** fire/smoke.
- **NDFD** (AWS), **Air quality** (AirNow public data files keyless + Open-Meteo AQ keyless; AirNow API optional), **NWS HeatRisk**.
- **International radar:**
  - Full single-site volumes: **Finland** (FMI on AWS, ODIM HDF5, SNS notifications), **Germany** (DWD open data), **Switzerland** + other European countries via **EUMETNET Open Radar Data API / MeteoGate** (24h rolling cache), **Canada** (ECCC — verify volume availability), **Australia (BoM)** and **South Korea (KMA, key)**.
  - Composites/mosaics (verify each): France, Netherlands, Belgium, Denmark, Sweden, Norway, Poland, Czechia, UK (key), Spain (key), Japan, Taiwan (key), Hong Kong, Singapore, Philippines, Indonesia, Brazil, Mexico, India, Israel, New Zealand.
  - Global fallback: NOAA satellite-derived rain rate (RRQPE, 60S–70N). RainViewer free API is too restricted now (zoom 7 max, one color scheme since Jan 2026) — don't rely on it. LibreWXR (github.com/JoshuaKimsey/LibreWXR) is a useful reference for source regions.
- **US niche/university radars** (where public; some image-only): MZZU (Univ. of Missouri X-band), Valparaiso Univ. C-band dual-pol (Indiana), Purdue XTRRA (Indiana, public images), Georgia Gwinnett/GT/UGA X-band. To check: UAH ARMOR, CSU-CHILL, OU research radars, CASA DFW X-band network, NASA NPOL/KWAJ. "WLX" unidentified — ask user. FAA ASR and TV station radars are not public.

## Overlays (multiple at once)
- Weather alerts; custom points (home, work, etc.)
- Mesoscale Discussions; SPC outlooks
- Tropical: tracks, outlooks, winds, hurricane hunters, spaghetti models
- Hydrological, fire weather, winter weather, climatological (CPC) outlooks
- METARs; marine (tide points, NDBC buoys + **NOAA BuoyCAMs**)
- Surface fronts; LSRs; **mPING** (see licensing note below)
- Lightning (GOES GLM, Blitzortung)
- Spotter Network (account); storm chasers (click for video)
- Power outages (best-effort public sources); Cycloneport stations
- Rotation highlights
- **Traffic cameras** (see Cameras section), Hazcams
- NWS offices; NOAA Weather Radio transmitters
- GeoJSON/JSON/KML/KMZ user files
- Aviation: flights (adsb.lol / airplanes.live keyless ADS-B), center fixes, flight paths, recon missions, PIREPs, airports, TAFs, SIGMETs (aviationweather.gov)
- YouTube feeds (user places icon + URL)
- Raspberry Shake nodes; volcanic activity + VAAC ash advisories
- Draggable server hardware stats (CPU, RAM used/free, disk used/free, net up/down)
- CDC/ATSDR Social Vulnerability Index (NWS GIS)
- **ISS:** position computed client-side from CelesTrak TLE (SGP4), ground track, visibility footprint, next visible pass over saved points; click → NASA live ISS stream in draggable/pop-out panel (stream may show blue screen during LOS). Bonus toggles: Tiangong, Hubble, weather satellites.
- **Waffle House Index:** locations from OpenStreetMap (brand-tagged). Status (green open / yellow limited / red closed) from Waffle House's store locator **only if toggle enabled — toggle OFF by default**. Light polling, more often near hurricane/tornado watches. Cluster "% closed" summary. Falls back to locations-only if blocked. (Public fan trackers received cease-and-desist letters over trademark; this is a private personal app.)
- **Ships layer (new):** AIS via aisstream.io (free key, global; strongest near coasts; stale tag far offshore). Keyless regional: Norway Kystverket open AIS, Finland Digitraffic (Baltic). **Cruise ship webcams** (e.g. Viking 360°/220° bridge cams) mapped to live ship positions; click ship → cam (360° in draggable panorama viewer). User can add ships/cam URLs. Optional general ship traffic filter by type.
- Extra data: Iowa Environmental Mesonet (archives for case-study mode), mesonets (Oklahoma, West TX, NY State, Kentucky; Synoptic optional), SWPC space weather (aurora oval, Kp), NOHRSC snow, wind profilers, upper-air soundings, SST & ocean currents, NIFC fire perimeters, NASA FIRMS hotspots, USGS gauges & earthquakes, NOAA tides, drought monitor, HRRR smoke, wind particle animation.

## Cameras
- **US:** ingest directly from state DOT/511 sources (Caltrans, TxDOT, 511NY, FDOT, GDOT, TDOT, KYTC, ALGO, MDOT, etc.), expand state by state.
- **International:** Canada (511 Ontario, DriveBC, Québec 511, 511 Alberta, others), UK/Ireland (Traffic Scotland, Traffic Wales, TII, England motorways), Nordics (Finland Digitraffic, Norway Statens vegvesen, Sweden Trafikverket key, Iceland), Asia-Pacific (Hong Kong, Singapore, Taiwan, NZTA, Australia NSW key / QLD / others), Europe to check (Spain DGT, France, Italy, Germany, Netherlands, Switzerland, Czechia, Poland), South Korea ITS (key), Japan (patchy), parts of LatAm. One adapter per source. Include mountain-pass/weather/ski cams.
- **TrafficVision.live:** their ToS forbids scrapers/bots and bulk DB extraction without permission; they offer API/licensing by contact. Implement as **optional source with key field**, with required attribution. Not scraped.
- **Camera icons by type** (shape, not just color): video stream = play triangle; YouTube = YouTube-style rounded rect; snapshot = still camera; 360°/panoramic = circle-arrow badge. Offline = greyed; recording = red dot.
- **Camera recording** (server-side): video streams saved without re-encoding (ffmpeg copy); snapshot cams saved per refresh → playback/timelapse MP4. Concurrency limited by hardware profile. Scheduled recording; **record-on-alert** (cams inside new warning polygons). Shared library with radar recordings; synced playback against radar. Disclaimer under every feed: recording/redistributing some feeds may require owner permission. **YouTube is watch-only** (ToS prohibits downloading).

## Bottom toolbar
Play/pause radar animation · locate me (pinpoint + zoom) · screenshot · distance/bearing from selected radar to screen center · center crosshair showing current layer value · measure tool · show/hide radar sites · drawing mode.

## Drawing mode
Shapes · undo/redo · brush size · brush color · clear all · optional persist after exit (anchored to map coords, stays on pan/zoom) with an X at top-right of each persisted drawing to delete.

## Sidebar extra menus
- **Weather radio** — NOAA Weather Radio streams; user-added stream URLs (Broadcastify has no open API), preload public ones.
- **Custom files manager** — KML/KMZ/GeoJSON.
- **Forecast** — 24h and 7-day (temps, rain chance, wind, etc.).
- **Overpass search** — small collapsible menu.
- **Import/Export** — export single recordings or all as one `.zip` (radar, camera, other weather data); import into any server.

## Notable features
- Extreme customizability (colormap editor w/ `.pal` import, themes, keybinds, per-layer opacity/smoothing, alert sound rules)
- Dual/quad pane (synced or independent pan/zoom/time)
- Custom colormaps
- Niche/educational radars
- Radar history via public S3
- Draggable camera/METAR panels that pop out to other monitors; correct mixed-DPI scaling
- Optional audio alerts (new alerts / new sweeps)
- Record up to 4 products of one radar simultaneously; recordings library + playback

### Added features
- **Radar analysis:** storm cell tracking with motion arrows + ETAs to saved points; Level III hail/TVS/meso attribute table; vertical cross-sections; 3D volume view; storm-relative & dealiased velocity; derived products from Level II (echo tops, VIL, composite); hail swath accumulation.
- **Alerts:** notify only when a saved point is inside a polygon; Tornado Emergency/PDS highlighting; full alert text panel; desktop notifications (Android push later).
- **Forecast tools:** click for model sounding (Skew-T + hodograph) or meteogram; observed soundings; ensemble plumes; wind particle layer.
- **Map/playback:** one global synced timeline; adjustable loop speed + last-frame dwell; range rings; **case study mode** (replay past events w/ radar, warnings, reports synced); export loops as GIF/MP4.
- **Workflow:** saved workspaces (e.g. "chase day", "winter"); full hotkeys; data source health panel; bandwidth-saver mode.
- **Extra overlays:** wildfire perimeters/hotspots, river gauges/floods, drought monitor, HRRR smoke, earthquakes, GPS track recording + distance to nearby chasers.

## API keys (all free; optional)
Synoptic, AirNow, aisstream.io, mPING, Spotter Network, EUMETSAT, KMA, Trafikverket, NSW road agency, Google Map Tiles (optional), TrafficVision (if granted).

**Keyless alternatives:**
| Keyed | Keyless alternative |
|---|---|
| Synoptic | NWS API station obs + Iowa Environmental Mesonet |
| AirNow API | AirNow public data files (files.airnowtech.org) + Open-Meteo AQ |
| aisstream.io | Regional only: Norway Kystverket, Finland Digitraffic |
| EUMETSAT | EUMETView WMS (imagery, no registration) |
| Google satellite | Esri / NASA imagery |
| KMA, Trafikverket, Spotter Network | None good — keys/accounts free |

**mPING licensing:** research license excludes the most recent 48h; real-time requires commercial license; general-user license allows viewing last 4h on mPING's own site only (no collecting/redistributing). Default: mPING button opens their official live map in a panel. User may apply for access.

## Build phases
1. **Foundation:** server, `start.sh`, HTTPS (Caddy), Electron shell, basemaps, NEXRAD L2/L3 + TDWR with RapidSweep and history, alerts, bottom toolbar, settings + API-key page.
2. **Gridded data:** MRMS, satellite, METAR interpolation, NDFD, models.
3. **Overlays:** SPC/WPC/NHC/CPC, METARs, marine, LSRs, lightning, aviation, cameras, ships, ISS, Waffle House, file imports.
4. **Power features:** multi-pane, drawing, recording (radar + cameras), import/export, pop-out windows, audio alerts, Overpass search, forecast menu, radio menu.
5. **International & niche radars.**
6. **Android** — only when user asks.

Each phase ends with a working AppImage + server and a test checklist.

## Next step
Put this plan in the repo as `PLAN.md`, then start **Phase 1**.

---

