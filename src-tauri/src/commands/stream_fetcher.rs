use super::config_store::{
    get_effective_playback_rd_token, get_trimmed_store_string, normalize_addon_url, AddonConfig,
};
use super::playback_preferences_commands::sanitize_language_pref;
use super::playback_state::PlaybackStateService;
use super::stream_coordinator::{
    build_source_health_priorities, build_stream_family_priorities, build_title_source_affinities,
    sort_streams_by_recommendation, StreamMatchContext, StreamRecommendationInputs,
};
use super::streaming_helpers::{
    build_addon_source_priority_map, build_stream_query_ids, merge_unique_streams,
    prepare_addon_streams,
};
use super::{
    normalize_non_empty, normalize_stream_media_type, PlaybackLanguagePreferences,
    SETTINGS_STORE_FILE,
};
use crate::operational_log::{field, log_operational_event, OperationalLogLevel};
use crate::providers::{
    addons::{AddonTransport, StreamResolution, TorrentioStream},
    realdebrid::RealDebrid,
};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

// Primary addon lookups still get the most budget, but keep the upper bound short enough that
// one unhealthy source does not dominate selector open time.
const ADDON_STREAM_FETCH_TIMEOUT_SECS: u64 = 14;
// Lookup fallbacks are best-effort only and should fail fast when the first ID did not produce
// a usable response.
const ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS: u64 = 5;
const DEGRADED_SOURCE_LATENCY_MS: u64 = 4_500;
const ADDON_STREAM_FETCH_CONCURRENCY_LIMIT: usize = 4;
const DEFAULT_SOURCE_HEALTH_PRIORITY: u8 = 2;
const ACTIVE_SOURCE_COOLDOWN_PRIORITY: u8 = 0;
const SOURCE_COOLDOWN_ERROR_MESSAGE: &str =
    "Temporarily cooling down after recent playback failures.";
const ALL_SOURCES_COOLDOWN_FATAL_ERROR: &str =
    "All enabled stream sources are temporarily cooling down after recent playback failures.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StreamSourceStatus {
    Healthy,
    Degraded,
    Offline,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSourceSummary {
    pub id: String,
    pub name: String,
    pub status: StreamSourceStatus,
    pub stream_count: usize,
    pub latency_ms: Option<u64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSelectorData {
    pub streams: Vec<TorrentioStream>,
    pub stats: StreamSelectorStats,
    pub source_summaries: Vec<StreamSourceSummary>,
    pub fatal_error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub(crate) struct StreamSelectorResolutionCounts {
    #[serde(rename = "4k")]
    pub ultra_hd: usize,
    #[serde(rename = "1080p")]
    pub full_hd: usize,
    #[serde(rename = "720p")]
    pub hd: usize,
    pub sd: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSelectorStats {
    pub res_counts: StreamSelectorResolutionCounts,
    pub playable_count: usize,
    pub cached_count: usize,
    pub batch_count: usize,
    pub episode_like_count: usize,
}

#[derive(Debug)]
struct AddonStreamFetchOutcome {
    id: String,
    name: String,
    streams: Vec<TorrentioStream>,
    latency_ms: u64,
    error_message: Option<String>,
}

fn normalize_source_health_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn source_health_priority_for_addon(
    addon_name: &str,
    source_health_priorities: &HashMap<String, u8>,
) -> u8 {
    normalize_source_health_key(addon_name)
        .and_then(|source_name| source_health_priorities.get(&source_name).copied())
        .unwrap_or(DEFAULT_SOURCE_HEALTH_PRIORITY)
}

fn summarize_cooldown_skipped_addon(addon: &AddonConfig) -> StreamSourceSummary {
    StreamSourceSummary {
        id: addon.id.clone(),
        name: addon.name.clone(),
        status: StreamSourceStatus::Offline,
        stream_count: 0,
        latency_ms: None,
        error_message: Some(SOURCE_COOLDOWN_ERROR_MESSAGE.to_string()),
    }
}

fn load_effective_playback_language_preferences<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_id: &str,
    media_type: &str,
) -> PlaybackLanguagePreferences {
    let defaults = PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(
            get_trimmed_store_string(store, "preferred_audio_language"),
            false,
        ),
        preferred_subtitle_language: sanitize_language_pref(
            get_trimmed_store_string(store, "preferred_subtitle_language"),
            true,
        ),
    };

    playback_state
        .get_effective_playback_language_preferences(
            app,
            Some(media_id),
            Some(media_type),
            defaults.clone(),
        )
        .unwrap_or(defaults)
}

pub(crate) struct StreamQueryRequest<'a> {
    pub media_type: &'a str,
    pub id: &'a str,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_episode: Option<u32>,
}

pub(crate) struct StreamRankingScope {
    pub media_type: String,
    pub media_id: String,
    pub title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_stream_ranking_scope(
    query_media_type: &str,
    query_id: &str,
    fallback_season: Option<u32>,
    fallback_episode: Option<u32>,
    ranking_media_type: Option<String>,
    ranking_media_id: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<StreamRankingScope, String> {
    let media_id = match ranking_media_id.as_deref() {
        Some(value) => normalize_non_empty(value)
            .ok_or_else(|| "Media ID is required for stream ranking.".to_string())?,
        None => query_id.to_string(),
    };
    let media_type = match ranking_media_type.as_deref() {
        Some(value) => normalize_stream_media_type(value, Some(media_id.as_str()))
            .ok_or_else(|| "Invalid media type for stream ranking.".to_string())?,
        None => query_media_type.to_string(),
    };

    Ok(StreamRankingScope {
        media_type,
        media_id,
        title: ranking_title.as_deref().and_then(normalize_non_empty),
        season: ranking_season.or(fallback_season),
        episode: ranking_episode.or(fallback_episode),
    })
}

pub(crate) async fn fetch_prepared_streams_for_addon(
    provider: &AddonTransport,
    rd_provider: &RealDebrid,
    effective_type: &str,
    query_ids: &[String],
    token: Option<&str>,
    addon_url: &str,
    source_name: &str,
) -> Result<Vec<TorrentioStream>, String> {
    let mut last_error: Option<String> = None;

    for (index, query_id) in query_ids.iter().enumerate() {
        let timeout_secs = if index == 0 {
            ADDON_STREAM_FETCH_TIMEOUT_SECS
        } else {
            ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS
        };

        let attempt = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            provider.get_streams(
                effective_type,
                query_id,
                Some(rd_provider),
                token,
                addon_url,
            ),
        )
        .await;

        match attempt {
            Ok(Ok(streams)) => {
                let prepared = prepare_addon_streams(streams, source_name);
                if prepared.is_empty() {
                    continue;
                }

                return Ok(prepared);
            }
            Ok(Err(error)) => {
                log_operational_event(
                    OperationalLogLevel::Warn,
                    "stream-fetcher",
                    "fetch_addon_streams",
                    "addon-query-failed",
                    &[
                        field("source", source_name),
                        field("media_type", effective_type),
                        field("query_index", index + 1),
                        field("query_id", query_id),
                        field("error", &error),
                    ],
                );
                last_error = Some(format!("{}: {}", source_name, error));
            }
            Err(_) => {
                let error = format!("{} timed out after {}s", source_name, timeout_secs);
                log_operational_event(
                    OperationalLogLevel::Warn,
                    "stream-fetcher",
                    "fetch_addon_streams",
                    "addon-query-timeout",
                    &[
                        field("source", source_name),
                        field("media_type", effective_type),
                        field("query_index", index + 1),
                        field("query_id", query_id),
                        field("timeout_secs", timeout_secs),
                    ],
                );
                last_error = Some(error);
            }
        }
    }

    if let Some(error) = last_error {
        return Err(error);
    }

    Ok(Vec::new())
}

async fn fetch_addon_stream_outcome(
    provider: &AddonTransport,
    rd_provider: &RealDebrid,
    effective_type: &str,
    query_ids: &[String],
    token: Option<String>,
    addon: AddonConfig,
) -> AddonStreamFetchOutcome {
    let started_at = Instant::now();
    let result = fetch_prepared_streams_for_addon(
        provider,
        rd_provider,
        effective_type,
        query_ids,
        token.as_deref(),
        &addon.url,
        &addon.name,
    )
    .await;
    let latency_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;

    match result {
        Ok(streams) => AddonStreamFetchOutcome {
            id: addon.id,
            name: addon.name,
            streams,
            latency_ms,
            error_message: None,
        },
        Err(error_message) => AddonStreamFetchOutcome {
            id: addon.id,
            name: addon.name,
            streams: Vec::new(),
            latency_ms,
            error_message: Some(error_message),
        },
    }
}

fn summarize_addon_outcome(outcome: &AddonStreamFetchOutcome) -> StreamSourceSummary {
    let status = if outcome.error_message.is_some() {
        StreamSourceStatus::Offline
    } else if outcome.streams.is_empty() || outcome.latency_ms > DEGRADED_SOURCE_LATENCY_MS {
        StreamSourceStatus::Degraded
    } else {
        StreamSourceStatus::Healthy
    };

    StreamSourceSummary {
        id: outcome.id.clone(),
        name: outcome.name.clone(),
        status,
        stream_count: outcome.streams.len(),
        latency_ms: outcome
            .error_message
            .is_none()
            .then_some(outcome.latency_ms),
        error_message: outcome.error_message.clone(),
    }
}

fn build_fatal_stream_error(errors: &[String]) -> Option<String> {
    if errors.is_empty() {
        None
    } else {
        Some(errors.join(" | "))
    }
}

fn compute_stream_selector_stats(streams: &[TorrentioStream]) -> StreamSelectorStats {
    let mut stats = StreamSelectorStats::default();

    for stream in streams
        .iter()
        .filter(|stream| stream.presentation.is_instantly_playable)
    {
        stats.playable_count += 1;

        match stream.presentation.resolution {
            StreamResolution::P2160 => stats.res_counts.ultra_hd += 1,
            StreamResolution::P1080 => stats.res_counts.full_hd += 1,
            StreamResolution::P720 => stats.res_counts.hd += 1,
            StreamResolution::Sd => stats.res_counts.sd += 1,
        }

        if stream.cached {
            stats.cached_count += 1;
        }

        if stream.presentation.is_batch {
            stats.batch_count += 1;
        }
    }

    stats.episode_like_count = stats.playable_count.saturating_sub(stats.batch_count);
    stats
}

pub(crate) async fn fetch_stream_selector_data(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    rd_provider: &RealDebrid,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
) -> Result<StreamSelectorData, String> {
    let effective_type = if query.media_type == "anime" {
        "series".to_string()
    } else {
        query.media_type.to_string()
    };

    let query_ids = build_stream_query_ids(
        query.media_type,
        query.id,
        query.season,
        query.episode,
        query.absolute_episode,
    );
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let token = get_effective_playback_rd_token(&store);
    let addon_configs = super::config_store::load_addon_configs(&store);
    let mut seen_addon_urls = HashSet::new();
    let enabled_addons: Vec<AddonConfig> = addon_configs
        .into_iter()
        .filter(|addon| addon.enabled)
        .filter_map(|mut addon| {
            let normalized_url = normalize_addon_url(&addon.url).ok().flatten()?;
            if !seen_addon_urls.insert(normalized_url.clone()) {
                return None;
            }

            addon.url = normalized_url;
            addon.name = addon.name.trim().to_string();
            Some(addon)
        })
        .collect();

    if enabled_addons.is_empty() {
        return Ok(StreamSelectorData {
            streams: Vec::new(),
            stats: StreamSelectorStats::default(),
            source_summaries: Vec::new(),
            fatal_error_message: None,
        });
    }

    let addon_source_health_priorities = playback_state
        .source_health_priorities_for_names(app, enabled_addons.iter().map(|addon| addon.name.as_str()))
        .unwrap_or_default();
    let mut prioritized_addons = Vec::new();

    for (index, addon) in enabled_addons.iter().cloned().enumerate() {
        let priority = source_health_priority_for_addon(&addon.name, &addon_source_health_priorities);

        if priority == ACTIVE_SOURCE_COOLDOWN_PRIORITY {
            log_operational_event(
                OperationalLogLevel::Warn,
                "stream-fetcher",
                "fetch_stream_selector_data",
                "addon-query-skipped-cooldown",
                &[
                    field("source", &addon.name),
                    field("media_type", query.media_type),
                    field("media_id", query.id),
                ],
            );
        }

        if priority > ACTIVE_SOURCE_COOLDOWN_PRIORITY {
            prioritized_addons.push((index, addon));
        }
    }

    if prioritized_addons.is_empty() {
        return Ok(StreamSelectorData {
            streams: Vec::new(),
            stats: StreamSelectorStats::default(),
            source_summaries: enabled_addons
                .iter()
                .map(summarize_cooldown_skipped_addon)
                .collect(),
            fatal_error_message: Some(ALL_SOURCES_COOLDOWN_FATAL_ERROR.to_string()),
        });
    }

    let addon_source_priority_addons: Vec<AddonConfig> = prioritized_addons
        .iter()
        .map(|(_, addon)| addon.clone())
        .collect();

    let mut outcomes = stream::iter(prioritized_addons.into_iter().map(|(index, addon)| {
                let query_ids = query_ids.clone();
                let effective_type = effective_type.clone();
                let token = token.clone();

                async move {
                    (
                        index,
                        fetch_addon_stream_outcome(
                            provider,
                            rd_provider,
                            &effective_type,
                            &query_ids,
                            token,
                            addon,
                        )
                        .await,
                    )
                }
            }))
    .buffer_unordered(ADDON_STREAM_FETCH_CONCURRENCY_LIMIT)
    .collect::<Vec<_>>()
    .await;
    outcomes.sort_by_key(|(index, _)| *index);
    let mut outcomes_by_index = outcomes.into_iter().collect::<HashMap<usize, AddonStreamFetchOutcome>>();
    let mut merged: Vec<TorrentioStream> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut source_summaries = Vec::with_capacity(enabled_addons.len());
    let mut fatal_errors = Vec::new();

    for (index, addon) in enabled_addons.iter().enumerate() {
        if source_health_priority_for_addon(&addon.name, &addon_source_health_priorities)
            == ACTIVE_SOURCE_COOLDOWN_PRIORITY
        {
            source_summaries.push(summarize_cooldown_skipped_addon(addon));
            continue;
        }

        let Some(outcome) = outcomes_by_index.remove(&index) else {
            source_summaries.push(StreamSourceSummary {
                id: addon.id.clone(),
                name: addon.name.clone(),
                status: StreamSourceStatus::Offline,
                stream_count: 0,
                latency_ms: None,
                error_message: Some("Source did not return a selector outcome.".to_string()),
            });
            continue;
        };

        let summary = summarize_addon_outcome(&outcome);
        if fatal_errors.len() < 3 {
            if let Some(error_message) = outcome.error_message.as_ref() {
                fatal_errors.push(error_message.clone());
            }
        }

        merge_unique_streams(&mut merged, &mut seen, outcome.streams);
        source_summaries.push(summary);
    }

    if !merged.is_empty() {
        let addon_source_priorities =
            build_addon_source_priority_map(&addon_source_priority_addons);
        let source_health_priorities = build_source_health_priorities(app, playback_state, &merged);
        let stream_family_priorities = build_stream_family_priorities(
            app,
            playback_state,
            &ranking.media_id,
            &ranking.media_type,
            ranking.season,
            ranking.episode,
            &merged,
        );
        let title_source_affinities = build_title_source_affinities(
            app,
            playback_state,
            &ranking.media_id,
            &ranking.media_type,
            &merged,
        );
        let playback_language_preferences = load_effective_playback_language_preferences(
            &store,
            app,
            playback_state,
            &ranking.media_id,
            &ranking.media_type,
        );
        sort_streams_by_recommendation(
            &mut merged,
            StreamRecommendationInputs {
                addon_source_priorities: &addon_source_priorities,
                source_health_priorities: &source_health_priorities,
                stream_family_priorities: &stream_family_priorities,
                title_source_affinities: &title_source_affinities,
                match_context: StreamMatchContext {
                    media_type: &ranking.media_type,
                    title: ranking.title.as_deref(),
                    query_season: query.season,
                    query_episode: query.episode,
                    canonical_season: ranking.season,
                    canonical_episode: ranking.episode,
                },
                preferred_audio_language: playback_language_preferences
                    .preferred_audio_language
                    .as_deref(),
                preferred_subtitle_language: playback_language_preferences
                    .preferred_subtitle_language
                    .as_deref(),
            },
        );
    }

    Ok(StreamSelectorData {
        fatal_error_message: if merged.is_empty() {
            build_fatal_stream_error(&fatal_errors)
        } else {
            None
        },
        stats: compute_stream_selector_stats(&merged),
        source_summaries,
        streams: merged,
    })
}

pub(crate) async fn fetch_ranked_streams(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    rd_provider: &RealDebrid,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
) -> Result<Vec<TorrentioStream>, String> {
    let data =
        fetch_stream_selector_data(app, playback_state, provider, rd_provider, query, ranking)
            .await?;

    if data.streams.is_empty() {
        if let Some(error) = data.fatal_error_message {
            return Err(error);
        }
    }

    Ok(data.streams)
}

#[cfg(test)]
mod tests {
    use super::{
        compute_stream_selector_stats, normalize_source_health_key,
        source_health_priority_for_addon, summarize_cooldown_skipped_addon, StreamSelectorStats,
        StreamSourceStatus, ACTIVE_SOURCE_COOLDOWN_PRIORITY,
    };
    use crate::commands::config_store::AddonConfig;
    use crate::providers::addons::{StreamPresentation, StreamResolution, TorrentioStream};
    use std::collections::HashMap;

    fn build_stream(
        resolution: StreamResolution,
        instantly_playable: bool,
        cached: bool,
        is_batch: bool,
    ) -> TorrentioStream {
        TorrentioStream {
            name: None,
            title: None,
            info_hash: None,
            url: None,
            file_idx: None,
            behavior_hints: None,
            cached,
            seeders: None,
            size_bytes: None,
            source_name: None,
            stream_family: None,
            stream_key: String::new(),
            recommendation_reasons: Vec::new(),
            presentation: StreamPresentation {
                resolution,
                is_instantly_playable: instantly_playable,
                is_batch,
                ..StreamPresentation::default()
            },
        }
    }

    #[test]
    fn compute_stream_selector_stats_uses_playable_streams_only() {
        let stats = compute_stream_selector_stats(&[
            build_stream(StreamResolution::P2160, true, true, false),
            build_stream(StreamResolution::P1080, true, false, true),
            build_stream(StreamResolution::P720, false, true, false),
        ]);

        assert_eq!(
            stats,
            StreamSelectorStats {
                res_counts: super::StreamSelectorResolutionCounts {
                    ultra_hd: 1,
                    full_hd: 1,
                    hd: 0,
                    sd: 0,
                },
                playable_count: 2,
                cached_count: 1,
                batch_count: 1,
                episode_like_count: 1,
            }
        );
    }

    #[test]
    fn source_health_priority_for_addon_uses_normalized_names() {
        let mut source_health_priorities = HashMap::new();
        source_health_priorities.insert("torrentio".to_string(), ACTIVE_SOURCE_COOLDOWN_PRIORITY);

        assert_eq!(
            source_health_priority_for_addon(" Torrentio ", &source_health_priorities),
            ACTIVE_SOURCE_COOLDOWN_PRIORITY
        );
        assert_eq!(normalize_source_health_key("  "), None);
    }

    #[test]
    fn summarize_cooldown_skipped_addon_marks_source_offline() {
        let summary = summarize_cooldown_skipped_addon(&AddonConfig {
            id: "addon-1".to_string(),
            url: "https://example.com/manifest.json".to_string(),
            name: "Torrentio".to_string(),
            enabled: true,
        });

        assert_eq!(summary.status, StreamSourceStatus::Offline);
        assert_eq!(summary.stream_count, 0);
        assert!(summary.latency_ms.is_none());
        assert!(summary.error_message.is_some());
    }
}
