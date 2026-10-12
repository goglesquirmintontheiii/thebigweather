//! Radar beam geometry (4/3 effective earth radius) and polar-sweep lookup helpers shared by
//! the 3D volume and rotation products.

use super::level2::{Moment, MomentData, Sweep};

/// Mean earth radius (m), same as the app's 3D renderer.
pub const R_EARTH: f64 = 6_371_000.0;
/// Effective earth radius for standard refraction.
pub const RE_EFF: f64 = R_EARTH * 4.0 / 3.0;

/// Beam height above the radar (m) and ground distance (m) for slant range `r` (m) at `elev` (deg).
#[inline]
pub fn beam_height(r: f64, elev_deg: f64) -> (f64, f64) {
    let th = elev_deg.to_radians();
    let h = (r * r + RE_EFF * RE_EFF + 2.0 * r * RE_EFF * th.sin()).sqrt() - RE_EFF;
    let s = RE_EFF * (r * th.cos() / (RE_EFF + h)).asin();
    (h, s)
}

/// Inverse of [`beam_height`]: slant range (m) and elevation (deg) of the point at ground distance
/// `s` (m) and height `h` (m) above the radar.
#[inline]
pub fn slant_from(s: f64, h: f64) -> (f64, f64) {
    let phi = s / RE_EFF;
    let rr = RE_EFF + h;
    let dx = rr * phi.sin();
    let dz = rr * phi.cos() - RE_EFF;
    ((dx * dx + dz * dz).sqrt(), dz.atan2(dx).to_degrees())
}

/// Great-circle bearing (deg, 0..360) and distance (m) from (lat1, lon1) to (lat2, lon2).
#[inline]
pub fn bearing_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> (f64, f64) {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dl = (lon2 - lon1).to_radians();
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    let brg = y.atan2(x).to_degrees().rem_euclid(360.0);
    let h = ((p2 - p1) / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    (brg, 2.0 * R_EARTH * h.sqrt().asin())
}

/// Point at bearing `az` (deg) and ground distance `d` (m) from (lat, lon).
#[inline]
pub fn destination(lat: f64, lon: f64, az: f64, d: f64) -> (f64, f64) {
    let (p1, l1, th, dr) = (lat.to_radians(), lon.to_radians(), az.to_radians(), d / R_EARTH);
    let p2 = (p1.sin() * dr.cos() + p1.cos() * dr.sin() * th.cos()).asin();
    let l2 = l1 + (th.sin() * dr.sin() * p1.cos()).atan2(dr.cos() - p1.sin() * p2.sin());
    (p2.to_degrees(), ((l2.to_degrees() + 540.0) % 360.0) - 180.0)
}

/// Number of azimuth bins in the lookup table (0.25°).
const AZ_BINS: usize = 1440;

/// One moment of one sweep, radials sorted by azimuth, with an azimuth → radial lookup.
pub struct PolarSweep<'a> {
    pub elev: f64,
    pub radials: Vec<(f32, f32, f32, &'a MomentData)>, // (azimuth, spacing, nyquist, data)
    /// azimuth bin -> index into `radials` (u16::MAX = gap)
    lut: Vec<u16>,
    pub first_gate: f64,
    pub gate: f64,
    pub ngates: usize,
}

impl<'a> PolarSweep<'a> {
    pub fn new(sweep: &'a Sweep, m: Moment) -> Option<Self> {
        let mut radials: Vec<(f32, f32, f32, &MomentData)> =
            sweep.radials.iter().filter_map(|r| r.moment(m).map(|d| (r.azimuth.rem_euclid(360.0), r.az_spacing.max(0.1), r.nyquist, d))).collect();
        if radials.len() < 10 {
            return None;
        }
        radials.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let first = radials[0].3;
        let ngates = radials.iter().map(|r| r.3.ngates as usize).max().unwrap_or(0);
        let mut lut = vec![u16::MAX; AZ_BINS];
        let bw = 360.0 / AZ_BINS as f32;
        for (b, slot) in lut.iter_mut().enumerate() {
            let az = (b as f32 + 0.5) * bw;
            // nearest radial (sorted, so binary search then compare neighbours, with wrap)
            let n = radials.len();
            let k = radials.partition_point(|r| r.0 < az);
            let cand = [(k + n - 1) % n, k % n];
            let mut best = None;
            let mut bd = f32::MAX;
            for &c in &cand {
                let mut d = (radials[c].0 - az).abs();
                if d > 180.0 {
                    d = 360.0 - d;
                }
                if d < bd {
                    bd = d;
                    best = Some(c);
                }
            }
            if let Some(c) = best {
                // a radial covers ±0.75 of its spacing (tolerates small gaps, not missing sectors)
                if bd <= radials[c].1 * 0.75 {
                    *slot = c as u16;
                }
            }
        }
        Some(Self { elev: sweep.elevation() as f64, radials, lut, first_gate: first.first_gate_m as f64, gate: first.gate_m.max(1.0) as f64, ngates })
    }

    /// Radial index covering azimuth `az` (deg).
    #[inline]
    pub fn radial_at(&self, az: f64) -> Option<usize> {
        let b = ((az.rem_euclid(360.0)) / 360.0 * AZ_BINS as f64) as usize;
        let v = self.lut[b.min(AZ_BINS - 1)];
        (v != u16::MAX).then_some(v as usize)
    }

    /// Gate index at slant range `r` (m).
    #[inline]
    pub fn gate_at(&self, r: f64) -> Option<usize> {
        let g = ((r - self.first_gate) / self.gate).round();
        (g >= 0.0 && (g as usize) < self.ngates).then_some(g as usize)
    }

    /// Physical value at (radial, gate); None for no data / range folded / beyond the radial.
    #[inline]
    pub fn value(&self, ri: usize, g: usize) -> Option<f32> {
        let d = self.radials[ri].3;
        if g >= d.ngates as usize {
            return None;
        }
        d.value(g)
    }

    /// Value at azimuth / slant range.
    #[inline]
    pub fn at(&self, az: f64, r: f64) -> Option<f32> {
        self.value(self.radial_at(az)?, self.gate_at(r)?)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::radar::level2::{Radial, Volume};

    #[test]
    fn beam_roundtrip() {
        for &(r, el) in &[(10_000.0, 0.5), (120_000.0, 0.5), (200_000.0, 3.1), (50_000.0, 19.5)] {
            let (h, s) = beam_height(r, el);
            let (r2, el2) = slant_from(s, h);
            assert!((r2 - r).abs() < 1.0 && (el2 - el).abs() < 1e-4, "{r} {el} -> {r2} {el2}");
        }
        // classic numbers: 0.5° beam at 100 km is ~1.46 km above the radar
        let (h, _) = beam_height(100_000.0, 0.5);
        assert!((h - 1460.0).abs() < 30.0, "{h}");
    }

    #[test]
    fn bearing_destination_roundtrip() {
        let (lat, lon) = destination(35.33, -97.28, 47.0, 60_000.0);
        let (b, d) = bearing_dist(35.33, -97.28, lat, lon);
        assert!((b - 47.0).abs() < 0.01 && (d - 60_000.0).abs() < 1.0);
    }

    /// Encode a physical value as an 8-bit Level II gate (scale/offset as in Message 31).
    pub fn enc(v: Option<f32>, scale: f32, offset: f32) -> u8 {
        match v {
            Some(v) => (v * scale + offset).round().clamp(2.0, 255.0) as u8,
            None => 0,
        }
    }

    /// Build a synthetic volume: one sweep per elevation, 720 radials, 250 m gates.
    /// `f(moment, az, slant range m, elev) -> value`.
    pub fn synth_volume(elevs: &[f32], ngates: usize, nyq: f32, f: impl Fn(Moment, f64, f64, f64) -> Option<f32>) -> Volume {
        let mut v = Volume { site: "KTST".into(), vcp: 212, lat: 35.0, lon: -97.0, height_m: 400.0, header_time_ms: 1_700_000_000_000, complete: true, ..Default::default() };
        for (ei, &el) in elevs.iter().enumerate() {
            let mut sweep = Sweep { elev_num: ei as u8 + 1, radials: vec![], complete: true };
            for i in 0..720 {
                let az = i as f32 * 0.5 + 0.25;
                let mut moments = vec![];
                for (m, scale, offset) in [(Moment::Ref, 2.0f32, 66.0f32), (Moment::Vel, 2.0, 129.0), (Moment::Zdr, 16.0, 128.0)] {
                    let data: Vec<u8> = (0..ngates).map(|g| enc(f(m, az as f64, 2125.0 + g as f64 * 250.0, el as f64), scale, offset)).collect();
                    moments.push(MomentData { moment: m, ngates: ngates as u16, first_gate_m: 2125.0, gate_m: 250.0, word_size: 8, scale, offset, data });
                }
                sweep.radials.push(Radial { time_ms: v.header_time_ms + ei as i64 * 20_000 + i as i64 * 20, azimuth: az, elevation: el, az_spacing: 0.5, status: 1, elev_num: ei as u8 + 1, nyquist: nyq, moments });
            }
            v.sweeps.push(sweep);
        }
        v
    }

    #[test]
    fn polar_lookup() {
        let v = synth_volume(&[0.5], 400, 30.0, |m, az, _, _| if m == Moment::Ref { Some((az / 10.0) as f32) } else { None });
        let p = PolarSweep::new(&v.sweeps[0], Moment::Ref).unwrap();
        let ri = p.radial_at(90.3).unwrap();
        assert!((p.radials[ri].0 - 90.25).abs() < 0.01);
        assert!(p.radial_at(359.9).is_some());
        let x = p.at(180.0, 50_000.0).unwrap();
        assert!((x - 18.0).abs() < 0.6, "{x}");
        assert!(p.at(10.0, 500_000.0).is_none());
    }
}
