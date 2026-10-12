# Data sources

Every feed is public and keyless unless marked **key**. The server caches each one and only polls while you have it turned on.

## Radar, gridded data and satellite

| Data | Source |
|---|---|
| NEXRAD / TDWR Level II, Level III | AWS Open Data (Unidata/NOAA buckets), tgftp.nws.noaa.gov |
| MRMS, HRRR, RRFS, NAM, RAP, NBM, GFS, HAFS | NOAA Open Data on AWS |
| ECMWF IFS | data.ecmwf.int open data (CC-BY-4.0) |
| GOES-19/18 bands and RGB composites | AWS `noaa-goes19` / `noaa-goes18`. Composites are built by the server from CIRA/RAMMB quick-guide recipes |
| NASA GeoColor (full disk), Himawari | NASA GIBS WMTS (`epsg3857/best`) |
| NDFD | tgftp.nws.noaa.gov |
| European radar volumes | EUMETNET OPERA open radar data (`openradar-24h` on CloudFerro S3, CC BY 4.0); FMI Finland (`fmi-opendata-radar-volume-hdf5` on AWS) | 24 h rolling for OPERA |
| OPERA composites | Same OPERA bucket (DBZH, RATE) | CC BY 4.0 |
| Taiwan composite | CWA open data on S3 | |
| Canada, Germany radar | ECCC GeoMet WMS (OGL Canada); DWD WMS (GeoNutzV) | |
| Japan radar | JMA nowcast tiles | Credit JMA |
| Mexico radar | SMN (CONAGUA) radar images | Personal use |
| Philippines radar | PAGASA (panahon.gov.ph) | |
| Meteosat | EUMETView WMS | |
| GEFS | AWS `noaa-gefs-pds` | |
| CMC GDPS / HRDPS | MSC Datamart (dd.weather.gc.ca) | OGL Canada |
| ICON-EU | DWD open data | |
| MRMS 3D reflectivity | AWS `noaa-mrms-pds` (MergedReflectivityQC levels) | |
| Soundings | IEM RAOB archive (observed); Open-Meteo pressure levels (model) | |
| Ensembles | Open-Meteo Ensemble API (called from the app) | CC BY 4.0, non-commercial |
| METARs / TAFs / PIREPs / SIGMETs / G-AIRMETs | aviationweather.gov Data API (100 requests per minute limit) |

## Overlays

| Overlay | Source | Notes |
|---|---|---|
| SPC, WPC, CPC outlooks; NHC cones, tracks, watches/warnings; tropical outlook; national forecast chart; river flood outlook | mapservices.weather.noaa.gov (ArcGIS) | |
| Active storms | nhc.noaa.gov/CurrentStorms.json | |
| Current fronts | WPC coded surface bulletin (`ASUS02 KWBC`) on tgftp | |
| Mesoscale discussions, WPC MPDs, watch outlines, storm reports, NWS office list | Iowa Environmental Mesonet | |
| Recon (Hurricane Hunters) | NHC HDOB messages on tgftp (`urnt15` / `urpn15`) | Tracks build up while the overlay is on |
| Lightning | GOES GLM L2 (AWS) | 20 s files, kept for 30 min |
| Buoys, BuoyCAMs | NDBC | |
| Tides | NOAA CO-OPS API | |
| River gauges | NWS NWPS API | |
| Earthquakes | USGS GeoJSON feeds | |
| Wildfires | NIFC WFIGS perimeters; NASA FIRMS VIIRS 24 h files | |
| Aurora | NOAA SWPC OVATION | |
| Airports | OurAirports (public domain) | |
| Flights | airplanes.live, falling back to adsb.lol | Non-commercial use. adsb.lol data is ODbL |
| Ships | Digitraffic (Finland, CC BY 4.0); Kystverket open AIS (Norway, NLOD); aisstream.io (**key**, worldwide) | |
| ISS / satellites | CelesTrak elements | One download per 2-hour update, cached on disk |
| Waffle House | OpenStreetMap via Overpass, refreshed weekly | Store status (off by default) reads closure notices on the official store pages. There's no status API, so this is best effort |
| Cameras | `server/data/camera_sources.json` | Edit to add or fix sources. Each camera shows its source's attribution |
| Camera database | Your file in `server/data/uploads/` (`filtereddb*.json`, `*camera*.json`) | Stream-parsed; inactive, ignored and marked-duplicate records are skipped. Repeats of live-source cameras are dropped |
| Flight tracks | adsb.lol trace files (`globe.adsb.lol`), falling back to positions seen by the server | |
| NWS office positions | IEM list, moved onto the office building from OpenStreetMap where one is mapped | |
| Weather radio | wxradio.org Icecast directory (`status-json.xsl`) | Volunteer-run. One stream at a time, for direct listening only |
| Radio station map | Stream cities geocoded once with Nominatim | NOAA publishes no transmitter coordinate list |
| Spotter Network | Public placefiles (`gr-no.txt`, `gr-stream-no.txt`) | Personal, non-commercial use. Names are left out, and nothing older than 48 h is kept |
| mPING | mping.ou.edu API v2 (**key**) | General license: last 4 hours |
| Forecast | api.weather.gov (US); Open-Meteo elsewhere or as backup | Open-Meteo is CC BY 4.0, non-commercial |
| Place search | Nominatim (OpenStreetMap) | Max 1 request per second; results are cached |
| Historical warnings, reports, watches, MDs | Iowa Environmental Mesonet archives | |
| Storm attributes (storm tracks, rotation scan) | IEM `nexrad_attr.geojson` (NWS storm cell data) | |
| Spaghetti models | NHC ATCF a-decks | |
| Recon center fixes | NHC vortex messages (tgftp), IEM AFOS archive | |
| Volcanoes | USGS HANS | |
| Drought | US Drought Monitor via IEM | |
| Social Vulnerability Index | CDC/ATSDR SVI 2022 (ArcGIS) | |
| Fire and smoke | NOAA HMS daily files | |
| Air quality | AirNow public files (`reportingarea.dat`) | |
| Kp | NOAA SWPC | |
| NOHRSC snow, HeatRisk | mapservices.weather.noaa.gov (ArcGIS) | |
| Raspberry Shake | data.raspberryshake.org FDSN | Data may not be redistributed; the server only fetches on demand |
| Traffic | TomTom Traffic API (**key**, free tier) | |
| YouTube recording | yt-dlp on the server (optional) | Check the stream owner's terms before recording |
| Map search | Overpass API (overpass-api.de, overpass.private.coffee) | |

## Not used, and why

- **Blitzortung:** their terms limit raw data to project participants and forbid storm-warning use. GOES GLM covers lightning instead.
- **TrafficVision.live:** their terms forbid scraping. It needs a licence/key from them.
- **IBI "511" platforms** (Ontario, Alberta, Georgia, Idaho, Utah, Alaska, 511PA, and likely NY/FL/AZ/NV/WI/NB/NS), plus **OHGO**, **TfNSW API**, **Statens vegvesen**, **Traffic Scotland** and **National Highways**: these need registration or keys. They can go in `camera_sources.json` once you have keys.
- **Cruise ship cameras:** most lines discontinued public cams. Add any you find as ship cameras. Check each site's terms before using it.
- **FAA WeatherCams:** no public API.
- **NOAA Weather Radio transmitter locations:** there's no official machine-readable list with coordinates. Stations are shown at their stream's city instead.
- **Live chaser video maps** (Severe Studios, ChaserTV and others): no public APIs.
