use super::{
    episode_navigation::{build_source_episode_coordinates, SourceEpisodeCoordinates},
    media_normalization::normalize_media_details,
    normalize_cinemeta_type, normalize_non_empty, normalize_stream_media_type,
    playback_state::{PlaybackEpisodeMappingSnapshot, PlaybackStateService},
};
use crate::providers::{
    cinemeta::Cinemeta,
    kitsu::{Kitsu, KitsuEpisodePage},
    AnimeSupplementalMetadata, Episode, MediaDetails, Provider,
};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{command, AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeStreamMapping {
    pub lookup_id: String,
    pub canonical_season: u32,
    pub canonical_episode: u32,
    pub source_season: u32,
    pub source_episode: u32,
    pub aniskip_episode: u32,
}

impl From<PlaybackEpisodeMappingSnapshot> for EpisodeStreamMapping {
    fn from(value: PlaybackEpisodeMappingSnapshot) -> Self {
        Self {
            lookup_id: value.source_lookup_id,
            canonical_season: value.canonical_season,
            canonical_episode: value.canonical_episode,
            source_season: value.source_season,
            source_episode: value.source_episode,
            aniskip_episode: value.aniskip_episode,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEpisodesPage {
    pub episodes: Vec<Episode>,
    pub seasons: Vec<u32>,
    pub season_years: HashMap<u32, String>,
    pub total: usize,
    pub total_in_season: usize,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
}

fn fallback_episode_lookup_id(media_id: &str, episodes: &[Episode]) -> String {
    episodes
        .iter()
        .find_map(|episode| episode.imdb_id.as_deref())
        .and_then(normalize_non_empty)
        .unwrap_or_else(|| media_id.to_string())
}

fn source_coordinates_from_mapping(
    mapping: PlaybackEpisodeMappingSnapshot,
) -> SourceEpisodeCoordinates {
    SourceEpisodeCoordinates {
        lookup_id: mapping.source_lookup_id,
        season: mapping.source_season,
        episode: mapping.source_episode,
        aniskip_episode: mapping.aniskip_episode,
    }
}

pub(crate) fn enrich_episode_stream_targets(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: &str,
    episodes: &mut [Episode],
) -> Result<(), String> {
    for episode in episodes.iter_mut() {
        let source = if let Some(mapping) = playback_state.get_episode_mapping(
            app,
            media_type,
            media_id,
            episode.season,
            episode.episode,
        )? {
            source_coordinates_from_mapping(mapping)
        } else {
            build_source_episode_coordinates(episode, fallback_lookup_id)
        };

        episode.stream_lookup_id = Some(source.lookup_id);
        episode.stream_season = Some(source.season);
        episode.stream_episode = Some(source.episode);
        episode.aniskip_episode = Some(source.aniskip_episode);
    }

    Ok(())
}

pub(crate) async fn fetch_media_details_inner(
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    media_type: &str,
    id: &str,
    include_episodes: bool,
) -> Result<MediaDetails, String> {
    if id.starts_with("kitsu:") {
        return kitsu_provider
            .get_details_with_options(id, include_episodes)
            .await
            .map(normalize_media_details);
    }

    let media_type = normalize_cinemeta_type(media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    cinemeta_provider
        .get_details(media_type, id.to_string())
        .await
        .map(normalize_media_details)
}

#[command]
pub async fn get_media_details(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    id: String,
    include_episodes: Option<bool>,
) -> Result<MediaDetails, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let include_episodes = include_episodes.unwrap_or(true);

    let mut details = fetch_media_details_inner(
        &cinemeta_provider,
        &kitsu_provider,
        &media_type,
        &id,
        include_episodes,
    )
    .await?;

    if let Some(episodes) = details.episodes.as_mut() {
        let fallback_lookup_id = details.imdb_id.as_deref().unwrap_or(id.as_str());
        playback_state.cache_episode_mappings(
            &app,
            &media_type,
            &id,
            Some(fallback_lookup_id),
            episodes,
        )?;
        enrich_episode_stream_targets(
            &app,
            playback_state.inner(),
            &media_type,
            &id,
            fallback_lookup_id,
            episodes,
        )?;
    }

    Ok(details)
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_media_episodes(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    id: String,
    season: Option<u32>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<MediaEpisodesPage, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for episodes lookup.".to_string())?;

    if media_type != "anime" && !id.starts_with("kitsu:") {
        return Err(
            "Episode pagination is currently supported for Kitsu anime IDs only.".to_string(),
        );
    }

    let page = page.unwrap_or(0);
    let page_size = page_size.unwrap_or(50);

    let KitsuEpisodePage {
        episodes,
        seasons,
        season_years,
        total,
        total_in_season,
        page,
        page_size,
        has_more,
    } = kitsu_provider
        .get_episodes_page(&id, season, page, page_size)
        .await?;

    let mut episodes = super::media_normalization::normalize_episode_metadata_list(episodes);
    let fallback_lookup_id = fallback_episode_lookup_id(&id, &episodes);

    playback_state.cache_episode_mappings(
        &app,
        &media_type,
        &id,
        Some(&fallback_lookup_id),
        &episodes,
    )?;
    enrich_episode_stream_targets(
        &app,
        playback_state.inner(),
        &media_type,
        &id,
        &fallback_lookup_id,
        &mut episodes,
    )?;

    Ok(MediaEpisodesPage {
        episodes,
        seasons,
        season_years,
        total,
        total_in_season,
        page,
        page_size,
        has_more,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn resolve_episode_stream_mapping_inner(
    app: AppHandle,
    playback_state: &PlaybackStateService,
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    media_type: &str,
    id: &str,
    canonical_season: u32,
    canonical_episode: u32,
) -> Result<Option<EpisodeStreamMapping>, String> {
    let id = normalize_non_empty(id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(media_type)
        .ok_or_else(|| "Invalid media type for episode mapping lookup.".to_string())?;

    if media_type == "movie" {
        return Ok(None);
    }

    if let Some(mapping) = playback_state.get_episode_mapping(
        &app,
        &media_type,
        &id,
        canonical_season,
        canonical_episode,
    )? {
        return Ok(Some(mapping.into()));
    }

    let details =
        fetch_media_details_inner(cinemeta_provider, kitsu_provider, &media_type, &id, true)
            .await?;

    if let Some(episodes) = details.episodes.as_ref() {
        let fallback_lookup_id = details.imdb_id.as_deref().unwrap_or(id.as_str());
        playback_state.cache_episode_mappings(
            &app,
            &media_type,
            &id,
            Some(fallback_lookup_id),
            episodes,
        )?;
    }

    Ok(playback_state
        .get_episode_mapping(&app, &media_type, &id, canonical_season, canonical_episode)?
        .map(Into::into))
}

#[command]
pub async fn get_kitsu_anime_metadata(
    kitsu_provider: State<'_, Kitsu>,
    id: String,
) -> Result<AnimeSupplementalMetadata, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    if !id.starts_with("kitsu:") {
        return Err("Anime metadata is currently supported for Kitsu titles only.".to_string());
    }

    kitsu_provider.get_anime_supplemental_metadata(&id).await
}
