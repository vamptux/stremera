use super::*;
use std::collections::{HashMap, HashSet};

fn mk_watch_progress(id: &str, type_: &str, last_watched: u64) -> WatchProgress {
    WatchProgress {
        id: id.to_string(),
        type_: type_.to_string(),
        season: None,
        episode: None,
        absolute_season: None,
        absolute_episode: None,
        stream_season: None,
        stream_episode: None,
        aniskip_episode: None,
        position: 0.0,
        duration: 0.0,
        last_watched,
        title: "Example".to_string(),
        poster: None,
        backdrop: None,
        last_stream_url: None,
        last_stream_format: None,
        last_stream_lookup_id: None,
        last_stream_key: None,
    }
}

fn mk_stream(
    name: Option<&str>,
    title: Option<&str>,
    url: Option<&str>,
    info_hash: Option<&str>,
    filename: Option<&str>,
) -> TorrentioStream {
    TorrentioStream {
        name: name.map(|v| v.to_string()),
        title: title.map(|v| v.to_string()),
        info_hash: info_hash.map(|v| v.to_string()),
        url: url.map(|v| v.to_string()),
        file_idx: None,
        behavior_hints: Some(crate::providers::torrentio::BehaviorHints {
            binge_group: None,
            filename: filename.map(|v| v.to_string()),
        }),
        cached: false,
        seeders: None,
        size_bytes: None,
        source_name: None,
    }
}

#[test]
fn build_magnet_returns_magnet_url_if_already_magnet() {
    let magnet = "magnet:?xt=urn:btih:abc123&dn=Test";
    let result = build_magnet(Some(magnet), None);
    assert_eq!(result.as_deref(), Some(magnet));
}

#[test]
fn build_magnet_from_info_hash_when_url_is_http() {
    let result = build_magnet(
        Some("https://rd.example.com/dl/file.mkv"),
        Some("aabbccddeeff00112233445566778899aabbccdd"),
    );
    assert_eq!(
        result.as_deref(),
        Some("magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd")
    );
}

#[test]
fn build_magnet_from_hash_only() {
    let result = build_magnet(None, Some("deadbeef1234"));
    assert_eq!(result.as_deref(), Some("magnet:?xt=urn:btih:deadbeef1234"));
}

#[test]
fn build_magnet_returns_none_when_both_absent() {
    assert!(build_magnet(None, None).is_none());
}

#[test]
fn placeholder_block_payload_is_filtered() {
    let blocked = mk_stream(
        Some("[BLOCKED] No Streams Available"),
        Some("No streams found for this content"),
        Some("data:text/plain;charset=utf-8,No%20streams%20available"),
        None,
        Some("no_streams_available.txt"),
    );

    assert!(is_placeholder_no_stream(&blocked));
    assert!(!has_playable_stream_source(&blocked));
}

#[test]
fn stream_with_filename_marker_is_treated_as_placeholder() {
    let blocked = mk_stream(
        Some("No Streams"),
        Some("Try again later"),
        Some("https://example.com/not-a-video"),
        None,
        Some("no_streams_available.txt"),
    );
    assert!(is_placeholder_no_stream(&blocked));
}

#[test]
fn viable_sources_accept_http_magnet_or_hash() {
    let http = mk_stream(
        None,
        None,
        Some("https://video.example/file.mkv"),
        None,
        None,
    );
    let magnet = mk_stream(None, None, Some("magnet:?xt=urn:btih:abc"), None, None);
    let hash_only = mk_stream(None, None, None, Some("deadbeef"), None);

    assert!(has_playable_stream_source(&http));
    assert!(has_playable_stream_source(&magnet));
    assert!(has_playable_stream_source(&hash_only));
}

#[test]
fn stream_dedup_key_prefers_hash_over_url() {
    let mut stream = mk_stream(
        Some("Example"),
        Some("1080p"),
        Some("https://example.com/video.mkv"),
        Some("abcdef123456"),
        None,
    );
    stream.file_idx = Some(7);

    assert_eq!(
        streaming_helpers::stream_dedup_key(&stream).as_deref(),
        Some("h:abcdef123456:7")
    );
}

#[test]
fn prepare_addon_streams_dedupes_hash_case_insensitively() {
    let mut upper = mk_stream(
        Some("Upper hash"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:ABCDEF1234"),
        Some("ABCDEF1234"),
        None,
    );
    upper.file_idx = Some(2);

    let mut lower = mk_stream(
        Some("Lower hash"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abcdef1234"),
        Some("abcdef1234"),
        None,
    );
    lower.file_idx = Some(2);

    let prepared = prepare_addon_streams(vec![upper, lower], "CaseTest");
    assert_eq!(prepared.len(), 1);
}

#[test]
fn prepare_addon_streams_filters_labels_and_dedupes() {
    let mut a = mk_stream(
        Some("Torrent A"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abc"),
        Some("abc"),
        None,
    );
    a.file_idx = Some(1);

    let mut duplicate = a.clone();
    duplicate.title = Some("Duplicate entry".to_string());

    let blocked = mk_stream(
        Some("[BLOCKED] No Streams Available"),
        Some("No streams found for this content"),
        Some("data:text/plain,blocked"),
        None,
        Some("no_streams_available.txt"),
    );

    let prepared = prepare_addon_streams(vec![a, duplicate, blocked], "TestSource");

    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].source_name.as_deref(), Some("TestSource"));
    assert_eq!(prepared[0].info_hash.as_deref(), Some("abc"));
}

#[test]
fn merge_unique_streams_skips_already_seen_entries() {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    let mut first = mk_stream(
        Some("First"),
        Some("720p"),
        Some("magnet:?xt=urn:btih:first"),
        Some("firsthash"),
        None,
    );
    first.file_idx = Some(0);

    let mut dupe = first.clone();
    dupe.name = Some("Duplicate".to_string());

    merge_unique_streams(&mut merged, &mut seen, vec![first]);
    merge_unique_streams(&mut merged, &mut seen, vec![dupe]);

    assert_eq!(merged.len(), 1);
    assert_eq!(seen.len(), 1);
}

#[test]
fn query_ids_movie_returns_single_id() {
    let ids = build_stream_query_ids("movie", "tt1234567", None, None, None);
    assert_eq!(ids, vec!["tt1234567"]);
}

#[test]
fn normalize_debrid_provider_accepts_supported_values() {
    assert_eq!(normalize_debrid_provider("realdebrid"), Some("realdebrid"));
    assert_eq!(
        normalize_debrid_provider(" REALDEBRID "),
        Some("realdebrid")
    );
    assert_eq!(normalize_debrid_provider("none"), Some("none"));
    assert_eq!(normalize_debrid_provider(""), Some("none"));
}

#[test]
fn normalize_debrid_provider_rejects_unknown_values() {
    assert_eq!(normalize_debrid_provider("premiumize"), None);
    assert_eq!(normalize_debrid_provider("rd"), None);
}

#[test]
fn query_ids_series_no_anime_no_fallback() {
    let ids = build_stream_query_ids("series", "tt9998887", Some(2), Some(5), None);
    assert_eq!(ids, vec!["tt9998887:2:5"]);
}

#[test]
fn query_ids_anime_imdb_adds_season_zero_and_season_one_fallbacks() {
    let ids = build_stream_query_ids("anime", "tt1111111", Some(2), Some(10), None);
    assert!(ids.contains(&"tt1111111:2:10".to_string()));
    assert!(ids.contains(&"tt1111111:1:10".to_string()));
    assert!(ids.contains(&"tt1111111:0:10".to_string()));
}

#[test]
fn query_ids_anime_season_one_no_duplicate_season_one() {
    let ids = build_stream_query_ids("anime", "tt2222222", Some(1), Some(3), None);
    let canonical = "tt2222222:1:3";
    let count = ids.iter().filter(|s| s.as_str() == canonical).count();
    assert_eq!(count, 1, "canonical id should appear exactly once");
}

#[test]
fn query_ids_anime_adds_absolute_episode_fallback_when_different() {
    let ids = build_stream_query_ids("anime", "tt0388629", Some(21), Some(5), Some(1000));
    assert!(ids.contains(&"tt0388629:21:5".to_string()));
    assert!(ids.contains(&"tt0388629:1:5".to_string()));
    assert!(ids.contains(&"tt0388629:1:1000".to_string()));
    assert!(ids.contains(&"tt0388629:0:5".to_string()));
}

#[test]
fn query_ids_anime_kitsu_id_no_fallbacks() {
    let ids = build_stream_query_ids("anime", "kitsu:12345", Some(1), Some(7), Some(7));
    assert_eq!(ids, vec!["kitsu:12345:1:7"]);
}

#[test]
fn resolve_addon_configs_respects_explicit_empty_list() {
    let resolved = store_helpers::resolve_addon_configs(
        Some(vec![]),
        Some("https://torrentio.strem.fun".to_string()),
    );

    assert!(
        resolved.is_empty(),
        "an explicitly empty addon list should not resurrect legacy torrentio state"
    );
}

#[test]
fn resolve_addon_configs_normalizes_loaded_addons() {
    let resolved = store_helpers::resolve_addon_configs(
        Some(vec![AddonConfig {
            id: "   ".to_string(),
            url: "torrentio.strem.fun/manifest.json".to_string(),
            name: "   ".to_string(),
            enabled: true,
        }]),
        None,
    );

    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].id, "https://torrentio.strem.fun");
    assert_eq!(resolved[0].url, "https://torrentio.strem.fun");
    assert_eq!(resolved[0].name, "torrentio.strem.fun");
}

#[test]
fn resolve_addon_configs_dedupes_duplicate_urls() {
    let resolved = store_helpers::resolve_addon_configs(
        Some(vec![
            AddonConfig {
                id: "torrentio-primary".to_string(),
                url: "https://torrentio.strem.fun/manifest.json".to_string(),
                name: "Torrentio A".to_string(),
                enabled: true,
            },
            AddonConfig {
                id: "torrentio-secondary".to_string(),
                url: "torrentio.strem.fun".to_string(),
                name: "Torrentio B".to_string(),
                enabled: false,
            },
        ]),
        None,
    );

    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].id, "torrentio-primary");
    assert_eq!(resolved[0].url, "https://torrentio.strem.fun");
    assert_eq!(resolved[0].name, "Torrentio A");
}

#[test]
fn resolve_addon_configs_repairs_duplicate_ids_for_distinct_urls() {
    let resolved = store_helpers::resolve_addon_configs(
        Some(vec![
            AddonConfig {
                id: "shared-id".to_string(),
                url: "https://torrentio.strem.fun".to_string(),
                name: "Torrentio".to_string(),
                enabled: true,
            },
            AddonConfig {
                id: "shared-id".to_string(),
                url: "https://example-addon.test/manifest.json".to_string(),
                name: "Example".to_string(),
                enabled: true,
            },
        ]),
        None,
    );

    assert_eq!(resolved.len(), 2);
    assert_eq!(resolved[0].id, "shared-id");
    assert_eq!(resolved[1].id, "https://example-addon.test");
    assert_eq!(resolved[1].url, "https://example-addon.test");
}

#[test]
fn choose_watch_history_entry_prefers_playable_resume_metadata() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 200);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut playable = mk_watch_progress("kitsu:42", "anime", 180);
    playable.season = Some(1);
    playable.episode = Some(12);
    playable.position = 512.0;
    playable.duration = 1_440.0;
    playable.last_stream_lookup_id = Some("tt1234567".to_string());
    playable.last_stream_url = Some("magnet:?xt=urn:btih:resume42".to_string());
    playable.last_stream_format = Some("video/mp4".to_string());

    let chosen = choose_watch_history_entry(vec![latest, playable]).expect("history entry");

    assert_eq!(chosen.last_watched, 200);
    assert_eq!(chosen.season, Some(1));
    assert_eq!(chosen.episode, Some(12));
    assert_eq!(chosen.position, 512.0);
    assert_eq!(chosen.duration, 1_440.0);
    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt1234567"));
    assert_eq!(
        chosen.last_stream_url.as_deref(),
        Some("magnet:?xt=urn:btih:resume42")
    );
}

#[test]
fn choose_watch_history_entry_hydrates_lookup_from_imdb_id_for_series() {
    let mut latest = mk_watch_progress("tt7654321", "series", 200);
    latest.season = Some(1);
    latest.episode = Some(1);
    latest.position = 180.0;
    latest.duration = 1_200.0;
    latest.last_stream_url = Some("https://cdn.example/video.m3u8".to_string());

    let chosen = choose_watch_history_entry(vec![latest]).expect("history entry");

    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt7654321"));
}

#[test]
fn sanitize_watch_progress_normalizes_anime_type_to_series() {
    let progress = mk_watch_progress("kitsu:99", "anime", 10);
    let sanitized = sanitize_watch_progress(progress).expect("valid anime progress");

    assert_eq!(sanitized.type_, "series");
}

#[test]
fn sanitize_watch_progress_rejects_invalid_type() {
    let progress = mk_watch_progress("bad:1", "unsupported", 10);

    assert!(sanitize_watch_progress(progress).is_none());
}

#[test]
fn stream_priority_prefers_user_source_order_when_quality_is_tied() {
    let addons = vec![
        AddonConfig {
            id: "alpha".to_string(),
            url: "https://alpha.example".to_string(),
            name: "Alpha".to_string(),
            enabled: true,
        },
        AddonConfig {
            id: "beta".to_string(),
            url: "https://beta.example".to_string(),
            name: "Beta".to_string(),
            enabled: true,
        },
    ];
    let priorities = build_addon_source_priority_map(&addons);

    let mut preferred = mk_stream(
        Some("1080p HEVC"),
        Some("Alpha Stream"),
        Some("magnet:?xt=urn:btih:alpha1"),
        Some("alpha1"),
        None,
    );
    preferred.cached = true;
    preferred.seeders = Some(10);
    preferred.size_bytes = Some(1_000);
    preferred.source_name = Some("Alpha".to_string());

    let mut fallback = preferred.clone();
    fallback.url = Some("magnet:?xt=urn:btih:beta1".to_string());
    fallback.info_hash = Some("beta1".to_string());
    fallback.seeders = Some(300);
    fallback.source_name = Some("Beta".to_string());

    let preferred_score =
        stream_resolution_priority(&preferred, stream_source_priority(&preferred, &priorities));
    let fallback_score =
        stream_resolution_priority(&fallback, stream_source_priority(&fallback, &priorities));

    assert!(preferred_score > fallback_score);
}

#[test]
fn stream_priority_prefers_multi_audio_when_other_signals_match() {
    let priorities = HashMap::new();

    let mut dual_audio = mk_stream(
        Some("1080p HEVC"),
        Some("Dual Audio Release"),
        Some("magnet:?xt=urn:btih:dual1"),
        Some("dual1"),
        None,
    );
    dual_audio.cached = true;
    dual_audio.seeders = Some(50);
    dual_audio.size_bytes = Some(1_000);

    let mut standard = dual_audio.clone();
    standard.title = Some("Standard Release".to_string());
    standard.url = Some("magnet:?xt=urn:btih:std1".to_string());
    standard.info_hash = Some("std1".to_string());

    let dual_score = stream_resolution_priority(
        &dual_audio,
        stream_source_priority(&dual_audio, &priorities),
    );
    let standard_score =
        stream_resolution_priority(&standard, stream_source_priority(&standard, &priorities));

    assert!(dual_score > standard_score);
}

#[test]
fn best_matching_file_ignores_extras_for_episode_only_fallback() {
    let files = vec![
        crate::providers::realdebrid::TorrentFile {
            id: 1,
            path: "Show/Extras/BehindTheScenes/E01.mkv".to_string(),
            bytes: 2_000,
            selected: 1,
        },
        crate::providers::realdebrid::TorrentFile {
            id: 2,
            path: "Show/Season 01/Episode E01.mkv".to_string(),
            bytes: 1_500,
            selected: 1,
        },
    ];

    let idx = find_best_matching_file(&files, Some(1), Some(1));
    assert_eq!(idx, 1, "should prefer non-extras episode candidate");
}

#[test]
fn best_matching_file_prefers_non_extras_for_strict_sxe_match() {
    let files = vec![
        crate::providers::realdebrid::TorrentFile {
            id: 1,
            path: "Show/Extras/Show.S01E01.BehindTheScenes.mkv".to_string(),
            bytes: 2_000,
            selected: 1,
        },
        crate::providers::realdebrid::TorrentFile {
            id: 2,
            path: "Show/Season 01/Show.S01E01.1080p.mkv".to_string(),
            bytes: 1_500,
            selected: 1,
        },
    ];

    let idx = find_best_matching_file(&files, Some(1), Some(1));
    assert_eq!(idx, 1, "should prefer non-extras strict SxxExx match");
}

#[test]
fn largest_video_fallback_ignores_non_video_suffix_collision() {
    let files = vec![
        crate::providers::realdebrid::TorrentFile {
            id: 1,
            path: "Show/Season 01/episode_file_mkv".to_string(),
            bytes: 10_000,
            selected: 1,
        },
        crate::providers::realdebrid::TorrentFile {
            id: 2,
            path: "Show/Season 01/episode_file.mkv".to_string(),
            bytes: 9_000,
            selected: 1,
        },
    ];

    let idx = find_best_matching_file(&files, None, None);
    assert_eq!(
        idx, 1,
        "should require a real file extension for video fallback"
    );
}

#[test]
fn largest_video_fallback_allows_titles_with_trailer_word() {
    let files = vec![
        crate::providers::realdebrid::TorrentFile {
            id: 1,
            path: "Movies/Trailer Park Boys The Movie.mkv".to_string(),
            bytes: 8_000,
            selected: 1,
        },
        crate::providers::realdebrid::TorrentFile {
            id: 2,
            path: "Movies/sample.mkv".to_string(),
            bytes: 9_000,
            selected: 1,
        },
    ];

    let idx = find_best_matching_file(&files, None, None);
    assert_eq!(
        idx, 0,
        "should not reject valid titles that contain trailer"
    );
}
