use super::{
    build_provider_http_client, normalize_media_year, Episode, MediaDetails, MediaItem, Provider,
};
use futures_util::future::join_all;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use urlencoding::encode;

const BASE_URL: &str = "https://v3-cinemeta.strem.io";
const DISCOVER_PAGE_SKIPS: [Option<u32>; 2] = [None, Some(50)];

pub struct Cinemeta {
    client: Client,
}

impl Cinemeta {
    pub fn new() -> Self {
        Self {
            client: build_provider_http_client(Some(10)),
        }
    }

    pub async fn get_anime_trending(
        &self,
        genre: Option<String>,
    ) -> Result<Vec<MediaItem>, String> {
        // Anime is surfaced through Cinemeta "series" catalogs using genre=Anime by default.
        let effective_genre = genre.or_else(|| Some("Anime".to_string()));
        self.get_discover_catalog("series", "top", effective_genre)
            .await
    }

    pub async fn get_catalog(
        &self,
        type_: &str,
        catalog_id: &str,
        genre: Option<String>,
        skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
        // Cinemeta ignores query-string pagination, but it does honour Stremio-style
        // path extras (`/skip=50.json` or `/genre=Anime&skip=50.json`) for browse catalogs.
        self.fetch_catalog_page(type_, catalog_id, &genre, skip)
            .await
    }

    /// Fetch from *both* `top` and `imdbRating` catalogs in parallel and merge the
    /// results. The user's selected feed (`primary_catalog`) determines which items
    /// appear first. This roughly doubles the available content (~70-90 unique items
    /// vs ~40-50 from a single endpoint).
    pub async fn get_discover_catalog(
        &self,
        type_: &str,
        primary_catalog: &str,
        genre: Option<String>,
    ) -> Result<Vec<MediaItem>, String> {
        let secondary_catalog = if primary_catalog == "imdbRating" {
            "top"
        } else {
            "imdbRating"
        };

        let mut all_items: Vec<MediaItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        let mut requests = Vec::with_capacity(DISCOVER_PAGE_SKIPS.len() * 2);
        for skip in DISCOVER_PAGE_SKIPS {
            requests.push((primary_catalog, genre.clone(), skip));
        }
        for skip in DISCOVER_PAGE_SKIPS {
            requests.push((secondary_catalog, genre.clone(), skip));
        }

        let results = join_all(
            requests
                .into_iter()
                .map(|(catalog_id, genre, skip)| async move {
                    self.fetch_catalog_page(type_, catalog_id, &genre, skip)
                        .await
                }),
        )
        .await;
        let mut had_success = false;
        let mut last_error: Option<String> = None;

        for result in results {
            match result {
                Ok(items) => {
                    had_success = true;
                    for item in items {
                        if seen.insert(item.id.clone()) {
                            all_items.push(item);
                        }
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }

        if !had_success {
            return Err(last_error.unwrap_or_else(|| "Cinemeta discover failed.".to_string()));
        }

        Ok(all_items)
    }

    pub async fn search_with_media_type(
        &self,
        query: &str,
        media_type: Option<&str>,
    ) -> Result<Vec<MediaItem>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        self.search_catalogs(query, media_type).await
    }

    /// Fetch a single catalog page from one Cinemeta endpoint.
    async fn fetch_catalog_page(
        &self,
        type_: &str,
        catalog_id: &str,
        genre: &Option<String>,
        skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
        let url = Self::build_catalog_url(type_, catalog_id, genre.as_deref(), skip);

        #[cfg(debug_assertions)]
        eprintln!("Fetching Cinemeta Catalog: {}", url);

        self.fetch_catalog_items_from_url(&url).await
    }

    fn build_catalog_url(
        type_: &str,
        catalog_id: &str,
        genre: Option<&str>,
        skip: Option<u32>,
    ) -> String {
        let mut url = format!("{}/catalog/{}/{}", BASE_URL, type_, catalog_id);

        let extras = match (genre, skip.filter(|value| *value > 0)) {
            (Some(genre_name), Some(skip)) => {
                Some(format!("genre={}&skip={}", encode(genre_name), skip))
            }
            (Some(genre_name), None) => Some(format!("genre={}", encode(genre_name))),
            (None, Some(skip)) => Some(format!("skip={}", skip)),
            (None, None) => None,
        };

        if let Some(extras) = extras {
            url.push('/');
            url.push_str(&extras);
        }

        url.push_str(".json");
        url
    }

    fn build_search_catalog_url(type_: &str, catalog_id: &str, query: &str) -> String {
        format!(
            "{}/catalog/{}/{}/search={}.json",
            BASE_URL,
            type_,
            catalog_id,
            encode(query)
        )
    }

    fn normalize_search_media_scope(
        media_type: Option<&str>,
    ) -> Result<&'static [&'static str], String> {
        match media_type.map(|value| value.trim().to_ascii_lowercase()) {
            Some(value) if value == "movie" => Ok(&["movie"]),
            Some(value) if value == "series" => Ok(&["series"]),
            Some(_) => Err("Invalid media type for search. Expected movie or series.".to_string()),
            None => Ok(&["movie", "series"]),
        }
    }

    async fn search_catalogs(
        &self,
        query: &str,
        media_type: Option<&str>,
    ) -> Result<Vec<MediaItem>, String> {
        let media_types = Self::normalize_search_media_scope(media_type)?;
        let mut urls = Vec::with_capacity(media_types.len() * 2);

        for media_type in media_types {
            urls.push(Self::build_search_catalog_url(media_type, "top", query));
            urls.push(Self::build_search_catalog_url(
                media_type,
                "imdbRating",
                query,
            ));
        }

        let results = join_all(
            urls.iter()
                .map(|url| self.fetch_catalog_items_from_url(url)),
        )
        .await;
        let mut merged = Vec::new();
        let mut seen = HashSet::new();
        let mut had_success = false;
        let mut last_error: Option<String> = None;

        for result in results {
            match result {
                Ok(items) => {
                    had_success = true;
                    for item in items {
                        let key = format!("{}:{}", item.type_, item.id);
                        if seen.insert(key) {
                            merged.push(item);
                        }
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }

        if !had_success {
            return Err(last_error.unwrap_or_else(|| "Cinemeta search failed.".to_string()));
        }

        Ok(merged)
    }

    fn map_catalog_items(catalog: CatalogResponse) -> Vec<MediaItem> {
        catalog
            .metas
            .into_iter()
            .map(|m| MediaItem {
                id: m.id,
                title: m.name,
                poster: m.poster,
                backdrop: m.background,
                logo: m.logo,
                description: m.description,
                year: normalize_media_year(m.year, m.release_info),
                primary_year: None,
                display_year: None,
                type_: m.type_,
                relation_role: None,
                relation_context_label: None,
                relation_preferred_season: None,
            })
            .collect()
    }

    fn parse_catalog_response(text: &str) -> Result<CatalogResponse, String> {
        serde_json::from_str(text).map_err(|e| format!("Parse Error: {}", e))
    }

    fn parse_meta_response(text: &str) -> Result<Meta, String> {
        let body: MetaResponse = serde_json::from_str(text).map_err(|e| {
            #[cfg(debug_assertions)]
            {
                eprintln!("JSON Parse Error: {}", e);
                eprintln!("Snippet: {}", &text.chars().take(200).collect::<String>());
            }
            format!("JSON Parse Error: {}", e)
        })?;

        body.meta.ok_or_else(|| {
            #[cfg(debug_assertions)]
            eprintln!(
                "Cinemeta detail response missing meta field. Snippet: {}",
                &text.chars().take(200).collect::<String>()
            );
            "Metadata not found.".to_string()
        })
    }

    async fn fetch_catalog_items_from_url(&self, url: &str) -> Result<Vec<MediaItem>, String> {
        let res = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("API Error: {}", res.status()));
        }

        let text = res.text().await.map_err(|e| e.to_string())?;
        let catalog = Self::parse_catalog_response(&text)?;

        Ok(Self::map_catalog_items(catalog))
    }
}

impl Default for Cinemeta {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default, Deserialize)]
struct CatalogResponse {
    #[serde(default)]
    metas: Vec<Meta>,
}

#[derive(Deserialize)]
struct MetaResponse {
    #[serde(default)]
    meta: Option<Meta>,
}

#[derive(Deserialize, Debug)]
struct Meta {
    id: String,
    name: String,
    #[serde(rename = "type")]
    type_: String,
    poster: Option<String>,
    background: Option<String>,
    logo: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "releaseInfo", default)]
    release_info: Option<String>,
    year: Option<String>,
    #[serde(alias = "imdbRating")]
    rating: Option<String>,
    #[serde(default)]
    cast: Option<Vec<String>>,
    #[serde(default)]
    genre: Option<Vec<String>>,
    #[serde(default)]
    trailers: Option<Vec<MetaStream>>,
    #[serde(default)]
    videos: Option<Vec<MetaVideo>>,
}

#[derive(Deserialize, Debug)]
struct MetaStream {
    source: String,
    #[serde(rename = "type")]
    type_: String,
}

#[derive(Deserialize, Debug)]
struct MetaVideo {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    season: u32,
    // episode and number both exist in response, causing duplicate field error if aliased.
    #[serde(default)]
    episode: u32,
    #[serde(default)]
    released: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    thumbnail: Option<String>,
}

impl Provider for Cinemeta {
    async fn get_trending(
        &self,
        type_: String,
        genre: Option<String>,
    ) -> Result<Vec<MediaItem>, String> {
        self.get_catalog(&type_, "top", genre, None).await
    }

    async fn search(&self, query: String) -> Result<Vec<MediaItem>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        self.search_catalogs(query, None).await
    }

    async fn get_details(&self, type_: String, id: String) -> Result<MediaDetails, String> {
        let encoded_id = encode(&id).into_owned();
        let url = format!("{}/meta/{}/{}.json", BASE_URL, type_, encoded_id);
        #[cfg(debug_assertions)]
        eprintln!("Fetching Details: {}", url);
        let res = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            #[cfg(debug_assertions)]
            eprintln!("API Error Status: {}", res.status());
            return Err(format!("API Error: {}", res.status()));
        }

        let text = res.text().await.map_err(|e| e.to_string())?;

        let m = Self::parse_meta_response(&text)?;

        // For Cinemeta, the ID is already an IMDB ID
        let imdb_id = if m.id.starts_with("tt") {
            Some(m.id.clone())
        } else {
            None
        };

        Ok(MediaDetails {
            id: m.id,
            imdb_id,
            title: m.name,
            poster: m.poster,
            backdrop: m.background,
            logo: m.logo,
            year: normalize_media_year(m.year, m.release_info),
            primary_year: None,
            display_year: None,
            release_date: None,
            type_: m.type_,
            description: m.description,
            rating: m.rating,
            cast: m.cast,
            genres: m.genre,
            trailers: m.trailers.map(|ts| {
                ts.into_iter()
                    .filter(|t| t.type_ == "Trailer")
                    .map(|t| super::Trailer {
                        id: t.source.clone(),
                        source: "youtube".to_string(),
                        url: format!("https://www.youtube.com/watch?v={}", t.source),
                    })
                    .collect()
            }),
            episodes: m.videos.map(|videos| {
                videos
                    .into_iter()
                    .map(|v| Episode {
                        id: v.id,
                        title: v.name.or(v.title),
                        season: v.season,
                        episode: v.episode,
                        released: v.released,
                        release_date: None,
                        overview: v.overview,
                        thumbnail: v.thumbnail,
                        imdb_id: None,
                        imdb_season: None,
                        imdb_episode: None,
                        stream_lookup_id: None,
                        stream_season: None,
                        stream_episode: None,
                        aniskip_episode: None,
                    })
                    .collect()
            }),
            season_years: None,
            relations: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_meta_response_returns_not_found_for_empty_object() {
        let err = Cinemeta::parse_meta_response("{}").expect_err("missing meta should fail");
        assert_eq!(err, "Metadata not found.");
    }

    #[test]
    fn parse_catalog_response_treats_empty_object_as_empty_catalog() {
        let catalog = Cinemeta::parse_catalog_response("{}").expect("empty catalog response");
        assert!(catalog.metas.is_empty());
    }
}
