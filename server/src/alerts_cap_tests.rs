// 0.8.2: CAP / feed parser tests (fixtures modelled on the real feeds).

use super::*;
use chrono::TimeZone;

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 7, 12, 0, 0).unwrap()
}

fn meta() -> SrcMeta<'static> {
    SrcMeta { id: "test", name: "Test Met Service", country: "XX", region: "intl", attribution: "Test Met Service (official CAP feed)", centre: [10.0, 50.0] }
}

const CAP: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>urn:oid:2.49.0.1.124.1234</identifier>
  <sender>cap-pac@canada.ca</sender>
  <sent>2026-11-07T10:00:00-00:00</sent>
  <status>Actual</status>
  <msgType>Update</msgType>
  <scope>Public</scope>
  <references>cap-pac@canada.ca,urn:oid:2.49.0.1.124.1000,2026-11-07T08:00:00-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.1001,2026-11-07T09:00:00-00:00</references>
  <info>
    <language>fr-CA</language>
    <event>vents</event>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <headline>avertissement de vents</headline>
    <expires>2026-11-08T10:00:00-00:00</expires>
    <area><areaDesc>Montréal</areaDesc><polygon>45.4,-73.9 45.7,-73.9 45.7,-73.4 45.4,-73.4 45.4,-73.9</polygon></area>
  </info>
  <info>
    <language>en-CA</language>
    <event>wind</event>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <senderName>Environment Canada</senderName>
    <headline>wind warning in effect</headline>
    <description><![CDATA[Strong winds &amp; gusts up to 90 km/h.]]></description>
    <instruction>Secure loose objects &amp; stay safe.</instruction>
    <effective>2026-11-07T10:00:00-00:00</effective>
    <expires>2026-11-08T10:00:00-00:00</expires>
    <web>https://weather.gc.ca/</web>
    <parameter><valueName>layer:EC-MSC-SMC:1.0:Alert_Coverage</valueName><value>Quebec</value></parameter>
    <area>
      <areaDesc>Montréal</areaDesc>
      <polygon>45.4,-73.9 45.7,-73.9 45.7,-73.4 45.4,-73.4 45.4,-73.9</polygon>
      <geocode><valueName>layer:EC-MSC-SMC:1.0:CLC</valueName><value>071100</value></geocode>
    </area>
    <area>
      <areaDesc>Laval</areaDesc>
      <circle>45.6,-73.75 10</circle>
    </area>
  </info>
</alert>"#;

#[test]
fn xml_tree_handles_entities_cdata_namespaces() {
    let n = parse_xml(r#"<a:root xmlns:a="x"><a:b k="1 &amp; 2">x &lt; y &#65;</a:b><c><![CDATA[<raw>]]></c><e/></a:root>"#).unwrap();
    assert_eq!(n.name, "root");
    let b = n.child("b").unwrap();
    assert_eq!(b.text, "x < y A");
    assert_eq!(b.attr("k"), Some("1 & 2"));
    assert_eq!(n.t("c"), "<raw>");
    assert!(n.child("e").is_some());
    // truncated documents still give what was read
    let t = parse_xml("<feed><entry><title>one</title></entry><entry><title>tw").unwrap();
    assert_eq!(t.children("entry").count(), 2);
}

#[test]
fn cap_parses_infos_areas_references() {
    let a = parse_cap_str(CAP).unwrap();
    assert_eq!(a.identifier, "urn:oid:2.49.0.1.124.1234");
    assert_eq!(a.msg_type, "Update");
    assert_eq!(a.references, vec!["urn:oid:2.49.0.1.124.1000", "urn:oid:2.49.0.1.124.1001"]);
    assert_eq!(a.infos.len(), 2);
    let i = pick_info(&a).unwrap();
    assert_eq!(i.lang, "en-CA");
    assert_eq!(i.description, "Strong winds &amp; gusts up to 90 km/h."); // CDATA is literal
    assert_eq!(i.instruction, "Secure loose objects & stay safe.");
    assert_eq!(i.areas.len(), 2);
    assert_eq!(i.areas[0].polygons[0][0], [-73.9, 45.4]); // lat,lon → [lon, lat]
    assert_eq!(i.areas[0].geocodes[0].1, "071100");
    assert_eq!(i.areas[1].circles[0], ([-73.75, 45.6], 10.0));
    assert_eq!(i.param("layer:EC-MSC-SMC:1.0:Alert_Coverage"), Some("Quebec"));
}

#[test]
fn cap_feature_shape() {
    let a = parse_cap_str(CAP).unwrap();
    let f = cap_feature(&meta(), &a, now()).unwrap();
    let p = &f["properties"];
    assert_eq!(p["id"], "test:urn:oid:2.49.0.1.124.1234");
    assert_eq!(p["event"], "Wind");
    assert_eq!(p["region"], "intl");
    assert_eq!(p["country"], "XX");
    assert_eq!(p["level"], "yellow"); // Moderate
    assert_eq!(p["areaDesc"], "Montréal; Laval");
    assert_eq!(p["senderName"], "Environment Canada");
    assert_eq!(p["messageType"], "Update");
    assert!(p["geom_note"].is_null());
    assert_eq!(f["geometry"]["type"], "MultiPolygon");
    assert_eq!(f["geometry"]["coordinates"].as_array().unwrap().len(), 2); // polygon + circle
}

#[test]
fn cap_feature_skips_tests_cancels_expired() {
    let mut a = parse_cap_str(CAP).unwrap();
    a.status = "Test".into();
    assert!(cap_feature(&meta(), &a, now()).is_none());
    a.status = "Actual".into();
    a.msg_type = "Cancel".into();
    assert!(cap_feature(&meta(), &a, now()).is_none());
    a.msg_type = "Alert".into();
    let later = Utc.with_ymd_and_hms(2026, 11, 9, 0, 0, 0).unwrap();
    assert!(cap_feature(&meta(), &a, later).is_none());
}

#[test]
fn polygons_circles_and_bad_input() {
    assert!(parse_polygon("1,2 3,4").is_none()); // too few points
    assert!(parse_polygon("91,0 1,1 2,2").is_none()); // latitude out of range
    let r = parse_polygon("0,0 0,1 1,1").unwrap();
    assert_eq!(r.first(), r.last()); // closed
    let c = circle_ring([10.0, 50.0], 0.0);
    assert_eq!(c.len(), 33);
    assert_eq!(c[0], c[32]);
    assert!((c[0][0] - 10.0).abs() > 0.02); // zero radius still gets a visible size
}

#[test]
fn geocodes_through_tables_or_centre_point() {
    assert!(geocode_polys("EMMA_ID", "AT101").is_some());
    assert!(geocode_polys("emma_id", "DE261").is_some());
    assert!(geocode_polys("EMMA_ID", "ZZ999").is_none());
    assert!(geocode_polys("FIPS", "AT101").is_none());
    let (g, missing) = areas_geometry(&[CapArea { desc: "Eisenstadt".into(), geocodes: vec![("EMMA_ID".into(), "AT101".into())], ..Default::default() }]);
    assert_eq!(g["type"], "MultiPolygon");
    assert!(!missing);
    // unmapped geocode: point at the source's centre with a note
    let a = CapAlert { identifier: "x1".into(), status: "Actual".into(), msg_type: "Alert".into(), infos: vec![CapInfo { event: "heavy rain".into(), severity: "Severe".into(), areas: vec![CapArea { desc: "Somewhere".into(), geocodes: vec![("district".into(), "42".into())], ..Default::default() }], ..Default::default() }], ..Default::default() };
    let f = cap_feature(&meta(), &a, now()).unwrap();
    assert_eq!(f["geometry"]["type"], "Point");
    assert_eq!(f["geometry"]["coordinates"], json!([10.0, 50.0]));
    assert!(f["properties"]["geom_note"].as_str().unwrap().contains("not mapped"));
    assert_eq!(f["properties"]["event"], "Heavy rain");
    assert_eq!(f["properties"]["level"], "orange");
}

#[test]
fn levels() {
    assert_eq!(level_of("Minor", "2; yellow; Moderate"), "yellow");
    assert_eq!(level_of("", "Red Wind Warning"), "red");
    assert_eq!(level_of("Extreme", ""), "red");
    assert_eq!(level_of("Severe", ""), "orange");
    assert_eq!(level_of("Minor", ""), "minor");
    assert_eq!(level_of("", ""), "unknown");
    assert_eq!(title_case("blizzard warning"), "Blizzard Warning");
    assert_eq!(title_case("special weather statement"), "Special Weather Statement");
}

pub const METEOALARM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <id>tag:meteoalarm.org,2021-02-19:DE</id>
  <title>MeteoAlarm - Alerting Europe for Extreme Weather</title>
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>DE261</value></cap:geocode>
    <link title="Kreis Elbe-Elster" href="https://meteoalarm.org?geocode=EMMA_ID:DE261" hreflang="en"/>
    <cap:areaDesc>Kreis Elbe-Elster</cap:areaDesc>
    <cap:event>fog</cap:event>
    <cap:sent>2026-11-07T10:21:00+00:00</cap:sent>
    <cap:expires>2026-11-08T08:00:00+00:00</cap:expires>
    <cap:onset>2026-11-07T10:21:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Minor</cap:severity>
    <cap:urgency>Immediate</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.276.0.DWD.PVW.1</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-germany/abc"/>
    <link title="Germany" rel="related" href="https://meteoalarm.org?region=DE" hreflang="en"/>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-germany/abc</id>
    <title>Yellow Fog Warning issued for Germany - Kreis Elbe-Elster</title>
  </entry>
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>DE262</value></cap:geocode>
    <cap:areaDesc>Kreis Dahme-Spreewald</cap:areaDesc>
    <cap:event>fog</cap:event>
    <cap:sent>2026-11-07T10:21:00+00:00</cap:sent>
    <cap:expires>2026-11-08T08:00:00+00:00</cap:expires>
    <cap:severity>Minor</cap:severity>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.276.0.DWD.PVW.1</cap:identifier>
    <title>Yellow Fog Warning issued for Germany - Kreis Dahme-Spreewald</title>
  </entry>
  <entry>
    <cap:polygon>70.3497,30.0332 70.4225,31.1445 70.7112,30.1582 70.3497,30.0332</cap:polygon>
    <cap:areaDesc>Slettnes lighthouse - Vardoe</cap:areaDesc>
    <cap:event>Gale</cap:event>
    <cap:sent>2026-11-07T08:18:56+00:00</cap:sent>
    <cap:expires>2026-11-08T12:00:00+00:00</cap:expires>
    <cap:severity>Moderate</cap:severity>
    <cap:message_type>Update</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.1.578.0.20261107080517.037</cap:identifier>
    <title>Orange Wind Warning issued for Norway - Slettnes lighthouse - Vardoe</title>
  </entry>
  <entry>
    <cap:areaDesc>Old</cap:areaDesc>
    <cap:event>rain</cap:event>
    <cap:expires>2026-11-06T12:00:00+00:00</cap:expires>
    <cap:status>Actual</cap:status>
    <cap:identifier>old-1</cap:identifier>
    <title>Yellow Rain Warning issued for Germany - Old</title>
  </entry>
</feed>"#;

#[test]
fn meteoalarm_atom_entries() {
    let fs = meteoalarm_features(&meta(), METEOALARM, now());
    assert_eq!(fs.len(), 2, "same identifier merged, expired dropped");
    let fog = &fs[0];
    assert_eq!(fog["properties"]["event"], "Yellow Fog Warning");
    assert_eq!(fog["properties"]["level"], "yellow");
    assert_eq!(fog["properties"]["areaDesc"], "Kreis Elbe-Elster; Kreis Dahme-Spreewald");
    assert_eq!(fog["properties"]["cap_url"], "https://feeds.meteoalarm.org/api/v1/warnings/feeds-germany/abc");
    assert_eq!(fog["properties"]["link"], "https://meteoalarm.org?geocode=EMMA_ID:DE261");
    assert_eq!(fog["geometry"]["type"], "MultiPolygon");
    assert!(fog["properties"]["flags"]["warning"].as_bool().unwrap());
    let gale = &fs[1];
    assert_eq!(gale["properties"]["event"], "Orange Wind Warning");
    assert_eq!(gale["properties"]["level"], "orange");
    assert_eq!(gale["geometry"]["coordinates"][0][0][0], json!([30.0332, 70.3497]));
}

#[test]
fn geomet_groups_regions_into_alerts() {
    let fc = json!({"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": "a1", "geometry": {"type": "Polygon", "coordinates": [[[-79.0, 43.0], [-79.0, 44.0], [-78.0, 44.0], [-79.0, 43.0]]]},
         "properties": {"id": "a1", "alert_name_en": "snowfall warning", "alert_short_name_en": "snowfall", "alert_type": "warning", "risk_colour_en": "orange", "province": "ON", "feature_name_en": "Toronto", "publication_datetime": "2026-11-07T09:00:00Z", "expiration_datetime": "2026-11-08T09:00:00Z", "alert_text_en": "Heavy snow."}},
        {"type": "Feature", "id": "a2", "geometry": {"type": "MultiPolygon", "coordinates": [[[[-80.0, 43.0], [-80.0, 44.0], [-79.5, 44.0], [-80.0, 43.0]]]]},
         "properties": {"id": "a2", "alert_name_en": "snowfall warning", "alert_short_name_en": "snowfall", "alert_type": "warning", "risk_colour_en": "orange", "province": "ON", "feature_name_en": "Hamilton", "publication_datetime": "2026-11-07T09:00:00Z", "expiration_datetime": "2026-11-08T09:00:00Z"}},
        {"type": "Feature", "id": "b1", "geometry": {"type": "Polygon", "coordinates": [[[-123.0, 49.0], [-123.0, 50.0], [-122.0, 50.0], [-123.0, 49.0]]]},
         "properties": {"id": "b1", "alert_name_en": "special weather statement", "alert_type": "statement", "province": "BC", "feature_name_en": "Metro Vancouver", "publication_datetime": "2026-11-07T09:00:00Z", "expiration_datetime": "2026-11-08T09:00:00Z"}},
        {"type": "Feature", "id": "c1", "geometry": null,
         "properties": {"id": "c1", "alert_name_en": "wind warning", "alert_type": "ended", "province": "NS", "publication_datetime": "2026-11-07T09:00:00Z", "expiration_datetime": "2026-11-08T09:00:00Z"}}
    ]});
    let m = SrcMeta { region: "ca", country: "CA", ..meta() };
    let fs = geomet_features(&m, &fc, now());
    assert_eq!(fs.len(), 2);
    let snow = fs.iter().find(|f| f["properties"]["event"] == "Snowfall Warning").unwrap();
    assert_eq!(snow["properties"]["areaDesc"], "Toronto; Hamilton");
    assert_eq!(snow["properties"]["level"], "orange");
    assert_eq!(snow["properties"]["severity"], "Severe");
    assert_eq!(snow["properties"]["region"], "ca");
    assert_eq!(snow["properties"]["description"], "Heavy snow.");
    assert_eq!(snow["geometry"]["coordinates"].as_array().unwrap().len(), 2);
    let sws = fs.iter().find(|f| f["properties"]["event"] == "Special Weather Statement").unwrap();
    assert_eq!(sws["properties"]["province"], "BC");
}

#[test]
fn feeds_rss_atom_embedded() {
    let rss = r#"<rss version="2.0"><channel><title>CAP</title>
      <item><title>Heavy rain</title><link>https://example.org/cap/alert-1.xml</link><guid>https://example.org/web/1</guid></item>
      <item><title>Wind</title><link>/api/cap/2.xml</link></item>
      <item><title>Page only</title><link>https://example.org/page</link></item>
    </channel></rss>"#;
    let es = parse_feed(rss, "https://example.org/api/cap/rss.xml", None);
    assert_eq!(es.len(), 3);
    assert_eq!(es[0].cap_urls, vec!["https://example.org/cap/alert-1.xml"]);
    assert_eq!(es[1].cap_urls, vec!["https://example.org/api/cap/2.xml"]); // root-relative resolved
    assert_eq!(es[2].cap_urls, vec!["https://example.org/page"]); // fallback link
    // a `must` filter drops web pages
    let only = parse_feed(rss, "https://example.org/x", Some("/cap/"));
    assert_eq!(only.len(), 2);

    let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title>
      <link rel="alternate" type="text/html" href="https://x.org/w"/>
      <link rel="related" type="application/cap+xml" href="https://x.org/c/1"/></entry></feed>"#;
    let es = parse_feed(atom, "https://x.org/feed", None);
    assert_eq!(es[0].cap_urls, vec!["https://x.org/c/1"]);

    let emb = format!("<feed><entry><title>E</title><content type=\"text/xml\">{}</content></entry></feed>", CAP.replace("<?xml version=\"1.0\" encoding=\"UTF-8\"?>", ""));
    let es = parse_feed(&emb, "https://x.org/feed", None);
    assert_eq!(es[0].embedded.as_ref().unwrap().identifier, "urn:oid:2.49.0.1.124.1234");

    // the "feed" is a CAP alert itself
    let es = parse_feed(CAP, "https://x.org/cap.xml", None);
    assert_eq!(es.len(), 1);
    assert!(es[0].embedded.is_some());
}

#[test]
fn times() {
    assert!(parse_time("2026-11-07T10:00:00-00:00").is_some());
    assert!(parse_time("Sat, 07 Nov 2026 10:00:00 GMT").is_some());
    assert!(parse_time("2026-11-07T10:00:00").is_some());
    assert!(parse_time("").is_none());
    assert!(!expired("", now()));
}
