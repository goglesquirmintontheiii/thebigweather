//! Minimal anonymous S3 client for public NOAA/Unidata buckets.

use anyhow::{bail, Result};
use bytes::Bytes;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Object {
    pub key: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Default)]
pub struct Listing {
    pub objects: Vec<Object>,
    pub prefixes: Vec<String>,
}

fn tag_values<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = vec![];
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        if let Some(j) = after.find(&close) {
            out.push(&after[..j]);
            rest = &after[j + close.len()..];
        } else {
            break;
        }
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

fn enc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

pub fn object_url(bucket: &str, key: &str) -> String {
    format!("https://{bucket}.s3.amazonaws.com/{}", enc(key))
}

/// List keys under a prefix (follows continuation up to `max_pages`).
pub async fn list(
    http: &reqwest::Client,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: Option<u32>,
    max_pages: usize,
) -> Result<Listing> {
    let mut out = Listing::default();
    let mut token: Option<String> = None;
    for _ in 0..max_pages.max(1) {
        let mut url = format!("https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={}", enc(prefix));
        if let Some(d) = delimiter {
            url.push_str(&format!("&delimiter={}", enc(d)));
        }
        if let Some(m) = max_keys {
            url.push_str(&format!("&max-keys={m}"));
        }
        if let Some(t) = &token {
            url.push_str(&format!("&continuation-token={}", enc(t).replace('/', "%2F")));
        }
        let resp = http.get(&url).send().await?;
        if !resp.status().is_success() {
            bail!("S3 list {bucket}: HTTP {}", resp.status());
        }
        let xml = resp.text().await?;
        for c in tag_values(&xml, "Contents") {
            let key = tag_values(c, "Key").first().map(|s| unescape(s)).unwrap_or_default();
            let size = tag_values(c, "Size").first().and_then(|s| s.parse().ok()).unwrap_or(0);
            let modified = tag_values(c, "LastModified").first().map(|s| s.to_string()).unwrap_or_default();
            out.objects.push(Object { key, size, modified });
        }
        for c in tag_values(&xml, "CommonPrefixes") {
            if let Some(p) = tag_values(c, "Prefix").first() {
                out.prefixes.push(unescape(p));
            }
        }
        let truncated = tag_values(&xml, "IsTruncated").first().map(|s| *s == "true").unwrap_or(false);
        token = tag_values(&xml, "NextContinuationToken").first().map(|s| unescape(s));
        if !truncated || token.is_none() || max_keys.is_some() {
            break;
        }
    }
    Ok(out)
}

pub async fn get(http: &reqwest::Client, bucket: &str, key: &str) -> Result<Bytes> {
    let resp = http.get(object_url(bucket, key)).send().await?;
    if !resp.status().is_success() {
        bail!("S3 get {bucket}/{key}: HTTP {}", resp.status());
    }
    Ok(resp.bytes().await?)
}
