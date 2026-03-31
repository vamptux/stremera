#![allow(async_fn_in_trait)]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaItem {
    pub id: String,
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub logo: Option<String>,
    pub description: Option<String>,
    pub year: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "relationRole", skip_serializing_if = "Option::is_none")]
    pub relation_role: Option<String>,
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
    #[serde(rename = "type")]
    pub type_: String,
    pub description: Option<String>,
    pub rating: Option<String>,
    pub cast: Option<Vec<String>>,
    pub genres: Option<Vec<String>>,
    pub trailers: Option<Vec<Trailer>>,
    pub episodes: Option<Vec<Episode>>,
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
}

pub mod cinemeta;
pub mod kitsu;
pub mod netflix;
pub mod realdebrid;
pub mod skip_times;
pub mod addons;

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
