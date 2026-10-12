//! Small in-memory ring of recent log lines (for the local "Server settings" log view).

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fmt::Write;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

pub const CAP: usize = 2000;

static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Last `n` lines, oldest first.
pub fn tail(n: usize) -> Vec<String> {
    let l = LINES.lock();
    let k = l.len().saturating_sub(n);
    l.iter().skip(k).cloned().collect()
}

pub fn push(line: String) {
    let mut l = LINES.lock();
    if l.len() >= CAP {
        l.pop_front();
    }
    l.push_back(line);
}

pub struct RingLayer;

struct Msg(String);

impl Visit for Msg {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for RingLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut m = Msg(String::new());
        event.record(&mut m);
        let t = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        push(format!("{t} {:>5} {}", event.metadata().level(), m.0));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ring_keeps_last_lines() {
        for i in 0..(super::CAP + 5) {
            super::push(format!("line {i}"));
        }
        let t = super::tail(2);
        assert_eq!(t, vec![format!("line {}", super::CAP + 3), format!("line {}", super::CAP + 4)]);
    }
}
