use super::{
    config_store::{
        get_effective_playback_rd_token, sanitize_stream_selector_preferences,
        StreamSelectorBatch, StreamSelectorPreferences, StreamSelectorQuality,
        StreamSelectorSort, StreamSelectorSource,
    },
    episode_navigation::PreparedPlaybackStream,
    history_helpers::{build_history_key, normalize_watch_progress_type},
    normalize_non_empty, normalize_stream_media_type, now_unix_millis,
    playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind},
    stream_fetcher::{
        fetch_ranked_streams, fetch_stream_selector_data, resolve_stream_ranking_scope,
        StreamQueryRequest, StreamSelectorData,
    },
    stream_resolver::{
        is_auth_error, is_missing_debrid_config_error, missing_debrid_provider_message,
        resolve_stream_inner, BestResolvedStream, ResolveStreamParams, ResolvedStream,
    },
    streaming_helpers::{
        build_magnet, has_playable_stream_source, is_http_url, is_placeholder_no_stream,
        normalize_http_url,
    },
    BEST_STREAM_CANDIDATE_TIMEOUT_SECS, BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS,
    BEST_STREAM_MAX_CANDIDATES, SETTINGS_STORE_FILE,
};
use crate::providers::{
    addons::{
        AddonTransport, BehaviorHints, StreamPresentation, StreamResolution, TorrentioStream,
    },
    realdebrid::RealDebrid,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StreamSelectorCommandStream {
    name: Option<String>,
    #[serde(alias = "description")]
    title: Option<String>,
    #[serde(rename = "infoHash", alias = "info_hash")]
    info_hash: Option<String>,
    url: Option<String>,
    #[serde(rename = "fileIdx", alias = "file_idx")]
    file_idx: Option<u32>,
    #[serde(rename = "behaviorHints", alias = "behavior_hints")]
    behavior_hints: Option<BehaviorHints>,
    #[serde(default)]
    cached: bool,
    #[serde(default)]
    seeders: Option<u32>,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    source_name: Option<String>,
    #[serde(default)]
    stream_family: Option<String>,
    #[serde(rename = "streamKey", default)]
    stream_key: String,
    #[serde(default)]
    recommendation_reasons: Vec<String>,
    #[serde(default)]
    presentation: StreamPresentation,
}

fn stream_selector_resolution_rank(resolution: StreamResolution) -> u8 {
    match resolution {
        StreamResolution::P2160 => 4,
        StreamResolution::P1080 => 3,
        StreamResolution::P720 => 2,
        StreamResolution::Sd => 1,
    }
}

fn filter_stream_selector_streams_inner(
    streams: Vec<StreamSelectorCommandStream>,
    filters: &StreamSelectorPreferences,
) -> Vec<StreamSelectorCommandStream> {
    let mut filtered = streams
        .into_iter()
        .filter(|stream| stream.presentation.is_instantly_playable)
        .filter(|stream| match filters.quality {
            StreamSelectorQuality::All => true,
            StreamSelectorQuality::P2160 => stream.presentation.resolution == StreamResolution::P2160,
            StreamSelectorQuality::P1080 => stream.presentation.resolution == StreamResolution::P1080,
            StreamSelectorQuality::P720 => stream.presentation.resolution == StreamResolution::P720,
            StreamSelectorQuality::Sd => stream.presentation.resolution == StreamResolution::Sd,
        })
        .filter(|stream| match filters.source {
            StreamSelectorSource::All => true,
            StreamSelectorSource::Cached => stream.cached,
        })
        .filter(|stream| match filters.batch {
            StreamSelectorBatch::All => true,
            StreamSelectorBatch::Episodes => !stream.presentation.is_batch,
            StreamSelectorBatch::Packs => stream.presentation.is_batch,
        })
        .filter(|stream| {
            if filters.addon.eq_ignore_ascii_case("all") {
                return true;
            }

            stream
                .source_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Unknown")
                == filters.addon
        })
        .collect::<Vec<_>>();

    match filters.sort {
        StreamSelectorSort::Smart => {}
        StreamSelectorSort::Quality => {
            filtered.sort_by(|left, right| {
                stream_selector_resolution_rank(right.presentation.resolution)
                    .cmp(&stream_selector_resolution_rank(left.presentation.resolution))
                    .then_with(|| right.size_bytes.unwrap_or(0).cmp(&left.size_bytes.unwrap_or(0)))
            });
        }
        StreamSelectorSort::Size => {
            filtered.sort_by(|left, right| {
                right.size_bytes.unwrap_or(0).cmp(&left.size_bytes.unwrap_or(0))
            });
        }
        StreamSelectorSort::Seeds => {
            filtered.sort_by(|left, right| {
                i64::from(right.seeders.unwrap_or(0))
                    .cmp(&i64::from(left.seeders.unwrap_or(0)))
            });
        }
    }

    filtered
}

#[derive(Clone)]
struct StreamResolveCandidateTask {
    index: usize,
    source_name: Option<String>,
    stream_family: Option<String>,
    magnet: String,
    info_hash: Option<String>,
    file_idx: Option<usize>,
    direct_url: Option<String>,
    timeout_secs: u64,
}

fn normalize_recovery_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalize_non_empty(&value))
}

fn normalize_recovery_url(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalize_http_url(&value).or_else(|| normalize_non_empty(&value)))
}

fn build_prepared_recovery_stream(stream: PreparedPlaybackStream) -> Option<BestResolvedStream> {
    let url = normalize_recovery_url(Some(stream.url))?;
    let format = normalize_non_empty(&stream.format).unwrap_or_else(|| "unknown".to_string());

    Some(BestResolvedStream {
        url,
        is_web_friendly: true,
        format,
        used_fallback: true,
        source_name: normalize_recovery_text(stream.source_name),
        stream_family: normalize_recovery_text(stream.stream_family),
    })
}

async fn resolve_ranked_best_stream_candidate(
    rd_provider: &RealDebrid,
    token: Option<String>,
    streams: Vec<TorrentioStream>,
    season: Option<u32>,
    episode: Option<u32>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
) -> Result<BestResolvedStream, String> {
    let excluded_stream_key = excluded_stream_key.and_then(normalize_non_empty);
    let excluded_resolved_url = excluded_resolved_url.and_then(normalize_non_empty);
    let mut auth_errors = Vec::new();
    let mut debrid_requirement_errors = 0usize;
    let mut debrid_requirement_sources = Vec::new();
    let mut errors = Vec::new();
    let mut candidates = tokio::task::JoinSet::new();
    let mut candidate_count = 0usize;

    for (index, stream) in streams
        .into_iter()
        .take(BEST_STREAM_MAX_CANDIDATES)
        .enumerate()
    {
        if excluded_stream_key
            .as_deref()
            .is_some_and(|stream_key| stream.stream_key == stream_key)
        {
            continue;
        }

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

        if excluded_resolved_url
            .as_deref()
            .is_some_and(|excluded_url| direct_url.as_deref() == Some(excluded_url))
        {
            continue;
        }

        let candidate = StreamResolveCandidateTask {
            index,
            source_name: stream.source_name.clone(),
            stream_family: stream.stream_family.clone(),
            magnet: magnet.unwrap_or_default(),
            info_hash: stream.info_hash.clone(),
            file_idx: stream.file_idx.map(|value| value as usize),
            direct_url,
            timeout_secs: if index == 0 {
                BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS
            } else {
                BEST_STREAM_CANDIDATE_TIMEOUT_SECS
            },
        };

        let task_provider = rd_provider.clone();
        let task_token = token.clone();
        let task_candidate = candidate.clone();

        candidate_count += 1;
        candidates.spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(task_candidate.timeout_secs),
                resolve_stream_inner(
                    &task_provider,
                    task_token.as_deref(),
                    ResolveStreamParams {
                        magnet: task_candidate.magnet.clone(),
                        info_hash: task_candidate.info_hash.clone(),
                        file_idx: task_candidate.file_idx,
                        season,
                        episode,
                        url: task_candidate.direct_url.clone(),
                    },
                ),
            )
            .await;

            (task_candidate, result)
        });
    }

    if candidate_count == 0 {
        let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
        return Err(if summary.is_empty() {
            "Unable to resolve a playable stream from the available recovery candidates."
                .to_string()
        } else {
            format!(
                "Unable to resolve a playable stream from the available recovery candidates. {}",
                summary
            )
        });
    }

    while let Some(joined) = candidates.join_next().await {
        match joined {
            Ok((candidate, Ok(Ok(resolved)))) => {
                if excluded_resolved_url
                    .as_deref()
                    .is_some_and(|excluded_url| resolved.url.trim() == excluded_url)
                {
                    continue;
                }

                candidates.abort_all();
                return Ok(BestResolvedStream {
                    url: resolved.url,
                    is_web_friendly: resolved.is_web_friendly,
                    format: resolved.format,
                    used_fallback: candidate.index > 0,
                    source_name: candidate.source_name,
                    stream_family: candidate.stream_family,
                });
            }
            Ok((candidate, Ok(Err(error)))) => {
                let source_name = candidate.source_name.as_deref().unwrap_or("Unknown source");
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
            Ok((candidate, Err(_))) => {
                let source_name = candidate.source_name.as_deref().unwrap_or("Unknown source");
                errors.push(format!(
                    "{} timed out after {}s",
                    source_name, candidate.timeout_secs
                ));
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
            "{} Also failed to resolve other candidates: {}",
            missing_debrid_provider_message(),
            summary
        ));
    }

    Err(if summary.is_empty() {
        "Unable to resolve a playable stream from the best candidates.".to_string()
    } else {
        format!(
            "Unable to resolve a playable stream from the best candidates. {}",
            summary
        )
    })
}

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
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
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
pub async fn get_stream_selector_data(
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
) -> Result<StreamSelectorData, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;

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

    fetch_stream_selector_data(
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
pub fn filter_stream_selector_streams(
    streams: Vec<StreamSelectorCommandStream>,
    filters: StreamSelectorPreferences,
) -> Vec<StreamSelectorCommandStream> {
    let filters = sanitize_stream_selector_preferences(filters);
    filter_stream_selector_streams_inner(streams, &filters)
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

#[cfg(test)]
mod tests {
    use super::{
        filter_stream_selector_streams_inner, StreamSelectorCommandStream,
    };
    use crate::commands::config_store::{
        StreamSelectorBatch, StreamSelectorPreferences, StreamSelectorQuality,
        StreamSelectorSort, StreamSelectorSource,
    };
    use crate::providers::addons::{StreamPresentation, StreamResolution};

    #[allow(clippy::too_many_arguments)]
    fn build_stream(
        stream_key: &str,
        source_name: &str,
        resolution: StreamResolution,
        size_bytes: Option<u64>,
        seeders: Option<u32>,
        cached: bool,
        is_batch: bool,
        is_instantly_playable: bool,
    ) -> StreamSelectorCommandStream {
        StreamSelectorCommandStream {
            name: None,
            title: None,
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached,
            seeders,
            size_bytes,
            source_name: Some(source_name.to_string()),
            stream_family: None,
            stream_key: stream_key.to_string(),
            recommendation_reasons: Vec::new(),
            presentation: StreamPresentation {
                resolution,
                is_batch,
                is_instantly_playable,
                ..StreamPresentation::default()
            },
        }
    }

    #[test]
    fn filter_stream_selector_streams_keeps_smart_order_for_playable_matches() {
        let streams = vec![
            build_stream(
                "first",
                "Source A",
                StreamResolution::P1080,
                Some(2_000),
                Some(10),
                true,
                false,
                true,
            ),
            build_stream(
                "second",
                "Source B",
                StreamResolution::P2160,
                Some(4_000),
                Some(20),
                true,
                false,
                false,
            ),
            build_stream(
                "third",
                "Source C",
                StreamResolution::P720,
                Some(1_000),
                Some(5),
                false,
                true,
                true,
            ),
        ];

        let filtered = filter_stream_selector_streams_inner(
            streams,
            &StreamSelectorPreferences {
                quality: StreamSelectorQuality::All,
                source: StreamSelectorSource::All,
                addon: "all".to_string(),
                sort: StreamSelectorSort::Smart,
                batch: StreamSelectorBatch::All,
            },
        );

        let stream_keys = filtered
            .into_iter()
            .map(|stream| stream.stream_key)
            .collect::<Vec<_>>();
        assert_eq!(stream_keys, vec!["first".to_string(), "third".to_string()]);
    }

    #[test]
    fn filter_stream_selector_streams_applies_filters_and_quality_sort() {
        let streams = vec![
            build_stream(
                "a-1080",
                "Source A",
                StreamResolution::P1080,
                Some(2_000),
                Some(10),
                true,
                false,
                true,
            ),
            build_stream(
                "a-4k",
                "Source A",
                StreamResolution::P2160,
                Some(3_000),
                Some(8),
                true,
                false,
                true,
            ),
            build_stream(
                "b-pack",
                "Source B",
                StreamResolution::P2160,
                Some(9_000),
                Some(3),
                true,
                true,
                true,
            ),
        ];

        let filtered = filter_stream_selector_streams_inner(
            streams,
            &StreamSelectorPreferences {
                quality: StreamSelectorQuality::All,
                source: StreamSelectorSource::Cached,
                addon: "Source A".to_string(),
                sort: StreamSelectorSort::Quality,
                batch: StreamSelectorBatch::Episodes,
            },
        );

        let stream_keys = filtered
            .into_iter()
            .map(|stream| stream.stream_key)
            .collect::<Vec<_>>();
        assert_eq!(stream_keys, vec!["a-4k".to_string(), "a-1080".to_string()]);
    }
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
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for stream lookup.".to_string())?;
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

    resolve_ranked_best_stream_candidate(
        rd_provider.inner(),
        token,
        streams,
        season,
        episode,
        None,
        None,
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn recover_playback_stream(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    addon_transport: State<'_, AddonTransport>,
    rd_provider: State<'_, RealDebrid>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_lookup_id: Option<String>,
    failed_stream_url: Option<String>,
    failed_stream_format: Option<String>,
    failed_source_name: Option<String>,
    failed_stream_family: Option<String>,
    failed_stream_key: Option<String>,
    outcome: String,
    prepared_backup_stream: Option<PreparedPlaybackStream>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Option<BestResolvedStream>, String> {
    let normalized_id = normalize_non_empty(&id)
        .ok_or_else(|| "Media ID is required for stream recovery.".to_string())?;
    let normalized_media_type = normalize_stream_media_type(&media_type, Some(&normalized_id))
        .ok_or_else(|| "Invalid media type for stream recovery.".to_string())?;
    let normalized_history_type = normalize_watch_progress_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream recovery.".to_string())?;
    let normalized_outcome = PlaybackStreamOutcomeKind::parse(&outcome)
        .ok_or_else(|| "Invalid playback stream outcome.".to_string())?;
    let ranking = resolve_stream_ranking_scope(
        &normalized_media_type,
        &normalized_id,
        season,
        episode,
        ranking_media_type,
        ranking_media_id,
        ranking_title,
        ranking_season,
        ranking_episode,
    )?;
    let failed_stream_url = normalize_recovery_url(failed_stream_url);
    let failed_stream_format = normalize_recovery_text(failed_stream_format);
    let failed_source_name = normalize_recovery_text(failed_source_name);
    let failed_stream_family = normalize_recovery_text(failed_stream_family);
    let failed_stream_key = normalize_recovery_text(failed_stream_key);
    let stream_lookup_id = normalize_recovery_text(stream_lookup_id);
    let history_key = build_history_key(
        &normalized_history_type,
        &normalized_id,
        absolute_season,
        absolute_episode,
    );

    playback_state.record_stream_outcome(
        &app,
        &history_key,
        &normalized_id,
        &normalized_history_type,
        absolute_season,
        absolute_episode,
        failed_source_name,
        failed_stream_family,
        failed_stream_url.clone(),
        failed_stream_format,
        stream_lookup_id,
        failed_stream_key.clone(),
        normalized_outcome,
        now_unix_millis(),
    )?;

    if let Some(prepared_backup_stream) =
        prepared_backup_stream.and_then(build_prepared_recovery_stream)
    {
        if failed_stream_url.as_deref() != Some(prepared_backup_stream.url.as_str()) {
            return Ok(Some(prepared_backup_stream));
        }
    }

    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);
    let streams = match fetch_ranked_streams(
        &app,
        &playback_state,
        &addon_transport,
        &rd_provider,
        &StreamQueryRequest {
            media_type: &normalized_media_type,
            id: &normalized_id,
            season,
            episode,
            absolute_episode,
        },
        &ranking,
    )
    .await
    {
        Ok(streams) => streams,
        Err(_) => return Ok(None),
    };

    let streams = streams
        .into_iter()
        .filter(|stream| !is_placeholder_no_stream(stream) && has_playable_stream_source(stream))
        .collect::<Vec<_>>();
    if streams.is_empty() {
        return Ok(None);
    }

    match resolve_ranked_best_stream_candidate(
        rd_provider.inner(),
        token,
        streams,
        season,
        episode,
        failed_stream_key.as_deref(),
        failed_stream_url.as_deref(),
    )
    .await
    {
        Ok(resolved) => Ok(Some(resolved)),
        Err(_) => Ok(None),
    }
}
