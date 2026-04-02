use super::normalize_non_empty;
use serde::{Deserialize, Serialize};

const ADDON_CONFIGS_KEY: &str = "addon_configs";
const APP_UI_PREFERENCES_KEY: &str = "app_ui_preferences";
const LAST_NOTIFIED_APP_UPDATE_VERSION_KEY: &str = "last_notified_app_update_version";
const PROFILE_PREFERENCES_KEY: &str = "profile_preferences";
const STREAM_SELECTOR_PREFERENCES_KEY: &str = "stream_selector_preferences";
const APP_UPDATE_VERSION_MAX_CHARS: usize = 64;
const PLAYER_VOLUME_DEFAULT: u32 = 75;
const PLAYER_SPEED_DEFAULT: f64 = 1.0;
const PLAYER_SPEED_MIN: f64 = 0.25;
const PLAYER_SPEED_MAX: f64 = 4.0;
const PROFILE_NAME_MAX_CHARS: usize = 32;
const PROFILE_BIO_MAX_CHARS: usize = 80;
const STREAM_SELECTOR_ADDON_MAX_CHARS: usize = 160;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AddonConfig {
    pub id: String,
    pub url: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AddonManifest {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DebridConfig {
    pub provider: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferences {
    pub player_volume: u32,
    pub player_speed: f64,
    pub spoiler_protection: bool,
}

impl Default for AppUiPreferences {
    fn default() -> Self {
        Self {
            player_volume: PLAYER_VOLUME_DEFAULT,
            player_speed: PLAYER_SPEED_DEFAULT,
            spoiler_protection: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferencesPatch {
    pub player_volume: Option<u32>,
    pub player_speed: Option<f64>,
    pub spoiler_protection: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfile {
    pub username: String,
    pub accent_color: String,
    pub bio: String,
}

impl Default for LocalProfile {
    fn default() -> Self {
        Self {
            username: "Guest User".to_string(),
            accent_color: "#ffffff".to_string(),
            bio: String::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileViewMode {
    #[default]
    Grid,
    List,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreferences {
    pub profile: LocalProfile,
    pub view_mode: ProfileViewMode,
}

impl Default for ProfilePreferences {
    fn default() -> Self {
        Self {
            profile: LocalProfile::default(),
            view_mode: ProfileViewMode::Grid,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamSelectorQuality {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "4k")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "sd")]
    Sd,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSource {
    #[default]
    All,
    Cached,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSort {
    #[default]
    Smart,
    Quality,
    Size,
    Seeds,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorBatch {
    #[default]
    All,
    Episodes,
    Packs,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferences {
    pub quality: StreamSelectorQuality,
    pub source: StreamSelectorSource,
    pub addon: String,
    pub sort: StreamSelectorSort,
    pub batch: StreamSelectorBatch,
}

impl Default for StreamSelectorPreferences {
    fn default() -> Self {
        Self {
            quality: StreamSelectorQuality::All,
            source: StreamSelectorSource::All,
            addon: "all".to_string(),
            sort: StreamSelectorSort::Smart,
            batch: StreamSelectorBatch::All,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocalProfile {
    username: Option<String>,
    accent_color: Option<String>,
    bio: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfilePreferences {
    profile: Option<StoredLocalProfile>,
    view_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAppUiPreferences {
    player_volume: Option<u32>,
    player_speed: Option<f64>,
    spoiler_protection: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredStreamSelectorPreferences {
    quality: Option<String>,
    source: Option<String>,
    addon: Option<String>,
    sort: Option<String>,
    batch: Option<String>,
}

fn trim_to_max_chars(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_player_volume(value: Option<u32>) -> u32 {
    value
        .map(|volume| volume.min(100))
        .unwrap_or(PLAYER_VOLUME_DEFAULT)
}

fn normalize_player_speed(value: Option<f64>) -> f64 {
    value
        .filter(|speed| speed.is_finite() && *speed > 0.0)
        .map(|speed| speed.clamp(PLAYER_SPEED_MIN, PLAYER_SPEED_MAX))
        .unwrap_or(PLAYER_SPEED_DEFAULT)
}

fn normalize_last_notified_app_update_version(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(|version| trim_to_max_chars(version, APP_UPDATE_VERSION_MAX_CHARS))
        .filter(|version| !version.is_empty())
}

fn normalize_profile_username(value: Option<String>) -> String {
    let candidate = value
        .as_deref()
        .map(|value| trim_to_max_chars(value, PROFILE_NAME_MAX_CHARS))
        .filter(|value| !value.is_empty());

    candidate.unwrap_or_else(|| LocalProfile::default().username)
}

fn normalize_profile_bio(value: Option<String>) -> String {
    value
        .as_deref()
        .map(|value| trim_to_max_chars(value, PROFILE_BIO_MAX_CHARS))
        .unwrap_or_default()
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit())
}

fn normalize_profile_accent_color(value: Option<String>) -> String {
    let candidate = value
        .as_deref()
        .map(str::trim)
        .filter(|value| is_hex_color(value))
        .map(str::to_ascii_lowercase);

    candidate.unwrap_or_else(|| LocalProfile::default().accent_color)
}

fn normalize_profile_view_mode(value: Option<&str>) -> ProfileViewMode {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("list") => ProfileViewMode::List,
        _ => ProfileViewMode::Grid,
    }
}

pub(crate) fn sanitize_local_profile(profile: LocalProfile) -> LocalProfile {
    LocalProfile {
        username: normalize_profile_username(Some(profile.username)),
        accent_color: normalize_profile_accent_color(Some(profile.accent_color)),
        bio: normalize_profile_bio(Some(profile.bio)),
    }
}

fn normalize_stored_local_profile(profile: Option<StoredLocalProfile>) -> LocalProfile {
    let profile = profile.unwrap_or(StoredLocalProfile {
        username: None,
        accent_color: None,
        bio: None,
    });

    LocalProfile {
        username: normalize_profile_username(profile.username),
        accent_color: normalize_profile_accent_color(profile.accent_color),
        bio: normalize_profile_bio(profile.bio),
    }
}

pub(crate) fn sanitize_profile_preferences(preferences: ProfilePreferences) -> ProfilePreferences {
    ProfilePreferences {
        profile: sanitize_local_profile(preferences.profile),
        view_mode: preferences.view_mode,
    }
}

pub(crate) fn sanitize_app_ui_preferences(preferences: AppUiPreferences) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(Some(preferences.player_volume)),
        player_speed: normalize_player_speed(Some(preferences.player_speed)),
        spoiler_protection: preferences.spoiler_protection,
    }
}

pub(crate) fn apply_app_ui_preferences_patch(
    current: AppUiPreferences,
    patch: AppUiPreferencesPatch,
) -> AppUiPreferences {
    sanitize_app_ui_preferences(AppUiPreferences {
        player_volume: patch.player_volume.unwrap_or(current.player_volume),
        player_speed: patch.player_speed.unwrap_or(current.player_speed),
        spoiler_protection: patch
            .spoiler_protection
            .unwrap_or(current.spoiler_protection),
    })
}

fn normalize_stored_profile_preferences(
    preferences: StoredProfilePreferences,
) -> ProfilePreferences {
    ProfilePreferences {
        profile: normalize_stored_local_profile(preferences.profile),
        view_mode: normalize_profile_view_mode(preferences.view_mode.as_deref()),
    }
}

fn normalize_stored_app_ui_preferences(preferences: StoredAppUiPreferences) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(preferences.player_volume),
        player_speed: normalize_player_speed(preferences.player_speed),
        spoiler_protection: preferences.spoiler_protection.unwrap_or(false),
    }
}

pub(crate) fn profile_preferences_initialized<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> bool {
    store.get(PROFILE_PREFERENCES_KEY).is_some()
}

pub(crate) fn app_ui_preferences_initialized<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> bool {
    store.get(APP_UI_PREFERENCES_KEY).is_some()
}

pub(crate) fn load_profile_preferences<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> ProfilePreferences {
    store
        .get(PROFILE_PREFERENCES_KEY)
        .and_then(|value| serde_json::from_value::<StoredProfilePreferences>(value).ok())
        .map(normalize_stored_profile_preferences)
        .unwrap_or_default()
}

pub(crate) fn load_app_ui_preferences<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> AppUiPreferences {
    store
        .get(APP_UI_PREFERENCES_KEY)
        .and_then(|value| serde_json::from_value::<StoredAppUiPreferences>(value).ok())
        .map(normalize_stored_app_ui_preferences)
        .unwrap_or_default()
}

pub(crate) fn load_last_notified_app_update_version<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<String> {
    store
        .get(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .and_then(|value| normalize_last_notified_app_update_version(Some(value)))
}

pub(crate) fn save_profile_preferences_to_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    preferences: &ProfilePreferences,
) {
    store.set(PROFILE_PREFERENCES_KEY, serde_json::json!(preferences));
}

pub(crate) fn save_app_ui_preferences_to_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    preferences: &AppUiPreferences,
) {
    store.set(APP_UI_PREFERENCES_KEY, serde_json::json!(preferences));
}

pub(crate) fn save_last_notified_app_update_version_to_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    version: Option<String>,
) {
    if let Some(version) = normalize_last_notified_app_update_version(version) {
        store.set(
            LAST_NOTIFIED_APP_UPDATE_VERSION_KEY,
            serde_json::json!(version),
        );
    } else {
        store.delete(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY);
    }
}

fn normalize_stream_selector_quality(value: Option<&str>) -> StreamSelectorQuality {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("4k") => StreamSelectorQuality::P2160,
        Some("1080p") => StreamSelectorQuality::P1080,
        Some("720p") => StreamSelectorQuality::P720,
        Some("sd") => StreamSelectorQuality::Sd,
        _ => StreamSelectorQuality::All,
    }
}

fn normalize_stream_selector_source(value: Option<&str>) -> StreamSelectorSource {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("cached") => StreamSelectorSource::Cached,
        _ => StreamSelectorSource::All,
    }
}

fn normalize_stream_selector_sort(value: Option<&str>) -> StreamSelectorSort {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("quality") => StreamSelectorSort::Quality,
        Some("size") => StreamSelectorSort::Size,
        Some("seeds") => StreamSelectorSort::Seeds,
        _ => StreamSelectorSort::Smart,
    }
}

fn normalize_stream_selector_batch(value: Option<&str>) -> StreamSelectorBatch {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("episodes") => StreamSelectorBatch::Episodes,
        Some("packs") => StreamSelectorBatch::Packs,
        _ => StreamSelectorBatch::All,
    }
}

fn normalize_stream_selector_addon(value: Option<String>) -> String {
    let normalized = value
        .as_deref()
        .map(|value| trim_to_max_chars(value, STREAM_SELECTOR_ADDON_MAX_CHARS))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "all".to_string());

    if normalized.eq_ignore_ascii_case("all") {
        "all".to_string()
    } else {
        normalized
    }
}

pub(crate) fn sanitize_stream_selector_preferences(
    preferences: StreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: preferences.quality,
        source: preferences.source,
        addon: normalize_stream_selector_addon(Some(preferences.addon)),
        sort: preferences.sort,
        batch: preferences.batch,
    }
}

fn normalize_stored_stream_selector_preferences(
    preferences: StoredStreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: normalize_stream_selector_quality(preferences.quality.as_deref()),
        source: normalize_stream_selector_source(preferences.source.as_deref()),
        addon: normalize_stream_selector_addon(preferences.addon),
        sort: normalize_stream_selector_sort(preferences.sort.as_deref()),
        batch: normalize_stream_selector_batch(preferences.batch.as_deref()),
    }
}

pub(crate) fn stream_selector_preferences_initialized<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> bool {
    store.get(STREAM_SELECTOR_PREFERENCES_KEY).is_some()
}

pub(crate) fn load_stream_selector_preferences<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> StreamSelectorPreferences {
    store
        .get(STREAM_SELECTOR_PREFERENCES_KEY)
        .and_then(|value| serde_json::from_value::<StoredStreamSelectorPreferences>(value).ok())
        .map(normalize_stored_stream_selector_preferences)
        .unwrap_or_default()
}

pub(crate) fn save_stream_selector_preferences_to_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    preferences: &StreamSelectorPreferences,
) {
    store.set(
        STREAM_SELECTOR_PREFERENCES_KEY,
        serde_json::json!(preferences),
    );
}

pub(crate) fn get_trimmed_store_string<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    key: &str,
) -> Option<String> {
    store
        .get(key)
        .and_then(|value| value.as_str().map(|item| item.trim().to_string()))
        .filter(|value| !value.is_empty())
}

pub(crate) fn normalize_addon_url(config: &str) -> Result<Option<String>, String> {
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
        .map_err(|_| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Addon URL must start with http:// or https://".to_string());
    }

    if parsed.host_str().is_none() {
        return Err("Addon URL must include a valid host.".to_string());
    }

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

pub(crate) fn normalize_debrid_provider(value: &str) -> Option<&'static str> {
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

pub(crate) fn get_effective_rd_token<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<String> {
    match get_stored_debrid_provider(store) {
        Some("realdebrid") | None => get_trimmed_store_string(store, "debrid_api_key"),
        Some("none") => None,
        Some(_) => None,
    }
}

pub(crate) fn extract_embedded_realdebrid_token(config_url: &str) -> Option<String> {
    let normalized = normalize_addon_url(config_url).ok().flatten()?;
    let parsed = reqwest::Url::parse(&normalized).ok()?;

    for (key, value) in parsed.query_pairs() {
        let normalized_key = key.trim().to_ascii_lowercase();
        if matches!(normalized_key.as_str(), "realdebrid" | "rd" | "rd_token") {
            if let Some(token) = normalize_non_empty(&value) {
                return Some(token);
            }
        }
    }

    for segment in parsed.path_segments().into_iter().flatten() {
        let Some((key, value)) = segment.split_once('=') else {
            continue;
        };

        let normalized_key = key.trim().to_ascii_lowercase();
        if matches!(normalized_key.as_str(), "realdebrid" | "rd") {
            if let Some(token) = normalize_non_empty(value) {
                return Some(token);
            }
        }
    }

    None
}

pub(crate) fn get_effective_playback_rd_token<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Option<String> {
    get_effective_rd_token(store).or_else(|| {
        load_addon_configs(store)
            .into_iter()
            .filter(|addon| addon.enabled)
            .find_map(|addon| extract_embedded_realdebrid_token(&addon.url))
    })
}

pub(crate) fn get_effective_debrid_provider<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> String {
    get_stored_debrid_provider(store)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if get_trimmed_store_string(store, "debrid_api_key").is_some() {
                "realdebrid".to_string()
            } else {
                "none".to_string()
            }
        })
}

fn normalize_loaded_addon_config(mut config: AddonConfig) -> Option<AddonConfig> {
    let url = normalize_addon_url(&config.url).ok().flatten()?;
    let fallback_name = reqwest::Url::parse(&url)
        .ok()
        .and_then(|value| value.host_str().map(|host| host.to_string()));

    config.id = normalize_non_empty(&config.id).unwrap_or_else(|| url.clone());
    config.name = normalize_non_empty(&config.name)
        .or(fallback_name)
        .unwrap_or_else(|| "Addon".to_string());
    config.url = url;

    Some(config)
}

fn normalize_loaded_addon_configs(configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    let mut normalized_configs = Vec::with_capacity(configs.len());
    let mut seen_urls = std::collections::HashSet::with_capacity(configs.len());
    let mut seen_ids = std::collections::HashSet::with_capacity(configs.len());

    for mut config in configs
        .into_iter()
        .filter_map(normalize_loaded_addon_config)
    {
        if !seen_urls.insert(config.url.clone()) {
            continue;
        }

        if !seen_ids.insert(config.id.clone()) {
            config.id = config.url.clone();
            if !seen_ids.insert(config.id.clone()) {
                continue;
            }
        }

        normalized_configs.push(config);
    }

    normalized_configs
}

fn legacy_single_addon_config(config_url: String) -> AddonConfig {
    let fallback_name = reqwest::Url::parse(&config_url)
        .ok()
        .and_then(|value| value.host_str().map(|host| host.to_string()))
        .unwrap_or_else(|| "Migrated Addon".to_string());

    AddonConfig {
        id: "legacy-addon".to_string(),
        url: config_url,
        name: fallback_name,
        enabled: true,
    }
}

pub(crate) fn resolve_addon_configs(
    stored_configs: Option<Vec<AddonConfig>>,
    legacy_addon_url: Option<String>,
) -> Vec<AddonConfig> {
    if let Some(configs) = stored_configs {
        return normalize_loaded_addon_configs(configs);
    }

    legacy_addon_url
        .map(legacy_single_addon_config)
        .into_iter()
        .collect()
}

pub(crate) fn load_addon_configs<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Vec<AddonConfig> {
    if let Some(value) = store.get(ADDON_CONFIGS_KEY) {
        let stored_configs = serde_json::from_value::<Vec<AddonConfig>>(value).unwrap_or_default();
        return resolve_addon_configs(Some(stored_configs), None);
    }

    Vec::new()
}

pub(crate) fn save_addon_configs_to_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    configs: &[AddonConfig],
) {
    store.set(ADDON_CONFIGS_KEY, serde_json::json!(configs));
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_app_ui_preferences, sanitize_local_profile, sanitize_profile_preferences,
        sanitize_stream_selector_preferences, AppUiPreferences, LocalProfile, ProfilePreferences,
        ProfileViewMode, StreamSelectorBatch, StreamSelectorPreferences, StreamSelectorQuality,
        StreamSelectorSort, StreamSelectorSource,
    };

    #[test]
    fn sanitize_local_profile_trims_and_defaults_invalid_fields() {
        let profile = sanitize_local_profile(LocalProfile {
            username: "   ".to_string(),
            accent_color: "not-a-color".to_string(),
            bio: "  Hello world  ".to_string(),
        });

        assert_eq!(profile.username, "Guest User");
        assert_eq!(profile.accent_color, "#ffffff");
        assert_eq!(profile.bio, "Hello world");
    }

    #[test]
    fn sanitize_profile_preferences_preserves_view_mode() {
        let preferences = sanitize_profile_preferences(ProfilePreferences {
            profile: LocalProfile {
                username: "  Streamer  ".to_string(),
                accent_color: "#ABCDEF".to_string(),
                bio: String::new(),
            },
            view_mode: ProfileViewMode::List,
        });

        assert_eq!(preferences.profile.username, "Streamer");
        assert_eq!(preferences.profile.accent_color, "#abcdef");
        assert_eq!(preferences.view_mode, ProfileViewMode::List);
    }

    #[test]
    fn sanitize_stream_selector_preferences_canonicalizes_addon_token() {
        let preferences = sanitize_stream_selector_preferences(StreamSelectorPreferences {
            quality: StreamSelectorQuality::P1080,
            source: StreamSelectorSource::Cached,
            addon: "  ALL  ".to_string(),
            sort: StreamSelectorSort::Size,
            batch: StreamSelectorBatch::Episodes,
        });

        assert_eq!(preferences.quality, StreamSelectorQuality::P1080);
        assert_eq!(preferences.source, StreamSelectorSource::Cached);
        assert_eq!(preferences.addon, "all");
        assert_eq!(preferences.sort, StreamSelectorSort::Size);
        assert_eq!(preferences.batch, StreamSelectorBatch::Episodes);
    }

    #[test]
    fn sanitize_app_ui_preferences_clamps_runtime_values() {
        let preferences = sanitize_app_ui_preferences(AppUiPreferences {
            player_volume: 140,
            player_speed: 9.0,
            spoiler_protection: true,
        });

        assert_eq!(preferences.player_volume, 100);
        assert_eq!(preferences.player_speed, 4.0);
        assert!(preferences.spoiler_protection);
    }
}
