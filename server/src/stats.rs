//! Server hardware stats pushed to the draggable stats panel.

use crate::hub::Hub;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize, Default)]
pub struct Stats {
    /// whole-machine CPU use, % (0-100)
    pub cpu: f32,
    pub cores: usize,
    pub per_core: Vec<f32>,
    pub cpu_name: String,
    pub cpu_mhz: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub mem_available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disk_mount: String,
    pub disk_fs: String,
    pub net_rx_total: u64,
    pub net_tx_total: u64,
    /// server process CPU as % of the whole machine (0-100), comparable with `cpu`
    pub proc_cpu: f32,
    /// same as `proc_cpu` (kept for older clients)
    pub proc_cpu_pct: f32,
    /// server process CPU in % of one core (100 per busy core: 400 = four cores busy)
    pub proc_cpu_cores: f32,
    /// server process threads
    pub proc_threads: usize,
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
            sys.refresh_cpu_all();
            sys.refresh_memory();
            nets.refresh(true);
            disks.refresh(true);
            let dt = last.elapsed().as_secs_f64().max(0.001);
            last = std::time::Instant::now();
            let (mut rx, mut tx, mut rxt, mut txt) = (0u64, 0u64, 0u64, 0u64);
            for (name, n) in nets.iter() {
                if name == "lo" {
                    continue;
                }
                rx += n.received();
                tx += n.transmitted();
                rxt += n.total_received();
                txt += n.total_transmitted();
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
            let disk_mount = best.map(|(d, _)| d.mount_point().display().to_string()).unwrap_or_default();
            let disk_fs = best.map(|(d, _)| d.file_system().to_string_lossy().to_string()).unwrap_or_default();
            let mut rss = 0;
            let mut pcpu = 0.0;
            let mut nthreads = 0;
            if let Some(p) = pid {
                sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[p]), true);
                if let Some(pr) = sys.process(p) {
                    rss = pr.memory();
                    pcpu = pr.cpu_usage();
                    nthreads = pr.tasks().map(|t| t.len()).unwrap_or(0);
                }
            }
            let ncpu = sys.cpus().len().max(1);
            let la = System::load_average();
            let s = Stats {
                cpu: sys.global_cpu_usage().clamp(0.0, 100.0),
                cores: sys.cpus().len(),
                per_core: sys.cpus().iter().map(|c| c.cpu_usage().clamp(0.0, 100.0)).collect(),
                cpu_name: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
                cpu_mhz: sys.cpus().first().map(|c| c.frequency()).unwrap_or(0),
                load1: la.one,
                load5: la.five,
                load15: la.fifteen,
                mem_available: sys.available_memory(),
                swap_total: sys.total_swap(),
                swap_used: sys.used_swap(),
                disk_mount,
                disk_fs,
                net_rx_total: rxt,
                net_tx_total: txt,
                proc_cpu: machine_pct(pcpu, ncpu),
                proc_cpu_pct: machine_pct(pcpu, ncpu),
                proc_cpu_cores: pcpu.max(0.0),
                proc_threads: nthreads,
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

/// A process CPU reading in % of one core → % of the whole machine (0–100).
pub fn machine_pct(per_core_pct: f32, ncpu: usize) -> f32 {
    if !per_core_pct.is_finite() {
        return 0.0;
    }
    (per_core_pct / ncpu.max(1) as f32).clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn process_cpu_is_a_share_of_the_machine() {
        assert_eq!(super::machine_pct(400.0, 8), 50.0);
        assert_eq!(super::machine_pct(1600.0, 8), 100.0);
        assert_eq!(super::machine_pct(f32::NAN, 8), 0.0);
    }
}
