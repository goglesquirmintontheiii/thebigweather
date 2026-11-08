// 0.8.2: source registry, demand and per-feed parsing tests.

use super::*;
use chrono::TimeZone;

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc.with_ymd_and_hms(2026, 11, 7, 12, 0, 0).unwrap()
}

#[test]
fn registry_is_sane() {
    let mut ids = HashSet::new();
    for s in SOURCES {
        assert!(ids.insert(s.id), "duplicate id {}", s.id);
        assert_eq!(s.country.len(), 2, "{}", s.id);
        assert!(s.bbox[0] < s.bbox[2] && s.bbox[1] < s.bbox[3], "bbox {}", s.id);
        assert!(s.url.starts_with("https://"), "{}", s.id);
        assert!(!s.attribution().is_empty());
    }
    assert_eq!(source("eccc").unwrap().region(), "ca");
    assert_eq!(source("ma-de").unwrap().region(), "intl");
    assert!(SOURCES.iter().filter(|s| s.kind == Kind::MeteoAlarm).count() >= 38);
    assert!(SOURCES.len() >= 100);
}

#[test]
fn want_resolves_groups_and_respects_switches() {
    let i = Intl::new(true, true);
    assert_eq!(i.want(&["ca".into()]), 1);
    assert_eq!(i.want(&["ma-fr".into(), "nope".into()]), 1);
    assert!(i.want(&["intl".into()]) > 100);
    let l = i.list();
    let fr = l["sources"].as_array().unwrap().iter().find(|s| s["id"] == "ma-fr").unwrap();
    assert_eq!(fr["active"], true);
    assert_eq!(fr["region"], "intl");
    let off = Intl::new(false, false);
    assert_eq!(off.want(&["ca".into(), "intl".into(), "ma-fr".into()]), 0);
    off.set_regions(true, false);
    assert_eq!(off.want(&["ca".into(), "ma-fr".into()]), 1);
}

#[test]
fn superseded_messages_are_dropped() {
    let mk = |id: &str, refs: &[&str]| CapAlert {
        identifier: id.into(),
        status: "Actual".into(),
        msg_type: if refs.is_empty() { "Alert".into() } else { "Update".into() },
        references: refs.iter().map(|s| s.to_string()).collect(),
        sent: "2026-11-07T10:00:00Z".into(),
        infos: vec![cap::CapInfo { event: "storm".into(), severity: "Severe".into(), expires: "2026-11-08T00:00:00Z".into(), areas: vec![cap::CapArea { desc: "A".into(), polygons: vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]], ..Default::default() }], ..Default::default() }],
        ..Default::default()
    };
    let s = source("au-bom").unwrap();
    let docs = vec![mk("a", &[]), mk("b", &["a"]), mk("c", &[]), mk("c", &[])];
    let fs = features_for(s, "", &docs, now());
    let ids: Vec<&str> = fs.iter().map(|f| f["properties"]["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["au-bom:b", "au-bom:c"]);
    assert_eq!(fs[0]["properties"]["country"], "AU");
    assert_eq!(fs[0]["properties"]["region"], "intl");
    assert!(fs[0]["properties"]["attribution"].as_str().unwrap().contains("Bureau of Meteorology"));
}

#[test]
fn meteoalarm_source_parses_fixture() {
    let s = source("ma-de").unwrap();
    let fs = features_for(s, crate::alerts_cap::tests::METEOALARM, &[], now());
    assert_eq!(fs.len(), 2);
    assert!(fs.iter().all(|f| f["properties"]["src"] == "ma-de" && f["properties"]["country"] == "DE"));
    assert!(fs[0]["properties"]["attribution"].as_str().unwrap().contains("MeteoAlarm"));
}

#[test]
fn geomet_source_parses_fixture() {
    let s = source("eccc").unwrap();
    let body = r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-79,43],[-79,44],[-78,44],[-79,43]]]},"properties":{"alert_name_en":"freezing rain warning","alert_type":"warning","risk_colour_en":"yellow","province":"ON","feature_name_en":"Ottawa","publication_datetime":"2026-11-07T09:00:00Z","expiration_datetime":"2026-11-08T09:00:00Z"}}]}"#;
    let fs = features_for(s, body, &[], now());
    assert_eq!(fs.len(), 1);
    assert_eq!(fs[0]["properties"]["event"], "Freezing Rain Warning");
    assert_eq!(fs[0]["properties"]["region"], "ca");
    assert!(fs[0]["properties"]["id"].as_str().unwrap().starts_with("eccc:"));
    assert!(features_for(s, "not json", &[], now()).is_empty());
}

#[test]
fn apply_source_only_touches_its_own_alerts() {
    let hub = crate::hub::Hub::new();
    let health = Arc::new(crate::health::Health::new(hub.clone()));
    let dir = std::env::temp_dir().join(format!("tbw-alerts-test-{}", std::process::id()));
    let a = Alerts::new(reqwest::Client::new(), String::new(), hub, health, &dir, 60);
    a.current.write().insert("nws1".into(), json!({"properties": {"id": "nws1", "event": "Tornado Warning"}}));
    let f = |id: &str, sent: &str| json!({"type": "Feature", "geometry": null, "properties": {"id": id, "src": "ma-de", "sent": sent}});
    assert_eq!(a.apply_source("ma-de", vec![f("ma-de:1", "a"), f("ma-de:2", "a")]), 2);
    assert_eq!(a.current.read().len(), 3);
    a.apply_source("ma-de", vec![f("ma-de:2", "b")]);
    let cur = a.current.read();
    assert!(cur.contains_key("nws1") && cur.contains_key("ma-de:2") && !cur.contains_key("ma-de:1"));
    assert_eq!(cur["ma-de:2"]["properties"]["sent"], "b");
    drop(cur);
    a.apply_source("ma-de", vec![]);
    assert_eq!(a.current.read().len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}
