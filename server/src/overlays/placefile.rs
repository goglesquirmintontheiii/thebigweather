//! GRLevelX placefile proxy: fetches a placefile (or one of its icon sheets) for the app, which
//! parses it. Guards against server-side request forgery: only http(s), no private / loopback /
//! link-local targets (unless the app runs on this machine), DNS answers pinned for the request,
//! redirects re-checked, 8 MB cap. Placefiles are cached for their own refresh interval.

use super::Overlays;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str = concat!("TheBigWeather/", env!("CARGO_PKG_VERSION"), " (placefile proxy)");
const CACHE_BYTES: usize = 48 * 1024 * 1024;

/// Fetched placefiles / icon sheets: url → (fresh until, body, content type).
pub struct PlaceCache {
    inner: Mutex<(lru::LruCache<String, (Instant, Bytes, String)>, usize)>,
}

impl Default for PlaceCache {
    fn default() -> Self {
        Self { inner: Mutex::new((lru::LruCache::unbounded(), 0)) }
    }
}

impl PlaceCache {
    fn get(&self, k: &str) -> Option<(Bytes, String)> {
        let mut g = self.inner.lock();
        match g.0.get(k) {
            Some((until, b, ct)) if Instant::now() < *until => Some((b.clone(), ct.clone())),
            _ => None,
        }
    }
    fn put(&self, k: String, ttl: Duration, b: Bytes, ct: String) {
        let mut g = self.inner.lock();
        let n = b.len() + k.len();
        if let Some((old_k, (_, old, _))) = g.0.push(k, (Instant::now() + ttl, b, ct)) {
            g.1 -= old.len() + old_k.len();
        }
        g.1 += n;
        while g.1 > CACHE_BYTES && g.0.len() > 1 {
            match g.0.pop_lru() {
                Some((k, (_, b, _))) => g.1 -= b.len() + k.len(),
                None => break,
            }
        }
    }
    pub fn stats(&self) -> crate::caches::CacheInfo {
        let g = self.inner.lock();
        crate::caches::CacheInfo::mem("placefiles", "Placefiles & icon sheets", g.1, g.0.len(), CACHE_BYTES)
    }
    pub fn clear(&self) {
        let mut g = self.inner.lock();
        g.0.clear();
        g.1 = 0;
    }
}

/// Addresses a proxied request must never reach from a remote client.
pub fn blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => blocked_v4(a),
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return blocked_v4(v4);
            }
            let s = a.segments();
            // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
                return blocked_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        }
    }
}

fn blocked_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    a.is_loopback()
        || a.is_private()
        || a.is_link_local()
        || a.is_unspecified()
        || a.is_broadcast()
        || a.is_multicast()
        || a.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking
        || o[0] >= 240 // reserved
}

/// Check a URL and resolve its host; returns the parsed URL, host and the addresses to use.
async fn vet(url: &str, allow_private: bool) -> Result<(reqwest::Url, String, Vec<SocketAddr>)> {
    let u = reqwest::Url::parse(url.trim()).map_err(|_| anyhow!("bad url"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        bail!("url must be http or https");
    }
    if !u.username().is_empty() || u.password().is_some() {
        bail!("url must not contain credentials");
    }
    let host = u.host_str().ok_or_else(|| anyhow!("bad url"))?.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = u.port_or_known_default().unwrap_or(80);
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((host.as_str(), port)))
            .await
            .map_err(|_| anyhow!("DNS lookup timed out for {host}"))?
            .map_err(|e| anyhow!("can't resolve {host}: {e}"))?
            .collect(),
    };
    if addrs.is_empty() {
        bail!("can't resolve {host}");
    }
    if !allow_private && addrs.iter().any(|a| blocked_ip(a.ip())) {
        bail!("blocked: {host} is a private or local address");
    }
    Ok((u, host, addrs))
}

/// GET with the SSRF guard, following up to 5 redirects (each re-checked). Returns the body and
/// its content type.
pub async fn guarded_get(user_agent: &str, url: &str, allow_private: bool, max: usize) -> Result<(Bytes, String)> {
    let mut url = url.to_string();
    for _ in 0..6 {
        let (u, host, addrs) = vet(&url, allow_private).await?;
        let mut b = reqwest::Client::builder()
            .user_agent(user_agent)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10));
        if host.parse::<IpAddr>().is_err() {
            // pin the vetted addresses so a second DNS answer can't point elsewhere
            b = b.resolve_to_addrs(&host, &addrs);
        }
        let client = b.build()?;
        let mut r = client.get(u.clone()).send().await?;
        if r.status().is_redirection() {
            let loc = r.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(|| anyhow!("redirect without location"))?;
            url = u.join(loc).map_err(|_| anyhow!("bad redirect"))?.to_string();
            continue;
        }
        if !r.status().is_success() {
            bail!("HTTP {} from {host}", r.status());
        }
        if r.content_length().map(|n| n as usize > max).unwrap_or(false) {
            bail!("too large (over {} MB)", max >> 20);
        }
        let ct = r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mut body = Vec::new();
        while let Some(c) = r.chunk().await? {
            if body.len() + c.len() > max {
                bail!("too large (over {} MB)", max >> 20);
            }
            body.extend_from_slice(&c);
        }
        return Ok((Bytes::from(body), ct));
    }
    bail!("too many redirects")
}

/// Refresh interval a placefile asks for ("RefreshSeconds: n" or "Refresh: minutes"), at least 30 s.
pub fn refresh_secs(text: &str) -> u64 {
    for line in text.lines().take(400) {
        let l = line.trim();
        if l.starts_with(';') || l.starts_with("//") {
            continue;
        }
        let Some((k, v)) = l.split_once(':') else { continue };
        let k = k.trim().to_ascii_lowercase();
        let n = v.trim().split(|c: char| !c.is_ascii_digit() && c != '.').next().and_then(|x| x.parse::<f64>().ok());
        match (k.as_str(), n) {
            ("refreshseconds", Some(n)) => return (n as u64).max(30),
            ("refresh", Some(n)) => return ((n * 60.0) as u64).max(30),
            _ => {}
        }
    }
    60
}

/// Sniff common image signatures (servers often send icon sheets as octet-stream).
pub fn image_type(b: &[u8], ct: &str) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else if b.starts_with(b"BM") {
        Some("image/bmp")
    } else if ct.starts_with("image/") && !ct.contains("svg") {
        // other raster types the source labels correctly (SVG is refused: it can carry script)
        Some(match ct.split(';').next().unwrap_or("").trim() {
            "image/x-icon" | "image/vnd.microsoft.icon" => "image/x-icon",
            "image/tiff" => "image/tiff",
            "image/avif" => "image/avif",
            _ => return None,
        })
    } else {
        None
    }
}

impl Overlays {
    /// Placefile text (`asset == false`) or an icon-sheet image.
    pub async fn placefile(&self, url: &str, asset: bool, allow_private: bool) -> Result<(Bytes, String)> {
        let key = format!("{}|{}|{url}", if asset { "a" } else { "p" }, allow_private as u8);
        if let Some(hit) = self.placefiles.get(&key) {
            return Ok(hit);
        }
        let name = if asset { "Placefile icons" } else { "Placefiles" };
        let id = if asset { "placefile-asset" } else { "placefile" };
        let res = guarded_get(USER_AGENT, url, allow_private, MAX_BYTES).await;
        let (b, ct) = match res {
            Ok(x) => x,
            Err(e) => {
                if !format!("{e}").starts_with("blocked") && !format!("{e}").starts_with("bad url") {
                    self.health.err(id, name, &e);
                }
                return Err(e);
            }
        };
        self.health.ok(id, name, "");
        let out = if asset {
            let t = image_type(&b, &ct).ok_or_else(|| anyhow!("not an image"))?;
            self.placefiles.put(key, Duration::from_secs(3600), b.clone(), t.to_string());
            (b, t.to_string())
        } else {
            // placefiles are text; refuse obvious binaries
            if b.iter().take(4096).filter(|&&c| c == 0).count() > 0 {
                bail!("not a placefile (binary data)");
            }
            let text = String::from_utf8_lossy(&b);
            let ttl = refresh_secs(&text);
            let body = Bytes::from(text.into_owned());
            self.placefiles.put(key, Duration::from_secs(ttl), body.clone(), "text/plain; charset=utf-8".into());
            (body, "text/plain; charset=utf-8".into())
        };
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_targets() {
        for s in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "224.0.0.1", "255.255.255.255"] {
            assert!(blocked_ip(s.parse().unwrap()), "{s}");
        }
        for s in ["8.8.8.8", "140.90.101.62", "2607:f8b0:4005::200e", "172.32.0.1", "100.128.0.1"] {
            assert!(!blocked_ip(s.parse().unwrap()), "{s}");
        }
    }

    #[tokio::test]
    async fn vets_urls() {
        assert!(vet("ftp://example.com/x", false).await.is_err());
        assert!(vet("http://user:pw@8.8.8.8/x", false).await.is_err());
        assert!(format!("{}", vet("http://127.0.0.1:8787/api", false).await.unwrap_err()).starts_with("blocked"));
        assert!(format!("{}", vet("http://[::1]/", false).await.unwrap_err()).starts_with("blocked"));
        assert!(vet("http://127.0.0.1:8787/api", true).await.is_ok());
        assert!(vet("http://8.8.8.8/pf.txt", false).await.is_ok());
    }

    #[test]
    fn refresh_interval() {
        assert_eq!(refresh_secs("Title: x\nRefreshSeconds: 15\n"), 30);
        assert_eq!(refresh_secs("; comment Refresh: 1\nRefreshSeconds: 120\n"), 120);
        assert_eq!(refresh_secs("Title: x\nRefresh: 2\nThreshold: 999\n"), 120);
        assert_eq!(refresh_secs("Title: x\n"), 60);
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(image_type(&[0x89, b'P', b'N', b'G', 0, 0], ""), Some("image/png"));
        assert_eq!(image_type(b"<svg", "image/svg+xml"), None);
        assert_eq!(image_type(b"hello", "text/plain"), None);
        assert_eq!(image_type(b"xx", "image/x-icon"), Some("image/x-icon"));
    }
}
