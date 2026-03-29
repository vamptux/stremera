use super::{
    now_unix_millis, normalize_non_empty, WatchProgress,
};
use super::history_helpers::{
    build_history_key, choose_continue_watching_entry, choose_exact_watch_progress_entry,
    choose_watch_history_entry, continue_watching_priority_score, sanitize_watch_progress,
    should_skip_watch_progress_save,
};
use super::playback_state::{PlaybackStateService, PlaybackStreamReusePolicy};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

fn build_unique_watch_history_entries(entries: Vec<(String, WatchProgress)>) -> Vec<WatchProgress> {
    let mut grouped: HashMap<(String, String), Vec<WatchProgress>> = HashMap::new();
    for (_, item) in entries {
        let key = (item.type_.clone(), item.id.clone());
        grouped.entry(key).or_default().push(item);
    }

    let mut unique_map: HashMap<(String, String), WatchProgress> = HashMap::new();
    for (key, items) in grouped {
        if let Some(chosen) = choose_watch_history_entry(items) {
            unique_map.insert(key, chosen);
        }
    }

    let mut list: Vec<WatchProgress> = unique_map.into_values().collect();
    list.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));
    list
}

pub(crate) fn continue_watching_resumability_confidence(
    item: &WatchProgress,
    policy: &PlaybackStreamReusePolicy,
) -> i32 {
    let mut score = 0;

    if policy.can_reuse_directly {
        score += match policy.kind.as_str() {
            "local-file" | "localhost" => 150,
            _ => 120,
        };
    } else if !policy.should_bypass && policy.is_remote {
        score += 55;
    }

    if policy.last_verified_at.is_some() {
        score += 35;
    }
    if item.last_stream_lookup_id.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        score += 16;
    }
    if item.last_stream_key.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        score += 10;
    }
    if item.source_name.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        score += 8;
    }
    if item.stream_family.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        score += 8;
    }

    if policy.last_failure_reason.is_some() {
        score -= 14;
    }
    if policy.consecutive_failures >= 2 {
        score -= 24;
    } else if policy.consecutive_failures == 1 {
        score -= 10;
    }
    if policy.cooldown_until.is_some() {
        score -= 45;
    }
    if policy.should_bypass {
        score -= 70;
    }

    score
}

pub(crate) fn compare_continue_watching_candidates(
    left: &WatchProgress,
    left_policy: &PlaybackStreamReusePolicy,
    right: &WatchProgress,
    right_policy: &PlaybackStreamReusePolicy,
) -> Ordering {
    continue_watching_resumability_confidence(right, right_policy)
        .cmp(&continue_watching_resumability_confidence(left, left_policy))
        .then_with(|| {
            continue_watching_priority_score(right).cmp(&continue_watching_priority_score(left))
        })
        .then_with(|| right.last_watched.cmp(&left.last_watched))
}

fn build_continue_watching_entries(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    entries: Vec<(String, WatchProgress)>,
) -> Result<Vec<WatchProgress>, String> {
    let mut grouped: HashMap<(String, String), Vec<WatchProgress>> = HashMap::new();
    for (_, item) in entries {
        let key = (item.type_.clone(), item.id.clone());
        grouped.entry(key).or_default().push(item);
    }

    let mut list = grouped
        .into_values()
        .filter_map(choose_continue_watching_entry)
        .collect::<Vec<_>>();

    let mut with_policy = Vec::with_capacity(list.len());
    for item in list.drain(..) {
        let key = build_history_key(&item.type_, &item.id, item.season, item.episode);
        let policy = playback_state.get_stream_reuse_policy(app, &key, Some(&item))?;
        with_policy.push((item, policy));
    }

    with_policy.sort_by(|(left_item, left_policy), (right_item, right_policy)| {
        compare_continue_watching_candidates(left_item, left_policy, right_item, right_policy)
    });

    Ok(with_policy.into_iter().map(|(item, _)| item).collect())
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
    Ok(build_unique_watch_history_entries(
        playback_state.load_resume_entries(&app)?,
    ))
}

#[command]
pub async fn get_continue_watching(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    build_continue_watching_entries(
        &app,
        &playback_state,
        playback_state.load_resume_entries(&app)?,
    )
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
        .filter_map(|(_, item)| if item.id == trimmed_id { Some(item) } else { None })
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
    Ok(choose_exact_watch_progress_entry(
        playback_state
            .load_resume_entries(&app)?
            .into_iter()
            .map(|(_, item)| item)
            .collect(),
        &id,
        &type_,
        season,
        episode,
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
        if playback_state.get_resume_entry(&app, &fallback_key)?.is_some() {
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
        vec![
            format!("movie:{}", id),
            format!("series:{}:0:0", id),
        ]
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
                prefixes.iter().any(|prefix| key.starts_with(prefix.as_str()))
            }
        })
        .cloned()
        .collect();

    if !keys_to_remove.is_empty() {
        playback_state.remove_keys(&app, &keys_to_remove.into_iter().collect::<Vec<_>>())?;
    }

    Ok(())
}