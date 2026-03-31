use super::store_helpers::{
    library_item_key, load_library_map, load_or_migrate_library_index, merge_library_item,
    normalize_library_item,
};
use super::{normalize_non_empty, LIBRARY_INDEX_KEY, LIBRARY_MAP_KEY, LIBRARY_STORE_FILE};
use crate::providers::MediaItem;
use serde_json::json;
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

#[command]
pub async fn add_to_library(app: AppHandle, item: MediaItem) -> Result<(), String> {
    let store = app.store(LIBRARY_STORE_FILE).map_err(|e| e.to_string())?;
    let mut index = load_or_migrate_library_index(&store)?;

    let normalized_item = normalize_library_item(item).ok_or_else(|| {
        "Invalid library item. ID, title, and media type are required.".to_string()
    })?;

    let existing = store
        .get(library_item_key(&normalized_item.id))
        .and_then(|value| serde_json::from_value::<MediaItem>(value).ok())
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
