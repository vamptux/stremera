use super::{
    normalize_non_empty, WATCH_STATUS_INDEX_KEY, WATCH_STATUS_MAP_KEY, WATCH_STATUS_STORE_FILE,
};
use super::store_helpers::{
    load_or_migrate_watch_status_index, load_watch_statuses_map, watch_status_item_key,
};
use serde_json::json;
use std::collections::HashMap;
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

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

    match status.and_then(|value| normalize_non_empty(&value)) {
        Some(value) => {
            store.set(watch_status_item_key(&item_id), json!(value));
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
        .and_then(|value| value.as_str().and_then(normalize_non_empty)))
}

#[command]
pub async fn get_all_watch_statuses(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let store = app
        .store(WATCH_STATUS_STORE_FILE)
        .map_err(|e| e.to_string())?;
    load_watch_statuses_map(&store)
}