use super::{
    AnimeCharacterProfile, AnimeProductionCompanyProfile, AnimeStaffProfile,
    AnimeStreamingPlatformProfile, AnimeSupplementalMetadata, Episode, MediaDetails, MediaItem,
    Trailer, build_provider_http_client,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use urlencoding::encode;

const BASE_URL: &str = "https://anime-kitsu.strem.fun";
const CATALOG_PAGE_SIZE: usize = 20;
const SEARCH_PAGE_LIMIT: usize = 5;
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

    fn extract_release_year(value: &str) -> Option<u32> {
        let trimmed = value.trim();
        if trimmed.len() < 4 {
            return None;
        }

        let year_text = trimmed.get(0..4)?;
        let year = year_text.parse::<u32>().ok()?;
        if (1900..=2100).contains(&year) {
            Some(year)
        } else {
            None
        }
    }

    pub fn new() -> Self {
        Self {
            client: build_provider_http_client(None),
        }
    }

    pub async fn get_anime_catalog(
        &self,
        catalog_id: &str,
        genre: Option<String>,
        skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
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

        let effective_supports_skip = matches!(
            effective_catalog,
            "kitsu-anime-airing"
                | "kitsu-anime-popular"
                | "kitsu-anime-rating"
                | "kitsu-anime-list"
        );

        if !effective_supports_skip {
            let url = Self::build_catalog_url(effective_catalog, &genre, None);
            #[cfg(debug_assertions)]
            eprintln!("Fetching Kitsu Catalog (single): {}", url);
            return self.fetch_items(&url).await;
        }

        // Bounded pagination keeps browse latency predictable.
        let mut all_items: Vec<MediaItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        let (start_skip, max_pages) = match skip {
            Some(s) => (s as usize, 3),
            None => (0, 5),
        };

        for page in 0..max_pages {
            let page_skip = start_skip + page * CATALOG_PAGE_SIZE;
            let skip_opt = if page_skip == 0 {
                None
            } else {
                Some(page_skip as u32)
            };
            let url = Self::build_catalog_url(effective_catalog, &genre, skip_opt);

            #[cfg(debug_assertions)]
            eprintln!("Fetching Kitsu Catalog: {}", url);

            let page_items_opt = self.fetch_items_optional(&url).await?;
            let Some(page_items) = page_items_opt else {
                break;
            };

            if page_items.is_empty() {
                break;
            }

            let mut added_this_page = 0usize;
            for item in page_items {
                if seen.insert(item.id.clone()) {
                    all_items.push(item);
                    added_this_page += 1;
                }
            }

            if added_this_page < CATALOG_PAGE_SIZE {
                break;
            }
        }

        Ok(all_items)
    }

    pub async fn search_anime(&self, query: &str) -> Result<Vec<MediaItem>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let mut all_items: Vec<MediaItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        let max_pages: usize = SEARCH_PAGE_LIMIT; // up to ~100 search results

        for page in 0..max_pages {
            let skip = page * CATALOG_PAGE_SIZE;
            let skip_opt = if skip == 0 { None } else { Some(skip as u32) };
            let url = Self::build_search_url(query, skip_opt);

            #[cfg(debug_assertions)]
            eprintln!("Searching Kitsu: {}", url);

            let page_items_opt = self.fetch_items_optional(&url).await?;
            let Some(page_items) = page_items_opt else {
                // If skip isn't supported here, fall back to single page.
                if page == 0 {
                    let single_url = Self::build_search_url(query, None);
                    return self.fetch_items(&single_url).await;
                }
                break;
            };

            if page_items.is_empty() {
                break;
            }

            let mut added_this_page = 0usize;
            for item in page_items {
                if seen.insert(item.id.clone()) {
                    all_items.push(item);
                    added_this_page += 1;
                }
            }

            if added_this_page < CATALOG_PAGE_SIZE {
                break;
            }
        }

        Ok(all_items)
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
                    overview: v.overview,
                    thumbnail,
                    imdb_id: v.imdb_id,
                    imdb_season: inferred_imdb_season,
                    imdb_episode: v.imdb_episode,
                }
            })
            .collect()
    }

    fn default_episode_page_season(seasons: &[u32], requested_season: Option<u32>) -> Option<u32> {
        requested_season.or_else(|| {
            seasons
                .iter()
                .copied()
                .find(|season_number| *season_number == 1)
                .or_else(|| seasons.first().copied())
        })
    }

    fn build_episode_page(
        episodes_all: Vec<Episode>,
        season: Option<u32>,
        page: u32,
        page_size: u32,
    ) -> KitsuEpisodePage {
        let mut seasons = episodes_all
            .iter()
            .map(|ep| ep.season)
            .collect::<HashSet<u32>>()
            .into_iter()
            .collect::<Vec<u32>>();
        seasons.sort_unstable();

        let mut years_by_season: HashMap<u32, Vec<u32>> = HashMap::new();
        for ep in &episodes_all {
            let Some(released) = ep.released.as_deref() else {
                continue;
            };
            let Some(year) = Self::extract_release_year(released) else {
                continue;
            };
            years_by_season.entry(ep.season).or_default().push(year);
        }

        let mut season_years: HashMap<u32, String> = HashMap::new();
        for (season_num, years) in years_by_season {
            if years.is_empty() {
                continue;
            }

            let mut sorted_years = years;
            sorted_years.sort_unstable();
            sorted_years.dedup();

            let label = match (sorted_years.first(), sorted_years.last()) {
                (Some(first), Some(last)) if first != last => format!("{}-{}", first, last),
                (Some(single), _) => single.to_string(),
                _ => continue,
            };

            season_years.insert(season_num, label);
        }

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
        let safe_page_size = page_size.clamp(1, 200) as usize;
        let start = (page as usize).saturating_mul(safe_page_size);
        let end = (start + safe_page_size).min(total_in_season);
        let episodes = if start < total_in_season {
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
            page,
            page_size: safe_page_size as u32,
            has_more: end < total_in_season,
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
    ) -> Result<KitsuEpisodePage, String> {
        let meta = self.fetch_meta_detail(id).await?;
        let episodes_all = Self::map_videos_to_episodes(meta.videos.unwrap_or_default());

        Ok(Self::build_episode_page(
            episodes_all,
            season,
            page,
            page_size,
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
                self.fetch_relations(nid).await
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
            self.fetch_relations(fallback_id).await
        };

        Ok(MediaDetails {
            id: m.id.clone(),
            imdb_id: m.imdb_id,
            title: m.name,
            poster: m.poster,
            backdrop: m.background,
            logo: m.logo,
            year: m.year,
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
        })
    }

    pub async fn get_details(&self, id: &str) -> Result<MediaDetails, String> {
        self.get_details_with_options(id, true).await
    }

    pub async fn get_anime_supplemental_metadata(
        &self,
        id: &str,
    ) -> Result<AnimeSupplementalMetadata, String> {
        let numeric_id = id.strip_prefix("kitsu:").unwrap_or(id).trim();
        if numeric_id.is_empty() {
            return Err("Anime ID is required for Kitsu metadata.".to_string());
        }

        let (characters_result, staff_result, productions_result, platforms_result) = tokio::join!(
            self.fetch_anime_characters(numeric_id),
            self.fetch_anime_staff(numeric_id),
            self.fetch_anime_productions(numeric_id),
            self.fetch_anime_streaming_platforms(numeric_id),
        );

        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        let characters = match characters_result {
            Ok(characters) => characters,
            Err(error) => {
                errors.push(error);
                warnings.push(Self::supplemental_warning("Character"));
                Vec::new()
            }
        };
        let staff = match staff_result {
            Ok(staff) => staff,
            Err(error) => {
                errors.push(error);
                warnings.push(Self::supplemental_warning("Staff"));
                Vec::new()
            }
        };
        let productions = match productions_result {
            Ok(productions) => productions,
            Err(error) => {
                errors.push(error);
                warnings.push(Self::supplemental_warning("Studio and producer"));
                Vec::new()
            }
        };
        let platforms = match platforms_result {
            Ok(platforms) => platforms,
            Err(error) => {
                errors.push(error);
                warnings.push(Self::supplemental_warning("Streaming platform"));
                Vec::new()
            }
        };

        if characters.is_empty()
            && staff.is_empty()
            && productions.is_empty()
            && platforms.is_empty()
        {
            if let Some(error) = errors.into_iter().next() {
                return Err(error);
            }
        }

        Ok(AnimeSupplementalMetadata {
            characters,
            staff,
            productions,
            platforms,
            warnings,
        })
    }

    async fn fetch_anime_characters(
        &self,
        kitsu_id: &str,
    ) -> Result<Vec<AnimeCharacterProfile>, String> {
        let url = format!(
            "https://kitsu.io/api/edge/anime/{}/characters?page[limit]={}&include=character",
            kitsu_id, ANIME_CHARACTER_LIMIT
        );
        let body = self.fetch_edge_value(&url).await?;
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let included = body
            .get("included")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let included_characters = included
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("characters"))
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?.to_string();
                Some((id, entry))
            })
            .collect::<HashMap<_, _>>();

        let mut characters = Vec::new();
        let mut seen_character_ids = HashSet::new();

        for relationship in data {
            let Some(character_id) = relationship
                .pointer("/relationships/character/data/id")
                .and_then(Value::as_str)
            else {
                continue;
            };

            if !seen_character_ids.insert(character_id.to_string()) {
                continue;
            }

            let Some(character) = included_characters.get(character_id) else {
                continue;
            };

            let Some(name) = Self::extract_value_string(character, "/attributes/canonicalName")
                .or_else(|| Self::extract_value_string(character, "/attributes/name"))
            else {
                continue;
            };

            characters.push(AnimeCharacterProfile {
                name,
                role: Self::extract_value_string(&relationship, "/attributes/role")
                    .map(|role| Self::title_case_label(&role)),
                image: Self::extract_image_url(character, "image"),
                description: Self::extract_value_string(character, "/attributes/description"),
            });
        }

        characters.sort_by(|left, right| {
            Self::character_role_priority(right.role.as_deref())
                .cmp(&Self::character_role_priority(left.role.as_deref()))
                .then_with(|| left.name.cmp(&right.name))
        });
        characters.truncate(ANIME_CHARACTER_LIMIT);

        Ok(characters)
    }

    async fn fetch_anime_staff(&self, kitsu_id: &str) -> Result<Vec<AnimeStaffProfile>, String> {
        let url = format!(
            "https://kitsu.io/api/edge/anime/{}/anime-staff?page[limit]={}&include=person",
            kitsu_id, ANIME_STAFF_LIMIT
        );
        let body = self.fetch_edge_value(&url).await?;
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let included = body
            .get("included")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let included_people = included
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("people"))
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?.to_string();
                Some((id, entry))
            })
            .collect::<HashMap<_, _>>();

        let mut merged_staff: HashMap<String, AnimeStaffProfile> = HashMap::new();

        for relationship in data {
            let Some(person_id) = relationship
                .pointer("/relationships/person/data/id")
                .and_then(Value::as_str)
            else {
                continue;
            };

            let Some(person) = included_people.get(person_id) else {
                continue;
            };

            let Some(name) = Self::extract_value_string(person, "/attributes/name") else {
                continue;
            };

            let staff_entry = merged_staff
                .entry(person_id.to_string())
                .or_insert_with(|| AnimeStaffProfile {
                    name,
                    roles: Vec::new(),
                    image: Self::extract_image_url(person, "image"),
                    description: Self::extract_value_string(person, "/attributes/description"),
                });

            if let Some(raw_role) = Self::extract_value_string(&relationship, "/attributes/role") {
                for role in raw_role
                    .split(',')
                    .filter_map(Self::normalize_text)
                    .map(|role| Self::title_case_label(&role))
                {
                    if !staff_entry.roles.iter().any(|existing| existing == &role) {
                        staff_entry.roles.push(role);
                    }
                }
            }
        }

        let mut staff = merged_staff.into_values().collect::<Vec<_>>();
        for entry in &mut staff {
            entry.roles.sort_by(|left, right| {
                Self::staff_role_priority(right)
                    .cmp(&Self::staff_role_priority(left))
                    .then_with(|| left.cmp(right))
            });
        }

        staff.sort_by(|left, right| {
            let left_priority = left
                .roles
                .iter()
                .map(|role| Self::staff_role_priority(role))
                .max()
                .unwrap_or(0);
            let right_priority = right
                .roles
                .iter()
                .map(|role| Self::staff_role_priority(role))
                .max()
                .unwrap_or(0);

            right_priority
                .cmp(&left_priority)
                .then_with(|| left.name.cmp(&right.name))
        });
        staff.truncate(ANIME_STAFF_LIMIT);

        Ok(staff)
    }

    async fn fetch_anime_productions(
        &self,
        kitsu_id: &str,
    ) -> Result<Vec<AnimeProductionCompanyProfile>, String> {
        let url = format!(
            "https://kitsu.io/api/edge/anime/{}/productions?page[limit]={}&include=producer",
            kitsu_id, ANIME_PRODUCTION_LIMIT
        );
        let body = self.fetch_edge_value(&url).await?;
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let included = body
            .get("included")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let included_producers = included
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("producers"))
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?.to_string();
                Some((id, entry))
            })
            .collect::<HashMap<_, _>>();

        let mut merged_productions: HashMap<String, AnimeProductionCompanyProfile> = HashMap::new();

        for relationship in data {
            let Some(producer_id) = relationship
                .pointer("/relationships/producer/data/id")
                .and_then(Value::as_str)
            else {
                continue;
            };

            let Some(producer) = included_producers.get(producer_id) else {
                continue;
            };

            let Some(name) = Self::extract_value_string(producer, "/attributes/name") else {
                continue;
            };

            let production_entry = merged_productions
                .entry(producer_id.to_string())
                .or_insert_with(|| AnimeProductionCompanyProfile {
                    name,
                    roles: Vec::new(),
                    logo: Self::extract_image_url(producer, "logo")
                        .or_else(|| Self::extract_image_url(producer, "image")),
                    description: Self::extract_value_string(producer, "/attributes/description"),
                });

            if let Some(raw_role) = Self::extract_value_string(&relationship, "/attributes/role")
                .or_else(|| Self::extract_value_string(&relationship, "/attributes/producerType"))
            {
                for role in raw_role
                    .split(',')
                    .filter_map(Self::normalize_text)
                    .map(|role| Self::title_case_label(&role))
                {
                    if !production_entry
                        .roles
                        .iter()
                        .any(|existing| existing == &role)
                    {
                        production_entry.roles.push(role);
                    }
                }
            }
        }

        let mut productions = merged_productions.into_values().collect::<Vec<_>>();
        for entry in &mut productions {
            entry.roles.sort_by(|left, right| {
                Self::production_role_priority(right)
                    .cmp(&Self::production_role_priority(left))
                    .then_with(|| left.cmp(right))
            });
        }

        productions.sort_by(|left, right| {
            let left_priority = left
                .roles
                .iter()
                .map(|role| Self::production_role_priority(role))
                .max()
                .unwrap_or(0);
            let right_priority = right
                .roles
                .iter()
                .map(|role| Self::production_role_priority(role))
                .max()
                .unwrap_or(0);

            right_priority
                .cmp(&left_priority)
                .then_with(|| left.name.cmp(&right.name))
        });
        productions.truncate(ANIME_PRODUCTION_LIMIT);

        Ok(productions)
    }

    async fn fetch_anime_streaming_platforms(
        &self,
        kitsu_id: &str,
    ) -> Result<Vec<AnimeStreamingPlatformProfile>, String> {
        let url = format!(
            "https://kitsu.io/api/edge/anime/{}/streaming-links?page[limit]=20&include=streamer",
            kitsu_id
        );
        let body = self.fetch_edge_value(&url).await?;
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let included = body
            .get("included")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let included_streamers = included
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("streamers"))
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?.to_string();
                Some((id, entry))
            })
            .collect::<HashMap<_, _>>();

        let mut merged_platforms: HashMap<String, AnimeStreamingPlatformProfile> = HashMap::new();
        let mut platform_link_counts: HashMap<String, usize> = HashMap::new();

        for streaming_link in data {
            let Some(streamer_id) = streaming_link
                .pointer("/relationships/streamer/data/id")
                .and_then(Value::as_str)
            else {
                continue;
            };

            let Some(streamer) = included_streamers.get(streamer_id) else {
                continue;
            };

            let Some(name) = Self::extract_value_string(streamer, "/attributes/siteName") else {
                continue;
            };

            let Some(link_url) = Self::extract_value_string(&streaming_link, "/attributes/url")
            else {
                continue;
            };

            if reqwest::Url::parse(&link_url).is_err() {
                continue;
            }

            let key = streamer_id.to_string();
            let entry = merged_platforms.entry(key.clone()).or_insert_with(|| {
                AnimeStreamingPlatformProfile {
                    name,
                    url: link_url.clone(),
                    logo: Self::extract_value_string(streamer, "/attributes/logo"),
                    sub_languages: Vec::new(),
                    dub_languages: Vec::new(),
                }
            });

            if entry.logo.is_none() {
                entry.logo = Self::extract_value_string(streamer, "/attributes/logo");
            }
            if Self::should_replace_platform_url(&entry.url, &link_url) {
                entry.url = link_url.clone();
            }

            for language in Self::extract_language_labels(&streaming_link, "/attributes/subs") {
                if !entry
                    .sub_languages
                    .iter()
                    .any(|existing| existing == &language)
                {
                    entry.sub_languages.push(language);
                }
            }
            for language in Self::extract_language_labels(&streaming_link, "/attributes/dubs") {
                if !entry
                    .dub_languages
                    .iter()
                    .any(|existing| existing == &language)
                {
                    entry.dub_languages.push(language);
                }
            }

            *platform_link_counts.entry(key).or_insert(0) += 1;
        }

        let mut platforms = merged_platforms
            .into_iter()
            .map(|(key, mut platform)| {
                platform.sub_languages.sort();
                platform.dub_languages.sort();
                let link_count = platform_link_counts.get(&key).copied().unwrap_or(0);
                (link_count, platform)
            })
            .collect::<Vec<_>>();

        platforms.sort_by(|(left_count, left), (right_count, right)| {
            right_count
                .cmp(left_count)
                .then_with(|| {
                    let right_signal = right.sub_languages.len() + right.dub_languages.len();
                    let left_signal = left.sub_languages.len() + left.dub_languages.len();
                    right_signal.cmp(&left_signal)
                })
                .then_with(|| left.name.cmp(&right.name))
        });
        platforms.truncate(ANIME_STREAMING_PLATFORM_LIMIT);

        Ok(platforms
            .into_iter()
            .map(|(_, platform)| platform)
            .collect())
    }

    async fn fetch_relations(&self, kitsu_id: &str) -> Option<Vec<MediaItem>> {
        let url = format!(
            "https://kitsu.io/api/edge/anime/{}/media-relationships?include=destination&page[limit]={}",
            kitsu_id, RELATION_LIMIT
        );

        let body = self.fetch_edge_value(&url).await.ok()?;

        let relation_roles = body
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let destination_id = entry
                    .pointer("/relationships/destination/data/id")
                    .and_then(Value::as_str)?;
                let role = Self::extract_value_string(entry, "/attributes/role")?;
                Some((destination_id.to_string(), role))
            })
            .collect::<HashMap<_, _>>();

        let included = body.get("included")?.as_array()?;

        let relations: Vec<MediaItem> = included
            .iter()
            .filter_map(|item| {
                let attrs = item.get("attributes")?;
                let id = item.get("id")?.as_str()?;
                let type_ = item.get("type")?.as_str()?;

                // We only want anime relations for now
                if type_ != "anime" {
                    return None;
                }

                let title = attrs
                    .get("canonicalTitle")
                    .and_then(|s| s.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let poster = attrs
                    .get("posterImage")
                    .and_then(|i| i.get("original").or(i.get("large")))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());

                let backdrop = attrs
                    .get("coverImage")
                    .and_then(|i| i.get("original").or(i.get("large")))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());

                let description = attrs
                    .get("synopsis")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                let year = attrs
                    .get("startDate")
                    .and_then(|s| s.as_str())
                    .and_then(|s| {
                        let y = s.split('-').next().unwrap_or("");
                        if y.is_empty() {
                            None
                        } else {
                            Some(y.to_string())
                        }
                    });

                Some(MediaItem {
                    id: format!("kitsu:{}", id),
                    title,
                    poster,
                    backdrop,
                    logo: None,
                    description,
                    year,
                    type_: "series".to_string(),
                    relation_role: relation_roles.get(id).cloned(),
                })
            })
            // Rust-side safety cap — page[limit] in the URL should already
            // enforce this, but guard against API responses that ignore the hint.
            .take(RELATION_LIMIT)
            .collect();

        if relations.is_empty() {
            None
        } else {
            Some(relations)
        }
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
            #[cfg(debug_assertions)]
            {
                eprintln!("Failed to parse kitsu detail response: {}", e);
                eprintln!("Snippet: {}", &text.chars().take(200).collect::<String>());
            }
            format!("Parse Error: {}", e)
        })?;

        body.meta.ok_or_else(|| {
            #[cfg(debug_assertions)]
            eprintln!(
                "Kitsu detail response missing meta field. Snippet: {}",
                &text.chars().take(200).collect::<String>()
            );
            "Metadata not found.".to_string()
        })
    }

    fn parse_catalog_response(text: &str) -> Result<CatalogResponse, String> {
        serde_json::from_str(text).map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("Failed to parse kitsu response: {}", e);
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
                year: m.year,
                type_: m.type_,
                relation_role: None,
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
            overview: None,
            thumbnail: None,
            imdb_id: None,
            imdb_season: None,
            imdb_episode: None,
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
        );

        assert_eq!(page.seasons, vec![1, 2]);
        assert_eq!(page.total, 2);
        assert_eq!(page.total_in_season, 1);
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
        );

        assert_eq!(page.total, 3);
        assert_eq!(page.total_in_season, 2);
        assert_eq!(page.episodes.len(), 2);
        assert_eq!(page.episodes[0].episode, 1);
        assert_eq!(page.episodes[1].episode, 2);
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
