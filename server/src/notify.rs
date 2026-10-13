//! Notification channels used by server-side rules (and anything else that wants to reach the
//! owner's phone): ntfy, Pushover, e-mail (SMTP, pure Rust: lettre + rustls), Discord, Telegram
//! and a generic JSON webhook.
//!
//! Stored in `data/notify.json` (file mode 600). Secret fields are encrypted at rest with
//! AES-256-GCM under a random key in `data/notify.key` (mode 600) and never returned by GET.
//!
//! * `GET  /api/notify/channels` → `{channels:[…secrets null…, has:{field:true}], quiet, kinds}`
//! * `PUT  /api/notify/channels {channels, quiet?}` — a secret that is missing / null keeps
//!   the stored value (matched by channel id); `""` clears it
//! * `POST /api/notify/test {channel_id}` → `{ok, status?, error?, ms}`

use crate::api::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const KINDS: &[&str] = &["ntfy", "pushover", "email", "discord", "telegram", "webhook"];
/// Fields holding secrets (encrypted at rest, redacted in GET).
pub const SECRETS: &[&str] = &["token", "app_token", "user_key", "password", "webhook_url", "bot_token", "secret"];
const MAX_CHANNELS: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Quiet {
    pub on: bool,
    /// "HH:MM" server local time
    pub from: String,
    pub to: String,
}

/// One channel: `{id, name, kind, enabled, …kind fields}`.
///
/// * ntfy: `server` (default https://ntfy.sh), `topic`, `token`?, `priority` 1-5 (default 4), `allow_lan`?
/// * pushover: `user_key`, `app_token`, `priority` -2..2 (default 0), `sound`?
/// * email: `host`, `port` (465 tls / 587 starttls / 25 none), `security` "tls"|"starttls"|"none",
///   `username`?, `password`?, `from`, `to`: [addresses]
/// * discord: `webhook_url`
/// * telegram: `bot_token`, `chat_id`
/// * webhook: `url`, `secret`? (sent as `X-TBW-Secret`), `allow_lan`?
pub type Channel = Map<String, Value>;

#[derive(Clone, Debug, Default)]
pub struct Store {
    pub channels: Vec<Channel>,
    pub quiet: Quiet,
    pub updated: i64,
}

/// A notification to send.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Msg {
    pub title: String,
    pub body: String,
    /// "low" | "normal" | "high" | "urgent"
    pub level: String,
    /// quiet hours: deliver without sound where the service supports it
    pub silent: bool,
    pub url: Option<String>,
    pub rule: String,
    pub vars: Map<String, Value>,
    pub test: bool,
}

pub struct Notify {
    path: PathBuf,
    key: [u8; 32],
    pub store: RwLock<Store>,
    pub http: reqwest::Client,
}

fn s<'a>(c: &'a Channel, k: &str) -> &'a str {
    c.get(k).and_then(|v| v.as_str()).unwrap_or("").trim()
}

#[cfg(unix)]
fn restrict(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict(_p: &Path) {}

fn load_key(data: &Path) -> [u8; 32] {
    let kp = data.join("notify.key");
    if let Ok(b) = std::fs::read(&kp) {
        if let Ok(k) = <[u8; 32]>::try_from(b.as_slice()) {
            restrict(&kp);
            return k;
        }
    }
    let mut k = [0u8; 32];
    aws_lc_rs::rand::fill(&mut k).expect("random key");
    let _ = std::fs::create_dir_all(data);
    if std::fs::write(&kp, k).is_ok() {
        restrict(&kp);
    }
    k
}

pub fn encrypt(key: &[u8; 32], plain: &str) -> String {
    use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    let k = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("key"));
    let mut n = [0u8; 12];
    aws_lc_rs::rand::fill(&mut n).expect("nonce");
    let mut buf = plain.as_bytes().to_vec();
    k.seal_in_place_append_tag(Nonce::assume_unique_for_key(n), Aad::empty(), &mut buf).expect("seal");
    let mut out = n.to_vec();
    out.extend(buf);
    format!("enc:v1:{}", base64::engine::general_purpose::STANDARD.encode(out))
}

pub fn decrypt(key: &[u8; 32], s: &str) -> Option<String> {
    use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    let Some(b64) = s.strip_prefix("enc:v1:") else { return Some(s.to_string()) };
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() < 12 + 16 {
        return None;
    }
    let k = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).ok()?);
    let n = Nonce::try_assume_unique_for_key(&raw[..12]).ok()?;
    let mut buf = raw[12..].to_vec();
    let p = k.open_in_place(n, Aad::empty(), &mut buf).ok()?;
    String::from_utf8(p.to_vec()).ok()
}

impl Notify {
    pub fn new(data: &Path, http: reqwest::Client) -> Arc<Notify> {
        let path = data.join("notify.json");
        let key = load_key(data);
        let mut store = Store::default();
        if let Ok(b) = std::fs::read(&path) {
            restrict(&path);
            if let Ok(v) = serde_json::from_slice::<Value>(&b) {
                store.quiet = serde_json::from_value(v["quiet"].clone()).unwrap_or_default();
                store.updated = v["updated"].as_i64().unwrap_or(0);
                for c in v["channels"].as_array().cloned().unwrap_or_default() {
                    let Value::Object(mut c) = c else { continue };
                    for f in SECRETS {
                        if let Some(Value::String(x)) = c.get(*f) {
                            match decrypt(&key, x) {
                                Some(p) => c.insert(f.to_string(), Value::String(p)),
                                None => {
                                    tracing::warn!("notify: can't decrypt {f} of channel {} (key changed?)", s(&c, "id"));
                                    c.insert(f.to_string(), Value::String(String::new()))
                                }
                            };
                        }
                    }
                    store.channels.push(c);
                }
            }
        }
        Arc::new(Notify { path, key, store: RwLock::new(store), http })
    }

    fn save(&self) -> anyhow::Result<()> {
        let st = self.store.read().clone();
        let chans: Vec<Value> = st
            .channels
            .iter()
            .map(|c| {
                let mut c = c.clone();
                for f in SECRETS {
                    if let Some(Value::String(x)) = c.get(*f) {
                        if !x.is_empty() {
                            let e = encrypt(&self.key, x);
                            c.insert(f.to_string(), Value::String(e));
                        }
                    }
                }
                Value::Object(c)
            })
            .collect();
        let b = serde_json::to_vec_pretty(&json!({"channels": chans, "quiet": st.quiet, "updated": st.updated}))?;
        crate::platform::write_atomic(&self.path, &b)?;
        restrict(&self.path);
        Ok(())
    }

    /// Channels for GET: secrets replaced by null, `has` lists which are set.
    pub fn public(&self) -> Value {
        let st = self.store.read();
        let chans: Vec<Value> = st.channels.iter().map(redact).collect();
        json!({"channels": chans, "quiet": st.quiet, "updated": st.updated, "kinds": KINDS})
    }

    /// Replace the channel list (validated); secrets left out keep their stored values.
    pub fn put(&self, body: &Value) -> Result<(), String> {
        let list = body.get("channels").and_then(|c| c.as_array()).ok_or("channels: array required")?;
        if list.len() > MAX_CHANNELS {
            return Err(format!("at most {MAX_CHANNELS} channels"));
        }
        let old = self.store.read().clone();
        let mut out = vec![];
        let mut ids = std::collections::HashSet::new();
        for (i, c) in list.iter().enumerate() {
            let Value::Object(c) = c else { return Err(format!("channel {i}: object expected")) };
            let mut c = c.clone();
            c.remove("has");
            let id = s(&c, "id").to_string();
            let id = if id.is_empty() { format!("ch{}", rand::random::<u32>()) } else { id };
            if id.len() > 64 || !ids.insert(id.clone()) {
                return Err(format!("channel {i}: duplicate or too long id"));
            }
            c.insert("id".into(), json!(id));
            let prev = old.channels.iter().find(|x| s(x, "id") == id);
            for f in SECRETS {
                match c.get(*f) {
                    None | Some(Value::Null) => {
                        if let Some(v) = prev.and_then(|p| p.get(*f)) {
                            c.insert(f.to_string(), v.clone());
                        } else {
                            c.remove(*f);
                        }
                    }
                    Some(Value::String(_)) => {}
                    Some(_) => return Err(format!("channel {id}: {f} must be a string")),
                }
            }
            if !c.contains_key("enabled") {
                c.insert("enabled".into(), json!(true));
            }
            validate(&c).map_err(|e| format!("channel {id}: {e}"))?;
            out.push(c);
        }
        let quiet = match body.get("quiet") {
            Some(q) if !q.is_null() => serde_json::from_value::<Quiet>(q.clone()).map_err(|e| format!("quiet: {e}"))?,
            _ => old.quiet.clone(),
        };
        if quiet.on && (parse_hm(&quiet.from).is_none() || parse_hm(&quiet.to).is_none()) {
            return Err("quiet: from/to must be HH:MM".into());
        }
        {
            let mut st = self.store.write();
            st.channels = out;
            st.quiet = quiet;
            st.updated = crate::share::now_ms();
        }
        self.save().map_err(|e| e.to_string())
    }

    pub fn channel(&self, id: &str) -> Option<Channel> {
        self.store.read().channels.iter().find(|c| s(c, "id") == id).cloned()
    }

    /// Quiet hours right now (server local time)?
    pub fn quiet_now(&self) -> bool {
        let q = self.store.read().quiet.clone();
        let now = chrono::Local::now();
        use chrono::Timelike;
        in_quiet(&q, now.hour() * 60 + now.minute())
    }

    /// Send to the given channel ids ("*" = every enabled channel). Returns per-channel results.
    pub async fn send_to(&self, ids: &[String], msg: &Msg) -> Vec<Value> {
        let chans: Vec<Channel> = {
            let st = self.store.read();
            st.channels.iter().filter(|c| c.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) && (ids.iter().any(|i| i == "*") || ids.iter().any(|i| i == s(c, "id")))).cloned().collect()
        };
        let futs = chans.iter().map(|c| async move {
            let t0 = std::time::Instant::now();
            let r = send(&self.http, c, msg).await;
            let ms = t0.elapsed().as_millis() as u64;
            match r {
                Ok(status) => json!({"channel": s(c, "id"), "ok": true, "status": status, "ms": ms}),
                Err(e) => {
                    tracing::warn!("notify {} ({}): {e}", s(c, "id"), s(c, "kind"));
                    json!({"channel": s(c, "id"), "ok": false, "error": e, "ms": ms})
                }
            }
        });
        futures::future::join_all(futs).await
    }
}

fn redact(c: &Channel) -> Value {
    let mut c = c.clone();
    let mut has = Map::new();
    for f in SECRETS {
        if let Some(v) = c.get(*f) {
            has.insert(f.to_string(), json!(v.as_str().map(|x| !x.is_empty()).unwrap_or(false)));
            c.insert(f.to_string(), Value::Null);
        }
    }
    c.insert("has".into(), Value::Object(has));
    Value::Object(c)
}

fn parse_hm(t: &str) -> Option<u32> {
    let (h, m) = t.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

pub fn in_quiet(q: &Quiet, minute: u32) -> bool {
    if !q.on {
        return false;
    }
    let (Some(a), Some(b)) = (parse_hm(&q.from), parse_hm(&q.to)) else { return false };
    if a <= b { minute >= a && minute < b } else { minute >= a || minute < b }
}

fn http_url(u: &str) -> bool {
    reqwest::Url::parse(u).map(|x| x.scheme() == "https" || x.scheme() == "http").unwrap_or(false)
}

pub fn validate(c: &Channel) -> Result<(), String> {
    let kind = s(c, "kind");
    if !KINDS.contains(&kind) {
        return Err(format!("kind must be one of {}", KINDS.join(", ")));
    }
    if s(c, "name").len() > 100 {
        return Err("name too long".into());
    }
    let need = |k: &str| if s(c, k).is_empty() { Err(format!("{k} is required")) } else { Ok(()) };
    match kind {
        "ntfy" => {
            need("topic")?;
            let srv = s(c, "server");
            if !srv.is_empty() && !http_url(srv) {
                return Err("server must be an http(s) URL".into());
            }
            if s(c, "topic").contains('/') {
                return Err("topic can't contain '/'".into());
            }
        }
        "pushover" => {
            need("user_key")?;
            need("app_token")?;
        }
        "email" => {
            need("host")?;
            need("from")?;
            let to = c.get("to").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
            if to == 0 {
                return Err("to: at least one address".into());
            }
            let sec = s(c, "security");
            if !["", "tls", "starttls", "none"].contains(&sec) {
                return Err("security must be tls, starttls or none".into());
            }
            for a in std::iter::once(s(c, "from").to_string()).chain(c["to"].as_array().unwrap().iter().map(|v| v.as_str().unwrap_or("").to_string())) {
                a.parse::<lettre::message::Mailbox>().map_err(|e| format!("bad address {a:?}: {e}"))?;
            }
        }
        "discord" => {
            need("webhook_url")?;
            if !http_url(s(c, "webhook_url")) {
                return Err("webhook_url must be an http(s) URL".into());
            }
        }
        "telegram" => {
            need("bot_token")?;
            need("chat_id")?;
        }
        "webhook" => {
            need("url")?;
            if !http_url(s(c, "url")) {
                return Err("url must be an http(s) URL".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// An HTTP request a channel turns a message into (pure, so it can be unit tested).
#[derive(Debug, Clone, PartialEq)]
pub struct Req {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub json: Option<Value>,
    pub form: Option<Vec<(String, String)>>,
    /// target must pass the SSRF guard (public address)
    pub guard: bool,
}

fn level_num(level: &str) -> i64 {
    match level {
        "low" => 0,
        "high" => 2,
        "urgent" => 3,
        _ => 1,
    }
}

pub fn build_request(c: &Channel, m: &Msg) -> Result<Req, String> {
    let lv = level_num(&m.level);
    let allow_lan = c.get("allow_lan").and_then(|v| v.as_bool()).unwrap_or(false);
    let title = if m.test { format!("[TEST] {}", m.title) } else { m.title.clone() };
    match s(c, "kind") {
        "ntfy" => {
            let srv = match s(c, "server") {
                "" => "https://ntfy.sh",
                x => x,
            }
            .trim_end_matches('/');
            let base = c.get("priority").and_then(|v| v.as_i64()).unwrap_or(4).clamp(1, 5);
            let pri = if m.silent { base.min(2) } else { (base + lv - 1).clamp(1, 5) };
            let mut body = json!({"topic": s(c, "topic"), "title": title, "message": m.body, "priority": pri, "tags": tags(m)});
            if let Some(u) = &m.url {
                body["click"] = json!(u);
            }
            let mut headers = vec![];
            if !s(c, "token").is_empty() {
                headers.push(("Authorization".into(), format!("Bearer {}", s(c, "token"))));
            }
            Ok(Req { url: format!("{srv}/"), headers, json: Some(body), form: None, guard: !allow_lan })
        }
        "pushover" => {
            let base = c.get("priority").and_then(|v| v.as_i64()).unwrap_or(0).clamp(-2, 1);
            let pri = if m.silent { -1 } else { (base + if lv >= 2 { 1 } else { 0 }).min(1) };
            let mut form = vec![("token".into(), s(c, "app_token").to_string()), ("user".into(), s(c, "user_key").to_string()), ("title".into(), title), ("message".into(), m.body.clone()), ("priority".into(), pri.to_string())];
            if !s(c, "sound").is_empty() {
                form.push(("sound".into(), s(c, "sound").to_string()));
            }
            if let Some(u) = &m.url {
                form.push(("url".into(), u.clone()));
            }
            Ok(Req { url: "https://api.pushover.net/1/messages.json".into(), headers: vec![], json: None, form: Some(form), guard: false })
        }
        "discord" => {
            let color = match lv {
                3 => 0xd0021b,
                2 => 0xf5a623,
                0 => 0x7f8c8d,
                _ => 0x2d7ff9,
            };
            let mut embed = json!({"title": title.chars().take(256).collect::<String>(), "description": m.body.chars().take(4000).collect::<String>(), "color": color, "timestamp": chrono::Utc::now().to_rfc3339()});
            if let Some(u) = &m.url {
                embed["url"] = json!(u);
            }
            Ok(Req { url: s(c, "webhook_url").to_string(), headers: vec![], json: Some(json!({"username": "TheBigWeather", "embeds": [embed], "allowed_mentions": {"parse": []}})), form: None, guard: true })
        }
        "telegram" => {
            let text = format!("{title}\n{}", m.body);
            Ok(Req {
                url: format!("https://api.telegram.org/bot{}/sendMessage", s(c, "bot_token")),
                headers: vec![],
                json: Some(json!({"chat_id": c.get("chat_id").cloned().unwrap_or(Value::Null), "text": text.chars().take(4000).collect::<String>(), "disable_notification": m.silent, "disable_web_page_preview": true})),
                form: None,
                guard: false,
            })
        }
        "webhook" => {
            let mut headers = vec![];
            if !s(c, "secret").is_empty() {
                headers.push(("X-TBW-Secret".into(), s(c, "secret").to_string()));
            }
            Ok(Req {
                url: s(c, "url").to_string(),
                headers,
                json: Some(json!({"source": "TheBigWeather", "rule": m.rule, "title": title, "message": m.body, "level": m.level, "silent": m.silent, "url": m.url, "vars": m.vars, "test": m.test, "time": chrono::Utc::now().to_rfc3339()})),
                form: None,
                guard: !allow_lan,
            })
        }
        k => Err(format!("{k} is not an HTTP channel")),
    }
}

fn tags(m: &Msg) -> Vec<&'static str> {
    match m.level.as_str() {
        "urgent" => vec!["rotating_light"],
        "high" => vec!["warning"],
        _ => vec!["cloud_with_lightning"],
    }
}

/// E-mail message for a channel (pure; sent by [`send`]).
pub fn build_email(c: &Channel, m: &Msg) -> Result<lettre::Message, String> {
    use lettre::message::{header::ContentType, Mailbox};
    let from: Mailbox = s(c, "from").parse().map_err(|e| format!("from: {e}"))?;
    let mut b = lettre::Message::builder().from(from).subject(if m.test { format!("[TEST] {}", m.title) } else { m.title.clone() });
    for t in c.get("to").and_then(|t| t.as_array()).cloned().unwrap_or_default() {
        let a: Mailbox = t.as_str().unwrap_or("").parse().map_err(|e| format!("to: {e}"))?;
        b = b.to(a);
    }
    if m.level == "urgent" || m.level == "high" {
        use lettre::message::header::{HeaderName, HeaderValue};
        b = b.raw_header(HeaderValue::new(HeaderName::new_from_ascii_str("Importance"), "high".into()));
        b = b.raw_header(HeaderValue::new(HeaderName::new_from_ascii_str("X-Priority"), "1".into()));
    }
    let mut text = m.body.clone();
    if let Some(u) = &m.url {
        text.push_str(&format!("\n\n{u}"));
    }
    text.push_str("\n\n-- \nTheBigWeather server");
    b.header(ContentType::TEXT_PLAIN).body(text).map_err(|e| e.to_string())
}

/// Deliver one message; Ok(HTTP status or 250 for mail).
pub async fn send(http: &reqwest::Client, c: &Channel, m: &Msg) -> Result<u16, String> {
    if s(c, "kind") == "email" {
        return send_email(c, m).await;
    }
    let r = build_request(c, m)?;
    let client = if r.guard {
        let (u, addr) = crate::rules::vet_url(&r.url, None).await?;
        let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_string();
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .resolve(&host, addr)
            .user_agent(format!("TheBigWeather/{}", crate::api::VERSION))
            .build()
            .map_err(|e| e.to_string())?
    } else {
        http.clone()
    };
    let mut q = client.post(&r.url).timeout(Duration::from_secs(15));
    for (k, v) in &r.headers {
        q = q.header(k, v);
    }
    if let Some(j) = &r.json {
        q = q.json(j);
    }
    if let Some(f) = &r.form {
        q = q.header("Content-Type", "application/x-www-form-urlencoded").body(form_encode(f));
    }
    let resp = q.send().await.map_err(|e| format!("{e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let body: String = resp.text().await.unwrap_or_default().chars().take(300).collect();
        return Err(format!("HTTP {status}: {body}"));
    }
    Ok(status)
}

/// application/x-www-form-urlencoded body.
pub fn form_encode(f: &[(String, String)]) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                b' ' => "+".into(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    f.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

async fn send_email(c: &Channel, m: &Msg) -> Result<u16, String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    let msg = build_email(c, m)?;
    let host = s(c, "host");
    let sec = match s(c, "security") {
        "" => "starttls",
        x => x,
    };
    let port = c.get("port").and_then(|p| p.as_u64()).map(|p| p as u16).unwrap_or(match sec {
        "tls" => 465,
        "none" => 25,
        _ => 587,
    });
    let b = match sec {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host).map_err(|e| e.to_string())?,
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host).map_err(|e| e.to_string())?,
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host),
    };
    let mut b = b.port(port).timeout(Some(Duration::from_secs(20)));
    if !s(c, "username").is_empty() {
        b = b.credentials(Credentials::new(s(c, "username").to_string(), s(c, "password").to_string()));
    }
    let t = b.build();
    t.send(msg).await.map(|r| r.code().into()).map_err(|e| e.to_string())
}

// ---------- HTTP ----------

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

pub async fn get_channels(State(st): St) -> Json<Value> {
    Json(st.notify.public())
}

pub async fn put_channels(State(st): St, Json(body): Json<Value>) -> Response {
    let n = st.notify.clone();
    match tokio::task::spawn_blocking(move || n.put(&body)).await {
        Ok(Ok(())) => Json(st.notify.public()).into_response(),
        Ok(Err(e)) => err(StatusCode::BAD_REQUEST, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn test(State(st): St, Json(body): Json<Value>) -> Response {
    let Some(id) = body.get("channel_id").and_then(|v| v.as_str()) else {
        return err(StatusCode::BAD_REQUEST, "channel_id missing");
    };
    if !st.shares.limit.allow("notify-test", 30, 600) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many tests; wait a few minutes");
    }
    let Some(c) = st.notify.channel(id) else {
        return err(StatusCode::NOT_FOUND, "no such channel");
    };
    let m = Msg {
        title: "TheBigWeather test".into(),
        body: format!("Test notification from {} ({}).", st.cfg.read().server.name, chrono::Local::now().format("%Y-%m-%d %H:%M")),
        level: "normal".into(),
        rule: "Test".into(),
        test: true,
        ..Default::default()
    };
    let t0 = std::time::Instant::now();
    let r = send(&st.notify.http, &c, &m).await;
    let ms = t0.elapsed().as_millis() as u64;
    match r {
        Ok(status) => Json(json!({"ok": true, "status": status, "ms": ms})).into_response(),
        Err(e) => Json(json!({"ok": false, "error": e, "ms": ms})).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(v: Value) -> Channel {
        v.as_object().unwrap().clone()
    }
    fn msg() -> Msg {
        Msg { title: "Tornado Warning near Home".into(), body: "Tornado Warning covers Home".into(), level: "urgent".into(), url: Some("https://example.com/a".into()), rule: "Tor".into(), ..Default::default() }
    }

    #[test]
    fn crypto_roundtrip() {
        let k = [7u8; 32];
        let e = encrypt(&k, "hunter2");
        assert!(e.starts_with("enc:v1:"));
        assert_ne!(encrypt(&k, "hunter2"), e, "fresh nonce");
        assert_eq!(decrypt(&k, &e).as_deref(), Some("hunter2"));
        assert_eq!(decrypt(&[8u8; 32], &e), None);
        assert_eq!(decrypt(&k, "plain").as_deref(), Some("plain"));
    }

    #[test]
    fn payloads() {
        let n = build_request(&ch(json!({"kind": "ntfy", "topic": "wx", "token": "tk", "priority": 4})), &msg()).unwrap();
        assert_eq!(n.url, "https://ntfy.sh/");
        assert_eq!(n.json.as_ref().unwrap()["priority"], 5);
        assert_eq!(n.json.as_ref().unwrap()["topic"], "wx");
        assert_eq!(n.json.as_ref().unwrap()["click"], "https://example.com/a");
        assert_eq!(n.headers, vec![("Authorization".to_string(), "Bearer tk".to_string())]);
        assert!(n.guard);
        let mut quiet = msg();
        quiet.silent = true;
        assert_eq!(build_request(&ch(json!({"kind": "ntfy", "topic": "wx", "server": "https://n.example.org/"})), &quiet).unwrap().json.unwrap()["priority"], 2);

        let p = build_request(&ch(json!({"kind": "pushover", "user_key": "u", "app_token": "a"})), &msg()).unwrap();
        let f = p.form.unwrap();
        assert!(f.contains(&("priority".into(), "1".into())) && f.contains(&("user".into(), "u".into())) && f.contains(&("token".into(), "a".into())));
        assert_eq!(form_encode(&[("a b".into(), "x&y=ü".into())]), "a+b=x%26y%3D%C3%BC");
        let p = build_request(&ch(json!({"kind": "pushover", "user_key": "u", "app_token": "a"})), &quiet).unwrap();
        assert!(p.form.unwrap().contains(&("priority".into(), "-1".into())));

        let d = build_request(&ch(json!({"kind": "discord", "webhook_url": "https://discord.com/api/webhooks/1/x"})), &msg()).unwrap();
        assert_eq!(d.json.as_ref().unwrap()["embeds"][0]["color"], 0xd0021b);
        assert_eq!(d.json.as_ref().unwrap()["allowed_mentions"]["parse"], json!([]));

        let t = build_request(&ch(json!({"kind": "telegram", "bot_token": "123:abc", "chat_id": "-100"})), &quiet).unwrap();
        assert_eq!(t.url, "https://api.telegram.org/bot123:abc/sendMessage");
        assert_eq!(t.json.as_ref().unwrap()["disable_notification"], true);
        assert!(t.json.as_ref().unwrap()["text"].as_str().unwrap().starts_with("Tornado Warning near Home\n"));

        let mut tm = msg();
        tm.test = true;
        let w = build_request(&ch(json!({"kind": "webhook", "url": "https://hooks.example.com/x", "secret": "s3"})), &tm).unwrap();
        assert_eq!(w.json.as_ref().unwrap()["title"], "[TEST] Tornado Warning near Home");
        assert_eq!(w.headers, vec![("X-TBW-Secret".to_string(), "s3".to_string())]);
        assert!(w.guard);
    }

    #[test]
    fn email_message() {
        let c = ch(json!({"kind": "email", "host": "smtp.example.com", "from": "TBW <wx@example.com>", "to": ["a@example.com", "b@example.com"]}));
        validate(&c).unwrap();
        let m = build_email(&c, &msg()).unwrap();
        let raw = String::from_utf8(m.formatted()).unwrap();
        assert!(raw.contains("Subject: Tornado Warning near Home"));
        assert!(raw.contains("To: a@example.com, b@example.com"));
        assert!(raw.contains("Importance: High") || raw.contains("Importance: high"));
        assert!(validate(&ch(json!({"kind": "email", "host": "h", "from": "nope", "to": ["a@example.com"]}))).is_err());
    }

    #[test]
    fn store_keeps_secrets_and_encrypts() {
        let d = std::env::temp_dir().join(format!("tbw-notify-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let n = Notify::new(&d, reqwest::Client::new());
        n.put(&json!({"channels": [{"id": "m", "kind": "email", "host": "smtp.example.com", "from": "wx@example.com", "to": ["me@example.com"], "username": "u", "password": "pw1"}], "quiet": {"on": true, "from": "22:00", "to": "07:00"}})).unwrap();
        let raw = std::fs::read_to_string(d.join("notify.json")).unwrap();
        assert!(!raw.contains("pw1") && raw.contains("enc:v1:"));
        let p = n.public();
        assert_eq!(p["channels"][0]["password"], Value::Null);
        assert_eq!(p["channels"][0]["has"]["password"], true);
        // a PUT without the secret keeps it
        let mut c = p["channels"][0].clone();
        c["host"] = json!("smtp2.example.com");
        n.put(&json!({"channels": [c]})).unwrap();
        let n2 = Notify::new(&d, reqwest::Client::new());
        let c = n2.channel("m").unwrap();
        assert_eq!(s(&c, "password"), "pw1");
        assert_eq!(s(&c, "host"), "smtp2.example.com");
        assert!(n2.store.read().quiet.on);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join("notify.json")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(d.join("notify.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(n.put(&json!({"channels": [{"kind": "carrier-pigeon"}]})).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn quiet_hours() {
        let q = Quiet { on: true, from: "22:00".into(), to: "07:00".into() };
        assert!(in_quiet(&q, 23 * 60));
        assert!(in_quiet(&q, 3 * 60));
        assert!(!in_quiet(&q, 12 * 60));
        let q2 = Quiet { on: true, from: "13:00".into(), to: "14:00".into() };
        assert!(in_quiet(&q2, 13 * 60 + 30) && !in_quiet(&q2, 14 * 60));
    }
}
