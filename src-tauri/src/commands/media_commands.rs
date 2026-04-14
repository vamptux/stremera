use super::{
    episode_navigation::{build_source_episode_coordinates, SourceEpisodeCoordinates},
    media_normalization::{build_release_date, normalize_media_details},
    normalize_cinemeta_type, normalize_non_empty, normalize_stream_media_type,
    playback_state::{PlaybackEpisodeMappingSnapshot, PlaybackStateService},
};
use crate::providers::{
    cinemeta::Cinemeta,
    kitsu::{Kitsu, KitsuEpisodePage},
    AnimeSupplementalMetadata, Episode, MediaDetails, Provider,
};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

const MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT: usize = 6;

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
    pub filtered_total: usize,
    pub resolved_season: Option<u32>,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaScheduleEpisode {
    pub id: String,
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
    pub release_date: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSchedule {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub title: String,
    pub poster: Option<String>,
    pub release_date: Option<String>,
    pub episodes: Vec<MediaScheduleEpisode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScheduleRequest {
    pub media_type: String,
    pub id: String,
}

fn schedule_episode_release_date(episode: &Episode) -> Option<String> {
    episode
        .release_date
        .clone()
        .or_else(|| build_release_date(episode.released.as_deref()))
}

pub(crate) fn build_media_schedule(mut details: MediaDetails) -> MediaSchedule {
    let mut episodes = details
        .episodes
        .take()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|episode| {
            let release_date = schedule_episode_release_date(&episode)?;

            Some(MediaScheduleEpisode {
                id: episode.id,
                title: episode.title,
                season: episode.season,
                episode: episode.episode,
                release_date,
                thumbnail: episode.thumbnail,
            })
        })
        .collect::<Vec<_>>();

    episodes.sort_by(|left, right| {
        left.release_date
            .cmp(&right.release_date)
            .then_with(|| left.season.cmp(&right.season))
            .then_with(|| left.episode.cmp(&right.episode))
            .then_with(|| left.id.cmp(&right.id))
    });

    MediaSchedule {
        id: details.id,
        type_: details.type_,
        title: details.title,
        poster: details.poster,
        release_date: details.release_date,
        episodes,
    }
}

async fn fetch_media_schedule_inner(
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    media_type: &str,
    id: &str,
) -> Result<MediaSchedule, String> {
    let include_episodes = media_type != "movie";

    let mut schedule = build_media_schedule(
        fetch_media_details_inner(
            cinemeta_provider,
            kitsu_provider,
            media_type,
            id,
            include_episodes,
        )
        .await?,
    );
    schedule.type_ = media_type.to_string();

    Ok(schedule)
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
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for details lookup.".to_string())?;
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
pub async fn get_media_schedules(
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    items: Vec<MediaScheduleRequest>,
) -> Result<Vec<MediaSchedule>, String> {
    let mut seen_requests = HashSet::new();
    let mut normalized_requests = Vec::with_capacity(items.len());

    for item in items {
        let id = normalize_non_empty(&item.id).ok_or_else(|| "Media ID is required.".to_string())?;
        let media_type = normalize_stream_media_type(&item.media_type, Some(&id))
            .ok_or_else(|| "Invalid media type for schedule lookup.".to_string())?;
        let request_key = format!("{media_type}:{id}");

        if seen_requests.insert(request_key) {
            normalized_requests.push((media_type, id));
        }
    }

    if normalized_requests.is_empty() {
        return Ok(Vec::new());
    }

    let cinemeta_provider = cinemeta_provider.inner();
    let kitsu_provider = kitsu_provider.inner();
    let mut outcomes = stream::iter(
        normalized_requests
            .into_iter()
            .enumerate()
            .map(|(index, (media_type, id))| async move {
                let outcome = fetch_media_schedule_inner(
                    cinemeta_provider,
                    kitsu_provider,
                    &media_type,
                    &id,
                )
                .await;

                (index, outcome)
            }),
    )
    .buffer_unordered(MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT)
    .collect::<Vec<_>>()
    .await;
    outcomes.sort_by_key(|(index, _)| *index);

    let mut schedules = Vec::new();
    let mut errors = Vec::new();

    for (_, outcome) in outcomes {
        match outcome {
            Ok(schedule) => schedules.push(schedule),
            Err(error) => {
                if errors.len() < 3 {
                    errors.push(error);
                }
            }
        }
    }

    if schedules.is_empty() && !errors.is_empty() {
        return Err(errors.join(" | "));
    }

    Ok(schedules)
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
    query: Option<String>,
) -> Result<MediaEpisodesPage, String> {
    let id = normalize_non_empty(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for episodes lookup.".to_string())?;

    if media_type != "anime" && !id.starts_with("kitsu:") {
        return Err(
            "Episode pagination is currently supported for Kitsu anime IDs only.".to_string(),
        );
    }

    let page = page.unwrap_or(0);
    let page_size = page_size.unwrap_or(50);
    let query = query.as_deref().and_then(normalize_non_empty);

    let KitsuEpisodePage {
        episodes,
        seasons,
        season_years,
        total,
        total_in_season,
        filtered_total,
        resolved_season,
        page,
        page_size,
        has_more,
    } = kitsu_provider
        .get_episodes_page(&id, season, page, page_size, query.as_deref())
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
        filtered_total,
        resolved_season,
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
    let media_type = normalize_stream_media_type(media_type, Some(&id))
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

#[cfg(test)]
mod tests {
    use super::build_media_schedule;
    use crate::providers::{Episode, MediaDetails};

    fn episode(id: &str, season: u32, episode: u32, release_date: Option<&str>) -> Episode {
        Episode {
            id: id.to_string(),
            title: Some(format!("Episode {episode}")),
            season,
            episode,
            released: release_date.map(|value| value.to_string()),
            release_date: None,
            overview: None,
            thumbnail: None,
            imdb_id: None,
            imdb_season: None,
            imdb_episode: None,
            stream_lookup_id: None,
            stream_season: None,
            stream_episode: None,
            aniskip_episode: None,
        }
    }

    #[test]
    fn build_media_schedule_filters_undated_episodes_and_sorts_by_release_date() {
        let schedule = build_media_schedule(MediaDetails {
            id: "tt123".to_string(),
            imdb_id: None,
            title: "Test Show".to_string(),
            poster: Some("poster".to_string()),
            backdrop: None,
            logo: None,
            year: Some("2025".to_string()),
            primary_year: None,
            display_year: None,
            release_date: Some("2025-01-01".to_string()),
            type_: "series".to_string(),
            description: None,
            rating: None,
            cast: None,
            genres: None,
            trailers: None,
            episodes: Some(vec![
                episode("ep-2", 1, 2, Some("2025-02-12")),
                episode("ep-0", 1, 0, None),
                Episode {
                    release_date: Some("2025-01-14".to_string()),
                    ..episode("ep-1", 1, 1, None)
                },
            ]),
            season_years: None,
            relations: None,
        });

        assert_eq!(schedule.episodes.len(), 2);
        assert_eq!(schedule.episodes[0].id, "ep-1");
        assert_eq!(schedule.episodes[0].release_date, "2025-01-14");
        assert_eq!(schedule.episodes[1].id, "ep-2");
    }

    #[test]
    fn build_media_schedule_keeps_movie_release_date_without_episode_payload() {
        let schedule = build_media_schedule(MediaDetails {
            id: "tt999".to_string(),
            imdb_id: Some("tt999".to_string()),
            title: "Test Movie".to_string(),
            poster: Some("poster".to_string()),
            backdrop: None,
            logo: None,
            year: Some("2024".to_string()),
            primary_year: Some(2024),
            display_year: Some("2024".to_string()),
            release_date: Some("2024-01-01".to_string()),
            type_: "movie".to_string(),
            description: None,
            rating: None,
            cast: None,
            genres: None,
            trailers: None,
            episodes: None,
            season_years: None,
            relations: None,
        });

        assert_eq!(schedule.release_date.as_deref(), Some("2024-01-01"));
        assert!(schedule.episodes.is_empty());
    }
}
