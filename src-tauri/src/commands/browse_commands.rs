use super::{normalize_cinemeta_catalog, normalize_cinemeta_type, normalize_non_empty};
use crate::providers::{cinemeta::Cinemeta, kitsu::Kitsu, MediaItem};
use futures_util::future::join_all;
use serde::Serialize;
use std::collections::HashSet;
use tauri::{command, State};

const KITSU_MULTI_GENRE_MINIMUM_PAGE_SIZE: usize = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiGenreCatalogPage {
    pub items: Vec<MediaItem>,
    pub has_more: bool,
}

fn normalize_genres(genres: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(genres.len());

    for genre in genres {
        let Some(genre) = normalize_non_empty(&genre) else {
            continue;
        };

        if seen.insert(genre.clone()) {
            normalized.push(genre);
        }
    }

    normalized
}

fn merge_multi_genre_results(
    results: Vec<Result<Vec<MediaItem>, String>>,
    minimum_page_size_for_more: Option<usize>,
) -> Result<MultiGenreCatalogPage, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut had_success = false;
    let mut last_error: Option<String> = None;
    let mut has_more = false;

    for result in results {
        match result {
            Ok(batch) => {
                had_success = true;
                if let Some(minimum_page_size) = minimum_page_size_for_more {
                    if batch.len() >= minimum_page_size {
                        has_more = true;
                    }
                }

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
        return Err(last_error.unwrap_or_else(|| "Failed to load multi-genre catalog.".to_string()));
    }

    Ok(MultiGenreCatalogPage { items, has_more })
}

#[command]
pub async fn get_multi_genre_catalog(
    cinemeta_provider: State<'_, Cinemeta>,
    kitsu_provider: State<'_, Kitsu>,
    media_type: String,
    catalog_id: String,
    genres: Vec<String>,
    skip: Option<u32>,
) -> Result<MultiGenreCatalogPage, String> {
    let normalized_genres = normalize_genres(genres);
    if normalized_genres.is_empty() {
        return Ok(MultiGenreCatalogPage {
            items: Vec::new(),
            has_more: false,
        });
    }

    let page_skip = skip.filter(|value| *value > 0);

    if media_type.trim().eq_ignore_ascii_case("anime") {
        let catalog_id =
            normalize_non_empty(&catalog_id).ok_or_else(|| "Catalog ID is required.".to_string())?;
        let provider = &*kitsu_provider;
        let futures = normalized_genres.into_iter().map(|genre| {
            let catalog_id = catalog_id.clone();
            async move { provider.get_anime_catalog(&catalog_id, Some(genre), page_skip).await }
        });

        return merge_multi_genre_results(
            join_all(futures).await,
            Some(KITSU_MULTI_GENRE_MINIMUM_PAGE_SIZE),
        );
    }

    let media_type = normalize_cinemeta_type(&media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    let catalog_id = normalize_cinemeta_catalog(&catalog_id)
        .ok_or_else(|| "Invalid Cinemeta catalog.".to_string())?;

    if page_skip.is_some() {
        return Ok(MultiGenreCatalogPage {
            items: Vec::new(),
            has_more: false,
        });
    }

    let provider = &*cinemeta_provider;
    let futures = normalized_genres.into_iter().map(|genre| {
        let media_type = media_type.clone();
        let catalog_id = catalog_id.clone();
        async move {
            provider
                .get_discover_catalog(&media_type, &catalog_id, Some(genre))
                .await
        }
    });

    merge_multi_genre_results(join_all(futures).await, None)
}