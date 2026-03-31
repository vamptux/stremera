use super::config_store::{
    get_trimmed_store_string, normalize_addon_url, normalize_debrid_provider,
    resolve_addon_configs, save_addon_configs_to_store,
};
use super::list_helpers::{list_item_store_key, list_meta_key, UserList, LISTS_ORDER_KEY};
use super::store_helpers::{library_item_key, watch_status_item_key};
use super::{
    LIBRARY_INDEX_KEY, LIBRARY_MAP_KEY, LIBRARY_STORE_FILE, LISTS_STORE_FILE, SETTINGS_STORE_FILE,
    WATCH_STATUS_INDEX_KEY, WATCH_STATUS_MAP_KEY, WATCH_STATUS_STORE_FILE,
};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const ADDON_CONFIGS_KEY: &str = "addon_configs";
const DEBRID_PROVIDER_KEY: &str = "debrid_provider";
const DEBRID_API_KEY_KEY: &str = "debrid_api_key";
const LEGACY_TORRENTIO_CONFIG_KEY: &str = "torrentio_config";
const LEGACY_RD_ACCESS_TOKEN_KEY: &str = "rd_access_token";
const STALE_ANIME_ENHANCEMENT_KEYS: [&str; 2] = [
    "anime_playback_enhancement_preset",
    "anime_playback_enhancement_validation",
];
const STALE_DEBRID_KEYS: [&str; 5] = [
    LEGACY_RD_ACCESS_TOKEN_KEY,
    "rd_refresh_token",
    "rd_client_id",
    "rd_client_secret",
    "rd_auth_method",
];

pub(crate) fn run_startup_migrations(app: &AppHandle) -> Result<(), String> {
    migrate_settings_store(app)?;
    migrate_legacy_app_data_stores(app)?;
    Ok(())
}

fn migrate_settings_store(app: &AppHandle) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let mut dirty = false;

    if store.get(ADDON_CONFIGS_KEY).is_none() {
        let legacy_addon_url = get_trimmed_store_string(&store, LEGACY_TORRENTIO_CONFIG_KEY)
            .and_then(|config| normalize_addon_url(&config).ok().flatten());

        if let Some(config) = legacy_addon_url {
            let configs = resolve_addon_configs(None, Some(config));
            if !configs.is_empty() {
                save_addon_configs_to_store(&store, &configs);
                dirty = true;
            }
        }
    }

    if store.delete(LEGACY_TORRENTIO_CONFIG_KEY) {
        dirty = true;
    }

    let stored_provider = get_trimmed_store_string(&store, DEBRID_PROVIDER_KEY);
    let stored_api_key = get_trimmed_store_string(&store, DEBRID_API_KEY_KEY);
    let legacy_api_key = get_trimmed_store_string(&store, LEGACY_RD_ACCESS_TOKEN_KEY);
    let canonical_provider = stored_provider
        .as_deref()
        .and_then(normalize_debrid_provider)
        .unwrap_or_else(|| {
            if stored_api_key.is_some() || legacy_api_key.is_some() {
                "realdebrid"
            } else {
                "none"
            }
        });

    if stored_provider.as_deref() != Some(canonical_provider) {
        store.set(DEBRID_PROVIDER_KEY, json!(canonical_provider));
        dirty = true;
    }

    let canonical_api_key = stored_api_key.or(legacy_api_key);

    if let Some(api_key) = canonical_api_key {
        let api_key_changed = get_trimmed_store_string(&store, DEBRID_API_KEY_KEY).as_deref()
            != Some(api_key.as_str());
        store.set(DEBRID_API_KEY_KEY, json!(api_key));
        if api_key_changed {
            dirty = true;
        }
    } else if store.delete(DEBRID_API_KEY_KEY) {
        dirty = true;
    }

    for key in STALE_DEBRID_KEYS {
        if store.delete(key) {
            dirty = true;
        }
    }

    for key in STALE_ANIME_ENHANCEMENT_KEYS {
        if store.delete(key) {
            dirty = true;
        }
    }

    if dirty {
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn migrate_legacy_app_data_stores(app: &AppHandle) -> Result<(), String> {
    let settings_store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let library_store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let lists_store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;
    let watch_status_store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;

    let mut settings_dirty = false;

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
