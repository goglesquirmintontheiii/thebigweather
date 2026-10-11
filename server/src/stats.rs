//! Server hardware stats pushed to the draggable stats panel.

use crate::hub::Hub;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize, Default)]
pub struct Stats {
    pub cpu: f32,
    pub cores: usize,
    pub load1: f64,
    pub mem_total: u64,
    pub mem_used: u64,
    pub disk_total: u64,
    pub disk_free: u64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub proc_rss: u64,
    pub uptime: u64,
    pub clients: usize,
}

pub fn spawn(hub: Hub, data_dir: PathBuf, interval_ms: u64, latest: Arc<parking_lot::RwLock<Stats>>) {
    tokio::spawn(async move {
        let mut sys = System::new();
        let mut nets = Networks::new_with_refreshed_list();
        let mut disks = Disks::new_with_refreshed_list();
        let pid = sysinfo::get_current_pid().ok();
        let dir = std::fs::canonicalize(&data_dir).unwrap_or(data_dir);
        let mut last = std::time::Instant::now();
        sys.refresh_cpu_usage();
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            nets.refresh(true);
            disks.refresh(true);
            let dt = last.elapsed().as_secs_f64().max(0.001);
            last = std::time::Instant::now();
            let (mut rx, mut tx) = (0u64, 0u64);
            for (name, n) in nets.iter() {
                if name == "lo" {
                    continue;
                }
                rx += n.received();
                tx += n.transmitted();
            }
            // disk holding the data dir = longest matching mount point
            let mut best: Option<(&sysinfo::Disk, usize)> = None;
            for d in disks.list() {
                let mp = d.mount_point();
                if dir.starts_with(mp) {
                    let l = mp.as_os_str().len();
                    if best.map(|b| l > b.1).unwrap_or(true) {
                        best = Some((d, l));
                    }
                }
            }
            let (disk_total, disk_free) = best.map(|(d, _)| (d.total_space(), d.available_space())).unwrap_or((0, 0));
            let mut rss = 0;
            if let Some(p) = pid {
                sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[p]), true);
                if let Some(pr) = sys.process(p) {
                    rss = pr.memory();
                }
            }
            let s = Stats {
                cpu: sys.global_cpu_usage(),
                cores: sys.cpus().len(),
                load1: System::load_average().one,
                mem_total: sys.total_memory(),
                mem_used: sys.used_memory(),
                disk_total,
                disk_free,
                net_rx_bps: rx as f64 / dt,
                net_tx_bps: tx as f64 / dt,
                proc_rss: rss,
                uptime: System::uptime(),
                clients: hub.clients(),
            };
            *latest.write() = s.clone();
            if hub.clients() > 0 {
                hub.send(serde_json::json!({"type": "stats", "stats": s}));
            }
        }
    });
}
