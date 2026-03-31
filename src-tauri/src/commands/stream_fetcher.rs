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
use crate::providers::{
    realdebrid::RealDebrid,
    addons::{AddonTransport, TorrentioStream},
};
use futures_util::future::join_all;
use std::collections::HashSet;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const ADDON_STREAM_FETCH_TIMEOUT_SECS: u64 = 20;
const ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS: u64 = 8;

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
    let media_type = match ranking_media_type.as_deref() {
        Some(value) => normalize_stream_media_type(value)
            .ok_or_else(|| "Invalid media type for stream ranking.".to_string())?,
        None => query_media_type.to_string(),
    };
    let media_id = match ranking_media_id.as_deref() {
        Some(value) => normalize_non_empty(value)
            .ok_or_else(|| "Media ID is required for stream ranking.".to_string())?,
        None => query_id.to_string(),
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
                #[cfg(debug_assertions)]
                eprintln!(
                    "Addon '{}' query {} for '{}' failed: {}",
                    source_name,
                    index + 1,
                    query_id,
                    error
                );
                last_error = Some(format!("{}: {}", source_name, error));
            }
            Err(_) => {
                let error = format!("{} timed out after {}s", source_name, timeout_secs);
                #[cfg(debug_assertions)]
                eprintln!(
                    "Addon '{}' query {} for '{}' timed out after {}s",
                    source_name,
                    index + 1,
                    query_id,
                    timeout_secs
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

pub(crate) async fn fetch_ranked_streams(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    rd_provider: &RealDebrid,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
) -> Result<Vec<TorrentioStream>, String> {
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
        return Ok(Vec::new());
    }

    let mut futures_vec = Vec::with_capacity(enabled_addons.len());
    for addon in &enabled_addons {
        let query_ids = query_ids.clone();
        let effective_type = effective_type.clone();
        let token = token.clone();
        let addon_url = addon.url.clone();
        let source_name = addon.name.clone();
        futures_vec.push(async move {
            fetch_prepared_streams_for_addon(
                provider,
                rd_provider,
                &effective_type,
                &query_ids,
                token.as_deref(),
                &addon_url,
                &source_name,
            )
            .await
        });
    }

    let all_addon_streams = join_all(futures_vec).await;
    let mut merged: Vec<TorrentioStream> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut errors: Vec<String> = Vec::new();

    for result in all_addon_streams {
        match result {
            Ok(streams) => merge_unique_streams(&mut merged, &mut seen, streams),
            Err(error) => errors.push(error),
        }
    }

    if merged.is_empty() && !errors.is_empty() {
        return Err(errors.into_iter().take(3).collect::<Vec<_>>().join(" | "));
    }

    let addon_source_priorities = build_addon_source_priority_map(&enabled_addons);
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

    Ok(merged)
}
