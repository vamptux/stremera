use super::list_helpers::{
    list_item_store_key, list_meta_key, load_lists_order, UserList, UserListWithItems,
    LISTS_ORDER_KEY,
};
use super::LISTS_STORE_FILE;
use crate::providers::MediaItem;
use serde_json::json;
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

#[command]
pub async fn create_list(
    app: AppHandle,
    name: String,
    icon: Option<String>,
) -> Result<UserList, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let id = format!("list_{}", uuid::Uuid::new_v4().simple());

    let list = UserList {
        id: id.clone(),
        name: name.trim().to_string(),
        icon: icon.unwrap_or_else(|| "📋".to_string()),
        item_ids: Vec::new(),
    };

    let mut order = load_lists_order(&store);
    order.push(id.clone());

    store.set(list_meta_key(&id), json!(list.clone()));
    store.set(LISTS_ORDER_KEY, json!(order));
    store.save().map_err(|e| e.to_string())?;

    Ok(list)
}

#[command]
pub async fn delete_list(app: AppHandle, list_id: String) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    if let Some(meta_val) = store.get(list_meta_key(&list_id)) {
        if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
            for item_id in &list.item_ids {
                store.delete(list_item_store_key(&list_id, item_id));
            }
        }
    }

    store.delete(list_meta_key(&list_id));

    let mut order = load_lists_order(&store);
    order.retain(|id| id != &list_id);
    store.set(LISTS_ORDER_KEY, json!(order));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn rename_list(
    app: AppHandle,
    list_id: String,
    name: String,
    icon: Option<String>,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|value| serde_json::from_value::<UserList>(value).ok())
        .ok_or_else(|| "List not found".to_string())?;

    list.name = name.trim().to_string();
    if let Some(next_icon) = icon {
        list.icon = next_icon;
    }

    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn add_to_list(app: AppHandle, list_id: String, item: MediaItem) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|value| serde_json::from_value::<UserList>(value).ok())
        .ok_or_else(|| "List not found".to_string())?;

    if !list.item_ids.contains(&item.id) {
        list.item_ids.push(item.id.clone());
        store.set(list_item_store_key(&list_id, &item.id), json!(item));
        store.set(list_meta_key(&list_id), json!(list));
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[command]
pub async fn remove_from_list(
    app: AppHandle,
    list_id: String,
    item_id: String,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|value| serde_json::from_value::<UserList>(value).ok())
        .ok_or_else(|| "List not found".to_string())?;

    list.item_ids.retain(|id| id != &item_id);
    store.delete(list_item_store_key(&list_id, &item_id));
    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn get_lists(app: AppHandle) -> Result<Vec<UserListWithItems>, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let order = load_lists_order(&store);
    let mut result: Vec<UserListWithItems> = Vec::with_capacity(order.len());
    let mut modified = false;

    for list_id in &order {
        if let Some(meta_val) = store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                let mut items: Vec<MediaItem> = Vec::with_capacity(list.item_ids.len());
                let mut cleaned_item_ids: Vec<String> = Vec::with_capacity(list.item_ids.len());

                for item_id in &list.item_ids {
                    let Some(item_val) = store.get(list_item_store_key(list_id, item_id)) else {
                        modified = true;
                        continue;
                    };
                    let Ok(item) = serde_json::from_value::<MediaItem>(item_val) else {
                        modified = true;
                        store.delete(list_item_store_key(list_id, item_id));
                        continue;
                    };

                    cleaned_item_ids.push(item_id.clone());
                    items.push(item);
                }

                if cleaned_item_ids != list.item_ids {
                    modified = true;
                    let repaired = UserList {
                        id: list.id.clone(),
                        name: list.name.clone(),
                        icon: list.icon.clone(),
                        item_ids: cleaned_item_ids.clone(),
                    };
                    store.set(list_meta_key(list_id), json!(repaired));
                }

                result.push(UserListWithItems {
                    id: list.id,
                    name: list.name,
                    icon: list.icon,
                    item_ids: cleaned_item_ids,
                    items,
                });
            }
        }
    }

    if modified {
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(result)
}

#[command]
pub async fn reorder_list_items(
    app: AppHandle,
    list_id: String,
    item_ids: Vec<String>,
) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let mut list = store
        .get(list_meta_key(&list_id))
        .and_then(|value| serde_json::from_value::<UserList>(value).ok())
        .ok_or_else(|| "List not found".to_string())?;

    list.item_ids = item_ids
        .into_iter()
        .filter(|id| list.item_ids.contains(id))
        .collect();

    store.set(list_meta_key(&list_id), json!(list));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn reorder_lists(app: AppHandle, list_ids: Vec<String>) -> Result<(), String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let current_order = load_lists_order(&store);
    let new_order: Vec<String> = list_ids
        .into_iter()
        .filter(|id| current_order.contains(id))
        .collect();

    store.set(LISTS_ORDER_KEY, json!(new_order));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn check_item_in_lists(app: AppHandle, item_id: String) -> Result<Vec<String>, String> {
    let store = app.store(LISTS_STORE_FILE).map_err(|e| e.to_string())?;

    let order = load_lists_order(&store);
    let mut list_ids: Vec<String> = Vec::new();

    for list_id in &order {
        if let Some(meta_val) = store.get(list_meta_key(list_id)) {
            if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                if list.item_ids.contains(&item_id) {
                    list_ids.push(list_id.clone());
                }
            }
        }
    }

    Ok(list_ids)
}
