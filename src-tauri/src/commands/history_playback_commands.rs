use super::history_helpers::{
    choose_exact_watch_progress_entry_with_source_health, playable_resume_start_time,
    sanitize_watch_progress,
};
use super::media_commands::resolve_episode_stream_mapping_inner;
use super::playback_state::PlaybackStateService;
use super::{normalize_non_empty, WatchProgress};
use crate::providers::{cinemeta::Cinemeta, kitsu::Kitsu};
use serde::Serialize;
use tauri::{command, AppHandle, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum HistoryPlaybackPlanKind {
    Details,
    Player,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HistoryPlaybackPlanReason {
    MissingEpisodeContext,
    MissingSavedStream,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPlaybackRouteState {
    from: Option<String>,
    season: Option<u32>,
    reopen_stream_selector: Option<bool>,
    reopen_stream_season: Option<u32>,
    reopen_stream_episode: Option<u32>,
    reopen_start_time: Option<f64>,
    stream_url: Option<String>,
    title: Option<String>,
    poster: Option<String>,
    backdrop: Option<String>,
    format: Option<String>,
    stream_source_name: Option<String>,
    stream_family: Option<String>,
    selected_stream_key: Option<String>,
    start_time: Option<f64>,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
    aniskip_episode: Option<u32>,
    resume_from_history: Option<bool>,
    stream_lookup_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlaybackPlan {
    kind: HistoryPlaybackPlanKind,
    reason: Option<HistoryPlaybackPlanReason>,
    target: String,
    state: HistoryPlaybackRouteState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryPlaybackMediaType {
    Movie,
    Series,
    Anime,
}

impl HistoryPlaybackMediaType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Anime => "anime",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct HistoryEpisodeContext {
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
    aniskip_episode: Option<u32>,
}

#[derive(Debug, Clone)]
struct ResolvedHistoryEpisodeContext {
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
    aniskip_episode: Option<u32>,
    stream_lookup_id: String,
}

fn normalize_saved_value(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim)?;
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered == "null" || lowered == "undefined" {
        return None;
    }

    Some(trimmed.to_string())
}

fn normalize_history_media_type(item: &WatchProgress) -> HistoryPlaybackMediaType {
    match item.type_.trim().to_ascii_lowercase().as_str() {
        "movie" => HistoryPlaybackMediaType::Movie,
        "anime" => HistoryPlaybackMediaType::Anime,
        _ if item.id.trim().to_ascii_lowercase().starts_with("kitsu:") => {
            HistoryPlaybackMediaType::Anime
        }
        _ => HistoryPlaybackMediaType::Series,
    }
}

fn is_series_like(item: &WatchProgress) -> bool {
    matches!(
        normalize_history_media_type(item),
        HistoryPlaybackMediaType::Series | HistoryPlaybackMediaType::Anime
    )
}

fn has_explicit_stream_episode_context(item: &WatchProgress) -> bool {
    item.stream_season.is_some() && item.stream_episode.is_some()
}

fn is_mapped_anime_history_item(item: &WatchProgress, lookup_id: Option<&str>) -> bool {
    normalize_history_media_type(item) == HistoryPlaybackMediaType::Anime
        && lookup_id.is_some_and(|lookup_id| lookup_id.starts_with("tt"))
        && !item.id.trim().starts_with("tt")
}

fn get_episode_context(item: &WatchProgress) -> HistoryEpisodeContext {
    let absolute_season = item.absolute_season.or(item.season);
    let absolute_episode = item.absolute_episode.or(item.episode);
    let explicit_lookup_id = normalize_saved_value(item.last_stream_lookup_id.as_deref());
    let should_defer_mapped_anime_coordinates = !has_explicit_stream_episode_context(item)
        && is_mapped_anime_history_item(item, explicit_lookup_id.as_deref());
    let stream_season = item.stream_season.or({
        if should_defer_mapped_anime_coordinates {
            None
        } else {
            absolute_season
        }
    });
    let stream_episode = item.stream_episode.or({
        if should_defer_mapped_anime_coordinates {
            None
        } else {
            absolute_episode
        }
    });

    HistoryEpisodeContext {
        absolute_season,
        absolute_episode,
        stream_season,
        stream_episode,
        aniskip_episode: item.aniskip_episode.or({
            if should_defer_mapped_anime_coordinates {
                absolute_episode
            } else {
                stream_episode
            }
        }),
    }
}

fn has_episode_context(item: &WatchProgress) -> bool {
    if !is_series_like(item) {
        return true;
    }

    let context = get_episode_context(item);
    context.absolute_season.is_some() && context.absolute_episode.is_some()
}

fn has_saved_stream(item: &WatchProgress) -> bool {
    normalize_saved_value(item.last_stream_url.as_deref()).is_some()
}

fn get_immediate_stream_lookup_id(item: &WatchProgress) -> String {
    normalize_saved_value(item.last_stream_lookup_id.as_deref())
        .unwrap_or_else(|| item.id.trim().to_string())
}

fn build_player_route(
    media_type: HistoryPlaybackMediaType,
    media_id: &str,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
) -> String {
    match (absolute_season, absolute_episode) {
        (Some(season), Some(episode)) => {
            format!(
                "/player/{}/{}/{}/{}",
                media_type.as_str(),
                media_id,
                season,
                episode
            )
        }
        _ => format!("/player/{}/{}", media_type.as_str(), media_id),
    }
}

fn build_details_target(media_type: HistoryPlaybackMediaType, media_id: &str) -> String {
    format!("/details/{}/{}", media_type.as_str(), media_id)
}

fn build_details_reopen_state(
    from: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    start_time: Option<f64>,
) -> HistoryPlaybackRouteState {
    HistoryPlaybackRouteState {
        from,
        season,
        reopen_stream_selector: Some(true),
        reopen_stream_season: season,
        reopen_stream_episode: episode,
        reopen_start_time: start_time,
        ..HistoryPlaybackRouteState::default()
    }
}

fn build_details_fallback_state(
    item: &WatchProgress,
    from: Option<String>,
    reason: HistoryPlaybackPlanReason,
) -> HistoryPlaybackRouteState {
    let context = get_episode_context(item);
    let resume_start_time = playable_resume_start_time(item);

    if reason == HistoryPlaybackPlanReason::MissingSavedStream {
        return build_details_reopen_state(
            from,
            context.absolute_season,
            if is_series_like(item) {
                context.absolute_episode
            } else {
                None
            },
            resume_start_time,
        );
    }

    HistoryPlaybackRouteState {
        from,
        season: context.absolute_season,
        ..HistoryPlaybackRouteState::default()
    }
}

fn merge_latest_history_metadata(item: &WatchProgress, latest: &mut WatchProgress) {
    if latest.title.trim().is_empty() {
        latest.title = item.title.clone();
    }
    if latest.poster.is_none() {
        latest.poster = item.poster.clone();
    }
    if latest.backdrop.is_none() {
        latest.backdrop = item.backdrop.clone();
    }
}

fn get_latest_history_playback_item(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    item: &WatchProgress,
) -> Result<WatchProgress, String> {
    let items = playback_state
        .load_resume_entries(app)?
        .into_iter()
        .map(|(_, item)| item)
        .collect::<Vec<_>>();
    let source_health_priorities = playback_state.source_health_priorities_for_names(
        app,
        items
            .iter()
            .filter_map(|entry| entry.source_name.as_deref()),
    )?;
    let context = get_episode_context(item);

    if let Some(mut latest) = choose_exact_watch_progress_entry_with_source_health(
        items,
        &item.id,
        &item.type_,
        context.absolute_season,
        context.absolute_episode,
        Some(&source_health_priorities),
    ) {
        merge_latest_history_metadata(item, &mut latest);
        return Ok(latest);
    }

    Ok(item.clone())
}

async fn resolve_history_episode_context(
    app: AppHandle,
    playback_state: &PlaybackStateService,
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    item: &WatchProgress,
) -> ResolvedHistoryEpisodeContext {
    let base_context = get_episode_context(item);
    let stream_lookup_id = get_immediate_stream_lookup_id(item);
    let needs_mapping = base_context.absolute_season.is_some()
        && base_context.absolute_episode.is_some()
        && (base_context.stream_season.is_none() || base_context.stream_episode.is_none());

    if needs_mapping {
        if let Ok(Some(mapping)) = resolve_episode_stream_mapping_inner(
            app,
            playback_state,
            cinemeta_provider,
            kitsu_provider,
            normalize_history_media_type(item).as_str(),
            &item.id,
            base_context.absolute_season.unwrap_or_default(),
            base_context.absolute_episode.unwrap_or_default(),
        )
        .await
        {
            return ResolvedHistoryEpisodeContext {
                absolute_season: Some(mapping.canonical_season),
                absolute_episode: Some(mapping.canonical_episode),
                stream_season: Some(mapping.source_season),
                stream_episode: Some(mapping.source_episode),
                aniskip_episode: Some(mapping.aniskip_episode),
                stream_lookup_id: mapping.lookup_id,
            };
        }
    }

    ResolvedHistoryEpisodeContext {
        absolute_season: base_context.absolute_season,
        absolute_episode: base_context.absolute_episode,
        stream_season: base_context.stream_season,
        stream_episode: base_context.stream_episode,
        aniskip_episode: base_context.aniskip_episode,
        stream_lookup_id,
    }
}

#[command]
pub async fn build_history_playback_plan(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    item: WatchProgress,
    from: String,
) -> Result<HistoryPlaybackPlan, String> {
    let mut item = sanitize_watch_progress(item)
        .ok_or_else(|| "Invalid media type for history playback planning.".to_string())?;
    item.id = normalize_non_empty(&item.id)
        .ok_or_else(|| "Media ID is required for history playback planning.".to_string())?;

    let latest_item = get_latest_history_playback_item(&app, playback_state.inner(), &item)?;
    let playback_type = normalize_history_media_type(&latest_item);
    let from = normalize_saved_value(Some(from.as_str()));

    if !has_episode_context(&latest_item) {
        return Ok(HistoryPlaybackPlan {
            kind: HistoryPlaybackPlanKind::Details,
            reason: Some(HistoryPlaybackPlanReason::MissingEpisodeContext),
            target: build_details_target(playback_type, &latest_item.id),
            state: build_details_fallback_state(
                &latest_item,
                from.clone(),
                HistoryPlaybackPlanReason::MissingEpisodeContext,
            ),
        });
    }

    if !has_saved_stream(&latest_item) {
        return Ok(HistoryPlaybackPlan {
            kind: HistoryPlaybackPlanKind::Details,
            reason: Some(HistoryPlaybackPlanReason::MissingSavedStream),
            target: build_details_target(playback_type, &latest_item.id),
            state: build_details_fallback_state(
                &latest_item,
                from.clone(),
                HistoryPlaybackPlanReason::MissingSavedStream,
            ),
        });
    }

    let resolved_context = resolve_history_episode_context(
        app,
        playback_state.inner(),
        cinemeta_provider.inner(),
        kitsu_provider.inner(),
        &latest_item,
    )
    .await;

    Ok(HistoryPlaybackPlan {
        kind: HistoryPlaybackPlanKind::Player,
        reason: None,
        target: build_player_route(
            playback_type,
            &latest_item.id,
            resolved_context.absolute_season,
            resolved_context.absolute_episode,
        ),
        state: HistoryPlaybackRouteState {
            from,
            stream_url: normalize_saved_value(latest_item.last_stream_url.as_deref()),
            title: normalize_saved_value(Some(latest_item.title.as_str())),
            poster: latest_item.poster.clone(),
            backdrop: latest_item.backdrop.clone(),
            format: normalize_saved_value(latest_item.last_stream_format.as_deref()),
            stream_source_name: normalize_saved_value(latest_item.source_name.as_deref()),
            stream_family: normalize_saved_value(latest_item.stream_family.as_deref()),
            selected_stream_key: normalize_saved_value(latest_item.last_stream_key.as_deref()),
            start_time: playable_resume_start_time(&latest_item),
            absolute_season: resolved_context.absolute_season,
            absolute_episode: resolved_context.absolute_episode,
            stream_season: resolved_context.stream_season,
            stream_episode: resolved_context.stream_episode,
            aniskip_episode: resolved_context.aniskip_episode,
            resume_from_history: Some(true),
            stream_lookup_id: Some(resolved_context.stream_lookup_id),
            ..HistoryPlaybackRouteState::default()
        },
    })
}
