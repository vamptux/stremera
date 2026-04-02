use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguageCandidate {
    pub id: i64,
    pub lang: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub default_track: bool,
    #[serde(default)]
    pub forced: bool,
    #[serde(default)]
    pub hearing_impaired: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguageSelectionResolution {
    pub normalized_preferred_language: Option<String>,
    pub selected_matches: bool,
    pub matched_track_id: Option<i64>,
}

pub(crate) fn canonicalize_language_token(value: &str) -> Option<&'static str> {
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

fn language_aliases(canonical: &str) -> &'static [&'static str] {
    match canonical {
        "en" => &["en", "eng", "english"],
        "ja" => &["ja", "jpn", "japanese"],
        "es" => &["es", "spa", "spanish"],
        "fr" => &["fr", "fra", "fre", "french"],
        "de" => &["de", "deu", "ger", "german"],
        "it" => &["it", "ita", "italian"],
        "pt" => &["pt", "por", "portuguese"],
        "ko" => &["ko", "kor", "korean"],
        "zh" => &["zh", "zho", "chi", "chinese"],
        _ => &[],
    }
}

fn normalize_lower(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if value.is_empty() || values.iter().any(|existing| existing == value) {
        return;
    }

    values.push(value.to_string());
}

pub(crate) fn tokenize_language_meta(value: &str) -> Vec<String> {
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

    normalized.split_whitespace().map(str::to_string).collect()
}

pub(crate) fn normalize_language_token(value: Option<&str>, allow_off: bool) -> Option<String> {
    let normalized = normalize_lower(value)?;

    if allow_off && normalized == "off" {
        return Some(normalized);
    }

    if let Some(canonical) = canonicalize_language_token(&normalized) {
        return Some(canonical.to_string());
    }

    tokenize_language_meta(&normalized)
        .into_iter()
        .find_map(|token| canonicalize_language_token(&token).map(str::to_string))
}

pub(crate) fn language_candidates(preferred: &str) -> Vec<String> {
    let normalized = preferred.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }

    let canonical =
        normalize_language_token(Some(&normalized), false).unwrap_or_else(|| normalized.clone());
    let mut candidates = Vec::new();

    push_unique(&mut candidates, &canonical);
    push_unique(&mut candidates, &normalized);

    for alias in language_aliases(&canonical) {
        push_unique(&mut candidates, alias);
    }

    for token in tokenize_language_meta(&normalized) {
        if let Some(token_canonical) = canonicalize_language_token(&token) {
            push_unique(&mut candidates, token_canonical);

            for alias in language_aliases(token_canonical) {
                push_unique(&mut candidates, alias);
            }
        }
    }

    candidates
}

fn contains_token(tokens: &[String], needle: &str) -> bool {
    tokens.iter().any(|token| token == needle)
}

fn contains_any_token(tokens: &[String], needles: &[&str]) -> bool {
    needles.iter().any(|needle| contains_token(tokens, needle))
}

fn contains_phrase(tokens: &[String], phrase: &[&str]) -> bool {
    if phrase.is_empty() || tokens.len() < phrase.len() {
        return false;
    }

    tokens
        .windows(phrase.len())
        .any(|window| window.iter().map(String::as_str).eq(phrase.iter().copied()))
}

fn track_language_score(track: &TrackLanguageCandidate, candidates: &[String]) -> i32 {
    let lang = normalize_lower(track.lang.as_deref()).unwrap_or_default();
    let lang_tokens = track
        .lang
        .as_deref()
        .map(tokenize_language_meta)
        .unwrap_or_default();
    let title_tokens = track
        .title
        .as_deref()
        .map(tokenize_language_meta)
        .unwrap_or_default();
    let combined_tokens = lang_tokens
        .iter()
        .chain(title_tokens.iter())
        .cloned()
        .collect::<Vec<_>>();

    let mut score = 0;

    for candidate in candidates {
        if lang == *candidate {
            score = score.max(120);
        } else if lang.starts_with(&format!("{}-", candidate)) {
            score = score.max(100);
        }

        if title_tokens.iter().any(|token| token == candidate) {
            score = score.max(80);
        }
    }

    if score == 0 {
        return 0;
    }

    if track.default_track {
        score += 15;
    }

    if contains_any_token(&title_tokens, &["full", "dialogue", "dialog", "main"]) {
        score += 20;
    }

    if track.forced || contains_token(&combined_tokens, "forced") {
        score -= 45;
    }

    if contains_any_token(
        &title_tokens,
        &["sign", "signs", "song", "songs", "karaoke", "typesetting"],
    ) {
        score -= 35;
    }

    if contains_token(&combined_tokens, "commentary") {
        score -= 60;
    }

    if track.hearing_impaired
        || contains_any_token(&combined_tokens, &["sdh", "cc"])
        || contains_phrase(&combined_tokens, &["closed", "caption"])
        || contains_phrase(&combined_tokens, &["closed", "captions"])
        || contains_phrase(&combined_tokens, &["hearing", "impaired"])
    {
        score -= 12;
    }

    score
}

pub(crate) fn infer_track_preferred_language(
    lang: Option<&str>,
    title: Option<&str>,
) -> Option<String> {
    if let Some(normalized_lang) = normalize_lower(lang) {
        if let Some(canonical) = canonicalize_language_token(&normalized_lang) {
            return Some(canonical.to_string());
        }

        for token in tokenize_language_meta(&normalized_lang) {
            if let Some(canonical) = canonicalize_language_token(&token) {
                return Some(canonical.to_string());
            }
        }
    }

    for token in title.map(tokenize_language_meta).unwrap_or_default() {
        if let Some(canonical) = canonicalize_language_token(&token) {
            return Some(canonical.to_string());
        }
    }

    None
}

pub(crate) fn track_matches_preferred_language(
    lang: Option<&str>,
    title: Option<&str>,
    preferred_language: &str,
) -> bool {
    let candidates = language_candidates(preferred_language);
    if candidates.is_empty() {
        return false;
    }

    let lang = normalize_lower(lang).unwrap_or_default();
    let title_tokens = title.map(tokenize_language_meta).unwrap_or_default();

    candidates.iter().any(|candidate| {
        lang == *candidate
            || lang.starts_with(&format!("{}-", candidate))
            || title_tokens.iter().any(|token| token == candidate)
    })
}

fn find_track_by_language(
    tracks: &[TrackLanguageCandidate],
    preferred_language: &str,
    selected_track_id: Option<i64>,
) -> Option<i64> {
    let candidates = language_candidates(preferred_language);
    if candidates.is_empty() {
        return None;
    }

    let mut best_track_id = None;
    let mut best_score = -1;

    for track in tracks {
        let score = track_language_score(track, &candidates);

        if score > 0
            && (score > best_score || (score == best_score && Some(track.id) == selected_track_id))
        {
            best_score = score;
            best_track_id = Some(track.id);
        }
    }

    best_track_id
}

pub(crate) fn resolve_preferred_track_selection(
    tracks: &[TrackLanguageCandidate],
    preferred_language: Option<&str>,
    selected_track_id: Option<i64>,
) -> TrackLanguageSelectionResolution {
    let normalized_preferred_language = normalize_language_token(preferred_language, false);
    let Some(preferred_language) = normalized_preferred_language.as_deref() else {
        return TrackLanguageSelectionResolution::default();
    };

    let matched_track_id = find_track_by_language(tracks, preferred_language, selected_track_id);

    let selected_matches = match (selected_track_id, matched_track_id) {
        (Some(selected_track_id), Some(best_track_id)) => selected_track_id == best_track_id,
        (Some(track_id), None) => tracks
            .iter()
            .find(|track| track.id == track_id)
            .is_some_and(|track| {
                track_matches_preferred_language(
                    track.lang.as_deref(),
                    track.title.as_deref(),
                    preferred_language,
                )
            }),
        _ => false,
    };

    let matched_track_id = if selected_matches {
        None
    } else {
        matched_track_id
    };

    TrackLanguageSelectionResolution {
        normalized_preferred_language,
        selected_matches,
        matched_track_id,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        infer_track_preferred_language, normalize_language_token,
        resolve_preferred_track_selection, TrackLanguageCandidate,
    };

    #[test]
    fn normalize_language_token_canonicalizes_aliases() {
        assert_eq!(
            normalize_language_token(Some("English"), false).as_deref(),
            Some("en")
        );
        assert_eq!(
            normalize_language_token(Some("pt-BR"), false).as_deref(),
            Some("pt")
        );
        assert_eq!(normalize_language_token(Some("commentary"), false), None);
    }

    #[test]
    fn infer_track_preferred_language_checks_lang_then_title() {
        assert_eq!(
            infer_track_preferred_language(Some("English Commentary"), None).as_deref(),
            Some("en")
        );
        assert_eq!(
            infer_track_preferred_language(None, Some("[JPN] Main Subtitle")).as_deref(),
            Some("ja")
        );
    }

    #[test]
    fn resolve_preferred_track_selection_returns_match_state_and_best_track() {
        let tracks = vec![
            TrackLanguageCandidate {
                id: 1,
                lang: Some("eng".to_string()),
                title: Some("English".to_string()),
                default_track: false,
                forced: false,
                hearing_impaired: false,
            },
            TrackLanguageCandidate {
                id: 2,
                lang: Some("jpn".to_string()),
                title: Some("Japanese".to_string()),
                default_track: false,
                forced: false,
                hearing_impaired: false,
            },
        ];

        let resolution = resolve_preferred_track_selection(&tracks, Some("Japanese"), Some(1));
        assert_eq!(
            resolution.normalized_preferred_language.as_deref(),
            Some("ja")
        );
        assert!(!resolution.selected_matches);
        assert_eq!(resolution.matched_track_id, Some(2));

        let already_matching = resolve_preferred_track_selection(&tracks, Some("eng"), Some(1));
        assert!(already_matching.selected_matches);
        assert_eq!(already_matching.matched_track_id, None);
    }

    #[test]
    fn resolve_preferred_track_selection_prefers_full_subtitles_over_signs_track() {
        let tracks = vec![
            TrackLanguageCandidate {
                id: 1,
                lang: Some("eng".to_string()),
                title: Some("English Signs & Songs".to_string()),
                default_track: true,
                forced: false,
                hearing_impaired: false,
            },
            TrackLanguageCandidate {
                id: 2,
                lang: Some("eng".to_string()),
                title: Some("English Full".to_string()),
                default_track: false,
                forced: false,
                hearing_impaired: false,
            },
        ];

        let resolution = resolve_preferred_track_selection(&tracks, Some("English"), Some(1));
        assert_eq!(
            resolution.normalized_preferred_language.as_deref(),
            Some("en")
        );
        assert!(!resolution.selected_matches);
        assert_eq!(resolution.matched_track_id, Some(2));
    }

    #[test]
    fn resolve_preferred_track_selection_prefers_main_audio_over_commentary() {
        let tracks = vec![
            TrackLanguageCandidate {
                id: 1,
                lang: Some("eng".to_string()),
                title: Some("English Commentary".to_string()),
                default_track: true,
                forced: false,
                hearing_impaired: false,
            },
            TrackLanguageCandidate {
                id: 2,
                lang: Some("eng".to_string()),
                title: Some("English".to_string()),
                default_track: false,
                forced: false,
                hearing_impaired: false,
            },
        ];

        let resolution = resolve_preferred_track_selection(&tracks, Some("English"), Some(1));
        assert_eq!(
            resolution.normalized_preferred_language.as_deref(),
            Some("en")
        );
        assert!(!resolution.selected_matches);
        assert_eq!(resolution.matched_track_id, Some(2));
    }
}
