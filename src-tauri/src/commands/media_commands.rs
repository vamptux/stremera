use super::{
    normalize_cinemeta_type, normalize_non_empty, normalize_stream_media_type,
    playback_state::{PlaybackEpisodeMappingSnapshot, PlaybackStateService},
};
use crate::providers::{
    AnimeSupplementalMetadata,
    cinemeta::Cinemeta,
    kitsu::{Kitsu, KitsuEpisodePage},
    Episode, MediaDetails, Provider,
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
            .await;
    }

    let media_type = normalize_cinemeta_type(media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    cinemeta_provider.get_details(media_type, id.to_string()).await
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

    let details = fetch_media_details_inner(
        &cinemeta_provider,
        &kitsu_provider,
        &media_type,
        &id,
        include_episodes,
    )
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

    playback_state.cache_episode_mappings(&app, &media_type, &id, Some(&id), &episodes)?;

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

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_episode_stream_mapping(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    id: String,
    canonical_season: u32,
    canonical_episode: u32,
) -> Result<Option<EpisodeStreamMapping>, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type)
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

    let details = fetch_media_details_inner(
        &cinemeta_provider,
        &kitsu_provider,
        &media_type,
        &id,
        true,
    )
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
        .get_episode_mapping(
            &app,
            &media_type,
            &id,
            canonical_season,
            canonical_episode,
        )?
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