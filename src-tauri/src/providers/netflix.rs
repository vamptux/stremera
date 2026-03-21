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
                type_: meta.type_,
            })
            .collect()
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
        //     first page.  The frontend's `getNextPageParam` deduplicates by item
        //     id, so it will see 0 new items and stop paginating automatically.
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
        for item in first_page {
            if seen.insert(item.id.clone()) {
                all_items.push(item);
            }
        }

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
                    for item in items {
                        if seen.insert(item.id.clone()) {
                            all_items.push(item);
                        }
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

    #[test]
    fn parse_catalog_response_treats_empty_object_as_empty_catalog() {
        let catalog = Netflix::parse_catalog_response("{}").expect("empty catalog response");
        assert!(catalog.metas.is_empty());
    }
}
