#![allow(async_fn_in_trait)]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaItem {
    pub id: String,
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub logo: Option<String>,
    pub description: Option<String>,
    pub year: Option<String>,
    #[serde(rename = "primaryYear", skip_serializing_if = "Option::is_none")]
    pub primary_year: Option<u32>,
    #[serde(rename = "displayYear", skip_serializing_if = "Option::is_none")]
    pub display_year: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "relationRole", skip_serializing_if = "Option::is_none")]
    pub relation_role: Option<String>,
    #[serde(
        rename = "relationContextLabel",
        skip_serializing_if = "Option::is_none"
    )]
    pub relation_context_label: Option<String>,
    #[serde(
        rename = "relationPreferredSeason",
        skip_serializing_if = "Option::is_none"
    )]
    pub relation_preferred_season: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaDetails {
    pub id: String,
    #[serde(rename = "imdbId")]
    pub imdb_id: Option<String>,
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub logo: Option<String>,
    pub year: Option<String>,
    #[serde(rename = "primaryYear", skip_serializing_if = "Option::is_none")]
    pub primary_year: Option<u32>,
    #[serde(rename = "displayYear", skip_serializing_if = "Option::is_none")]
    pub display_year: Option<String>,
    #[serde(rename = "releaseDate", skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    pub description: Option<String>,
    pub rating: Option<String>,
    pub cast: Option<Vec<String>>,
    pub genres: Option<Vec<String>>,
    pub trailers: Option<Vec<Trailer>>,
    pub episodes: Option<Vec<Episode>>,
    #[serde(rename = "seasonYears", skip_serializing_if = "Option::is_none")]
    pub season_years: Option<HashMap<u32, String>>,
    pub relations: Option<Vec<MediaItem>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeCharacterProfile {
    pub name: String,
    pub role: Option<String>,
    pub image: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeStaffProfile {
    pub name: String,
    pub roles: Vec<String>,
    pub image: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeStreamingPlatformProfile {
    pub name: String,
    pub url: String,
    pub logo: Option<String>,
    pub sub_languages: Vec<String>,
    pub dub_languages: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeProductionCompanyProfile {
    pub name: String,
    pub roles: Vec<String>,
    pub logo: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeSupplementalMetadata {
    pub characters: Vec<AnimeCharacterProfile>,
    pub staff: Vec<AnimeStaffProfile>,
    pub productions: Vec<AnimeProductionCompanyProfile>,
    pub platforms: Vec<AnimeStreamingPlatformProfile>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Trailer {
    pub id: String,
    pub source: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Episode {
    pub id: String,
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
    pub released: Option<String>,
    #[serde(rename = "releaseDate", skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    pub overview: Option<String>,
    pub thumbnail: Option<String>,
    /// IMDB ID for this episode's parent series (e.g. "tt0388629")
    #[serde(rename = "imdbId", skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    /// IMDB season number (may differ from source season, e.g. Kitsu season 1 → IMDB season 21)
    #[serde(rename = "imdbSeason", skip_serializing_if = "Option::is_none")]
    pub imdb_season: Option<u32>,
    /// IMDB episode number within the IMDB season
    #[serde(rename = "imdbEpisode", skip_serializing_if = "Option::is_none")]
    pub imdb_episode: Option<u32>,
    /// Backend-normalized playback lookup ID for this episode.
    #[serde(rename = "streamLookupId", skip_serializing_if = "Option::is_none")]
    pub stream_lookup_id: Option<String>,
    /// Backend-normalized source season used when resolving streams for this episode.
    #[serde(rename = "streamSeason", skip_serializing_if = "Option::is_none")]
    pub stream_season: Option<u32>,
    /// Backend-normalized source episode used when resolving streams for this episode.
    #[serde(rename = "streamEpisode", skip_serializing_if = "Option::is_none")]
    pub stream_episode: Option<u32>,
    /// Backend-normalized AniSkip episode number for this episode.
    #[serde(rename = "aniskipEpisode", skip_serializing_if = "Option::is_none")]
    pub aniskip_episode: Option<u32>,
}

pub mod addons;
pub mod cinemeta;
pub mod kitsu;
pub mod netflix;
pub mod realdebrid;
pub mod skip_times;

fn trim_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(crate) fn normalize_media_year(
    year: Option<String>,
    release_info: Option<String>,
) -> Option<String> {
    trim_non_empty(year).or_else(|| trim_non_empty(release_info))
}

pub(crate) fn extract_primary_year(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    if value.len() < 4 {
        return None;
    }

    let bytes = value.as_bytes();
    for index in 0..=bytes.len().saturating_sub(4) {
        let year_text = &value[index..index + 4];
        if !year_text
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }

        let Ok(year) = year_text.parse::<u32>() else {
            continue;
        };

        if (1889..=2100).contains(&year) {
            return Some(year);
        }
    }

    None
}

fn build_season_year_label(years: &[u32]) -> Option<String> {
    let first = *years.first()?;
    let last = *years.last()?;

    Some(if first != last {
        format!("{}-{}", first, last)
    } else {
        first.to_string()
    })
}

pub(crate) fn build_episode_season_years(episodes: &[Episode]) -> Option<HashMap<u32, String>> {
    let mut years_by_season: HashMap<u32, Vec<u32>> = HashMap::new();

    for episode in episodes {
        let Some(year) = extract_primary_year(
            episode
                .release_date
                .as_deref()
                .or(episode.released.as_deref()),
        ) else {
            continue;
        };

        years_by_season
            .entry(episode.season)
            .or_default()
            .push(year);
    }

    let mut season_years = HashMap::new();

    for (season, mut years) in years_by_season {
        years.sort_unstable();
        years.dedup();

        let Some(label) = build_season_year_label(&years) else {
            continue;
        };

        season_years.insert(season, label);
    }

    (!season_years.is_empty()).then_some(season_years)
}

pub(crate) fn build_provider_http_client(max_idle_per_host: Option<usize>) -> Client {
    let mut builder = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90));

    if let Some(max_idle_per_host) = max_idle_per_host {
        builder = builder.pool_max_idle_per_host(max_idle_per_host);
    }

    builder.build().unwrap_or_else(|_| Client::new())
}

#[allow(async_fn_in_trait)]
pub trait Provider {
    async fn get_trending(
        &self,
        type_: String,
        genre: Option<String>,
    ) -> Result<Vec<MediaItem>, String>;
    async fn search(&self, query: String) -> Result<Vec<MediaItem>, String>;
    async fn get_details(&self, type_: String, id: String) -> Result<MediaDetails, String>;
}
