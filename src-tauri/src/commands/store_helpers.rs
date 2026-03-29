use super::{
    normalize_non_empty, MediaItem, LIBRARY_INDEX_KEY, LIBRARY_ITEM_PREFIX, LIBRARY_MAP_KEY,
    WATCH_STATUS_INDEX_KEY, WATCH_STATUS_ITEM_PREFIX, WATCH_STATUS_MAP_KEY,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub(super) fn normalize_library_item(mut item: MediaItem) -> Option<MediaItem> {
    let id = normalize_non_empty(&item.id)?;
    let title = normalize_non_empty(&item.title)?;

    let normalized_type = item.type_.trim().to_ascii_lowercase();
    item.type_ = match normalized_type.as_str() {
        "movie" => "movie".to_string(),
        "series" | "anime" => "series".to_string(),
        _ => return None,
    };

    item.id = id;
    item.title = title;
    item.poster = item.poster.and_then(|s| normalize_non_empty(&s));
    item.backdrop = item.backdrop.and_then(|s| normalize_non_empty(&s));
    item.logo = item.logo.and_then(|s| normalize_non_empty(&s));
    item.description = item.description.and_then(|s| normalize_non_empty(&s));
    item.year = item.year.and_then(|s| normalize_non_empty(&s));
    item.relation_role = item.relation_role.and_then(|s| normalize_non_empty(&s));

    Some(item)
}

fn choose_library_field(incoming: Option<String>, existing: Option<String>) -> Option<String> {
    incoming.or(existing)
}

pub(super) fn merge_library_item(existing: MediaItem, incoming: MediaItem) -> MediaItem {
    MediaItem {
        id: existing.id,
        title: incoming.title,
        poster: choose_library_field(incoming.poster, existing.poster),
        backdrop: choose_library_field(incoming.backdrop, existing.backdrop),
        logo: choose_library_field(incoming.logo, existing.logo),
        description: choose_library_field(incoming.description, existing.description),
        year: choose_library_field(incoming.year, existing.year),
        type_: incoming.type_,
        relation_role: choose_library_field(incoming.relation_role, existing.relation_role),
    }
}

pub(super) fn library_item_key(item_id: &str) -> String {
    format!("{}{}", LIBRARY_ITEM_PREFIX, item_id)
}

pub(super) fn load_or_migrate_library_index<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<Vec<String>, String> {
    if let Some(value) = store.get(LIBRARY_INDEX_KEY) {
        if let Ok(index) = serde_json::from_value::<Vec<String>>(value) {
            return Ok(index);
        }
    }

    if let Some(value) = store.get(LIBRARY_MAP_KEY) {
        let legacy_map = serde_json::from_value::<HashMap<String, MediaItem>>(value)
            .map_err(|e| e.to_string())?;
        let mut migrated: HashMap<String, MediaItem> = HashMap::with_capacity(legacy_map.len());

        for (_legacy_key, item) in legacy_map {
            let Some(normalized) = normalize_library_item(item) else {
                continue;
            };

            if let Some(existing) = migrated.remove(&normalized.id) {
                let merged = merge_library_item(existing, normalized);
                migrated.insert(merged.id.clone(), merged);
            } else {
                migrated.insert(normalized.id.clone(), normalized);
            }
        }

        let mut index: Vec<String> = migrated.keys().cloned().collect();
        index.sort();

        for item_id in &index {
            if let Some(item) = migrated.get(item_id) {
                store.set(library_item_key(item_id), json!(item));
            }
        }

        store.delete(LIBRARY_MAP_KEY);
        store.set(LIBRARY_INDEX_KEY, json!(index.clone()));
        store.save().map_err(|e| e.to_string())?;
        return Ok(index);
    }

    Ok(Vec::new())
}

pub(super) fn load_library_map<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<HashMap<String, MediaItem>, String> {
    let mut index = load_or_migrate_library_index(store)?;
    let mut map: HashMap<String, MediaItem> = HashMap::with_capacity(index.len());
    let mut modified = false;

    for item_id in &index {
        let Some(value) = store.get(library_item_key(item_id)) else {
            modified = true;
            continue;
        };

        let Some(normalized) = serde_json::from_value::<MediaItem>(value)
            .ok()
            .and_then(normalize_library_item)
        else {
            modified = true;
            continue;
        };

        if normalized.id != *item_id {
            modified = true;
        }

        if let Some(existing) = map.remove(&normalized.id) {
            modified = true;
            let merged = merge_library_item(existing, normalized);
            map.insert(merged.id.clone(), merged);
        } else {
            map.insert(normalized.id.clone(), normalized);
        }
    }

    if modified {
        let previous_ids: HashSet<String> = index.into_iter().collect();
        for stale_id in &previous_ids {
            if !map.contains_key(stale_id) {
                store.delete(library_item_key(stale_id));
            }
        }

        index = map.keys().cloned().collect();
        index.sort();

        for item_id in &index {
            if let Some(item) = map.get(item_id) {
                store.set(library_item_key(item_id), json!(item));
            }
        }
        store.set(LIBRARY_INDEX_KEY, json!(index));
        store.delete(LIBRARY_MAP_KEY);
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(map)
}

pub(super) fn watch_status_item_key(item_id: &str) -> String {
    format!("{}{}", WATCH_STATUS_ITEM_PREFIX, item_id)
}

pub(super) fn load_or_migrate_watch_status_index<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<Vec<String>, String> {
    if let Some(value) = store.get(WATCH_STATUS_INDEX_KEY) {
        if let Ok(index) = serde_json::from_value::<Vec<String>>(value) {
            return Ok(index);
        }
    }

    if let Some(value) = store.get(WATCH_STATUS_MAP_KEY) {
        let legacy_map =
            serde_json::from_value::<HashMap<String, String>>(value).map_err(|e| e.to_string())?;

        let mut index: Vec<String> = Vec::with_capacity(legacy_map.len());
        for (item_id, status) in legacy_map {
            let Some(id) = normalize_non_empty(&item_id) else {
                continue;
            };
            let Some(clean_status) = normalize_non_empty(&status) else {
                continue;
            };
            store.set(watch_status_item_key(&id), json!(clean_status));
            index.push(id);
        }

        index.sort();
        index.dedup();
        store.delete(WATCH_STATUS_MAP_KEY);
        store.set(WATCH_STATUS_INDEX_KEY, json!(index.clone()));
        store.save().map_err(|e| e.to_string())?;
        return Ok(index);
    }

    Ok(Vec::new())
}

pub(super) fn load_watch_statuses_map<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Result<HashMap<String, String>, String> {
    let mut index = load_or_migrate_watch_status_index(store)?;
    let mut statuses: HashMap<String, String> = HashMap::with_capacity(index.len());
    let mut modified = false;

    for item_id in &index {
        let Some(value) = store.get(watch_status_item_key(item_id)) else {
            modified = true;
            continue;
        };

        let Some(status) = value.as_str().and_then(normalize_non_empty) else {
            modified = true;
            continue;
        };

        if statuses.insert(item_id.clone(), status).is_some() {
            modified = true;
        }
    }

    if modified {
        let previous_ids: HashSet<String> = index.into_iter().collect();
        for stale_id in &previous_ids {
            if !statuses.contains_key(stale_id) {
                store.delete(watch_status_item_key(stale_id));
            }
        }

        index = statuses.keys().cloned().collect();
        index.sort();
        for item_id in &index {
            if let Some(status) = statuses.get(item_id) {
                store.set(watch_status_item_key(item_id), json!(status));
            }
        }
        store.set(WATCH_STATUS_INDEX_KEY, json!(index));
        store.delete(WATCH_STATUS_MAP_KEY);
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(statuses)
}

