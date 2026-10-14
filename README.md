# TheBigWeather

Radar and weather workstation: a Linux desktop app (AppImage) plus a self-hosted server that does the heavy lifting.

**Status:** Phase 8 of 10 (see [PLAN.md](PLAN.md)). Test list: [docs/PHASE8_CHECKLIST.md](docs/PHASE8_CHECKLIST.md). Plan audit: [docs/PLAN_AUDIT.md](docs/PLAN_AUDIT.md). Data sources and licensing notes: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Quick start

### 0. Install from GitHub (and stay up to date)

```bash
# Linux: desktop app (AppImage) + server bundle into ~/TheBigWeather, SHA-256 checked
curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.sh | bash
bash install-latest.sh --server-only --dir /opt/tbw     # options: --app-only, --no-desktop-entry, --version X.Y.Z, --source release|repo
```

Windows: download and double-click [`install-latest.cmd`](https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.cmd) (`-Portable`, `-AppOnly`, `-ServerOnly`, `-Dir`, `-Source`).
The installers take the newer of the latest GitHub release and the repository's [`builds` branch](https://github.com/goglesquirmintontheiii/thebigweather/tree/builds) (files split into parts, joined and checked while downloading).
The installed app updates itself the same way (Settings → Updates: daily check, background download, "Restart to update"; the portable .exe too); the server updates with `./start.sh --update` / `start.ps1 -Update` or from Settings → Updates on the server's computer.

### 1. Server (your VPS or PC)

On Windows, run `start.cmd` (or `start.ps1 -Help` for options) instead of `start.sh`. Or skip the separate server: the app can run its own (first-run dialog → "Run the server in this app").

```bash
./start.sh                          # LAN mode: http://<machine>:8787
./start.sh --domain wx.example.com  # HTTPS via Caddy (ports 80/443 must reach the box)
./start.sh --domain wx.example.com --install-service   # run on boot (systemd)
```

`start.sh` prints the **server URL** and **token** at the end. Run `./start.sh --help` for every option.

- A prebuilt server binary is in `server/bin/` (needs glibc 2.38+, e.g. Ubuntu 24.04 / Debian 13).
- On older systems `start.sh` installs Rust and builds from source automatically (a few minutes).
- Config lives in `server/data/config.toml`.

### 2. Desktop app

```bash
chmod +x TheBigWeather-0.8.0-x86_64.AppImage
./TheBigWeather-0.8.0-x86_64.AppImage
```

On first launch, paste the server URL and token. If the server runs on the same computer, click **Use the server on this computer** — no token needed (turn this off with `local_no_auth = false` under `[server]` in the config).

The UI also works in a browser at the server URL (phones too, until the Android app exists).

## Install or update from GitHub

- **Linux:** `curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.sh | bash`
- **Windows:** download `install-latest.cmd` (main branch, `builds` branch or a release) and run it.
- **Source:** the newer of the latest release and the `builds` branch (`--source release|repo` / `-Source` picks one).
- **Updates:** the app updates itself (Settings → Updates shows "GitHub release" or "repository build"). Update the server with `./start.sh --update` (Linux) or `start.ps1 -Update` (Windows), or from Server settings.
- **Publishing builds (no release needed):** build (`tools/release.sh --dry-run`), then `tools/publish-builds.sh`. It force-pushes one fresh commit to the `builds` branch with the files in ≤45 MB parts; plain `git` push access is enough. `--dry-run` only builds the commit locally.
- **By hand:** download the `builds` branch as a ZIP and run `join-appimage.sh` / `join-windows.cmd` in it.
- **Publishing a release:** `tools/release.sh`. It needs the `gh` CLI signed in to the repo.

## Phase 8 features (0.8.0)

- **Forecast data:**
  - GEFS/ECMWF ensemble probability maps.
  - SPC-style severe parameters (STP, SCP, SHIP and more) with composites.
  - Forecast confidence.
- **Radar:**
  - Difference products and ZDR columns.
  - QC reflectivity and a bio/clutter mask.
  - Beam blockage maps.
  - Lightning jumps.
- **Detection models:**
  - Per-model runs, and runs on history data.
  - Four training intensities, resource budgets and parallel training.
  - Storm track predictions.
  - Model reports, ensembles and A/B scorecards.
- **Awareness:**
  - Per-point dashboard and alert timeline.
  - Chaser toolkit.
  - Shelters and hospitals.
  - ShakeMap and tsunami messages.
  - Seismic events from Raspberry Shake nodes.
- **Media:**
  - GOES fires, overshooting tops and fog.
  - Daily webcam timelapses.
  - A server-side radio scanner that decodes SAME on many stations at once.
  - Data export.
- **Platform:**
  - Notification channels (ntfy, Pushover, email, Discord, Telegram, webhooks) and server-side rules.
  - Command palette (Ctrl+K) and accessibility options.
  - Pane pop-outs and custom pane layouts.
  - Built-in offline voice.
  - GitHub auto-update.

## Phase 7 features (0.7.0)

- **Detection models:** train your own detectors and forecast models (tornadoes, supercells, hail, wind, debris, storm intensification, instability, temperature/precipitation/storm forecasts that become weather layers, tropical development, SPC-style outlooks, floods, wildfires) on historical radar, satellite (GOES/GLM), MRMS, METAR, HRRR and GFS data, with a probability gate, retraining and further training, then run them on any or all US radars. Training and running work on the server or this computer, and models can be exported and imported.
- **Power outages:** utility outage maps by county, plus outage points.
- **3D on laptops:** on-screen orbit controls, keys and Shift+drag.
- **Radio:** small ↔ big player switch.
- **Also:**
  - Historical Storms gains a Tornadoes tab.
  - Space weather gets its own menu, and the stats panel is compact.
  - Canada station image viewer.
  - Fixes from the Phase 6 checklist.

## Phase 6 features (0.6.0)

- **Windows:**
  - App installer and portable .exe.
  - Server: `start.cmd` / `start.ps1`, with a Windows service option.
  - The app can also run its own built-in server on one computer (Linux too).
- **Radar:**
  - GRLevelX placefiles.
  - Debris signature (TDS) detection, dual-pol hail and hail swaths.
  - Rotation tracks, velocity dealiasing, and an all-products Inspector (`I`).
- **Data:**
  - NWS damage surveys and SPC tornado history.
  - NHC wind probabilities, surge and arrival times.
  - MRMS FLASH and National Water Model flooding.
  - GFS-Wave, and road conditions.
  - Personal weather stations (CWOP) and space weather.
  - Climate normals and records; health and stargazing tabs.
  - Radar nowcast; contours and wind barbs on any model.
  - Model comparison and swipe compare.
- **Workflow:**
  - Desktop widgets and a tray icon.
  - Route weather with storm intercept.
  - Notification rules, spoken briefings and kiosk mode.
  - Light theme and terrain.
  - Offline maps and plugins.
  - Share links (read-only live view) and Team rooms.

## 0.5.1

Phase 5 follow-ups: 3D surfaces, Seismographs menu, SAME decoding and live transcription in the radio player, Historical Storms (past warnings and hurricanes), METARs in history, Canada per-radar views, keyless road work and traffic speeds, Server settings and App stats, reorganised layers menu, and fixes. Details in `docs/PHASE6_CHECKLIST.md` (part 1). The roadmap now has Phase 6 (new features + Windows) and Phase 7 (Android + VR) in `PLAN.md`.

## Phase 5 features

- **International radar:**
  - About 210 European single-site radars (EUMETNET OPERA, plus FMI for Finland) that work like NEXRAD.
  - Composites: OPERA Europe, DWD Germany, Canada (GeoMet), Mexico (SMN), Japan (JMA), Taiwan (CWA), Philippines (PAGASA). They're in the layer menu → World.
- **Historical mode:** pick a date range. All radars, satellite and grids follow it, and warnings, watches, MDs, reports and storm cells replay with the loop.
- **Radar analysis:**
  - 3D volume view (Shift+3), vertical cross-sections and storm-relative velocity.
  - Composite reflectivity, echo tops and VIL from Level II.
  - Rotation detection on the selected radar, plus a US-wide rotation/supercell scan.
  - Storm tracks with ETAs to your points.
  - A noise filter on the legend.
- **Forecast tools:** a big forecast window with ensembles, and Skew-T/hodograph soundings (model or balloon). Also GEFS, CMC GDPS/HRDPS, ICON-EU and HRRR smoke.
- **New layers:**
  - spaghetti models
  - recon center fixes
  - volcanoes
  - Raspberry Shake seismographs
  - drought
  - air quality
  - SVI
  - HMS fire/smoke
  - NOHRSC snow
  - HeatRisk
  - Kp
  - traffic (TomTom key)
  - wind particles
  - Meteosat and NASA polar imagery
- **Workflow:**
  - Linked second window and per-pane products.
  - Layer shortcuts (`?`).
  - Workspaces and loop export (GIF/WebM/MP4).
  - Screen recording and a bandwidth saver.
  - Appearance settings.
  - Pinned METAR panels and GPS tracks.
- **Cameras and radio:** bigger camera viewer with info and recording, including YouTube once yt-dlp is installed on the server. A big radio window with a DVR-style player that can pause, seek back and record.

## Phase 4 features

- **Panes:** 1, 2 (side by side or stacked), 3 or 4 maps. Each extra pane shows a radar product or any gridded layer, follows the main timeline, and can move with the main map or on its own. A second full map window can be opened for another monitor.
- **Drawing:** freehand, line, arrow, rectangle, circle, polygon and text, with colors, size, fill, undo/redo and clear. Drawings can be kept on the map, each with an × to delete it.
- **Recordings (server side):**
  - Radar: Level II volumes, or up to 4 Level III products.
  - Cameras: stills saved each refresh; video streams copied with ffmpeg, no re-encoding. YouTube is watch-only.
  - Start them now, on a schedule, or automatically when chosen warnings come in (nearest radar plus cameras inside the polygon).
  - Play back as a radar loop or a camera player that can follow the radar time. Make a timelapse MP4 from stills.
  - Export any or all as .zip and import on any server. Recordings are never deleted automatically.
- **Pop-out windows** for cameras and the radio player.
- **Forecast:** 24-hour chart and 7 days (NWS, or Open-Meteo outside the US).
- **Weather radio:** NOAA Weather Radio streams from wxradio.org, favorites, your own stream URLs, and a station map.
- **Search:** go to a place, or find hospitals, shelters, gas and more in view (OpenStreetMap).
- **Chasers & reports:** Spotter Network positions (public feed) and mPING reports (key).
- **Alerts:** settings per category and type: show/hide, colors, border style, striped/checkered fills, sound when new, flashing, and read-aloud. Clicking overlapping alerts steps through all of them.
- **Timeline:** history picker, frames by count or by time span, drag/scroll scrubbing, 0.25–16 fps, loading bars.
- **Also:**
  - Centered layer settings windows and a separate Basemap tab.
  - Adjustable smoothing, value under the cursor (V or hold Shift), and a movable legend.
  - Multi-radar RapidSweep.
  - Camera database import (`server/data/uploads/filtereddb.json`, de-duplicated against the live sources).
  - Files & settings backup.

## Phase 3 features

**Overlays** (Layers panel, grouped; each has a gear for color, opacity, size, labels and its own options):

- **Severe:** SPC outlooks (days 1–8, categorical, tornado, wind, hail), mesoscale discussions, watch outlines, local storm reports, GOES GLM lightning
- **Tropical:** NHC cones, tracks, forecast points and coastal watches/warnings; tropical outlook; Hurricane Hunter recon flights
- **Outlooks:** WPC excessive rainfall, WPC winter storm severity, SPC fire weather, CPC 6–10 / 8–14 / monthly / seasonal and hazards, river flood outlook
- **Surface:** fronts with pips plus highs/lows (current analysis or WPC forecast), METAR station plots with TAFs, NDBC buoys, tide predictions, river gauges, NWS offices
- **Aviation:** SIGMETs/AIRMETs, G-AIRMETs, PIREPs, airports, live flights (ADS-B)
- **Cameras:** more than 20 public camera networks (US DOTs, Canada, Finland, Iceland, Hong Kong, Singapore, New Zealand, Australia, NOAA BuoyCAMs), with icons by type. Floating viewers handle snapshots, HLS video and YouTube. You can add your own cameras, or attach one to a ship. The camera list lives in `server/data/camera_sources.json`; edit it to fix or add sources.
- **Marine:** ships via AIS. Finland and Norway work without a key; worldwide coverage needs an aisstream.io key.
- **Space:** ISS, Tiangong, Hubble and weather satellites, computed in the app. Shows ground track, footprint, next pass and NASA live video. Also an aurora forecast.
- **Hazards:** earthquakes; wildfire perimeters and hotspots
- **Fun:** Waffle House Index (locations from OpenStreetMap; the store-status check is off by default)
- **My files:** GeoJSON, KML, KMZ and GPX (drop on the map)

**Also new:** GOES RGB composites built on the server for every region (GeoColor, True Color, Air Mass, Dust, Day Cloud Phase, Fire Temperature, Night Microphysics, Day Convection), custom basemap tile servers, smoother playback (no blank frames), and nearest-radar priority when several radars overlap.

## Phase 2 features

**Layer menu** (top left of the header) switches the weather layer without opening a panel. Search, or browse by category:

- **Radar:** Level II, Level III, and MRMS radar mosaics
- **Future:** 6 hr future radar (HRRR, every 15 min), 24 hr future radar (HRRR), 72 hr future radar (RRFS), and 48 hr future snowfall (total from now). Each picks the freshest run that reaches the full time span and falls back to another model if one is late.
- **MRMS:** reflectivity, precip type and rate, hail (MESH, POSH), rotation tracks, azimuthal shear, lightning probability, VIL, echo tops, QPE 1–72 h
- **Satellite:** GOES-19/18 all 16 bands for CONUS, Full Disk, Meso 1 and 2 (values on hover); GeoColor, Air Mass, Dust and Fire RGB; Himawari-9
- **Models:** HRRR, RRFS, NAM 3 km, NAM 12 km, RAP, NBM, GFS, ECMWF IFS, HAFS-A/B. Fields include reflectivity, precip, snow, temperature, dewpoint, RH, wind, gusts, pressure, visibility, clouds, CAPE, helicity, updraft helicity, PWAT, 850 mb temperature, 500 mb height and 250 mb wind. Pick the run, plus the storm for HAFS.
- **Forecast:** NDFD grids (temperature, highs and lows, feels-like, dewpoint, RH, precip chance and amount, snow, ice, sky cover, wind, gusts, WBGT, and tornado, hail and damaging-wind probabilities)
- **Surface:** live analysis interpolated from every METAR (temperature, dewpoint, RH, wind, gust, pressure, visibility, feels-like, dewpoint depression)

How it works: the server decodes GRIB2 and NetCDF, reprojects to the map, and sends only what's on screen as compact raw values. The app colors them on the GPU, so values under the cursor are exact and units follow your settings (°F/°C, in/mm, mi/km, mph/kt).

**Fixes and changes from Phase 1 testing**
- Arrow keys step frames and tilts only (the map no longer moves)
- Level III: one button per product with a tilt selector (↑ ↓ works); switching between NEXRAD and TDWR sites picks the matching product; clear messages when a site doesn't publish a product (e.g. LPLA)
- RapidSweep: off by default; progress bar under the header and a live beam line on the map
- Ctrl+click radar sites to show several radars together (plain click shows one)
- OpenFreeMap or CARTO tiles for Dark, Light and Road (Layers panel); OpenFreeMap is the default
- Lower memory use: smaller sweep and GPU caches, live sweeps freed immediately, capped JS heap
- No token needed from the same computer
- Hover the server stats bars for details (per-core load, swap, process memory, totals)
- FPS counter, top right (Settings → FPS counter)

## Phase 1 features

**Radar**
- NEXRAD Level II, current and history, from the AWS bucket
- RapidSweep: live chunks drawn as the radar scans
- TDWR Level II through the live chunk feed
- Level III (base, dual-pol, derived, precip, TDWR products)
- Open local Level II files (or drop one on the map)

**Rendering**
- GPU radar renderer: instant color tables, smoothing, opacity
- Exact values under the cursor and the crosshair, with beam height
- `.pal` color table import; colorblind-safe tables

**Alerts**
- NWS alerts with standard colors
- Tornado Emergency / PDS / damage-threat tags
- Alert list and alert text panel
- Notifications for your saved points, with sound and desktop popups

**Map**
- Basemaps: Dark, Light, Road, Dark roadmap (vector), Terrain, Satellite, Google satellite (key), Offline
- Toolbar:
  - play/pause
  - locate
  - screenshot
  - distance and bearing from the radar
  - crosshair
  - measure
  - radar sites toggle
- Range rings, saved points, county and state lines

**Server**
- Draggable server stats panel (CPU, RAM, disk, network)
- Data source health panel
- API keys stored on the server
- Hardware profiles: full on big machines, lite on small VPSes

## Hotkeys

| Key | Action |
|---|---|
| `Space` | play/pause |
| `←` `→` | previous / next frame |
| `↑` `↓` | tilt up / down (Level II and Level III) |
| `1`–`6` | REF, VEL, SW, ZDR, CC, PHI |
| `Shift+3` | 3D view |
| `V` | value under the cursor |
| `D` | draw |
| `[` `]` | step through overlapping items |
| `,` `.` | legend filter (legend hovered) |
| `?` | all shortcuts, and your layer shortcuts |
| `C` | crosshair |
| `B` | bearing from radar |
| `M` | measure |
| `R` | radar sites |
| `L` | locate |
| `S` | screenshot |
| `Esc` | close / cancel |

## Development

```bash
cd server && cargo build --release      # server
cd app && npm install && npm run dev    # UI in a browser (vite)
cd app && npm run dist                  # AppImage -> app/release/
```

Offline testing with sample data:

```bash
tbw-server -c data/config.toml \
  --replay-dir <folder of Level II chunk files> --replay-site TORD \
  --alerts-fixture tools/fixtures/alerts_demo.geojson \
  --grid-dir <folder of GRIB2/NetCDF files named <layer>__<file>> \
  --metar-fixture <metars.cache.csv>
```

## Data sources

- NOAA NEXRAD and TDWR via AWS Open Data: `unidata-nexrad-level2`, `-level2-chunks`, `-level3`
- MRMS, HRRR, RRFS, NAM, RAP, NBM, GFS, HAFS, GOES-19/18 via NOAA Open Data on AWS
- ECMWF open data (IFS 0.25°, CC-BY-4.0)
- NDFD via tgftp.nws.noaa.gov; METARs via aviationweather.gov
- NASA GIBS (GeoColor and RGB composites, Himawari)
- National Weather Service API (alerts)
- Map tiles: © OpenStreetMap contributors, CARTO, Esri, OpenFreeMap
- Overlays, forecast, radio and search: see `docs/DATA_SOURCES.md`
