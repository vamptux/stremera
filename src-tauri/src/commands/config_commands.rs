use super::config_store::{
    get_effective_debrid_provider, get_effective_rd_token, load_addon_configs,
    normalize_addon_url, normalize_debrid_provider, resolve_addon_configs,
    save_addon_configs_to_store, AddonConfig, AddonManifest, DebridConfig,
};
use crate::providers::stremio_addon::StremioAddonTransport;
use serde_json::json;
use std::time::Duration;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[command]
pub async fn save_debrid_config(
    app: AppHandle,
    addon_transport: State<'_, StremioAddonTransport>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let store = app.store(super::SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
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
    let store = app.store(super::SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let provider = get_effective_debrid_provider(&store);
    let api_key = if provider == "realdebrid" {
        get_effective_rd_token(&store).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(DebridConfig { provider, api_key })
}

#[command]
pub async fn get_addon_configs(app: AppHandle) -> Result<Vec<AddonConfig>, String> {
    let store = app.store(super::SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    Ok(load_addon_configs(&store))
}

#[command]
pub async fn save_addon_configs(
    app: AppHandle,
    provider: State<'_, StremioAddonTransport>,
    configs: Vec<AddonConfig>,
) -> Result<(), String> {
    let store = app.store(super::SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;

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
    Ok(())
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
