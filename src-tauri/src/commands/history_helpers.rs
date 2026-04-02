use super::{normalize_non_empty, WatchProgress};
use std::collections::HashMap;

const WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS: f64 = 4.0;
const WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS: f64 = 1.0;
const WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS: u64 = 15_000;
const WATCH_PROGRESS_NEAR_COMPLETION_RATIO: f64 = 0.97;
const WATCH_PROGRESS_NEAR_COMPLETION_REMAINING_SECS: f64 = 30.0;
const WATCH_PROGRESS_NEAR_COMPLETION_MIN_DURATION_SECS: f64 = 60.0;
const WATCH_PROGRESS_MIN_RESUME_POSITION_SECS: f64 = 5.0;
const WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO: f64 = 0.95;
const WATCH_PROGRESS_LOW_CONFIDENCE_EARLY_POSITION_SECS: f64 = 90.0;
const WATCH_PROGRESS_LOW_CONFIDENCE_PROGRESS_RATIO: f64 = 0.08;
const WATCH_PROGRESS_BETTER_RESUME_POSITION_DELTA_SECS: f64 = 45.0;
const WATCH_PROGRESS_BETTER_RESUME_PROGRESS_RATIO_DELTA: f64 = 0.12;

type WatchProgressEpisodeIdentity = (Option<u32>, Option<u32>, Option<u32>, Option<u32>);
type SourceHealthPriorityMap = HashMap<String, u8>;

pub(crate) fn build_history_key(
    type_lower: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> String {
    if type_lower == "movie" {
        format!("movie:{}", id)
    } else {
        format!(
            "series:{}:{}:{}",
            id,
            season.unwrap_or(0),
            episode.unwrap_or(0)
        )
    }
}

pub(crate) fn normalize_watch_progress_type(type_: &str) -> Option<String> {
    match type_.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie".to_string()),
        "series" | "anime" => Some("series".to_string()),
        _ => None,
    }
}

pub(crate) fn sanitize_watch_progress(mut progress: WatchProgress) -> Option<WatchProgress> {
    progress.id = progress.id.trim().to_string();
    progress.type_ = normalize_watch_progress_type(&progress.type_)?;
    progress.resume_start_time = None;

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
    progress.source_name = progress.source_name.and_then(|s| normalize_non_empty(&s));
    progress.stream_family = progress.stream_family.and_then(|s| normalize_non_empty(&s));

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
        && existing.source_name == incoming.source_name
        && existing.stream_family == incoming.stream_family
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

    let existing_near_completion = is_near_completion_watch_progress(existing);
    let incoming_near_completion = is_near_completion_watch_progress(incoming);

    if incoming_near_completion && !existing_near_completion {
        return false;
    }

    let watched_delta = incoming.last_watched.saturating_sub(existing.last_watched);
    let position_delta = (incoming.position - existing.position).abs();
    let duration_delta = (incoming.duration - existing.duration).abs();

    watched_delta < WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS
        && position_delta < WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS
        && duration_delta < WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS
}

fn is_near_completion_watch_progress(item: &WatchProgress) -> bool {
    if item.duration < WATCH_PROGRESS_NEAR_COMPLETION_MIN_DURATION_SECS || item.position <= 0.0 {
        return false;
    }

    let remaining = (item.duration - item.position).max(0.0);
    let progress_ratio = if item.duration > 0.0 {
        item.position / item.duration
    } else {
        0.0
    };

    remaining <= WATCH_PROGRESS_NEAR_COMPLETION_REMAINING_SECS
        || progress_ratio >= WATCH_PROGRESS_NEAR_COMPLETION_RATIO
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

fn matches_exact_watch_progress_episode(
    item: &WatchProgress,
    season: Option<u32>,
    episode: Option<u32>,
) -> bool {
    match (season, episode) {
        (Some(season), Some(episode)) => {
            (watch_progress_absolute_season(item) == Some(season)
                && watch_progress_absolute_episode(item) == Some(episode))
                || (item.season == Some(season) && item.episode == Some(episode))
        }
        (None, None) => !is_series_like_watch_progress(item),
        _ => false,
    }
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

fn has_source_name_watch_progress(item: &WatchProgress) -> bool {
    item.source_name
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn has_stream_family_watch_progress(item: &WatchProgress) -> bool {
    item.stream_family
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn has_source_binding_watch_progress(item: &WatchProgress) -> bool {
    has_usable_resume_lookup_id(item)
        || has_stream_key_watch_progress(item)
        || has_source_name_watch_progress(item)
        || has_stream_family_watch_progress(item)
        || has_stream_url_watch_progress(item)
}

fn normalize_watch_progress_source_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn watch_progress_source_priority(
    item: &WatchProgress,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) -> u8 {
    let Some(source_health_priorities) = source_health_priorities else {
        return 2;
    };

    let Some(source_name) = item
        .source_name
        .as_deref()
        .and_then(normalize_watch_progress_source_name)
    else {
        return 2;
    };

    source_health_priorities
        .get(source_name.as_str())
        .copied()
        .unwrap_or(2)
}

fn same_source_watch_progress(left: &WatchProgress, right: &WatchProgress) -> bool {
    let Some(left_source) = left
        .source_name
        .as_deref()
        .and_then(normalize_watch_progress_source_name)
    else {
        return false;
    };
    let Some(right_source) = right
        .source_name
        .as_deref()
        .and_then(normalize_watch_progress_source_name)
    else {
        return false;
    };

    left_source == right_source
}

fn replace_source_metadata_from_donor(target: &mut WatchProgress, donor: &WatchProgress) {
    target.last_stream_lookup_id = donor.last_stream_lookup_id.clone();
    target.last_stream_key = donor.last_stream_key.clone();
    target.source_name = donor.source_name.clone();
    target.stream_family = donor.stream_family.clone();
    target.last_stream_url = donor.last_stream_url.clone();
    target.last_stream_format = donor.last_stream_format.clone();
}

fn merge_missing_source_metadata_from_donor(target: &mut WatchProgress, donor: &WatchProgress) {
    if !has_usable_resume_lookup_id(target) && has_usable_resume_lookup_id(donor) {
        target.last_stream_lookup_id = donor.last_stream_lookup_id.clone();
    }
    if !has_stream_key_watch_progress(target) && has_stream_key_watch_progress(donor) {
        target.last_stream_key = donor.last_stream_key.clone();
    }
    if !has_source_name_watch_progress(target) && has_source_name_watch_progress(donor) {
        target.source_name = donor.source_name.clone();
    }
    if !has_stream_family_watch_progress(target) && has_stream_family_watch_progress(donor) {
        target.stream_family = donor.stream_family.clone();
    }
    if !has_stream_url_watch_progress(target) && has_stream_url_watch_progress(donor) {
        target.last_stream_url = donor.last_stream_url.clone();
        target.last_stream_format = donor.last_stream_format.clone();
    }
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
    item.position >= WATCH_PROGRESS_MIN_RESUME_POSITION_SECS
}

pub(crate) fn playable_resume_start_time(item: &WatchProgress) -> Option<f64> {
    if !item.position.is_finite() || item.position < WATCH_PROGRESS_MIN_RESUME_POSITION_SECS {
        return None;
    }

    if item.duration.is_finite()
        && item.duration > 0.0
        && item.position / item.duration >= WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO
    {
        return None;
    }

    Some(item.position)
}

pub(crate) fn annotate_resume_start_time(item: &mut WatchProgress) {
    item.resume_start_time = playable_resume_start_time(item);
}

fn watch_progress_ratio(item: &WatchProgress) -> f64 {
    if item.duration > 0.0 {
        (item.position / item.duration).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn is_low_confidence_resume_position(item: &WatchProgress) -> bool {
    has_meaningful_resume_position(item)
        && item.position <= WATCH_PROGRESS_LOW_CONFIDENCE_EARLY_POSITION_SECS
        && (item.duration <= 0.0
            || watch_progress_ratio(item) <= WATCH_PROGRESS_LOW_CONFIDENCE_PROGRESS_RATIO)
}

fn donor_can_supply_episode_resume(target: &WatchProgress, donor: &WatchProgress) -> bool {
    if !has_meaningful_resume_position(donor) {
        return false;
    }

    !has_episode_context_watch_progress(target)
        || watch_progress_episode_affinity(target, donor) > 0
}

fn donor_has_materially_better_resume(target: &WatchProgress, donor: &WatchProgress) -> bool {
    if !donor_can_supply_episode_resume(target, donor) {
        return false;
    }

    if donor.position <= target.position || !is_low_confidence_resume_position(target) {
        return false;
    }

    let position_delta = donor.position - target.position;
    let progress_ratio_delta =
        (watch_progress_ratio(donor) - watch_progress_ratio(target)).max(0.0);

    position_delta >= WATCH_PROGRESS_BETTER_RESUME_POSITION_DELTA_SECS
        || progress_ratio_delta >= WATCH_PROGRESS_BETTER_RESUME_PROGRESS_RATIO_DELTA
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

fn watch_progress_episode_identity(item: &WatchProgress) -> WatchProgressEpisodeIdentity {
    (
        watch_progress_absolute_season(item),
        watch_progress_absolute_episode(item),
        item.season,
        item.episode,
    )
}

pub(crate) fn continue_watching_priority_score(item: &WatchProgress) -> u32 {
    let mut score = 0;

    if has_meaningful_resume_position(item) {
        score += if is_low_confidence_resume_position(item) {
            45
        } else {
            100
        };
        score += (watch_progress_ratio(item) * 20.0).round() as u32;
    } else if item.position > 0.0 {
        score += 30;
    }

    if item.duration > 0.0 {
        score += 20;
    }
    if has_usable_resume_lookup_id(item) {
        score += 12;
    }
    if has_stream_url_watch_progress(item) {
        score += 10;
    }
    if has_stream_key_watch_progress(item) {
        score += 6;
    }
    if has_source_name_watch_progress(item) {
        score += 4;
    }
    if has_stream_family_watch_progress(item) {
        score += 4;
    }
    if has_episode_context_watch_progress(item) {
        score += 5;
    }

    score
}

fn has_complete_resume_snapshot(item: &WatchProgress) -> bool {
    has_episode_context_watch_progress(item)
        && has_stream_url_watch_progress(item)
        && has_usable_resume_lookup_id(item)
        && has_meaningful_resume_position(item)
        && item.duration > 0.0
}

fn watch_progress_episode_affinity(reference: &WatchProgress, candidate: &WatchProgress) -> u32 {
    let reference_absolute = (
        watch_progress_absolute_season(reference),
        watch_progress_absolute_episode(reference),
    );
    let candidate_absolute = (
        watch_progress_absolute_season(candidate),
        watch_progress_absolute_episode(candidate),
    );

    if reference_absolute.0.is_some()
        && reference_absolute.1.is_some()
        && reference_absolute == candidate_absolute
    {
        return 40;
    }

    if reference.season.is_some()
        && reference.episode.is_some()
        && reference.season == candidate.season
        && reference.episode == candidate.episode
    {
        return 28;
    }

    0
}

fn watch_progress_quality_score(
    reference: &WatchProgress,
    candidate: &WatchProgress,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) -> u32 {
    let mut score = watch_progress_episode_affinity(reference, candidate);

    if has_episode_context_watch_progress(candidate) {
        score += 20;
    }
    if has_usable_resume_lookup_id(candidate) {
        score += 20;
    }
    if has_meaningful_resume_position(candidate) {
        score += 16;
    }
    if candidate.duration > 0.0 {
        score += 12;
    }
    if has_stream_url_watch_progress(candidate) {
        score += 10;
    }
    if has_stream_key_watch_progress(candidate) {
        score += 6;
    }
    if has_source_name_watch_progress(candidate) {
        score += 4;
    }
    if has_stream_family_watch_progress(candidate) {
        score += 4;
    }

    match watch_progress_source_priority(candidate, source_health_priorities) {
        0 => score = score.saturating_sub(24),
        1 => score = score.saturating_sub(12),
        3 => score += 6,
        _ => {}
    }

    score
}

fn merge_watch_progress_from_donor(
    target: &mut WatchProgress,
    donor: &WatchProgress,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) {
    let donor_can_supply_resume = donor_can_supply_episode_resume(target, donor);
    let should_prefer_donor_resume = donor_can_supply_resume
        && (!has_meaningful_resume_position(target)
            || donor_has_materially_better_resume(target, donor));

    let target_has_source_binding = has_source_binding_watch_progress(target);
    let donor_has_source_binding = has_source_binding_watch_progress(donor);
    let target_source_priority = watch_progress_source_priority(target, source_health_priorities);
    let donor_source_priority = watch_progress_source_priority(donor, source_health_priorities);
    let same_source = same_source_watch_progress(target, donor);
    let should_replace_source_metadata = donor_can_supply_resume
        && target_has_source_binding
        && donor_has_source_binding
        && !same_source
        && donor_source_priority > target_source_priority;
    let can_merge_missing_source_metadata = donor_has_source_binding
        && (!target_has_source_binding
            || same_source
            || donor_source_priority > target_source_priority);

    merge_watch_progress_coordinates(target, donor);

    if should_replace_source_metadata {
        replace_source_metadata_from_donor(target, donor);
    } else if can_merge_missing_source_metadata {
        merge_missing_source_metadata_from_donor(target, donor);
    }
    if should_prefer_donor_resume {
        target.position = donor.position;
    }
    if should_prefer_donor_resume && donor.duration > 0.0 {
        target.duration = donor.duration;
    }
    if target.poster.is_none() && donor.poster.is_some() {
        target.poster = donor.poster.clone();
    }
    if target.backdrop.is_none() && donor.backdrop.is_some() {
        target.backdrop = donor.backdrop.clone();
    }
}

#[cfg(test)]
pub(crate) fn choose_watch_history_entry(items: Vec<WatchProgress>) -> Option<WatchProgress> {
    choose_watch_history_entry_with_source_health(items, None)
}

pub(crate) fn choose_watch_history_entry_with_source_health(
    mut items: Vec<WatchProgress>,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) -> Option<WatchProgress> {
    items.sort_by(|a, b| b.last_watched.cmp(&a.last_watched));

    let mut chosen = items.first()?.clone();
    hydrate_watch_progress_lookup_id(&mut chosen);

    if !is_series_like_watch_progress(&chosen) {
        return Some(chosen);
    }

    if has_complete_resume_snapshot(&chosen) {
        return Some(chosen);
    }

    let mut donors = items;
    donors.sort_by(|left, right| {
        watch_progress_quality_score(&chosen, right, source_health_priorities)
            .cmp(&watch_progress_quality_score(
                &chosen,
                left,
                source_health_priorities,
            ))
            .then_with(|| right.last_watched.cmp(&left.last_watched))
    });

    for mut donor in donors {
        hydrate_watch_progress_lookup_id(&mut donor);
        merge_watch_progress_from_donor(&mut chosen, &donor, source_health_priorities);

        if has_complete_resume_snapshot(&chosen) {
            break;
        }
    }

    hydrate_watch_progress_lookup_id(&mut chosen);
    Some(chosen)
}

#[cfg(test)]
pub(crate) fn choose_continue_watching_entry(items: Vec<WatchProgress>) -> Option<WatchProgress> {
    choose_continue_watching_entry_with_source_health(items, None)
}

pub(crate) fn choose_continue_watching_entry_with_source_health(
    items: Vec<WatchProgress>,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) -> Option<WatchProgress> {
    if items.is_empty() {
        return None;
    }

    if !items.iter().any(is_series_like_watch_progress) {
        return choose_watch_history_entry_with_source_health(items, source_health_priorities)
            .filter(is_continue_watching_candidate);
    }

    let mut grouped: std::collections::HashMap<WatchProgressEpisodeIdentity, Vec<WatchProgress>> =
        std::collections::HashMap::new();

    for item in items {
        grouped
            .entry(watch_progress_episode_identity(&item))
            .or_default()
            .push(item);
    }

    let mut candidates = grouped
        .into_values()
        .filter_map(|group| {
            choose_watch_history_entry_with_source_health(group, source_health_priorities)
        })
        .filter(is_continue_watching_candidate)
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        continue_watching_priority_score(right)
            .cmp(&continue_watching_priority_score(left))
            .then_with(|| right.last_watched.cmp(&left.last_watched))
    });

    candidates.into_iter().next()
}

#[cfg(test)]
pub(crate) fn choose_exact_watch_progress_entry(
    items: Vec<WatchProgress>,
    media_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> Option<WatchProgress> {
    choose_exact_watch_progress_entry_with_source_health(
        items, media_id, media_type, season, episode, None,
    )
}

pub(crate) fn choose_exact_watch_progress_entry_with_source_health(
    items: Vec<WatchProgress>,
    media_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
    source_health_priorities: Option<&SourceHealthPriorityMap>,
) -> Option<WatchProgress> {
    let normalized_type = normalize_watch_progress_type(media_type)?;

    let normalized_id = media_id.trim();
    if normalized_id.is_empty() {
        return None;
    }

    let matching_items = items
        .into_iter()
        .filter(|item| {
            item.id == normalized_id
                && normalize_watch_progress_type(&item.type_).as_deref()
                    == Some(normalized_type.as_str())
        })
        .filter(|item| matches_exact_watch_progress_episode(item, season, episode))
        .collect::<Vec<_>>();

    choose_watch_history_entry_with_source_health(matching_items, source_health_priorities)
}

pub(crate) fn is_continue_watching_candidate(item: &WatchProgress) -> bool {
    playable_resume_start_time(item).is_some()
}
