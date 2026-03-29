use super::{
    normalize_non_empty, now_unix_millis, PlaybackSessionTouchRequest,
};
use super::history_helpers::{build_history_key, normalize_watch_progress_type};
use super::playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind};
use tauri::{command, AppHandle, State};

#[command]
pub async fn get_playback_stream_reuse_policy(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<super::playback_state::PlaybackStreamReusePolicy, String> {
    let normalized_id = normalize_non_empty(&id)
        .ok_or_else(|| "Media ID is required for stream reuse policy.".to_string())?;
    let normalized_type = normalize_watch_progress_type(&type_)
        .ok_or_else(|| "Invalid media type for stream reuse policy.".to_string())?;
    let key = build_history_key(&normalized_type, &normalized_id, season, episode);
    let resume_entry = playback_state.get_resume_entry(&app, &key)?;

    playback_state.get_stream_reuse_policy(&app, &key, resume_entry.as_ref())
}

#[command]
pub async fn touch_playback_session(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    session: PlaybackSessionTouchRequest,
) -> Result<(), String> {
    let normalized_id = normalize_non_empty(&session.id)
        .ok_or_else(|| "Media ID is required for playback sessions.".to_string())?;
    let normalized_type = normalize_watch_progress_type(&session.type_)
        .ok_or_else(|| "Invalid media type for playback sessions.".to_string())?;
    let title = normalize_non_empty(&session.title).unwrap_or_else(|| normalized_id.clone());
    let key = build_history_key(
        &normalized_type,
        &normalized_id,
        session.absolute_season.or(session.season),
        session.absolute_episode.or(session.episode),
    );

    playback_state.touch_session(
        &app,
        &key,
        &normalized_id,
        &normalized_type,
        session.season,
        session.episode,
        session.absolute_season,
        session.absolute_episode,
        session.stream_season,
        session.stream_episode,
        session.aniskip_episode,
        &title,
        session.stream_url,
        session.stream_format,
        session.stream_lookup_id,
        session.stream_key,
        session.source_name,
        session.stream_family,
        session.position,
        session.duration,
        now_unix_millis(),
    )
}

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