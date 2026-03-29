use super::{Episode, MediaDetails, MediaItem, Provider, build_provider_http_client};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use urlencoding::encode;

const BASE_URL: &str = "https://v3-cinemeta.strem.io";

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
        self.get_catalog("series", "top", effective_genre, None)
            .await
    }

    pub async fn get_catalog(
        &self,
        type_: &str,
        catalog_id: &str,
        genre: Option<String>,
        _skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
        // NOTE: Cinemeta's `?skip=N` query parameter does NOT return different items —
        // the API consistently returns the same fixed set of ~40-50 items regardless of
        // the skip offset. This was verified by live testing. Therefore we always fetch
        // a single page per catalog endpoint (no pagination loop).
        self.fetch_catalog_page(type_, catalog_id, &genre).await
    }

    /// Fetch from *both* `top` and `imdbRating` catalogs in parallel and merge the
    /// results.  The user's selected feed (`primary_catalog`) determines which items
    /// appear first.  This roughly doubles the available content (~70-90 unique items
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

        let genre_clone = genre.clone();
        let (primary_res, secondary_res) = tokio::join!(
            self.fetch_catalog_page(type_, primary_catalog, &genre),
            self.fetch_catalog_page(type_, secondary_catalog, &genre_clone),
        );

        let mut all_items: Vec<MediaItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        // Primary catalog first (preserves user's feed preference ordering)
        for item in primary_res? {
            if seen.insert(item.id.clone()) {
                all_items.push(item);
            }
        }

        // Append secondary catalog items for additional content
        match secondary_res {
            Ok(items) => {
                for item in items {
                    if seen.insert(item.id.clone()) {
                        all_items.push(item);
                    }
                }
            }
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("Secondary catalog fetch failed (non-fatal): {}", _e);
            }
        }

        Ok(all_items)
    }

    /// Fetch a single catalog page from one Cinemeta endpoint.
    async fn fetch_catalog_page(
        &self,
        type_: &str,
        catalog_id: &str,
        genre: &Option<String>,
    ) -> Result<Vec<MediaItem>, String> {
        let url = Self::build_catalog_url(type_, catalog_id, genre.as_deref());

        #[cfg(debug_assertions)]
        eprintln!("Fetching Cinemeta Catalog: {}", url);

        self.fetch_catalog_items_from_url(&url).await
    }

    fn build_catalog_url(type_: &str, catalog_id: &str, genre: Option<&str>) -> String {
        if let Some(genre_name) = genre {
            format!(
                "{}/catalog/{}/{}/genre={}.json",
                BASE_URL,
                type_,
                catalog_id,
                encode(genre_name)
            )
        } else {
            format!("{}/catalog/{}/{}.json", BASE_URL, type_, catalog_id)
        }
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
                year: m.year,
                type_: m.type_,
                relation_role: None,
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
    // releaseInfo and year both exist in response, causing duplicate field error if aliased.
    // We'll trust 'year' is present.
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
    #[serde(default)] // title/name
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

        let mut results = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut had_success = false;
        let mut last_error: Option<String> = None;
        let movie_top_url = Self::build_search_catalog_url("movie", "top", query);
        let movie_imdb_rating_url = Self::build_search_catalog_url("movie", "imdbRating", query);
        let series_top_url = Self::build_search_catalog_url("series", "top", query);
        let series_imdb_rating_url = Self::build_search_catalog_url("series", "imdbRating", query);

        let (movie_top_res, movie_imdb_rating_res, series_top_res, series_imdb_rating_res) = tokio::join!(
            self.fetch_catalog_items_from_url(&movie_top_url),
            self.fetch_catalog_items_from_url(&movie_imdb_rating_url),
            self.fetch_catalog_items_from_url(&series_top_url),
            self.fetch_catalog_items_from_url(&series_imdb_rating_url)
        );

        for result in [
            movie_top_res,
            movie_imdb_rating_res,
            series_top_res,
            series_imdb_rating_res,
        ] {
            match result {
                Ok(items) => {
                    had_success = true;
                    for item in items {
                        let key = format!("{}:{}", item.type_, item.id);
                        if seen.insert(key) {
                            results.push(item);
                        }
                    }
                }
                Err(err) => {
                    last_error = Some(err);
                }
            }
        }

        if !had_success {
            return Err(last_error.unwrap_or_else(|| "Cinemeta search failed.".to_string()));
        }

        Ok(results)
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
            year: m.year,
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
                        overview: v.overview,
                        thumbnail: v.thumbnail,
                        imdb_id: None,
                        imdb_season: None,
                        imdb_episode: None,
                    })
                    .collect()
            }),
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
