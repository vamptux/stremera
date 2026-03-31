use super::history_helpers::{build_history_key, normalize_watch_progress_type};
use super::playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind};
use super::{normalize_non_empty, now_unix_millis};
use tauri::{command, AppHandle, State};

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn report_playback_stream_outcome(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
    source_name: Option<String>,
    stream_family: Option<String>,
    stream_url: Option<String>,
    stream_format: Option<String>,
    stream_lookup_id: Option<String>,
    stream_key: Option<String>,
    outcome: String,
) -> Result<(), String> {
    let normalized_id = normalize_non_empty(&id)
        .ok_or_else(|| "Media ID is required for stream outcome reporting.".to_string())?;
    let normalized_type = normalize_watch_progress_type(&type_)
        .ok_or_else(|| "Invalid media type for stream outcome reporting.".to_string())?;
    let normalized_outcome = PlaybackStreamOutcomeKind::parse(&outcome)
        .ok_or_else(|| "Invalid playback stream outcome.".to_string())?;
    let key = build_history_key(&normalized_type, &normalized_id, season, episode);

    playback_state.record_stream_outcome(
        &app,
        &key,
        &normalized_id,
        &normalized_type,
        season,
        episode,
        source_name,
        stream_family,
        stream_url,
        stream_format,
        stream_lookup_id,
        stream_key,
        normalized_outcome,
        now_unix_millis(),
    )
}
