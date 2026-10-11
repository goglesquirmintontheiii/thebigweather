//! Event hub: JSON events pushed to every connected app over WebSocket.

use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Arc<str>>,
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self { tx }
    }
    pub fn send(&self, v: serde_json::Value) {
        let _ = self.tx.send(Arc::from(v.to_string()));
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }
    pub fn clients(&self) -> usize {
        self.tx.receiver_count()
    }
}
