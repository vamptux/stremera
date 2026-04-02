use super::language::{canonicalize_language_token, tokenize_language_meta};
use super::playback_state::PlaybackStateService;
use super::streaming_helpers::{stream_resolution_priority, stream_source_priority};
use crate::providers::addons::{
    stream_episode_match_kind, stream_quality_score, StreamEpisodeMatchKind, TorrentioStream,
};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

const DEFAULT_SOURCE_HEALTH_PRIORITY: u8 = 2;
const DEFAULT_STREAM_FAMILY_PRIORITY: u8 = 2;
const DEFAULT_TITLE_SOURCE_AFFINITY_PRIORITY: u8 = 0;
const TITLE_STOP_WORDS: &[&str] = &["a", "an", "and", "of", "on", "the", "to"];
const TITLE_NEUTRAL_EXTRA_TOKENS: &[&str] = &[
    "arc",
    "batch",
    "chapter",
    "collection",
    "complete",
    "cour",
    "cut",
    "directors",
    "dub",
    "dubbed",
    "dual",
    "extended",
    "final",
    "multi",
    "pack",
    "part",
    "season",
    "sub",
    "subbed",
    "uncut",
    "volume",
    "vol",
];
const TITLE_SPINOFF_TOKENS: &[&str] = &[
    "anthology",
    "chibi",
    "junior",
    "musical",
    "ona",
    "ova",
    "parody",
    "picture",
    "recap",
    "short",
    "shorts",
    "special",
    "specials",
    "spinoff",
];
const TITLE_BOUNDARY_TOKENS: &[&str] = &[
    "10bit", "aac", "ac3", "amzn", "atmos", "av1", "bluray", "bdrip", "ddp", "dsnp", "dts", "dv",
    "h264", "h265", "hdtv", "hevc", "hulu", "mkv", "mp4", "nf", "proper", "repack", "remux",
    "webrip", "web", "webdl", "x264", "x265",
];

#[derive(Clone, Copy)]
pub(crate) struct StreamMatchContext<'a> {
    pub media_type: &'a str,
    pub title: Option<&'a str>,
    pub query_season: Option<u32>,
    pub query_episode: Option<u32>,
    pub canonical_season: Option<u32>,
    pub canonical_episode: Option<u32>,
}

#[derive(Clone, Copy)]
pub(crate) struct StreamRecommendationInputs<'a> {
    pub addon_source_priorities: &'a HashMap<String, u32>,
    pub source_health_priorities: &'a HashMap<String, u8>,
    pub stream_family_priorities: &'a HashMap<String, u8>,
    pub title_source_affinities: &'a HashMap<String, u8>,
    pub match_context: StreamMatchContext<'a>,
    pub preferred_audio_language: Option<&'a str>,
    pub preferred_subtitle_language: Option<&'a str>,
}

fn normalize_source_name(source_name: &str) -> Option<String> {
    let trimmed = source_name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn stream_language_haystack(stream: &TorrentioStream) -> String {
    format!(
        "{} {}",
        stream.name.as_deref().unwrap_or(""),
        stream.title.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase()
}

fn stream_language_tokens(stream: &TorrentioStream) -> HashSet<String> {
    let mut tokens = HashSet::new();

    for token in tokenize_language_meta(&stream_language_haystack(stream)) {
        if let Some(canonical) = canonicalize_language_token(&token) {
            tokens.insert(canonical.to_string());
        } else {
            tokens.insert(token);
        }
    }

    tokens
}

fn stream_language_preference_priority(
    stream: &TorrentioStream,
    preferred_audio_language: Option<&str>,
    preferred_subtitle_language: Option<&str>,
) -> u8 {
    let preferred_audio_language = preferred_audio_language.and_then(canonicalize_language_token);
    let preferred_subtitle_language = preferred_subtitle_language.and_then(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            None
        } else if normalized == "off" {
            Some("off")
        } else {
            canonicalize_language_token(&normalized)
        }
    });

    if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
        return 0;
    }

    let haystack = stream_language_haystack(stream);
    let language_tokens = stream_language_tokens(stream);
    let raw_tokens = tokenize_language_meta(&haystack)
        .into_iter()
        .collect::<HashSet<_>>();
    let has_dual_audio = [
        "dual audio",
        "dual-audio",
        "dub + sub",
        "sub + dub",
        "dubbed/subbed",
    ]
    .iter()
    .any(|marker| haystack.contains(marker));
    let has_multi_audio = ["multi audio", "multi-audio", "multiaudio"]
        .iter()
        .any(|marker| haystack.contains(marker));
    let has_multi_sub = ["multi sub", "multi-sub", "multisub", "multi subtitle"]
        .iter()
        .any(|marker| haystack.contains(marker));
    let has_dub = raw_tokens.contains("dub") || raw_tokens.contains("dubbed");
    let has_subtitle_hint = raw_tokens.contains("sub")
        || raw_tokens.contains("subbed")
        || raw_tokens.contains("subtitle")
        || raw_tokens.contains("subtitles");
    let mut score = 0;

    if let Some(preferred_audio_language) = preferred_audio_language {
        if language_tokens.contains(preferred_audio_language) {
            score += 4;
        } else if preferred_audio_language == "en" && has_dub {
            score += 3;
        } else if has_dual_audio || has_multi_audio {
            score += 2;
        }
    }

    match preferred_subtitle_language {
        Some("off") => {
            if has_dub || has_dual_audio || has_multi_audio {
                score += 2;
            }
        }
        Some(preferred_subtitle_language) => {
            if language_tokens.contains(preferred_subtitle_language) {
                score += 3;
            } else if has_multi_sub || has_dual_audio || has_multi_audio || has_subtitle_hint {
                score += 1;
            }
        }
        _ => {}
    }

    score.min(6)
}

fn stream_source_health_priority(
    stream: &TorrentioStream,
    source_health_priorities: &HashMap<String, u8>,
) -> u8 {
    stream
        .source_name
        .as_deref()
        .and_then(normalize_source_name)
        .and_then(|source_name| source_health_priorities.get(&source_name).copied())
        .unwrap_or(DEFAULT_SOURCE_HEALTH_PRIORITY)
}

fn stream_family_priority(
    stream: &TorrentioStream,
    stream_family_priorities: &HashMap<String, u8>,
) -> u8 {
    stream
        .stream_family
        .as_deref()
        .and_then(normalize_source_name)
        .and_then(|stream_family| stream_family_priorities.get(&stream_family).copied())
        .unwrap_or(DEFAULT_STREAM_FAMILY_PRIORITY)
}

fn stream_title_source_affinity_priority(
    stream: &TorrentioStream,
    title_source_affinities: &HashMap<String, u8>,
) -> u8 {
    stream
        .source_name
        .as_deref()
        .and_then(normalize_source_name)
        .and_then(|source_name| title_source_affinities.get(&source_name).copied())
        .unwrap_or(DEFAULT_TITLE_SOURCE_AFFINITY_PRIORITY)
}

fn is_title_stop_word(token: &str) -> bool {
    TITLE_STOP_WORDS.contains(&token)
}

fn is_resolution_token(token: &str) -> bool {
    token
        .strip_suffix('p')
        .and_then(|value| value.parse::<u16>().ok())
        .is_some_and(|value| matches!(value, 480 | 576 | 720 | 1080 | 1440 | 2160))
}

fn is_episode_token(token: &str) -> bool {
    token.split_once('x').is_some_and(|(season, episode)| {
        !season.is_empty()
            && !episode.is_empty()
            && season.chars().all(|ch| ch.is_ascii_digit())
            && episode.chars().all(|ch| ch.is_ascii_digit())
    }) || (token.starts_with('s')
        && token.contains('e')
        && token.chars().skip(1).any(|ch| ch.is_ascii_digit()))
}

fn is_title_boundary_token(token: &str) -> bool {
    TITLE_BOUNDARY_TOKENS.contains(&token)
        || is_resolution_token(token)
        || is_episode_token(token)
        || matches!(token, "ep" | "episode")
}

fn tokenize_title_words(value: &str, stop_at_boundary: bool) -> Vec<String> {
    let normalized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();

    let mut words = Vec::new();
    for token in normalized.split_whitespace() {
        if stop_at_boundary && is_title_boundary_token(token) {
            break;
        }

        if token.len() == 1 && !token.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }

        words.push(token.to_string());
        if words.len() >= 12 {
            break;
        }
    }

    words
}

fn build_title_token_set(words: &[String]) -> HashSet<String> {
    words
        .iter()
        .filter(|word| !is_title_stop_word(word))
        .cloned()
        .collect()
}

fn build_title_initialism(words: &[String]) -> Option<String> {
    let initialism: String = words
        .iter()
        .filter(|word| !is_title_stop_word(word))
        .filter(|word| word.chars().all(|ch| ch.is_ascii_alphabetic()))
        .filter_map(|word| word.chars().next())
        .collect();

    (3..=6).contains(&initialism.len()).then_some(initialism)
}

fn is_neutral_title_extra(token: &str, media_type: &str) -> bool {
    is_title_stop_word(token)
        || TITLE_NEUTRAL_EXTRA_TOKENS.contains(&token)
        || token.chars().all(|ch| ch.is_ascii_digit())
        || (media_type == "movie" && matches!(token, "movie" | "film"))
}

fn is_spin_off_title_extra(token: &str, media_type: &str) -> bool {
    TITLE_SPINOFF_TOKENS.contains(&token)
        || (media_type != "movie" && matches!(token, "movie" | "film"))
}

fn stream_episode_relevance_priority(
    stream: &TorrentioStream,
    context: StreamMatchContext<'_>,
) -> StreamEpisodeMatchKind {
    let mut best_match = StreamEpisodeMatchKind::None;

    for (season, episode) in [
        (context.query_season, context.query_episode),
        (context.canonical_season, context.canonical_episode),
    ] {
        if let (Some(season), Some(episode)) = (season, episode) {
            best_match = best_match.max(stream_episode_match_kind(stream, season, episode));
        }
    }

    best_match
}

fn stream_title_relevance_priority(
    stream: &TorrentioStream,
    context: StreamMatchContext<'_>,
) -> i8 {
    let Some(title) = context
        .title
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return 0;
    };

    let reference_words = tokenize_title_words(title, false);
    let reference_tokens = build_title_token_set(&reference_words);
    if reference_tokens.is_empty() {
        return 0;
    }

    let reference_initialism = build_title_initialism(&reference_words);
    let mut best_score = 0;

    for candidate in [
        stream.name.as_deref(),
        stream.title.as_deref(),
        stream
            .behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        let candidate_words = tokenize_title_words(candidate, true);
        let candidate_tokens = build_title_token_set(&candidate_words);
        if candidate_tokens.is_empty() {
            continue;
        }

        let overlap_count = candidate_tokens.intersection(&reference_tokens).count();
        let initialism_match = reference_initialism
            .as_deref()
            .is_some_and(|initialism| candidate_tokens.contains(initialism));

        if overlap_count == 0 && !initialism_match {
            continue;
        }

        let mut score = if overlap_count >= reference_tokens.len() {
            4
        } else if overlap_count * 3 >= reference_tokens.len() * 2 {
            3
        } else {
            2
        };

        if initialism_match {
            score = score.max(2);
        }

        let has_spin_off_marker = candidate_tokens.iter().any(|token| {
            !reference_tokens.contains(token) && is_spin_off_title_extra(token, context.media_type)
        });
        let significant_extra_count = candidate_tokens
            .iter()
            .filter(|token| !reference_tokens.contains(*token))
            .filter(|token| reference_initialism.as_deref() != Some(token.as_str()))
            .filter(|token| !is_neutral_title_extra(token, context.media_type))
            .count();

        if has_spin_off_marker {
            score -= 5;
        } else if significant_extra_count > 0 && reference_tokens.len() <= 2 {
            score -= 2;
        } else if significant_extra_count > 1 {
            score -= 1;
        }

        best_score = best_score.max(score);
    }

    best_score
}

fn compare_stream_recommendation(
    left: &TorrentioStream,
    right: &TorrentioStream,
    inputs: &StreamRecommendationInputs<'_>,
) -> Ordering {
    let left_episode_match = stream_episode_relevance_priority(left, inputs.match_context);
    let right_episode_match = stream_episode_relevance_priority(right, inputs.match_context);
    let left_title_match = stream_title_relevance_priority(left, inputs.match_context);
    let right_title_match = stream_title_relevance_priority(right, inputs.match_context);
    let left_health = stream_source_health_priority(left, inputs.source_health_priorities);
    let right_health = stream_source_health_priority(right, inputs.source_health_priorities);
    let left_family = stream_family_priority(left, inputs.stream_family_priorities);
    let right_family = stream_family_priority(right, inputs.stream_family_priorities);
    let left_title_source =
        stream_title_source_affinity_priority(left, inputs.title_source_affinities);
    let right_title_source =
        stream_title_source_affinity_priority(right, inputs.title_source_affinities);
    let left_language = stream_language_preference_priority(
        left,
        inputs.preferred_audio_language,
        inputs.preferred_subtitle_language,
    );
    let right_language = stream_language_preference_priority(
        right,
        inputs.preferred_audio_language,
        inputs.preferred_subtitle_language,
    );
    let left_priority = stream_resolution_priority(
        left,
        stream_source_priority(left, inputs.addon_source_priorities),
    );
    let right_priority = stream_resolution_priority(
        right,
        stream_source_priority(right, inputs.addon_source_priorities),
    );

    right_episode_match
        .cmp(&left_episode_match)
        .then_with(|| right_title_match.cmp(&left_title_match))
        .then_with(|| right_health.cmp(&left_health))
        .then_with(|| right_family.cmp(&left_family))
        .then_with(|| right_title_source.cmp(&left_title_source))
        .then_with(|| right_language.cmp(&left_language))
        .then_with(|| right_priority.cmp(&left_priority))
}

fn recommendation_reasons(
    stream: &TorrentioStream,
    inputs: &StreamRecommendationInputs<'_>,
) -> Vec<String> {
    let mut reasons = Vec::with_capacity(5);
    let episode_match = stream_episode_relevance_priority(stream, inputs.match_context);
    let title_match = stream_title_relevance_priority(stream, inputs.match_context);
    let health_priority = stream_source_health_priority(stream, inputs.source_health_priorities);
    let family_priority = stream_family_priority(stream, inputs.stream_family_priorities);
    let title_source_affinity =
        stream_title_source_affinity_priority(stream, inputs.title_source_affinities);
    let language_priority = stream_language_preference_priority(
        stream,
        inputs.preferred_audio_language,
        inputs.preferred_subtitle_language,
    );
    let source_priority = stream_source_priority(stream, inputs.addon_source_priorities);
    let quality_score = stream_quality_score(stream);
    let is_direct_http = stream
        .url
        .as_deref()
        .is_some_and(|value| value.starts_with("http://") || value.starts_with("https://"));

    match episode_match {
        StreamEpisodeMatchKind::Exact => reasons.push("Exact episode match".to_string()),
        StreamEpisodeMatchKind::EpisodeRange => reasons.push("Batch includes episode".to_string()),
        StreamEpisodeMatchKind::SeasonPack => reasons.push("Season pack".to_string()),
        StreamEpisodeMatchKind::None => {}
    }

    if title_match >= 4 {
        reasons.push("Close title match".to_string());
    } else if title_match >= 2 {
        reasons.push("Title match".to_string());
    }

    match health_priority {
        3 => reasons.push("Verified source".to_string()),
        1 => reasons.push("Recent source issues".to_string()),
        0 => reasons.push("Source cooling down".to_string()),
        _ => {}
    }

    match family_priority {
        4 => reasons.push("Proven release group".to_string()),
        1 => reasons.push("Release group had issues".to_string()),
        0 => reasons.push("Release group cooling down".to_string()),
        _ => {}
    }

    match title_source_affinity {
        3 => reasons.push("Previously worked on this title".to_string()),
        2 => reasons.push("Recently used source".to_string()),
        _ => {}
    }

    if language_priority >= 4 {
        reasons.push("Matches language prefs".to_string());
    } else if language_priority >= 2 {
        reasons.push("Flexible audio/subs".to_string());
    }

    if stream.cached {
        reasons.push("Debrid cached".to_string());
    } else if is_direct_http {
        reasons.push("Direct HTTP".to_string());
    }

    if quality_score >= 400 {
        reasons.push("Top quality".to_string());
    } else if quality_score >= 250 {
        reasons.push("Good quality".to_string());
    }

    if source_priority > 0 {
        reasons.push("Preferred source".to_string());
    }

    if reasons.is_empty() {
        reasons.push("Fallback".to_string());
    }

    reasons.truncate(3);
    reasons
}

pub(crate) fn build_source_health_priorities(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    streams: &[TorrentioStream],
) -> HashMap<String, u8> {
    let mut priorities = HashMap::new();

    for source_name in streams
        .iter()
        .filter_map(|stream| stream.source_name.as_deref())
        .filter_map(normalize_source_name)
    {
        if priorities.contains_key(&source_name) {
            continue;
        }

        let priority = playback_state
            .source_health_priority(app, Some(&source_name))
            .unwrap_or(DEFAULT_SOURCE_HEALTH_PRIORITY);
        priorities.insert(source_name, priority);
    }

    priorities
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_stream_family_priorities(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
    streams: &[TorrentioStream],
) -> HashMap<String, u8> {
    let mut priorities = HashMap::new();

    for stream_family in streams
        .iter()
        .filter_map(|stream| stream.stream_family.as_deref())
        .filter_map(normalize_source_name)
    {
        if priorities.contains_key(&stream_family) {
            continue;
        }

        let priority = playback_state
            .stream_family_priority(
                app,
                media_id,
                media_type,
                season,
                episode,
                Some(&stream_family),
            )
            .unwrap_or(DEFAULT_STREAM_FAMILY_PRIORITY);
        priorities.insert(stream_family, priority);
    }

    priorities
}

pub(crate) fn build_title_source_affinities(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_id: &str,
    media_type: &str,
    streams: &[TorrentioStream],
) -> HashMap<String, u8> {
    let mut priorities = HashMap::new();

    for source_name in streams
        .iter()
        .filter_map(|stream| stream.source_name.as_deref())
        .filter_map(normalize_source_name)
    {
        if priorities.contains_key(&source_name) {
            continue;
        }

        let priority = playback_state
            .title_source_affinity_priority(app, media_id, media_type, Some(&source_name))
            .unwrap_or(DEFAULT_TITLE_SOURCE_AFFINITY_PRIORITY);
        priorities.insert(source_name, priority);
    }

    priorities
}

pub(crate) fn sort_streams_by_recommendation(
    streams: &mut [TorrentioStream],
    inputs: StreamRecommendationInputs<'_>,
) {
    streams.sort_by(|left, right| compare_stream_recommendation(left, right, &inputs));

    for stream in streams.iter_mut() {
        stream.recommendation_reasons = recommendation_reasons(stream, &inputs);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compare_stream_recommendation, recommendation_reasons, StreamMatchContext,
        StreamRecommendationInputs, DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
    };
    use crate::providers::addons::{StreamPresentation, TorrentioStream};
    use std::collections::HashMap;

    fn build_stream(
        source_name: &str,
        cached: bool,
        url: Option<&str>,
        size_bytes: u64,
    ) -> TorrentioStream {
        TorrentioStream {
            name: Some("1080p Release".to_string()),
            title: Some("2.0 GB".to_string()),
            info_hash: if url.is_none() {
                Some("abc123".to_string())
            } else {
                None
            },
            url: url.map(|value| value.to_string()),
            file_idx: None,
            behavior_hints: None,
            cached,
            seeders: Some(100),
            size_bytes: Some(size_bytes),
            source_name: Some(source_name.to_string()),
            stream_family: Some(format!("{}|release:test", source_name.to_ascii_lowercase())),
            stream_key: String::new(),
            recommendation_reasons: Vec::new(),
            presentation: StreamPresentation::default(),
        }
    }

    fn no_match_context() -> StreamMatchContext<'static> {
        StreamMatchContext {
            media_type: "series",
            title: None,
            query_season: None,
            query_episode: None,
            canonical_season: None,
            canonical_episode: None,
        }
    }

    fn episode_match_context(
        title: &'static str,
        season: u32,
        episode: u32,
    ) -> StreamMatchContext<'static> {
        StreamMatchContext {
            media_type: "series",
            title: Some(title),
            query_season: Some(season),
            query_episode: Some(episode),
            canonical_season: Some(season),
            canonical_episode: Some(episode),
        }
    }

    fn recommendation_inputs<'a>(
        addon_priorities: &'a HashMap<String, u32>,
        source_health: &'a HashMap<String, u8>,
        stream_family_priorities: &'a HashMap<String, u8>,
        title_source_affinities: &'a HashMap<String, u8>,
        match_context: StreamMatchContext<'a>,
        preferred_audio_language: Option<&'a str>,
        preferred_subtitle_language: Option<&'a str>,
    ) -> StreamRecommendationInputs<'a> {
        StreamRecommendationInputs {
            addon_source_priorities: addon_priorities,
            source_health_priorities: source_health,
            stream_family_priorities,
            title_source_affinities,
            match_context,
            preferred_audio_language,
            preferred_subtitle_language,
        }
    }

    #[test]
    fn recommendation_prefers_healthier_source_with_same_viability() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), 0),
        ]);
        let stream_family_priorities = HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let alpha = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_500);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &stream_family_priorities,
                    &HashMap::new(),
                    no_match_context(),
                    None,
                    None,
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_prefers_recently_successful_stream_family_when_health_is_tied() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]);
        let family_health = HashMap::from([
            ("alpha|release:test".to_string(), 4),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let alpha = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &family_health,
                    &HashMap::new(),
                    no_match_context(),
                    None,
                    None,
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_prefers_recent_title_source_when_other_inputs_are_tied() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]);
        let stream_family_priorities = HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let title_affinity = HashMap::from([("alpha".to_string(), 3), ("beta".to_string(), 0)]);
        let alpha = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &stream_family_priorities,
                    &title_affinity,
                    no_match_context(),
                    None,
                    None,
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_prefers_exact_episode_over_batch_range() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]);
        let stream_family_priorities = HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let mut exact = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        exact.name = Some("One Piece S01E08 1080p".to_string());

        let mut batch = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);
        batch.name = Some("One Piece S01E01-E12 Batch 1080p".to_string());

        assert_eq!(
            compare_stream_recommendation(
                &exact,
                &batch,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &stream_family_priorities,
                    &HashMap::new(),
                    episode_match_context("One Piece", 1, 8),
                    None,
                    None,
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_demotes_spinoff_title_even_with_matching_episode() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]);
        let stream_family_priorities = HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let mut mainline = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        mainline.name = Some("Attack on Titan S01E03 1080p".to_string());

        let mut spinoff =
            build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);
        spinoff.name = Some("Attack on Titan Junior High S01E03 1080p".to_string());

        assert_eq!(
            compare_stream_recommendation(
                &mainline,
                &spinoff,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &stream_family_priorities,
                    &HashMap::new(),
                    episode_match_context("Attack on Titan", 1, 3),
                    None,
                    None,
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_prefers_language_matching_stream_when_other_inputs_are_tied() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]);
        let stream_family_priorities = HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]);
        let mut japanese = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        japanese.name = Some("[JA] Dual Audio 1080p".to_string());

        let mut dubbed = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);
        dubbed.name = Some("English Dub 1080p".to_string());

        assert_eq!(
            compare_stream_recommendation(
                &japanese,
                &dubbed,
                &recommendation_inputs(
                    &addon_priorities,
                    &source_health,
                    &stream_family_priorities,
                    &HashMap::new(),
                    no_match_context(),
                    Some("ja"),
                    Some("off"),
                ),
            ),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn recommendation_reasons_include_title_source_and_language_context() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1)]);
        let source_health = HashMap::from([("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY)]);
        let stream_family_priorities = HashMap::from([(
            "alpha|release:test".to_string(),
            DEFAULT_STREAM_FAMILY_PRIORITY,
        )]);
        let title_affinity = HashMap::from([("alpha".to_string(), 3)]);
        let mut stream = build_stream(
            "alpha",
            true,
            Some("https://alpha.example/video.m3u8"),
            2_000,
        );
        stream.name = Some("[JA] Dual Audio 1080p".to_string());

        let reasons = recommendation_reasons(
            &stream,
            &recommendation_inputs(
                &addon_priorities,
                &source_health,
                &stream_family_priorities,
                &title_affinity,
                no_match_context(),
                Some("ja"),
                Some("off"),
            ),
        );

        assert!(reasons
            .iter()
            .any(|reason| reason.contains("Previously worked on this title")));
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("language prefs"))
                || reasons
                    .iter()
                    .any(|reason| reason.contains("Flexible audio/subs"))
        );
    }
}
