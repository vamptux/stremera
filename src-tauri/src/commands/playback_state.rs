use super::{
    episode_navigation::build_source_episode_coordinates,
    history_helpers::should_skip_watch_progress_save,
    playback_preferences_commands::sanitize_language_pref, resume_store::ResumeStore,
    PlaybackLanguagePreferences, WatchProgress,
};
use crate::providers::Episode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

const PLAYBACK_STATE_STORE_FILE: &str = "playback_state.json";
const PLAYBACK_STREAM_HEALTH_INDEX_KEY: &str = "playback_stream_health_index";
const PLAYBACK_SOURCE_HEALTH_INDEX_KEY: &str = "playback_source_health_index";
const PLAYBACK_STREAM_FAMILY_INDEX_KEY: &str = "playback_stream_family_index";
const PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY: &str = "playback_language_preferences_index";
const PLAYBACK_EPISODE_MAPPING_INDEX_KEY: &str = "playback_episode_mapping_index";
const PLAYBACK_STREAM_HEALTH_ITEM_PREFIX: &str = "playback_stream_health_item:";
const PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX: &str = "playback_source_health_item:";
const PLAYBACK_STREAM_FAMILY_ITEM_PREFIX: &str = "playback_stream_family_item:";
const PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX: &str = "playback_language_preferences_item:";
const PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX: &str = "playback_episode_mapping_item:";
const SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS: u64 = 1000 * 60 * 30;
const SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS: u64 = 1000 * 60 * 60 * 6;
const STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS: u64 = 1000 * 60 * 60 * 18;
const STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS: u64 = 1000 * 60 * 60 * 24 * 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackStreamKind {
    Unknown,
    LocalFile,
    Localhost,
    RemoteDebrid,
    RemoteSigned,
    RemoteManifest,
    RemoteDirect,
}

impl PlaybackStreamKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::LocalFile => "local-file",
            Self::Localhost => "localhost",
            Self::RemoteDebrid => "remote-debrid",
            Self::RemoteSigned => "remote-signed",
            Self::RemoteManifest => "remote-manifest",
            Self::RemoteDirect => "remote-direct",
        }
    }

    fn is_remote(self) -> bool {
        matches!(
            self,
            Self::RemoteDebrid | Self::RemoteSigned | Self::RemoteManifest | Self::RemoteDirect
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaybackStreamOutcomeKind {
    Verified,
    StartupTimeout,
    LoadFailed,
    Disconnected,
}

impl PlaybackStreamOutcomeKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "verified" => Some(Self::Verified),
            "startup-timeout" => Some(Self::StartupTimeout),
            "load-failed" => Some(Self::LoadFailed),
            "disconnected" => Some(Self::Disconnected),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::StartupTimeout => "startup-timeout",
            Self::LoadFailed => "load-failed",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackEpisodeMappingSnapshot {
    pub media_id: String,
    pub media_type: String,
    pub canonical_season: u32,
    pub canonical_episode: u32,
    pub source_lookup_id: String,
    pub source_season: u32,
    pub source_episode: u32,
    pub aniskip_episode: u32,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackStreamHealthSnapshot {
    pub last_stream_url: Option<String>,
    pub last_stream_format: Option<String>,
    pub last_stream_lookup_id: Option<String>,
    pub last_stream_key: Option<String>,
    pub stream_kind: String,
    pub resolved_at: Option<u64>,
    pub last_verified_at: Option<u64>,
    pub last_success_at: Option<u64>,
    pub last_failure_at: Option<u64>,
    pub last_failure_reason: Option<String>,
    pub consecutive_failures: u32,
    pub cooldown_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackSourceHealthSnapshot {
    pub source_name: String,
    pub last_success_at: Option<u64>,
    pub last_failure_at: Option<u64>,
    pub last_failure_reason: Option<String>,
    pub consecutive_failures: u32,
    pub cooldown_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackStreamFamilySnapshot {
    pub media_id: String,
    pub media_type: String,
    pub stream_family: String,
    pub source_name: Option<String>,
    pub last_success_at: Option<u64>,
    pub last_success_season: Option<u32>,
    pub last_success_episode: Option<u32>,
    pub last_failure_at: Option<u64>,
    pub last_failure_season: Option<u32>,
    pub last_failure_episode: Option<u32>,
    pub last_failure_reason: Option<String>,
    pub consecutive_failures: u32,
    pub cooldown_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackLanguagePreferencesSnapshot {
    pub media_id: String,
    pub media_type: String,
    pub preferred_audio_language: Option<String>,
    pub preferred_subtitle_language: Option<String>,
    pub updated_at: u64,
}

#[derive(Default)]
struct PlaybackRuntimeState {
    persisted_history: HashMap<String, WatchProgress>,
}

#[derive(Default)]
pub(crate) struct PlaybackStateService {
    runtime: Mutex<PlaybackRuntimeState>,
    resume_store: Mutex<Option<ResumeStore>>,
}

impl PlaybackStateService {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn with_resume_store<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&mut ResumeStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .resume_store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if guard.is_none() {
            *guard = Some(self.initialize_resume_store(app)?);
        }

        let resume_store = guard
            .as_mut()
            .ok_or_else(|| "Playback resume store failed to initialize.".to_string())?;

        operation(resume_store)
    }

    fn initialize_resume_store(&self, app: &AppHandle) -> Result<ResumeStore, String> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&app_dir)
            .map_err(|error| format!("Failed to create app data directory: {}", error))?;

        ResumeStore::open(&app_dir.join("playback_resume.sqlite3"))
    }

    pub(crate) fn track_progress(
        &self,
        app: &AppHandle,
        key: &str,
        progress: &WatchProgress,
    ) -> Result<(), String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.upsert_progress(key, progress)
        })?;

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        if upsert_stream_health_snapshot(&store, key, progress)? {
            store.save().map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub(crate) fn should_skip_history_write(
        &self,
        key: &str,
        incoming: &WatchProgress,
        persisted_history: Option<&WatchProgress>,
    ) -> bool {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(existing) = runtime.persisted_history.get(key) {
            return should_skip_watch_progress_save(existing, incoming);
        }

        persisted_history
            .map(|existing| should_skip_watch_progress_save(existing, incoming))
            .unwrap_or(false)
    }

    pub(crate) fn mark_history_persisted(&self, key: String, progress: WatchProgress) {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.persisted_history.insert(key, progress);
    }

    pub(crate) fn load_resume_entries(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| resume_store.load_entries())
    }

    pub(crate) fn count_resume_entries(&self, app: &AppHandle) -> Result<usize, String> {
        self.with_resume_store(app, |resume_store| resume_store.count_entries())
    }

    pub(crate) fn load_resume_entries_for_media_id(
        &self,
        app: &AppHandle,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_media_id(media_id)
        })
    }

    pub(crate) fn load_resume_entries_for_title(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_title(media_type, media_id)
        })
    }

    pub(crate) fn merge_history_entries(
        &self,
        app: &AppHandle,
        entries: Vec<(String, WatchProgress)>,
    ) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }

        let imported = self.with_resume_store(app, |resume_store| {
            resume_store.merge_entries(entries.clone())
        })?;

        if imported == 0 {
            return Ok(0);
        }

        for (key, progress) in entries {
            self.mark_history_persisted(key, progress);
        }

        Ok(imported)
    }

    pub(crate) fn get_resume_entry(
        &self,
        app: &AppHandle,
        key: &str,
    ) -> Result<Option<WatchProgress>, String> {
        self.with_resume_store(app, |resume_store| resume_store.get_entry(key))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_stream_outcome(
        &self,
        app: &AppHandle,
        key: &str,
        media_id: &str,
        media_type: &str,
        season: Option<u32>,
        episode: Option<u32>,
        source_name: Option<String>,
        stream_family: Option<String>,
        stream_url: Option<String>,
        stream_format: Option<String>,
        stream_lookup_id: Option<String>,
        stream_key: Option<String>,
        outcome: PlaybackStreamOutcomeKind,
        timestamp_ms: u64,
    ) -> Result<(), String> {
        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let mut health_index = load_index(&store, PLAYBACK_STREAM_HEALTH_INDEX_KEY)?;
        let mut snapshot = load_stream_health_snapshot(&store, key).unwrap_or_else(|| {
            PlaybackStreamHealthSnapshot {
                last_stream_url: None,
                last_stream_format: None,
                last_stream_lookup_id: None,
                last_stream_key: None,
                stream_kind: PlaybackStreamKind::Unknown.as_str().to_string(),
                resolved_at: None,
                last_verified_at: None,
                last_success_at: None,
                last_failure_at: None,
                last_failure_reason: None,
                consecutive_failures: 0,
                cooldown_until: None,
            }
        });

        let normalized_url = stream_url.and_then(|value| normalize_stream_meta(&value));
        let normalized_format = stream_format.and_then(|value| normalize_stream_meta(&value));
        let normalized_lookup_id = stream_lookup_id.and_then(|value| normalize_stream_meta(&value));
        let normalized_stream_key = stream_key.and_then(|value| normalize_stream_meta(&value));
        let stream_changed = normalized_url != snapshot.last_stream_url
            || normalized_lookup_id != snapshot.last_stream_lookup_id
            || normalized_stream_key != snapshot.last_stream_key;

        if stream_changed {
            snapshot.last_verified_at = None;
            snapshot.last_success_at = None;
            snapshot.last_failure_at = None;
            snapshot.last_failure_reason = None;
            snapshot.consecutive_failures = 0;
            snapshot.cooldown_until = None;
        }

        snapshot.last_stream_url = normalized_url.clone();
        snapshot.last_stream_format = normalized_format;
        snapshot.last_stream_lookup_id = normalized_lookup_id;
        snapshot.last_stream_key = normalized_stream_key;
        snapshot.stream_kind = classify_stream_kind(normalized_url.as_deref())
            .as_str()
            .to_string();
        snapshot.resolved_at = Some(timestamp_ms);

        match outcome {
            PlaybackStreamOutcomeKind::Verified => {
                snapshot.last_verified_at = Some(timestamp_ms);
                snapshot.last_success_at = Some(timestamp_ms);
                snapshot.last_failure_at = None;
                snapshot.last_failure_reason = None;
                snapshot.consecutive_failures = 0;
                snapshot.cooldown_until = None;
            }
            _ => {
                snapshot.last_failure_at = Some(timestamp_ms);
                snapshot.last_failure_reason = Some(outcome.as_str().to_string());
                snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
                snapshot.cooldown_until = compute_stream_cooldown_until(
                    classify_stream_kind(snapshot.last_stream_url.as_deref()),
                    outcome,
                    timestamp_ms,
                );
            }
        }

        insert_sorted_unique(&mut health_index, key);

        store.set(playback_stream_health_item_key(key), json!(snapshot));
        store.set(PLAYBACK_STREAM_HEALTH_INDEX_KEY, json!(health_index));

        let normalized_source_name = source_name
            .as_ref()
            .and_then(|value| normalize_source_name(value));

        if let Some(source_name) = normalized_source_name.as_deref() {
            upsert_source_health_snapshot(&store, source_name, outcome, timestamp_ms)?;
        }

        if let Some(scope_key) = playback_stream_family_scope_key(Some(media_type), Some(media_id))
        {
            if let Some(stream_family) =
                stream_family.and_then(|value| normalize_stream_family(&value))
            {
                upsert_stream_family_snapshot(
                    &store,
                    &scope_key,
                    media_id,
                    media_type,
                    season,
                    episode,
                    source_name,
                    &stream_family,
                    outcome,
                    timestamp_ms,
                )?;
            }
        }

        store.save().map_err(|e| e.to_string())?;

        Ok(())
    }

    pub(crate) fn title_source_affinity_priority(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        source_name: Option<&str>,
    ) -> Result<u8, String> {
        let Some(source_name) = source_name.and_then(normalize_source_name) else {
            return Ok(0);
        };
        let Some(scope_key) = playback_stream_family_scope_key(Some(media_type), Some(media_id))
        else {
            return Ok(0);
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let now_ms = current_timestamp_ms();

        if preferred_title_source_from_success(&store, &scope_key, now_ms).as_deref()
            == Some(source_name.as_str())
        {
            return Ok(3);
        }

        Ok(0)
    }

    pub(crate) fn source_health_priority(
        &self,
        app: &AppHandle,
        source_name: Option<&str>,
    ) -> Result<u8, String> {
        let Some(source_name) = source_name.and_then(normalize_source_name) else {
            return Ok(2);
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let snapshot = load_source_health_snapshot(&store, &source_name);
        Ok(score_source_health_priority(
            snapshot.as_ref(),
            current_timestamp_ms(),
        ))
    }

    pub(crate) fn source_health_priorities_for_names<'a>(
        &self,
        app: &AppHandle,
        source_names: impl IntoIterator<Item = &'a str>,
    ) -> Result<HashMap<String, u8>, String> {
        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let now_ms = current_timestamp_ms();
        let mut priorities = HashMap::new();
        let mut seen = HashSet::new();

        for source_name in source_names {
            let Some(source_name) = normalize_source_name(source_name) else {
                continue;
            };
            if !seen.insert(source_name.clone()) {
                continue;
            }

            let snapshot = load_source_health_snapshot(&store, &source_name);
            priorities.insert(
                source_name,
                score_source_health_priority(snapshot.as_ref(), now_ms),
            );
        }

        Ok(priorities)
    }

    pub(crate) fn stream_family_priority(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        season: Option<u32>,
        episode: Option<u32>,
        stream_family: Option<&str>,
    ) -> Result<u8, String> {
        let Some(scope_key) = playback_stream_family_scope_key(Some(media_type), Some(media_id))
        else {
            return Ok(2);
        };
        let Some(stream_family) = stream_family.and_then(normalize_stream_family) else {
            return Ok(2);
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let snapshot_key = playback_stream_family_snapshot_key(&scope_key, &stream_family);
        let snapshot = load_playback_stream_family_snapshot(&store, &snapshot_key);
        Ok(score_stream_family_priority(
            snapshot.as_ref(),
            season,
            episode,
            current_timestamp_ms(),
        ))
    }

    pub(crate) fn get_effective_playback_language_preferences(
        &self,
        app: &AppHandle,
        media_id: Option<&str>,
        media_type: Option<&str>,
        defaults: PlaybackLanguagePreferences,
    ) -> Result<PlaybackLanguagePreferences, String> {
        let Some(scope_key) = playback_language_preferences_scope_key(media_type, media_id) else {
            return Ok(defaults);
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let snapshot = load_playback_language_preferences_snapshot(&store, &scope_key);

        Ok(merge_playback_language_preferences(
            defaults,
            snapshot.as_ref(),
        ))
    }

    pub(crate) fn record_playback_language_preference_outcome(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        preferred_audio_language: Option<String>,
        preferred_subtitle_language: Option<String>,
        timestamp_ms: u64,
    ) -> Result<(), String> {
        let Some(scope_key) =
            playback_language_preferences_scope_key(Some(media_type), Some(media_id))
        else {
            return Ok(());
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let mut preferences_index = load_index(&store, PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY)?;
        let preferred_audio_language = sanitize_playback_language_pref(preferred_audio_language);
        let preferred_subtitle_language =
            sanitize_playback_language_pref(preferred_subtitle_language);

        if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
            store.delete(playback_language_preferences_item_key(&scope_key));
            preferences_index.retain(|entry| entry != &scope_key);
            store.set(
                PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
                json!(preferences_index),
            );
            store.save().map_err(|e| e.to_string())?;
            return Ok(());
        }

        insert_sorted_unique(&mut preferences_index, &scope_key);

        store.set(
            playback_language_preferences_item_key(&scope_key),
            json!(PlaybackLanguagePreferencesSnapshot {
                media_id: media_id.trim().to_string(),
                media_type: canonical_media_type_for_preference_scope(media_type)
                    .unwrap_or("series")
                    .to_string(),
                preferred_audio_language,
                preferred_subtitle_language,
                updated_at: timestamp_ms,
            }),
        );
        store.set(
            PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
            json!(preferences_index),
        );
        store.save().map_err(|e| e.to_string())?;

        Ok(())
    }

    pub(crate) fn cache_episode_mappings(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        fallback_lookup_id: Option<&str>,
        episodes: &[Episode],
    ) -> Result<(), String> {
        if episodes.is_empty() {
            return Ok(());
        }

        let Some(media_type) = canonical_media_type_for_title_scope(media_type) else {
            return Ok(());
        };
        let Some(media_id) = normalize_stream_meta(media_id) else {
            return Ok(());
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let mut episode_mapping_index = load_index(&store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY)?;
        let normalized_fallback_lookup_id = fallback_lookup_id.and_then(normalize_stream_meta);
        let mut changed = false;
        let updated_at = current_timestamp_ms();

        for episode in episodes {
            let snapshot_key = playback_episode_mapping_snapshot_key(
                media_type,
                &media_id,
                episode.season,
                episode.episode,
            );
            let existing_snapshot = load_playback_episode_mapping_snapshot(&store, &snapshot_key);
            let next_snapshot = build_episode_mapping_snapshot(
                media_type,
                &media_id,
                normalized_fallback_lookup_id.as_deref(),
                episode,
                updated_at,
            );

            let needs_write = existing_snapshot
                .as_ref()
                .map(|existing| !episode_mapping_snapshot_matches(existing, &next_snapshot))
                .unwrap_or(true);

            if needs_write {
                store.set(
                    playback_episode_mapping_item_key(&snapshot_key),
                    json!(next_snapshot),
                );
                changed = true;
            }

            if insert_sorted_unique(&mut episode_mapping_index, &snapshot_key) {
                changed = true;
            }
        }

        if changed {
            store.set(
                PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
                json!(episode_mapping_index),
            );
            store.save().map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub(crate) fn get_episode_mapping(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        canonical_season: u32,
        canonical_episode: u32,
    ) -> Result<Option<PlaybackEpisodeMappingSnapshot>, String> {
        let Some(media_type) = canonical_media_type_for_title_scope(media_type) else {
            return Ok(None);
        };
        let Some(media_id) = normalize_stream_meta(media_id) else {
            return Ok(None);
        };

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        Ok(load_playback_episode_mapping_snapshot(
            &store,
            &playback_episode_mapping_snapshot_key(
                media_type,
                &media_id,
                canonical_season,
                canonical_episode,
            ),
        ))
    }

    pub(crate) fn remove_keys(&self, app: &AppHandle, keys: &[String]) -> Result<(), String> {
        if keys.is_empty() {
            return Ok(());
        }

        self.with_resume_store(app, |resume_store| resume_store.remove_keys(keys))?;

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let key_set: HashSet<&String> = keys.iter().collect();
        let mut health_index = load_index(&store, PLAYBACK_STREAM_HEALTH_INDEX_KEY)?;
        let mut source_health_index = load_index(&store, PLAYBACK_SOURCE_HEALTH_INDEX_KEY)?;

        for key in keys {
            store.delete(playback_stream_health_item_key(key));
        }

        health_index.retain(|entry| !key_set.contains(entry));
        prune_stale_source_health_entries(&store, &mut source_health_index);
        store.set(PLAYBACK_STREAM_HEALTH_INDEX_KEY, json!(health_index));
        store.set(PLAYBACK_SOURCE_HEALTH_INDEX_KEY, json!(source_health_index));
        store.save().map_err(|e| e.to_string())?;

        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for key in keys {
            runtime.persisted_history.remove(key);
        }

        Ok(())
    }

    pub(crate) fn clear(&self, app: &AppHandle) -> Result<(), String> {
        self.with_resume_store(app, |resume_store| resume_store.clear())?;

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let stream_health_index = load_index(&store, PLAYBACK_STREAM_HEALTH_INDEX_KEY)?;
        let source_health_index = load_index(&store, PLAYBACK_SOURCE_HEALTH_INDEX_KEY)?;
        let stream_family_index = load_index(&store, PLAYBACK_STREAM_FAMILY_INDEX_KEY)?;
        let episode_mapping_index = load_index(&store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY)?;

        for key in &stream_health_index {
            store.delete(playback_stream_health_item_key(key));
        }
        for key in &source_health_index {
            store.delete(playback_source_health_item_key(key));
        }
        for key in &stream_family_index {
            store.delete(playback_stream_family_item_key(key));
        }
        for key in &episode_mapping_index {
            store.delete(playback_episode_mapping_item_key(key));
        }

        store.set(
            PLAYBACK_STREAM_HEALTH_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_STREAM_FAMILY_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.save().map_err(|e| e.to_string())?;

        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.persisted_history.clear();

        Ok(())
    }

    pub(crate) fn clear_saved_stream_links(&self, app: &AppHandle) -> Result<(), String> {
        self.with_resume_store(app, |resume_store| resume_store.clear_saved_stream_links())?;

        let store = app
            .store(PLAYBACK_STATE_STORE_FILE)
            .map_err(|e| e.to_string())?;
        let stream_health_index = load_index(&store, PLAYBACK_STREAM_HEALTH_INDEX_KEY)?;
        let mut changed = false;

        for key in &stream_health_index {
            let item_key = playback_stream_health_item_key(key);
            let Some(value) = store.get(&item_key) else {
                continue;
            };
            let Ok(mut item) = serde_json::from_value::<PlaybackStreamHealthSnapshot>(value) else {
                continue;
            };

            if item.last_stream_url.is_some()
                || item.last_stream_format.is_some()
                || item.last_stream_key.is_some()
            {
                item.last_stream_url = None;
                item.last_stream_format = None;
                item.last_stream_key = None;
                item.stream_kind = PlaybackStreamKind::Unknown.as_str().to_string();
                store.set(item_key, json!(item));
                changed = true;
            }
        }

        if changed {
            store.save().map_err(|e| e.to_string())?;
        }

        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for item in runtime.persisted_history.values_mut() {
            item.last_stream_url = None;
            item.last_stream_format = None;
            item.last_stream_key = None;
        }

        Ok(())
    }
}

fn build_episode_mapping_snapshot(
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: Option<&str>,
    episode: &Episode,
    updated_at: u64,
) -> PlaybackEpisodeMappingSnapshot {
    let source = build_source_episode_coordinates(episode, fallback_lookup_id.unwrap_or(media_id));

    PlaybackEpisodeMappingSnapshot {
        media_id: media_id.to_string(),
        media_type: media_type.to_string(),
        canonical_season: episode.season,
        canonical_episode: episode.episode,
        source_lookup_id: normalize_stream_meta(&source.lookup_id)
            .unwrap_or_else(|| media_id.to_string()),
        source_season: source.season,
        source_episode: source.episode,
        aniskip_episode: source.aniskip_episode,
        updated_at,
    }
}

fn playback_stream_health_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_STREAM_HEALTH_ITEM_PREFIX, key)
}

fn playback_source_health_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX, key)
}

fn playback_stream_family_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_STREAM_FAMILY_ITEM_PREFIX, key)
}

fn playback_language_preferences_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX, key)
}

fn playback_episode_mapping_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX, key)
}

fn playback_episode_mapping_snapshot_key(
    media_type: &str,
    media_id: &str,
    canonical_season: u32,
    canonical_episode: u32,
) -> String {
    format!(
        "{}:{}:{}:{}",
        media_type, media_id, canonical_season, canonical_episode
    )
}

fn current_timestamp_ms() -> u64 {
    crate::commands::now_unix_millis()
}

fn normalize_stream_meta(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("undefined")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_source_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn normalize_stream_family(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn sanitize_playback_language_pref(value: Option<String>) -> Option<String> {
    sanitize_language_pref(value, true)
}

fn canonical_media_type_for_title_scope(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie"),
        "series" | "anime" => Some("series"),
        _ => None,
    }
}

fn canonical_media_type_for_preference_scope(media_type: &str) -> Option<&'static str> {
    canonical_media_type_for_title_scope(media_type)
}

fn playback_language_preferences_scope_key(
    media_type: Option<&str>,
    media_id: Option<&str>,
) -> Option<String> {
    let media_type = canonical_media_type_for_preference_scope(media_type?)?;
    let media_id = normalize_stream_meta(media_id?)?;

    Some(format!("{}:{}", media_type, media_id))
}

fn playback_stream_family_scope_key(
    media_type: Option<&str>,
    media_id: Option<&str>,
) -> Option<String> {
    let media_type = canonical_media_type_for_title_scope(media_type?)?;
    let media_id = normalize_stream_meta(media_id?)?;

    Some(format!("{}:{}", media_type, media_id))
}

fn playback_stream_family_snapshot_key(scope_key: &str, stream_family: &str) -> String {
    format!("{}|{}", scope_key, stream_family)
}

fn load_playback_language_preferences_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<PlaybackLanguagePreferencesSnapshot> {
    store
        .get(playback_language_preferences_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackLanguagePreferencesSnapshot>(value).ok())
}

fn load_playback_episode_mapping_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<PlaybackEpisodeMappingSnapshot> {
    store
        .get(playback_episode_mapping_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackEpisodeMappingSnapshot>(value).ok())
}

fn episode_mapping_snapshot_matches(
    left: &PlaybackEpisodeMappingSnapshot,
    right: &PlaybackEpisodeMappingSnapshot,
) -> bool {
    left.media_id == right.media_id
        && left.media_type == right.media_type
        && left.canonical_season == right.canonical_season
        && left.canonical_episode == right.canonical_episode
        && left.source_lookup_id == right.source_lookup_id
        && left.source_season == right.source_season
        && left.source_episode == right.source_episode
        && left.aniskip_episode == right.aniskip_episode
}

fn load_playback_stream_family_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<PlaybackStreamFamilySnapshot> {
    store
        .get(playback_stream_family_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackStreamFamilySnapshot>(value).ok())
}

fn playback_snapshot_belongs_to_scope(snapshot_key: &str, scope_key: &str) -> bool {
    snapshot_key
        .strip_prefix(scope_key)
        .is_some_and(|suffix| suffix.starts_with('|'))
}

fn preferred_title_source_from_success<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    scope_key: &str,
    now_ms: u64,
) -> Option<String> {
    let stream_family_index = load_index(store, PLAYBACK_STREAM_FAMILY_INDEX_KEY).ok()?;

    stream_family_index
        .into_iter()
        .filter(|snapshot_key| playback_snapshot_belongs_to_scope(snapshot_key, scope_key))
        .filter_map(|snapshot_key| load_playback_stream_family_snapshot(store, &snapshot_key))
        .filter_map(|snapshot| {
            let source_name = snapshot
                .source_name
                .and_then(|value| normalize_source_name(&value))?;
            let last_success_at = snapshot.last_success_at?;
            Some((source_name, last_success_at))
        })
        .filter(|(_, last_success_at)| {
            now_ms.saturating_sub(*last_success_at) <= STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
        })
        .max_by_key(|(_, last_success_at)| *last_success_at)
        .map(|(source_name, _)| source_name)
}

fn merge_playback_language_preferences(
    defaults: PlaybackLanguagePreferences,
    scoped: Option<&PlaybackLanguagePreferencesSnapshot>,
) -> PlaybackLanguagePreferences {
    let PlaybackLanguagePreferences {
        preferred_audio_language,
        preferred_subtitle_language,
    } = defaults;

    PlaybackLanguagePreferences {
        preferred_audio_language: scoped
            .and_then(|snapshot| snapshot.preferred_audio_language.clone())
            .or(preferred_audio_language),
        preferred_subtitle_language: scoped
            .and_then(|snapshot| snapshot.preferred_subtitle_language.clone())
            .or(preferred_subtitle_language),
    }
}

fn is_localhost_stream_url(stream_url: &str) -> bool {
    let normalized = stream_url.trim().to_ascii_lowercase();
    normalized.starts_with("http://127.0.0.1:")
        || normalized.starts_with("https://127.0.0.1:")
        || normalized.starts_with("http://localhost:")
        || normalized.starts_with("https://localhost:")
        || normalized.starts_with("http://[::1]:")
        || normalized.starts_with("https://[::1]:")
}

fn is_debrid_hostname(hostname: &str) -> bool {
    let normalized = hostname.trim().to_ascii_lowercase();
    [
        "real-debrid.com",
        "realdebrid.com",
        "premiumize.me",
        "alldebrid.com",
        "debrid.link",
        "torbox.app",
    ]
    .iter()
    .any(|candidate| normalized == *candidate || normalized.ends_with(&format!(".{}", candidate)))
}

fn classify_stream_kind(stream_url: Option<&str>) -> PlaybackStreamKind {
    let Some(trimmed) = stream_url.and_then(normalize_stream_meta) else {
        return PlaybackStreamKind::Unknown;
    };

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return PlaybackStreamKind::LocalFile;
    }
    if is_localhost_stream_url(&trimmed) {
        return PlaybackStreamKind::Localhost;
    }

    let Ok(parsed) = reqwest::Url::parse(&trimmed) else {
        return PlaybackStreamKind::RemoteDirect;
    };

    if is_debrid_hostname(parsed.host_str().unwrap_or_default()) {
        return PlaybackStreamKind::RemoteDebrid;
    }

    let pathname = parsed.path().to_ascii_lowercase();
    let search_keys: Vec<String> = parsed
        .query_pairs()
        .map(|(key, _)| key.to_ascii_lowercase())
        .collect();
    let has_signing_hints = search_keys.iter().any(|key| {
        matches!(
            key.as_str(),
            "expires"
                | "exp"
                | "signature"
                | "sig"
                | "token"
                | "auth"
                | "policy"
                | "hdnts"
                | "md5"
                | "x-amz-algorithm"
                | "x-amz-credential"
                | "x-amz-date"
                | "x-amz-expires"
                | "x-amz-signature"
                | "x-goog-algorithm"
                | "x-goog-credential"
                | "x-goog-date"
                | "x-goog-expires"
                | "x-goog-signature"
        )
    });

    if has_signing_hints {
        return PlaybackStreamKind::RemoteSigned;
    }

    if pathname.ends_with(".m3u8")
        || pathname.ends_with(".mpd")
        || pathname.ends_with(".ism/manifest")
        || pathname.contains("/manifest")
    {
        return PlaybackStreamKind::RemoteManifest;
    }

    PlaybackStreamKind::RemoteDirect
}

fn compute_stream_cooldown_until(
    kind: PlaybackStreamKind,
    outcome: PlaybackStreamOutcomeKind,
    timestamp_ms: u64,
) -> Option<u64> {
    if !kind.is_remote() {
        return None;
    }

    let cooldown_ms = match outcome {
        PlaybackStreamOutcomeKind::Verified => 0,
        PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 8,
        PlaybackStreamOutcomeKind::LoadFailed => 1000 * 60 * 10,
        PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 5,
    };

    Some(timestamp_ms.saturating_add(cooldown_ms))
}

fn load_stream_health_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<PlaybackStreamHealthSnapshot> {
    store
        .get(playback_stream_health_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackStreamHealthSnapshot>(value).ok())
}

fn load_source_health_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<PlaybackSourceHealthSnapshot> {
    store
        .get(playback_source_health_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackSourceHealthSnapshot>(value).ok())
}

fn score_source_health_priority(
    snapshot: Option<&PlaybackSourceHealthSnapshot>,
    now_ms: u64,
) -> u8 {
    let Some(snapshot) = snapshot else {
        return 2;
    };

    if snapshot
        .cooldown_until
        .is_some_and(|cooldown_until| cooldown_until > now_ms)
    {
        return 0;
    }

    if snapshot.last_failure_at.is_some_and(|last_failure_at| {
        now_ms.saturating_sub(last_failure_at) <= SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS
            && snapshot.consecutive_failures >= 2
    }) {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        now_ms.saturating_sub(last_success_at) <= SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS
    }) {
        return 3;
    }

    2
}

fn is_nearby_episode(
    target_season: Option<u32>,
    target_episode: Option<u32>,
    candidate_season: Option<u32>,
    candidate_episode: Option<u32>,
) -> bool {
    let Some((target_season, target_episode, candidate_season, candidate_episode)) = target_season
        .zip(target_episode)
        .zip(candidate_season.zip(candidate_episode))
        .map(
            |((left_season, left_episode), (right_season, right_episode))| {
                (left_season, left_episode, right_season, right_episode)
            },
        )
    else {
        return false;
    };

    target_season == candidate_season && target_episode.abs_diff(candidate_episode) <= 2
}

fn score_stream_family_priority(
    snapshot: Option<&PlaybackStreamFamilySnapshot>,
    season: Option<u32>,
    episode: Option<u32>,
    now_ms: u64,
) -> u8 {
    let Some(snapshot) = snapshot else {
        return 2;
    };

    let recent_nearby_failure = snapshot.last_failure_at.is_some_and(|last_failure_at| {
        now_ms.saturating_sub(last_failure_at) <= STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS
            && is_nearby_episode(
                season,
                episode,
                snapshot.last_failure_season,
                snapshot.last_failure_episode,
            )
    });

    if snapshot
        .cooldown_until
        .is_some_and(|cooldown_until| cooldown_until > now_ms)
        && recent_nearby_failure
    {
        return 0;
    }

    if recent_nearby_failure && snapshot.consecutive_failures >= 1 {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        now_ms.saturating_sub(last_success_at) <= STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
            && is_nearby_episode(
                season,
                episode,
                snapshot.last_success_season,
                snapshot.last_success_episode,
            )
    }) {
        return 4;
    }

    2
}

fn upsert_source_health_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    source_name: &str,
    outcome: PlaybackStreamOutcomeKind,
    timestamp_ms: u64,
) -> Result<(), String> {
    let mut source_health_index = load_index(store, PLAYBACK_SOURCE_HEALTH_INDEX_KEY)?;
    let mut snapshot =
        load_source_health_snapshot(store, source_name).unwrap_or(PlaybackSourceHealthSnapshot {
            source_name: source_name.to_string(),
            last_success_at: None,
            last_failure_at: None,
            last_failure_reason: None,
            consecutive_failures: 0,
            cooldown_until: None,
        });

    snapshot.source_name = source_name.to_string();

    match outcome {
        PlaybackStreamOutcomeKind::Verified => {
            snapshot.last_success_at = Some(timestamp_ms);
            snapshot.last_failure_at = None;
            snapshot.last_failure_reason = None;
            snapshot.consecutive_failures = 0;
            snapshot.cooldown_until = None;
        }
        _ => {
            snapshot.last_failure_at = Some(timestamp_ms);
            snapshot.last_failure_reason = Some(outcome.as_str().to_string());
            snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
            snapshot.cooldown_until = Some(timestamp_ms.saturating_add(match outcome {
                PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 12,
                PlaybackStreamOutcomeKind::LoadFailed => 1000 * 60 * 15,
                PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                PlaybackStreamOutcomeKind::Verified => 0,
            }));
        }
    }

    insert_sorted_unique(&mut source_health_index, source_name);

    store.set(
        playback_source_health_item_key(source_name),
        json!(snapshot),
    );
    prune_stale_source_health_entries(store, &mut source_health_index);
    store.set(PLAYBACK_SOURCE_HEALTH_INDEX_KEY, json!(source_health_index));

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_stream_family_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    scope_key: &str,
    media_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
    source_name: Option<String>,
    stream_family: &str,
    outcome: PlaybackStreamOutcomeKind,
    timestamp_ms: u64,
) -> Result<(), String> {
    let mut stream_family_index = load_index(store, PLAYBACK_STREAM_FAMILY_INDEX_KEY)?;
    let snapshot_key = playback_stream_family_snapshot_key(scope_key, stream_family);
    let mut snapshot = load_playback_stream_family_snapshot(store, &snapshot_key).unwrap_or(
        PlaybackStreamFamilySnapshot {
            media_id: media_id.trim().to_string(),
            media_type: canonical_media_type_for_title_scope(media_type)
                .unwrap_or("series")
                .to_string(),
            stream_family: stream_family.to_string(),
            source_name: None,
            last_success_at: None,
            last_success_season: None,
            last_success_episode: None,
            last_failure_at: None,
            last_failure_season: None,
            last_failure_episode: None,
            last_failure_reason: None,
            consecutive_failures: 0,
            cooldown_until: None,
        },
    );

    snapshot.media_id = media_id.trim().to_string();
    snapshot.media_type = canonical_media_type_for_title_scope(media_type)
        .unwrap_or("series")
        .to_string();
    snapshot.stream_family = stream_family.to_string();
    snapshot.source_name = source_name.and_then(|value| normalize_source_name(&value));

    match outcome {
        PlaybackStreamOutcomeKind::Verified => {
            snapshot.last_success_at = Some(timestamp_ms);
            snapshot.last_success_season = season;
            snapshot.last_success_episode = episode;
            snapshot.last_failure_at = None;
            snapshot.last_failure_season = None;
            snapshot.last_failure_episode = None;
            snapshot.last_failure_reason = None;
            snapshot.consecutive_failures = 0;
            snapshot.cooldown_until = None;
        }
        _ => {
            snapshot.last_failure_at = Some(timestamp_ms);
            snapshot.last_failure_season = season;
            snapshot.last_failure_episode = episode;
            snapshot.last_failure_reason = Some(outcome.as_str().to_string());
            snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
            snapshot.cooldown_until = Some(timestamp_ms.saturating_add(match outcome {
                PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 10,
                PlaybackStreamOutcomeKind::LoadFailed => 1000 * 60 * 12,
                PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                PlaybackStreamOutcomeKind::Verified => 0,
            }));
        }
    }

    insert_sorted_unique(&mut stream_family_index, &snapshot_key);

    store.set(
        playback_stream_family_item_key(&snapshot_key),
        json!(snapshot),
    );
    prune_stale_stream_family_entries(store, &mut stream_family_index);
    store.set(PLAYBACK_STREAM_FAMILY_INDEX_KEY, json!(stream_family_index));

    Ok(())
}

fn prune_stale_source_health_entries<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    source_health_index: &mut Vec<String>,
) {
    let now_ms = current_timestamp_ms();
    source_health_index.retain(|key| {
        let Some(snapshot) = load_source_health_snapshot(store, key) else {
            return false;
        };

        let keep = snapshot
            .cooldown_until
            .is_some_and(|cooldown_until| cooldown_until > now_ms)
            || snapshot.last_success_at.is_some_and(|last_success_at| {
                now_ms.saturating_sub(last_success_at) <= SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS
            })
            || snapshot.last_failure_at.is_some_and(|last_failure_at| {
                now_ms.saturating_sub(last_failure_at) <= SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS
            });

        if !keep {
            store.delete(playback_source_health_item_key(key));
        }

        keep
    });
}

fn prune_stale_stream_family_entries<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    stream_family_index: &mut Vec<String>,
) {
    let now_ms = current_timestamp_ms();
    stream_family_index.retain(|key| {
        let Some(snapshot) = load_playback_stream_family_snapshot(store, key) else {
            return false;
        };

        let keep = snapshot
            .cooldown_until
            .is_some_and(|cooldown_until| cooldown_until > now_ms)
            || snapshot.last_success_at.is_some_and(|last_success_at| {
                now_ms.saturating_sub(last_success_at) <= STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
            })
            || snapshot.last_failure_at.is_some_and(|last_failure_at| {
                now_ms.saturating_sub(last_failure_at) <= STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS
            });

        if !keep {
            store.delete(playback_stream_family_item_key(key));
        }

        keep
    });
}

fn upsert_stream_health_snapshot<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
    progress: &WatchProgress,
) -> Result<bool, String> {
    let Some(stream_url) = progress.last_stream_url.as_deref() else {
        return Ok(false);
    };

    let mut health_index = load_index(store, PLAYBACK_STREAM_HEALTH_INDEX_KEY)?;
    let mut snapshot =
        load_stream_health_snapshot(store, key).unwrap_or(PlaybackStreamHealthSnapshot {
            last_stream_url: None,
            last_stream_format: None,
            last_stream_lookup_id: None,
            last_stream_key: None,
            stream_kind: PlaybackStreamKind::Unknown.as_str().to_string(),
            resolved_at: None,
            last_verified_at: None,
            last_success_at: None,
            last_failure_at: None,
            last_failure_reason: None,
            consecutive_failures: 0,
            cooldown_until: None,
        });

    let normalized_url = normalize_stream_meta(stream_url);
    let normalized_format = progress
        .last_stream_format
        .as_deref()
        .and_then(normalize_stream_meta);
    let normalized_lookup_id = progress
        .last_stream_lookup_id
        .as_deref()
        .and_then(normalize_stream_meta);
    let normalized_stream_key = progress
        .last_stream_key
        .as_deref()
        .and_then(normalize_stream_meta);
    let next_stream_kind = classify_stream_kind(normalized_url.as_deref())
        .as_str()
        .to_string();
    let stream_changed = snapshot.last_stream_url != normalized_url
        || snapshot.last_stream_lookup_id != normalized_lookup_id
        || snapshot.last_stream_key != normalized_stream_key;
    let format_changed = snapshot.last_stream_format != normalized_format;
    let stream_kind_changed = snapshot.stream_kind != next_stream_kind;
    let missing_resolved_at = snapshot.resolved_at.is_none();
    let index_changed = insert_sorted_unique(&mut health_index, key);

    if !stream_changed
        && !format_changed
        && !stream_kind_changed
        && !missing_resolved_at
        && !index_changed
    {
        return Ok(false);
    }

    if stream_changed {
        snapshot.last_verified_at = None;
        snapshot.last_success_at = None;
        snapshot.last_failure_at = None;
        snapshot.last_failure_reason = None;
        snapshot.consecutive_failures = 0;
        snapshot.cooldown_until = None;
    }

    snapshot.last_stream_url = normalized_url.clone();
    snapshot.last_stream_format = normalized_format;
    snapshot.last_stream_lookup_id = normalized_lookup_id;
    snapshot.last_stream_key = normalized_stream_key;
    snapshot.stream_kind = next_stream_kind;
    if stream_changed || missing_resolved_at {
        snapshot.resolved_at = Some(progress.last_watched);
    }

    store.set(playback_stream_health_item_key(key), json!(snapshot));
    if index_changed {
        store.set(PLAYBACK_STREAM_HEALTH_INDEX_KEY, json!(health_index));
    }

    Ok(true)
}

fn insert_sorted_unique(index: &mut Vec<String>, value: &str) -> bool {
    match index.binary_search_by(|existing| existing.as_str().cmp(value)) {
        Ok(_) => false,
        Err(position) => {
            index.insert(position, value.to_string());
            true
        }
    }
}

fn load_index<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    index_key: &str,
) -> Result<Vec<String>, String> {
    if let Some(value) = store.get(index_key) {
        if let Ok(index) = serde_json::from_value::<Vec<String>>(value) {
            return Ok(index);
        }
    }

    store.set(index_key, json!(Vec::<String>::new()));
    store.save().map_err(|e| e.to_string())?;
    Ok(Vec::new())
}

#[cfg(test)]
pub(crate) fn merge_keyed_progress_entries(
    history_entries: Vec<(String, WatchProgress)>,
    resume_entries: Vec<(String, WatchProgress)>,
) -> Vec<(String, WatchProgress)> {
    let mut merged: HashMap<String, WatchProgress> = history_entries.into_iter().collect();

    for (key, resume) in resume_entries {
        match merged.get(&key) {
            Some(existing) if existing.last_watched > resume.last_watched => {}
            _ => {
                merged.insert(key, resume);
            }
        }
    }

    let mut entries: Vec<(String, WatchProgress)> = merged.into_iter().collect();
    entries.sort_by(|left, right| right.1.last_watched.cmp(&left.1.last_watched));
    entries
}

#[cfg(test)]
mod tests {
    use super::{
        build_episode_mapping_snapshot, merge_playback_language_preferences,
        playback_language_preferences_scope_key, score_source_health_priority,
        score_stream_family_priority, PlaybackLanguagePreferencesSnapshot,
        PlaybackSourceHealthSnapshot, PlaybackStreamFamilySnapshot,
    };
    use crate::commands::PlaybackLanguagePreferences;
    use crate::providers::Episode;

    #[test]
    fn source_health_priority_penalizes_active_cooldown() {
        let now_ms = 10_000;
        let snapshot = PlaybackSourceHealthSnapshot {
            source_name: "alpha".to_string(),
            last_success_at: Some(5_000),
            last_failure_at: Some(9_000),
            last_failure_reason: Some("load-failed".to_string()),
            consecutive_failures: 3,
            cooldown_until: Some(20_000),
        };

        assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 0);
    }

    #[test]
    fn source_health_priority_penalizes_recent_repeat_failures() {
        let now_ms = 60_000;
        let snapshot = PlaybackSourceHealthSnapshot {
            source_name: "alpha".to_string(),
            last_success_at: None,
            last_failure_at: Some(55_000),
            last_failure_reason: Some("startup-timeout".to_string()),
            consecutive_failures: 2,
            cooldown_until: None,
        };

        assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 1);
    }

    #[test]
    fn source_health_priority_rewards_recent_success() {
        let now_ms = 60_000;
        let snapshot = PlaybackSourceHealthSnapshot {
            source_name: "alpha".to_string(),
            last_success_at: Some(58_000),
            last_failure_at: None,
            last_failure_reason: None,
            consecutive_failures: 0,
            cooldown_until: None,
        };

        assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 3);
    }

    #[test]
    fn stream_family_priority_rewards_recent_nearby_success() {
        let now_ms = 100_000;
        let snapshot = PlaybackStreamFamilySnapshot {
            media_id: "tt123".to_string(),
            media_type: "series".to_string(),
            stream_family: "alpha|release:group-1080p".to_string(),
            source_name: Some("alpha".to_string()),
            last_success_at: Some(99_000),
            last_success_season: Some(1),
            last_success_episode: Some(4),
            last_failure_at: None,
            last_failure_season: None,
            last_failure_episode: None,
            last_failure_reason: None,
            consecutive_failures: 0,
            cooldown_until: None,
        };

        assert_eq!(
            score_stream_family_priority(Some(&snapshot), Some(1), Some(5), now_ms),
            4
        );
    }

    #[test]
    fn stream_family_priority_penalizes_recent_nearby_failure() {
        let now_ms = 100_000;
        let snapshot = PlaybackStreamFamilySnapshot {
            media_id: "tt123".to_string(),
            media_type: "series".to_string(),
            stream_family: "alpha|release:group-1080p".to_string(),
            source_name: Some("alpha".to_string()),
            last_success_at: None,
            last_success_season: None,
            last_success_episode: None,
            last_failure_at: Some(99_500),
            last_failure_season: Some(1),
            last_failure_episode: Some(5),
            last_failure_reason: Some("startup-timeout".to_string()),
            consecutive_failures: 1,
            cooldown_until: Some(110_000),
        };

        assert_eq!(
            score_stream_family_priority(Some(&snapshot), Some(1), Some(6), now_ms),
            0
        );
    }

    #[test]
    fn language_preferences_scope_collapses_anime_into_series_scope() {
        assert_eq!(
            playback_language_preferences_scope_key(Some("anime"), Some("kitsu:42")).as_deref(),
            Some("series:kitsu:42")
        );
    }

    #[test]
    fn scoped_language_preferences_override_global_defaults_per_field() {
        let defaults = PlaybackLanguagePreferences {
            preferred_audio_language: Some("en".to_string()),
            preferred_subtitle_language: Some("off".to_string()),
        };
        let scoped = PlaybackLanguagePreferencesSnapshot {
            media_id: "tt123".to_string(),
            media_type: "series".to_string(),
            preferred_audio_language: Some("ja".to_string()),
            preferred_subtitle_language: None,
            updated_at: 42,
        };

        let effective = merge_playback_language_preferences(defaults, Some(&scoped));

        assert_eq!(effective.preferred_audio_language.as_deref(), Some("ja"));
        assert_eq!(
            effective.preferred_subtitle_language.as_deref(),
            Some("off")
        );
    }

    #[test]
    fn episode_mapping_snapshot_prefers_backend_normalized_episode_coordinates() {
        let snapshot = build_episode_mapping_snapshot(
            "anime",
            "kitsu:42",
            Some("tt-fallback"),
            &Episode {
                id: "episode-1".to_string(),
                title: Some("Episode 1".to_string()),
                season: 1,
                episode: 1,
                released: None,
                release_date: None,
                overview: None,
                thumbnail: None,
                imdb_id: Some("tt-legacy".to_string()),
                imdb_season: Some(21),
                imdb_episode: Some(1004),
                stream_lookup_id: Some("tt-stream".to_string()),
                stream_season: Some(4),
                stream_episode: Some(12),
                aniskip_episode: Some(13),
            },
            123,
        );

        assert_eq!(snapshot.source_lookup_id, "tt-stream");
        assert_eq!(snapshot.source_season, 4);
        assert_eq!(snapshot.source_episode, 12);
        assert_eq!(snapshot.aniskip_episode, 13);
    }
}
