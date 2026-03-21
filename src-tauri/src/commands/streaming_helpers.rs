use super::AddonConfig;
use crate::providers::realdebrid::TorrentFile;
use crate::providers::torrentio::{stream_quality_score, TorrentioStream};
use std::collections::{HashMap, HashSet};

pub(crate) fn normalize_http_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed = reqwest::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed.to_string()),
        _ => None,
    }
}

pub(crate) fn is_http_url(input: &str) -> bool {
    normalize_http_url(input).is_some()
}

pub(crate) fn has_playable_stream_source(stream: &TorrentioStream) -> bool {
    let has_direct_http = stream.url.as_deref().is_some_and(is_http_url);
    let has_magnet = stream
        .url
        .as_deref()
        .is_some_and(|u| u.trim().to_ascii_lowercase().starts_with("magnet:"));
    let has_info_hash = stream
        .info_hash
        .as_deref()
        .is_some_and(|h| !h.trim().is_empty());

    has_direct_http || has_magnet || has_info_hash
}

pub(crate) fn is_placeholder_no_stream(stream: &TorrentioStream) -> bool {
    let name = stream.name.as_deref().unwrap_or("").to_ascii_lowercase();
    let title = stream.title.as_deref().unwrap_or("").to_ascii_lowercase();
    let filename = stream
        .behavior_hints
        .as_ref()
        .and_then(|h| h.filename.as_deref())
        .unwrap_or("")
        .to_ascii_lowercase();
    let url = stream
        .url
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let no_stream_marker = name.contains("[blocked]")
        || name.contains("no streams available")
        || title.contains("no streams found for this content")
        || title.contains("no streams available")
        || filename.contains("no_streams_available");

    no_stream_marker || url.starts_with("data:text/")
}

pub(crate) fn stream_dedup_key(stream: &TorrentioStream) -> Option<String> {
    if let Some(hash) = stream
        .info_hash
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(|h| h.to_ascii_lowercase())
    {
        return Some(format!("h:{}:{}", hash, stream.file_idx.unwrap_or(0)));
    }

    stream
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|url| format!("u:{}", url))
}

pub(crate) fn prepare_addon_streams(
    streams: Vec<TorrentioStream>,
    source_name: &str,
) -> Vec<TorrentioStream> {
    let source_name = source_name.to_string();
    let mut seen = HashSet::new();
    let mut prepared = Vec::with_capacity(streams.len());

    for mut stream in streams {
        if is_placeholder_no_stream(&stream) || !has_playable_stream_source(&stream) {
            continue;
        }

        let Some(dedup_key) = stream_dedup_key(&stream) else {
            continue;
        };

        if !seen.insert(dedup_key) {
            continue;
        }

        stream.source_name = Some(source_name.clone());
        prepared.push(stream);
    }

    prepared
}

pub(crate) fn merge_unique_streams(
    merged: &mut Vec<TorrentioStream>,
    seen: &mut HashSet<String>,
    streams: Vec<TorrentioStream>,
) {
    for stream in streams {
        let Some(dedup_key) = stream_dedup_key(&stream) else {
            continue;
        };

        if seen.insert(dedup_key) {
            merged.push(stream);
        }
    }
}

pub(crate) fn infer_stream_mime(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".m3u8") {
        "application/x-mpegURL"
    } else if lower.contains(".mpd") {
        "application/dash+xml"
    } else if lower.contains(".webm") {
        "video/webm"
    } else if lower.contains(".ogg") || lower.contains(".ogv") {
        "video/ogg"
    } else if lower.contains(".mkv") {
        "video/x-matroska"
    } else {
        "video/mp4"
    }
}

pub(crate) fn build_magnet(url: Option<&str>, info_hash: Option<&str>) -> Option<String> {
    if let Some(u) = url.filter(|u| u.starts_with("magnet")) {
        return Some(u.to_string());
    }

    info_hash.map(|hash| format!("magnet:?xt=urn:btih:{}", hash))
}

pub(crate) fn build_stream_query_ids(
    media_type: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Vec<String> {
    if let (Some(s), Some(e)) = (season, episode) {
        let mut ids = vec![format!("{}:{}:{}", id, s, e)];

        // For anime with IMDB ID, the frontend already sends the correct IMDB season/episode
        // (mapped from Kitsu's imdbSeason/imdbEpisode fields). We need broader fallbacks
        // since different addons index anime differently (One Piece has 1000+ episodes).
        if media_type == "anime" && id.starts_with("tt") {
            // Season 1 fallback: some providers index all anime episodes under season 1
            // with absolute episode numbering (e.g. episode 1000 for One Piece)
            if s != 1 {
                let season_one = format!("{}:1:{}", id, e);
                if !ids.contains(&season_one) {
                    ids.push(season_one);
                }
            }

            // Absolute episode fallback: when frontend sends IMDB S/E coordinates
            // but also knows the source absolute episode number, include that too.
            // Critical for long-running series like One Piece where Kitsu uses ep 1000+
            // but IMDB maps to smaller season-relative numbers.
            if let Some(abs_ep) = absolute_episode.filter(|abs_ep| *abs_ep != e) {
                // Try absolute episode under the original season
                let absolute_in_season = format!("{}:{}:{}", id, s, abs_ep);
                if !ids.contains(&absolute_in_season) {
                    ids.push(absolute_in_season);
                }
                // Try absolute episode under season 1 (common indexing)
                let absolute_season_one = format!("{}:1:{}", id, abs_ep);
                if !ids.contains(&absolute_season_one) {
                    ids.push(absolute_season_one);
                }
            }

            // Season 0 fallback: specials/OVAs are often indexed under season 0
            let season_zero = format!("{}:0:{}", id, e);
            if !ids.contains(&season_zero) {
                ids.push(season_zero);
            }
        }

        ids
    } else {
        vec![id.to_string()]
    }
}

pub(crate) fn find_best_matching_file(
    files: &[TorrentFile],
    season: Option<u32>,
    episode: Option<u32>,
) -> usize {
    // If no season/episode provided (movie), prefer largest video file - batch packs may
    // include large making-of files that would win a pure byte-count comparison.
    let Some((s, e)) = season.zip(episode) else {
        return find_largest_video_file_idx(files);
    };

    // Pre-compute lowercased paths once to avoid repeated .to_lowercase() per loop.
    let lowered_paths: Vec<String> = files.iter().map(|f| f.path.to_lowercase()).collect();

    // Helper to check if file is video and NOT sample (operates on pre-lowered path).
    let is_valid_video = |p: &str| is_valid_video_path_lower(p);

    let is_extras_path = |p: &str| p.split(['/', '\\']).any(is_extra_directory_segment_lower);

    // Pattern strings for matching - lowercase since we compare against lowercased paths.
    let s_e_pattern = format!("s{:02}e{:02}", s, e);
    let s_e_pattern_unpadded = format!("s{}e{}", s, e);
    let n_x_n_pattern = format!("{}x{:02}", s, e);
    let e_only_pattern = format!("e{:02}", e);
    // For 3+ digit episodes (long-running anime), also search unpadded variants
    let e_long_pattern = if e >= 100 {
        Some(format!("e{}", e))
    } else {
        None
    };
    // " - 052" / " - 1000" anime naming convention
    let anime_dash_pattern = format!(" - {:03}", e);
    let anime_dash_unpadded = if e >= 100 {
        Some(format!(" - {}", e))
    } else {
        None
    };

    // 1. Try strict SxxExx match on video files, preferring non-extras paths.
    for avoid_extras in [true, false] {
        for (i, p) in lowered_paths.iter().enumerate() {
            if is_valid_video(p)
                && (p.contains(&s_e_pattern) || p.contains(&s_e_pattern_unpadded))
                && (!avoid_extras || !is_extras_path(p))
            {
                return i;
            }
        }
    }

    // 2. Try NxN match (1x01) on video files, preferring non-extras paths.
    for avoid_extras in [true, false] {
        for (i, p) in lowered_paths.iter().enumerate() {
            if is_valid_video(p)
                && p.contains(&n_x_n_pattern)
                && (!avoid_extras || !is_extras_path(p))
            {
                return i;
            }
        }
    }

    // 3. Fallback: episode number only (e.g. "E01", "E1000")
    for (i, p) in lowered_paths.iter().enumerate() {
        if is_valid_video(p)
            && (p.contains(&e_only_pattern)
                || e_long_pattern
                    .as_ref()
                    .is_some_and(|pat| p.contains(pat.as_str())))
            && !is_extras_path(p)
        {
            return i;
        }
    }

    // 3.5. Anime-style " - 052" / " - 1000" naming convention
    for (i, p) in lowered_paths.iter().enumerate() {
        if is_valid_video(p) && !is_extras_path(p) {
            if p.contains(&anime_dash_pattern) {
                return i;
            }
            if let Some(ref pat) = anime_dash_unpadded {
                if p.contains(pat.as_str()) {
                    return i;
                }
            }
        }
    }

    // 4. Last resort: largest video file (prevents selecting a making-of/featurette for
    //    batch packs where no standard SxxExx / NxN / Exx pattern was found). Falls back
    //    to absolute largest only if no valid video file is present at all.
    find_largest_video_file_idx(files)
}

pub(crate) fn build_addon_source_priority_map(addons: &[AddonConfig]) -> HashMap<String, u32> {
    let total = addons.len() as u32;
    let mut priorities = HashMap::new();

    for (idx, addon) in addons.iter().enumerate() {
        let normalized = addon.name.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        priorities
            .entry(normalized)
            .or_insert(total.saturating_sub(idx as u32));
    }

    priorities
}

pub(crate) fn stream_source_priority(
    stream: &TorrentioStream,
    priorities: &HashMap<String, u32>,
) -> u32 {
    stream
        .source_name
        .as_deref()
        .map(|name| name.trim().to_ascii_lowercase())
        .and_then(|name| priorities.get(&name).copied())
        .unwrap_or(0)
}

fn stream_language_bonus(stream: &TorrentioStream) -> u8 {
    let haystack = format!(
        "{} {}",
        stream.name.as_deref().unwrap_or(""),
        stream.title.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase();

    if [
        "dual audio",
        "dual-audio",
        "multi audio",
        "multi-audio",
        "multiaudio",
        "dub + sub",
        "sub + dub",
        "dubbed/subbed",
    ]
    .iter()
    .any(|marker| haystack.contains(marker))
    {
        1
    } else {
        0
    }
}

pub(crate) fn stream_resolution_priority(
    stream: &TorrentioStream,
    source_priority: u32,
) -> (u8, i32, u8, u32, u32, u64) {
    let has_direct_http = stream.url.as_deref().is_some_and(is_http_url);
    let has_info_hash = stream
        .info_hash
        .as_deref()
        .is_some_and(|hash| !hash.trim().is_empty());

    let viability_rank = if stream.cached {
        4
    } else if has_direct_http {
        3
    } else if has_info_hash {
        2
    } else {
        1
    };

    (
        viability_rank,
        stream_quality_score(stream),
        stream_language_bonus(stream),
        source_priority,
        stream.seeders.unwrap_or(0),
        stream.size_bytes.unwrap_or(0),
    )
}

/// Returns the index of the largest selected file whose extension is a common video
/// container and whose name does not suggest it is a sample or trailer.
/// Falls back to the absolute largest selected file when no qualifying video file exists.
fn find_largest_video_file_idx(files: &[TorrentFile]) -> usize {
    let best_video = files
        .iter()
        .enumerate()
        .filter(|(_, f)| {
            if f.selected != 1 {
                return false;
            }
            let p = f.path.to_lowercase();
            is_valid_video_path_lower(&p)
        })
        .max_by_key(|(_, f)| f.bytes)
        .map(|(i, _)| i);

    best_video.unwrap_or_else(|| find_largest_file_idx(files))
}

fn find_largest_file_idx(files: &[TorrentFile]) -> usize {
    let mut largest_file_idx = 0;
    let mut max_size = 0;

    for (i, file) in files.iter().enumerate() {
        if file.selected == 1 && file.bytes > max_size {
            max_size = file.bytes;
            largest_file_idx = i;
        }
    }
    largest_file_idx
}

fn is_extra_directory_segment_lower(segment: &str) -> bool {
    matches!(
        segment,
        "extra"
            | "extras"
            | "special"
            | "specials"
            | "bonus"
            | "featurette"
            | "featurettes"
            | "behindthescenes"
            | "interview"
            | "interviews"
            | "sample"
            | "samples"
            | "trailer"
            | "trailers"
    )
}

fn is_explicit_extra_filename_stem_lower(stem: &str) -> bool {
    let tokens = stem
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    match tokens.as_slice() {
        ["sample"] | ["samples"] | ["trailer"] | ["trailers"] => true,
        [prefix, suffix]
            if matches!(*prefix, "sample" | "samples" | "trailer" | "trailers")
                && suffix.chars().all(|c| c.is_ascii_digit()) =>
        {
            true
        }
        _ => false,
    }
}

fn is_valid_video_path_lower(path_lower: &str) -> bool {
    let mut segments = path_lower
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let Some(filename) = segments.pop() else {
        return false;
    };

    if segments
        .iter()
        .copied()
        .any(is_extra_directory_segment_lower)
    {
        return false;
    }

    let stem = filename
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(filename);
    if is_explicit_extra_filename_stem_lower(stem) {
        return false;
    }

    let extension = filename.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");

    matches!(
        extension,
        "mp4" | "mkv" | "avi" | "webm" | "mov" | "m4v" | "ts"
    )
}
