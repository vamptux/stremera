use super::history_helpers::{
    build_history_key, choose_continue_watching_entry_with_source_health,
    choose_exact_watch_progress_entry_with_source_health,
    choose_watch_history_entry_with_source_health, continue_watching_priority_score,
    sanitize_watch_progress, should_skip_watch_progress_save,
};
use super::playback_state::PlaybackStateService;
use super::{normalize_non_empty, now_unix_millis, WatchProgress};
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

fn build_unique_watch_history_entries(
    entries: Vec<(String, WatchProgress)>,
    source_health_priorities: &HashMap<String, u8>,
) -> Vec<WatchProgress> {
    let mut grouped: HashMap<(String, String), Vec<WatchProgress>> = HashMap::new();
    for (_, item) in entries {
        let key = (item.type_.clone(), item.id.clone());
        grouped.entry(key).or_default().push(item);
    }

    let mut unique_map: HashMap<(String, String), WatchProgress> = HashMap::new();
    for (key, items) in grouped {
        if let Some(chosen) =
            choose_watch_history_entry_with_source_health(items, Some(source_health_priorities))
        {
            unique_map.insert(key, chosen);
        }
    }

    let mut list: Vec<WatchProgress> = unique_map.into_values().collect();
    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    list
}

fn build_continue_watching_entries(
    entries: Vec<(String, WatchProgress)>,
    source_health_priorities: &HashMap<String, u8>,
) -> Vec<WatchProgress> {
    let mut grouped: HashMap<(String, String), Vec<WatchProgress>> = HashMap::new();
    for (_, item) in entries {
        let key = (item.type_.clone(), item.id.clone());
        grouped.entry(key).or_default().push(item);
    }

    let mut list = grouped
        .into_values()
        .filter_map(|items| {
            choose_continue_watching_entry_with_source_health(items, Some(source_health_priorities))
        })
        .collect::<Vec<_>>();

    list.sort_by(|left, right| {
        continue_watching_priority_score(right)
            .cmp(&continue_watching_priority_score(left))
            .then_with(|| right.last_watched.cmp(&left.last_watched))
    });

    list
}

#[command]
pub async fn save_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    progress: WatchProgress,
) -> Result<(), String> {
    let mut progress = sanitize_watch_progress(progress)
        .ok_or_else(|| "Invalid media type for watch progress.".to_string())?;
    if progress.id.is_empty() {
        return Err("Media ID is required for watch progress.".to_string());
    }
    if progress.title.is_empty() {
        progress.title = "Untitled".to_string();
    }
    if progress.last_watched == 0 {
        progress.last_watched = now_unix_millis();
    }

    let type_lower = progress.type_.clone();
    let key = build_history_key(&type_lower, &progress.id, progress.season, progress.episode);
    let existing_history = playback_state.get_resume_entry(&app, &key)?;

    if playback_state.should_skip_history_write(&key, &progress, existing_history.as_ref()) {
        return Ok(());
    }

    if let Some(existing) = existing_history.as_ref() {
        if should_skip_watch_progress_save(existing, &progress) {
            return Ok(());
        }
    }

    playback_state.track_progress(&app, &key, &progress)?;
    playback_state.mark_history_persisted(key, progress);

    Ok(())
}

#[command]
pub async fn get_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    let entries = playback_state.load_resume_entries(&app)?;
    let source_health_priorities = playback_state.source_health_priorities_for_names(
        &app,
        entries
            .iter()
            .filter_map(|(_, item)| item.source_name.as_deref()),
    )?;

    Ok(build_unique_watch_history_entries(
        entries,
        &source_health_priorities,
    ))
}

#[command]
pub async fn get_continue_watching(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    let entries = playback_state.load_resume_entries(&app)?;
    let source_health_priorities = playback_state.source_health_priorities_for_names(
        &app,
        entries
            .iter()
            .filter_map(|(_, item)| item.source_name.as_deref()),
    )?;

    Ok(build_continue_watching_entries(
        entries,
        &source_health_priorities,
    ))
}

#[command]
pub async fn get_watch_history_full(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    let mut list: Vec<WatchProgress> = playback_state
        .load_resume_entries(&app)?
        .into_iter()
        .map(|(_, item)| item)
        .collect();

    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    Ok(list)
}

#[command]
pub async fn get_watch_history_for_id(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
) -> Result<Vec<WatchProgress>, String> {
    let trimmed_id = id.trim();
    if trimmed_id.is_empty() {
        return Ok(Vec::new());
    }

    let mut list: Vec<WatchProgress> = playback_state
        .load_resume_entries(&app)?
        .into_iter()
        .filter_map(|(_, item)| {
            if item.id == trimmed_id {
                Some(item)
            } else {
                None
            }
        })
        .collect();

    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    Ok(list)
}

#[command]
pub async fn get_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Option<WatchProgress>, String> {
    let items = playback_state
        .load_resume_entries(&app)?
        .into_iter()
        .map(|(_, item)| item)
        .collect::<Vec<_>>();
    let source_health_priorities = playback_state.source_health_priorities_for_names(
        &app,
        items.iter().filter_map(|item| item.source_name.as_deref()),
    )?;

    Ok(choose_exact_watch_progress_entry_with_source_health(
        items,
        &id,
        &type_,
        season,
        episode,
        Some(&source_health_priorities),
    ))
}

#[command]
pub async fn remove_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<(), String> {
    let type_lower = type_.to_lowercase();
    let key = build_history_key(&type_lower, &id, season, episode);

    let mut removed_keys = Vec::with_capacity(2);

    if playback_state.get_resume_entry(&app, &key)?.is_some() {
        removed_keys.push(key.clone());
    }

    if removed_keys.is_empty() && type_lower == "movie" {
        let fallback_key = format!("series:{}:0:0", id);
        if playback_state
            .get_resume_entry(&app, &fallback_key)?
            .is_some()
        {
            removed_keys.push(fallback_key);
        }
    }

    if !removed_keys.is_empty() {
        playback_state.remove_keys(&app, &removed_keys)?;
        return Ok(());
    }

    Err(format!(
        "Item not found in history (type={}, id={}, s={:?}, e={:?})",
        type_lower, id, season, episode
    ))
}

#[command]
pub async fn remove_all_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
) -> Result<(), String> {
    let Some(id) = normalize_non_empty(&id) else {
        return Ok(());
    };
    let type_lower = type_.to_lowercase();

    let prefixes: Vec<String> = if type_lower == "movie" {
        vec![format!("movie:{}", id), format!("series:{}:0:0", id)]
    } else {
        vec![format!("series:{}:", id), format!("anime:{}:", id)]
    };

    let resume_keys: Vec<String> = playback_state
        .load_resume_entries(&app)?
        .into_iter()
        .map(|(key, _)| key)
        .collect();

    let keys_to_remove: HashSet<String> = resume_keys
        .iter()
        .filter(|key| {
            if type_lower == "movie" {
                prefixes.iter().any(|prefix| *key == prefix)
            } else {
                prefixes
                    .iter()
                    .any(|prefix| key.starts_with(prefix.as_str()))
            }
        })
        .cloned()
        .collect();

    if !keys_to_remove.is_empty() {
        playback_state.remove_keys(&app, &keys_to_remove.into_iter().collect::<Vec<_>>())?;
    }

    Ok(())
}
