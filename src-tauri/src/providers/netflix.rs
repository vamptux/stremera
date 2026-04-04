use super::{build_provider_http_client, MediaItem};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;

const BASE_URL: &str = "https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club";

pub struct Netflix {
    client: Client,
}

impl Netflix {
    pub fn new() -> Self {
        Self {
            client: build_provider_http_client(None),
        }
    }

    fn parse_catalog_response(text: &str) -> Result<CatalogResponse, String> {
        serde_json::from_str(text).map_err(|e| {
            #[cfg(debug_assertions)]
            {
                eprintln!("Failed to parse netflix response: {}", e);
                eprintln!("Snippet: {}", &text.chars().take(200).collect::<String>());
            }
            format!("Parse Error: {}", e)
        })
    }

    fn map_catalog(catalog: CatalogResponse) -> Vec<MediaItem> {
        catalog
            .metas
            .into_iter()
            .map(|meta| MediaItem {
                id: meta.id,
                title: meta.name,
                poster: meta.poster,
                backdrop: meta.background,
                logo: meta.logo,
                description: meta.description,
                year: meta.year,
                primary_year: None,
                display_year: None,
                type_: meta.type_,
                relation_role: None,
                relation_context_label: None,
                relation_preferred_season: None,
            })
            .collect()
    }

    fn extend_unique_items(
        all_items: &mut Vec<MediaItem>,
        seen: &mut HashSet<String>,
        batch: Vec<MediaItem>,
    ) -> usize {
        let mut inserted = 0usize;

        for item in batch {
            if seen.insert(item.id.clone()) {
                inserted += 1;
                all_items.push(item);
            }
        }

        inserted
    }

    pub async fn get_catalog(
        &self,
        catalog_id: &str,
        type_: &str,
        skip: Option<u32>,
    ) -> Result<Vec<MediaItem>, String> {
        // catalog_id: nfx (Netflix), hbm (HBO Max), dnp (Disney+), amp (Prime), atp (Apple TV+)
        // type_: movie | series
        //
        // Skip-pagination behaviour (verified 2026-03):
        //   • The Stremio catalog addon hosted at BASE_URL honours Stremio-style
        //     skip path segments (`/skip=N`).
        //   • A missing page returns HTTP 404; `fetch_page_optional` maps that to
        //     `None`, which halts the loop — no retry needed.
        //   • An empty `metas` array (instead of 404) also stops the loop.
        //   • Some catalog mirrors may NOT honour skip and always return the same
        //     first page. Stop as soon as a repeated page contributes no new ids.
        let mut all_items: Vec<MediaItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        if let Some(skip_val) = skip {
            // Single-page mode for infinite scroll
            let url = if skip_val == 0 {
                format!("{}/catalog/{}/{}.json", BASE_URL, type_, catalog_id)
            } else {
                format!(
                    "{}/catalog/{}/{}/skip={}.json",
                    BASE_URL, type_, catalog_id, skip_val
                )
            };
            #[cfg(debug_assertions)]
            eprintln!("Fetching Netflix Catalog (single): {}", url);
            match self.fetch_page_optional(&url).await? {
                None => return Ok(vec![]),
                Some(items) => return Ok(items),
            }
        }

        // Multi-page mode for home rows (no skip specified)
        let base_url = format!("{}/catalog/{}/{}.json", BASE_URL, type_, catalog_id);
        #[cfg(debug_assertions)]
        eprintln!("Fetching Netflix Catalog: {}", base_url);
        let first_page = self.fetch_page(&base_url).await?;
        Self::extend_unique_items(&mut all_items, &mut seen, first_page);

        // Some deployments support Stremio-style skip pagination even if not declared in manifest.
        // Try several pages for richer catalogs and stop on 404.
        for skip_offset in [100, 200] {
            let url = format!(
                "{}/catalog/{}/{}/skip={}.json",
                BASE_URL, type_, catalog_id, skip_offset
            );
            #[cfg(debug_assertions)]
            eprintln!("Fetching Netflix Catalog (skip): {}", url);

            match self.fetch_page_optional(&url).await? {
                None => break,
                Some(items) => {
                    if items.is_empty() {
                        break;
                    }

                    if Self::extend_unique_items(&mut all_items, &mut seen, items) == 0 {
                        break;
                    }
                }
            }
        }

        Ok(all_items)
    }

    async fn fetch_page(&self, url: &str) -> Result<Vec<MediaItem>, String> {
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

        Ok(Self::map_catalog(catalog))
    }

    async fn fetch_page_optional(&self, url: &str) -> Result<Option<Vec<MediaItem>>, String> {
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

        Ok(Some(Self::map_catalog(catalog)))
    }
}

impl Default for Netflix {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default, Deserialize)]
struct CatalogResponse {
    #[serde(default)]
    metas: Vec<Meta>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn build_item(id: &str) -> MediaItem {
        MediaItem {
            id: id.to_string(),
            title: id.to_string(),
            poster: None,
            backdrop: None,
            logo: None,
            description: None,
            year: None,
            primary_year: None,
            display_year: None,
            type_: "movie".to_string(),
            relation_role: None,
            relation_context_label: None,
            relation_preferred_season: None,
        }
    }

    #[test]
    fn parse_catalog_response_treats_empty_object_as_empty_catalog() {
        let catalog = Netflix::parse_catalog_response("{}").expect("empty catalog response");
        assert!(catalog.metas.is_empty());
    }

    #[test]
    fn extend_unique_items_detects_repeated_page() {
        let mut all_items = Vec::new();
        let mut seen = HashSet::new();

        let inserted = Netflix::extend_unique_items(
            &mut all_items,
            &mut seen,
            vec![build_item("1"), build_item("2")],
        );
        assert_eq!(inserted, 2);
        assert_eq!(all_items.len(), 2);

        let repeated_inserted = Netflix::extend_unique_items(
            &mut all_items,
            &mut seen,
            vec![build_item("1"), build_item("2")],
        );
        assert_eq!(repeated_inserted, 0);
        assert_eq!(all_items.len(), 2);
    }
}
