//! Live collaboration rooms for chase teams: shared drawings (GeoJSON per drawing group), pins,
//! notes, member positions and "follow me" view sync over one WebSocket per member.
//!
//! Rooms live in memory, are saved to `data/collab.json` (drawings, pins, notes — not members),
//! and are dropped after 24 h without activity.
//!
//! Client → server messages (`type`): `hello {name,color}`, `pos {lat,lon,heading?,speed?}` or
//! `pos {off:true}`, `view {center,zoom,bearing?,pitch?}`, `draw {group,name?,geojson}`,
//! `draw_del {group}`, `pin {id?,lat,lon,text,color?}`, `pin_del {id}`, `note {text,lat?,lon?}`,
//! `ping`. Server → client: `state` (on join), `member` (join/update), `leave`, `pos`, `view`,
//! `draw`, `draw_del`, `pin`, `pin_del`, `note`, `error`, `pong`.

use crate::api::AppState;
use crate::share::{now_ms, rand_id};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

pub const IDLE_MS: i64 = 24 * 3600 * 1000;
const MAX_ROOMS: usize = 100;
const MAX_MEMBERS: usize = 50;
const MAX_MSG: usize = 256 * 1024;
const MAX_GROUPS: usize = 200;
const MAX_PINS: usize = 500;
const MAX_NOTES: usize = 300;
const MAX_ROOM_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Saved {
    pub code: String,
    pub name: String,
    pub created: i64,
    pub active: i64,
    /// drawing group id -> {group, name, by, color, geojson, t}
    pub drawings: BTreeMap<String, Value>,
    pub pins: Vec<Value>,
    pub notes: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub color: String,
    pub joined: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<Value>,
}

pub struct Room {
    pub data: Mutex<Saved>,
    pub members: Mutex<HashMap<String, Member>>,
    tx: broadcast::Sender<(String, Arc<str>)>,
}

impl Room {
    fn new(s: Saved) -> Arc<Room> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Room { data: Mutex::new(s), members: Mutex::new(HashMap::new()), tx })
    }
    /// Send to everyone in the room except `from` ("" = everyone).
    fn send(&self, from: &str, v: Value) {
        let _ = self.tx.send((from.to_string(), Arc::from(v.to_string())));
    }
    fn touch(&self) {
        self.data.lock().active = now_ms();
    }
    fn size(&self) -> usize {
        let d = self.data.lock();
        serde_json::to_vec(&*d).map(|v| v.len()).unwrap_or(0)
    }
    fn summary(&self) -> Value {
        let d = self.data.lock();
        let m = self.members.lock();
        json!({
            "code": d.code, "name": d.name, "created": d.created, "active": d.active,
            "members": m.values().map(|x| json!({"id": x.id, "name": x.name, "color": x.color})).collect::<Vec<_>>(),
            "drawings": d.drawings.len(), "pins": d.pins.len(), "notes": d.notes.len(),
        })
    }
}

pub struct Collab {
    path: PathBuf,
    rooms: RwLock<HashMap<String, Arc<Room>>>,
    dirty: AtomicBool,
    seq: AtomicU64,
}

/// Room codes: 6 characters, no look-alikes, upper case for reading aloud.
fn new_code() -> String {
    rand_id(6).to_ascii_uppercase()
}

fn norm_code(c: &str) -> String {
    c.trim().chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect::<String>().to_ascii_uppercase()
}

fn clean(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect()
}

fn color(s: Option<&str>) -> String {
    match s {
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()) => c.to_string(),
        _ => "#3fb7ff".into(),
    }
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64()).filter(|x| x.is_finite())
}

impl Collab {
    pub fn new(data: &std::path::Path) -> Arc<Collab> {
        let path = data.join("collab.json");
        let list: Vec<Saved> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let now = now_ms();
        let rooms = list.into_iter().filter(|s| now - s.active < IDLE_MS).map(|s| (s.code.clone(), Room::new(s))).collect();
        Arc::new(Collab { path, rooms: RwLock::new(rooms), dirty: AtomicBool::new(false), seq: AtomicU64::new(1) })
    }

    pub fn create(&self, name: &str) -> Result<Arc<Room>, String> {
        let mut rooms = self.rooms.write();
        if rooms.len() >= MAX_ROOMS {
            return Err("too many rooms on this server".into());
        }
        let mut code = new_code();
        while rooms.contains_key(&code) {
            code = new_code();
        }
        let now = now_ms();
        let name = clean(name, 60);
        let r = Room::new(Saved { code: code.clone(), name: if name.is_empty() { format!("Team {code}") } else { name }, created: now, active: now, ..Default::default() });
        rooms.insert(code, r.clone());
        self.dirty.store(true, Ordering::Relaxed);
        Ok(r)
    }

    pub fn get(&self, code: &str) -> Option<Arc<Room>> {
        self.rooms.read().get(&norm_code(code)).cloned()
    }

    pub fn list(&self) -> Vec<Value> {
        let mut v: Vec<Value> = self.rooms.read().values().map(|r| r.summary()).collect();
        v.sort_by_key(|r| -r["active"].as_i64().unwrap_or(0));
        v
    }

    pub fn delete(&self, code: &str) -> bool {
        let r = self.rooms.write().remove(&norm_code(code));
        if let Some(r) = &r {
            r.send("", json!({"type": "closed"}));
            self.dirty.store(true, Ordering::Relaxed);
        }
        r.is_some()
    }

    pub fn save(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let list: Vec<Saved> = self.rooms.read().values().map(|r| r.data.lock().clone()).collect();
        if let Ok(b) = serde_json::to_vec(&list) {
            if let Err(e) = crate::platform::write_atomic(&self.path, &b) {
                tracing::warn!("saving collab rooms: {e}");
            }
        }
    }

    /// Drop rooms idle for 24 h (rooms with members connected count as active).
    pub fn purge(&self, now: i64) -> usize {
        let mut rooms = self.rooms.write();
        let before = rooms.len();
        rooms.retain(|_, r| !r.members.lock().is_empty() || now - r.data.lock().active < IDLE_MS);
        let n = before - rooms.len();
        if n > 0 {
            self.dirty.store(true, Ordering::Relaxed);
        }
        n
    }

    /// Apply one client message from member `me`; returns an error text for the sender.
    pub fn apply(&self, room: &Room, me: &str, v: &Value) -> Result<(), String> {
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let now = now_ms();
        let my = || room.members.lock().get(me).cloned();
        match t {
            "hello" => {
                let mut m = room.members.lock();
                if let Some(x) = m.get_mut(me) {
                    if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
                        let n = clean(n, 40);
                        if !n.is_empty() {
                            x.name = n;
                        }
                    }
                    if v.get("color").is_some() {
                        x.color = color(v.get("color").and_then(|c| c.as_str()));
                    }
                    let x = x.clone();
                    drop(m);
                    room.send("", json!({"type": "member", "member": x}));
                }
            }
            "pos" => {
                let pos = if v.get("off").and_then(|o| o.as_bool()).unwrap_or(false) {
                    None
                } else {
                    let (lat, lon) = (num(v, "lat").ok_or("lat missing")?, num(v, "lon").ok_or("lon missing")?);
                    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                        return Err("bad position".into());
                    }
                    let mut p = json!({"lat": lat, "lon": lon, "t": now});
                    for k in ["heading", "speed", "acc"] {
                        if let Some(x) = num(v, k) {
                            p[k] = json!(x);
                        }
                    }
                    Some(p)
                };
                if let Some(x) = room.members.lock().get_mut(me) {
                    x.pos = pos.clone();
                }
                room.send(me, json!({"type": "pos", "id": me, "pos": pos}));
            }
            "view" => {
                let c = v.get("center").and_then(|c| c.as_array()).ok_or("center missing")?;
                let (lon, lat) = (c.first().and_then(|x| x.as_f64()).ok_or("bad center")?, c.get(1).and_then(|x| x.as_f64()).ok_or("bad center")?);
                let mut view = json!({"center": [lon, lat], "zoom": num(v, "zoom").unwrap_or(6.0).clamp(0.0, 22.0), "t": now});
                for k in ["bearing", "pitch"] {
                    if let Some(x) = num(v, k) {
                        view[k] = json!(x);
                    }
                }
                if let Some(x) = room.members.lock().get_mut(me) {
                    x.view = Some(view.clone());
                }
                room.send(me, json!({"type": "view", "id": me, "view": view}));
            }
            "draw" => {
                let group = clean(v.get("group").and_then(|g| g.as_str()).ok_or("group missing")?, 40);
                let gj = v.get("geojson").ok_or("geojson missing")?;
                if gj.get("type").and_then(|t| t.as_str()) != Some("FeatureCollection") || !gj.get("features").map(|f| f.is_array()).unwrap_or(false) {
                    return Err("geojson must be a FeatureCollection".into());
                }
                let who = my().ok_or("not a member")?;
                let entry = json!({
                    "group": group, "name": clean(v.get("name").and_then(|n| n.as_str()).unwrap_or(""), 60),
                    "by": who.id, "by_name": who.name, "color": who.color, "geojson": gj, "t": now,
                });
                {
                    let mut d = room.data.lock();
                    if let Some(old) = d.drawings.get(&group) {
                        // a member may only replace their own drawing (others copy it instead)
                        if old["by_name"] != entry["by_name"] && old["by"] != entry["by"] {
                            return Err("that drawing belongs to another member".into());
                        }
                    } else if d.drawings.len() >= MAX_GROUPS {
                        return Err("this room has too many drawings".into());
                    }
                    d.drawings.insert(group.clone(), entry.clone());
                }
                if room.size() > MAX_ROOM_BYTES {
                    room.data.lock().drawings.remove(&group);
                    return Err("room is full (4 MB); delete some drawings".into());
                }
                room.send("", json!({"type": "draw", "drawing": entry}));
            }
            "draw_del" => {
                let group = v.get("group").and_then(|g| g.as_str()).ok_or("group missing")?;
                if room.data.lock().drawings.remove(group).is_some() {
                    room.send("", json!({"type": "draw_del", "group": group}));
                }
            }
            "pin" => {
                let (lat, lon) = (num(v, "lat").ok_or("lat missing")?, num(v, "lon").ok_or("lon missing")?);
                let who = my().ok_or("not a member")?;
                let id = v.get("id").and_then(|i| i.as_str()).map(|s| clean(s, 24)).filter(|s| !s.is_empty()).unwrap_or_else(|| rand_id(8));
                let pin = json!({
                    "id": id, "lat": lat.clamp(-90.0, 90.0), "lon": lon.clamp(-180.0, 180.0),
                    "text": clean(v.get("text").and_then(|t| t.as_str()).unwrap_or(""), 500),
                    "color": color(v.get("color").and_then(|c| c.as_str()).or(Some(&who.color))),
                    "by": who.id, "by_name": who.name, "t": now,
                });
                {
                    let mut d = room.data.lock();
                    if let Some(p) = d.pins.iter_mut().find(|p| p["id"] == pin["id"]) {
                        *p = pin.clone();
                    } else {
                        if d.pins.len() >= MAX_PINS {
                            return Err("this room has too many pins".into());
                        }
                        d.pins.push(pin.clone());
                    }
                }
                room.send("", json!({"type": "pin", "pin": pin}));
            }
            "pin_del" => {
                let id = v.get("id").and_then(|i| i.as_str()).ok_or("id missing")?;
                let mut d = room.data.lock();
                let n = d.pins.len();
                d.pins.retain(|p| p["id"] != id);
                if d.pins.len() != n {
                    drop(d);
                    room.send("", json!({"type": "pin_del", "id": id}));
                }
            }
            "note" => {
                let text = clean(v.get("text").and_then(|t| t.as_str()).unwrap_or(""), 1000);
                if text.is_empty() {
                    return Err("empty note".into());
                }
                let who = my().ok_or("not a member")?;
                let mut note = json!({"id": rand_id(8), "text": text, "by": who.id, "by_name": who.name, "color": who.color, "t": now});
                if let (Some(lat), Some(lon)) = (num(v, "lat"), num(v, "lon")) {
                    note["lat"] = json!(lat);
                    note["lon"] = json!(lon);
                }
                {
                    let mut d = room.data.lock();
                    d.notes.push(note.clone());
                    let n = d.notes.len();
                    if n > MAX_NOTES {
                        d.notes.drain(..n - MAX_NOTES);
                    }
                }
                room.send("", json!({"type": "note", "note": note}));
            }
            "ping" => return Ok(()),
            "" => return Err("type missing".into()),
            other => return Err(format!("unknown message type {other}")),
        }
        if t != "pos" && t != "view" {
            self.dirty.store(true, Ordering::Relaxed);
        }
        room.touch();
        Ok(())
    }

    fn state(&self, room: &Room, me: &str) -> Value {
        let d = room.data.lock();
        let m = room.members.lock();
        json!({
            "type": "state",
            "room": {"code": d.code, "name": d.name, "created": d.created},
            "you": me,
            "members": m.values().collect::<Vec<_>>(),
            "drawings": d.drawings.values().collect::<Vec<_>>(),
            "pins": d.pins,
            "notes": d.notes,
        })
    }
}

pub fn spawn_janitor(c: Arc<Collab>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        let mut n = 0u64;
        loop {
            tick.tick().await;
            n += 1;
            if n % 20 == 0 {
                let gone = c.purge(now_ms());
                if gone > 0 {
                    tracing::info!("collab: dropped {gone} idle room(s)");
                }
            }
            c.save();
        }
    });
}

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

/// POST /api/collab/rooms {name} → room summary with its code
pub async fn create_room(State(st): St, Json(v): Json<Value>) -> Response {
    match st.collab.create(v.get("name").and_then(|n| n.as_str()).unwrap_or("")) {
        Ok(r) => Json(r.summary()).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}

/// GET /api/collab/rooms
pub async fn list_rooms(State(st): St) -> Json<Value> {
    Json(json!(st.collab.list()))
}

/// GET /api/collab/rooms/{code}
pub async fn get_room(State(st): St, axum::extract::Path(code): axum::extract::Path<String>) -> Response {
    match st.collab.get(&code) {
        Some(r) => Json(r.summary()).into_response(),
        None => err(StatusCode::NOT_FOUND, "no room with that code"),
    }
}

/// DELETE /api/collab/rooms/{code}
pub async fn delete_room(State(st): St, axum::extract::Path(code): axum::extract::Path<String>) -> Response {
    if st.collab.delete(&code) { Json(json!({"ok": true})).into_response() } else { err(StatusCode::NOT_FOUND, "no room with that code") }
}

#[derive(Deserialize)]
pub struct WsQ {
    room: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

/// GET /api/collab/ws?room=CODE&name=…&color=%23rrggbb
pub async fn ws(State(st): St, Query(q): Query<WsQ>, up: WebSocketUpgrade) -> Response {
    let Some(room) = st.collab.get(&q.room) else {
        return err(StatusCode::NOT_FOUND, "no room with that code");
    };
    if room.members.lock().len() >= MAX_MEMBERS {
        return err(StatusCode::SERVICE_UNAVAILABLE, "room is full");
    }
    let id = format!("m{}", st.collab.seq.fetch_add(1, Ordering::Relaxed));
    let name = clean(&q.name, 40);
    let member = Member { id: id.clone(), name: if name.is_empty() { format!("Guest {}", &id[1..]) } else { name }, color: color(Some(&q.color)), joined: now_ms(), pos: None, view: None };
    up.max_message_size(MAX_MSG).on_upgrade(move |sock| conn(st, room, member, sock))
}

async fn conn(st: Arc<AppState>, room: Arc<Room>, me: Member, mut sock: WebSocket) {
    let id = me.id.clone();
    let mut rx = room.tx.subscribe();
    room.members.lock().insert(id.clone(), me.clone());
    room.touch();
    room.send(&id, json!({"type": "member", "member": me}));
    if sock.send(Message::Text(st.collab.state(&room, &id).to_string().into())).await.is_err() {
        room.members.lock().remove(&id);
        return;
    }
    let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));
    // per-connection flood guard: 40 messages/second sustained
    let mut budget = 80f64;
    let mut last = std::time::Instant::now();
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok((from, txt)) => {
                    if from == id { continue; }
                    if sock.send(Message::Text(txt.to_string().into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // fell behind: resend the full state
                    if sock.send(Message::Text(st.collab.state(&room, &id).to_string().into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            incoming = sock.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    let el = last.elapsed().as_secs_f64();
                    last = std::time::Instant::now();
                    budget = (budget + el * 40.0).min(80.0) - 1.0;
                    if budget < 0.0 {
                        let _ = sock.send(Message::Text(json!({"type": "error", "error": "too many messages"}).to_string().into())).await;
                        continue;
                    }
                    let v: Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                    if v["type"] == "ping" {
                        let _ = sock.send(Message::Text(json!({"type": "pong"}).to_string().into())).await;
                        continue;
                    }
                    if let Err(e) = st.collab.apply(&room, &id, &v) {
                        let _ = sock.send(Message::Text(json!({"type": "error", "error": e, "for": v.get("type")}).to_string().into())).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if sock.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
    room.members.lock().remove(&id);
    room.touch();
    room.send(&id, json!({"type": "leave", "id": id}));
    st.collab.dirty.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join(c: &Collab, r: &Room, name: &str) -> String {
        let id = format!("m{}", c.seq.fetch_add(1, Ordering::Relaxed));
        r.members.lock().insert(id.clone(), Member { id: id.clone(), name: name.into(), color: "#ff0000".into(), joined: 0, pos: None, view: None });
        id
    }

    #[test]
    fn room_flow() {
        let d = std::env::temp_dir().join(format!("tbw-collab-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let c = Collab::new(&d);
        let r = c.create("Chasers").unwrap();
        let code = r.data.lock().code.clone();
        assert_eq!(code.len(), 6);
        assert!(c.get(&code.to_lowercase()).is_some());
        let a = join(&c, &r, "Ann");
        let b = join(&c, &r, "Bob");
        let mut rx = r.tx.subscribe();
        let fc = json!({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [-97.0, 35.0]}}]});
        c.apply(&r, &a, &json!({"type": "draw", "group": "g1", "geojson": fc})).unwrap();
        let (_, msg) = rx.try_recv().unwrap();
        assert!(msg.contains("\"draw\""));
        // Bob can't overwrite Ann's drawing
        assert!(c.apply(&r, &b, &json!({"type": "draw", "group": "g1", "geojson": fc})).is_err());
        assert!(c.apply(&r, &a, &json!({"type": "draw", "group": "g2", "geojson": {"type": "Feature"}})).is_err());
        c.apply(&r, &b, &json!({"type": "pin", "lat": 35.1, "lon": -97.2, "text": "Hail core"})).unwrap();
        c.apply(&r, &b, &json!({"type": "note", "text": "Heading north on I-35"})).unwrap();
        c.apply(&r, &a, &json!({"type": "pos", "lat": 35.0, "lon": -97.0, "heading": 10})).unwrap();
        assert!(c.apply(&r, &a, &json!({"type": "pos", "lat": 135.0, "lon": -97.0})).is_err());
        c.apply(&r, &a, &json!({"type": "view", "center": [-97.0, 35.0], "zoom": 9})).unwrap();
        assert!(r.members.lock()[&a].view.is_some());
        assert!(c.apply(&r, &a, &json!({"type": "bogus"})).is_err());
        let st = c.state(&r, &a);
        assert_eq!(st["drawings"].as_array().unwrap().len(), 1);
        assert_eq!(st["pins"].as_array().unwrap().len(), 1);
        assert_eq!(st["notes"].as_array().unwrap().len(), 1);
        c.save();
        // persisted without members
        let c2 = Collab::new(&d);
        let r2 = c2.get(&code).unwrap();
        assert_eq!(r2.data.lock().pins.len(), 1);
        assert!(r2.members.lock().is_empty());
        // idle rooms are dropped after 24 h
        assert_eq!(c2.purge(now_ms() + IDLE_MS + 1000), 1);
        assert!(c2.get(&code).is_none());
        std::fs::remove_dir_all(&d).ok();
    }
}
