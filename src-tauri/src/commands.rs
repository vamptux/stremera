use crate::downloader::{DownloadItem, DownloadManager};
use crate::providers::{
    cinemeta::Cinemeta,
    kitsu::{Kitsu, KitsuEpisodePage},
    netflix::Netflix,
    realdebrid::{RealDebrid, UserInfo},
    torrentio::{stream_quality_score, Torrentio, TorrentioStream},
    Episode, MediaDetails, MediaItem, Provider,
};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

mod history_helpers;
mod list_helpers;
mod store_helpers;
mod streaming_helpers;
#[cfg(test)]
mod tests;

use history_helpers::{
    choose_watch_history_entry, sanitize_watch_progress, should_skip_watch_progress_save,
};
use list_helpers::{
    list_item_store_key, list_meta_key, load_lists_order, UserList, UserListWithItems,
    LISTS_ORDER_KEY,
};
use store_helpers::{
    library_item_key, load_addon_configs, load_library_map, load_or_migrate_library_index,
    load_or_migrate_watch_status_index, load_watch_statuses_map, merge_library_item,
    normalize_library_item, resolve_addon_configs, save_addon_configs_to_store,
    watch_status_item_key,
};
use streaming_helpers::{
    build_addon_source_priority_map, build_magnet, build_stream_query_ids, find_best_matching_file,
    has_playable_stream_source, infer_stream_mime, is_http_url, is_placeholder_no_stream,
    merge_unique_streams, normalize_http_url, prepare_addon_streams, stream_resolution_priority,
    stream_source_priority,
};

/// Shared HTTP client for following redirect chains on direct stream URLs.
/// Re-used across calls to avoid per-request TLS handshake overhead.
static REDIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

async fn resolve_final_direct_url(direct_url: &str) -> String {
    let client = &*REDIRECT_CLIENT;

    if let Ok(resp) = client.head(direct_url).send().await {
        if resp.status().is_success() || resp.status().is_redirection() {
            return resp.url().to_string();
        }
    }

    if let Ok(resp) = client
        .get(direct_url)
        .header("Range", "bytes=0-0")
        .send()
        .await
    {
        if resp.status().is_success()
            || resp.status().is_redirection()
            || resp.status() == reqwest::StatusCode::PARTIAL_CONTENT
        {
            return resp.url().to_string();
        }
    }

    direct_url.to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchProgress {
    pub id: String,    // imdb_id
    pub type_: String, // "movie" or "series"
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_season: Option<u32>,
    pub absolute_episode: Option<u32>,
    pub stream_season: Option<u32>,
    pub stream_episode: Option<u32>,
    pub aniskip_episode: Option<u32>,
    pub position: f64,     // in seconds
    pub duration: f64,     // in seconds
    pub last_watched: u64, // timestamp
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub last_stream_url: Option<String>,
    pub last_stream_format: Option<String>,
    pub last_stream_lookup_id: Option<String>,
    pub last_stream_key: Option<String>,
}

const HISTORY_INDEX_KEY: &str = "history_index";
const HISTORY_MAP_KEY: &str = "history";
const HISTORY_MIGRATION_V1_COMPLETE_KEY: &str = "history_migration_v1_complete";
const HISTORY_ITEM_PREFIX: &str = "history_item:";
const LIBRARY_INDEX_KEY: &str = "library_index";
const LIBRARY_MAP_KEY: &str = "library";
const LIBRARY_ITEM_PREFIX: &str = "library_item:";
const WATCH_STATUS_INDEX_KEY: &str = "watch_status_index";
const WATCH_STATUS_MAP_KEY: &str = "statuses";
const WATCH_STATUS_ITEM_PREFIX: &str = "watch_status:";
const ADDON_CONFIGS_KEY: &str = "addon_configs";
/// Timeout for the first (highest-ranked) stream candidate. A tighter bound is appropriate
/// because the best candidate is usually a cached/direct URL that resolves quickly; if it
/// doesn't respond within this window, fallbacks are more likely to succeed.
const BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS: u64 = 12;
/// Timeout for second- and third-ranked stream candidates. Fallback streams may need a
/// full RealDebrid resolution cycle, so they get the full window.
const BEST_STREAM_CANDIDATE_TIMEOUT_SECS: u64 = 14;
const RD_TRANSIENT_RETRY_DELAY_MS: u64 = 900;
const BEST_STREAM_MAX_CANDIDATES: usize = 8;
const MAX_SEARCH_QUERY_CHARS: usize = 120;
const ADDON_STREAM_FETCH_TIMEOUT_SECS: u64 = 20;
const ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS: u64 = 8;
const SETTINGS_STORE_FILE: &str = "settings.json";
const HISTORY_STORE_FILE: &str = "history.json";
const LIBRARY_STORE_FILE: &str = "library.json";
const LISTS_STORE_FILE: &str = "lists.json";
const WATCH_STATUS_STORE_FILE: &str = "watch_status.json";

fn normalize_non_empty(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_stream_media_type(media_type: &str) -> Option<String> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie".to_string()),
        "series" => Some("series".to_string()),
        "anime" => Some("anime".to_string()),
        _ => None,
    }
}

fn normalize_torrentio_config(config: &str) -> Result<Option<String>, String> {
    let trimmed = config.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let mut parsed = reqwest::Url::parse(&candidate)
        .map_err(|_| "Invalid Torrentio URL. Please provide a valid http(s) URL.".to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Torrentio URL must start with http:// or https://".to_string());
    }

    if parsed.host_str().is_none() {
        return Err("Torrentio URL must include a valid host.".to_string());
    }

    // Keep query params because some addons encode their config in `?...`.
    parsed.set_fragment(None);

    let normalized_path = {
        let trimmed_path = parsed.path().trim_end_matches('/');
        trimmed_path
            .strip_suffix("/manifest.json")
            .unwrap_or(trimmed_path)
            .to_string()
    };

    if normalized_path.is_empty() {
        parsed.set_path("/");
    } else {
        parsed.set_path(&normalized_path);
    }

    let mut normalized = parsed.to_string();
    if normalized.ends_with('/') {
        normalized.pop();
    }

    Ok(normalize_non_empty(&normalized))
}

fn normalize_query(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.chars().take(MAX_SEARCH_QUERY_CHARS).collect())
}

fn normalize_cinemeta_type(media_type: &str) -> Option<String> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie".to_string()),
        "series" | "anime" => Some("series".to_string()),
        _ => None,
    }
}

fn normalize_cinemeta_catalog(catalog_id: &str) -> Option<String> {
    match catalog_id.trim() {
        "top" | "imdbRating" => Some(catalog_id.trim().to_string()),
        _ => None,
    }
}

fn build_history_key(
    type_lower: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> String {
    if type_lower == "movie" {
        format!("movie:{}", id)
    } else {
        format!(
            "series:{}:{}:{}",
            id,
            season.unwrap_or(0),
            episode.unwrap_or(0)
        )
    }
}

fn history_item_key(key: &str) -> String {
    format!("{}{}", HISTORY_ITEM_PREFIX, key)
}

fn now_unix_millis() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

fn load_or_migrate_history_index<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<Vec<String>, String> {
    let migration_complete = store
        .get(HISTORY_MIGRATION_V1_COMPLETE_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(value) = store.get(HISTORY_INDEX_KEY) {
        if let Ok(index) = serde_json::from_value::<Vec<String>>(value) {
            if !migration_complete {
                store.set(HISTORY_MIGRATION_V1_COMPLETE_KEY, json!(true));
                store.save().map_err(|e| e.to_string())?;
            }
            return Ok(index);
        }
    }

    if migration_complete {
        if store.get(HISTORY_MAP_KEY).is_some() {
            store.delete(HISTORY_MAP_KEY);
        }

        store.set(HISTORY_INDEX_KEY, json!(Vec::<String>::new()));
        store.save().map_err(|e| e.to_string())?;

        return Ok(Vec::new());
    }

    if let Some(value) = store.get(HISTORY_MAP_KEY) {
        let history = serde_json::from_value::<HashMap<String, WatchProgress>>(value)
            .map_err(|e| e.to_string())?;

        // This branch only runs once per installation (old flat map → indexed migration).
        // The debug log confirms it is not running on every launch in production builds.
        #[cfg(debug_assertions)]
        eprintln!(
            "[streamy/debug] load_or_migrate_history_index: migrating {} items from flat \
             HISTORY_MAP_KEY to per-item keys",
            history.len()
        );

        let mut migrated_keys: HashSet<String> = HashSet::with_capacity(history.len());
        for (key, progress) in history {
            let Some(normalized_key) = normalize_non_empty(&key) else {
                continue;
            };

            let Some(progress) = sanitize_watch_progress(progress) else {
                continue;
            };

            store.set(history_item_key(&normalized_key), json!(progress));
            migrated_keys.insert(normalized_key);
        }

        let mut index: Vec<String> = migrated_keys.into_iter().collect();
        index.sort();

        let persisted_count = index
            .iter()
            .filter(|key| store.get(history_item_key(key)).is_some())
            .count();
        if persisted_count != index.len() {
            return Err("Failed to verify migrated watch history index.".to_string());
        }

        store.delete(HISTORY_MAP_KEY);
        store.set(HISTORY_INDEX_KEY, json!(index.clone()));
        store.set(HISTORY_MIGRATION_V1_COMPLETE_KEY, json!(true));
        store.save().map_err(|e| e.to_string())?;
        return Ok(index);
    }

    // Neither a valid indexed structure nor a legacy flat map exists.
    // Persist an explicit empty index to self-heal corrupted/missing state and
    // avoid repeating this fallback path every startup.
    store.set(HISTORY_INDEX_KEY, json!(Vec::<String>::new()));
    if !migration_complete {
        store.set(HISTORY_MIGRATION_V1_COMPLETE_KEY, json!(true));
    }
    store.save().map_err(|e| e.to_string())?;

    Ok(Vec::new())
}

fn load_clean_history_entries<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<Vec<(String, WatchProgress)>, String> {
    let index = load_or_migrate_history_index(store)?;
    let original_index_len = index.len();
    let mut cleaned_index = Vec::with_capacity(original_index_len);
    let mut entries = Vec::with_capacity(original_index_len);

    for key in index {
        let Some(value) = store.get(history_item_key(&key)) else {
            continue;
        };

        let Ok(item) = serde_json::from_value::<WatchProgress>(value) else {
            continue;
        };

        let Some(item) = sanitize_watch_progress(item) else {
            continue;
        };

        cleaned_index.push(key.clone());
        entries.push((key, item));
    }

    if cleaned_index.len() != original_index_len {
        store.set(HISTORY_INDEX_KEY, json!(cleaned_index));
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(entries)
}

fn get_trimmed_store_string<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<String> {
    store
        .get(key)
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
}

fn normalize_debrid_provider(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "realdebrid" => Some("realdebrid"),
        "none" | "" => Some("none"),
        _ => None,
    }
}

fn get_stored_debrid_provider<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<&'static str> {
    get_trimmed_store_string(store, "debrid_provider")
        .as_deref()
        .and_then(normalize_debrid_provider)
}

fn get_effective_rd_token<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<String> {
    let direct_token = get_trimmed_store_string(store, "debrid_api_key");
    let legacy_token = get_trimmed_store_string(store, "rd_access_token");

    match get_stored_debrid_provider(store) {
        Some("realdebrid") => direct_token.or(legacy_token),
        Some("none") => None,
        Some(_) => None,
        None => legacy_token.or(direct_token),
    }
}

fn get_effective_debrid_provider<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> String {
    get_stored_debrid_provider(store)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if get_trimmed_store_string(store, "debrid_api_key").is_some()
                || get_trimmed_store_string(store, "rd_access_token").is_some()
            {
                "realdebrid".to_string()
            } else {
                "none".to_string()
            }
        })
}

fn load_torrentio_config<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<String> {
    get_trimmed_store_string(store, "torrentio_config")
        .and_then(|cfg| normalize_torrentio_config(&cfg).ok().flatten())
}

// ─── Multi-addon config ───────────────────────────────────────────────────────

/// A single Stremio-compatible addon source that the user has configured.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AddonConfig {
    pub id: String,
    pub url: String,
    pub name: String,
    pub enabled: bool,
}

/// Parsed manifest returned by a Stremio addon's `/manifest.json` endpoint.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddonManifest {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
}

async fn fetch_prepared_streams_for_addon(
    provider: &Torrentio,
    rd_provider: &RealDebrid,
    effective_type: &str,
    query_ids: &[String],
    token: Option<&str>,
    addon_url: &str,
    source_name: &str,
) -> Result<Vec<TorrentioStream>, String> {
    let mut last_error: Option<String> = None;

    for (index, query_id) in query_ids.iter().enumerate() {
        let timeout_secs = if index == 0 {
            ADDON_STREAM_FETCH_TIMEOUT_SECS
        } else {
            ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS
        };

        let attempt = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            provider.get_streams(
                effective_type,
                query_id,
                Some(rd_provider),
                token,
                Some(addon_url),
            ),
        )
        .await;

        match attempt {
            Ok(Ok(streams)) => {
                let prepared = prepare_addon_streams(streams, source_name);
                if prepared.is_empty() {
                    continue;
                }

                return Ok(prepared);
            }
            Ok(Err(e)) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "Addon '{}' query {} for '{}' failed: {}",
                    source_name,
                    index + 1,
                    query_id,
                    e
                );
                last_error = Some(e);
                continue;
            }
            Err(_) => {
                let err = format!("{} timed out after {}s", source_name, timeout_secs);
                #[cfg(debug_assertions)]
                eprintln!(
                    "Addon '{}' query {} for '{}' timed out after {}s",
                    source_name,
                    index + 1,
                    query_id,
                    timeout_secs
                );
                last_error = Some(err);
                continue;
            }
        }
    }

    if let Some(err) = last_error {
        return Err(err);
    }

    Ok(vec![])
}

async fn fetch_prepared_streams_for_addon_best_effort(
    provider: &Torrentio,
    rd_provider: &RealDebrid,
    effective_type: &str,
    query_ids: &[String],
    token: Option<&str>,
    addon_url: &str,
    source_name: &str,
) -> Vec<TorrentioStream> {
    match fetch_prepared_streams_for_addon(
        provider,
        rd_provider,
        effective_type,
        query_ids,
        token,
        addon_url,
        source_name,
    )
    .await
    {
        Ok(streams) => streams,
        Err(_err) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "Skipping addon '{}' in resolve_best_stream: {}",
                source_name, _err
            );
            vec![]
        }
    }
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_streams(
    app: AppHandle,
    provider: State<'_, Torrentio>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Result<Vec<TorrentioStream>, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;

    // Torrentio exposes anime streams through the series endpoint.
    let effective_type = if media_type == "anime" {
        "series".to_string()
    } else {
        media_type.clone()
    };

    let query_ids = build_stream_query_ids(&media_type, &id, season, episode, absolute_episode);

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_rd_token(&store);
    let addon_configs = load_addon_configs(&store);
    let enabled_addons: Vec<AddonConfig> =
        addon_configs.into_iter().filter(|a| a.enabled).collect();

    if enabled_addons.is_empty() {
        return Ok(vec![]);
    }

    // Deref State<'_, T> to plain references (&T implements Copy) so the
    // async closures below can capture them without a move conflict.
    let provider = &*provider;
    let rd_provider = &*rd_provider;

    // Fetch streams from all enabled addons concurrently.
    // join_all drives all futures on the current task — no Send requirement.
    let mut futures_vec = Vec::with_capacity(enabled_addons.len());
    for addon in &enabled_addons {
        let qids = query_ids.clone();
        let et = effective_type.clone();
        let tok = token.clone();
        let addon_url = addon.url.clone();
        let source_name = addon.name.clone();
        futures_vec.push(async move {
            fetch_prepared_streams_for_addon(
                provider,
                rd_provider,
                &et,
                &qids,
                tok.as_deref(),
                &addon_url,
                &source_name,
            )
            .await
        });
    }
    let all_addon_streams = join_all(futures_vec).await;

    // Merge results from all addons, preserving per-source ordering.
    // Deduplicate by info_hash+file_idx so the same torrent from multiple sources
    // is only shown once (attributed to the first source that returned it).
    let mut merged: Vec<TorrentioStream> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_err: Option<String> = None;

    for result in all_addon_streams {
        match result {
            Ok(streams) => merge_unique_streams(&mut merged, &mut seen, streams),
            Err(e) => last_err = Some(e),
        }
    }

    if merged.is_empty() {
        if let Some(err) = last_err {
            return Err(err);
        }
    }

    // Re-sort merged streams across sources: cached > quality > size > seeds.
    merged.sort_by(|a, b| {
        if a.cached != b.cached {
            return b.cached.cmp(&a.cached);
        }
        let score_diff = stream_quality_score(b).cmp(&stream_quality_score(a));
        if score_diff != std::cmp::Ordering::Equal {
            return score_diff;
        }
        b.size_bytes.unwrap_or(0).cmp(&a.size_bytes.unwrap_or(0))
    });

    Ok(merged)
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_streams_for_addon(
    app: AppHandle,
    provider: State<'_, Torrentio>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    addon_url: String,
    addon_name: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Result<Vec<TorrentioStream>, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let addon_url = normalize_torrentio_config(&addon_url)?
        .ok_or_else(|| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;

    let source_name = addon_name
        .as_deref()
        .and_then(normalize_non_empty)
        .or_else(|| {
            reqwest::Url::parse(&addon_url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
        })
        .unwrap_or_else(|| "Addon".to_string());

    // Torrentio exposes anime streams through the series endpoint.
    let effective_type = if media_type == "anime" {
        "series".to_string()
    } else {
        media_type.clone()
    };

    let query_ids = build_stream_query_ids(&media_type, &id, season, episode, absolute_episode);

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_rd_token(&store);

    let provider = &*provider;
    let rd_provider = &*rd_provider;

    fetch_prepared_streams_for_addon(
        provider,
        rd_provider,
        &effective_type,
        &query_ids,
        token.as_deref(),
        &addon_url,
        &source_name,
    )
    .await
}

// ─── Debrid Config (multi-provider) ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct DebridConfig {
    pub provider: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
}

#[command]
pub async fn save_debrid_config(
    app: AppHandle,
    torrentio_provider: State<'_, Torrentio>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let provider = normalize_debrid_provider(&provider)
        .ok_or_else(|| "Unsupported debrid provider.".to_string())?;
    let api_key = api_key.trim().to_string();

    store.set("debrid_provider", json!(provider));

    if provider == "none" {
        store.delete("debrid_api_key");
        store.delete("rd_access_token");
    } else {
        if api_key.is_empty() {
            return Err("Real-Debrid API key is required.".to_string());
        }

        store.set("debrid_api_key", json!(api_key.clone()));
        // Backward-compat: keep rd_access_token in sync for RealDebrid.
        store.set("rd_access_token", json!(api_key));
    }

    store.save().map_err(|e| e.to_string())?;

    // Invalidate stream cache since RD availability data is now stale.
    torrentio_provider.clear_cache();

    Ok(())
}

#[command]
pub async fn get_debrid_config(app: AppHandle) -> Result<DebridConfig, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;

    let provider = get_effective_debrid_provider(&store);

    let api_key = if provider == "realdebrid" {
        get_effective_rd_token(&store).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(DebridConfig { provider, api_key })
}

// ─── Torrentio Config ─────────────────────────────────────────────────────────

#[command]
pub async fn save_torrentio_config(
    app: AppHandle,
    provider: State<'_, Torrentio>,
    config: String,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let normalized = normalize_torrentio_config(&config)?;

    if let Some(config) = normalized {
        store.set("torrentio_config", json!(config));
    } else {
        store.delete("torrentio_config");
    }
    store.save().map_err(|e| e.to_string())?;

    // Invalidate server-side stream cache so new config takes effect immediately.
    provider.clear_cache();

    Ok(())
}

#[command]
pub async fn get_torrentio_config(app: AppHandle) -> Result<String, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let config = load_torrentio_config(&store).unwrap_or_default();
    Ok(config)
}

// ─── Multi-addon commands ─────────────────────────────────────────────────────

#[command]
pub async fn get_addon_configs(app: AppHandle) -> Result<Vec<AddonConfig>, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    Ok(load_addon_configs(&store))
}

#[command]
pub async fn save_addon_configs(
    app: AppHandle,
    provider: State<'_, Torrentio>,
    configs: Vec<AddonConfig>,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut normalized: Vec<AddonConfig> = Vec::with_capacity(configs.len());
    for mut config in configs {
        config.id = config.id.trim().to_string();
        config.name = config.name.trim().to_string();
        let url = normalize_torrentio_config(&config.url)?.ok_or_else(|| {
            format!(
                "Invalid URL for addon '{}'. Please provide a valid http(s) URL.",
                config.name
            )
        })?;
        config.url = url;
        normalized.push(config);
    }

    let normalized = resolve_addon_configs(Some(normalized), None);

    save_addon_configs_to_store(&store, &normalized);
    store.save().map_err(|e| e.to_string())?;

    // Invalidate stream cache so new config takes effect immediately.
    provider.clear_cache();

    Ok(())
}

/// Fetches a Stremio addon's `/manifest.json` and returns its name and description.
/// Used by the Settings UI to auto-populate addon name when a user pastes a URL.
#[command]
pub async fn fetch_addon_manifest(url: String) -> Result<AddonManifest, String> {
    let base_url = normalize_torrentio_config(&url)?
        .ok_or_else(|| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;
    let mut parsed = reqwest::Url::parse(&base_url)
        .map_err(|_| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;
    let query = parsed.query().map(|q| q.to_string());
    let trimmed_path = parsed.path().trim_end_matches('/');
    let manifest_path = if trimmed_path.is_empty() || trimmed_path == "/" {
        "/manifest.json".to_string()
    } else if trimmed_path.ends_with("/manifest.json") {
        trimmed_path.to_string()
    } else {
        format!("{}/manifest.json", trimmed_path)
    };
    parsed.set_path(&manifest_path);
    parsed.set_query(query.as_deref());
    let manifest_url = parsed.to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&manifest_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach addon: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Addon returned HTTP {}. Check the URL and try again.",
            resp.status().as_u16()
        ));
    }

    let manifest: AddonManifest = resp
        .json()
        .await
        .map_err(|_| "Invalid addon manifest format.".to_string())?;

    Ok(manifest)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackLanguagePreferences {
    pub preferred_audio_language: Option<String>,
    pub preferred_subtitle_language: Option<String>,
}

fn sanitize_language_pref(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
}

#[command]
pub async fn save_playback_language_preferences(
    app: AppHandle,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let audio = sanitize_language_pref(preferred_audio_language);
    let subtitle = sanitize_language_pref(preferred_subtitle_language);

    if let Some(value) = audio {
        store.set("preferred_audio_language", json!(value));
    } else {
        store.delete("preferred_audio_language");
    }

    if let Some(value) = subtitle {
        store.set("preferred_subtitle_language", json!(value));
    } else {
        store.delete("preferred_subtitle_language");
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn get_playback_language_preferences(
    app: AppHandle,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let preferred_audio_language =
        sanitize_language_pref(get_trimmed_store_string(&store, "preferred_audio_language"));
    let preferred_subtitle_language = sanitize_language_pref(get_trimmed_store_string(
        &store,
        "preferred_subtitle_language",
    ));

    Ok(PlaybackLanguagePreferences {
        preferred_audio_language,
        preferred_subtitle_language,
    })
}

#[derive(Debug, Serialize)]
pub struct ResolvedStream {
    pub url: String,
    pub is_web_friendly: bool,
    pub format: String,
}

#[derive(Debug, Serialize)]
pub struct BestResolvedStream {
    pub url: String,
    pub is_web_friendly: bool,
    pub format: String,
    pub used_fallback: bool,
}

fn is_auth_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("real-debrid auth error")
        || lower.contains("no debrid token")
        || lower.contains("no real-debrid token")
        || lower.contains("401")
        || lower.contains("403")
}

fn is_transient_rd_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection refused")
        || lower.contains("temporary")
        || lower.contains("dns")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("500")
        || lower.contains("429")
}

async fn run_with_transient_retry<T, F, Fut>(
    _operation_name: &str,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match operation().await {
        Ok(value) => Ok(value),
        Err(first_error) => {
            if !is_transient_rd_error(&first_error) {
                return Err(first_error);
            }

            #[cfg(debug_assertions)]
            eprintln!(
                "Transient RD error during {} (retrying once): {}",
                _operation_name, first_error
            );

            tokio::time::sleep(Duration::from_millis(RD_TRANSIENT_RETRY_DELAY_MS)).await;
            operation().await
        }
    }
}

fn is_disabled_rd_availability(message: &str) -> bool {
    message.contains("disabled_endpoint") || message.contains("\"error_code\": 37")
}

fn is_rd_processing_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "queued" | "downloading" | "magnet_conversion" | "waiting_files_selection"
    )
}

fn has_rd_variants(
    availability: &crate::providers::realdebrid::InstantAvailabilityResponse,
    hash: &str,
) -> bool {
    availability
        .items
        .get(hash)
        .and_then(|variants| variants.get("rd"))
        .and_then(|rd_variants| rd_variants.as_array())
        .is_some_and(|arr| !arr.is_empty())
}

struct ResolveStreamParams {
    magnet: String,
    info_hash: Option<String>,
    file_idx: Option<usize>,
    season: Option<u32>,
    episode: Option<u32>,
    url: Option<String>,
}

async fn resolve_stream_inner(
    provider: &RealDebrid,
    token: Option<&str>,
    params: ResolveStreamParams,
) -> Result<ResolvedStream, String> {
    let ResolveStreamParams {
        magnet,
        info_hash,
        file_idx,
        season,
        episode,
        url,
    } = params;

    // Direct URLs from custom configs can skip the RD flow entirely.
    if let Some(direct_url) = url.and_then(|u| normalize_http_url(&u)) {
        let final_url = resolve_final_direct_url(&direct_url).await;

        return Ok(ResolvedStream {
            format: infer_stream_mime(&final_url).to_string(),
            is_web_friendly: true,
            url: final_url,
        });
    }

    let token = token
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("No debrid token configured. Please add your API key in Settings.")?;

    if let Some(hash) = &info_hash {
        #[cfg(debug_assertions)]
        eprintln!("Checking availability for hash: {}", hash);
        let availability_res = run_with_transient_retry("availability check", || async {
            provider
                .check_availability(&token, vec![hash.clone()])
                .await
                .map_err(|e| e.to_string())
        })
        .await;

        match availability_res {
            Ok(availability) => {
                if !has_rd_variants(&availability, hash) {
                    return Err(
                        "Stream not cached on Real-Debrid (Instant availability failed)."
                            .to_string(),
                    );
                }
            }
            Err(e) => {
                if is_disabled_rd_availability(&e) {
                    #[cfg(debug_assertions)]
                    eprintln!("RD availability endpoint disabled/bypassed: {}", e);
                } else if is_auth_error(&e) {
                    return Err(format!("Real-Debrid Auth Error: {}", e));
                } else if is_transient_rd_error(&e) {
                    return Err(
                        "Temporary Real-Debrid availability issue. Please retry in a moment."
                            .to_string(),
                    );
                } else {
                    return Err(format!("Availability Check Error: {}", e));
                }
            }
        }
    }

    let add_res = run_with_transient_retry("add magnet", || async {
        provider
            .add_magnet(&token, &magnet)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        if is_auth_error(&e) {
            format!("Real-Debrid Auth Error during add magnet: {}", e)
        } else if is_transient_rd_error(&e) {
            format!("Temporary Real-Debrid add-magnet failure: {}", e)
        } else {
            format!("Failed to add magnet to Real-Debrid: {}", e)
        }
    })?;
    let torrent_id = add_res.id;
    #[cfg(debug_assertions)]
    eprintln!("Magnet added. Torrent ID: {}", torrent_id);

    let info = run_with_transient_retry("get torrent info", || async {
        provider
            .get_torrent_info(&token, &torrent_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        if is_auth_error(&e) {
            format!("Real-Debrid Auth Error while fetching torrent info: {}", e)
        } else if is_transient_rd_error(&e) {
            "Temporary Real-Debrid error while loading torrent info. Please retry.".to_string()
        } else {
            format!("Failed to get torrent info: {}", e)
        }
    })?;

    let target_file_idx = if let Some(idx) = file_idx {
        if idx < info.files.len() {
            idx
        } else {
            find_best_matching_file(&info.files, season, episode)
        }
    } else {
        find_best_matching_file(&info.files, season, episode)
    };

    if target_file_idx >= info.files.len() {
        return Err("No suitable file found in torrent.".to_string());
    }

    let target_file_id = info.files[target_file_idx].id.to_string();
    #[cfg(debug_assertions)]
    eprintln!(
        "Selected file index: {}, ID: {}",
        target_file_idx, target_file_id
    );

    run_with_transient_retry("select files", || async {
        provider
            .select_files(&token, &torrent_id, &target_file_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        if is_auth_error(&e) {
            format!("Real-Debrid Auth Error during file selection: {}", e)
        } else if is_transient_rd_error(&e) {
            "Temporary Real-Debrid error while selecting files. Please retry.".to_string()
        } else {
            format!("Failed to select files: {}", e)
        }
    })?;

    // RD applies file selection asynchronously; give it a short head start
    // before polling so we avoid immediate queued/downloading churn.
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);
    let mut transient_poll_retry_used = false;
    let mut poll_attempts: u32 = 0;

    let links = loop {
        if start.elapsed() > timeout {
            let info = provider
                .get_torrent_info(&token, &torrent_id)
                .await
                .unwrap_or(info);
            if is_rd_processing_status(&info.status) {
                return Err("Torrent is not cached and is currently downloading on Real-Debrid. Please try again later.".to_string());
            }
            return Err("Timeout waiting for Real-Debrid to process links.".to_string());
        }

        let info = match provider.get_torrent_info(&token, &torrent_id).await {
            Ok(i) => i,
            Err(e) => {
                let e = e.to_string();
                #[cfg(debug_assertions)]
                eprintln!("Error polling torrent info: {}", e);

                if is_auth_error(&e) {
                    return Err(format!(
                        "Real-Debrid Auth Error while polling torrent info: {}",
                        e
                    ));
                }

                if is_transient_rd_error(&e) {
                    if !transient_poll_retry_used {
                        transient_poll_retry_used = true;
                        tokio::time::sleep(Duration::from_millis(RD_TRANSIENT_RETRY_DELAY_MS))
                            .await;
                        continue;
                    }

                    return Err(
                        "Temporary Real-Debrid network/server issue while waiting for links. Please retry."
                            .to_string(),
                    );
                }

                return Err(format!("Failed while waiting for Real-Debrid links: {}", e));
            }
        };

        let status = info.status.trim().to_ascii_lowercase();

        if status == "downloaded" && !info.links.is_empty() {
            break info.links;
        } else if status == "error" || status == "dead" {
            return Err(format!(
                "Torrent failed on Real-Debrid (Status: {})",
                info.status
            ));
        } else if status == "magnet_error" {
            return Err("Real-Debrid could not process this magnet link.".to_string());
        }

        poll_attempts = poll_attempts.saturating_add(1);
        let poll_delay = if poll_attempts <= 3 {
            std::time::Duration::from_millis(500)
        } else {
            std::time::Duration::from_secs(1)
        };
        tokio::time::sleep(poll_delay).await;
    };

    if links.is_empty() {
        return Err("No links returned from Real-Debrid.".to_string());
    }

    #[cfg(debug_assertions)]
    eprintln!("Got {} links. Unrestricting first one...", links.len());

    let target_link = &links[0];

    let unrestrict = provider
        .unrestrict_link(&token, target_link)
        .await
        .map_err(|e| format!("Failed to unrestrict link: {}", e))?;

    let filename_lower = unrestrict.filename.to_lowercase();
    let has_problematic_codec = filename_lower.contains("hevc")
        || filename_lower.contains("x265")
        || filename_lower.contains("h265")
        || filename_lower.contains("10bit")
        || filename_lower.contains("hdr")
        || filename_lower.contains("dv")
        || filename_lower.contains("dolby vision")
        || filename_lower.contains("atmos")
        || filename_lower.contains("dts");

    let is_web_friendly = (unrestrict.mime_type.contains("mp4")
        || unrestrict.mime_type.contains("webm")
        || unrestrict.mime_type.contains("ogg")
        || filename_lower.ends_with(".mp4"))
        && !has_problematic_codec;

    Ok(ResolvedStream {
        url: unrestrict.link,
        is_web_friendly,
        format: unrestrict.mime_type,
    })
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_stream(
    app: AppHandle,
    provider: State<'_, RealDebrid>,
    magnet: String,
    info_hash: Option<String>,
    file_idx: Option<usize>,
    season: Option<u32>,
    episode: Option<u32>,
    url: Option<String>,
) -> Result<ResolvedStream, String> {
    let has_direct_url = url.as_deref().and_then(normalize_http_url).is_some();
    let has_magnet_source = build_magnet(Some(magnet.as_str()), info_hash.as_deref()).is_some();

    if !has_direct_url && !has_magnet_source {
        return Err(
            "No stream source provided. Expected a valid direct URL, magnet, or info hash."
                .to_string(),
        );
    }

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_rd_token(&store);

    resolve_stream_inner(
        &provider,
        token.as_deref(),
        ResolveStreamParams {
            magnet,
            info_hash,
            file_idx,
            season,
            episode,
            url,
        },
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_best_stream(
    app: AppHandle,
    torrentio_provider: State<'_, Torrentio>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Result<BestResolvedStream, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;

    let effective_type = if media_type == "anime" {
        "series".to_string()
    } else {
        media_type.clone()
    };

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_rd_token(&store);
    let addon_configs = load_addon_configs(&store);
    let enabled_addons: Vec<AddonConfig> =
        addon_configs.into_iter().filter(|a| a.enabled).collect();
    let query_ids = build_stream_query_ids(&media_type, &id, season, episode, absolute_episode);

    // Collect streams from all enabled addons concurrently (same logic as get_streams).
    // Deref State<'_, T> to &T (Copy) to avoid move-out-of-FnMut conflicts.
    let torrentio_ref = &*torrentio_provider;
    let rd_ref = &*rd_provider;

    let mut best_futures = Vec::with_capacity(enabled_addons.len());
    for addon in &enabled_addons {
        let qids = query_ids.clone();
        let et = effective_type.clone();
        let tok = token.clone();
        let addon_url = addon.url.clone();
        let source_name = addon.name.clone();
        best_futures.push(async move {
            fetch_prepared_streams_for_addon_best_effort(
                torrentio_ref,
                rd_ref,
                &et,
                &qids,
                tok.as_deref(),
                &addon_url,
                &source_name,
            )
            .await
        });
    }
    let all_addon_streams = join_all(best_futures).await;

    let mut streams: Vec<TorrentioStream> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for addon_streams in all_addon_streams {
        merge_unique_streams(&mut streams, &mut seen, addon_streams);
    }

    streams.retain(|s| !is_placeholder_no_stream(s) && has_playable_stream_source(s));

    if streams.is_empty() {
        return Err("No streams found for this content.".to_string());
    }

    let addon_source_priorities = build_addon_source_priority_map(&enabled_addons);
    streams.sort_by(|a, b| {
        let b_priority =
            stream_resolution_priority(b, stream_source_priority(b, &addon_source_priorities));
        let a_priority =
            stream_resolution_priority(a, stream_source_priority(a, &addon_source_priorities));
        b_priority.cmp(&a_priority)
    });

    let mut errors: Vec<String> = Vec::new();
    let mut candidates = tokio::task::JoinSet::new();
    let mut candidate_count = 0usize;

    for (idx, stream) in streams.iter().take(BEST_STREAM_MAX_CANDIDATES).enumerate() {
        let direct_url = stream
            .url
            .as_deref()
            .filter(|u| is_http_url(u))
            .map(|u| u.to_string());
        let magnet = build_magnet(stream.url.as_deref(), stream.info_hash.as_deref());

        if direct_url.is_none() && magnet.is_none() {
            errors.push(format!("Stream {} missing URL/hash", idx + 1));
            continue;
        }

        let task_provider = rd_provider.inner().clone();
        let task_token = token.clone();
        let params = ResolveStreamParams {
            magnet: magnet.unwrap_or_default(),
            info_hash: stream.info_hash.clone(),
            file_idx: stream.file_idx.map(|f| f as usize),
            season,
            episode,
            url: direct_url,
        };

        // The first (highest-ranked) candidate gets a tighter timeout — it should
        // resolve quickly if it's going to. Fallbacks get the full window.
        let candidate_timeout_secs = if idx == 0 {
            BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS
        } else {
            BEST_STREAM_CANDIDATE_TIMEOUT_SECS
        };
        candidate_count += 1;
        candidates.spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(candidate_timeout_secs),
                resolve_stream_inner(&task_provider, task_token.as_deref(), params),
            )
            .await;
            (idx, result, candidate_timeout_secs)
        });
    }

    if candidate_count == 0 {
        let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
        return Err(format!(
            "Unable to resolve a playable stream from the best candidates. {}",
            summary
        ));
    }

    while let Some(joined) = candidates.join_next().await {
        match joined {
            Ok((idx, Ok(Ok(resolved)), _)) => {
                candidates.abort_all();
                return Ok(BestResolvedStream {
                    url: resolved.url,
                    is_web_friendly: resolved.is_web_friendly,
                    format: resolved.format,
                    used_fallback: idx > 0,
                });
            }
            Ok((idx, Ok(Err(e)), _)) => {
                if is_auth_error(&e) {
                    candidates.abort_all();
                    return Err(e);
                }
                errors.push(format!("Stream {} failed: {}", idx + 1, e));
            }
            Ok((idx, Err(_), timeout_secs)) => {
                errors.push(format!(
                    "Stream {} timed out after {}s",
                    idx + 1,
                    timeout_secs
                ));
            }
            Err(e) => {
                errors.push(format!("Stream candidate task failed: {}", e));
            }
        }
    }

    let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
    Err(format!(
        "Unable to resolve a playable stream from the best candidates. {}",
        summary
    ))
}

#[command]
pub async fn get_app_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;

    // Return all keys/values as a map
    // Note: tauri-plugin-store doesn't have a direct "get_all" in v2 yet easily accessible without iterating known keys
    // For now, we return a constructed object with known public config

    let torrentio_config = load_torrentio_config(&store);
    let rd_auth_method = get_trimmed_store_string(&store, "rd_auth_method");
    let has_rd_token = get_effective_rd_token(&store).is_some();
    let debrid_provider = get_effective_debrid_provider(&store);

    Ok(json!({
        "torrentio_config": torrentio_config,
        "rd_auth_method": rd_auth_method,
        "has_rd_token": has_rd_token,
        "debrid_provider": debrid_provider,
        "preferred_audio_language": store
            .get("preferred_audio_language")
            .and_then(|v| v.as_str().map(|s| s.to_string())),
        "preferred_subtitle_language": store
            .get("preferred_subtitle_language")
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    }))
}

#[command]
pub async fn get_trending_movies(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider.get_trending("movie".to_string(), genre).await
}

#[command]
pub async fn get_trending_series(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider.get_trending("series".to_string(), genre).await
}

#[command]
pub async fn get_trending_anime(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider.get_anime_trending(genre).await
}

#[command]
pub async fn get_cinemeta_catalog(
    provider: State<'_, Cinemeta>,
    media_type: String,
    catalog_id: String,
    genre: Option<String>,
    skip: Option<u32>,
) -> Result<Vec<MediaItem>, String> {
    let media_type = normalize_cinemeta_type(&media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    let catalog_id = normalize_cinemeta_catalog(&catalog_id)
        .ok_or_else(|| "Invalid Cinemeta catalog.".to_string())?;
    let genre = genre.and_then(|g| normalize_non_empty(&g));

    provider
        .get_catalog(&media_type, &catalog_id, genre, skip)
        .await
}

/// Browse-optimised variant that merges both `top` and `imdbRating` catalogs in
/// parallel for maximum content (~70-90 unique items vs ~40-50 from one catalog).
#[command]
pub async fn get_cinemeta_discover(
    provider: State<'_, Cinemeta>,
    media_type: String,
    catalog_id: String,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    let media_type = normalize_cinemeta_type(&media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    let catalog_id = normalize_cinemeta_catalog(&catalog_id)
        .ok_or_else(|| "Invalid Cinemeta catalog.".to_string())?;
    let genre = genre.and_then(|g| normalize_non_empty(&g));

    provider
        .get_discover_catalog(&media_type, &catalog_id, genre)
        .await
}

#[command]
pub async fn search_media(
    provider: State<'_, Cinemeta>,
    query: String,
) -> Result<Vec<MediaItem>, String> {
    let Some(query) = normalize_query(&query) else {
        return Ok(Vec::new());
    };

    provider.search(query).await
}

#[command]
pub async fn get_media_details(
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    id: String,
    include_episodes: Option<bool>,
) -> Result<MediaDetails, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let include_episodes = include_episodes.unwrap_or(true);

    // Route Kitsu IDs to Kitsu provider
    if id.starts_with("kitsu:") {
        return kitsu_provider
            .get_details_with_options(&id, include_episodes)
            .await;
    }

    // Default to Cinemeta for IMDB IDs
    let media_type = normalize_cinemeta_type(&media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    cinemeta_provider.get_details(media_type, id).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEpisodesPage {
    pub episodes: Vec<Episode>,
    pub seasons: Vec<u32>,
    pub season_years: HashMap<u32, String>,
    pub total: usize,
    pub total_in_season: usize,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_media_episodes(
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    id: String,
    season: Option<u32>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<MediaEpisodesPage, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for episodes lookup.".to_string())?;

    if media_type != "anime" && !id.starts_with("kitsu:") {
        return Err(
            "Episode pagination is currently supported for Kitsu anime IDs only.".to_string(),
        );
    }

    let page = page.unwrap_or(0);
    let page_size = page_size.unwrap_or(50);

    let KitsuEpisodePage {
        episodes,
        seasons,
        season_years,
        total,
        total_in_season,
        page,
        page_size,
        has_more,
    } = kitsu_provider
        .get_episodes_page(&id, season, page, page_size)
        .await?;

    Ok(MediaEpisodesPage {
        episodes,
        seasons,
        season_years,
        total,
        total_in_season,
        page,
        page_size,
        has_more,
    })
}

#[command]
pub async fn get_rd_user(
    app: AppHandle,
    provider: State<'_, RealDebrid>,
    token: Option<String>,
) -> Result<UserInfo, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;

    let token = if let Some(t) = token {
        t.trim().to_string()
    } else {
        get_effective_rd_token(&store).ok_or("No token found. Please login.")?
    };

    if token.is_empty() {
        return Err("No token found. Please login.".to_string());
    }

    match provider.get_user_info(&token).await {
        Ok(user) => Ok(user),
        Err(e) => {
            if e.contains("401") || e.contains("403") {
                return Err(
                    "API token is invalid or expired. Please re-enter your API token in Settings."
                        .to_string(),
                );
            }
            Err(e)
        }
    }
}

#[command]
pub async fn rd_verify_token(
    _app: AppHandle,
    provider: State<'_, RealDebrid>,
    token: String,
) -> Result<UserInfo, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token is empty.".to_string());
    }

    // 1. Check if token is valid by getting user info
    let user = provider.get_user_info(&token).await?;

    // 2. We do NOT save to store anymore. Frontend will save to Stronghold.

    Ok(user)
}

#[command]
pub async fn rd_logout(app: AppHandle) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    store.delete("rd_access_token");
    store.delete("rd_refresh_token");
    store.delete("rd_client_id");
    store.delete("rd_client_secret");
    store.delete("rd_auth_method");
    // Clear generic debrid keys too
    store.delete("debrid_provider");
    store.delete("debrid_api_key");
    store.save().map_err(|e| e.to_string())?;

    let history_store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let index = load_or_migrate_history_index(&history_store)?;
    let mut updated = false;

    for key in &index {
        if let Some(value) = history_store.get(history_item_key(key)) {
            if let Ok(mut item) = serde_json::from_value::<WatchProgress>(value) {
                item.last_stream_url = None;
                item.last_stream_format = None;
                item.last_stream_key = None;
                history_store.set(history_item_key(key), json!(item));
                updated = true;
            }
        }
    }

    if updated {
        history_store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[command]
pub async fn save_watch_progress(app: AppHandle, progress: WatchProgress) -> Result<(), String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;

    let mut progress = sanitize_watch_progress(progress)
        .ok_or_else(|| "Invalid media type for watch progress.".to_string())?;
    if progress.id.is_empty() {
        return Err("Media ID is required for watch progress.".to_string());
    }
    if progress.title.is_empty() {
        progress.title = "Untitled".to_string();
    }
    if progress.last_watched == 0 {
        progress.last_watched = now_unix_millis();
    }

    let type_lower = progress.type_.clone();

    let key = build_history_key(&type_lower, &progress.id, progress.season, progress.episode);
    if let Some(existing_value) = store.get(history_item_key(&key)) {
        if let Ok(existing) = serde_json::from_value::<WatchProgress>(existing_value) {
            if should_skip_watch_progress_save(&existing, &progress) {
                return Ok(());
            }
        }
    }

    let mut index = load_or_migrate_history_index(&store)?;

    if !index.iter().any(|k| k == &key) {
        index.push(key.clone());
    }

    store.set(history_item_key(&key), json!(progress));
    store.set(HISTORY_INDEX_KEY, json!(index));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn get_watch_history(app: AppHandle) -> Result<Vec<WatchProgress>, String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let entries = load_clean_history_entries(&store)?;

    // Deduplicate by (type, id), preferring the latest entry while backfilling
    // missing resume metadata from nearby playable rows when necessary.
    let mut grouped: HashMap<(String, String), Vec<WatchProgress>> = HashMap::new();
    for (_, item) in entries {
        let key = (item.type_.clone(), item.id.clone());
        grouped.entry(key).or_default().push(item);
    }

    let mut unique_map: HashMap<(String, String), WatchProgress> = HashMap::new();

    for (key, items) in grouped {
        if let Some(chosen) = choose_watch_history_entry(items) {
            unique_map.insert(key, chosen);
        }
    }

    // Sort by last_watched desc
    let mut list: Vec<WatchProgress> = unique_map.into_values().collect();
    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));

    Ok(list)
}

#[command]
pub async fn get_watch_history_full(app: AppHandle) -> Result<Vec<WatchProgress>, String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let mut list: Vec<WatchProgress> = load_clean_history_entries(&store)?
        .into_iter()
        .map(|(_, item)| item)
        .collect();

    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    Ok(list)
}

#[command]
pub async fn get_watch_history_for_id(
    app: AppHandle,
    id: String,
) -> Result<Vec<WatchProgress>, String> {
    let trimmed_id = id.trim();
    if trimmed_id.is_empty() {
        return Ok(Vec::new());
    }

    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let mut list: Vec<WatchProgress> = load_clean_history_entries(&store)?
        .into_iter()
        .filter_map(|(_, item)| {
            if item.id == trimmed_id {
                Some(item)
            } else {
                None
            }
        })
        .collect();

    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    Ok(list)
}

#[command]
pub async fn get_watch_progress(
    app: AppHandle,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Option<WatchProgress>, String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;

    let type_lower = type_.to_lowercase();
    let key = build_history_key(&type_lower, &id, season, episode);

    load_or_migrate_history_index(&store)?;
    let entry = store
        .get(history_item_key(&key))
        .and_then(|v| serde_json::from_value::<WatchProgress>(v).ok())
        .and_then(sanitize_watch_progress);

    Ok(entry)
}

#[command]
pub async fn remove_from_watch_history(
    app: AppHandle,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<(), String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;

    let type_lower = type_.to_lowercase();
    let key = build_history_key(&type_lower, &id, season, episode);

    let mut index = load_or_migrate_history_index(&store)?;
    let mut removed = false;

    if store.delete(history_item_key(&key)) {
        removed = true;
        index.retain(|k| k != &key);
    }

    if !removed && type_lower == "movie" {
        let fallback_key = format!("series:{}:0:0", id);
        if store.delete(history_item_key(&fallback_key)) {
            removed = true;
            index.retain(|k| k != &fallback_key);
        }
    }

    if removed {
        store.set(HISTORY_INDEX_KEY, json!(index));
        store.save().map_err(|e| e.to_string())?;
    } else {
        return Err(format!(
            "Item not found in history (type={}, id={}, s={:?}, e={:?})",
            type_lower, id, season, episode
        ));
    }

    Ok(())
}

/// Remove **every** history entry that belongs to a given title (all episodes).
///
/// For movies there is always a single entry; for series/anime this deletes all
/// season-×-episode keys so that the show disappears entirely from Continue Watching.
#[command]
pub async fn remove_all_from_watch_history(
    app: AppHandle,
    id: String,
    type_: String,
) -> Result<(), String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;

    let Some(id) = normalize_non_empty(&id) else {
        return Ok(());
    };
    let type_lower = type_.to_lowercase();
    let mut index = load_or_migrate_history_index(&store)?;

    // Prefixes that could belong to this title.
    // Movies: "movie:{id}", Series/Anime: "series:{id}:"
    let prefixes: Vec<String> = if type_lower == "movie" {
        vec![
            format!("movie:{}", id),
            // Legacy fallback key from older writes.
            format!("series:{}:0:0", id),
        ]
    } else {
        vec![format!("series:{}:", id), format!("anime:{}:", id)]
    };

    let mut removed_count = 0usize;
    let keys_to_remove: HashSet<String> = index
        .iter()
        .filter(|k| {
            if type_lower == "movie" {
                prefixes.iter().any(|p| *k == p)
            } else {
                prefixes.iter().any(|p| k.starts_with(p.as_str()))
            }
        })
        .cloned()
        .collect();

    for key in &keys_to_remove {
        if store.delete(history_item_key(key)) {
            removed_count += 1;
        }
    }
    index.retain(|k| !keys_to_remove.contains(k));

    if removed_count > 0 {
        store.set(HISTORY_INDEX_KEY, json!(index));
        store.save().map_err(|e| e.to_string())?;
    }
    // Silently succeed even if nothing matched (idempotent remove).
    Ok(())
}

#[command]
pub async fn add_to_library(app: AppHandle, item: MediaItem) -> Result<(), String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let mut index = load_or_migrate_library_index(&store)?;

    let normalized_item = normalize_library_item(item).ok_or_else(|| {
        "Invalid library item. ID, title, and media type are required.".to_string()
    })?;

    let existing = store
        .get(library_item_key(&normalized_item.id))
        .and_then(|v| serde_json::from_value::<MediaItem>(v).ok())
        .and_then(normalize_library_item);

    let final_item = if let Some(existing) = existing {
        merge_library_item(existing, normalized_item)
    } else {
        normalized_item
    };

    if !index.contains(&final_item.id) {
        index.push(final_item.id.clone());
        index.sort();
    }

    store.set(library_item_key(&final_item.id), json!(final_item));
    store.set(LIBRARY_INDEX_KEY, json!(index));
    store.delete(LIBRARY_MAP_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn remove_from_library(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let Some(id) = normalize_non_empty(&id) else {
        return Ok(());
    };
    let mut index = load_or_migrate_library_index(&store)?;
    let deleted_item = store.delete(library_item_key(&id));
    let original_len = index.len();
    index.retain(|entry| entry != &id);

    if deleted_item || index.len() != original_len {
        store.set(LIBRARY_INDEX_KEY, json!(index));
        store.delete(LIBRARY_MAP_KEY);
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn get_library(app: AppHandle) -> Result<Vec<MediaItem>, String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let cleaned = load_library_map(&store)?;

    let mut items: Vec<MediaItem> = cleaned.into_values().collect();
    items.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(items)
}

#[command]
pub async fn check_library(app: AppHandle, id: String) -> Result<bool, String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let Some(id) = normalize_non_empty(&id) else {
        return Ok(false);
    };
    let _ = load_or_migrate_library_index(&store)?;

    Ok(store.get(library_item_key(&id)).is_some())
}

#[command]
pub async fn get_netflix_catalog(
    provider: State<'_, Netflix>,
    catalog_id: String,
    media_type: String,
    skip: Option<u32>,
) -> Result<Vec<MediaItem>, String> {
    provider.get_catalog(&catalog_id, &media_type, skip).await
}

#[command]
pub async fn get_kitsu_catalog(
    provider: State<'_, Kitsu>,
    catalog_id: String,
    genre: Option<String>,
    skip: Option<u32>,
) -> Result<Vec<MediaItem>, String> {
    let catalog_id =
        normalize_non_empty(&catalog_id).ok_or_else(|| "Catalog ID is required.".to_string())?;
    let genre = genre.and_then(|g| normalize_non_empty(&g));

    provider.get_anime_catalog(&catalog_id, genre, skip).await
}

#[command]
pub async fn search_kitsu(
    provider: State<'_, Kitsu>,
    query: String,
) -> Result<Vec<MediaItem>, String> {
    let Some(query) = normalize_query(&query) else {
        return Ok(Vec::new());
    };

    provider.search_anime(&query).await
}

// ─── Custom Lists ─────────────────────────────────────────────────────────────

pub fn migrate_legacy_app_data_stores(app: &AppHandle) -> Result<(), String> {
    let settings_store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let history_store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let library_store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let lists_store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;
    let watch_status_store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    let mut settings_dirty = false;

    let mut history_dirty = false;
    let history_store_empty = history_store.get(HISTORY_INDEX_KEY).is_none()
        && history_store.get(HISTORY_MAP_KEY).is_none();
    if history_store_empty {
        let history_index_value = settings_store.get(HISTORY_INDEX_KEY);

        if let Some(value) = history_index_value.clone() {
            history_store.set(HISTORY_INDEX_KEY, value);
            history_dirty = true;
            if settings_store.delete(HISTORY_INDEX_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(value) = settings_store.get(HISTORY_MIGRATION_V1_COMPLETE_KEY) {
            history_store.set(HISTORY_MIGRATION_V1_COMPLETE_KEY, value);
            history_dirty = true;
            if settings_store.delete(HISTORY_MIGRATION_V1_COMPLETE_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(value) = settings_store.get(HISTORY_MAP_KEY) {
            history_store.set(HISTORY_MAP_KEY, value);
            history_dirty = true;
            if settings_store.delete(HISTORY_MAP_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(index_value) = history_index_value {
            if let Ok(index) = serde_json::from_value::<Vec<String>>(index_value) {
                for key in index {
                    let item_key = history_item_key(&key);
                    if let Some(item_value) = settings_store.get(item_key.clone()) {
                        history_store.set(item_key.clone(), item_value);
                        history_dirty = true;
                        if settings_store.delete(item_key) {
                            settings_dirty = true;
                        }
                    }
                }
            }
        }
    }

    if history_dirty {
        history_store.save().map_err(|e| e.to_string())?;
    }

    let mut library_dirty = false;
    let library_store_empty = library_store.get(LIBRARY_INDEX_KEY).is_none()
        && library_store.get(LIBRARY_MAP_KEY).is_none();
    if library_store_empty {
        let library_index_value = settings_store.get(LIBRARY_INDEX_KEY);

        if let Some(value) = library_index_value.clone() {
            library_store.set(LIBRARY_INDEX_KEY, value);
            library_dirty = true;
            if settings_store.delete(LIBRARY_INDEX_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(value) = settings_store.get(LIBRARY_MAP_KEY) {
            library_store.set(LIBRARY_MAP_KEY, value);
            library_dirty = true;
            if settings_store.delete(LIBRARY_MAP_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(index_value) = library_index_value {
            if let Ok(index) = serde_json::from_value::<Vec<String>>(index_value) {
                for item_id in index {
                    let item_key = library_item_key(&item_id);
                    if let Some(item_value) = settings_store.get(item_key.clone()) {
                        library_store.set(item_key.clone(), item_value);
                        library_dirty = true;
                        if settings_store.delete(item_key) {
                            settings_dirty = true;
                        }
                    }
                }
            }
        }
    }

    if library_dirty {
        library_store.save().map_err(|e| e.to_string())?;
    }

    let mut watch_status_dirty = false;
    let watch_status_store_empty = watch_status_store.get(WATCH_STATUS_INDEX_KEY).is_none()
        && watch_status_store.get(WATCH_STATUS_MAP_KEY).is_none();
    if watch_status_store_empty {
        let status_index_value = settings_store.get(WATCH_STATUS_INDEX_KEY);

        if let Some(value) = status_index_value.clone() {
            watch_status_store.set(WATCH_STATUS_INDEX_KEY, value);
            watch_status_dirty = true;
            if settings_store.delete(WATCH_STATUS_INDEX_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(value) = settings_store.get(WATCH_STATUS_MAP_KEY) {
            watch_status_store.set(WATCH_STATUS_MAP_KEY, value);
            watch_status_dirty = true;
            if settings_store.delete(WATCH_STATUS_MAP_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(index_value) = status_index_value {
            if let Ok(index) = serde_json::from_value::<Vec<String>>(index_value) {
                for item_id in index {
                    let item_key = watch_status_item_key(&item_id);
                    if let Some(item_value) = settings_store.get(item_key.clone()) {
                        watch_status_store.set(item_key.clone(), item_value);
                        watch_status_dirty = true;
                        if settings_store.delete(item_key) {
                            settings_dirty = true;
                        }
                    }
                }
            }
        }
    }

    if watch_status_dirty {
        watch_status_store.save().map_err(|e| e.to_string())?;
    }

    let mut lists_dirty = false;
    let lists_store_empty = lists_store.get(LISTS_ORDER_KEY).is_none();
    if lists_store_empty {
        let lists_order_value = settings_store.get(LISTS_ORDER_KEY);

        if let Some(value) = lists_order_value.clone() {
            lists_store.set(LISTS_ORDER_KEY, value);
            lists_dirty = true;
            if settings_store.delete(LISTS_ORDER_KEY) {
                settings_dirty = true;
            }
        }

        if let Some(order_value) = lists_order_value {
            if let Ok(order) = serde_json::from_value::<Vec<String>>(order_value) {
                for list_id in order {
                    let meta_key = list_meta_key(&list_id);
                    if let Some(meta_value) = settings_store.get(meta_key.clone()) {
                        let item_ids = serde_json::from_value::<UserList>(meta_value.clone())
                            .map(|list| list.item_ids)
                            .unwrap_or_default();

                        lists_store.set(meta_key.clone(), meta_value);
                        lists_dirty = true;

                        if settings_store.delete(meta_key) {
                            settings_dirty = true;
                        }

                        for item_id in item_ids {
                            let item_key = list_item_store_key(&list_id, &item_id);
                            if let Some(item_value) = settings_store.get(item_key.clone()) {
                                lists_store.set(item_key.clone(), item_value);
                                lists_dirty = true;
                                if settings_store.delete(item_key) {
                                    settings_dirty = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if lists_dirty {
        lists_store.save().map_err(|e| e.to_string())?;
    }

    if settings_dirty {
        settings_store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[command]
pub async fn create_list(
    app: AppHandle,
    name: String,
    icon: Option<String>,
) -> Result<UserList, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let id = format!("list_{}", uuid::Uuid::new_v4().simple());

    let list = UserList {
        id: id.clone(),
        name: name.trim().to_string(),
        icon: icon.unwrap_or_else(|| "📋".to_string()),
        item_ids: Vec::new(),
    };

    let mut order = load_lists_order(&store);
    order.push(id.clone());

    store.set(list_meta_key(&id), json!(list));
    store.set(LISTS_ORDER_KEY, json!(order));
    store.save().map_err(|e| e.to_string())?;

    Ok(list)
}

#[command]
pub async fn delete_list(app: AppHandle, list_id: String) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    // Remove all items for this list
    if let Some(meta_val) = store.get(list_meta_key(&list_id)) {
        if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
            for item_id in &list.item_ids {
                store.delete(list_item_store_key(&list_id, item_id));
            }
        }
    }

    store.delete(list_meta_key(&list_id));

    let mut order = load_lists_order(&store);
    order.retain(|id| id != &list_id);
    store.set(LISTS_ORDER_KEY, json!(order));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn rename_list(
    app: AppHandle,
    list_id: String,
    name: String,
    icon: Option<String>,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|v| serde_json::from_value::<UserList>(v).ok())
        .ok_or_else(|| "List not found".to_string())?;

    list.name = name.trim().to_string();
    if let Some(ic) = icon {
        list.icon = ic;
    }

    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn add_to_list(app: AppHandle, list_id: String, item: MediaItem) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|v| serde_json::from_value::<UserList>(v).ok())
        .ok_or_else(|| "List not found".to_string())?;

    if !list.item_ids.contains(&item.id) {
        list.item_ids.push(item.id.clone());
        store.set(list_item_store_key(&list_id, &item.id), json!(item));
        store.set(list_meta_key(&list_id), json!(list));
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[command]
pub async fn remove_from_list(
    app: AppHandle,
    list_id: String,
    item_id: String,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|v| serde_json::from_value::<UserList>(v).ok())
        .ok_or_else(|| "List not found".to_string())?;

    list.item_ids.retain(|id| id != &item_id);
    store.delete(list_item_store_key(&list_id, &item_id));
    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn get_lists(app: AppHandle) -> Result<Vec<UserListWithItems>, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let order = load_lists_order(&store);
    let mut result: Vec<UserListWithItems> = Vec::with_capacity(order.len());
    let mut modified = false;

    for list_id in &order {
        if let Some(meta_val) = store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                let mut items: Vec<MediaItem> = Vec::with_capacity(list.item_ids.len());
                let mut cleaned_item_ids: Vec<String> = Vec::with_capacity(list.item_ids.len());

                for item_id in &list.item_ids {
                    let Some(item_val) = store.get(list_item_store_key(list_id, item_id)) else {
                        modified = true;
                        continue;
                    };
                    let Ok(item) = serde_json::from_value::<MediaItem>(item_val) else {
                        modified = true;
                        store.delete(list_item_store_key(list_id, item_id));
                        continue;
                    };

                    cleaned_item_ids.push(item_id.clone());
                    items.push(item);
                }

                if cleaned_item_ids != list.item_ids {
                    modified = true;
                    let repaired = UserList {
                        id: list.id.clone(),
                        name: list.name.clone(),
                        icon: list.icon.clone(),
                        item_ids: cleaned_item_ids.clone(),
                    };
                    store.set(list_meta_key(list_id), json!(repaired));
                }

                result.push(UserListWithItems {
                    id: list.id,
                    name: list.name,
                    icon: list.icon,
                    item_ids: cleaned_item_ids,
                    items,
                });
            }
        }
    }

    if modified {
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(result)
}

#[command]
pub async fn reorder_list_items(
    app: AppHandle,
    list_id: String,
    item_ids: Vec<String>,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|v| serde_json::from_value::<UserList>(v).ok())
        .ok_or_else(|| "List not found".to_string())?;

    // Only keep IDs that actually exist in this list
    list.item_ids = item_ids
        .into_iter()
        .filter(|id| list.item_ids.contains(id))
        .collect();

    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn reorder_lists(app: AppHandle, list_ids: Vec<String>) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let current_order = load_lists_order(&store);
    // Only keep IDs that actually exist
    let new_order: Vec<String> = list_ids
        .into_iter()
        .filter(|id| current_order.contains(id))
        .collect();

    store.set(LISTS_ORDER_KEY, json!(new_order));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn check_item_in_lists(app: AppHandle, item_id: String) -> Result<Vec<String>, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let order = load_lists_order(&store);
    let mut list_ids: Vec<String> = Vec::new();

    for list_id in &order {
        if let Some(meta_val) = store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                if list.item_ids.contains(&item_id) {
                    list_ids.push(list_id.clone());
                }
            }
        }
    }

    Ok(list_ids)
}

// ─── Watch Status ─────────────────────────────────────────────────────────────

/// Valid values: "watching" | "watched" | "plan_to_watch" | "dropped"
#[command]
pub async fn set_watch_status(
    app: AppHandle,
    item_id: String,
    status: Option<String>,
) -> Result<(), String> {
    let store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let Some(item_id) = normalize_non_empty(&item_id) else {
        return Ok(());
    };

    let mut index = load_or_migrate_watch_status_index(&store)?;

    match status.and_then(|s| normalize_non_empty(&s)) {
        Some(s) => {
            store.set(watch_status_item_key(&item_id), json!(s));
            if !index.contains(&item_id) {
                index.push(item_id);
                index.sort();
            }
        }
        None => {
            store.delete(watch_status_item_key(&item_id));
            index.retain(|id| id != &item_id);
        }
    }

    store.set(WATCH_STATUS_INDEX_KEY, json!(index));
    store.delete(WATCH_STATUS_MAP_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn get_watch_status(app: AppHandle, item_id: String) -> Result<Option<String>, String> {
    let store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let Some(item_id) = normalize_non_empty(&item_id) else {
        return Ok(None);
    };
    let _ = load_or_migrate_watch_status_index(&store)?;

    Ok(store
        .get(watch_status_item_key(&item_id))
        .and_then(|v| v.as_str().and_then(normalize_non_empty)))
}

#[command]
pub async fn get_all_watch_statuses(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    load_watch_statuses_map(&store)
}

// ─── Download Commands ────────────────────────────────────────────────────────────

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn start_download(
    manager: State<'_, DownloadManager>,
    title: String,
    url: String,
    file_path: String,
    file_name: String,
    poster: Option<String>,
    media_type: Option<String>,
    bandwidth_limit: Option<u64>,
    media_id: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<String, String> {
    manager
        .start_download(
            title,
            url,
            file_path,
            file_name,
            poster,
            media_type,
            bandwidth_limit,
            media_id,
            season,
            episode,
        )
        .await
}

#[command]
pub async fn pause_download(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    manager.pause_download(id).await
}

#[command]
pub async fn resume_download(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.resume_download(id).await
}

/// Checks whether the on-disk file for a completed download still exists.
///
/// If the file is missing the download item is transitioned to `Error` in the
/// persisted store so the Downloads UI can present a re-download action.
/// Returns `true` when the file is present, `false` when it was missing.
#[command]
pub async fn check_download_file_exists(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<bool, String> {
    manager.check_file_exists(id).await
}

#[command]
pub async fn cancel_download(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.cancel_download(id).await
}

#[command]
pub async fn remove_download(
    manager: State<'_, DownloadManager>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    manager.remove_download(id, delete_file).await
}

#[command]
pub async fn get_downloads(
    manager: State<'_, DownloadManager>,
) -> Result<Vec<DownloadItem>, String> {
    Ok(manager.get_downloads().await)
}

#[command]
pub async fn set_download_bandwidth(
    manager: State<'_, DownloadManager>,
    limit: Option<u64>,
) -> Result<(), String> {
    manager.set_bandwidth_limit(limit).await;
    Ok(())
}

#[command]
pub fn get_default_download_path(app: AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .download_dir()
        .map(|p| p.join("Streamy"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string())
}

// ─── Skip Times ──────────────────────────────────────────────────────────────

/// Fetch skippable segment data for an episode.
///
/// - **Anime** (`media_type == "anime"` or `id` starts with `"kitsu:"`): resolves the MAL ID
///   via Kitsu's mappings endpoint and then queries AniSkip v2.
/// - **Series** (`media_type == "series"`): queries IntroDB using the IMDb ID + season + episode.
///
/// Always returns an empty list on errors or when no data is available — callers should treat
/// missing skip times as a normal condition (crowdsourced data may not exist yet).
#[command]
pub async fn get_skip_times(
    skip_provider: State<'_, crate::providers::skip_times::SkipTimesProvider>,
    media_type: String,
    id: String,
    imdb_id: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    duration: Option<f64>,
) -> Result<Vec<crate::providers::skip_times::SkipSegment>, String> {
    let ep = episode.unwrap_or(1);
    let duration_val = duration.unwrap_or(0.0);

    let is_anime = media_type == "anime" || id.starts_with("kitsu:");

    if is_anime {
        // Strip the "kitsu:" prefix to get the numeric Kitsu ID.
        let kitsu_id = id.strip_prefix("kitsu:").unwrap_or(&id);
        let mal_id = skip_provider.resolve_mal_id(kitsu_id).await;
        if let Some(mal_id) = mal_id {
            let segments = skip_provider
                .get_aniskip_segments(mal_id, ep, duration_val)
                .await;
            return Ok(segments);
        }
        return Ok(Vec::new());
    }

    if media_type == "series" {
        let s = season.unwrap_or(1);
        // Prefer the supplied imdb_id; fall back to the raw id if it looks like a tt-identifier.
        let effective_imdb = imdb_id.as_deref().or_else(|| {
            if id.starts_with("tt") {
                Some(id.as_str())
            } else {
                None
            }
        });

        if let Some(iid) = effective_imdb {
            let segments = skip_provider.get_introdb_segments(iid, s, ep).await;
            return Ok(segments);
        }
    }

    Ok(Vec::new())
}

// ─── Data Management ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DataStats {
    pub history_count: usize,
    pub library_count: usize,
    pub lists_count: usize,
    pub watch_statuses_count: usize,
}

/// Returns record counts for each persisted data store — used by the Data Manager UI.
#[command]
pub async fn get_data_stats(app: AppHandle) -> Result<DataStats, String> {
    let history_store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let history_count = load_or_migrate_history_index(&history_store)
        .unwrap_or_default()
        .len();

    let library_store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let library_count = load_library_map(&library_store)?.len();

    let lists_store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;
    let lists_count = load_lists_order(&lists_store).len();

    let status_store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let watch_statuses_count = load_watch_statuses_map(&status_store)?.len();

    Ok(DataStats {
        history_count,
        library_count,
        lists_count,
        watch_statuses_count,
    })
}

/// Wipes all watch history entries and resets the index.
#[command]
pub async fn clear_watch_history(app: AppHandle) -> Result<(), String> {
    let store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;

    let index = load_or_migrate_history_index(&store).unwrap_or_default();
    for key in &index {
        store.delete(history_item_key(key));
    }
    store.set(HISTORY_INDEX_KEY, json!(Vec::<String>::new()));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Wipes all library entries.
#[command]
pub async fn clear_library(app: AppHandle) -> Result<(), String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let index = load_or_migrate_library_index(&store).unwrap_or_default();
    for item_id in &index {
        store.delete(library_item_key(item_id));
    }
    store.delete(LIBRARY_MAP_KEY);
    store.set(LIBRARY_INDEX_KEY, json!(Vec::<String>::new()));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes every custom list and all their items.
#[command]
pub async fn clear_all_lists(app: AppHandle) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let order = load_lists_order(&store);
    for list_id in &order {
        if let Some(meta_val) = store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                for item_id in &list.item_ids {
                    store.delete(list_item_store_key(list_id, item_id));
                }
            }
        }
        store.delete(list_meta_key(list_id));
    }
    store.set(LISTS_ORDER_KEY, json!(Vec::<String>::new()));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears all watch statuses (Watching / Watched / Plan to Watch / Dropped).
#[command]
pub async fn clear_all_watch_statuses(app: AppHandle) -> Result<(), String> {
    let store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let index = load_or_migrate_watch_status_index(&store).unwrap_or_default();
    for item_id in &index {
        store.delete(watch_status_item_key(item_id));
    }
    store.delete(WATCH_STATUS_MAP_KEY);
    store.set(WATCH_STATUS_INDEX_KEY, json!(Vec::<String>::new()));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Data Backup & Restore ────────────────────────────────────────────────────

/// Full data snapshot used for backup export / import.
#[derive(Debug, Serialize, Deserialize)]
pub struct AppDataExport {
    /// Schema version; currently `1`.
    pub version: u32,
    /// Unix timestamp (milliseconds) when the backup was created.
    pub exported_at: u64,
    pub history: Vec<WatchProgress>,
    pub library: Vec<MediaItem>,
    pub lists: Vec<UserListWithItems>,
    pub watch_statuses: HashMap<String, String>,
}

/// Counts of records written during a successful import.
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub history_imported: usize,
    pub library_imported: usize,
    pub lists_imported: usize,
    pub statuses_imported: usize,
}

/// Serialises all persisted user data to a pretty-printed JSON string that the
/// frontend can offer as a file download.
#[command]
pub async fn export_app_data(app: AppHandle) -> Result<String, String> {
    // ― history (all individual entries, undeduped) ——————————————————————
    let history_store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let index = load_or_migrate_history_index(&history_store).unwrap_or_default();
    let mut history: Vec<WatchProgress> = Vec::with_capacity(index.len());
    for key in &index {
        if let Some(val) = history_store.get(history_item_key(key)) {
            if let Ok(item) = serde_json::from_value::<WatchProgress>(val) {
                history.push(item);
            }
        }
    }

    // ― library ——————————————————————————————————————————————————————————
    let lib_store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let library: Vec<MediaItem> = load_library_map(&lib_store)?.into_values().collect();

    // ― custom lists ——————————————————————————————————————————————————————
    let lists_store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;
    let order = load_lists_order(&lists_store);
    let mut lists: Vec<UserListWithItems> = Vec::with_capacity(order.len());
    for list_id in &order {
        if let Some(meta_val) = lists_store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                let mut items: Vec<MediaItem> = Vec::with_capacity(list.item_ids.len());
                for item_id in &list.item_ids {
                    if let Some(item_val) = lists_store.get(list_item_store_key(list_id, item_id)) {
                        if let Ok(item) = serde_json::from_value::<MediaItem>(item_val) {
                            items.push(item);
                        }
                    }
                }
                lists.push(UserListWithItems {
                    id: list.id,
                    name: list.name,
                    icon: list.icon,
                    item_ids: list.item_ids,
                    items,
                });
            }
        }
    }

    // ― watch statuses ————————————————————————————————————————————————————
    let status_store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let watch_statuses = load_watch_statuses_map(&status_store)?;

    let export = AppDataExport {
        version: 1,
        exported_at: now_unix_millis(),
        history,
        library,
        lists,
        watch_statuses,
    };

    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

/// Merges a previously exported JSON backup into the current data stores.
///
/// Merge strategy (non-destructive — existing data is never deleted):
/// - **History**: entries with a newer `last_watched` timestamp overwrite older ones.
/// - **Library**: items absent by ID are added; existing items are kept unchanged.
/// - **Lists**: lists whose ID is not present are appended with a fresh UUID.
/// - **Watch statuses**: statuses for IDs not currently recorded are added.
#[command]
pub async fn import_app_data(app: AppHandle, data: String) -> Result<ImportResult, String> {
    let export: AppDataExport =
        serde_json::from_str(&data).map_err(|e| format!("Invalid backup file: {}", e))?;

    if export.version != 1 {
        return Err(format!(
            "Unsupported backup version: {}. Only version 1 is supported.",
            export.version
        ));
    }

    // ― history ——————————————————————————————————————————————————————————
    let history_store = app.store(HISTORY_STORE_FILE).map_err(|e| e.to_string())?;
    let existing_index = load_or_migrate_history_index(&history_store).unwrap_or_default();
    let mut index_set: HashSet<String> = existing_index.into_iter().collect();
    let mut history_imported = 0usize;

    for item in export.history {
        let Some(sanitized) = sanitize_watch_progress(item) else {
            continue;
        };
        let type_lower = sanitized.type_.clone();
        let key = build_history_key(
            &type_lower,
            &sanitized.id,
            sanitized.season,
            sanitized.episode,
        );
        let item_key = history_item_key(&key);

        let should_write = match history_store
            .get(&item_key)
            .and_then(|v| serde_json::from_value::<WatchProgress>(v).ok())
        {
            Some(existing) => sanitized.last_watched > existing.last_watched,
            None => true,
        };

        if should_write {
            history_store.set(item_key, json!(sanitized));
            index_set.insert(key);
            history_imported += 1;
        }
    }

    let mut merged_index: Vec<String> = index_set.into_iter().collect();
    merged_index.sort();
    history_store.set(HISTORY_INDEX_KEY, json!(merged_index));
    history_store.save().map_err(|e| e.to_string())?;

    // ― library ——————————————————————————————————————————————————————————
    let lib_store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let mut lib_map = load_library_map(&lib_store)?;
    let mut library_imported = 0usize;
    for item in export.library {
        if let Some(normalized) = normalize_library_item(item) {
            if let std::collections::hash_map::Entry::Vacant(entry) =
                lib_map.entry(normalized.id.clone())
            {
                entry.insert(normalized);
                library_imported += 1;
            }
        }
    }

    let existing_library_index = load_or_migrate_library_index(&lib_store).unwrap_or_default();
    let current_library_ids: HashSet<String> = lib_map.keys().cloned().collect();
    for stale_id in &existing_library_index {
        if !current_library_ids.contains(stale_id) {
            lib_store.delete(library_item_key(stale_id));
        }
    }

    let mut new_library_index: Vec<String> = current_library_ids.into_iter().collect();
    new_library_index.sort();
    for item_id in &new_library_index {
        if let Some(item) = lib_map.get(item_id) {
            lib_store.set(library_item_key(item_id), json!(item));
        }
    }
    lib_store.delete(LIBRARY_MAP_KEY);
    lib_store.set(LIBRARY_INDEX_KEY, json!(new_library_index));
    lib_store.save().map_err(|e| e.to_string())?;

    // ― lists ————————————————————————————————————————————————————————————
    let lists_store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;
    let existing_order = load_lists_order(&lists_store);
    let existing_ids: HashSet<String> = existing_order.iter().cloned().collect();
    let mut new_order = existing_order;
    let mut lists_imported = 0usize;

    for list in export.lists {
        if existing_ids.contains(&list.id) {
            continue; // list already present — skip to keep user edits
        }
        let new_id = format!("list_{}", uuid::Uuid::new_v4().simple());
        let new_meta = UserList {
            id: new_id.clone(),
            name: list.name,
            icon: list.icon,
            item_ids: list.item_ids.clone(),
        };
        lists_store.set(list_meta_key(&new_id), json!(new_meta));
        for item in &list.items {
            lists_store.set(list_item_store_key(&new_id, &item.id), json!(item));
        }
        new_order.push(new_id);
        lists_imported += 1;
    }
    lists_store.set(LISTS_ORDER_KEY, json!(new_order));
    lists_store.save().map_err(|e| e.to_string())?;

    // ― watch statuses ————————————————————————————————————————————————————
    let status_store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let mut statuses = load_watch_statuses_map(&status_store)?;
    let mut statuses_imported = 0usize;
    for (id, status) in export.watch_statuses {
        let Some(clean_id) = normalize_non_empty(&id) else {
            continue;
        };
        let Some(clean_status) = normalize_non_empty(&status) else {
            continue;
        };

        if let std::collections::hash_map::Entry::Vacant(entry) = statuses.entry(clean_id) {
            entry.insert(clean_status);
            statuses_imported += 1;
        }
    }

    let existing_status_index =
        load_or_migrate_watch_status_index(&status_store).unwrap_or_default();
    let current_status_ids: HashSet<String> = statuses.keys().cloned().collect();
    for stale_id in &existing_status_index {
        if !current_status_ids.contains(stale_id) {
            status_store.delete(watch_status_item_key(stale_id));
        }
    }

    let mut new_status_index: Vec<String> = current_status_ids.into_iter().collect();
    new_status_index.sort();
    for item_id in &new_status_index {
        if let Some(status) = statuses.get(item_id) {
            status_store.set(watch_status_item_key(item_id), json!(status));
        }
    }
    status_store.delete(WATCH_STATUS_MAP_KEY);
    status_store.set(WATCH_STATUS_INDEX_KEY, json!(new_status_index));
    status_store.save().map_err(|e| e.to_string())?;

    Ok(ImportResult {
        history_imported,
        library_imported,
        lists_imported,
        statuses_imported,
    })
}

/// Exports all app data and writes it to the provided path.
#[command]
pub async fn export_app_data_to_file(app: AppHandle, path: String) -> Result<(), String> {
    let target_path =
        normalize_non_empty(&path).ok_or_else(|| "Export path is required.".to_string())?;
    let payload = export_app_data(app).await?;
    std::fs::write(&target_path, payload).map_err(|e| e.to_string())
}

/// Reads backup JSON from the provided file path and imports it.
#[command]
pub async fn import_app_data_from_file(
    app: AppHandle,
    path: String,
) -> Result<ImportResult, String> {
    let source_path =
        normalize_non_empty(&path).ok_or_else(|| "Import path is required.".to_string())?;
    let data = std::fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
    import_app_data(app, data).await
}

// ─────────────────────────────────────────────────────────────────────────────

/// Opens the folder that contains the given file path in the OS file explorer.
/// - On Windows this calls `explorer /select,<path>` so the file is highlighted.
/// - On macOS / Linux the plugin falls back to revealing the parent directory.
#[command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required.".to_string());
    }

    let input_path = std::path::Path::new(trimmed);
    let folder = if input_path.is_dir() {
        input_path.to_path_buf()
    } else {
        input_path
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| input_path.to_path_buf())
    };

    app.opener()
        .open_path(folder.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
