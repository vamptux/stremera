use super::{normalize_non_empty, WatchProgress};

const WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS: f64 = 4.0;
const WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS: f64 = 1.0;
const WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS: u64 = 15_000;

fn normalize_watch_progress_type(type_: &str) -> Option<String> {
    match type_.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie".to_string()),
        "series" | "anime" => Some("series".to_string()),
        _ => None,
    }
}

pub(crate) fn sanitize_watch_progress(mut progress: WatchProgress) -> Option<WatchProgress> {
    progress.id = progress.id.trim().to_string();
    progress.type_ = normalize_watch_progress_type(&progress.type_)?;

    if progress.absolute_season.is_none() {
        progress.absolute_season = progress.season;
    }
    if progress.absolute_episode.is_none() {
        progress.absolute_episode = progress.episode;
    }
    if progress.position.is_nan() || progress.position.is_sign_negative() {
        progress.position = 0.0;
    }
    if progress.duration.is_nan() || progress.duration.is_sign_negative() {
        progress.duration = 0.0;
    }
    if progress.duration > 0.0 && progress.position > progress.duration {
        progress.position = progress.duration;
    }

    progress.title = progress.title.trim().to_string();
    progress.poster = progress.poster.and_then(|s| normalize_non_empty(&s));
    progress.backdrop = progress.backdrop.and_then(|s| normalize_non_empty(&s));
    progress.last_stream_url = progress
        .last_stream_url
        .and_then(|s| normalize_non_empty(&s));
    progress.last_stream_format = progress
        .last_stream_format
        .and_then(|s| normalize_non_empty(&s));
    progress.last_stream_lookup_id = progress
        .last_stream_lookup_id
        .and_then(|s| normalize_non_empty(&s));
    progress.last_stream_key = progress
        .last_stream_key
        .and_then(|s| normalize_non_empty(&s));

    Some(progress)
}

pub(crate) fn should_skip_watch_progress_save(
    existing: &WatchProgress,
    incoming: &WatchProgress,
) -> bool {
    if existing.id != incoming.id
        || existing.type_ != incoming.type_
        || existing.season != incoming.season
        || existing.episode != incoming.episode
    {
        return false;
    }

    let metadata_unchanged = existing.last_stream_url == incoming.last_stream_url
        && existing.last_stream_format == incoming.last_stream_format
        && existing.last_stream_lookup_id == incoming.last_stream_lookup_id
        && existing.last_stream_key == incoming.last_stream_key
        && existing.absolute_season == incoming.absolute_season
        && existing.absolute_episode == incoming.absolute_episode
        && existing.stream_season == incoming.stream_season
        && existing.stream_episode == incoming.stream_episode
        && existing.aniskip_episode == incoming.aniskip_episode
        && existing.title == incoming.title
        && existing.poster == incoming.poster
        && existing.backdrop == incoming.backdrop;

    if !metadata_unchanged {
        return false;
    }

    let watched_delta = incoming.last_watched.saturating_sub(existing.last_watched);
    let position_delta = (incoming.position - existing.position).abs();
    let duration_delta = (incoming.duration - existing.duration).abs();

    watched_delta < WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS
        && position_delta < WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS
        && duration_delta < WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS
}

fn is_series_like_watch_progress(item: &WatchProgress) -> bool {
    matches!(item.type_.as_str(), "series" | "anime")
}

fn watch_progress_absolute_season(item: &WatchProgress) -> Option<u32> {
    item.absolute_season.or(item.season)
}

fn watch_progress_absolute_episode(item: &WatchProgress) -> Option<u32> {
    item.absolute_episode.or(item.episode)
}

fn has_episode_context_watch_progress(item: &WatchProgress) -> bool {
    watch_progress_absolute_season(item).is_some()
        && watch_progress_absolute_episode(item).is_some()
}

fn hydrate_watch_progress_coordinates(item: &mut WatchProgress) {
    if item.absolute_season.is_none() {
        item.absolute_season = item.season;
    }
    if item.absolute_episode.is_none() {
        item.absolute_episode = item.episode;
    }
}

fn merge_watch_progress_coordinates(target: &mut WatchProgress, source: &WatchProgress) {
    if target.season.is_none() {
        target.season = source.season.or(source.absolute_season);
    }
    if target.episode.is_none() {
        target.episode = source.episode.or(source.absolute_episode);
    }
    if target.absolute_season.is_none() {
        target.absolute_season = watch_progress_absolute_season(source);
    }
    if target.absolute_episode.is_none() {
        target.absolute_episode = watch_progress_absolute_episode(source);
    }
    if target.stream_season.is_none() {
        target.stream_season = source.stream_season;
    }
    if target.stream_episode.is_none() {
        target.stream_episode = source.stream_episode;
    }
    if target.aniskip_episode.is_none() {
        target.aniskip_episode = source
            .aniskip_episode
            .or(source.stream_episode)
            .or(source.absolute_episode)
            .or(source.episode);
    }
}

fn has_stream_url_watch_progress(item: &WatchProgress) -> bool {
    item.last_stream_url
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
}

fn has_stream_key_watch_progress(item: &WatchProgress) -> bool {
    item.last_stream_key
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
}

fn has_usable_resume_lookup_id(item: &WatchProgress) -> bool {
    item.last_stream_lookup_id.as_deref().is_some_and(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return false;
        }
        if is_series_like_watch_progress(item) {
            trimmed.starts_with("tt")
        } else {
            true
        }
    })
}

fn has_meaningful_resume_position(item: &WatchProgress) -> bool {
    item.position > WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS
}

fn hydrate_watch_progress_lookup_id(item: &mut WatchProgress) {
    hydrate_watch_progress_coordinates(item);

    if has_usable_resume_lookup_id(item) {
        return;
    }

    let fallback_id = item.id.trim();
    if fallback_id.is_empty() {
        return;
    }

    if is_series_like_watch_progress(item) {
        if fallback_id.starts_with("tt") {
            item.last_stream_lookup_id = Some(fallback_id.to_string());
        }
    } else {
        item.last_stream_lookup_id = Some(fallback_id.to_string());
    }
}

pub(crate) fn choose_watch_history_entry(mut items: Vec<WatchProgress>) -> Option<WatchProgress> {
    items.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));

    let mut chosen = items.first()?.clone();
    hydrate_watch_progress_lookup_id(&mut chosen);

    if !is_series_like_watch_progress(&chosen) {
        return Some(chosen);
    }

    let missing_episode_context = !has_episode_context_watch_progress(&chosen);
    let missing_stream_url = !has_stream_url_watch_progress(&chosen);
    let missing_lookup_id = !has_usable_resume_lookup_id(&chosen);
    let missing_resume_position = !has_meaningful_resume_position(&chosen);
    let missing_duration = chosen.duration <= 0.0;

    if !(missing_episode_context
        || missing_stream_url
        || missing_lookup_id
        || missing_resume_position
        || missing_duration)
    {
        return Some(chosen);
    }

    if let Some(playable) = items.iter().find(|item| {
        has_episode_context_watch_progress(item)
            && has_usable_resume_lookup_id(item)
            && has_meaningful_resume_position(item)
    }) {
        merge_watch_progress_coordinates(&mut chosen, playable);
        chosen.last_stream_lookup_id = playable.last_stream_lookup_id.clone();

        if !has_stream_key_watch_progress(&chosen) {
            chosen.last_stream_key = playable.last_stream_key.clone();
        }

        if missing_resume_position {
            chosen.position = playable.position;
        }
        if chosen.duration <= 0.0 && playable.duration > 0.0 {
            chosen.duration = playable.duration;
        }
        if !has_stream_url_watch_progress(&chosen) && has_stream_url_watch_progress(playable) {
            chosen.last_stream_url = playable.last_stream_url.clone();
            chosen.last_stream_format = playable.last_stream_format.clone();
        }
    }

    if !has_episode_context_watch_progress(&chosen) || !has_usable_resume_lookup_id(&chosen) {
        if let Some(with_episode_context) = items.iter().find(|item| {
            has_episode_context_watch_progress(item) && has_usable_resume_lookup_id(item)
        }) {
            if !has_episode_context_watch_progress(&chosen) {
                merge_watch_progress_coordinates(&mut chosen, with_episode_context);
            }
            if !has_usable_resume_lookup_id(&chosen) {
                chosen.last_stream_lookup_id = with_episode_context.last_stream_lookup_id.clone();
            }
            if !has_stream_key_watch_progress(&chosen) {
                chosen.last_stream_key = with_episode_context.last_stream_key.clone();
            }
            if chosen.duration <= 0.0 && with_episode_context.duration > 0.0 {
                chosen.duration = with_episode_context.duration;
            }
        }
    }

    if !has_stream_url_watch_progress(&chosen) {
        if let Some(with_stream_url) = items
            .iter()
            .find(|item| has_stream_url_watch_progress(item))
        {
            chosen.last_stream_url = with_stream_url.last_stream_url.clone();
            chosen.last_stream_format = with_stream_url.last_stream_format.clone();
            chosen.last_stream_key = with_stream_url.last_stream_key.clone();

            if !has_usable_resume_lookup_id(&chosen) && has_usable_resume_lookup_id(with_stream_url)
            {
                chosen.last_stream_lookup_id = with_stream_url.last_stream_lookup_id.clone();
            }
            if !has_episode_context_watch_progress(&chosen)
                && has_episode_context_watch_progress(with_stream_url)
            {
                merge_watch_progress_coordinates(&mut chosen, with_stream_url);
            }
        }
    }

    if !has_meaningful_resume_position(&chosen) {
        if let Some(with_resume_time) = items
            .iter()
            .find(|item| has_meaningful_resume_position(item))
        {
            chosen.position = with_resume_time.position;
            if chosen.duration <= 0.0 && with_resume_time.duration > 0.0 {
                chosen.duration = with_resume_time.duration;
            }
            if !has_episode_context_watch_progress(&chosen)
                && has_episode_context_watch_progress(with_resume_time)
            {
                merge_watch_progress_coordinates(&mut chosen, with_resume_time);
            }
            if !has_usable_resume_lookup_id(&chosen)
                && has_usable_resume_lookup_id(with_resume_time)
            {
                chosen.last_stream_lookup_id = with_resume_time.last_stream_lookup_id.clone();
            }
            if !has_stream_key_watch_progress(&chosen) {
                chosen.last_stream_key = with_resume_time.last_stream_key.clone();
            }
        }
    }

    if chosen.duration <= 0.0 {
        if let Some(with_duration) = items.iter().find(|item| item.duration > 0.0) {
            chosen.duration = with_duration.duration;
        }
    }

    hydrate_watch_progress_lookup_id(&mut chosen);
    Some(chosen)
}
