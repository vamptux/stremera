use super::{normalize_non_empty, now_unix_millis, SEARCH_HISTORY_STORE_FILE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

const SEARCH_HISTORY_KEY: &str = "entries";
const MAX_SEARCH_HISTORY_ENTRIES: usize = 10;
const SEARCH_YEAR_MIN: u32 = 1889;
const SEARCH_YEAR_MAX: u32 = 2100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHistoryEntry {
    pub query: String,
    pub media_type: Option<String>,
    pub provider: Option<String>,
    pub feed: Option<String>,
    pub sort: Option<String>,
    pub genres: Option<Vec<String>>,
    pub year_from: Option<u32>,
    pub year_to: Option<u32>,
    pub saved_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHistoryEntryInput {
    pub query: String,
    pub media_type: Option<String>,
    pub provider: Option<String>,
    pub feed: Option<String>,
    pub sort: Option<String>,
    pub genres: Option<Vec<String>>,
    pub year_from: Option<u32>,
    pub year_to: Option<u32>,
    pub saved_at: Option<u64>,
}

fn normalize_query(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalize_non_empty(&normalized)
}

fn normalize_token(value: Option<String>) -> Option<String> {
    value.as_deref().and_then(normalize_non_empty)
}

fn normalize_genres(value: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for genre in value.unwrap_or_default() {
        let Some(genre) = normalize_non_empty(&genre) else {
            continue;
        };

        if seen.insert(genre.to_ascii_lowercase()) {
            normalized.push(genre);
        }
    }

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_year(value: Option<u32>) -> Option<u32> {
    value.filter(|year| (SEARCH_YEAR_MIN..=SEARCH_YEAR_MAX).contains(year))
}

fn normalize_year_range(
    year_from: Option<u32>,
    year_to: Option<u32>,
) -> (Option<u32>, Option<u32>) {
    match (normalize_year(year_from), normalize_year(year_to)) {
        (Some(from), Some(to)) if from > to => (Some(to), Some(from)),
        (normalized_from, normalized_to) => (normalized_from, normalized_to),
    }
}

fn normalize_saved_at(value: Option<u64>, fallback: u64) -> u64 {
    value.filter(|saved_at| *saved_at > 0).unwrap_or(fallback)
}

fn normalize_entry(
    entry: SearchHistoryEntryInput,
    fallback_saved_at: u64,
) -> Option<SearchHistoryEntry> {
    let query = normalize_query(&entry.query)?;
    let (year_from, year_to) = normalize_year_range(entry.year_from, entry.year_to);

    Some(SearchHistoryEntry {
        query,
        media_type: normalize_token(entry.media_type),
        provider: normalize_token(entry.provider),
        feed: normalize_token(entry.feed),
        sort: normalize_token(entry.sort),
        genres: normalize_genres(entry.genres),
        year_from,
        year_to,
        saved_at: normalize_saved_at(entry.saved_at, fallback_saved_at),
    })
}

fn build_search_history_key(entry: &SearchHistoryEntry) -> String {
    let genres = entry
        .genres
        .as_ref()
        .map(|genres| {
            let mut normalized = genres
                .iter()
                .map(|genre| genre.to_ascii_lowercase())
                .collect::<Vec<_>>();
            normalized.sort();
            normalized.join(",")
        })
        .unwrap_or_else(|| "na".to_string());

    [
        entry.query.trim().to_ascii_lowercase(),
        entry
            .media_type
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "na".to_string()),
        entry
            .provider
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "na".to_string()),
        entry
            .feed
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "na".to_string()),
        entry
            .sort
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "na".to_string()),
        genres,
        entry
            .year_from
            .map(|year| year.to_string())
            .unwrap_or_else(|| "na".to_string()),
        entry
            .year_to
            .map(|year| year.to_string())
            .unwrap_or_else(|| "na".to_string()),
    ]
    .join("|")
}

fn canonicalize_entries(mut entries: Vec<SearchHistoryEntry>) -> Vec<SearchHistoryEntry> {
    entries.sort_by(|left, right| right.saved_at.cmp(&left.saved_at));

    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(build_search_history_key(entry)));
    entries.truncate(MAX_SEARCH_HISTORY_ENTRIES);
    entries
}

fn load_entries(app: &AppHandle) -> Result<Vec<SearchHistoryEntry>, String> {
    let store = app
        .store(SEARCH_HISTORY_STORE_FILE)
        .map_err(|error| error.to_string())?;

    Ok(store
        .get(SEARCH_HISTORY_KEY)
        .and_then(|value| serde_json::from_value::<Vec<SearchHistoryEntry>>(value).ok())
        .map(canonicalize_entries)
        .unwrap_or_default())
}

fn save_entries(app: &AppHandle, entries: &[SearchHistoryEntry]) -> Result<(), String> {
    let store = app
        .store(SEARCH_HISTORY_STORE_FILE)
        .map_err(|error| error.to_string())?;
    store.set(SEARCH_HISTORY_KEY, json!(entries));
    store.save().map_err(|error| error.to_string())
}

#[command]
pub async fn get_search_history(app: AppHandle) -> Result<Vec<SearchHistoryEntry>, String> {
    load_entries(&app)
}

#[command]
pub async fn import_search_history_entries(
    app: AppHandle,
    entries: Vec<SearchHistoryEntryInput>,
) -> Result<Vec<SearchHistoryEntry>, String> {
    let normalized = canonicalize_entries(
        entries
            .into_iter()
            .filter_map(|entry| normalize_entry(entry, 0))
            .collect::<Vec<_>>(),
    );
    save_entries(&app, &normalized)?;
    Ok(normalized)
}

#[command]
pub async fn push_search_history_entry(
    app: AppHandle,
    entry: SearchHistoryEntryInput,
) -> Result<Vec<SearchHistoryEntry>, String> {
    let Some(next_entry) = normalize_entry(entry, now_unix_millis()) else {
        return load_entries(&app);
    };

    let mut entries = load_entries(&app)?;
    entries.insert(0, next_entry);
    let entries = canonicalize_entries(entries);
    save_entries(&app, &entries)?;
    Ok(entries)
}

#[command]
pub async fn remove_search_history_entry(
    app: AppHandle,
    entry: SearchHistoryEntryInput,
) -> Result<Vec<SearchHistoryEntry>, String> {
    let Some(normalized_entry) = normalize_entry(entry, 0) else {
        return load_entries(&app);
    };

    let entry_key = build_search_history_key(&normalized_entry);
    let entries = load_entries(&app)?
        .into_iter()
        .filter(|existing| build_search_history_key(existing) != entry_key)
        .collect::<Vec<_>>();
    save_entries(&app, &entries)?;
    Ok(entries)
}

#[command]
pub async fn clear_search_history(app: AppHandle) -> Result<(), String> {
    let entries: Vec<SearchHistoryEntry> = Vec::new();
    save_entries(&app, &entries)
}
