use super::{
    has_playable_stream_source, is_http_url, is_placeholder_no_stream, normalize_non_empty,
    normalize_stream_media_type, BEST_STREAM_MAX_CANDIDATES, SETTINGS_STORE_FILE,
};
use super::config_store::get_effective_playback_rd_token;
use crate::providers::{
    cinemeta::Cinemeta, kitsu::Kitsu, realdebrid::RealDebrid, stremio_addon::StremioAddonTransport,
};
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

use super::episode_navigation::{self, NextPlaybackPlan, PreparedPlaybackStream};
use super::media_commands::fetch_media_details_inner;
use super::playback_state::PlaybackStateService;
use super::stream_fetcher::{fetch_ranked_streams, StreamQueryRequest, StreamRankingScope};
use super::stream_resolver::{
    is_auth_error, is_missing_debrid_config_error, resolve_stream_inner, ResolveStreamParams,
};
use super::streaming_helpers::build_magnet;

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn prepare_next_playback_plan(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    addon_transport: State<'_, StremioAddonTransport>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    current_season: u32,
    current_episode: u32,
    current_stream_lookup_id: Option<String>,
) -> Result<Option<NextPlaybackPlan>, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for next playback planning.".to_string())?;

    if media_type == "movie" {
        return Ok(None);
    }

    let details =
        fetch_media_details_inner(&cinemeta_provider, &kitsu_provider, &media_type, &id, true)
            .await?;
    let Some(episodes) = details.episodes.as_ref() else {
        return Ok(None);
    };

    let fallback_lookup_id = details.imdb_id.as_deref().unwrap_or(id.as_str());
    playback_state.cache_episode_mappings(
        &app,
        &media_type,
        &id,
        Some(fallback_lookup_id),
        episodes,
    )?;

    let fallback_lookup_id = current_stream_lookup_id
        .and_then(|value| normalize_non_empty(&value))
        .or_else(|| details.imdb_id.clone())
        .unwrap_or_else(|| id.clone());

    let Some(mut plan) = episode_navigation::build_next_playback_plan(
        episodes,
        current_season,
        current_episode,
        &media_type,
        &fallback_lookup_id,
    ) else {
        return Ok(None);
    };

    let ranked_streams = fetch_ranked_streams(
        &app,
        &playback_state,
        &addon_transport,
        &rd_provider,
        &StreamQueryRequest {
            media_type: &media_type,
            id: &plan.source.lookup_id,
            season: Some(plan.source.season),
            episode: Some(plan.source.episode),
            absolute_episode: Some(plan.canonical.episode),
        },
        &StreamRankingScope {
            media_type: media_type.clone(),
            media_id: id.clone(),
            season: Some(plan.canonical.season),
            episode: Some(plan.canonical.episode),
        },
    )
    .await?;

    let playable_streams = ranked_streams
        .into_iter()
        .filter(|stream| !is_placeholder_no_stream(stream) && has_playable_stream_source(stream))
        .collect::<Vec<_>>();

    if playable_streams.is_empty() {
        return Ok(Some(plan));
    }

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);
    let mut prepared = Vec::with_capacity(2);
    let mut seen_urls = std::collections::HashSet::new();

    for stream in playable_streams.iter().take(BEST_STREAM_MAX_CANDIDATES) {
        let direct_url = stream
            .url
            .as_deref()
            .filter(|url| is_http_url(url))
            .map(|url| url.to_string());
        let magnet = build_magnet(stream.url.as_deref(), stream.info_hash.as_deref());

        if direct_url.is_none() && magnet.is_none() {
            continue;
        }

        let result = resolve_stream_inner(
            &rd_provider,
            token.as_deref(),
            ResolveStreamParams {
                magnet: magnet.unwrap_or_default(),
                info_hash: stream.info_hash.clone(),
                file_idx: stream.file_idx.map(|value| value as usize),
                season: Some(plan.source.season),
                episode: Some(plan.source.episode),
                url: direct_url,
            },
        )
        .await;

        match result {
            Ok(resolved) => {
                if !seen_urls.insert(resolved.url.clone()) {
                    continue;
                }

                prepared.push(PreparedPlaybackStream {
                    url: resolved.url,
                    format: resolved.format,
                    source_name: stream.source_name.clone(),
                    stream_family: stream.stream_family.clone(),
                });

                if prepared.len() >= 2 {
                    break;
                }
            }
            Err(error) if is_auth_error(&error) || is_missing_debrid_config_error(&error) => {
                continue;
            }
            Err(_) => continue,
        }
    }

    if let Some(primary) = prepared.first().cloned() {
        plan.primary_stream = Some(primary);
    }
    if let Some(backup) = prepared.get(1).cloned() {
        plan.backup_stream = Some(backup);
    }

    Ok(Some(plan))
}