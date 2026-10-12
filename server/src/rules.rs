//! Notification rules storage. The app evaluates the rules; the server only keeps the JSON so
//! every device on this server shares one rule set, and offers a webhook test with an SSRF guard.

use crate::api::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

pub const MAX_RULES: usize = 256 * 1024;

pub struct Rules {
    path: PathBuf,
    cur: RwLock<(Value, i64)>,
}

impl Rules {
    pub fn new(data: &std::path::Path) -> Arc<Rules> {
        let path = data.join("rules.json");
        let cur = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|v| (v.get("rules").cloned().unwrap_or(Value::Null), v.get("updated").and_then(|u| u.as_i64()).unwrap_or(0)))
            .unwrap_or((Value::Null, 0));
        Arc::new(Rules { path, cur: RwLock::new(cur) })
    }
    pub fn get(&self) -> (Value, i64) {
        self.cur.read().clone()
    }
    pub fn set(&self, v: Value) -> anyhow::Result<i64> {
        let t = crate::share::now_ms();
        let b = serde_json::to_vec(&json!({"rules": v, "updated": t}))?;
        crate::platform::write_atomic(&self.path, &b)?;
        *self.cur.write() = (v, t);
        Ok(t)
    }
}

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

/// GET /api/rules → {rules, updated}
pub async fn get(State(st): St) -> Json<Value> {
    let (rules, updated) = st.rules.get();
    Json(json!({"rules": rules, "updated": updated}))
}

/// PUT /api/rules: any JSON value up to 256 KB (the app owns its shape).
pub async fn put(State(st): St, body: Bytes) -> Response {
    if body.len() > MAX_RULES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, format!("rules are limited to {} KB", MAX_RULES / 1024));
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("not valid JSON: {e}")),
    };
    // accept either the rules themselves or {"rules": …}
    let v = match v {
        Value::Object(mut m) if m.len() == 1 && m.contains_key("rules") => m.remove("rules").unwrap_or(Value::Null),
        v => v,
    };
    match st.rules.set(v) {
        Ok(t) => {
            st.hub.send(json!({"type": "rules", "updated": t}));
            Json(json!({"ok": true, "updated": t})).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Addresses a webhook may not reach (unless it is this server's own host name).
pub fn blocked_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || v.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
                || (o[0] == 198 && (18..20).contains(&o[1])) // benchmarking
                || o[0] >= 240
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x64 && s[1] == 0xff9b) // NAT64 can reach private v4
        }
    }
}

fn host_only(h: &str) -> String {
    let h = h.trim();
    if let Some(r) = h.strip_prefix('[') {
        return r.split(']').next().unwrap_or("").to_ascii_lowercase();
    }
    h.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|(a, _)| a).unwrap_or(h).to_ascii_lowercase()
}

/// Check a webhook URL and resolve it to one address to connect to (pinned, so DNS can't
/// change between the check and the request).
pub async fn vet_url(url: &str, same_host: Option<&str>) -> Result<(reqwest::Url, SocketAddr), String> {
    let u = reqwest::Url::parse(url.trim()).map_err(|e| format!("bad URL: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("only http and https webhooks are allowed".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("put credentials in the payload or a query token, not the URL".into());
    }
    let host = u.host_str().ok_or("URL has no host")?.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let port = u.port_or_known_default().unwrap_or(80);
    let same = same_host.map(|h| host_only(h) == host).unwrap_or(false);
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((host.as_str(), port)).await.map_err(|e| format!("can't resolve {host}: {e}"))?.collect(),
    };
    if addrs.is_empty() {
        return Err(format!("can't resolve {host}"));
    }
    if !same {
        if let Some(a) = addrs.iter().find(|a| blocked_ip(a.ip())) {
            return Err(format!("{host} resolves to a private or local address ({}); webhooks may only reach public hosts or this server", a.ip()));
        }
    }
    Ok((u, addrs[0]))
}

/// POST /api/rules/webhook-test {url, payload?, method?}
pub async fn webhook_test(State(st): St, headers: HeaderMap, Json(v): Json<Value>) -> Response {
    let who = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("local").chars().rev().take(8).collect::<String>();
    if !st.shares.limit.allow(&format!("webhook:{who}"), 20, 600) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many webhook tests; wait a few minutes");
    }
    let Some(url) = v.get("url").and_then(|u| u.as_str()) else {
        return err(StatusCode::BAD_REQUEST, "url missing");
    };
    let host_hdr = headers.get("host").and_then(|h| h.to_str().ok());
    let (u, addr) = match vet_url(url, host_hdr).await {
        Ok(x) => x,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let payload = v.get("payload").cloned().unwrap_or_else(|| {
        json!({
            "source": "TheBigWeather",
            "test": true,
            "rule": "Webhook test",
            "text": "Test notification from TheBigWeather",
            "time": chrono::Utc::now().to_rfc3339(),
        })
    });
    let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_string();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .resolve(&host, addr)
        .user_agent(format!("TheBigWeather/{}", crate::api::VERSION))
        .build()
    {
        Ok(c) => c,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let started = std::time::Instant::now();
    match client.post(u).json(&payload).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            let body: String = body.chars().take(500).collect();
            Json(json!({"ok": (200..300).contains(&status), "status": status, "body": body, "ms": started.elapsed().as_millis() as u64})).into_response()
        }
        Err(e) => Json(json!({"ok": false, "status": 0, "error": format!("{e}"), "ms": started.elapsed().as_millis() as u64})).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ranges() {
        for ip in ["10.1.2.3", "192.168.1.1", "172.16.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"] {
            assert!(blocked_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "172.32.0.1"] {
            assert!(!blocked_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn vetting() {
        assert!(vet_url("ftp://example.com/x", None).await.is_err());
        assert!(vet_url("http://127.0.0.1:8123/hook", None).await.is_err());
        assert!(vet_url("http://[::1]/hook", None).await.is_err());
        assert!(vet_url("http://user:pw@8.8.8.8/", None).await.is_err());
        assert!(vet_url("http://192.168.1.5/hook", Some("192.168.1.5:8787")).await.is_ok());
        assert!(vet_url("http://192.168.1.5/hook", Some("192.168.1.6:8787")).await.is_err());
        assert!(vet_url("https://8.8.8.8/hook", None).await.is_ok());
    }

    #[test]
    fn store() {
        let d = std::env::temp_dir().join(format!("tbw-rules-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let r = Rules::new(&d);
        assert_eq!(r.get().0, Value::Null);
        r.set(json!([{"id": "a"}])).unwrap();
        assert_eq!(Rules::new(&d).get().0, json!([{"id": "a"}]));
        std::fs::remove_dir_all(&d).ok();
    }
}
