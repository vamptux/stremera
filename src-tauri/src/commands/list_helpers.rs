use super::{normalize_non_empty, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserList {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserListWithItems {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
    pub items: Vec<MediaItem>,
}

pub(super) const LISTS_ORDER_KEY: &str = "lists_order";

pub(super) fn list_meta_key(list_id: &str) -> String {
    format!("list:{}", list_id)
}

pub(super) fn list_item_store_key(list_id: &str, item_id: &str) -> String {
    format!("list_item:{}:{}", list_id, item_id)
}

pub(super) fn load_lists_order<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> Vec<String> {
    let raw_order = store
        .get(LISTS_ORDER_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();

    let mut seen: HashSet<String> = HashSet::with_capacity(raw_order.len());

    raw_order
        .into_iter()
        .filter_map(|list_id| normalize_non_empty(&list_id))
        .filter(|list_id| seen.insert(list_id.clone()))
        .collect()
}
