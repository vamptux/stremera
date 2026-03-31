use super::config_store::{
    extract_embedded_realdebrid_token, normalize_addon_url, normalize_debrid_provider,
    resolve_addon_configs, AddonConfig,
};
use super::history_helpers::{
    choose_continue_watching_entry, choose_exact_watch_progress_entry, choose_watch_history_entry,
    choose_watch_history_entry_with_source_health, is_continue_watching_candidate,
};
use super::playback_state::merge_keyed_progress_entries;
use super::streaming_helpers::{
    build_addon_source_priority_map, build_magnet, build_stream_query_ids, find_best_matching_file,
    merge_unique_streams, prepare_addon_streams, stream_resolution_priority,
    stream_source_priority,
};
use super::*;
use crate::providers::addons::TorrentioStream;
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
        source_name: None,
        stream_family: None,
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
        behavior_hints: Some(crate::providers::addons::BehaviorHints {
            binge_group: None,
            filename: filename.map(|v| v.to_string()),
        }),
        cached: false,
        seeders: None,
        size_bytes: None,
        source_name: None,
        stream_family: None,
        recommendation_reasons: Vec::new(),
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
    assert!(prepared[0].stream_family.is_some());
}

#[test]
fn stream_family_ignores_episode_number_noise() {
    let source_name = "Alpha";
    let stream_one = mk_stream(
        Some("Alpha Group S01E01 1080p WEB-DL"),
        Some("1.4 GB"),
        Some("magnet:?xt=urn:btih:alpha-1"),
        Some("alpha-1"),
        Some("Show.S01E01.1080p.WEB-DL-GROUP.mkv"),
    );
    let stream_two = mk_stream(
        Some("Alpha Group S01E02 1080p WEB-DL"),
        Some("1.5 GB"),
        Some("magnet:?xt=urn:btih:alpha-2"),
        Some("alpha-2"),
        Some("Show.S01E02.1080p.WEB-DL-GROUP.mkv"),
    );

    let family_one = streaming_helpers::derive_stream_family(&stream_one, source_name);
    let family_two = streaming_helpers::derive_stream_family(&stream_two, source_name);

    assert_eq!(family_one, family_two);
}

#[test]
fn near_completion_progress_is_not_skipped() {
    let mut existing = mk_watch_progress("tt123", "series", 1_000);
    existing.season = Some(1);
    existing.episode = Some(2);
    existing.absolute_season = Some(1);
    existing.absolute_episode = Some(2);
    existing.position = 869.0;
    existing.duration = 900.0;

    let mut incoming = existing.clone();
    incoming.last_watched = 6_000;
    incoming.position = 871.0;

    assert!(!history_helpers::should_skip_watch_progress_save(
        &existing, &incoming,
    ));
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
fn extract_embedded_realdebrid_token_reads_path_segment() {
    let token = extract_embedded_realdebrid_token(
        "https://torrentio.strem.fun/providers=realdebrid|x/realdebrid=abc123xyz/manifest.json",
    );

    assert_eq!(token.as_deref(), Some("abc123xyz"));
}

#[test]
fn extract_embedded_realdebrid_token_reads_query_param() {
    let token = extract_embedded_realdebrid_token(
        "https://addon.example.com/manifest.json?realdebrid=query-token-789",
    );

    assert_eq!(token.as_deref(), Some("query-token-789"));
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
    let resolved = resolve_addon_configs(
        Some(vec![]),
        Some("https://torrentio.strem.fun".to_string()),
    );

    assert!(
        resolved.is_empty(),
        "an explicitly empty addon list should not resurrect legacy single-addon state"
    );
}

#[test]
fn normalize_addon_url_strips_manifest_suffix_and_fragment() {
    let normalized =
        normalize_addon_url("https://example-addon.test/path/manifest.json?foo=bar#fragment")
            .expect("valid addon url");

    assert_eq!(
        normalized.as_deref(),
        Some("https://example-addon.test/path?foo=bar")
    );
}

#[test]
fn resolve_addon_configs_normalizes_loaded_addons() {
    let resolved = resolve_addon_configs(
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
    let resolved = resolve_addon_configs(
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
    let resolved = resolve_addon_configs(
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
fn choose_watch_history_entry_prefers_same_episode_resume_donor() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 300);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut other_episode = mk_watch_progress("kitsu:42", "anime", 260);
    other_episode.season = Some(1);
    other_episode.episode = Some(11);
    other_episode.position = 420.0;
    other_episode.duration = 1_440.0;
    other_episode.last_stream_lookup_id = Some("tt-other-episode".to_string());
    other_episode.last_stream_url = Some("magnet:?xt=urn:btih:other11".to_string());

    let mut same_episode = mk_watch_progress("kitsu:42", "anime", 240);
    same_episode.season = Some(1);
    same_episode.episode = Some(12);
    same_episode.position = 512.0;
    same_episode.duration = 1_440.0;
    same_episode.last_stream_lookup_id = Some("tt-correct-episode".to_string());
    same_episode.last_stream_url = Some("magnet:?xt=urn:btih:same12".to_string());

    let chosen = choose_watch_history_entry(vec![latest, other_episode, same_episode])
        .expect("history entry");

    assert_eq!(chosen.position, 512.0);
    assert_eq!(
        chosen.last_stream_lookup_id.as_deref(),
        Some("tt-correct-episode")
    );
    assert_eq!(
        chosen.last_stream_url.as_deref(),
        Some("magnet:?xt=urn:btih:same12")
    );
}

#[test]
fn choose_watch_history_entry_avoids_cooldown_source_backfill_for_same_episode() {
    let mut latest = mk_watch_progress("tt7654321", "series", 300);
    latest.season = Some(1);
    latest.episode = Some(4);

    let mut cooldown_source = mk_watch_progress("tt7654321", "series", 280);
    cooldown_source.season = Some(1);
    cooldown_source.episode = Some(4);
    cooldown_source.position = 900.0;
    cooldown_source.duration = 2_400.0;
    cooldown_source.last_stream_lookup_id = Some("cooldown-lookup".to_string());
    cooldown_source.last_stream_url = Some("https://bad.example/episode-4.m3u8".to_string());
    cooldown_source.source_name = Some("Bad CDN".to_string());

    let mut healthier_source = mk_watch_progress("tt7654321", "series", 260);
    healthier_source.season = Some(1);
    healthier_source.episode = Some(4);
    healthier_source.position = 860.0;
    healthier_source.duration = 2_400.0;
    healthier_source.last_stream_lookup_id = Some("healthy-lookup".to_string());
    healthier_source.source_name = Some("Good CDN".to_string());

    let source_health_priorities = HashMap::from([
        ("bad cdn".to_string(), 0_u8),
        ("good cdn".to_string(), 3_u8),
    ]);

    let chosen = choose_watch_history_entry_with_source_health(
        vec![latest, cooldown_source, healthier_source],
        Some(&source_health_priorities),
    )
    .expect("history entry");

    assert_eq!(chosen.position, 860.0);
    assert_eq!(chosen.duration, 2_400.0);
    assert_eq!(chosen.source_name.as_deref(), Some("Good CDN"));
    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt7654321"));
    assert_eq!(chosen.last_stream_url, None);
}

#[test]
fn choose_watch_history_entry_does_not_borrow_resume_time_from_other_episode() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 300);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut other_episode = mk_watch_progress("kitsu:42", "anime", 260);
    other_episode.season = Some(1);
    other_episode.episode = Some(11);
    other_episode.position = 420.0;
    other_episode.duration = 1_440.0;
    other_episode.last_stream_lookup_id = Some("tt-other-episode".to_string());
    other_episode.last_stream_url = Some("magnet:?xt=urn:btih:other11".to_string());

    let chosen = choose_watch_history_entry(vec![latest, other_episode]).expect("history entry");

    assert_eq!(chosen.position, 0.0);
    assert_eq!(chosen.duration, 0.0);
    assert_eq!(
        chosen.last_stream_lookup_id.as_deref(),
        Some("tt-other-episode")
    );
    assert_eq!(
        chosen.last_stream_url.as_deref(),
        Some("magnet:?xt=urn:btih:other11")
    );
}

#[test]
fn choose_watch_history_entry_requires_resume_threshold_before_treating_position_as_meaningful() {
    let mut latest = mk_watch_progress("tt7654321", "series", 300);
    latest.season = Some(1);
    latest.episode = Some(2);
    latest.position = 4.5;
    latest.duration = 1_200.0;

    let mut same_episode = mk_watch_progress("tt7654321", "series", 260);
    same_episode.season = Some(1);
    same_episode.episode = Some(2);
    same_episode.position = 420.0;
    same_episode.duration = 1_200.0;
    same_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    same_episode.last_stream_url = Some("https://cdn.example/episode-2.m3u8".to_string());

    let chosen = choose_watch_history_entry(vec![latest, same_episode]).expect("history entry");

    assert_eq!(chosen.position, 420.0);
    assert_eq!(chosen.duration, 1_200.0);
}

#[test]
fn choose_continue_watching_entry_prefers_resumable_episode_over_newer_zero_progress_episode() {
    let mut newer_zero_progress = mk_watch_progress("tt7654321", "series", 400);
    newer_zero_progress.season = Some(1);
    newer_zero_progress.episode = Some(5);
    newer_zero_progress.absolute_season = Some(1);
    newer_zero_progress.absolute_episode = Some(5);

    let mut resumable_episode = mk_watch_progress("tt7654321", "series", 350);
    resumable_episode.season = Some(1);
    resumable_episode.episode = Some(4);
    resumable_episode.absolute_season = Some(1);
    resumable_episode.absolute_episode = Some(4);
    resumable_episode.position = 1_020.0;
    resumable_episode.duration = 2_400.0;
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_continue_watching_entry(vec![newer_zero_progress, resumable_episode])
        .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn choose_continue_watching_entry_prefers_older_resume_over_newer_same_episode_startup_stub() {
    let mut startup_stub = mk_watch_progress("tt7654321", "series", 420);
    startup_stub.season = Some(1);
    startup_stub.episode = Some(4);
    startup_stub.absolute_season = Some(1);
    startup_stub.absolute_episode = Some(4);
    startup_stub.position = 12.0;
    startup_stub.duration = 2_400.0;

    let mut resumable_episode = mk_watch_progress("tt7654321", "series", 350);
    resumable_episode.season = Some(1);
    resumable_episode.episode = Some(4);
    resumable_episode.absolute_season = Some(1);
    resumable_episode.absolute_episode = Some(4);
    resumable_episode.position = 1_020.0;
    resumable_episode.duration = 2_400.0;
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_continue_watching_entry(vec![startup_stub, resumable_episode])
        .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn choose_continue_watching_entry_keeps_latest_episode_when_no_resumable_candidate_exists() {
    let mut latest = mk_watch_progress("tt7654321", "series", 400);
    latest.season = Some(1);
    latest.episode = Some(5);
    latest.absolute_season = Some(1);
    latest.absolute_episode = Some(5);
    latest.position = 180.0;
    latest.duration = 2_400.0;

    let mut older = mk_watch_progress("tt7654321", "series", 300);
    older.season = Some(1);
    older.episode = Some(4);
    older.absolute_season = Some(1);
    older.absolute_episode = Some(4);
    older.position = 120.0;
    older.duration = 2_400.0;

    let chosen =
        choose_continue_watching_entry(vec![latest, older]).expect("continue watching entry");

    assert_eq!(chosen.episode, Some(5));
    assert_eq!(chosen.last_watched, 400);
}

#[test]
fn choose_continue_watching_entry_prefers_more_resumable_progress_over_newer_item() {
    let mut deeper_resume = mk_watch_progress("tt7654321", "series", 350);
    deeper_resume.season = Some(1);
    deeper_resume.episode = Some(4);
    deeper_resume.absolute_season = Some(1);
    deeper_resume.absolute_episode = Some(4);
    deeper_resume.position = 1_020.0;
    deeper_resume.duration = 2_400.0;
    deeper_resume.last_stream_lookup_id = Some("tt7654321".to_string());

    let mut newer = mk_watch_progress("tt7654321", "series", 500);
    newer.season = Some(1);
    newer.episode = Some(7);
    newer.absolute_season = Some(1);
    newer.absolute_episode = Some(7);
    newer.position = 920.0;
    newer.duration = 2_400.0;

    let chosen = choose_continue_watching_entry(vec![newer, deeper_resume])
        .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}
#[test]
fn choose_exact_watch_progress_entry_prefers_exact_episode_match() {
    let mut exact = mk_watch_progress("kitsu:42", "anime", 250);
    exact.season = Some(1);
    exact.episode = Some(12);
    exact.absolute_season = Some(1);
    exact.absolute_episode = Some(12);
    exact.position = 512.0;
    exact.duration = 1_440.0;

    let mut other = mk_watch_progress("kitsu:42", "anime", 300);
    other.season = Some(1);
    other.episode = Some(13);
    other.absolute_season = Some(1);
    other.absolute_episode = Some(13);
    other.position = 720.0;
    other.duration = 1_440.0;

    let chosen = choose_exact_watch_progress_entry(
        vec![other, exact],
        "kitsu:42",
        "anime",
        Some(1),
        Some(12),
    )
    .expect("exact watch progress entry");

    assert_eq!(chosen.episode, Some(12));
    assert_eq!(chosen.position, 512.0);
}

#[test]
fn choose_exact_watch_progress_entry_ignores_newer_same_episode_startup_stub() {
    let mut startup_stub = mk_watch_progress("tt7654321", "series", 420);
    startup_stub.season = Some(1);
    startup_stub.episode = Some(4);
    startup_stub.absolute_season = Some(1);
    startup_stub.absolute_episode = Some(4);
    startup_stub.position = 12.0;
    startup_stub.duration = 2_400.0;

    let mut resumable_episode = mk_watch_progress("tt7654321", "series", 350);
    resumable_episode.season = Some(1);
    resumable_episode.episode = Some(4);
    resumable_episode.absolute_season = Some(1);
    resumable_episode.absolute_episode = Some(4);
    resumable_episode.position = 1_020.0;
    resumable_episode.duration = 2_400.0;
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_exact_watch_progress_entry(
        vec![startup_stub, resumable_episode],
        "tt7654321",
        "series",
        Some(1),
        Some(4),
    )
    .expect("exact watch progress entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn continue_watching_candidate_filters_finished_items() {
    let mut item = mk_watch_progress("tt100", "movie", 10);
    item.position = 950.0;
    item.duration = 1_000.0;
    assert!(!is_continue_watching_candidate(&item));

    item.position = 940.0;
    assert!(is_continue_watching_candidate(&item));
}

#[test]
fn continue_watching_candidate_filters_low_progress_startup_stub() {
    let mut item = mk_watch_progress("tt101", "movie", 10);
    item.position = 4.0;
    item.duration = 1_000.0;

    assert!(!is_continue_watching_candidate(&item));

    item.position = 5.0;
    assert!(is_continue_watching_candidate(&item));
}

#[test]
fn merge_keyed_progress_entries_prefers_newer_resume_snapshot() {
    let mut persisted = mk_watch_progress("tt100", "series", 100);
    persisted.season = Some(1);
    persisted.episode = Some(2);
    persisted.position = 120.0;

    let mut latest_resume = persisted.clone();
    latest_resume.last_watched = 180;
    latest_resume.position = 260.0;

    let mut extra_resume = mk_watch_progress("tt100", "series", 170);
    extra_resume.season = Some(1);
    extra_resume.episode = Some(3);
    extra_resume.position = 90.0;

    let merged = merge_keyed_progress_entries(
        vec![("series:tt100:1:2".to_string(), persisted)],
        vec![
            ("series:tt100:1:2".to_string(), latest_resume),
            ("series:tt100:1:3".to_string(), extra_resume),
        ],
    );

    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].0, "series:tt100:1:2");
    assert_eq!(merged[0].1.position, 260.0);
    assert_eq!(merged[1].0, "series:tt100:1:3");
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
