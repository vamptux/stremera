use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// A single skippable segment (intro, outro, recap, opening, ending, etc.)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkipSegment {
    #[serde(rename = "type")]
    pub type_: String,
    /// Segment start in seconds
    pub start_time: f64,
    /// Segment end in seconds
    pub end_time: f64,
}

pub struct SkipTimesProvider {
    client: Client,
    /// In-process cache for Kitsu → MAL ID mappings.
    ///
    /// Each entry is `Some(mal_id)` on a successful mapping or `None` when
    /// the Kitsu API confirmed there is no MyAnimeList mapping for that ID.
    /// Both positive and negative results are cached to avoid redundant
    /// network requests across episodes of the same show.
    ///
    /// The map is keyed on the raw Kitsu numeric ID string (e.g. `"7936"`).
    mal_id_cache: Mutex<HashMap<String, Option<u64>>>,
}

const MAL_ID_CACHE_MAX_ENTRIES: usize = 2048;

impl SkipTimesProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("Streamy/1.0 (+https://github.com/streamy)")
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| Client::new()),
            mal_id_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve the MAL (MyAnimeList) ID from a Kitsu numeric ID via Kitsu's mappings API.
    ///
    /// Results (both positive `Some(id)` and negative `None`) are cached in
    /// `self.mal_id_cache` so that subsequent calls for the same show within
    /// the same app session never hit the network.  This is important because
    /// `get_skip_times` is invoked on every episode open.
    pub async fn resolve_mal_id(&self, kitsu_id: &str) -> Option<u64> {
        // ── Cache read ───────────────────────────────────────────────────────
        // Use a narrow lock scope so we don't hold the mutex across await points.
        {
            let cache = self.mal_id_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.get(kitsu_id) {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[SkipTimes] MAL ID cache hit for kitsu:{} → {:?}",
                    kitsu_id, cached
                );
                return *cached;
            }
        }

        // ── Network resolution ───────────────────────────────────────────────
        let url = format!("https://kitsu.io/api/edge/anime/{}/mappings", kitsu_id);

        #[cfg(debug_assertions)]
        eprintln!(
            "[SkipTimes] Resolving MAL ID for kitsu:{} — {}",
            kitsu_id, url
        );

        let result: Option<u64> = async {
            let res = self
                .client
                .get(&url)
                .header("Accept", "application/vnd.api+json")
                .send()
                .await
                .ok()?;

            if !res.status().is_success() {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] MAL resolve HTTP {}", res.status());
                return None;
            }

            let body: serde_json::Value = res.json().await.ok()?;
            let data = body.get("data")?.as_array()?;

            for entry in data {
                let attrs = entry.get("attributes")?;
                let external_site = attrs.get("externalSite")?.as_str()?;
                if external_site == "myanimelist/anime" {
                    let external_id = attrs.get("externalId")?.as_str()?;
                    let mal_id = external_id.parse::<u64>().ok()?;
                    #[cfg(debug_assertions)]
                    eprintln!("[SkipTimes] Resolved MAL ID: {}", mal_id);
                    return Some(mal_id);
                }
            }

            #[cfg(debug_assertions)]
            eprintln!("[SkipTimes] No MAL mapping found for kitsu:{}", kitsu_id);
            None
        }
        .await;

        // ── Cache write (stores both positive and negative results) ──────────
        {
            let mut cache = self.mal_id_cache.lock().unwrap_or_else(|e| e.into_inner());
            if cache.len() >= MAL_ID_CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(kitsu_id.to_string(), result);
        }

        result
    }

    /// Fetch skip segments from the AniSkip v2 API using a MAL ID and absolute episode number.
    ///
    /// `episode_length`: episode duration in seconds. Pass `0.0` to skip length-based filtering.
    pub async fn get_aniskip_segments(
        &self,
        mal_id: u64,
        episode: u32,
        episode_length: f64,
    ) -> Vec<SkipSegment> {
        let url = format!(
            "https://api.aniskip.com/v2/skip-times/{}/{}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength={:.3}",
            mal_id, episode, episode_length
        );

        #[cfg(debug_assertions)]
        eprintln!("[SkipTimes] AniSkip: {}", url);

        let res = match self.client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] AniSkip request error: {}", e);
                return Vec::new();
            }
        };

        if !res.status().is_success() {
            #[cfg(debug_assertions)]
            eprintln!("[SkipTimes] AniSkip HTTP {}", res.status());
            return Vec::new();
        }

        let body: AniSkipResponse = match res.json().await {
            Ok(b) => b,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] AniSkip parse error: {}", e);
                return Vec::new();
            }
        };

        if !body.found {
            return Vec::new();
        }

        body.results
            .into_iter()
            .map(|r| SkipSegment {
                type_: r.skip_type,
                start_time: r.interval.start_time,
                end_time: r.interval.end_time,
            })
            .collect()
    }

    /// Fetch skip/recap/outro segments from the IntroDB API using an IMDb ID, season, and episode.
    pub async fn get_introdb_segments(
        &self,
        imdb_id: &str,
        season: u32,
        episode: u32,
    ) -> Vec<SkipSegment> {
        let url = format!(
            "https://api.introdb.app/segments?imdb_id={}&season={}&episode={}",
            imdb_id, season, episode
        );

        #[cfg(debug_assertions)]
        eprintln!("[SkipTimes] IntroDB: {}", url);

        let res = match self.client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] IntroDB request error: {}", e);
                return Vec::new();
            }
        };

        // 404 is normal (entry doesn't exist yet — crowdsourced)
        if res.status().as_u16() == 404 {
            return Vec::new();
        }

        if !res.status().is_success() {
            #[cfg(debug_assertions)]
            eprintln!("[SkipTimes] IntroDB HTTP {}", res.status());
            return Vec::new();
        }

        let body: IntroDbSegmentsResponse = match res.json().await {
            Ok(b) => b,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] IntroDB parse error: {}", e);
                return Vec::new();
            }
        };

        let mut segments = Vec::new();

        if let Some(intro) = body.intro {
            segments.push(SkipSegment {
                type_: "intro".to_string(),
                start_time: intro.start_sec as f64,
                end_time: intro.end_sec as f64,
            });
        }
        if let Some(recap) = body.recap {
            segments.push(SkipSegment {
                type_: "recap".to_string(),
                start_time: recap.start_sec as f64,
                end_time: recap.end_sec as f64,
            });
        }
        if let Some(outro) = body.outro {
            segments.push(SkipSegment {
                type_: "outro".to_string(),
                start_time: outro.start_sec as f64,
                end_time: outro.end_sec as f64,
            });
        }

        segments
    }
}

impl Default for SkipTimesProvider {
    fn default() -> Self {
        Self::new()
    }
}

// ─── AniSkip deserialization ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct AniSkipResponse {
    found: bool,
    #[serde(default)]
    results: Vec<AniSkipResult>,
}

#[derive(Deserialize)]
struct AniSkipResult {
    interval: AniSkipInterval,
    #[serde(rename = "skipType")]
    skip_type: String,
}

#[derive(Deserialize)]
struct AniSkipInterval {
    #[serde(rename = "startTime")]
    start_time: f64,
    #[serde(rename = "endTime")]
    end_time: f64,
}

// ─── IntroDB deserialization ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct IntroDbSegmentsResponse {
    intro: Option<IntroDbSegment>,
    recap: Option<IntroDbSegment>,
    outro: Option<IntroDbSegment>,
}

#[derive(Deserialize)]
struct IntroDbSegment {
    start_sec: u32,
    end_sec: u32,
}
