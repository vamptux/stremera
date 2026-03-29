use super::normalize_non_empty;
use serde::{Deserialize, Serialize};

const ADDON_CONFIGS_KEY: &str = "addon_configs";

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

    for mut config in configs.into_iter().filter_map(normalize_loaded_addon_config) {
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