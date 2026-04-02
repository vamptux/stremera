use crate::providers::{
    build_episode_season_years, extract_primary_year, Episode, MediaDetails, MediaItem,
};
use regex::Regex;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static NON_ALNUM_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9\s]").expect("valid non-alnum regex"));
static FRANCHISE_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(season|part|cour|movie|ova|ona|special|specials|final|edition|arc|tv)\b")
        .expect("valid franchise marker regex")
});
static FRANCHISE_ROMAN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(ii|iii|iv|vi|vii|viii|ix|x)\b").expect("valid roman regex"));
static FRANCHISE_TRAILING_DIGIT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([2-9])\b").expect("valid trailing digit regex"));
static MULTI_SPACE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("valid multi-space regex"));
static RELEASE_DATE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(\d{4})-(\d{2})-(\d{2})\b").expect("valid release date regex"));
static DIRECT_SEASON_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bseason\s*[:\-]?\s*(\d{1,2})\b").expect("valid direct season regex")
});
static ORDINAL_SEASON_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2})(?:st|nd|rd|th)\s+season\b").expect("valid ordinal season regex")
});
static PART_NUMBER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bpart\s+(\d{1,2})\b").expect("valid part number regex"));
static PART_ROMAN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bpart\s+(ii|iii|iv|vi|vii|viii|ix|x)\b").expect("valid part roman regex")
});
static ROMAN_SUFFIX_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\s:]+(ii|iii|iv|vi|vii|viii|ix|x)\s*(?:[:\-]|$)")
        .expect("valid roman suffix regex")
});
static TRAILING_DIGIT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s:]([2-9])\s*$").expect("valid trailing digit regex"));
static SEASON_PART_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bseason\s*[:\-]?\s*(\d{1,2})\s+part\s+(\d{1,2})\b")
        .expect("valid season part regex")
});
static SEASON_PART_ROMAN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bseason\s*[:\-]?\s*(\d{1,2})\s+part\s+(ii|iii|iv|vi|vii|viii|ix|x)\b")
        .expect("valid season part roman regex")
});

#[derive(Clone, Copy)]
struct SeasonInfo {
    season: u32,
    part: Option<u32>,
}

#[derive(Clone)]
struct RelationCandidate {
    relation: MediaItem,
    score: f64,
    role_priority: u8,
    year: Option<u32>,
    season_info: Option<SeasonInfo>,
}

fn roman_numeral_season(value: &str) -> Option<u32> {
    match value {
        "ii" => Some(2),
        "iii" => Some(3),
        "iv" => Some(4),
        "vi" => Some(6),
        "vii" => Some(7),
        "viii" => Some(8),
        "ix" => Some(9),
        "x" => Some(10),
        _ => None,
    }
}

pub(crate) fn build_display_year(value: Option<&str>) -> Option<String> {
    extract_primary_year(value).map(|year| year.to_string())
}

fn normalize_episode_metadata(mut episode: Episode) -> Episode {
    episode.release_date = build_release_date(episode.released.as_deref());
    episode
}

pub(crate) fn normalize_episode_metadata_list(episodes: Vec<Episode>) -> Vec<Episode> {
    episodes
        .into_iter()
        .map(normalize_episode_metadata)
        .collect()
}

fn days_in_month(year: u32, month: u32) -> Option<u32> {
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let is_leap_year =
                (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
            if is_leap_year {
                29
            } else {
                28
            }
        }
        _ => return None,
    };

    Some(days)
}

pub(crate) fn build_release_date(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }

    if let Some(captures) = RELEASE_DATE_REGEX.captures(value) {
        if let (Some(year), Some(month), Some(day)) = (
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<u32>().ok()),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<u32>().ok()),
            captures
                .get(3)
                .and_then(|value| value.as_str().parse::<u32>().ok()),
        ) {
            if (1889..=2100).contains(&year)
                && days_in_month(year, month).is_some_and(|max_day| (1..=max_day).contains(&day))
            {
                return Some(format!("{year:04}-{month:02}-{day:02}"));
            }
        }
    }

    extract_primary_year(Some(value)).map(|year| format!("{year:04}-01-01"))
}

fn normalize_existing_season_years(
    season_years: Option<HashMap<u32, String>>,
) -> Option<HashMap<u32, String>> {
    let mut normalized = HashMap::new();

    for (season, label) in season_years.unwrap_or_default() {
        let Some(label) = super::normalize_non_empty(&label) else {
            continue;
        };

        normalized.insert(season, label);
    }

    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_franchise_tokens(title: &str) -> Vec<String> {
    let lowered = title.to_ascii_lowercase();
    let stripped = NON_ALNUM_REGEX.replace_all(&lowered, " ");
    let stripped = FRANCHISE_MARKER_REGEX.replace_all(&stripped, " ");
    let stripped = FRANCHISE_ROMAN_REGEX.replace_all(&stripped, " ");
    let stripped = FRANCHISE_TRAILING_DIGIT_REGEX.replace_all(&stripped, " ");
    let stripped = MULTI_SPACE_REGEX.replace_all(&stripped, " ");

    stripped
        .split(' ')
        .filter(|token| token.len() >= 3)
        .map(str::to_string)
        .collect()
}

fn anime_relation_score(base_tokens: &[String], relation_title: &str) -> f64 {
    if base_tokens.is_empty() {
        return 0.0;
    }

    let relation_tokens = normalize_franchise_tokens(relation_title)
        .into_iter()
        .collect::<HashSet<_>>();
    if relation_tokens.is_empty() {
        return 0.0;
    }

    let shared = base_tokens
        .iter()
        .filter(|token| relation_tokens.contains(token.as_str()))
        .count();
    shared as f64 / base_tokens.len() as f64
}

fn relation_role_priority(role: Option<&str>) -> u8 {
    match role
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "sequel" | "prequel" => 5,
        "side_story" | "spin_off" | "spinoff" => 4,
        "alternative_setting" | "alternative_version" => 3,
        "parent_story" | "full_story" | "summary" => 2,
        _ => 1,
    }
}

fn parse_capture_number(captures: &regex::Captures<'_>, index: usize) -> Option<u32> {
    captures
        .get(index)?
        .as_str()
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
}

fn extract_season_number_from_title(title: &str) -> Option<u32> {
    let normalized = title.to_ascii_lowercase();

    if let Some(captures) = DIRECT_SEASON_REGEX.captures(&normalized) {
        return parse_capture_number(&captures, 1);
    }
    if let Some(captures) = ORDINAL_SEASON_REGEX.captures(&normalized) {
        return parse_capture_number(&captures, 1);
    }
    if let Some(captures) = PART_NUMBER_REGEX.captures(&normalized) {
        return parse_capture_number(&captures, 1);
    }
    if let Some(captures) = PART_ROMAN_REGEX.captures(&normalized) {
        return captures
            .get(1)
            .and_then(|value| roman_numeral_season(value.as_str()));
    }
    if let Some(captures) = ROMAN_SUFFIX_REGEX.captures(&normalized) {
        return captures
            .get(1)
            .and_then(|value| roman_numeral_season(value.as_str()));
    }
    if let Some(captures) = TRAILING_DIGIT_REGEX.captures(&normalized) {
        return parse_capture_number(&captures, 1);
    }

    None
}

fn extract_season_info_from_title(title: &str) -> Option<SeasonInfo> {
    let normalized = title.to_ascii_lowercase();

    if let Some(captures) = SEASON_PART_REGEX.captures(&normalized) {
        return Some(SeasonInfo {
            season: parse_capture_number(&captures, 1)?,
            part: parse_capture_number(&captures, 2),
        });
    }

    if let Some(captures) = SEASON_PART_ROMAN_REGEX.captures(&normalized) {
        return Some(SeasonInfo {
            season: parse_capture_number(&captures, 1)?,
            part: captures
                .get(2)
                .and_then(|value| roman_numeral_season(value.as_str())),
        });
    }

    extract_season_number_from_title(title).map(|season| SeasonInfo { season, part: None })
}

fn format_season_info_label(season_info: SeasonInfo) -> String {
    match season_info.part {
        Some(part) => format!("Season {} Part {}", season_info.season, part),
        None => format!("Season {}", season_info.season),
    }
}

fn build_relation_context_label(title: &str, primary_year: Option<u32>) -> Option<String> {
    let season_info = extract_season_info_from_title(title);

    match (season_info, primary_year) {
        (None, None) => None,
        (None, Some(year)) => Some(year.to_string()),
        (Some(season_info), None) => Some(format_season_info_label(season_info)),
        (Some(season_info), Some(year)) => Some(format!(
            "{} • {}",
            format_season_info_label(season_info),
            year
        )),
    }
}

pub(crate) fn normalize_media_item(mut item: MediaItem) -> MediaItem {
    item.primary_year = extract_primary_year(item.year.as_deref());
    item.display_year = build_display_year(item.year.as_deref());
    item.relation_context_label = item
        .relation_context_label
        .take()
        .and_then(|value| super::normalize_non_empty(&value));
    item.relation_preferred_season = item.relation_preferred_season.filter(|value| *value > 0);
    item
}

pub(crate) fn normalize_media_items(items: Vec<MediaItem>) -> Vec<MediaItem> {
    items.into_iter().map(normalize_media_item).collect()
}

fn normalize_relations(
    base_id: &str,
    base_title: &str,
    relations: Vec<MediaItem>,
) -> Vec<MediaItem> {
    let is_anime_like = base_id.trim().to_ascii_lowercase().starts_with("kitsu:");
    let base_tokens = if is_anime_like {
        normalize_franchise_tokens(base_title)
    } else {
        Vec::new()
    };
    let mut seen_ids = HashSet::new();
    let mut candidates = relations
        .into_iter()
        .filter_map(|relation| {
            if !seen_ids.insert(relation.id.clone()) {
                return None;
            }

            let mut relation = normalize_media_item(relation);
            let season_info = extract_season_info_from_title(&relation.title);
            relation.relation_context_label =
                build_relation_context_label(&relation.title, relation.primary_year);
            relation.relation_preferred_season = season_info.map(|info| info.season);

            Some(RelationCandidate {
                score: if is_anime_like {
                    anime_relation_score(&base_tokens, &relation.title)
                } else {
                    1.0
                },
                role_priority: relation_role_priority(relation.relation_role.as_deref()),
                year: relation.primary_year,
                season_info,
                relation,
            })
        })
        .collect::<Vec<_>>();

    if is_anime_like {
        let strict_matches = candidates
            .iter()
            .filter(|candidate| {
                let minimum_score = if candidate
                    .season_info
                    .is_some_and(|season| season.part.is_some())
                {
                    0.22
                } else {
                    0.34
                };

                candidate.score >= minimum_score
            })
            .cloned()
            .collect::<Vec<_>>();

        if !strict_matches.is_empty() {
            candidates = strict_matches;
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.role_priority.cmp(&left.role_priority))
            .then_with(|| match (left.year, right.year) {
                (Some(left_year), Some(right_year)) if left_year != right_year => {
                    left_year.cmp(&right_year)
                }
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                _ => Ordering::Equal,
            })
            .then_with(|| left.relation.title.cmp(&right.relation.title))
    });

    candidates
        .into_iter()
        .map(|candidate| candidate.relation)
        .collect()
}

pub(crate) fn normalize_media_details(mut details: MediaDetails) -> MediaDetails {
    details.primary_year = extract_primary_year(details.year.as_deref());
    details.display_year = build_display_year(details.year.as_deref());
    details.release_date = build_release_date(details.year.as_deref());
    let normalized_episodes = details.episodes.take().map(normalize_episode_metadata_list);
    details.season_years =
        normalize_existing_season_years(details.season_years.take()).or_else(|| {
            normalized_episodes
                .as_ref()
                .and_then(|episodes| build_episode_season_years(episodes))
        });
    details.episodes = normalized_episodes;
    details.relations = details
        .relations
        .take()
        .map(|relations| normalize_relations(&details.id, &details.title, relations))
        .filter(|relations| !relations.is_empty());
    details
}

#[cfg(test)]
mod tests {
    use super::{
        build_display_year, build_release_date, extract_primary_year,
        normalize_episode_metadata_list, normalize_media_details, normalize_media_item,
    };
    use crate::providers::Episode;
    use crate::providers::MediaDetails;
    use crate::providers::MediaItem;

    fn relation(id: &str, title: &str, year: Option<&str>, role: Option<&str>) -> MediaItem {
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
            type_: "series".to_string(),
            relation_role: role.map(str::to_string),
            relation_context_label: None,
            relation_preferred_season: None,
        }
    }

    #[test]
    fn extract_primary_year_reads_first_valid_year() {
        assert_eq!(extract_primary_year(Some("2019-04-06")), Some(2019));
        assert_eq!(extract_primary_year(Some("Premiered in 2021")), Some(2021));
        assert_eq!(extract_primary_year(Some("Unknown")), None);
    }

    #[test]
    fn build_display_year_uses_first_valid_numeric_year() {
        assert_eq!(
            build_display_year(Some("2019-04-06")).as_deref(),
            Some("2019")
        );
        assert_eq!(
            build_display_year(Some("2019-2020")).as_deref(),
            Some("2019")
        );
        assert_eq!(build_display_year(Some("Unknown")), None);
    }

    #[test]
    fn normalize_media_item_sets_display_year() {
        let item = normalize_media_item(MediaItem {
            id: "tt1".to_string(),
            title: "Demo".to_string(),
            poster: None,
            backdrop: None,
            logo: None,
            description: None,
            year: Some("2024-10-01".to_string()),
            primary_year: None,
            display_year: None,
            type_: "movie".to_string(),
            relation_role: None,
            relation_context_label: None,
            relation_preferred_season: None,
        });

        assert_eq!(item.primary_year, Some(2024));
        assert_eq!(item.display_year.as_deref(), Some("2024"));
    }

    #[test]
    fn normalize_media_details_filters_and_orders_anime_relations() {
        let details = MediaDetails {
            id: "kitsu:42".to_string(),
            imdb_id: None,
            title: "Attack on Titan".to_string(),
            poster: None,
            backdrop: None,
            logo: None,
            year: Some("2013-04-07".to_string()),
            primary_year: None,
            display_year: None,
            release_date: None,
            type_: "series".to_string(),
            description: None,
            rating: None,
            cast: None,
            genres: None,
            trailers: None,
            episodes: Some(vec![
                Episode {
                    id: "ep-1".to_string(),
                    title: Some("Episode 1".to_string()),
                    season: 1,
                    episode: 1,
                    released: Some("2013-04-07".to_string()),
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
                },
                Episode {
                    id: "ep-2".to_string(),
                    title: Some("Episode 2".to_string()),
                    season: 1,
                    episode: 2,
                    released: Some("2014-01-05".to_string()),
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
                },
            ]),
            season_years: None,
            relations: Some(vec![
                relation(
                    "kitsu:2",
                    "Attack on Titan Season 3 Part 2",
                    Some("2019"),
                    Some("sequel"),
                ),
                relation(
                    "kitsu:3",
                    "Attack on Titan Junior High",
                    Some("2015"),
                    Some("side_story"),
                ),
                relation("kitsu:4", "One Piece", Some("1999"), Some("sequel")),
            ]),
        };

        let normalized = normalize_media_details(details);
        let relations = normalized.relations.expect("relations should remain");

        assert_eq!(normalized.primary_year, Some(2013));
        assert_eq!(normalized.display_year.as_deref(), Some("2013"));
        assert_eq!(normalized.release_date.as_deref(), Some("2013-04-07"));
        assert_eq!(
            normalized
                .episodes
                .as_ref()
                .and_then(|episodes| episodes.first())
                .and_then(|episode| episode.release_date.as_deref()),
            Some("2013-04-07")
        );
        assert_eq!(
            normalized
                .season_years
                .as_ref()
                .and_then(|season_years| season_years.get(&1))
                .map(String::as_str),
            Some("2013-2014")
        );
        assert_eq!(relations.len(), 2);
        assert_eq!(relations[0].id, "kitsu:2");
        assert_eq!(
            relations[0].relation_context_label.as_deref(),
            Some("Season 3 Part 2 • 2019")
        );
        assert_eq!(relations[1].id, "kitsu:3");
    }

    #[test]
    fn build_release_date_prefers_explicit_date_and_falls_back_to_year_start() {
        assert_eq!(
            build_release_date(Some("Premiered 2024-10-05 on TV")).as_deref(),
            Some("2024-10-05")
        );
        assert_eq!(
            build_release_date(Some("2024")).as_deref(),
            Some("2024-01-01")
        );
        assert_eq!(build_release_date(Some("Unknown")), None);
    }

    #[test]
    fn normalize_episode_metadata_list_sets_episode_release_dates() {
        let episodes = normalize_episode_metadata_list(vec![Episode {
            id: "ep-1".to_string(),
            title: Some("Episode 1".to_string()),
            season: 1,
            episode: 1,
            released: Some("2024".to_string()),
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
        }]);

        assert_eq!(episodes[0].release_date.as_deref(), Some("2024-01-01"));
    }
}
