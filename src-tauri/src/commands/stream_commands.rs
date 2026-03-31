use super::{
    config_store::{get_effective_playback_rd_token, normalize_addon_url},
    normalize_non_empty, normalize_stream_media_type,
    playback_state::PlaybackStateService,
    stream_fetcher::{
        fetch_prepared_streams_for_addon, fetch_ranked_streams, resolve_stream_ranking_scope,
        StreamQueryRequest,
    },
    stream_resolver::{
        is_auth_error, is_missing_debrid_config_error, missing_debrid_provider_message,
        resolve_stream_inner, BestResolvedStream, ResolveStreamParams, ResolvedStream,
    },
    streaming_helpers::{
        build_magnet, build_stream_query_ids, has_playable_stream_source, is_http_url,
        is_placeholder_no_stream, normalize_http_url,
    },
    BEST_STREAM_CANDIDATE_TIMEOUT_SECS, BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS,
    BEST_STREAM_MAX_CANDIDATES, SETTINGS_STORE_FILE,
};
use crate::providers::{
    realdebrid::RealDebrid,
    addons::{AddonTransport, TorrentioStream},
};
use std::time::Duration;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_streams(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    provider: State<'_, AddonTransport>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Vec<TorrentioStream>, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let ranking = resolve_stream_ranking_scope(
        &media_type,
        &id,
        season,
        episode,
        ranking_media_type,
        ranking_media_id,
        ranking_title,
        ranking_season,
        ranking_episode,
    )?;

    fetch_ranked_streams(
        &app,
        &playback_state,
        &provider,
        &rd_provider,
        &StreamQueryRequest {
            media_type: &media_type,
            id: &id,
            season,
            episode,
            absolute_episode,
        },
        &ranking,
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_streams_for_addon(
    app: AppHandle,
    provider: State<'_, AddonTransport>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    addon_url: String,
    addon_name: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Result<Vec<TorrentioStream>, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let addon_url = normalize_addon_url(&addon_url)?
        .ok_or_else(|| "Invalid addon URL. Please provide a valid http(s) URL.".to_string())?;

    let source_name = addon_name
        .as_deref()
        .and_then(normalize_non_empty)
        .or_else(|| {
            reqwest::Url::parse(&addon_url)
                .ok()
                .and_then(|url| url.host_str().map(|host| host.to_string()))
        })
        .unwrap_or_else(|| "Addon".to_string());

    let effective_type = if media_type == "anime" {
        "series".to_string()
    } else {
        media_type.clone()
    };

    let query_ids = build_stream_query_ids(&media_type, &id, season, episode, absolute_episode);
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);

    fetch_prepared_streams_for_addon(
        &provider,
        &rd_provider,
        &effective_type,
        &query_ids,
        token.as_deref(),
        &addon_url,
        &source_name,
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_stream(
    app: AppHandle,
    provider: State<'_, RealDebrid>,
    magnet: String,
    info_hash: Option<String>,
    file_idx: Option<usize>,
    season: Option<u32>,
    episode: Option<u32>,
    url: Option<String>,
) -> Result<ResolvedStream, String> {
    let has_direct_url = url.as_deref().and_then(normalize_http_url).is_some();
    let has_magnet_source = build_magnet(Some(magnet.as_str()), info_hash.as_deref()).is_some();

    if !has_direct_url && !has_magnet_source {
        return Err(
            "No stream source provided. Expected a valid direct URL, magnet, or info hash."
                .to_string(),
        );
    }

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);

    resolve_stream_inner(
        &provider,
        token.as_deref(),
        ResolveStreamParams {
            magnet,
            info_hash,
            file_idx,
            season,
            episode,
            url,
        },
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_best_stream(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    addon_transport: State<'_, AddonTransport>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<BestResolvedStream, String> {
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let ranking = resolve_stream_ranking_scope(
        &media_type,
        &id,
        season,
        episode,
        ranking_media_type,
        ranking_media_id,
        ranking_title,
        ranking_season,
        ranking_episode,
    )?;

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);
    let mut streams = fetch_ranked_streams(
        &app,
        &playback_state,
        &addon_transport,
        &rd_provider,
        &StreamQueryRequest {
            media_type: &media_type,
            id: &id,
            season,
            episode,
            absolute_episode,
        },
        &ranking,
    )
    .await?;

    streams
        .retain(|stream| !is_placeholder_no_stream(stream) && has_playable_stream_source(stream));

    if streams.is_empty() {
        return Err("No streams found for this content.".to_string());
    }

    let mut auth_errors = Vec::new();
    let mut debrid_requirement_errors = 0usize;
    let mut debrid_requirement_sources = Vec::new();
    let mut errors = Vec::new();
    let mut candidates = tokio::task::JoinSet::new();
    let mut candidate_count = 0usize;

    for (index, stream) in streams.iter().take(BEST_STREAM_MAX_CANDIDATES).enumerate() {
        let direct_url = stream
            .url
            .as_deref()
            .filter(|url| is_http_url(url))
            .map(|url| url.to_string());
        let magnet = build_magnet(stream.url.as_deref(), stream.info_hash.as_deref());

        if direct_url.is_none() && magnet.is_none() {
            errors.push(format!("Stream {} missing URL/hash", index + 1));
            continue;
        }

        let task_provider = rd_provider.inner().clone();
        let task_token = token.clone();
        let params = ResolveStreamParams {
            magnet: magnet.unwrap_or_default(),
            info_hash: stream.info_hash.clone(),
            file_idx: stream.file_idx.map(|file_idx| file_idx as usize),
            season,
            episode,
            url: direct_url,
        };

        let candidate_timeout_secs = if index == 0 {
            BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS
        } else {
            BEST_STREAM_CANDIDATE_TIMEOUT_SECS
        };

        candidate_count += 1;
        candidates.spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(candidate_timeout_secs),
                resolve_stream_inner(&task_provider, task_token.as_deref(), params),
            )
            .await;
            (index, result, candidate_timeout_secs)
        });
    }

    if candidate_count == 0 {
        let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
        return Err(format!(
            "Unable to resolve a playable stream from the best candidates. {}",
            summary
        ));
    }

    while let Some(joined) = candidates.join_next().await {
        match joined {
            Ok((index, Ok(Ok(resolved)), _)) => {
                candidates.abort_all();
                return Ok(BestResolvedStream {
                    url: resolved.url,
                    is_web_friendly: resolved.is_web_friendly,
                    format: resolved.format,
                    used_fallback: index > 0,
                    source_name: streams
                        .get(index)
                        .and_then(|stream| stream.source_name.clone()),
                    stream_family: streams
                        .get(index)
                        .and_then(|stream| stream.stream_family.clone()),
                });
            }
            Ok((index, Ok(Err(error)), _)) => {
                let source_name = streams
                    .get(index)
                    .and_then(|stream| stream.source_name.as_deref())
                    .unwrap_or("Unknown source");
                if is_missing_debrid_config_error(&error) {
                    debrid_requirement_errors += 1;
                    debrid_requirement_sources.push(source_name.to_string());
                    continue;
                }
                if is_auth_error(&error) {
                    auth_errors.push(format!("{}: {}", source_name, error));
                    continue;
                }

                errors.push(format!("{}: {}", source_name, error));
            }
            Ok((index, Err(_), timeout_secs)) => {
                let source_name = streams
                    .get(index)
                    .and_then(|stream| stream.source_name.as_deref())
                    .unwrap_or("Unknown source");
                errors.push(format!("{} timed out after {}s", source_name, timeout_secs));
            }
            Err(error) => {
                errors.push(format!("Stream candidate task failed: {}", error));
            }
        }
    }

    if let Some(error) = auth_errors.into_iter().next() {
        return Err(error);
    }

    if debrid_requirement_errors > 0 && errors.is_empty() {
        debrid_requirement_sources.sort();
        debrid_requirement_sources.dedup();
        let suffix = if debrid_requirement_sources.is_empty() {
            String::new()
        } else {
            format!(
                " Affected sources: {}.",
                debrid_requirement_sources.join(", ")
            )
        };
        return Err(format!("{}{}", missing_debrid_provider_message(), suffix));
    }

    let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
    if debrid_requirement_errors > 0 {
        if summary.is_empty() {
            debrid_requirement_sources.sort();
            debrid_requirement_sources.dedup();
            let suffix = if debrid_requirement_sources.is_empty() {
                String::new()
            } else {
                format!(
                    " Affected sources: {}.",
                    debrid_requirement_sources.join(", ")
                )
            };
            return Err(format!("{}{}", missing_debrid_provider_message(), suffix));
        }

        return Err(format!(
            "{} Other candidates also failed: {}",
            missing_debrid_provider_message(),
            summary
        ));
    }

    Err(format!(
        "Unable to resolve a playable stream from the best candidates. {}",
        summary
    ))
}
