//! 0.8.2: weather alerts outside the US — Canada (ECCC GeoMet) and international official CAP
//! sources (MeteoAlarm for Europe, national CAP feeds registered with the WMO).
//!
//! Cheap by design: a source is only fetched while some app wants it (`POST /api/alerts/want`,
//! sent while the map looks there, the Alerts tab is open, or — Canada — while its toggle is on).
//! Sources nobody asked for in 30 minutes are dropped from the alert set. Fetching runs a few
//! sources at a time; CAP documents are fetched once and kept while their feed lists them.

use crate::alerts::Alerts;
use crate::alerts_cap::{self as cap, CapAlert, SrcMeta};
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// ECCC GeoMet OGC API features
    GeoMet,
    /// MeteoAlarm legacy Atom (CAP fields inline)
    MeteoAlarm,
    /// RSS / Atom feed linking CAP documents (or a CAP document itself)
    Cap,
}

pub struct Source {
    pub id: &'static str,
    pub name: &'static str,
    /// ISO 3166-1 alpha-2
    pub country: &'static str,
    pub kind: Kind,
    pub url: &'static str,
    /// keep only links containing this (feeds that mix web pages and CAP files)
    pub must: Option<&'static str>,
    /// W, S, E, N (rough; decides "the map is looking there")
    pub bbox: [f64; 4],
}

impl Source {
    pub fn region(&self) -> &'static str {
        if self.country == "CA" { "ca" } else { "intl" }
    }
    pub fn attribution(&self) -> String {
        match self.kind {
            Kind::GeoMet => "Environment and Climate Change Canada (Open Government Licence – Canada)".into(),
            Kind::MeteoAlarm => "MeteoAlarm.org / EUMETNET and the national service (CC BY 4.0)".into(),
            Kind::Cap => format!("{} (official CAP feed)", self.name),
        }
    }
    fn poll_secs(&self) -> u64 {
        match self.kind {
            Kind::GeoMet => 180,
            Kind::MeteoAlarm => 300,
            Kind::Cap => 600,
        }
    }
}

macro_rules! ma {
    ($id:literal, $slug:literal, $name:literal, $c:literal, $w:expr, $s:expr, $e:expr, $n:expr) => {
        Source { id: concat!("ma-", $id), name: concat!("MeteoAlarm · ", $name), country: $c, kind: Kind::MeteoAlarm, url: concat!("https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-", $slug), must: None, bbox: [$w, $s, $e, $n] }
    };
}
macro_rules! capf {
    ($id:literal, $name:literal, $c:literal, $url:literal, $w:expr, $s:expr, $e:expr, $n:expr) => {
        Source { id: $id, name: $name, country: $c, kind: Kind::Cap, url: $url, must: None, bbox: [$w, $s, $e, $n] }
    };
    ($id:literal, $name:literal, $c:literal, $url:literal, $must:literal, $w:expr, $s:expr, $e:expr, $n:expr) => {
        Source { id: $id, name: $name, country: $c, kind: Kind::Cap, url: $url, must: Some($must), bbox: [$w, $s, $e, $n] }
    };
}

/// Keyless official sources. Feeds come from the WMO Register of Alerting Authorities (many are
/// mirrored by the WMO / IFRC alert hub on cap-sources.s3.amazonaws.com).
pub static SOURCES: &[Source] = &[
    Source { id: "eccc", name: "Environment Canada", country: "CA", kind: Kind::GeoMet, url: "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&lang=en&limit=1000", must: None, bbox: [-141.1, 41.6, -52.6, 83.2] },
    // ---- MeteoAlarm (EUMETNET) ----
    ma!("ad", "andorra", "Andorra", "AD", 1.4, 42.4, 1.8, 42.7),
    ma!("at", "austria", "Austria", "AT", 9.5, 46.3, 17.2, 49.1),
    ma!("be", "belgium", "Belgium", "BE", 2.5, 49.5, 6.4, 51.6),
    ma!("ba", "bosnia-herzegovina", "Bosnia and Herzegovina", "BA", 15.7, 42.5, 19.7, 45.3),
    ma!("bg", "bulgaria", "Bulgaria", "BG", 22.3, 41.2, 28.7, 44.3),
    ma!("hr", "croatia", "Croatia", "HR", 13.4, 42.3, 19.5, 46.6),
    ma!("cy", "cyprus", "Cyprus", "CY", 32.2, 34.5, 34.6, 35.7),
    ma!("cz", "czechia", "Czechia", "CZ", 12.0, 48.5, 18.9, 51.1),
    ma!("dk", "denmark", "Denmark", "DK", 8.0, 54.5, 15.3, 57.8),
    ma!("ee", "estonia", "Estonia", "EE", 21.7, 57.5, 28.3, 59.7),
    ma!("fi", "finland", "Finland", "FI", 19.0, 59.7, 31.6, 70.1),
    ma!("fr", "france", "France", "FR", -5.3, 41.3, 9.6, 51.2),
    ma!("de", "germany", "Germany", "DE", 5.8, 47.2, 15.1, 55.1),
    ma!("gr", "greece", "Greece", "GR", 19.3, 34.8, 29.7, 41.8),
    ma!("hu", "hungary", "Hungary", "HU", 16.1, 45.7, 22.9, 48.6),
    ma!("is", "iceland", "Iceland", "IS", -24.6, 63.2, -13.4, 66.6),
    ma!("ie", "ireland", "Ireland", "IE", -10.7, 51.4, -5.9, 55.4),
    ma!("il", "israel", "Israel", "IL", 34.2, 29.4, 35.9, 33.4),
    ma!("it", "italy", "Italy", "IT", 6.6, 35.4, 18.6, 47.1),
    ma!("lv", "latvia", "Latvia", "LV", 20.9, 55.6, 28.3, 58.1),
    ma!("lt", "lithuania", "Lithuania", "LT", 20.9, 53.9, 26.9, 56.5),
    ma!("lu", "luxembourg", "Luxembourg", "LU", 5.7, 49.4, 6.6, 50.2),
    ma!("mt", "malta", "Malta", "MT", 14.1, 35.8, 14.6, 36.1),
    ma!("md", "moldova", "Moldova", "MD", 26.6, 45.4, 30.2, 48.5),
    ma!("me", "montenegro", "Montenegro", "ME", 18.4, 41.8, 20.4, 43.6),
    ma!("nl", "netherlands", "Netherlands", "NL", 3.3, 50.7, 7.3, 53.6),
    ma!("mk", "republic-of-north-macedonia", "North Macedonia", "MK", 20.4, 40.8, 23.1, 42.4),
    ma!("no", "norway", "Norway", "NO", 4.5, 57.9, 31.2, 71.2),
    ma!("pl", "poland", "Poland", "PL", 14.1, 49.0, 24.2, 54.9),
    ma!("pt", "portugal", "Portugal", "PT", -31.3, 32.6, -6.2, 42.2),
    ma!("ro", "romania", "Romania", "RO", 20.2, 43.6, 29.8, 48.3),
    ma!("rs", "serbia", "Serbia", "RS", 18.8, 42.2, 23.0, 46.2),
    ma!("sk", "slovakia", "Slovakia", "SK", 16.8, 47.7, 22.6, 49.6),
    ma!("si", "slovenia", "Slovenia", "SI", 13.4, 45.4, 16.6, 46.9),
    ma!("es", "spain", "Spain", "ES", -18.2, 27.6, 4.4, 43.8),
    ma!("se", "sweden", "Sweden", "SE", 11.0, 55.3, 24.2, 69.1),
    ma!("ch", "switzerland", "Switzerland", "CH", 5.9, 45.8, 10.5, 47.8),
    ma!("ua", "ukraine", "Ukraine", "UA", 22.1, 44.4, 40.2, 52.4),
    ma!("gb", "united-kingdom", "United Kingdom", "GB", -8.7, 49.8, 1.8, 60.9),
    // ---- national CAP feeds ----
    capf!("au-bom", "Australian Bureau of Meteorology", "AU", "https://severeweather.wmo.int/v2/cap-alerts/au-bom-en/rss.xml", 112.9, -43.7, 153.7, -10.0),
    capf!("nz-metservice", "MetService New Zealand", "NZ", "https://alerts.metservice.com/cap/rss", "/cap/alert", 166.0, -47.4, 178.7, -34.3),
    capf!("br-inmet", "INMET Brazil", "BR", "https://apiprevmet3.inmet.gov.br/avisos/rss", "/avisos/rss/", -74.0, -33.8, -34.7, 5.3),
    capf!("mx-smn", "SMN Mexico", "MX", "https://smn.conagua.gob.mx/tools/PHP/feedsmn/cap.php", -118.4, 14.5, -86.7, 32.7),
    capf!("ar-smn", "SMN Argentina", "AR", "https://ssl.smn.gob.ar/CAP/AR.php", -73.6, -55.1, -53.6, -21.8),
    capf!("cl-dmc", "Dirección Meteorológica de Chile", "CL", "https://archivos.meteochile.gob.cl/portaldmc/rss/rss.php", -75.7, -56.0, -66.4, -17.5),
    capf!("uy-inumet", "INUMET Uruguay", "UY", "https://www.inumet.gub.uy/reportes/riesgo/rss.xml", -58.4, -35.0, -53.1, -30.1),
    capf!("co-ideam", "IDEAM Colombia", "CO", "https://severeweather.wmo.int/v2/cap-alerts/co-ideam-es/rss.xml", -79.0, -4.2, -66.9, 12.5),
    capf!("ec-inamhi", "INAMHI Ecuador", "EC", "https://cap-sources.s3.amazonaws.com/ec-inamhi-es/rss.xml", -81.1, -5.0, -75.2, 1.5),
    capf!("py-dmh", "DMH Paraguay", "PY", "https://cap-sources.s3.amazonaws.com/py-dmh-es/rss.xml", -62.7, -27.6, -54.3, -19.3),
    capf!("cr-imn", "IMN Costa Rica", "CR", "https://cap-sources.s3.amazonaws.com/cr-imn-es/rss.xml", -86.0, 8.0, -82.5, 11.3),
    capf!("pa-imhpa", "IMHPA Panama", "PA", "https://cap-sources.s3.amazonaws.com/pa-imhpa-es/rss.xml", -83.1, 7.2, -77.2, 9.7),
    capf!("do-indomet", "INDOMET Dominican Republic", "DO", "https://cap-sources.s3.amazonaws.com/do-indomet-es/rss.xml", -72.1, 17.5, -68.3, 20.0),
    capf!("bz-nms", "NMS Belize", "BZ", "https://cap-sources.s3.amazonaws.com/bz-nms-en/rss.xml", -89.3, 15.9, -87.5, 18.5),
    capf!("gy-hms", "Hydromet Guyana", "GY", "https://cap-sources.s3.amazonaws.com/gy-hms-en/rss.xml", -61.4, 1.2, -56.5, 8.6),
    capf!("sr-meteo", "Meteorological Service Suriname", "SR", "https://cap-sources.s3.amazonaws.com/sr-meteo-en/rss.xml", -58.1, 1.8, -53.9, 6.0),
    capf!("jm-msj", "Meteorological Service Jamaica", "JM", "https://alert.metservice.gov.jm/capfeed.php", -78.4, 17.7, -76.2, 18.6),
    capf!("tt-ttms", "Trinidad and Tobago Met Service", "TT", "https://metproducts.gov.tt/ttms/public/api/feed?type=rss", -61.95, 10.0, -60.5, 11.4),
    capf!("cw-meteo", "Meteorological Department Curaçao", "CW", "https://www.meteo.cw/rss/CAP_en.xml", -69.2, 12.0, -68.7, 12.4),
    capf!("ai-dma", "Anguilla DMA", "AI", "https://axa-primary.capews.com/capews/public/atom?type=cap", -63.5, 18.1, -62.9, 18.6),
    capf!("ag-met", "Antigua and Barbuda Met Service", "AG", "https://atg-primary.capews.com/capews/public/atom?type=cap", -62.4, 16.9, -61.6, 17.8),
    capf!("bb-dem", "Barbados DEM", "BB", "https://brb-primary.capews.com/capews/public/atom?type=cap", -59.7, 13.0, -59.4, 13.4),
    capf!("vc-met", "St Vincent and the Grenadines Met Service", "VC", "https://vct-primary.capews.com/capews/public/atom?type=cap", -61.5, 12.5, -61.1, 13.4),
    capf!("lc-met", "Saint Lucia Met Services", "LC", "https://saint-lucia.cap-composer.wiscaribbeancmo.org/api/cap/rss.xml", -61.1, 13.7, -60.8, 14.2),
    capf!("tc-gov", "Turks and Caicos DDME", "TC", "https://cap-sources.s3.amazonaws.com/tc-gov-en/rss.xml", -72.5, 21.0, -71.0, 22.0),
    // Africa
    capf!("za-saws", "South African Weather Service", "ZA", "https://severeweather.wmo.int/v2/cap-alerts/za-saws-en/rss.xml", 16.3, -34.9, 32.9, -22.1),
    capf!("eg-ema", "Egyptian Meteorological Authority", "EG", "https://cap-sources.s3.amazonaws.com/eg-ema-en/rss.xml", 24.7, 22.0, 36.9, 31.7),
    capf!("ly-nmc", "National Meteorological Center Libya", "LY", "https://cap-sources.s3.amazonaws.com/ly-nmc-en/rss.xml", 9.3, 19.5, 25.2, 33.2),
    capf!("tn-inm", "INM Tunisia", "TN", "https://cap-sources.s3.amazonaws.com/tn-meteo-en/rss.xml", 7.5, 30.2, 11.6, 37.6),
    capf!("ao-inamet", "INAMET Angola", "AO", "https://cap-sources.s3.amazonaws.com/ao-inamet-en/rss.xml", 11.6, -18.1, 24.1, -4.4),
    capf!("ls-lms", "Lesotho Meteorological Services", "LS", "https://cap-sources.s3.amazonaws.com/ls-lms-en/rss.xml", 27.0, -30.7, 29.5, -28.5),
    capf!("bw-dms", "Botswana Meteorological Services", "BW", "https://cap-sources.s3.amazonaws.com/bw-met-en/rss.xml", 19.9, -26.9, 29.4, -17.8),
    capf!("cm-meteo", "Météo Cameroun", "CM", "https://cap-sources.s3.amazonaws.com/cm-meteo-en/rss.xml", 8.4, 1.6, 16.2, 13.1),
    capf!("cf-dmn", "Météo Centrafrique", "CF", "https://cap-sources.s3.amazonaws.com/cf-dmn-fr/rss.xml", 14.4, 2.2, 27.5, 11.0),
    capf!("ci-sodexam", "SODEXAM Côte d'Ivoire", "CI", "https://cap-sources.s3.amazonaws.com/ci-sodexam-fr/rss.xml", -8.6, 4.3, -2.5, 10.8),
    capf!("ga-dgm", "DGM Gabon", "GA", "https://cap-sources.s3.amazonaws.com/ga-dgm-fr/rss.xml", 8.7, -4.0, 14.5, 2.4),
    capf!("mg-meteo", "Météo Madagascar", "MG", "https://cap-sources.s3.amazonaws.com/mg-meteo-en/rss.xml", 43.2, -25.7, 50.5, -11.9),
    capf!("mz-inam", "INAM Mozambique", "MZ", "https://cap-sources.s3.amazonaws.com/mz-inam-pt/rss.xml", 30.2, -26.9, 40.9, -10.4),
    capf!("ng-nimet", "NiMet Nigeria", "NG", "https://cap-sources.s3.amazonaws.com/ng-nimet-en/rss.xml", 2.6, 4.2, 14.7, 13.9),
    capf!("sn-anacim", "ANACIM Senegal", "SN", "https://cap-sources.s3.amazonaws.com/sn-anacim-fr/rss.xml", -17.6, 12.3, -11.3, 16.7),
    capf!("st-inm", "INM São Tomé and Príncipe", "ST", "https://cap-sources.s3.amazonaws.com/st-meteo-pt/rss.xml", 6.4, -0.1, 7.5, 1.8),
    capf!("tz-tma", "Tanzania Meteorological Authority", "TZ", "https://cap-sources.s3.amazonaws.com/tz-tma-en/rss.xml", 29.3, -11.8, 40.5, -0.9),
    capf!("sz-met", "Eswatini Meteorological Service", "SZ", "https://cap-sources.s3.amazonaws.com/sz-met-en/rss.xml", 30.7, -27.4, 32.2, -25.7),
    capf!("mu-mms", "Mauritius Meteorological Services", "MU", "https://cap-sources.s3.amazonaws.com/mu-mms-en/rss.xml", 56.5, -20.6, 63.6, -10.3),
    capf!("bj-meteo", "Météo Bénin", "BJ", "https://www.meteobenin.bj/api/cap/rss.xml", 0.7, 6.2, 3.9, 12.4),
    capf!("bf-meteo", "Météo Burkina", "BF", "https://meteoburkina.bf/api/cap/rss.xml", -5.6, 9.4, 2.4, 15.1),
    capf!("bi-igebu", "IGEBU Burundi", "BI", "https://www.igebu.bi/api/cap/rss.xml", 29.0, -4.5, 30.9, -2.3),
    capf!("td-meteo", "Météo Tchad", "TD", "https://www.meteotchad.org/api/cap/rss.xml", 13.5, 7.4, 24.0, 23.5),
    capf!("km-meteo", "Météo Comores", "KM", "https://meteocomores.km/api/cap/rss.xml", 43.2, -12.5, 44.6, -11.3),
    capf!("cg-dirmet", "DIRMET Congo", "CG", "https://dirmet.cg/api/cap/rss.xml", 11.1, -5.1, 18.7, 3.8),
    capf!("cd-meteo", "METTELSAT DR Congo", "CD", "https://meteordcongo.cd/api/cap/rss.xml", 12.2, -13.5, 31.4, 5.4),
    capf!("dj-meteo", "Météo Djibouti", "DJ", "https://meteodjibouti.dj/api/cap/rss.xml", 41.7, 10.9, 43.5, 12.8),
    capf!("et-emi", "Ethiopian Meteorological Institute", "ET", "https://www.ethiomet.gov.et/api/cap/rss.xml", 32.9, 3.4, 48.0, 15.0),
    capf!("gm-dwr", "Gambia Department of Water Resources", "GM", "https://meteogambia.gm/api/cap/rss.xml", -16.9, 13.0, -13.7, 13.9),
    capf!("gh-gmet", "Ghana Meteorological Agency", "GH", "https://www.meteo.gov.gh/api/cap/rss.xml", -3.3, 4.7, 1.2, 11.2),
    capf!("gn-anm", "ANM Guinea", "GN", "https://anmeteo.gov.gn/api/cap/rss.xml", -15.1, 7.2, -7.6, 12.7),
    capf!("gw-inm", "INM Guinea-Bissau", "GW", "https://meteoguinebissau.gw/api/cap/rss.xml", -16.8, 10.9, -13.6, 12.7),
    capf!("ke-kmd", "Kenya Meteorological Department", "KE", "https://meteo.go.ke/api/cap/rss.xml", 33.9, -4.7, 41.9, 5.0),
    capf!("lr-met", "Liberia Meteorological Service", "LR", "https://meteoliberia.com/api/cap/rss.xml", -11.5, 4.3, -7.4, 8.6),
    capf!("mw-dccms", "Malawi DCCMS", "MW", "https://www.metmalawi.gov.mw/api/cap/rss.xml", 32.7, -17.2, 35.9, -9.4),
    capf!("ml-meteo", "Mali-Météo", "ML", "https://www.malimeteo.ml/api/cap/rss.xml", -12.3, 10.1, 4.3, 25.0),
    capf!("mr-onm", "ONM Mauritania", "MR", "https://meteomauritanie.mr/api/cap/rss.xml", -17.1, 14.7, -4.8, 27.3),
    capf!("ne-meteo", "Météo Niger", "NE", "https://www.niger-meteo.ne/api/cap/rss.xml", 0.1, 11.6, 16.0, 23.6),
    capf!("sc-sma", "Seychelles Meteorological Authority", "SC", "https://www.meteo.sc/api/cap/rss.xml", 46.2, -10.3, 56.3, -3.7),
    capf!("sl-slmet", "Sierra Leone Meteorological Agency", "SL", "https://slmet.gov.sl/api/cap/rss.xml", -13.4, 6.9, -10.2, 10.0),
    capf!("so-sodma", "Somalia Meteorological Service", "SO", "https://meteosomalia.so/api/cap/rss.xml", 40.9, -1.7, 51.5, 12.0),
    capf!("ss-ssmd", "South Sudan Meteorological Department", "SS", "https://meteosouthsudan.com.ss/api/cap/rss.xml", 23.4, 3.4, 36.0, 12.3),
    capf!("sd-sma", "Sudan Meteorological Authority", "SD", "https://meteosudan.sd/api/cap/rss.xml", 21.8, 8.6, 38.6, 22.3),
    capf!("tg-meteo", "Météo Togo", "TG", "https://meteotogo.tg/api/cap/rss.xml", -0.2, 6.1, 1.9, 11.2),
    capf!("ug-unma", "Uganda National Meteorological Authority", "UG", "https://wids.mwe.go.ug/api/v1/cap/feed", 29.5, -1.5, 35.1, 4.3),
    capf!("zm-zmd", "Zambia Meteorological Department", "ZM", "https://zmd.gov.zm/api/cap/rss.xml", 21.9, -18.1, 33.8, -8.2),
    capf!("zw-msd", "Zimbabwe Meteorological Services", "ZW", "https://www.weatherzw.org.zw/api/cap/rss.xml", 25.2, -22.5, 33.1, -15.6),
    // Asia / Middle East / Pacific
    capf!("cn-cma", "China Meteorological Administration", "CN", "https://severeweather.wmo.int/v2/cap-alerts/cn-cma-xx/rss.xml", 73.5, 18.1, 134.8, 53.6),
    capf!("hk-hko", "Hong Kong Observatory", "HK", "https://alerts.weather.gov.hk/V1/cap_atom.xml", 113.8, 22.1, 114.5, 22.6),
    capf!("mo-smg", "SMG Macao", "MO", "https://rss.smg.gov.mo/cap_rss.xml", 113.5, 22.1, 113.6, 22.2),
    capf!("in-imd", "India Meteorological Department", "IN", "https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml", 68.1, 6.7, 97.4, 35.7),
    capf!("pk-pmd", "Pakistan Meteorological Department", "PK", "https://cap-sources.s3.amazonaws.com/pk-pmd-en/rss.xml", 60.9, 23.7, 77.8, 37.1),
    capf!("af-andma", "ANDMA Afghanistan", "AF", "https://cap-sources.s3.amazonaws.com/af-andma-en/rss.xml", 60.5, 29.4, 74.9, 38.5),
    capf!("ir-irimo", "IRIMO Iran", "IR", "https://cap-sources.s3.amazonaws.com/ir-irimo-en/rss.xml", 44.0, 25.1, 63.3, 39.8),
    capf!("mn-namem", "NAMEM Mongolia", "MN", "https://cap-sources.s3.amazonaws.com/mn-namem-en/rss.xml", 87.7, 41.6, 119.9, 52.2),
    capf!("mv-mms", "Maldives Meteorological Service", "MV", "https://cap.meteorology.gov.mv/rss/alerts/", 72.6, -0.7, 73.8, 7.1),
    capf!("sg-mss", "Meteorological Service Singapore", "SG", "https://www.weather.gov.sg/files/rss/rsscapalert/rsscapalert.xml", 103.6, 1.2, 104.1, 1.5),
    capf!("tl-dnmg", "DNMG Timor-Leste", "TL", "https://cap-sources.s3.amazonaws.com/tl-dnmg-en/rss.xml", 124.0, -9.5, 127.3, -8.1),
    capf!("om-met", "Oman Meteorology", "OM", "https://cap-sources.s3.amazonaws.com/om-met-en/rss.xml", 52.0, 16.6, 59.8, 26.4),
    capf!("qa-caa", "Qatar Meteorology Department", "QA", "https://cap-sources.s3.amazonaws.com/qa-caa-en/rss.xml", 50.7, 24.5, 51.7, 26.2),
    capf!("bh-meteo", "Bahrain Meteorological Directorate", "BH", "https://cap-sources.s3.amazonaws.com/bh-meteo-en/rss.xml", 50.3, 25.8, 50.8, 26.3),
    capf!("kw-met", "Kuwait Meteorological Department", "KW", "https://www.met.gov.kw/rss_eng/kuwait_cap.xml", 46.5, 28.5, 48.5, 30.1),
    capf!("jo-jmd", "Jordan Meteorological Department", "JO", "https://cap-sources.s3.amazonaws.com/jo-meteo-en/rss.xml", 34.9, 29.2, 39.3, 33.4),
    capf!("al-igewe", "IGEWE Albania", "AL", "https://cap-sources.s3.amazonaws.com/al-igewe-en/rss.xml", 19.3, 39.6, 21.1, 42.7),
    capf!("ru-hmc", "Hydrometcenter of Russia", "RU", "https://meteoinfo.ru/hmc-output/cap/cap-feed/en/atom.xml", 19.6, 41.2, 180.0, 81.9),
    capf!("by-belgidromet", "Belhydromet Belarus", "BY", "https://meteoalert.meteoinfo.ru/belarus/cap-feed/en/atom.xml", 23.2, 51.3, 32.8, 56.2),
    capf!("kz-kazhydromet", "Kazhydromet Kazakhstan", "KZ", "https://meteoalert.meteoinfo.ru/kazakhstan/cap-feed/en/atom.xml", 46.5, 40.6, 87.4, 55.4),
    capf!("kg-hydromet", "Kyrgyzhydromet", "KG", "https://meteoalert.meteoinfo.ru/kyrgyzstan/cap-feed/en/atom.xml", 69.3, 39.2, 80.3, 43.3),
    capf!("uz-uzhydromet", "Uzhydromet Uzbekistan", "UZ", "https://meteoalert.meteoinfo.ru/uzbekistan/cap-feed/en/atom.xml", 56.0, 37.2, 73.1, 45.6),
    capf!("tv-met", "Tuvalu Meteorological Service", "TV", "https://cap-sources.s3.amazonaws.com/tv-tuvmet-en/rss.xml", 176.0, -10.8, 179.9, -5.6),
    capf!("vu-vmgd", "Vanuatu VMGD", "VU", "https://cap-sources.s3.amazonaws.com/vu-vmgd-en/rss.xml", 166.5, -20.3, 170.3, -13.0),
    capf!("sb-met", "Solomon Islands Meteorological Service", "SB", "https://cap-sources.s3.amazonaws.com/sb-met-en/rss.xml", 155.5, -12.4, 170.2, -6.5),
];

pub fn source(id: &str) -> Option<&'static Source> {
    SOURCES.iter().find(|s| s.id == id)
}

fn meta(s: &Source) -> (SrcMeta<'static>, String) {
    let a = s.attribution();
    (SrcMeta { id: s.id, name: s.name, country: s.country, region: s.region(), attribution: "", centre: [(s.bbox[0] + s.bbox[2]) / 2.0, (s.bbox[1] + s.bbox[3]) / 2.0] }, a)
}

/// CAP alerts → features, dropping the ones a newer message updates or cancels.
pub fn cap_set_features(src: &SrcMeta, alerts: &[CapAlert], now: chrono::DateTime<chrono::Utc>) -> Vec<Value> {
    let superseded: HashSet<&str> = alerts.iter().flat_map(|a| a.references.iter().map(|r| r.as_str())).collect();
    let mut seen = HashSet::new();
    alerts
        .iter()
        .filter(|a| !superseded.contains(a.identifier.as_str()) && seen.insert(a.identifier.clone()))
        .filter_map(|a| cap::cap_feature(src, a, now))
        .collect()
}

/// Features for one fetched payload (no network; the poller fetches). For `Kind::Cap` the CAP
/// documents are passed in `docs`.
pub fn features_for(s: &Source, body: &str, docs: &[CapAlert], now: chrono::DateTime<chrono::Utc>) -> Vec<Value> {
    let (m, attr) = meta(s);
    let m = SrcMeta { attribution: &attr, ..m };
    let mut out = match s.kind {
        Kind::GeoMet => serde_json::from_str::<Value>(body).map(|v| cap::geomet_features(&m, &v, now)).unwrap_or_default(),
        Kind::MeteoAlarm => cap::meteoalarm_features(&m, body, now),
        Kind::Cap => cap_set_features(&m, docs, now),
    };
    out.truncate(3000);
    out
}

#[derive(Default)]
struct SrcState {
    fetched: Option<Instant>,
    count: usize,
    error: Option<String>,
    /// CAP document cache (url → parsed, None = unparsable)
    docs: HashMap<String, Option<CapAlert>>,
    has_data: bool,
}

pub struct Intl {
    canada: AtomicBool,
    international: AtomicBool,
    want: RwLock<HashMap<&'static str, Instant>>,
    state: Mutex<HashMap<&'static str, SrcState>>,
    wake: tokio::sync::Notify,
}

const WANT_TTL: Duration = Duration::from_secs(20 * 60);
const DROP_AFTER: Duration = Duration::from_secs(30 * 60);

impl Intl {
    pub fn new(canada: bool, international: bool) -> Self {
        Self { canada: AtomicBool::new(canada), international: AtomicBool::new(international), want: RwLock::new(HashMap::new()), state: Mutex::new(HashMap::new()), wake: tokio::sync::Notify::new() }
    }

    /// config: `[alerts] canada` / `international`
    pub fn set_regions(&self, canada: bool, international: bool) {
        self.canada.store(canada, Ordering::Relaxed);
        self.international.store(international, Ordering::Relaxed);
    }

    fn allowed(&self, s: &Source) -> bool {
        if s.region() == "ca" { self.canada.load(Ordering::Relaxed) } else { self.international.load(Ordering::Relaxed) }
    }

    /// An app wants these sources (ids; "ca" = Canada, "intl" = every international source).
    pub fn want(&self, ids: &[String]) -> usize {
        let now = Instant::now();
        let mut w = self.want.write();
        let mut n = 0;
        let mut fresh = false;
        for id in ids {
            for s in SOURCES.iter().filter(|s| (s.id == id || (id == "ca" && s.region() == "ca") || (id == "intl" && s.region() == "intl")) && self.allowed(s)) {
                if w.insert(s.id, now).is_none_or(|t| now.duration_since(t) > WANT_TTL) {
                    fresh = true;
                }
                n += 1;
            }
        }
        drop(w);
        if fresh {
            self.wake.notify_one();
        }
        n
    }

    /// Source list for the app (bbox decides which ones the map is looking at).
    pub fn list(&self) -> Value {
        let st = self.state.lock();
        let w = self.want.read();
        let now = Instant::now();
        let v: Vec<Value> = SOURCES
            .iter()
            .map(|s| {
                let x = st.get(s.id);
                json!({
                    "id": s.id, "name": s.name, "country": s.country, "region": s.region(), "bbox": s.bbox,
                    "attribution": s.attribution(), "url": s.url, "enabled": self.allowed(s),
                    "active": w.get(s.id).is_some_and(|t| now.duration_since(*t) < WANT_TTL),
                    "count": x.map(|x| x.count).unwrap_or(0),
                    "error": x.and_then(|x| x.error.clone()),
                    "age_s": x.and_then(|x| x.fetched).map(|t| now.duration_since(t).as_secs()),
                })
            })
            .collect();
        json!({"sources": v, "canada": self.canada.load(Ordering::Relaxed), "international": self.international.load(Ordering::Relaxed)})
    }
}

impl Alerts {
    /// 0.8.2: start the Canada / international poller.
    pub fn spawn_intl(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                me.intl_tick().await;
                let _ = tokio::time::timeout(Duration::from_secs(20), me.intl.wake.notified()).await;
            }
        });
    }

    async fn intl_tick(self: &Arc<Self>) {
        let now = Instant::now();
        let due: Vec<&'static Source> = {
            let w = self.intl.want.read();
            let st = self.intl.state.lock();
            SOURCES
                .iter()
                .filter(|s| self.intl.allowed(s) && w.get(s.id).is_some_and(|t| now.duration_since(*t) < WANT_TTL))
                .filter(|s| {
                    let x = st.get(s.id);
                    let every = if x.is_some_and(|x| x.error.is_some()) { 900 } else { s.poll_secs() };
                    x.and_then(|x| x.fetched).is_none_or(|t| now.duration_since(t).as_secs() >= every)
                })
                .collect()
        };
        // nobody asked for a while: drop their alerts
        let stale: Vec<&'static str> = {
            let w = self.intl.want.read();
            let st = self.intl.state.lock();
            st.iter().filter(|(id, x)| x.has_data && w.get(*id).is_none_or(|t| now.duration_since(*t) > DROP_AFTER)).map(|(id, _)| *id).collect()
        };
        for id in stale {
            self.apply_source(id, vec![]);
            if let Some(x) = self.intl.state.lock().get_mut(id) {
                x.has_data = false;
                x.count = 0;
                x.docs.clear();
            }
        }
        // a few sources at a time (keeps a 4-vCore VPS comfortable)
        for chunk in due.chunks(4) {
            futures::future::join_all(chunk.iter().map(|s| self.fetch_source(s))).await;
        }
        if !due.is_empty() {
            self.intl_health();
        }
    }

    fn intl_health(&self) {
        let st = self.intl.state.lock();
        for (key, name, region) in [("alerts-ca", "Canada alerts (ECCC)", "ca"), ("alerts-intl", "International alerts", "intl")] {
            let xs: Vec<(&Source, &SrcState)> = SOURCES.iter().filter(|s| s.region() == region).filter_map(|s| st.get(s.id).filter(|x| x.fetched.is_some()).map(|x| (s, x))).collect();
            if xs.is_empty() {
                continue;
            }
            let n: usize = xs.iter().map(|(_, x)| x.count).sum();
            let bad: Vec<&(&Source, &SrcState)> = xs.iter().filter(|(_, x)| x.error.is_some()).collect();
            if region == "ca" && !bad.is_empty() {
                self.health.err(key, name, bad[0].1.error.clone().unwrap_or_default());
            } else if bad.is_empty() {
                self.health.ok(key, name, format!("{n} active · {} source{}", xs.len(), if xs.len() == 1 { "" } else { "s" }));
            } else {
                let first = bad.iter().take(3).map(|(s, x)| format!("{}: {}", s.country, x.error.as_deref().unwrap_or(""))).collect::<Vec<_>>().join("; ");
                self.health.ok(key, name, format!("{n} active · {}/{} sources failing ({first})", bad.len(), xs.len()));
            }
        }
    }

    async fn get_text(&self, url: &str) -> anyhow::Result<String> {
        let r = self.http.get(url).header("Accept", "application/geo+json, application/atom+xml, application/rss+xml, application/cap+xml, application/xml, text/xml, */*").timeout(Duration::from_secs(25)).send().await?;
        if !r.status().is_success() {
            anyhow::bail!("HTTP {}", r.status());
        }
        let b = r.bytes().await?;
        if b.len() > 40 << 20 {
            anyhow::bail!("response too large");
        }
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    async fn fetch_source(&self, s: &'static Source) {
        let res = self.fetch_source_inner(s).await;
        let mut st = self.intl.state.lock();
        let x = st.entry(s.id).or_default();
        x.fetched = Some(Instant::now());
        match res {
            Ok(feats) => {
                x.error = None;
                x.count = feats.len();
                x.has_data = true;
                drop(st);
                self.apply_source(s.id, feats);
            }
            Err(e) => {
                let msg = e.to_string();
                x.error = Some(msg.chars().take(120).collect());
                tracing::debug!("alerts {}: {msg}", s.id);
            }
        }
    }

    async fn fetch_source_inner(&self, s: &'static Source) -> anyhow::Result<Vec<Value>> {
        let now = chrono::Utc::now();
        match s.kind {
            Kind::GeoMet => {
                // follow `next` pages (bounded)
                let mut url = s.url.to_string();
                let mut all: Vec<Value> = vec![];
                for _ in 0..6 {
                    let body = self.get_text(&url).await?;
                    let v: Value = serde_json::from_str(&body)?;
                    all.extend(v["features"].as_array().cloned().unwrap_or_default());
                    let next = v["links"].as_array().and_then(|ls| ls.iter().find(|l| l["rel"] == "next")).and_then(|l| l["href"].as_str()).map(String::from);
                    match next {
                        Some(n) if v["features"].as_array().is_some_and(|f| !f.is_empty()) => url = n,
                        _ => break,
                    }
                }
                Ok(features_for(s, &json!({"features": all}).to_string(), &[], now))
            }
            Kind::MeteoAlarm => Ok(features_for(s, &self.get_text(s.url).await?, &[], now)),
            Kind::Cap => {
                let body = self.get_text(s.url).await?;
                let entries = cap::parse_feed(&body, s.url, s.must);
                let mut docs: Vec<CapAlert> = entries.iter().filter_map(|e| e.embedded.clone()).collect();
                let urls: Vec<String> = entries.iter().filter(|e| e.embedded.is_none()).flat_map(|e| e.cap_urls.iter().cloned()).collect();
                let (_have, need): (Vec<String>, Vec<String>) = {
                    let st = self.intl.state.lock();
                    let cache = st.get(s.id).map(|x| &x.docs);
                    urls.iter().cloned().partition(|u| cache.is_some_and(|c| c.contains_key(u)))
                };
                let need: Vec<String> = need.into_iter().take(80).collect();
                let mut fetched: Vec<(String, Option<CapAlert>)> = vec![];
                for chunk in need.chunks(4) {
                    let rs = futures::future::join_all(chunk.iter().map(|u| self.get_text(u))).await;
                    for (u, r) in chunk.iter().zip(rs) {
                        match r {
                            Ok(t) => fetched.push((u.clone(), cap::parse_cap_str(&t))),
                            Err(_) => {} // try again next time
                        }
                    }
                }
                let mut st = self.intl.state.lock();
                let x = st.entry(s.id).or_default();
                let keep: HashSet<&String> = urls.iter().collect();
                x.docs.retain(|u, _| keep.contains(u));
                for (u, d) in fetched {
                    x.docs.insert(u, d);
                }
                for u in &urls {
                    if let Some(Some(d)) = x.docs.get(u) {
                        docs.push(d.clone());
                    }
                }
                drop(st);
                if entries.is_empty() && !body.contains("<rss") && !body.contains("<feed") && !body.contains("<alert") {
                    anyhow::bail!("not a CAP / RSS / Atom feed");
                }
                Ok(features_for(s, "", &docs, now))
            }
        }
    }
}

#[cfg(test)]
#[path = "alerts_intl_tests.rs"]
mod tests;
