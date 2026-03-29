use super::playback_state::PlaybackStateService;
use super::streaming_helpers::{stream_resolution_priority, stream_source_priority};
use crate::providers::stremio_addon::{stream_quality_score, TorrentioStream};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

const DEFAULT_SOURCE_HEALTH_PRIORITY: u8 = 2;
const DEFAULT_STREAM_FAMILY_PRIORITY: u8 = 2;
const DEFAULT_TITLE_SOURCE_AFFINITY_PRIORITY: u8 = 0;

#[derive(Clone, Copy)]
struct PlaybackLanguagePreferenceView<'a> {
    preferred_audio_language: Option<&'a str>,
    preferred_subtitle_language: Option<&'a str>,
}

fn normalize_source_name(source_name: &str) -> Option<String> {
    let trimmed = source_name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn canonicalize_language_token(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "en" | "eng" | "english" => Some("en"),
        "ja" | "jpn" | "japanese" => Some("ja"),
        "es" | "spa" | "spanish" => Some("es"),
        "fr" | "fra" | "fre" | "french" => Some("fr"),
        "de" | "deu" | "ger" | "german" => Some("de"),
        "it" | "ita" | "italian" => Some("it"),
        "pt" | "por" | "portuguese" => Some("pt"),
        "ko" | "kor" | "korean" => Some("ko"),
        "zh" | "zho" | "chi" | "chinese" => Some("zh"),
        _ => None,
    }
}

fn tokenize_language_meta(value: &str) -> Vec<String> {
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

    normalized
        .split_whitespace()
        .map(str::to_string)
        .collect()
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
    let has_dual_audio = ["dual audio", "dual-audio", "dub + sub", "sub + dub", "dubbed/subbed"]
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

fn compare_stream_recommendation(
    left: &TorrentioStream,
    right: &TorrentioStream,
    addon_source_priorities: &HashMap<String, u32>,
    source_health_priorities: &HashMap<String, u8>,
    stream_family_priorities: &HashMap<String, u8>,
    title_source_affinities: &HashMap<String, u8>,
    language_preferences: PlaybackLanguagePreferenceView<'_>,
) -> Ordering {
    let left_health = stream_source_health_priority(left, source_health_priorities);
    let right_health = stream_source_health_priority(right, source_health_priorities);
    let left_family = stream_family_priority(left, stream_family_priorities);
    let right_family = stream_family_priority(right, stream_family_priorities);
    let left_title_source = stream_title_source_affinity_priority(left, title_source_affinities);
    let right_title_source = stream_title_source_affinity_priority(right, title_source_affinities);
    let left_language = stream_language_preference_priority(
        left,
        language_preferences.preferred_audio_language,
        language_preferences.preferred_subtitle_language,
    );
    let right_language = stream_language_preference_priority(
        right,
        language_preferences.preferred_audio_language,
        language_preferences.preferred_subtitle_language,
    );
    let left_priority =
        stream_resolution_priority(left, stream_source_priority(left, addon_source_priorities));
    let right_priority = stream_resolution_priority(
        right,
        stream_source_priority(right, addon_source_priorities),
    );

    right_health
        .cmp(&left_health)
        .then_with(|| right_family.cmp(&left_family))
        .then_with(|| right_title_source.cmp(&left_title_source))
        .then_with(|| right_language.cmp(&left_language))
        .then_with(|| right_priority.cmp(&left_priority))
}

fn recommendation_reasons(
    stream: &TorrentioStream,
    addon_source_priorities: &HashMap<String, u32>,
    source_health_priorities: &HashMap<String, u8>,
    stream_family_priorities: &HashMap<String, u8>,
    title_source_affinities: &HashMap<String, u8>,
    language_preferences: PlaybackLanguagePreferenceView<'_>,
) -> Vec<String> {
    let mut reasons = Vec::with_capacity(5);
    let health_priority = stream_source_health_priority(stream, source_health_priorities);
    let family_priority = stream_family_priority(stream, stream_family_priorities);
    let title_source_affinity =
        stream_title_source_affinity_priority(stream, title_source_affinities);
    let language_priority = stream_language_preference_priority(
        stream,
        language_preferences.preferred_audio_language,
        language_preferences.preferred_subtitle_language,
    );
    let source_priority = stream_source_priority(stream, addon_source_priorities);
    let quality_score = stream_quality_score(stream);
    let is_direct_http = stream
        .url
        .as_deref()
        .is_some_and(|value| value.starts_with("http://") || value.starts_with("https://"));

    if stream.cached {
        reasons.push("Debrid cached for faster startup".to_string());
    } else if is_direct_http {
        reasons.push("Direct stream with no torrent handoff".to_string());
    }

    if quality_score >= 400 {
        reasons.push("Top quality match from the current ranking".to_string());
    } else if quality_score >= 250 {
        reasons.push("Strong quality match".to_string());
    }

    match health_priority {
        3 => reasons.push("Source has recent successful playback history".to_string()),
        1 => reasons.push("Source is slightly de-prioritized by recent failures".to_string()),
        0 => reasons.push("Source is cooling down after repeated failures".to_string()),
        _ => {}
    }

    match family_priority {
        4 => reasons.push("Matches a recently successful release family for nearby episodes".to_string()),
        1 => reasons.push("Release family recently stumbled on a nearby episode".to_string()),
        0 => reasons.push("Release family is cooling down after a nearby failure".to_string()),
        _ => {}
    }

    match title_source_affinity {
        3 => reasons.push("Matches the source that recently succeeded on this title".to_string()),
        2 => reasons.push("Matches a source you recently used on this title".to_string()),
        _ => {}
    }

    if language_priority >= 4 {
        reasons.push("Matches your playback language preferences".to_string());
    } else if language_priority >= 2 {
        reasons.push("Looks flexible for your audio and subtitle preferences".to_string());
    }

    if source_priority > 0 {
        reasons.push("Matches your preferred source order".to_string());
    }

    if reasons.is_empty() {
        reasons.push("Playable fallback candidate".to_string());
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
    addon_source_priorities: &HashMap<String, u32>,
    source_health_priorities: &HashMap<String, u8>,
    stream_family_priorities: &HashMap<String, u8>,
    title_source_affinities: &HashMap<String, u8>,
    preferred_audio_language: Option<&str>,
    preferred_subtitle_language: Option<&str>,
) {
    let language_preferences = PlaybackLanguagePreferenceView {
        preferred_audio_language,
        preferred_subtitle_language,
    };

    streams.sort_by(|left, right| {
        compare_stream_recommendation(
            left,
            right,
            addon_source_priorities,
            source_health_priorities,
            stream_family_priorities,
            title_source_affinities,
            language_preferences,
        )
    });

    for stream in streams.iter_mut() {
        stream.recommendation_reasons = recommendation_reasons(
            stream,
            addon_source_priorities,
            source_health_priorities,
            stream_family_priorities,
            title_source_affinities,
            language_preferences,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compare_stream_recommendation, recommendation_reasons,
        PlaybackLanguagePreferenceView, DEFAULT_SOURCE_HEALTH_PRIORITY,
        DEFAULT_STREAM_FAMILY_PRIORITY,
    };
    use crate::providers::stremio_addon::TorrentioStream;
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
            recommendation_reasons: Vec::new(),
        }
    }

    fn no_language_preferences() -> PlaybackLanguagePreferenceView<'static> {
        PlaybackLanguagePreferenceView {
            preferred_audio_language: None,
            preferred_subtitle_language: None,
        }
    }

    #[test]
    fn recommendation_prefers_healthier_source_with_same_viability() {
        let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
        let source_health = HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), 0),
        ]);
        let alpha = build_stream("alpha", true, Some("https://alpha.example/video.m3u8"), 2_000);
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_500);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &addon_priorities,
                &source_health,
                &HashMap::from([
                    ("alpha|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                    ("beta|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                ]),
                &HashMap::new(),
                no_language_preferences(),
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
            ("beta|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
        ]);
        let alpha = build_stream("alpha", true, Some("https://alpha.example/video.m3u8"), 2_000);
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &addon_priorities,
                &source_health,
                &family_health,
                &HashMap::new(),
                no_language_preferences(),
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
        let title_affinity = HashMap::from([("alpha".to_string(), 3), ("beta".to_string(), 0)]);
        let alpha = build_stream("alpha", true, Some("https://alpha.example/video.m3u8"), 2_000);
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);

        assert_eq!(
            compare_stream_recommendation(
                &alpha,
                &beta,
                &addon_priorities,
                &source_health,
                &HashMap::from([
                    ("alpha|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                    ("beta|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                ]),
                &title_affinity,
                no_language_preferences(),
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
        let mut japanese =
            build_stream("alpha", true, Some("https://alpha.example/video.m3u8"), 2_000);
        japanese.name = Some("[JA] Dual Audio 1080p".to_string());

        let mut dubbed =
            build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_000);
        dubbed.name = Some("English Dub 1080p".to_string());

        assert_eq!(
            compare_stream_recommendation(
                &japanese,
                &dubbed,
                &addon_priorities,
                &source_health,
                &HashMap::from([
                    ("alpha|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                    ("beta|release:test".to_string(), DEFAULT_STREAM_FAMILY_PRIORITY),
                ]),
                &HashMap::new(),
                PlaybackLanguagePreferenceView {
                    preferred_audio_language: Some("ja"),
                    preferred_subtitle_language: Some("off"),
                },
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
        let mut stream =
            build_stream("alpha", true, Some("https://alpha.example/video.m3u8"), 2_000);
        stream.name = Some("[JA] Dual Audio 1080p".to_string());

        let reasons = recommendation_reasons(
            &stream,
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            &title_affinity,
            PlaybackLanguagePreferenceView {
                preferred_audio_language: Some("ja"),
                preferred_subtitle_language: Some("off"),
            },
        );

        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("recently succeeded on this title"))
        );
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("playback language preferences"))
                || reasons
                    .iter()
                    .any(|reason| reason.contains("audio and subtitle preferences"))
        );
    }
}
