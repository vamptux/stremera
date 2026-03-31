use crate::providers::realdebrid::RealDebrid;
use regex::Regex;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

static SEEDER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*(\d+)").expect("valid seeder regex"));
static SIZE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([\d\.]+)\s*([KMGT]B)").expect("valid size regex"));
/// Fallback size regex for addons that use plain-text format (e.g. "1.2 GB") without emoji.
static PLAIN_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)([\d\.]+)\s*([KMGT]i?B)\b").expect("valid plain size regex")
});

/// Detects season packs, batch downloads, and multi-episode collections.
/// Intentionally conservative to avoid false positives on single-episode streams.
static BATCH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:",
        // Explicit batch/pack keywords
        r"\bbatch\b",
        r"|\bcomplete\s+(?:series|season|pack|collection)\b",
        r"|\bseason\s*pack\b",
        r"|\bfull\s+(?:season|series)\b",
        // Season ranges: S01-S23, S01~S05
        r"|\bs\d{1,2}\s*[-~]\s*s\d{1,2}\b",
        // Episode ranges requiring BOTH E/EP markers to avoid
        // false-matching titles like "S15E52 - 1080p"
        r"|\b(?:e|ep)\d{1,4}\s*[-~]\s*(?:e|ep)\d{1,4}\b",
        // Keyword ranges: "Season 1-23", "Episode 1-24"
        r"|\bseason\s*\d+\s*[-~&]\s*(?:season\s*)?\d+\b",
        r"|\bepisode\s*\d+\s*[-~]\s*(?:episode\s*)?\d+\b",
        r")"
    ))
    .expect("valid batch regex")
});

static SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e0*(\d{1,4})\s*[-~]\s*e?0*(\d{1,4})\b")
        .expect("valid season episode range regex")
});
static X_SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x0*(\d{1,4})\s*[-~]\s*(?:0*\d{1,2}x)?0*(\d{1,4})\b")
        .expect("valid x season episode range regex")
});
static EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:e|ep|episode)\s*0*(\d{1,4})\s*[-~]\s*(?:e|ep|episode)?\s*0*(\d{1,4})\b")
        .expect("valid episode range regex")
});
static SEASON_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs(?:eason)?\s*0*(\d{1,2})\s*[-~&]\s*(?:s(?:eason)?\s*)?0*(\d{1,2})\b")
        .expect("valid season range regex")
});
static SEASON_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bseason\s*0*(\d{1,2})\b").expect("valid season token regex")
});
static SEASON_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e\d{1,4}\b").expect("valid season episode token regex")
});
static X_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x\d{1,4}\b").expect("valid x episode token regex")
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum StreamEpisodeMatchKind {
    None,
    SeasonPack,
    EpisodeRange,
    Exact,
}

fn range_contains(requested: u32, start: u32, end: u32) -> bool {
    let lower = start.min(end);
    let upper = start.max(end);
    requested >= lower && requested <= upper
}

fn parse_captured_u32(captures: &regex::Captures<'_>, index: usize) -> Option<u32> {
    captures.get(index)?.as_str().parse::<u32>().ok()
}

fn text_matches_requested_season(text: &str, requested_season: u32) -> Option<bool> {
    let lower = text.to_lowercase();
    let mut saw_explicit_season = false;
    let mut saw_matching_season = false;

    for captures in SEASON_RANGE_REGEX.captures_iter(&lower) {
        let Some(start) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(end) = parse_captured_u32(&captures, 2) else {
            continue;
        };

        saw_explicit_season = true;
        if range_contains(requested_season, start, end) {
            saw_matching_season = true;
        }
    }

    for regex in [
        &*SEASON_EPISODE_RANGE_REGEX,
        &*X_SEASON_EPISODE_RANGE_REGEX,
        &*SEASON_EPISODE_TOKEN_REGEX,
        &*X_EPISODE_TOKEN_REGEX,
        &*SEASON_TOKEN_REGEX,
    ] {
        for captures in regex.captures_iter(&lower) {
            let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
                continue;
            };

            saw_explicit_season = true;
            if candidate_season == requested_season {
                saw_matching_season = true;
            }
        }
    }

    if !saw_explicit_season {
        None
    } else {
        Some(saw_matching_season)
    }
}

fn episode_range_contains_text(text: &str, season: u32, episode: u32) -> bool {
    let lower = text.to_lowercase();

    for captures in SEASON_EPISODE_RANGE_REGEX.captures_iter(&lower) {
        let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(start_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 3) else {
            continue;
        };

        if candidate_season == season && range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    for captures in X_SEASON_EPISODE_RANGE_REGEX.captures_iter(&lower) {
        let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(start_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 3) else {
            continue;
        };

        if candidate_season == season && range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    if matches!(text_matches_requested_season(text, season), Some(false)) {
        return false;
    }

    for captures in EPISODE_RANGE_REGEX.captures_iter(&lower) {
        let Some(start_episode) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };

        if range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    false
}

/// Check whether stream text explicitly mentions the requested episode.
/// Uses a pre-allocated buffer for pattern matching to avoid per-check heap allocations.
/// Handles long-running series (e.g. One Piece ep 1000+) with multiple naming conventions.
fn episode_matches_text(text: &str, season: u32, episode: u32) -> bool {
    use std::fmt::Write;

    let t = text.to_lowercase();
    let season_context = text_matches_requested_season(text, season);
    let mut buf = String::with_capacity(20);

    // S15E52 (zero-padded)
    let _ = write!(buf, "s{:02}e{:02}", season, episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    // S15E52 (no zero-padding on season)
    buf.clear();
    let _ = write!(buf, "s{}e{}", season, episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    // 3+ digit episodes: S01E1000 (common for long-running anime)
    if episode >= 100 {
        buf.clear();
        let _ = write!(buf, "s{:02}e{}", season, episode);
        if t.contains(buf.as_str()) {
            return true;
        }
    }

    // 15x52 / 1x1000
    buf.clear();
    let _ = write!(buf, "{}x{:02}", season, episode);
    if t.contains(buf.as_str()) {
        return true;
    }
    if episode >= 100 {
        buf.clear();
        let _ = write!(buf, "{}x{}", season, episode);
        if t.contains(buf.as_str()) {
            return true;
        }
    }

    if matches!(season_context, Some(false)) {
        return false;
    }

    // "Episode 52" / "Episode 1000" / "Ep 52" / "Ep.52" / "EP52" / "E52" standalone
    buf.clear();
    let _ = write!(buf, "episode {}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "ep {}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "ep.{}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "ep{}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    // " - 1000" / " - 052" — common for anime release groups
    buf.clear();
    let _ = write!(buf, " - {:03}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }
    if episode >= 100 {
        buf.clear();
        let _ = write!(buf, " - {}", episode);
        if t.contains(buf.as_str()) {
            return true;
        }
    }

    // "#1000" — sometimes used in anime releases
    buf.clear();
    let _ = write!(buf, "#{}", episode);
    if t.contains(buf.as_str()) {
        return true;
    }

    false
}

pub(crate) fn stream_contains_batch(s: &TorrentioStream) -> bool {
    s.name
        .as_deref()
        .is_some_and(|name| BATCH_REGEX.is_match(name))
        || s.title
            .as_deref()
            .is_some_and(|title| BATCH_REGEX.is_match(title))
        || s.behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref())
            .is_some_and(|filename| BATCH_REGEX.is_match(filename))
}

pub(crate) fn stream_matches_episode(s: &TorrentioStream, season: u32, episode: u32) -> bool {
    s.name
        .as_deref()
        .is_some_and(|name| episode_matches_text(name, season, episode))
        || s.title
            .as_deref()
            .is_some_and(|title| episode_matches_text(title, season, episode))
        || s.behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref())
            .is_some_and(|filename| episode_matches_text(filename, season, episode))
}

pub(crate) fn stream_episode_match_kind(
    s: &TorrentioStream,
    season: u32,
    episode: u32,
) -> StreamEpisodeMatchKind {
    if stream_matches_episode(s, season, episode) {
        return StreamEpisodeMatchKind::Exact;
    }

    for text in [
        s.name.as_deref(),
        s.title.as_deref(),
        s.behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        if episode_range_contains_text(text, season, episode) {
            return StreamEpisodeMatchKind::EpisodeRange;
        }
    }

    if stream_contains_batch(s) {
        for text in [
            s.name.as_deref(),
            s.title.as_deref(),
            s.behavior_hints
                .as_ref()
                .and_then(|hints| hints.filename.as_deref()),
        ]
        .into_iter()
        .flatten()
        {
            if matches!(text_matches_requested_season(text, season), Some(true)) {
                return StreamEpisodeMatchKind::SeasonPack;
            }
        }
    }

    StreamEpisodeMatchKind::None
}

fn rd_token_cache_segment(rd_token: Option<&str>) -> String {
    let Some(token) = rd_token.map(str::trim).filter(|token| !token.is_empty()) else {
        return "rd:none".to_string();
    };

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut hasher);
    format!("rd:{:016x}", hasher.finish())
}

/// Builds a short deterministic cache segment from the addon config URL so that
/// different addons never share a cache entry for the same content.
fn config_cache_segment(config_url: &str) -> String {
    let url = config_url.trim();
    if url.is_empty() {
        return "cfg:default".to_string();
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("cfg:{:016x}", hasher.finish())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentioStream {
    pub name: Option<String>,
    #[serde(alias = "description")]
    pub title: Option<String>,
    #[serde(rename = "infoHash", alias = "info_hash")]
    pub info_hash: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "fileIdx", alias = "file_idx")]
    pub file_idx: Option<u32>,
    #[serde(rename = "behaviorHints", alias = "behavior_hints")]
    pub behavior_hints: Option<BehaviorHints>,

    // Computed fields (skipped in deserialization, set by the command layer)
    #[serde(skip_deserializing, default)]
    pub cached: bool,
    #[serde(skip_deserializing, default)]
    pub seeders: Option<u32>,
    #[serde(skip_deserializing, default)]
    pub size_bytes: Option<u64>,
    /// Which addon/source produced this stream (set by commands.rs, not from the addon payload).
    #[serde(skip_deserializing, default)]
    pub source_name: Option<String>,
    /// Stable backend-derived identity for release families that can be reused across nearby episodes.
    #[serde(skip_deserializing, default)]
    pub stream_family: Option<String>,
    /// Short user-facing explanation from the backend coordinator for why this stream ranks here.
    #[serde(skip_deserializing, default)]
    pub recommendation_reasons: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BehaviorHints {
    #[serde(rename = "bingeGroup", alias = "binge_group")]
    pub binge_group: Option<String>,
    pub filename: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AddonStreamResponse {
    pub streams: Vec<TorrentioStream>,
}

/// TTL for cached addon stream responses. Shared across `get_streams` and
/// `resolve_best_stream` to avoid duplicate HTTP requests for the same content.
const STREAM_CACHE_TTL: Duration = Duration::from_secs(180);

/// Maximum number of entries before a full eviction pass.
const STREAM_CACHE_MAX_ENTRIES: usize = 64;

/// Max number of debrid-friendly streams retained for custom config mode.
const DEBRID_STREAMS_MAX: usize = 15;
/// Max number of torrent-capable streams retained for custom config mode.
const TORRENT_STREAMS_MAX: usize = 20;
/// Final merged max in custom config mode.
const TOTAL_STREAMS_MAX: usize = 35;
/// Per-request timeout for fallback probes against `/stream/...` endpoints.
const FALLBACK_STREAM_REQUEST_TIMEOUT_SECS: u64 = 6;

struct CachedStreams {
    streams: Vec<TorrentioStream>,
    expires_at: Instant,
}

pub struct AddonTransport {
    client: Client,
    /// In-memory, TTL-based cache for `get_streams` results keyed by
    /// `{type}|{id}|{rd_token_hash_or_none}|{addon_url_hash}`.
    /// Prevents duplicate addon HTTP requests when multiple code-paths
    /// (e.g. `get_streams` command + `resolve_best_stream` command) query the
    /// same content within a short window.
    cache: Mutex<HashMap<String, CachedStreams>>,
}

/// Composite quality score for a stream based on resolution, source, HDR,
/// audio, and encoding metadata. Higher = better. Used by both addon ranking
/// and the best-stream ranker in commands.
pub fn stream_quality_score(stream: &TorrentioStream) -> i32 {
    let title = stream.title.as_deref().unwrap_or("").to_lowercase();
    let name = stream.name.as_deref().unwrap_or("").to_lowercase();
    let mut score = 0;

    // ── Resolution ────────────────────────────────────────────────────
    if title.contains("2160p") || title.contains("4k") || name.contains("4k") {
        score += 400;
    } else if title.contains("1080p") {
        score += 300;
    } else if title.contains("720p") {
        score += 200;
    } else if title.contains("480p") {
        score += 100;
    }

    // ── Source quality (release type) ─────────────────────────────────
    if title.contains("remux") || title.contains("bdremux") {
        score += 35;
    } else if title.contains("bluray") || title.contains("blu-ray") || title.contains("bdrip") {
        score += 30;
    } else if title.contains("web-dl") || title.contains("webdl") {
        score += 25;
    } else if title.contains("webrip") {
        score += 20;
    } else if title.contains("hdtv") {
        score += 10;
    }

    // ── HDR / Dolby Vision ────────────────────────────────────────────
    if title.contains("dolby vision") || title.contains("dovi") {
        score += 55;
    } else if title.contains("hdr10+") {
        score += 52;
    } else if title.contains("hdr") {
        score += 50;
    }

    // ── Audio quality ─────────────────────────────────────────────────
    if title.contains("truehd") || title.contains("atmos") {
        score += 15;
    } else if title.contains("dts-hd") || title.contains("dts-x") || title.contains("dtsx") {
        score += 13;
    } else if title.contains("dts") || title.contains("dd+") || title.contains("eac3") {
        score += 10;
    } else if title.contains("5.1") || title.contains("7.1") {
        score += 8;
    }

    // ── Efficient encoding bonus ───────────────────────────────────────
    if title.contains("x265") || title.contains("hevc") || title.contains("h265") {
        score += 5;
    }

    score
}

impl AddonTransport {
    fn matches_stream_identity(left: &TorrentioStream, right: &TorrentioStream) -> bool {
        left.info_hash == right.info_hash
            && left.file_idx == right.file_idx
            && left.url == right.url
    }

    fn matches_torrent_identity(left: &TorrentioStream, right: &TorrentioStream) -> bool {
        left.info_hash == right.info_hash && left.file_idx == right.file_idx
    }

    fn build_stream_endpoint(base_url: &str, type_: &str, id: &str) -> Result<String, String> {
        let mut parsed =
            reqwest::Url::parse(base_url).map_err(|e| format!("Invalid addon URL: {}", e))?;

        let query = parsed.query().map(|q| q.to_string());
        let raw_path = parsed.path();
        let trimmed_path = raw_path.trim_end_matches('/');
        let base_path = trimmed_path
            .strip_suffix("/manifest.json")
            .unwrap_or(trimmed_path);

        let stream_path = if base_path.is_empty() || base_path == "/" {
            format!("/stream/{}/{}.json", type_, id)
        } else {
            format!("{}/stream/{}/{}.json", base_path, type_, id)
        };

        parsed.set_path(&stream_path);
        parsed.set_query(query.as_deref());
        Ok(parsed.to_string())
    }

    fn should_probe_root_fallback(base_url: &str) -> bool {
        let Ok(parsed) = reqwest::Url::parse(base_url) else {
            return false;
        };

        if parsed.query().is_some() {
            return true;
        }

        parsed
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|segment| !segment.is_empty() && *segment != "manifest.json")
            .any(|segment| segment.contains('=') || segment.contains('|'))
    }

    fn build_request_origin(base_url: &str) -> Result<String, String> {
        let parsed =
            reqwest::Url::parse(base_url).map_err(|e| format!("Invalid addon URL: {}", e))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "Invalid addon URL: missing host".to_string())?;

        let mut origin = format!("{}://{}", parsed.scheme(), host);
        if let Some(port) = parsed.port() {
            origin.push_str(&format!(":{}", port));
        }

        Ok(origin)
    }

    pub fn new() -> Self {
        // Build a header map that mirrors what a browser-like addon client sends so that
        // Some addon hosts sit behind CDN or anti-bot layers that are friendlier
        // to browser-like request headers.
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            header::ACCEPT_LANGUAGE,
            header::HeaderValue::from_static("en-US,en;q=0.9"),
        );
        headers.insert(
            header::ACCEPT_ENCODING,
            header::HeaderValue::from_static("gzip, deflate, br"),
        );
        headers.insert(
            header::CONNECTION,
            header::HeaderValue::from_static("keep-alive"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-cache"),
        );
        // Keep the legacy Stremio header for compatibility with existing addons.
        headers.insert(
            header::HeaderName::from_static("stremio-addon-transport"),
            header::HeaderValue::from_static("network/http"),
        );

        Self {
            client: Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
                .default_headers(headers)
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(35))
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Insert a stream result into the TTL cache, evicting expired entries
    /// when the cache grows beyond `STREAM_CACHE_MAX_ENTRIES`.
    fn cache_put(&self, key: &str, streams: &[TorrentioStream]) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= STREAM_CACHE_MAX_ENTRIES {
            let now = Instant::now();
            cache.retain(|_, v| v.expires_at > now);
        }
        cache.insert(
            key.to_string(),
            CachedStreams {
                streams: streams.to_vec(),
                expires_at: Instant::now() + STREAM_CACHE_TTL,
            },
        );
    }

    /// Clear the in-memory cache (e.g. when the user changes their config).
    pub fn clear_cache(&self) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub async fn get_streams(
        &self,
        type_: &str,
        id: &str,
        rd_provider: Option<&RealDebrid>,
        rd_token: Option<&str>,
        addon_url: &str,
    ) -> Result<Vec<TorrentioStream>, String> {
        // id for movies: tt1234567
        // id for series: tt1234567:1:2

        // ── Cache check ──────────────────────────────────────────────────
        // Include a config_url segment so different addons never share entries.
        let cache_key = format!(
            "{}|{}|{}|{}",
            type_,
            id,
            rd_token_cache_segment(rd_token),
            config_cache_segment(addon_url),
        );
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = cache.get(&cache_key) {
                if entry.expires_at > Instant::now() {
                    return Ok(entry.streams.clone());
                }
            }
        }

        let cfg = addon_url.trim();
        if cfg.is_empty() {
            return Ok(vec![]);
        }

        let mut base_url = cfg.to_string();
        if base_url.ends_with("/manifest.json") {
            base_url = base_url.trim_end_matches("/manifest.json").to_string();
        }
        if base_url.ends_with('/') {
            base_url.pop();
        }

        let should_probe_fallbacks = Self::should_probe_root_fallback(&base_url);

        let url = Self::build_stream_endpoint(&base_url, type_, id)?;

        #[cfg(debug_assertions)]
        eprintln!("Addon stream URL: {}", sanitize_addon_log(&url));

        // Derive origin from the base URL so the request looks like it's coming
        // from the same-origin addon context. This satisfies Cloudflare
        // CORS-aware checks without leaking the user's API key in the Referer.
        let origin = Self::build_request_origin(&base_url)?;

        // Max 2 attempts: one fresh request + one retry after a short back-off.
        let mut last_error = String::new();
        for attempt in 0u8..2 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(800)).await;
            }

            let res = match self
                .client
                .get(&url)
                .header(header::ORIGIN, &origin)
                .header(header::REFERER, format!("{}/", &origin))
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    last_error = e.to_string();
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Addon stream request failed (attempt {}): {}",
                        attempt + 1,
                        e
                    );
                    continue;
                }
            };

            if !res.status().is_success() {
                let status = res.status();
                #[cfg(debug_assertions)]
                eprintln!(
                    "Addon stream error {} (attempt {}) for {}",
                    status,
                    attempt + 1,
                    sanitize_addon_log(&url)
                );

                // For path-configured addon URLs, a 403 can still be recoverable via
                // root/public fallback endpoints. Try those before returning.
                if status == reqwest::StatusCode::FORBIDDEN && should_probe_fallbacks {
                    let mut fallback_streams =
                        Self::fetch_fallback_streams(&self.client, &base_url, type_, id).await;
                    if !fallback_streams.is_empty() {
                        Self::hydrate_streams(&mut fallback_streams);
                        Self::dedupe_streams(&mut fallback_streams);
                        let fallback_streams = Self::truncate_streams(fallback_streams);
                        self.cache_put(&cache_key, &fallback_streams);
                        return Ok(fallback_streams);
                    }
                } else if status == reqwest::StatusCode::FORBIDDEN {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Skipping root fallback probes for addon URL without embedded config segments: {}",
                        base_url
                    );
                }

                return Err(format!(
                    "Configured addon returned HTTP {}. Check the addon URL in Settings → Streaming.",
                    status.as_u16()
                ));
            }

            let body: AddonStreamResponse = match res.json::<AddonStreamResponse>().await {
                Ok(b) => b,
                Err(e) => {
                    last_error = e.to_string();
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Addon stream JSON parse error (attempt {}): {}",
                        attempt + 1,
                        e
                    );
                    continue;
                }
            };

            let mut streams = body.streams;
            Self::hydrate_streams(&mut streams);

            // Parse Metadata (Seeders, Size)
            // Some path-configured addons return direct HTTP links without infoHash metadata.
            // For Torrent/P2P mode we still need infoHash-capable entries, so we do a
            // best-effort fallback query against the addon origin root and merge only
            // torrent-capable results.
            if should_probe_fallbacks && !streams.iter().any(|s| s.info_hash.is_some()) {
                let mut fallback_streams =
                    Self::fetch_fallback_streams(&self.client, &base_url, type_, id).await;
                Self::hydrate_streams(&mut fallback_streams);
                Self::merge_torrent_capable_unique(&mut streams, fallback_streams);
            } else if !streams.iter().any(|s| s.info_hash.is_some()) {
                #[cfg(debug_assertions)]
                eprintln!(
                    "Skipping torrent-capable root fallback merge for addon URL without embedded config segments: {}",
                    base_url
                );
            }

            // Only run RD availability when at least one torrent-capable candidate exists.
            let needs_rd_check = streams.iter().any(|stream| {
                stream.info_hash.is_some()
                    || stream
                        .url
                        .as_deref()
                        .is_some_and(|url| url.starts_with("magnet"))
            });

            if needs_rd_check {
                if let (Some(rd), Some(token)) = (rd_provider, rd_token) {
                    let hashes: Vec<String> = streams
                        .iter()
                        .filter(|s| !s.cached)
                        .filter_map(|s| s.info_hash.clone())
                        .collect();

                    if !hashes.is_empty() {
                        for chunk in hashes.chunks(50) {
                            if let Ok(availability) =
                                rd.check_availability(token, chunk.to_vec()).await
                            {
                                for stream in &mut streams {
                                    if let Some(hash) = &stream.info_hash {
                                        if let Some(variants) = availability.items.get(hash) {
                                            if let Some(rd_variants) = variants.get("rd") {
                                                if let Some(arr) = rd_variants.as_array() {
                                                    if !arr.is_empty() {
                                                        stream.cached = true;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Parse requested season/episode from id (`tt...:S:E`).
            let (req_season, req_episode) = {
                let parts: Vec<&str> = id.split(':').collect();
                if parts.len() == 3 {
                    (parts[1].parse::<u32>().ok(), parts[2].parse::<u32>().ok())
                } else {
                    (None, None)
                }
            };

            // Sort priority: cached → requested episode/range match → non-batch → quality → size → seeders.
            streams.sort_by(|a, b| {
                if a.cached != b.cached {
                    return b.cached.cmp(&a.cached);
                }

                if let (Some(s), Some(e)) = (req_season, req_episode) {
                    let match_a = stream_episode_match_kind(a, s, e);
                    let match_b = stream_episode_match_kind(b, s, e);
                    if match_a != match_b {
                        return match_b.cmp(&match_a);
                    }
                }

                let batch_a = stream_contains_batch(a);
                let batch_b = stream_contains_batch(b);
                if batch_a != batch_b {
                    return batch_a.cmp(&batch_b);
                }

                let score_a = stream_quality_score(a);
                let score_b = stream_quality_score(b);
                if score_a != score_b {
                    return score_b.cmp(&score_a);
                }

                let size_a = a.size_bytes.unwrap_or(0);
                let size_b = b.size_bytes.unwrap_or(0);

                // 5. Size penalty: for 4K avoid massive remuxes (>20 GB)
                let base_res_a = score_a - (score_a % 100);
                let size_limit: u64 = if base_res_a >= 400 {
                    20 * 1024 * 1024 * 1024
                } else {
                    15 * 1024 * 1024 * 1024
                };
                if size_a > size_limit && size_b <= size_limit {
                    return std::cmp::Ordering::Greater;
                }
                if size_b > size_limit && size_a <= size_limit {
                    return std::cmp::Ordering::Less;
                }

                // 6. Seeders (P2P tie-break)
                let seeds_a = a.seeders.unwrap_or(0);
                let seeds_b = b.seeders.unwrap_or(0);
                seeds_b.cmp(&seeds_a)
            });

            // If requesting a specific episode and we already have targeted matches,
            // keep a smaller tail of low-confidence generic packs to reduce noise.
            if let (Some(s), Some(e)) = (req_season, req_episode) {
                let has_targeted_match = streams
                    .iter()
                    .any(|stream| stream_episode_match_kind(stream, s, e) != StreamEpisodeMatchKind::None);

                if has_targeted_match {
                    let mut generic_batch_seen = 0u32;
                    streams.retain(|stream| {
                        if stream_contains_batch(stream)
                            && stream_episode_match_kind(stream, s, e)
                                == StreamEpisodeMatchKind::None
                        {
                            generic_batch_seen += 1;
                            return generic_batch_seen <= 2;
                        }

                        true
                    });
                }
            }

            #[cfg(debug_assertions)]
            {
                let batch_count = streams.iter().filter(|s| stream_contains_batch(s)).count();
                eprintln!(
                    "Addon streams: {} total, {} batch/pack, req s={:?} e={:?}",
                    streams.len(),
                    batch_count,
                    req_season,
                    req_episode
                );
            }

            Self::dedupe_streams(&mut streams);
            let streams = Self::truncate_streams(streams);

            // ── Cache store ──────────────────────────────────────────────
            if !streams.is_empty() {
                self.cache_put(&cache_key, &streams);
            }

            return Ok(streams);
        } // end retry loop

        Err(if last_error.is_empty() {
            "Addon stream request failed after retries".to_string()
        } else {
            last_error
        })
    }

    fn truncate_streams(streams: Vec<TorrentioStream>) -> Vec<TorrentioStream> {
        let mut debrid_like: Vec<TorrentioStream> = Vec::new();
        let mut torrent_like: Vec<TorrentioStream> = Vec::new();

        for s in streams {
            let is_torrent_capable =
                s.info_hash.is_some() || s.url.as_deref().is_some_and(|u| u.starts_with("magnet"));
            let is_debrid_like =
                s.cached || s.url.as_deref().is_some_and(|u| u.starts_with("http"));

            if is_debrid_like && debrid_like.len() < DEBRID_STREAMS_MAX {
                debrid_like.push(s.clone());
            }

            if is_torrent_capable && torrent_like.len() < TORRENT_STREAMS_MAX {
                torrent_like.push(s);
            }

            if debrid_like.len() >= DEBRID_STREAMS_MAX && torrent_like.len() >= TORRENT_STREAMS_MAX
            {
                break;
            }
        }

        let mut merged: Vec<TorrentioStream> = debrid_like;
        for t in torrent_like {
            let duplicate = merged
                .iter()
                .any(|existing| Self::matches_stream_identity(existing, &t));
            if !duplicate {
                merged.push(t);
            }
        }

        merged.truncate(TOTAL_STREAMS_MAX);
        merged
    }

    fn hydrate_streams(streams: &mut [TorrentioStream]) {
        for stream in streams {
            Self::hydrate_stream(stream);
        }
    }

    fn hydrate_stream(stream: &mut TorrentioStream) {
        // Try parsing seeders and size from both title and name — different addons
        // (Torrentio, Comet, StremThru) place metadata in different fields.
        let combined = format!(
            "{}\n{}",
            stream.name.as_deref().unwrap_or(""),
            stream.title.as_deref().unwrap_or("")
        );

        if stream.seeders.is_none() {
            if let Some(caps) = SEEDER_REGEX.captures(&combined) {
                if let Ok(s) = caps[1].parse::<u32>() {
                    stream.seeders = Some(s);
                }
            }
        }

        if stream.size_bytes.is_none() {
            if let Some(caps) = SIZE_REGEX.captures(&combined) {
                stream.size_bytes = Self::parse_size_to_bytes(&caps[1], &caps[2]);
            }
            // Fallback: plain-text size like "1.2 GB" without emoji prefix
            if stream.size_bytes.is_none() {
                if let Some(caps) = PLAIN_SIZE_REGEX.captures(&combined) {
                    stream.size_bytes = Self::parse_size_to_bytes(&caps[1], &caps[2]);
                }
            }
        }

        let name_text = stream.name.as_deref().unwrap_or("");
        let title_text = stream.title.as_deref().unwrap_or("");
        let has_lightning = name_text.contains('\u{26A1}') || title_text.contains('\u{26A1}');
        let has_download_arrow = name_text.contains('\u{2B07}') || title_text.contains('\u{2B07}');

        stream.cached = if has_lightning {
            true
        } else if has_download_arrow {
            false
        } else if let Some(u) = &stream.url {
            u.starts_with("http")
        } else {
            false
        };
    }

    fn parse_size_to_bytes(value: &str, unit: &str) -> Option<u64> {
        let parsed = value.parse::<f64>().ok()?;
        let multiplier = match unit.to_uppercase().as_str() {
            "KB" | "KIB" => 1024.0,
            "MB" | "MIB" => 1024.0 * 1024.0,
            "GB" | "GIB" => 1024.0 * 1024.0 * 1024.0,
            "TB" | "TIB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
            _ => 1.0,
        };
        Some((parsed * multiplier) as u64)
    }

    fn merge_torrent_capable_unique(
        streams: &mut Vec<TorrentioStream>,
        fallback_streams: Vec<TorrentioStream>,
    ) {
        for stream in fallback_streams
            .into_iter()
            .filter(|s| s.info_hash.is_some())
        {
            let duplicate = streams
                .iter()
                .any(|existing| Self::matches_torrent_identity(existing, &stream));
            if !duplicate {
                streams.push(stream);
            }
        }
    }

    fn dedupe_streams(streams: &mut Vec<TorrentioStream>) {
        let mut seen = HashSet::new();
        streams.retain(|s| {
            let mut hasher = std::hash::DefaultHasher::new();
            s.info_hash.hash(&mut hasher);
            s.file_idx.hash(&mut hasher);
            s.url.hash(&mut hasher);
            s.name.hash(&mut hasher);
            s.title.hash(&mut hasher);
            seen.insert(hasher.finish())
        });
    }

    async fn fetch_streams_from_endpoint(
        client: &Client,
        url: &str,
        origin: Option<&str>,
    ) -> Vec<TorrentioStream> {
        let mut request = client
            .get(url)
            .timeout(Duration::from_secs(FALLBACK_STREAM_REQUEST_TIMEOUT_SECS));

        if let Some(origin) = origin {
            request = request
                .header(header::ORIGIN, origin)
                .header(header::REFERER, format!("{}/", origin));
        }

        match request.send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<AddonStreamResponse>().await {
                    Ok(body) => body.streams,
                    Err(_) => vec![],
                }
            }
            _ => vec![],
        }
    }

    async fn fetch_fallback_streams(
        client: &Client,
        base_url: &str,
        type_: &str,
        id: &str,
    ) -> Vec<TorrentioStream> {
        let origin_fallback = reqwest::Url::parse(base_url).ok().and_then(|parsed| {
            let host = parsed.host_str()?;
            let mut origin_root = format!("{}://{}", parsed.scheme(), host);
            if let Some(port) = parsed.port() {
                origin_root.push_str(&format!(":{}", port));
            }
            let fallback_url = format!("{}/stream/{}/{}.json", origin_root, type_, id);
            Some((origin_root, fallback_url))
        });

        if let Some((origin_root, fallback_url)) = origin_fallback {
            #[cfg(debug_assertions)]
            eprintln!("Addon root fallback stream URL: {}", fallback_url);
            return Self::fetch_streams_from_endpoint(
                client,
                fallback_url.as_str(),
                Some(origin_root.as_str()),
            )
            .await;
        }

        vec![]
    }
}

#[cfg(debug_assertions)]
fn sanitize_addon_log(value: &str) -> String {
    static TOKEN_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(realdebrid=)[^/\s]+").expect("valid regex"));

    TOKEN_RE.replace_all(value, "$1[redacted]").into_owned()
}

impl Default for AddonTransport {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── episode_matches_text ──────────────────────────────────────────────

    #[test]
    fn matches_standard_s_xxe_yy_format() {
        assert!(episode_matches_text("Show.S01E05.1080p", 1, 5));
    }

    #[test]
    fn matches_zero_padded_s_format() {
        assert!(episode_matches_text("Show.S15E52.BluRay", 15, 52));
    }

    #[test]
    fn matches_unpadded_s_format() {
        assert!(episode_matches_text("show s1e5 hdtv", 1, 5));
    }

    #[test]
    fn matches_x_nn_format() {
        assert!(episode_matches_text("Show.1x05.HDTV", 1, 5));
    }

    #[test]
    fn matches_episode_keyword() {
        assert!(episode_matches_text("Show Episode 12 1080p", 1, 12));
    }

    #[test]
    fn loose_episode_keyword_rejects_conflicting_season_context() {
        assert!(!episode_matches_text("Show Season 2 Episode 1 1080p", 1, 1));
    }

    #[test]
    fn no_match_wrong_episode() {
        assert!(!episode_matches_text("Show.S01E10.1080p", 1, 5));
    }

    #[test]
    fn no_match_wrong_season() {
        assert!(!episode_matches_text("Show.S02E05.1080p", 1, 5));
    }

    #[test]
    fn no_match_empty_title() {
        assert!(!episode_matches_text("", 1, 1));
    }

    // ── BATCH_REGEX ───────────────────────────────────────────────────────

    #[test]
    fn batch_regex_detects_season_pack() {
        assert!(BATCH_REGEX.is_match("Show Complete Season Pack 2024"));
    }

    #[test]
    fn batch_regex_detects_season_range() {
        assert!(BATCH_REGEX.is_match("Naruto S01-S23 Complete 1080p"));
    }

    #[test]
    fn batch_regex_detects_episode_range() {
        assert!(BATCH_REGEX.is_match("One.Piece.E001-E1100.HDTV"));
    }

    #[test]
    fn batch_regex_does_not_false_positive_single_episode() {
        // A single episode title should not trigger the batch regex.
        assert!(!BATCH_REGEX.is_match("Show.S01E05.1080p.BluRay"));
    }

    #[test]
    fn batch_regex_does_not_false_positive_plain_title() {
        assert!(!BATCH_REGEX.is_match("The Dark Knight 2008 1080p BluRay"));
    }

    #[test]
    fn stream_contains_batch_works_for_name_or_title() {
        let stream = TorrentioStream {
            name: Some("Butter".to_string()),
            title: Some("Complete Season Pack".to_string()),
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached: false,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            recommendation_reasons: Vec::new(),
        };
        assert!(stream_contains_batch(&stream));
    }

    #[test]
    fn stream_matches_episode_works_for_name_or_title() {
        let stream = TorrentioStream {
            name: Some("Show.S03E07".to_string()),
            title: Some("Other text".to_string()),
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached: false,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            recommendation_reasons: Vec::new(),
        };
        assert!(stream_matches_episode(&stream, 3, 7));
    }

    #[test]
    fn stream_episode_match_kind_detects_episode_ranges() {
        let stream = TorrentioStream {
            name: Some("One.Piece.E1000-E1010.1080p".to_string()),
            title: None,
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached: false,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            recommendation_reasons: Vec::new(),
        };

        assert_eq!(
            stream_episode_match_kind(&stream, 21, 1004),
            StreamEpisodeMatchKind::EpisodeRange
        );
    }

    #[test]
    fn stream_episode_match_kind_detects_targeted_season_packs() {
        let stream = TorrentioStream {
            name: Some("Show Complete Season 3 Pack 1080p".to_string()),
            title: None,
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached: false,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            recommendation_reasons: Vec::new(),
        };

        assert_eq!(
            stream_episode_match_kind(&stream, 3, 7),
            StreamEpisodeMatchKind::SeasonPack
        );
    }

    // ── truncate_streams ───────────────────────────────────────────────

    fn mk_stream(info_hash: Option<&str>, url: Option<&str>, cached: bool) -> TorrentioStream {
        TorrentioStream {
            name: Some("src".to_string()),
            title: Some("title".to_string()),
            info_hash: info_hash.map(|s| s.to_string()),
            url: url.map(|s| s.to_string()),
            file_idx: None,
            behavior_hints: None,
            cached,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            recommendation_reasons: Vec::new(),
        }
    }

    #[test]
    fn truncate_custom_keeps_torrent_capable_results() {
        let mut input = Vec::new();

        // Dominant debrid/http streams first (as often happens after ranking).
        for _ in 0..30 {
            input.push(mk_stream(None, Some("https://example.com/file.mp4"), true));
        }

        // Torrent-capable streams later in the ranked list.
        for i in 0..10 {
            input.push(mk_stream(
                Some(&format!("hash{}", i)),
                Some("magnet:?xt=urn:btih:abc"),
                false,
            ));
        }

        let out = AddonTransport::truncate_streams(input);
        let torrent_count = out
            .iter()
            .filter(|s| {
                s.info_hash.is_some() || s.url.as_deref().is_some_and(|u| u.starts_with("magnet"))
            })
            .count();

        assert!(
            torrent_count > 0,
            "expected at least one torrent-capable stream in custom-config output"
        );
    }

    #[test]
    fn root_fallback_probe_detects_embedded_config_segments() {
        assert!(AddonTransport::should_probe_root_fallback(
            "https://torrentio.strem.fun/debridoptions=foo/manifest.json"
        ));
        assert!(AddonTransport::should_probe_root_fallback(
            "https://mediafusion.example.com/manifest.json?token=abc"
        ));
    }

    #[test]
    fn root_fallback_probe_rejects_plain_addon_urls() {
        assert!(!AddonTransport::should_probe_root_fallback(
            "https://debridmediamanager.com/api/stremio/token/manifest.json"
        ));
        assert!(!AddonTransport::should_probe_root_fallback(
            "https://mediafusion.elfhosted.com/catalog/series"
        ));
    }
}
