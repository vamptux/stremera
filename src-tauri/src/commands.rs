use crate::providers::{
    cinemeta::Cinemeta,
    realdebrid::{RealDebrid, UserInfo},
    MediaItem, Provider,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

pub(crate) mod app_update_commands;
pub(crate) mod config_commands;
mod config_store;
pub(crate) mod download_commands;
mod episode_navigation;
mod history_helpers;
pub(crate) mod history_playback_commands;
mod language;
pub(crate) mod library_commands;
pub(crate) mod list_commands;
mod list_helpers;
pub(crate) mod media_commands;
mod media_normalization;
pub(crate) mod next_playback_commands;
pub(crate) mod playback_preferences_commands;
pub(crate) mod playback_state;
pub(crate) mod playback_state_commands;
mod resume_store;
pub(crate) mod search_commands;
pub(crate) mod search_history_commands;
mod startup_migrations;
mod store_helpers;
pub(crate) mod stream_commands;
mod stream_coordinator;
mod stream_fetcher;
mod stream_resolver;
mod streaming_helpers;
#[cfg(test)]
mod tests;
pub(crate) mod watch_history_commands;
pub(crate) mod watch_status_commands;

use config_store::get_effective_rd_token;
use history_helpers::{build_history_key, sanitize_watch_progress};
use list_helpers::{
    list_item_store_key, list_meta_key, load_lists_order, UserList, UserListWithItems,
    LISTS_ORDER_KEY,
};
use media_normalization::normalize_media_items;
use playback_state::PlaybackStateService;
pub(crate) use startup_migrations::run_startup_migrations;
use store_helpers::{
    library_item_key, load_library_map, load_or_migrate_library_index,
    load_or_migrate_watch_status_index, load_watch_statuses_map, normalize_library_item,
    watch_status_item_key,
};
use streaming_helpers::{has_playable_stream_source, is_http_url, is_placeholder_no_stream};

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
    pub source_name: Option<String>,
    pub stream_family: Option<String>,
    pub resume_start_time: Option<f64>,
}

const LIBRARY_INDEX_KEY: &str = "library_index";
const LIBRARY_MAP_KEY: &str = "library";
const LIBRARY_ITEM_PREFIX: &str = "library_item:";
const WATCH_STATUS_INDEX_KEY: &str = "watch_status_index";
const WATCH_STATUS_MAP_KEY: &str = "statuses";
const WATCH_STATUS_ITEM_PREFIX: &str = "watch_status:";
/// Timeout for the first (highest-ranked) stream candidate. Cached/direct URLs should resolve
/// quickly in the happy path, so fail fast here and move on when the best candidate stalls.
const BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS: u64 = 8;
/// Timeout for lower-ranked recovery candidates. These may still require a debrid resolution hop,
/// but keeping the window tighter avoids long failure chains when multiple candidates are bad.
const BEST_STREAM_CANDIDATE_TIMEOUT_SECS: u64 = 10;
const BEST_STREAM_MAX_CANDIDATES: usize = 8;
const MAX_SEARCH_QUERY_CHARS: usize = 120;
const SETTINGS_STORE_FILE: &str = "settings.json";
const LIBRARY_STORE_FILE: &str = "library.json";
const LISTS_STORE_FILE: &str = "lists.json";
const SEARCH_HISTORY_STORE_FILE: &str = "search_history.json";
const WATCH_STATUS_STORE_FILE: &str = "watch_status.json";

pub(crate) struct PendingAppUpdate(pub(crate) Mutex<Option<tauri_plugin_updater::Update>>);

impl Default for PendingAppUpdate {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn normalize_non_empty(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_stream_media_type(media_type: &str, media_id: Option<&str>) -> Option<String> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie".to_string()),
        "anime" => Some("anime".to_string()),
        "series" => Some(
            if media_id
                .map(str::trim)
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("kitsu:"))
            {
                "anime"
            } else {
                "series"
            }
            .to_string(),
        ),
        _ => None,
    }
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

fn now_unix_millis() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackLanguagePreferences {
    pub preferred_audio_language: Option<String>,
    pub preferred_subtitle_language: Option<String>,
}

#[command]
pub async fn get_trending_movies(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider
        .get_trending("movie".to_string(), genre)
        .await
        .map(normalize_media_items)
}

#[command]
pub async fn get_trending_series(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider
        .get_trending("series".to_string(), genre)
        .await
        .map(normalize_media_items)
}

#[command]
pub async fn get_trending_anime(
    provider: State<'_, Cinemeta>,
    genre: Option<String>,
) -> Result<Vec<MediaItem>, String> {
    provider
        .get_anime_trending(genre)
        .await
        .map(normalize_media_items)
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
pub async fn rd_logout(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<(), String> {
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

    playback_state.clear_saved_stream_links(&app)?;

    Ok(())
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
    let duration_hint = duration.filter(|value| value.is_finite() && *value > 0.0);

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
            let segments = skip_provider
                .get_introdb_segments(iid, s, ep, duration_hint)
                .await;
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
pub async fn get_data_stats(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<DataStats, String> {
    let history_count = playback_state.count_resume_entries(&app).unwrap_or_default();

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
pub async fn clear_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<(), String> {
    playback_state.clear(&app)?;
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
pub async fn export_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<String, String> {
    // ― history (all individual entries, undeduped) ——————————————————————
    let history: Vec<WatchProgress> = playback_state
        .load_resume_entries(&app)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, item)| item)
        .collect();

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
pub async fn import_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    data: String,
) -> Result<ImportResult, String> {
    let export: AppDataExport =
        serde_json::from_str(&data).map_err(|e| format!("Invalid backup file: {}", e))?;

    if export.version != 1 {
        return Err(format!(
            "Unsupported backup version: {}. Only version 1 is supported.",
            export.version
        ));
    }

    // ― history ——————————————————————————————————————————————————————————
    let mut history_entries = Vec::with_capacity(export.history.len());
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
        history_entries.push((key, sanitized));
    }
    let history_imported = playback_state.merge_history_entries(&app, history_entries)?;
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
    let payload = export_app_data(app.clone(), app.state::<PlaybackStateService>()).await?;
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
    import_app_data(app.clone(), app.state::<PlaybackStateService>(), data).await
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

    #[cfg(target_os = "windows")]
    {
        let canonical_target = input_path
            .canonicalize()
            .unwrap_or_else(|_| input_path.to_path_buf());

        let explorer_result = if canonical_target.is_file() {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", canonical_target.to_string_lossy()))
                .spawn()
        } else {
            std::process::Command::new("explorer.exe")
                .arg(canonical_target.as_os_str())
                .spawn()
        };

        if explorer_result.is_ok() {
            return Ok(());
        }
    }

    app.opener()
        .open_path(folder.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
