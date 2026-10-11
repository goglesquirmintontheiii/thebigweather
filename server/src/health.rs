//! Per-source health tracking shown in the app's "Sources" panel.

use crate::hub::Hub;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct SourceStatus {
    pub id: String,
    pub name: String,
    /// ok | error | idle | disabled
    pub status: String,
    pub last_ok: Option<i64>,
    pub last_error: Option<String>,
    pub last_error_at: Option<i64>,
    pub detail: String,
    pub failures: u32,
}

pub struct Health {
    map: RwLock<BTreeMap<String, SourceStatus>>,
    hub: Hub,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Health {
    pub fn new(hub: Hub) -> Self {
        Self { map: RwLock::new(BTreeMap::new()), hub }
    }
    fn update(&self, id: &str, name: &str, f: impl FnOnce(&mut SourceStatus)) {
        let snapshot = {
            let mut m = self.map.write();
            let e = m.entry(id.to_string()).or_insert_with(|| SourceStatus {
                id: id.into(),
                name: name.into(),
                status: "idle".into(),
                last_ok: None,
                last_error: None,
                last_error_at: None,
                detail: String::new(),
                failures: 0,
            });
            let before = e.status.clone();
            f(e);
            if before != e.status {
                Some(e.clone())
            } else {
                None
            }
        };
        if let Some(s) = snapshot {
            self.hub.send(serde_json::json!({"type": "source", "source": s}));
        }
    }
    pub fn register(&self, id: &str, name: &str, detail: &str) {
        self.update(id, name, |e| e.detail = detail.into());
    }
    pub fn ok(&self, id: &str, name: &str, detail: impl Into<String>) {
        let d = detail.into();
        self.update(id, name, |e| {
            e.status = "ok".into();
            e.last_ok = Some(now_ms());
            e.failures = 0;
            if !d.is_empty() {
                e.detail = d;
            }
        });
    }
    pub fn err(&self, id: &str, name: &str, err: impl std::fmt::Display) {
        let msg = err.to_string();
        tracing::warn!("source {id}: {msg}");
        self.update(id, name, |e| {
            e.failures += 1;
            // a single hiccup after success isn't an outage
            if e.failures >= 2 || e.last_ok.is_none() {
                e.status = "error".into();
            }
            e.last_error = Some(msg);
            e.last_error_at = Some(now_ms());
        });
    }
    pub fn disabled(&self, id: &str, name: &str, why: &str) {
        self.update(id, name, |e| {
            e.status = "disabled".into();
            e.detail = why.into();
        });
    }
    pub fn list(&self) -> Vec<SourceStatus> {
        self.map.read().values().cloned().collect()
    }
}
