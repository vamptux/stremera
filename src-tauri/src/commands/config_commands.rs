use super::config_store::{
    app_ui_preferences_initialized, apply_app_ui_preferences_patch, get_effective_debrid_provider,
    get_effective_rd_token, load_addon_configs, load_app_ui_preferences,
    load_last_notified_app_update_version, load_profile_preferences,
    load_stream_selector_preferences, normalize_addon_url, normalize_debrid_provider,
    profile_preferences_initialized, resolve_addon_configs, sanitize_app_ui_preferences,
    sanitize_profile_preferences, sanitize_stream_selector_preferences,
    save_addon_configs_to_store, save_app_ui_preferences_to_store,
    save_last_notified_app_update_version_to_store, save_profile_preferences_to_store,
    save_stream_selector_preferences_to_store, stream_selector_preferences_initialized,
    AddonConfig, AddonManifest, AppUiPreferences, AppUiPreferencesPatch, DebridConfig,
    LocalProfile, ProfilePreferences, ProfileViewMode, StreamSelectorPreferences,
};
use crate::providers::addons::AddonTransport;
use serde::Serialize;
use serde_json::json;
use std::time::Duration;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferencesState {
    pub preferences: StreamSelectorPreferences,
    pub initialized: bool,
}

#[command]
pub async fn save_debrid_config(
    app: AppHandle,
    addon_transport: State<'_, AddonTransport>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let provider = normalize_debrid_provider(&provider)
        .ok_or_else(|| "Unsupported debrid provider.".to_string())?;
    let api_key = api_key.trim().to_string();

    store.set("debrid_provider", json!(provider));

    if provider == "none" {
        store.delete("debrid_api_key");
    } else {
        if api_key.is_empty() {
            return Err("Real-Debrid API key is required.".to_string());
        }

        store.set("debrid_api_key", json!(api_key));
    }

    store.delete("rd_access_token");
    store.delete("rd_refresh_token");
    store.delete("rd_client_id");
    store.delete("rd_client_secret");
    store.delete("rd_auth_method");

    store.save().map_err(|e| e.to_string())?;
    addon_transport.clear_cache();
    Ok(())
}

#[command]
pub async fn get_debrid_config(app: AppHandle) -> Result<DebridConfig, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let provider = get_effective_debrid_provider(&store);
    let api_key = if provider == "realdebrid" {
        get_effective_rd_token(&store).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(DebridConfig { provider, api_key })
}

#[command]
pub async fn get_app_ui_preferences(app: AppHandle) -> Result<AppUiPreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    Ok(load_app_ui_preferences(&store))
}

#[command]
pub async fn save_app_ui_preferences(
    app: AppHandle,
    patch: AppUiPreferencesPatch,
) -> Result<AppUiPreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let preferences = apply_app_ui_preferences_patch(load_app_ui_preferences(&store), patch);

    save_app_ui_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn import_legacy_app_ui_preferences(
    app: AppHandle,
    preferences: AppUiPreferences,
) -> Result<AppUiPreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    if app_ui_preferences_initialized(&store) {
        return Ok(load_app_ui_preferences(&store));
    }

    let preferences = sanitize_app_ui_preferences(preferences);

    save_app_ui_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn get_last_notified_app_update_version(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    Ok(load_last_notified_app_update_version(&store))
}

#[command]
pub async fn save_last_notified_app_update_version(
    app: AppHandle,
    version: Option<String>,
) -> Result<Option<String>, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    save_last_notified_app_update_version_to_store(&store, version);
    store.save().map_err(|e| e.to_string())?;

    Ok(load_last_notified_app_update_version(&store))
}

#[command]
pub async fn import_legacy_last_notified_app_update_version(
    app: AppHandle,
    version: Option<String>,
) -> Result<Option<String>, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    if load_last_notified_app_update_version(&store).is_some() {
        return Ok(load_last_notified_app_update_version(&store));
    }

    save_last_notified_app_update_version_to_store(&store, version);
    store.save().map_err(|e| e.to_string())?;

    Ok(load_last_notified_app_update_version(&store))
}

#[command]
pub async fn get_profile_preferences(app: AppHandle) -> Result<ProfilePreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    Ok(load_profile_preferences(&store))
}

#[command]
pub async fn save_profile_preferences(
    app: AppHandle,
    profile: LocalProfile,
    view_mode: ProfileViewMode,
) -> Result<ProfilePreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let preferences = sanitize_profile_preferences(ProfilePreferences { profile, view_mode });

    save_profile_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn import_legacy_profile_preferences(
    app: AppHandle,
    profile: LocalProfile,
    view_mode: ProfileViewMode,
) -> Result<ProfilePreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    if profile_preferences_initialized(&store) {
        return Ok(load_profile_preferences(&store));
    }

    let preferences = sanitize_profile_preferences(ProfilePreferences { profile, view_mode });

    save_profile_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn get_stream_selector_preferences(
    app: AppHandle,
) -> Result<StreamSelectorPreferencesState, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    Ok(StreamSelectorPreferencesState {
        preferences: load_stream_selector_preferences(&store),
        initialized: stream_selector_preferences_initialized(&store),
    })
}

#[command]
pub async fn save_stream_selector_preferences(
    app: AppHandle,
    preferences: StreamSelectorPreferences,
) -> Result<StreamSelectorPreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    let preferences = sanitize_stream_selector_preferences(preferences);

    save_stream_selector_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn import_legacy_stream_selector_preferences(
    app: AppHandle,
    preferences: StreamSelectorPreferences,
) -> Result<StreamSelectorPreferences, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    if stream_selector_preferences_initialized(&store) {
        return Ok(load_stream_selector_preferences(&store));
    }

    let preferences = sanitize_stream_selector_preferences(preferences);

    save_stream_selector_preferences_to_store(&store, &preferences);
    store.save().map_err(|e| e.to_string())?;

    Ok(preferences)
}

#[command]
pub async fn get_addon_configs(app: AppHandle) -> Result<Vec<AddonConfig>, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    Ok(load_addon_configs(&store))
}

#[command]
pub async fn save_addon_configs(
    app: AppHandle,
    provider: State<'_, AddonTransport>,
    configs: Vec<AddonConfig>,
) -> Result<Vec<AddonConfig>, String> {
    let store = app
        .store(super::SETTINGS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    let mut normalized = Vec::with_capacity(configs.len());
    for mut config in configs {
        config.id = config.id.trim().to_string();
        config.name = config.name.trim().to_string();
        let url = normalize_addon_url(&config.url)?.ok_or_else(|| {
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
    provider.clear_cache();
    Ok(normalized)
}

#[command]
pub async fn fetch_addon_manifest(url: String) -> Result<AddonManifest, String> {
    let base_url = normalize_addon_url(&url)?
        .ok_or_else(|| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;
    let mut parsed = reqwest::Url::parse(&base_url)
        .map_err(|_| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;
    let query = parsed.query().map(|value| value.to_string());
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

    let response = client
        .get(&manifest_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach addon: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Addon returned HTTP {}. Check the URL and try again.",
            response.status().as_u16()
        ));
    }

    response
        .json()
        .await
        .map_err(|_| "Invalid addon manifest format.".to_string())
}
