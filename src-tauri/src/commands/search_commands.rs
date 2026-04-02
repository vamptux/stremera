use super::{
    media_normalization::normalize_media_items, normalize_cinemeta_catalog, normalize_non_empty,
    normalize_query,
};
use crate::providers::{
    cinemeta::Cinemeta, extract_primary_year, kitsu::Kitsu, netflix::Netflix, MediaItem,
};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::{command, State};

const SEARCH_YEAR_MIN: u32 = 1889;
const SEARCH_YEAR_MAX: u32 = 2100;
const MAX_SEARCH_RESULT_LIMIT: usize = 200;
const MAX_GENRE_FILTERS: usize = 6;
const DEFAULT_BROWSE_PAGE_LIMIT: usize = 100;
const ADDON_PAGE_SIZE: usize = 100;
const MAX_SORTED_BROWSE_SCAN_ITEMS: u32 = 2_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogPage {
    pub items: Vec<MediaItem>,
    pub next_skip: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchProvider {
    Cinemeta,
    Netflix,
    Hbo,
    Disney,
    Prime,
    Apple,
    Kitsu,
}

impl SearchProvider {
    fn resolve(requested: Option<&str>, media_type: Option<SearchMediaType>) -> Self {
        if media_type == Some(SearchMediaType::Anime) {
            return Self::Kitsu;
        }

        match requested
            .unwrap_or("cinemeta")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "netflix" => Self::Netflix,
            "hbo" => Self::Hbo,
            "disney" => Self::Disney,
            "prime" => Self::Prime,
            "apple" => Self::Apple,
            _ => Self::Cinemeta,
        }
    }

    fn supports_genres(self) -> bool {
        matches!(self, Self::Cinemeta | Self::Kitsu)
    }

    fn addon_catalog_id(self) -> Option<&'static str> {
        match self {
            Self::Netflix => Some("nfx"),
            Self::Hbo => Some("hbm"),
            Self::Disney => Some("dnp"),
            Self::Prime => Some("amp"),
            Self::Apple => Some("atp"),
            Self::Cinemeta | Self::Kitsu => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchMediaType {
    Movie,
    Series,
    Anime,
}

impl SearchMediaType {
    fn parse(value: Option<&str>) -> Option<Self> {
        match value?.trim().to_ascii_lowercase().as_str() {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            "anime" => Some(Self::Anime),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Anime => "anime",
        }
    }

    fn cinemeta_type(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series | Self::Anime => "series",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchFeed {
    Popular,
    Featured,
    Trending,
    Airing,
    Rating,
}

impl SearchFeed {
    fn resolve(media_type: SearchMediaType, requested: Option<&str>) -> Self {
        let normalized = requested
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();

        match media_type {
            SearchMediaType::Anime => match normalized.as_str() {
                "popular" => Self::Popular,
                "airing" => Self::Airing,
                "rating" => Self::Rating,
                _ => Self::Trending,
            },
            SearchMediaType::Movie | SearchMediaType::Series => match normalized.as_str() {
                "featured" => Self::Featured,
                _ => Self::Popular,
            },
        }
    }

    fn cinemeta_catalog(self) -> &'static str {
        match self {
            Self::Featured => "imdbRating",
            Self::Popular | Self::Trending | Self::Airing | Self::Rating => "top",
        }
    }

    fn kitsu_catalog(self) -> &'static str {
        match self {
            Self::Trending => "kitsu-anime-trending",
            Self::Popular => "kitsu-anime-popular",
            Self::Airing => "kitsu-anime-airing",
            Self::Rating => "kitsu-anime-rating",
            Self::Featured => "kitsu-anime-trending",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchSort {
    Default,
    TitleAsc,
    TitleDesc,
    YearDesc,
    YearAsc,
}

impl SearchSort {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("title-asc") => Self::TitleAsc,
            Some("title-desc") => Self::TitleDesc,
            Some("year-desc") => Self::YearDesc,
            Some("year-asc") => Self::YearAsc,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SearchYearRange {
    year_from: Option<u32>,
    year_to: Option<u32>,
}

impl SearchYearRange {
    fn resolve(year_from: Option<u32>, year_to: Option<u32>) -> Self {
        let normalized_from =
            year_from.filter(|value| (SEARCH_YEAR_MIN..=SEARCH_YEAR_MAX).contains(value));
        let normalized_to =
            year_to.filter(|value| (SEARCH_YEAR_MIN..=SEARCH_YEAR_MAX).contains(value));

        match (normalized_from, normalized_to) {
            (Some(from), Some(to)) if from > to => Self {
                year_from: Some(to),
                year_to: Some(from),
            },
            _ => Self {
                year_from: normalized_from,
                year_to: normalized_to,
            },
        }
    }

    fn is_active(self) -> bool {
        self.year_from.is_some() || self.year_to.is_some()
    }

    fn contains(self, year: u32) -> bool {
        if let Some(year_from) = self.year_from {
            if year < year_from {
                return false;
            }
        }

        if let Some(year_to) = self.year_to {
            if year > year_to {
                return false;
            }
        }

        true
    }
}

#[derive(Debug)]
struct SearchCatalogCriteria {
    query: Option<String>,
    media_type: Option<SearchMediaType>,
    provider: SearchProvider,
    feed: Option<SearchFeed>,
    genres: Vec<String>,
    year_range: SearchYearRange,
    sort: SearchSort,
    skip: u32,
    page_limit: usize,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogRequest {
    query: Option<String>,
    media_type: Option<String>,
    provider: Option<String>,
    feed: Option<String>,
    genres: Option<Vec<String>>,
    year_from: Option<u32>,
    year_to: Option<u32>,
    sort: Option<String>,
    skip: Option<u32>,
    limit: Option<usize>,
}

#[derive(Debug)]
struct RankedSearchItem {
    item: MediaItem,
    score: i32,
    year: u32,
    original_index: usize,
}

fn normalize_genres(genres: Option<Vec<String>>, provider: SearchProvider) -> Vec<String> {
    if !provider.supports_genres() {
        return Vec::new();
    }

    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for genre in genres.unwrap_or_default() {
        if normalized.len() >= MAX_GENRE_FILTERS {
            break;
        }

        let Some(genre) = normalize_non_empty(&genre) else {
            continue;
        };

        if seen.insert(genre.to_ascii_lowercase()) {
            normalized.push(genre);
        }
    }

    normalized
}

fn normalize_limit(limit: Option<usize>) -> Option<usize> {
    limit
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_SEARCH_RESULT_LIMIT))
}

fn build_search_criteria(request: SearchCatalogRequest) -> Result<SearchCatalogCriteria, String> {
    let normalized_query = request.query.as_deref().and_then(normalize_query);
    let parsed_media_type = SearchMediaType::parse(request.media_type.as_deref());
    let provider = SearchProvider::resolve(request.provider.as_deref(), parsed_media_type);
    let has_query = normalized_query.is_some();
    let normalized_limit = normalize_limit(request.limit);

    if normalized_query.is_none() && parsed_media_type.is_none() {
        return Err("Media type is required to browse the search catalog.".to_string());
    }

    Ok(SearchCatalogCriteria {
        query: normalized_query,
        media_type: parsed_media_type,
        provider,
        feed: parsed_media_type
            .map(|media_type| SearchFeed::resolve(media_type, request.feed.as_deref())),
        genres: if has_query {
            Vec::new()
        } else {
            normalize_genres(request.genres, provider)
        },
        year_range: SearchYearRange::resolve(request.year_from, request.year_to),
        sort: SearchSort::parse(request.sort.as_deref()),
        skip: request.skip.unwrap_or(0),
        page_limit: normalized_limit.unwrap_or(DEFAULT_BROWSE_PAGE_LIMIT),
        limit: normalized_limit,
    })
}

fn filter_items_by_year(items: Vec<MediaItem>, year_range: SearchYearRange) -> Vec<MediaItem> {
    if !year_range.is_active() {
        return items;
    }

    items
        .into_iter()
        .filter(|item| {
            let Some(year) = extract_primary_year(item.year.as_deref()) else {
                return true;
            };

            year_range.contains(year)
        })
        .collect()
}

fn normalize_search_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn score_search_item(query: &str, item: &MediaItem) -> i32 {
    let normalized_title = normalize_search_text(&item.title);
    if normalized_title.is_empty() {
        return 0;
    }

    if normalized_title == query {
        return 1200;
    }

    let mut score = 0;

    if normalized_title.starts_with(query) {
        score += 900;
    } else if normalized_title.contains(query) {
        score += 400;
    }

    let query_tokens = query.split_whitespace().collect::<Vec<_>>();
    let title_tokens = normalized_title.split_whitespace().collect::<Vec<_>>();
    let mut matched_tokens = 0i32;
    let mut prefix_token_matches = 0i32;

    for token in query_tokens {
        if title_tokens
            .iter()
            .any(|segment| segment == &token || segment.starts_with(token))
        {
            matched_tokens += 1;
            prefix_token_matches += 1;
        } else if normalized_title.contains(token) {
            matched_tokens += 1;
        }
    }

    if matched_tokens > 0 {
        score += matched_tokens * 70;
    }
    if prefix_token_matches > 0 {
        score += prefix_token_matches * 40;
    }

    if !query.is_empty() && normalized_title.contains(&format!(" {}", query)) {
        score += 120;
    }

    score - normalized_title.len() as i32
}

fn rank_search_results(query: &str, items: Vec<MediaItem>, limit: Option<usize>) -> Vec<MediaItem> {
    let normalized_query = normalize_search_text(query);
    let mut ranked = items
        .into_iter()
        .enumerate()
        .map(|(original_index, item)| RankedSearchItem {
            year: extract_primary_year(item.year.as_deref()).unwrap_or(0),
            score: score_search_item(&normalized_query, &item),
            item,
            original_index,
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.year.cmp(&left.year))
            .then_with(|| left.original_index.cmp(&right.original_index))
    });

    if let Some(limit) = limit {
        ranked.truncate(limit);
    }

    ranked.into_iter().map(|entry| entry.item).collect()
}

fn sort_catalog_items(mut items: Vec<MediaItem>, sort: SearchSort) -> Vec<MediaItem> {
    match sort {
        SearchSort::Default => items,
        SearchSort::TitleAsc => {
            items.sort_by(|left, right| {
                left.title
                    .cmp(&right.title)
                    .then_with(|| left.id.cmp(&right.id))
            });
            items
        }
        SearchSort::TitleDesc => {
            items.sort_by(|left, right| {
                right
                    .title
                    .cmp(&left.title)
                    .then_with(|| left.id.cmp(&right.id))
            });
            items
        }
        SearchSort::YearDesc => {
            items.sort_by(|left, right| {
                extract_primary_year(right.year.as_deref())
                    .unwrap_or(0)
                    .cmp(&extract_primary_year(left.year.as_deref()).unwrap_or(0))
                    .then_with(|| left.title.cmp(&right.title))
                    .then_with(|| left.id.cmp(&right.id))
            });
            items
        }
        SearchSort::YearAsc => {
            items.sort_by(|left, right| {
                extract_primary_year(left.year.as_deref())
                    .unwrap_or(0)
                    .cmp(&extract_primary_year(right.year.as_deref()).unwrap_or(0))
                    .then_with(|| left.title.cmp(&right.title))
                    .then_with(|| left.id.cmp(&right.id))
            });
            items
        }
    }
}

fn merge_item_batches(
    results: Vec<Result<Vec<MediaItem>, String>>,
) -> Result<Vec<MediaItem>, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut had_success = false;
    let mut last_error: Option<String> = None;

    for result in results {
        match result {
            Ok(batch) => {
                had_success = true;
                for item in batch {
                    if seen_ids.insert(item.id.clone()) {
                        items.push(item);
                    }
                }
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    if !had_success {
        return Err(last_error.unwrap_or_else(|| "Failed to load search catalog.".to_string()));
    }

    Ok(items)
}

fn slice_catalog_page(items: Vec<MediaItem>, skip: u32, page_limit: usize) -> SearchCatalogPage {
    let offset = skip as usize;
    if offset >= items.len() {
        return SearchCatalogPage {
            items: Vec::new(),
            next_skip: None,
        };
    }

    let end = (offset + page_limit).min(items.len());
    SearchCatalogPage {
        items: normalize_media_items(items[offset..end].to_vec()),
        next_skip: (end < items.len()).then_some(end as u32),
    }
}

async fn fetch_query_results(
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    query: &str,
    media_type: Option<SearchMediaType>,
) -> Result<Vec<MediaItem>, String> {
    match media_type {
        Some(SearchMediaType::Anime) => kitsu_provider.search_anime(query).await,
        Some(SearchMediaType::Movie) => {
            cinemeta_provider
                .search_with_media_type(query, Some(SearchMediaType::Movie.as_str()))
                .await
        }
        Some(SearchMediaType::Series) => {
            cinemeta_provider
                .search_with_media_type(query, Some(SearchMediaType::Series.as_str()))
                .await
        }
        None => cinemeta_provider.search_with_media_type(query, None).await,
    }
}

async fn fetch_cinemeta_browse_items(
    provider: &Cinemeta,
    media_type: SearchMediaType,
    feed: SearchFeed,
    genres: &[String],
) -> Result<Vec<MediaItem>, String> {
    let catalog_id = normalize_cinemeta_catalog(feed.cinemeta_catalog())
        .ok_or_else(|| "Invalid Cinemeta catalog.".to_string())?;
    let media_type = media_type.cinemeta_type();

    if genres.len() > 1 {
        let mut futures = Vec::with_capacity(genres.len());

        for genre in genres {
            futures.push(provider.get_discover_catalog(
                media_type,
                &catalog_id,
                Some(genre.clone()),
            ));
        }

        merge_item_batches(join_all(futures).await)
    } else {
        provider
            .get_discover_catalog(media_type, &catalog_id, genres.first().cloned())
            .await
    }
}

async fn fetch_kitsu_browse_items(
    provider: &Kitsu,
    feed: SearchFeed,
    genres: &[String],
) -> Result<Vec<MediaItem>, String> {
    let catalog_id = feed.kitsu_catalog();

    if genres.len() > 1 {
        let mut futures = Vec::with_capacity(genres.len());

        for genre in genres {
            futures.push(provider.get_anime_catalog(catalog_id, Some(genre.clone()), None));
        }

        merge_item_batches(join_all(futures).await)
    } else {
        provider
            .get_anime_catalog(catalog_id, genres.first().cloned(), None)
            .await
    }
}

async fn fetch_addon_browse_items(
    provider: &Netflix,
    catalog_id: &str,
    media_type: SearchMediaType,
    year_range: SearchYearRange,
) -> Result<Vec<MediaItem>, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut current_skip = 0u32;

    while current_skip < MAX_SORTED_BROWSE_SCAN_ITEMS {
        let batch = provider
            .get_catalog(catalog_id, media_type.as_str(), Some(current_skip))
            .await?;
        let batch_len = batch.len();
        if batch_len == 0 {
            break;
        }

        for item in filter_items_by_year(batch, year_range) {
            if seen_ids.insert(item.id.clone()) {
                items.push(item);
            }
        }

        current_skip += batch_len as u32;
        if batch_len < ADDON_PAGE_SIZE {
            break;
        }
    }

    Ok(items)
}

async fn fetch_default_addon_browse_page(
    provider: &Netflix,
    catalog_id: &str,
    media_type: SearchMediaType,
    skip: u32,
    year_range: SearchYearRange,
) -> Result<SearchCatalogPage, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut next_skip = None;
    let mut current_skip = skip;

    while current_skip < MAX_SORTED_BROWSE_SCAN_ITEMS {
        let batch = provider
            .get_catalog(catalog_id, media_type.as_str(), Some(current_skip))
            .await?;
        let batch_len = batch.len();
        if batch_len == 0 {
            next_skip = None;
            break;
        }

        let filtered_batch = filter_items_by_year(batch, year_range);
        for item in filtered_batch {
            if seen_ids.insert(item.id.clone()) {
                items.push(item);
            }
        }

        current_skip += batch_len as u32;
        next_skip = (batch_len >= ADDON_PAGE_SIZE && current_skip < MAX_SORTED_BROWSE_SCAN_ITEMS)
            .then_some(current_skip);

        if batch_len < ADDON_PAGE_SIZE || !items.is_empty() || !year_range.is_active() {
            break;
        }
    }

    Ok(SearchCatalogPage { items, next_skip })
}

async fn fetch_sorted_browse_items(
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    netflix_provider: &Netflix,
    criteria: &SearchCatalogCriteria,
) -> Result<Vec<MediaItem>, String> {
    let media_type = criteria
        .media_type
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let feed = criteria
        .feed
        .unwrap_or_else(|| SearchFeed::resolve(media_type, None));

    let items = match criteria.provider {
        SearchProvider::Kitsu => {
            fetch_kitsu_browse_items(kitsu_provider, feed, &criteria.genres).await?
        }
        SearchProvider::Cinemeta => {
            fetch_cinemeta_browse_items(cinemeta_provider, media_type, feed, &criteria.genres)
                .await?
        }
        provider => {
            let catalog_id = provider
                .addon_catalog_id()
                .ok_or_else(|| "Invalid addon provider.".to_string())?;

            fetch_addon_browse_items(
                netflix_provider,
                catalog_id,
                media_type,
                criteria.year_range,
            )
            .await?
        }
    };

    Ok(
        if matches!(
            criteria.provider,
            SearchProvider::Netflix
                | SearchProvider::Hbo
                | SearchProvider::Disney
                | SearchProvider::Prime
                | SearchProvider::Apple
        ) {
            items
        } else {
            filter_items_by_year(items, criteria.year_range)
        },
    )
}

async fn fetch_browse_page(
    cinemeta_provider: &Cinemeta,
    kitsu_provider: &Kitsu,
    netflix_provider: &Netflix,
    criteria: &SearchCatalogCriteria,
) -> Result<SearchCatalogPage, String> {
    let media_type = criteria
        .media_type
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let feed = criteria
        .feed
        .unwrap_or_else(|| SearchFeed::resolve(media_type, None));

    if matches!(criteria.sort, SearchSort::Default) {
        return match criteria.provider {
            SearchProvider::Kitsu => Ok(SearchCatalogPage {
                items: filter_items_by_year(
                    fetch_kitsu_browse_items(kitsu_provider, feed, &criteria.genres).await?,
                    criteria.year_range,
                ),
                next_skip: None,
            }),
            SearchProvider::Cinemeta => Ok(SearchCatalogPage {
                items: filter_items_by_year(
                    fetch_cinemeta_browse_items(
                        cinemeta_provider,
                        media_type,
                        feed,
                        &criteria.genres,
                    )
                    .await?,
                    criteria.year_range,
                ),
                next_skip: None,
            }),
            provider => {
                let catalog_id = provider
                    .addon_catalog_id()
                    .ok_or_else(|| "Invalid addon provider.".to_string())?;

                fetch_default_addon_browse_page(
                    netflix_provider,
                    catalog_id,
                    media_type,
                    criteria.skip,
                    criteria.year_range,
                )
                .await
            }
        };
    }

    let items = sort_catalog_items(
        fetch_sorted_browse_items(
            cinemeta_provider,
            kitsu_provider,
            netflix_provider,
            criteria,
        )
        .await?,
        criteria.sort,
    );
    Ok(slice_catalog_page(
        items,
        criteria.skip,
        criteria.page_limit,
    ))
}

#[command]
pub async fn query_search_catalog(
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    netflix_provider: State<'_, Netflix>,
    request: SearchCatalogRequest,
) -> Result<SearchCatalogPage, String> {
    let criteria = build_search_criteria(request)?;

    if let Some(query) = criteria.query.as_deref() {
        let items = fetch_query_results(
            &cinemeta_provider,
            &kitsu_provider,
            query,
            criteria.media_type,
        )
        .await?;
        let items = filter_items_by_year(items, criteria.year_range);
        let items = match criteria.sort {
            SearchSort::Default => rank_search_results(query, items, criteria.limit),
            sort => {
                let mut sorted = sort_catalog_items(items, sort);
                if let Some(limit) = criteria.limit {
                    sorted.truncate(limit);
                }
                sorted
            }
        };

        return Ok(SearchCatalogPage {
            items: normalize_media_items(items),
            next_skip: None,
        });
    }

    fetch_browse_page(
        &cinemeta_provider,
        &kitsu_provider,
        &netflix_provider,
        &criteria,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{slice_catalog_page, sort_catalog_items, SearchSort};
    use crate::providers::MediaItem;

    fn build_item(id: &str, title: &str, year: Option<&str>) -> MediaItem {
        MediaItem {
            id: id.to_string(),
            title: title.to_string(),
            poster: None,
            backdrop: None,
            logo: None,
            description: None,
            year: year.map(str::to_string),
            primary_year: None,
            display_year: None,
            type_: "movie".to_string(),
            relation_role: None,
            relation_context_label: None,
            relation_preferred_season: None,
        }
    }

    #[test]
    fn sort_catalog_items_orders_by_title_and_year() {
        let items = vec![
            build_item("2", "Beta", Some("2023")),
            build_item("1", "Alpha", Some("2024")),
            build_item("3", "Gamma", Some("2022")),
        ];

        let title_sorted = sort_catalog_items(items.clone(), SearchSort::TitleAsc)
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(title_sorted, vec!["1", "2", "3"]);

        let year_sorted = sort_catalog_items(items, SearchSort::YearDesc)
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(year_sorted, vec!["1", "2", "3"]);
    }

    #[test]
    fn slice_catalog_page_uses_backend_cursor_offset() {
        let items = vec![
            build_item("1", "Alpha", Some("2024")),
            build_item("2", "Beta", Some("2023")),
            build_item("3", "Gamma", Some("2022")),
        ];

        let page = slice_catalog_page(items, 1, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "2");
        assert_eq!(page.next_skip, Some(2));
    }
}
