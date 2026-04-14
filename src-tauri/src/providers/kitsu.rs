use super::{
    build_episode_season_years, build_provider_http_client, normalize_media_year,
    AnimeSupplementalMetadata, Episode, MediaDetails, MediaItem, Trailer,
};
use crate::operational_log::{field, log_operational_event, OperationalLogLevel};
use futures_util::future::join_all;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use urlencoding::encode;

mod supplements;

const BASE_URL: &str = "https://anime-kitsu.strem.fun";
const EDGE_BASE_URL: &str = "https://kitsu.io/api/edge/anime";
const EDGE_PAGE_LIMIT: usize = 20;
const EDGE_SUPPLEMENT_OFFSETS: [usize; 2] = [20, 40];
const RELATION_LIMIT: usize = 8;
const ANIME_CHARACTER_LIMIT: usize = 10;
const ANIME_STAFF_LIMIT: usize = 10;
const ANIME_PRODUCTION_LIMIT: usize = 8;
const ANIME_STREAMING_PLATFORM_LIMIT: usize = 8;

pub struct Kitsu {
    client: Client,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitsuEpisodePage {
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

impl Kitsu {
    fn supplemental_warning(section: &'static str) -> String {
        format!(
            "{} metadata is temporarily unavailable from Kitsu.",
            section
        )
    }

    fn normalize_text(value: &str) -> Option<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn title_case_label(value: &str) -> String {
        value
            .split('_')
            .flat_map(|segment| segment.split_whitespace())
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                let mut chars = segment.chars();
                let Some(first) = chars.next() else {
                    return String::new();
                };

                let mut word = String::new();
                word.extend(first.to_uppercase());
                word.push_str(&chars.as_str().to_ascii_lowercase());
                word
            })
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn extract_value_string(value: &Value, pointer: &str) -> Option<String> {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .and_then(Self::normalize_text)
    }

    fn extract_image_url(value: &Value, field: &str) -> Option<String> {
        for size in ["original", "large", "medium", "small", "tiny"] {
            let pointer = format!("/attributes/{}/{}", field, size);
            if let Some(image) = Self::extract_value_string(value, &pointer) {
                return Some(image);
            }
        }

        None
    }

    fn character_role_priority(role: Option<&str>) -> u8 {
        match role
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "main" => 3,
            "supporting" => 2,
            _ => 1,
        }
    }

    fn staff_role_priority(role: &str) -> u8 {
        let normalized = role.trim().to_ascii_lowercase();

        if normalized.contains("director") {
            7
        } else if normalized.contains("original") || normalized.contains("creator") {
            6
        } else if normalized.contains("screenplay")
            || normalized.contains("script")
            || normalized.contains("series composition")
            || normalized.contains("writer")
        {
            5
        } else if normalized.contains("music") || normalized.contains("composer") {
            4
        } else if normalized.contains("producer") {
            3
        } else if normalized.contains("character") || normalized.contains("design") {
            2
        } else {
            1
        }
    }

    fn production_role_priority(role: &str) -> u8 {
        let normalized = role.trim().to_ascii_lowercase();

        if normalized.contains("studio") || normalized.contains("animation") {
            5
        } else if normalized.contains("licensor") || normalized.contains("publisher") {
            4
        } else if normalized.contains("producer") || normalized.contains("production") {
            3
        } else if normalized.contains("committee") {
            2
        } else {
            1
        }
    }

    fn format_language_label(value: &str) -> Option<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return None;
        }

        let normalized = trimmed.replace('_', "-");
        let parts = normalized
            .split('-')
            .flat_map(|segment| segment.split_whitespace())
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();

        if parts.is_empty() {
            return None;
        }

        let is_code = parts.iter().all(|segment| {
            segment.chars().all(|char| char.is_ascii_alphabetic()) && segment.len() <= 3
        });

        if is_code {
            return Some(
                parts
                    .into_iter()
                    .map(|segment| segment.to_ascii_uppercase())
                    .collect::<Vec<_>>()
                    .join("-"),
            );
        }

        Some(
            parts
                .into_iter()
                .map(|segment| {
                    let mut chars = segment.chars();
                    let Some(first) = chars.next() else {
                        return String::new();
                    };

                    let mut word = String::new();
                    word.extend(first.to_uppercase());
                    word.push_str(&chars.as_str().to_ascii_lowercase());
                    word
                })
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        )
    }

    fn extract_language_labels(value: &Value, pointer: &str) -> Vec<String> {
        let mut labels = Vec::new();

        for label in value
            .pointer(pointer)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(Self::format_language_label)
        {
            if !labels.iter().any(|existing| existing == &label) {
                labels.push(label);
            }
        }

        labels.sort();
        labels
    }

    fn should_replace_platform_url(current_url: &str, candidate_url: &str) -> bool {
        let current_https = current_url.starts_with("https://");
        let candidate_https = candidate_url.starts_with("https://");

        if candidate_https != current_https {
            return candidate_https;
        }

        reqwest::Url::parse(current_url).is_err() && reqwest::Url::parse(candidate_url).is_ok()
    }

    async fn fetch_edge_value(&self, url: &str) -> Result<Value, String> {
        let response = self
            .client
            .get(url)
            .header("Accept", "application/vnd.api+json")
            .header("Content-Type", "application/vnd.api+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("API Error: {}", response.status()));
        }

        let text = response.text().await.map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("Parse Error: {}", e))
    }

    pub fn new() -> Self {
        Self {
            client: build_provider_http_client(None),
        }
    }

    fn merge_items_in_order<I>(batches: I) -> Vec<MediaItem>
    where
        I: IntoIterator<Item = Vec<MediaItem>>,
    {
        let mut items = Vec::new();
        let mut seen_ids = HashSet::new();

        for batch in batches {
            for item in batch {
                if seen_ids.insert(item.id.clone()) {
                    items.push(item);
                }
            }
        }

        items
    }

    fn build_edge_catalog_url(
        sort: &str,
        genre: Option<&str>,
        status: Option<&str>,
        offset: Option<usize>,
    ) -> String {
        let mut query = vec![
            format!("page[limit]={}", EDGE_PAGE_LIMIT),
            format!("sort={}", sort),
        ];

        if let Some(offset) = offset.filter(|value| *value > 0) {
            query.push(format!("page[offset]={}", offset));
        }

        if let Some(status) = status {
            query.push(format!("filter[status]={}", status));
        }

        if let Some(genre) = genre {
            query.push(format!("filter[categories]={}", encode(genre)));
        }

        format!("{}?{}", EDGE_BASE_URL, query.join("&"))
    }

    fn map_edge_item(entry: &Value) -> Option<MediaItem> {
        let id = entry.get("id").and_then(Value::as_str)?;
        let title = Self::extract_value_string(entry, "/attributes/canonicalTitle")
            .or_else(|| Self::extract_value_string(entry, "/attributes/titles/en"))
            .or_else(|| Self::extract_value_string(entry, "/attributes/titles/en_jp"))
            .or_else(|| Self::extract_value_string(entry, "/attributes/titles/ja_jp"))?;
        let subtype = Self::extract_value_string(entry, "/attributes/subtype");
        let media_type = if subtype
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("movie"))
        {
            "movie"
        } else {
            "series"
        };

        Some(MediaItem {
            id: format!("kitsu:{}", id),
            title,
            poster: Self::extract_image_url(entry, "posterImage"),
            backdrop: Self::extract_image_url(entry, "coverImage"),
            logo: None,
            description: Self::extract_value_string(entry, "/attributes/synopsis")
                .or_else(|| Self::extract_value_string(entry, "/attributes/description")),
            year: Self::extract_value_string(entry, "/attributes/startDate"),
            primary_year: None,
            display_year: None,
            type_: media_type.to_string(),
            relation_role: None,
            relation_context_label: None,
            relation_preferred_season: None,
        })
    }

    fn map_edge_catalog_items(body: &Value) -> Vec<MediaItem> {
        body.get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Self::map_edge_item)
            .collect()
    }

    async fn fetch_edge_catalog_items(
        &self,
        sort: &str,
        genre: Option<&str>,
        status: Option<&str>,
        offset: Option<usize>,
    ) -> Result<Vec<MediaItem>, String> {
        let url = Self::build_edge_catalog_url(sort, genre, status, offset);

        let body = self.fetch_edge_value(&url).await?;
        Ok(Self::map_edge_catalog_items(&body))
    }

    async fn fetch_catalog_supplements(
        &self,
        catalog_id: &str,
        genre: Option<&str>,
    ) -> Vec<Vec<MediaItem>> {
        let requests = match catalog_id {
            "kitsu-anime-popular" => {
                if genre.is_some() {
                    vec![self.fetch_edge_catalog_items("ratingRank", genre, None, None)]
                } else {
                    EDGE_SUPPLEMENT_OFFSETS
                        .into_iter()
                        .map(|offset| {
                            self.fetch_edge_catalog_items(
                                "popularityRank",
                                None,
                                None,
                                Some(offset),
                            )
                        })
                        .collect::<Vec<_>>()
                }
            }
            "kitsu-anime-rating" => {
                if genre.is_some() {
                    vec![self.fetch_edge_catalog_items("popularityRank", genre, None, None)]
                } else {
                    EDGE_SUPPLEMENT_OFFSETS
                        .into_iter()
                        .map(|offset| {
                            self.fetch_edge_catalog_items("ratingRank", None, None, Some(offset))
                        })
                        .collect::<Vec<_>>()
                }
            }
            "kitsu-anime-airing" => {
                vec![self.fetch_edge_catalog_items("-startDate", genre, Some("current"), None)]
            }
            _ => return Vec::new(),
        };

        let results = join_all(requests).await;
        let mut supplements = Vec::new();

        for result in results {
            match result {
                Ok(items) if !items.is_empty() => supplements.push(items),
                Ok(_) => {}
                Err(error) => {
                    log_operational_event(
                        OperationalLogLevel::Warn,
                        "kitsu",
                        "fetch_catalog_supplement",
                        "failed",
                        &[
                            field("catalog_id", catalog_id),
                            field("genre", genre.unwrap_or("all")),
                            field("error", error),
                        ],
                    );
                }
            }
        }

        supplements
    }

    pub async fn get_anime_catalog(
        &self,
        catalog_id: &str,
        genre: Option<String>,
        skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
        // Live validation against the public addon shows `skip` values repeat the first page.
        // Treat Kitsu browse as single-page until a working pagination contract is available.
        if skip.filter(|value| *value > 0).is_some() {
            return Ok(Vec::new());
        }

        let supports_genre = matches!(
            catalog_id,
            "kitsu-anime-airing" | "kitsu-anime-popular" | "kitsu-anime-rating"
        );

        // Route unsupported genre requests to a catalog that supports genre filtering.
        let effective_catalog = if genre.is_some() && !supports_genre {
            "kitsu-anime-popular"
        } else {
            catalog_id
        };

        let url = Self::build_catalog_url(effective_catalog, &genre, None);
        let addon_items = self.fetch_items(&url).await?;
        let supplements = self
            .fetch_catalog_supplements(effective_catalog, genre.as_deref())
            .await;

        Ok(Self::merge_items_in_order(
            std::iter::once(addon_items).chain(supplements.into_iter()),
        ))
    }

    pub async fn search_anime(&self, query: &str) -> Result<Vec<MediaItem>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let url = Self::build_search_url(query, None);
        self.fetch_items(&url).await
    }

    fn map_videos_to_episodes(videos: Vec<MetaVideo>) -> Vec<Episode> {
        // Some long-running anime have sparse IMDb mappings on isolated episodes.
        // Build nearest-known IMDb season lookups so outliers don't fall back to
        // season 1 and break grouping.
        let mut prev_known_imdb_season: Vec<Option<u32>> = vec![None; videos.len()];
        let mut next_known_imdb_season: Vec<Option<u32>> = vec![None; videos.len()];

        let mut carry_prev: Option<u32> = None;
        for (idx, video) in videos.iter().enumerate() {
            if let Some(s) = video.imdb_season {
                carry_prev = Some(s);
            }
            prev_known_imdb_season[idx] = carry_prev;
        }

        let mut carry_next: Option<u32> = None;
        for (idx, video) in videos.iter().enumerate().rev() {
            if let Some(s) = video.imdb_season {
                carry_next = Some(s);
            }
            next_known_imdb_season[idx] = carry_next;
        }

        let mut last_thumbnail_by_season: HashMap<u32, String> = HashMap::new();

        videos
            .into_iter()
            .enumerate()
            .map(|(idx, v)| {
                let inferred_imdb_season = v.imdb_season.or_else(|| {
                    match (prev_known_imdb_season[idx], next_known_imdb_season[idx]) {
                        (Some(prev), Some(next)) if prev == next => Some(prev),
                        (Some(prev), _) => Some(prev),
                        (_, Some(next)) => Some(next),
                        _ => None,
                    }
                });

                let display_season = inferred_imdb_season.or(v.season).unwrap_or(1);
                let display_episode = v.imdb_episode.or(v.episode).unwrap_or((idx + 1) as u32);

                // Fallback to Kitsu CDN thumbnail when addon thumbnail is missing.
                let mut thumbnail = v.thumbnail.or_else(|| {
                    let numeric_id = v.id.split(':').next_back().unwrap_or("").trim();
                    if !numeric_id.is_empty() && numeric_id.chars().all(char::is_numeric) {
                        Some(format!(
                            "https://media.kitsu.app/episodes/thumbnails/{}/large.jpg",
                            numeric_id
                        ))
                    } else {
                        None
                    }
                });

                // Normalize low-res Kitsu thumbnails to `large` quality.
                if let Some(t) = thumbnail.as_deref() {
                    if t.contains("/small.jpg") || t.contains("/medium.jpg") {
                        thumbnail = Some(
                            t.replace("/small.jpg", "/large.jpg")
                                .replace("/medium.jpg", "/large.jpg"),
                        );
                    }
                }

                // Rich metadata fallback: reuse the most recent thumbnail in season
                // when Kitsu leaves gaps for late episodes.
                if thumbnail.is_none() {
                    thumbnail = last_thumbnail_by_season.get(&display_season).cloned();
                }
                if let Some(t) = thumbnail.as_ref() {
                    last_thumbnail_by_season.insert(display_season, t.clone());
                }

                Episode {
                    id: v.id,
                    title: v.title,
                    season: display_season,
                    episode: display_episode,
                    released: v.released,
                    release_date: None,
                    overview: v.overview,
                    thumbnail,
                    imdb_id: v.imdb_id,
                    imdb_season: inferred_imdb_season,
                    imdb_episode: v.imdb_episode,
                    stream_lookup_id: None,
                    stream_season: None,
                    stream_episode: None,
                    aniskip_episode: None,
                }
            })
            .collect()
    }

    fn default_episode_page_season(seasons: &[u32], requested_season: Option<u32>) -> Option<u32> {
        requested_season
            .filter(|requested| seasons.contains(requested))
            .or_else(|| {
                seasons
                    .iter()
                    .copied()
                    .find(|season_number| *season_number == 1)
                    .or_else(|| seasons.first().copied())
            })
    }

    fn episode_matches_query(episode: &Episode, normalized_query: &str) -> bool {
        if normalized_query.is_empty() {
            return true;
        }

        episode.episode.to_string().contains(normalized_query)
            || episode
                .title
                .as_deref()
                .is_some_and(|title| title.to_lowercase().contains(normalized_query))
            || episode
                .overview
                .as_deref()
                .is_some_and(|overview| overview.to_lowercase().contains(normalized_query))
    }

    fn build_episode_page(
        episodes_all: Vec<Episode>,
        season: Option<u32>,
        page: u32,
        page_size: u32,
        query: Option<&str>,
    ) -> KitsuEpisodePage {
        let mut seasons = episodes_all
            .iter()
            .map(|ep| ep.season)
            .collect::<HashSet<u32>>()
            .into_iter()
            .collect::<Vec<u32>>();
        seasons.sort_unstable();
        let season_years = build_episode_season_years(&episodes_all).unwrap_or_default();

        let total = episodes_all.len();
        let resolved_season = Self::default_episode_page_season(&seasons, season);
        let mut filtered = if let Some(target_season) = resolved_season {
            episodes_all
                .into_iter()
                .filter(|ep| ep.season == target_season)
                .collect::<Vec<Episode>>()
        } else {
            Vec::new()
        };
        filtered.sort_by_key(|ep| ep.episode);

        let total_in_season = filtered.len();
        let normalized_query = query
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .map(str::to_lowercase);
        if let Some(normalized_query) = normalized_query.as_deref() {
            filtered.retain(|episode| Self::episode_matches_query(episode, normalized_query));
        }

        let filtered_total = filtered.len();
        let safe_page_size = page_size.clamp(1, 200) as usize;
        let start = (page as usize).saturating_mul(safe_page_size);
        let end = (start + safe_page_size).min(filtered_total);
        let episodes = if start < filtered_total {
            filtered[start..end].to_vec()
        } else {
            Vec::new()
        };

        KitsuEpisodePage {
            episodes,
            seasons,
            season_years,
            total,
            total_in_season,
            filtered_total,
            resolved_season,
            page,
            page_size: safe_page_size as u32,
            has_more: end < filtered_total,
        }
    }

    async fn fetch_meta_detail(&self, id: &str) -> Result<MetaDetail, String> {
        let url = format!("{}/meta/anime/{}.json", BASE_URL, id);
        let res = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("API Error: {}", res.status()));
        }
        let text = res.text().await.map_err(|e| e.to_string())?;
        Self::parse_meta_detail_response(&text)
    }

    pub async fn get_episodes_page(
        &self,
        id: &str,
        season: Option<u32>,
        page: u32,
        page_size: u32,
        query: Option<&str>,
    ) -> Result<KitsuEpisodePage, String> {
        let meta = self.fetch_meta_detail(id).await?;
        let episodes_all = Self::map_videos_to_episodes(meta.videos.unwrap_or_default());

        Ok(Self::build_episode_page(
            episodes_all,
            season,
            page,
            page_size,
            query,
        ))
    }

    pub async fn get_details_with_options(
        &self,
        id: &str,
        include_episodes: bool,
    ) -> Result<MediaDetails, String> {
        // Pre-calculate numeric ID for relations to fetch in parallel
        let numeric_id_opt = if let Some(stripped) = id.strip_prefix("kitsu:") {
            Some(stripped.to_string())
        } else if id.chars().all(char::is_numeric) {
            Some(id.to_string())
        } else {
            None
        };

        // Meta Future
        let meta_future = async { self.fetch_meta_detail(id).await };

        // Relations Future
        let relations_future = async {
            if let Some(nid) = &numeric_id_opt {
                supplements::fetch_relations(self, nid).await
            } else {
                None
            }
        };

        // Run in parallel
        let (meta_res, relations_res) = tokio::join!(meta_future, relations_future);

        let m = meta_res?;

        // Use parallel result or fallback
        let relations = if numeric_id_opt.is_some() {
            relations_res
        } else {
            // Fallback: Extract ID from response and fetch
            let fallback_id = m.id.strip_prefix("kitsu:").unwrap_or(&m.id);
            supplements::fetch_relations(self, fallback_id).await
        };

        Ok(MediaDetails {
            id: m.id.clone(),
            imdb_id: m.imdb_id,
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
            rating: m.imdb_rating,
            cast: None,
            genres: m.genres,
            relations,
            trailers: m.trailers.map(|ts| {
                ts.into_iter()
                    .filter(|t| t.type_ == "Trailer")
                    .map(|t| Trailer {
                        id: t.source.clone(),
                        source: "youtube".to_string(),
                        url: format!("https://www.youtube.com/watch?v={}", t.source),
                    })
                    .collect()
            }),
            episodes: if include_episodes {
                m.videos.map(Self::map_videos_to_episodes)
            } else {
                None
            },
            season_years: None,
        })
    }

    pub async fn get_details(&self, id: &str) -> Result<MediaDetails, String> {
        self.get_details_with_options(id, true).await
    }

    pub async fn get_anime_supplemental_metadata(
        &self,
        id: &str,
    ) -> Result<AnimeSupplementalMetadata, String> {
        supplements::get_anime_supplemental_metadata(self, id).await
    }

    async fn fetch_items(&self, url: &str) -> Result<Vec<MediaItem>, String> {
        let items_opt = self.fetch_items_optional(url).await?;
        match items_opt {
            Some(items) => Ok(items),
            None => Err("API Error: 404 Not Found".to_string()),
        }
    }

    fn build_catalog_url(catalog_id: &str, genre: &Option<String>, skip: Option<u32>) -> String {
        // Kitsu expects extras as a single path segment (`genre=...&skip=...`).
        let mut url = format!("{}/catalog/anime/{}", BASE_URL, catalog_id);

        let extra_segment = match (genre.as_deref(), skip) {
            (Some(g), Some(s)) => Some(format!("genre={}&skip={}", encode(g), s)),
            (Some(g), None) => Some(format!("genre={}", encode(g))),
            (None, Some(s)) => Some(format!("skip={}", s)),
            (None, None) => None,
        };

        if let Some(seg) = extra_segment {
            url.push('/');
            url.push_str(&seg);
        }

        url.push_str(".json");
        url
    }

    fn build_search_url(query: &str, skip: Option<u32>) -> String {
        let mut url = format!("{}/catalog/anime/kitsu-anime-list", BASE_URL);

        // Kitsu search expects a single path extras segment and always requires `search=`.
        let extra_segment = match skip {
            Some(s) => format!("search={}&skip={}", encode(query), s),
            None => format!("search={}", encode(query)),
        };

        url.push('/');
        url.push_str(&extra_segment);
        url.push_str(".json");
        url
    }

    fn parse_meta_detail_response(text: &str) -> Result<MetaDetail, String> {
        let body: MetaDetailResponse = serde_json::from_str(text).map_err(|e| {
            log_operational_event(
                OperationalLogLevel::Error,
                "kitsu",
                "parse_detail_response",
                "failed",
                &[
                    field("error", &e),
                    field("snippet", text.chars().take(200).collect::<String>()),
                ],
            );
            format!("Parse Error: {}", e)
        })?;

        body.meta.ok_or_else(|| {
            log_operational_event(
                OperationalLogLevel::Warn,
                "kitsu",
                "parse_detail_response",
                "missing-meta",
                &[field("snippet", text.chars().take(200).collect::<String>())],
            );
            "Metadata not found.".to_string()
        })
    }

    fn parse_catalog_response(text: &str) -> Result<CatalogResponse, String> {
        serde_json::from_str(text).map_err(|e| {
            log_operational_event(
                OperationalLogLevel::Error,
                "kitsu",
                "parse_catalog_response",
                "failed",
                &[field("error", &e)],
            );
            format!("Parse Error: {}", e)
        })
    }

    async fn fetch_items_optional(&self, url: &str) -> Result<Option<Vec<MediaItem>>, String> {
        let res = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if res.status().as_u16() == 404 {
            return Ok(None);
        }

        if !res.status().is_success() {
            return Err(format!("API Error: {}", res.status()));
        }

        let text = res.text().await.map_err(|e| e.to_string())?;
        let catalog = Self::parse_catalog_response(&text)?;

        let items: Vec<MediaItem> = catalog
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
            .collect();

        Ok(Some(items))
    }
}

impl Default for Kitsu {
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
struct MetaDetailResponse {
    #[serde(default)]
    meta: Option<MetaDetail>,
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
}

#[derive(Deserialize, Debug)]
struct MetaDetail {
    id: String,
    #[serde(default)]
    imdb_id: Option<String>,
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
    imdb_rating: Option<String>,
    #[serde(default)]
    genres: Option<Vec<String>>,
    #[serde(default)]
    trailers: Option<Vec<MetaTrailer>>,
    #[serde(default)]
    videos: Option<Vec<MetaVideo>>,
}

#[derive(Deserialize, Debug)]
struct MetaTrailer {
    source: String,
    #[serde(rename = "type")]
    type_: String,
}

#[derive(Deserialize, Debug)]
struct MetaVideo {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    season: Option<u32>,
    #[serde(default)]
    episode: Option<u32>,
    #[serde(default)]
    released: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    thumbnail: Option<String>,
    #[serde(default)]
    imdb_id: Option<String>,
    #[serde(default, alias = "imdbSeason")]
    imdb_season: Option<u32>,
    #[serde(default, alias = "imdbEpisode")]
    imdb_episode: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(id: &str, season: u32, episode: u32, released: Option<&str>) -> Episode {
        Episode {
            id: id.to_string(),
            title: Some(format!("Episode {}", episode)),
            season,
            episode,
            released: released.map(|value| value.to_string()),
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
    fn build_episode_page_defaults_to_season_one_when_unspecified() {
        let page = Kitsu::build_episode_page(
            vec![
                episode("ep-2-1", 2, 1, Some("2025-02-01")),
                episode("ep-1-1", 1, 1, Some("2024-01-01")),
            ],
            None,
            0,
            50,
            None,
        );

        assert_eq!(page.seasons, vec![1, 2]);
        assert_eq!(page.total, 2);
        assert_eq!(page.total_in_season, 1);
        assert_eq!(page.filtered_total, 1);
        assert_eq!(page.resolved_season, Some(1));
        assert_eq!(page.episodes.len(), 1);
        assert_eq!(page.episodes[0].season, 1);
        assert_eq!(page.season_years.get(&1).map(String::as_str), Some("2024"));
    }

    #[test]
    fn build_episode_page_preserves_total_when_filtering_requested_season() {
        let page = Kitsu::build_episode_page(
            vec![
                episode("ep-2-2", 2, 2, Some("2025-03-01")),
                episode("ep-2-1", 2, 1, Some("2025-02-01")),
                episode("ep-3-1", 3, 1, Some("2026-01-01")),
            ],
            Some(2),
            0,
            50,
            None,
        );

        assert_eq!(page.total, 3);
        assert_eq!(page.total_in_season, 2);
        assert_eq!(page.filtered_total, 2);
        assert_eq!(page.resolved_season, Some(2));
        assert_eq!(page.episodes.len(), 2);
        assert_eq!(page.episodes[0].episode, 1);
        assert_eq!(page.episodes[1].episode, 2);
        assert!(!page.has_more);
    }

    #[test]
    fn build_episode_page_falls_back_when_requested_season_is_missing() {
        let page = Kitsu::build_episode_page(
            vec![
                episode("ep-2-1", 2, 1, Some("2025-02-01")),
                episode("ep-1-1", 1, 1, Some("2024-01-01")),
            ],
            Some(9),
            0,
            50,
            None,
        );

        assert_eq!(page.resolved_season, Some(1));
        assert_eq!(page.total_in_season, 1);
        assert_eq!(page.episodes[0].season, 1);
    }

    #[test]
    fn build_episode_page_filters_by_query_before_pagination() {
        let mut first = episode("ep-1-1", 1, 1, Some("2024-01-01"));
        first.title = Some("Pilot".to_string());
        let mut second = episode("ep-1-2", 1, 2, Some("2024-01-08"));
        second.overview = Some("The hero meets a dragon".to_string());

        let page = Kitsu::build_episode_page(
            vec![first, second],
            Some(1),
            0,
            4,
            Some("dragon"),
        );

        assert_eq!(page.total_in_season, 2);
        assert_eq!(page.filtered_total, 1);
        assert_eq!(page.episodes.len(), 1);
        assert_eq!(page.episodes[0].episode, 2);
        assert!(!page.has_more);
    }

    #[test]
    fn parse_meta_detail_response_returns_not_found_for_empty_object() {
        let err = Kitsu::parse_meta_detail_response("{}").expect_err("missing meta should fail");
        assert_eq!(err, "Metadata not found.");
    }

    #[test]
    fn parse_catalog_response_treats_empty_object_as_empty_catalog() {
        let catalog = Kitsu::parse_catalog_response("{}").expect("empty catalog response");
        assert!(catalog.metas.is_empty());
    }
}
