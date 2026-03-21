# Streamy Implementation Tracker

Last updated: 2026-03-21 (F1, F2, F3, F4, SS3, SS4, SS5, SS6, SS7, S5, S6, S7, PR2, PR3, PR4, DR4, DR5, DR6, DR7, DR8, DR1, DR2, DR3, C6, C1, C2, C3, C4, C5, A2, A5, A6, A9, A10, A11, A12, POL1, POL2, POL3, POL4, POL5, POL6, SM1, SM2, SM3, SM4, SM5, SM6, SM7, SM8, PC1, PC2, PC3, PC4, PC5, PC6, PC7, PC8, PC9, PC10, PC11, PC12, PC13, PC14, PC15, PC16, PC17, PC18, PC19, PC20, PC21, PC22, PC23, PC24, PC25, PC26, PC27, PC28, PC29, PC30, PC31, PC32, PC33, PC34, PC35, PC36, PC37, PC38, PC39, PC40, PC41, PC42, PC43, PC44, PC45, P12, P13, P14, P15, P16, P17, SE4, SD5, PC46, PC47, PC48, PC49, PC50, PC51, PC52, PC53, PC54, PC55, PC56, PC57, PC58, PC59, PC60, PC61, PC62 resolved)
Status key: [ ] Not started · [~] In progress · [x] Done · [!] Blocked

---

## PLAYER / COMMANDS MAINTENANCE

### POL5 — Multi-Addon Fallback + Selector/Input Polish

- Removed provider-side fallback requests to the public Torrentio endpoint when a configured addon returns 403; fallback probes now stay on the user-configured origin only
- Persisted stream-selector filters across sessions, with context-aware batch fallback and stale-addon filter reset so multi-addon browsing feels consistent
- Tightened addon-input UX in Settings with inline validation for invalid/configure/duplicate URLs and reduced media-card hover detail fetch eagerness

Status: [x]

### POL6 — Stream Open Feedback + Player Startup Copy

- Added compact stream-selector resolve feedback so selecting a stream now shows a focused opening or download state before player navigation
- Forwarded selected-stream labeling into the player route state so the player loader can explain which stream is opening instead of showing a generic spinner
- Upgraded player startup copy to distinguish saved-stream resume, stream resolution, episode-identity waiting, and local-file playback for a faster-feeling handoff

Status: [x]

### PC1 — Consolidate Per-Addon Stream Fetch Flow (commands.rs)

- Added shared helper `fetch_prepared_streams_for_addon(...)` for timeout/query-id retry + stream preparation
- Reused helper in both `get_streams` and `get_streams_for_addon` to remove duplicate fetch loops
- Preserved existing behavior: per-addon timeout, empty-stream continue, source labeling, and dedupe prep

Status: [x]

### PC2 — Consolidate Watch-History Read/Cleanup Path (commands.rs)

- Added shared helper `load_clean_history_entries(...)` to handle index migration/cleanup in one place
- Reused helper in `get_watch_history`, `get_watch_history_full`, and `get_watch_history_for_id`
- Removed repeated index-scrub loops while keeping sorting and dedupe behavior unchanged

Status: [x]

### PC3 — Canonical Episode Stream Coordinate Mapping (player.tsx)

- Added `buildEpisodeStreamCoordinates(...)` to normalize stream lookup id + imdb/absolute episode mapping
- Reused helper in next-episode prefetch, `playNext`, and inline stream selector state
- Reduced Kitsu/IMDb mapping duplication and kept playback routing behavior consistent

Status: [x]

### PC4 — Player Loading-State Simplification (player.tsx)

- Added shared `stopLoading(...)` and `markPlaybackReady(...)` helpers for MPV observer/init paths
- Replaced repeated inline state/ref toggles across `time-pos`, `duration`, `core-idle`, startup watchdog, and fallback reveal logic
- Kept UX unchanged while lowering cognitive load in startup/recovery code

Status: [x]

### PC5 — Case-Insensitive Stream Hash Dedup (frontend + backend)

- Normalized `infoHash`/`info_hash` dedup keys to lowercase in both frontend and backend merge paths
- Prevents duplicate cards/candidates when addon sources return the same hash with different casing
- Updated shared key helper usage to keep active resolve keys aligned with normalized hashes

Status: [x]

### PC6 — Segment Stream Item Rendering (new file)

- Extracted heavy `StreamItem` render/parsing block from `stream-selector.tsx` into new `src/components/stream-selector-item.tsx`
- Reduced selector file size and cognitive load without changing UI behavior or interactions
- Kept stream parsing heuristics and badge rendering logic intact

Status: [x]

### PC7 — De-duplicate Best-Resolve Addon Fetch Path (commands.rs)

- Added `fetch_prepared_streams_for_addon_best_effort(...)` and reused existing fetch helper in `resolve_best_stream`
- Removed repeated per-addon query loop logic while preserving best-effort fallback behavior
- Kept timeout/error handling non-fatal for aggregate best-stream resolution

Status: [x]

### PC8 — Add Regression Test For Hash-Case Dedup

- Added unit test `prepare_addon_streams_dedupes_hash_case_insensitively`
- Locks in normalized hash dedup behavior to avoid future regressions across addon sources

Status: [x]

### PC9 — Preserve Absolute Episode Context Into Player Resolve Paths

- Stream selector now forwards `absoluteEpisode` into player route state
- Player now consumes `absoluteEpisode` for auto-resolve, stale-link fallback resolve, and slow-start recovery resolve
- Play-next route state now carries `absoluteEpisode` for better continuity on long-running anime fallback lookups

Status: [x]

### PC10 — Segment Player Track Utilities (new file)

- Extracted track/language helper logic from `player.tsx` into `src/lib/player-track-utils.ts`
- Centralized normalization, language matching, and label formatting helpers for cleaner player flow
- Reduced local cognitive load in `player.tsx` without over-fragmenting the player render path

Status: [x]

### PC11 — Continue-Watching History Candidate Quality Selection

- Improved `get_watch_history` dedupe fallback to preserve playable episode context plus non-zero resume timestamps
- Series rows now prefer TT-backed lookup IDs, valid episode coordinates, and meaningful position/duration data
- Reduces `0:00` resume rows caused by latest-entry metadata drift

Status: [x]

### PC12 — Segment Player Episode Sidebar UI (new file)

- Extracted episode side panel + toggle control into `src/components/player-episodes-panel.tsx`
- Added `PlayerEpisodesToggleButton` to keep control-row button logic out of `player.tsx`
- Reduced in-file render density while preserving existing episode navigation UX

Status: [x]

### PC13 — Segment Player Progress Bar UI/Interaction (new file)

- Extracted progress bar rendering + pointer/hover interaction into `src/components/player-progress-bar.tsx`
- Removed inline hover/drag handler block from `player.tsx` and replaced with `PlayerProgressBar`
- Added RAF-throttled hover updates and drag-rect reuse to reduce high-frequency layout churn

Status: [x]

### PC14 — Stabilize Next-Episode Prefetch Trigger

- Added `hasPlaybackStarted` gate set via `markPlaybackReady(...)`
- Updated next-episode prefetch effect to depend on playback readiness instead of `duration` updates
- Reduces repeated prefetch effect churn while preserving prefetch behavior after playback actually starts

Status: [x]

### PC15 — Harden Saved Stream Metadata Writes

- Added synced refs for active stream URL + effective stream lookup ID in player
- Updated `saveProgress(...)` to write `last_stream_url` and `last_stream_lookup_id` from refs
- Avoids stale-closure metadata when users hot-swap streams inline during playback

Status: [x]

### PC16 — Restore Player Episodes Sidebar Season/Episode Resolution

- Expanded player details query enablement to include anime routes in addition to series
- Added sidebar current-episode fallback using absolute episode context when route season/episode is IMDb-mapped
- Added selected-season reconciliation so sidebar auto-falls back to a valid fetched season when route season is not present

Status: [x]

### PC17 — Segment Player Stream Recovery Flow

- Extracted stale-saved-stream fallback + slow-start watchdog logic into `src/hooks/use-stream-recovery.ts`
- Kept history-resume fresh-resolve behavior, bypass-cache recovery, and idle/startup recovery paths intact
- Separated recovery timers from generic UI timers so startup fallback is not canceled as soon as `loadfile` begins

Status: [x]

### PC18 — Split Player Auto-Track Preference Effects

- Replaced the combined audio/subtitle auto-application effect with separate audio and subtitle effects in `player.tsx`
- Preserved queued-switch gating so subtitle auto-selection waits for audio auto-switches to settle
- Reduced nested branching around track preference application without moving the main track-switch orchestration out of the player

Status: [x]

### PC19 — Consolidate Player PiP Restore Path

- Extracted Tauri Picture-in-Picture window sizing/restoration into `src/hooks/use-picture-in-picture.ts`
- Reused a single `exitPiPAndRestore()` path from both back-navigation and unmount cleanup
- Preserved PiP enter behavior: exit fullscreen first, close episode panel, then pin/resize the window

Status: [x]

### PC20 — Share Player Surface Cleanup Helpers

- Added shared player surface restoration helpers for cursor/background/fullscreen cleanup in `player.tsx`
- Reused them across navigation and MPV teardown paths to reduce duplicated DOM/window cleanup code
- Kept player teardown behavior intact while making cleanup responsibilities easier to reason about

Status: [x]

### PC21 — Centralize Continue-Watching Playback Planning

- Added shared `src/lib/history-playback.ts` helper for resume/history launches
- Reused the planner in `src/components/resume-section.tsx`, `src/components/media-card-context-menu.tsx`, and `src/pages/profile.tsx`
- Recovers lookup IDs, resume timestamps, and short-budget best-stream warmups without duplicating navigation logic

Status: [x]

### PC22 — Delay Resume Auto-Resolve Until Lookup Identity Is Ready

- Added `bypassResolveCache` route state support for stale saved-stream resumes in `src/pages/player.tsx`
- Player auto-resolve now waits for details-based IMDb enrichment when series/anime resume routes arrive without a usable lookup ID
- Prevents early no-stream failures from non-IMDb route IDs and stale cached best-stream results

Status: [x]

### PC23 — Harden Aggregated Watch-History Candidate Selection

- Added `choose_watch_history_entry(...)` in `src-tauri/src/commands.rs` to backfill episode context, resume time, stream URL, and lookup identity from nearby playable rows
- Hydrates fallback lookup IDs from canonical item IDs when safe so grouped history rows keep usable resume metadata
- Reduces `0:00` continue-watching cards and anime resume failures caused by grouped-history metadata drift

Status: [x]

### PC24 — Make Best-Stream Ranking Respect Source Order

- Added addon source-priority ranking in `resolve_best_stream(...)` so configured source order now participates in tie-breaking
- Increased best-stream candidate depth/time budget and added a small multi-audio preference bonus for otherwise-equal streams
- Added regression tests covering watch-history selection, source-order preference, and multi-audio preference

Status: [x]

### PC25 — Normalize Anime Stream Resolve Type Across UI/History

- Stream selector now normalizes Kitsu-backed `series` IDs to `anime` media type for addon stream queries
- Player stream resolve/recovery and nested selector routing now keep Kitsu-backed playback on the anime stream-lookup path
- History playback and media-card quick-play paths now normalize Kitsu-backed rows to anime for details/player routing + best-stream resolution

Status: [x]

### PC26 — Retry Across Anime Query-ID Fallbacks Per Addon

- `fetch_prepared_streams_for_addon(...)` no longer aborts on the first query-id timeout/error when multiple fallback IDs are available
- Added shorter timeout for non-primary fallback IDs to keep anime fallback retries responsive without regressing primary-series behavior
- Function now returns first non-empty prepared stream set and only surfaces an error when all candidate IDs fail

Status: [x]

### PC27 — Validation Sweep (Frontend + Rust)

- Verified frontend with `npm run lint` and `npm run build`
- Verified backend with `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test`
- Added regression coverage in provider tests for fallback-host gating behavior

Status: [x]

### PC28 — Fast-Path History Resume Planning

- Added cached/immediate lookup-ID fast path in `src/lib/history-playback.ts` so saved-stream resumes do not block on details enrichment before navigation
- Parallelized lookup-ID and precise-resume recovery, and overlapped quick best-stream resolution with resume-time recovery
- Changed resume-card warmups to use bounded quick resolves instead of long full resolves to avoid background contention with real playback

Status: [x]

### PC29 — Reliable Early Resume Seek Orchestration

- Added pause-for-resume startup path in `src/pages/player.tsx` when a meaningful resume timestamp is present
- Replaced one-shot resume seek with short retry orchestration that settles on early metadata arrival and releases playback once resume is applied or intentionally skipped near EOF
- Guarded follow-up resume attempts so late progress hydration can still correct the target without firing pre-init MPV commands

Status: [x]

### PC30 — Isolate Fresh Best-Stream Resolves From Cached In-Flight Requests

- Updated `src/lib/api.ts` so `resolveBestStream(..., { bypassCache: true })` uses a separate in-flight key instead of attaching to a normal cached resolve already in progress
- Keeps stale-link recovery and forced-fresh resume paths from accidentally reusing an older best-stream result

Status: [x]

### PC31 — Canonicalize Watch-History Series/Anime Types

- Added backend watch-progress type normalization in `src-tauri/src/commands.rs` so history rows store series/anime entries under one canonical series-like type
- Prevents mixed anime/series resume metadata drift across history aggregation and continue-watching flows
- Added regression test covering anime-to-series normalization for history rows

Status: [x]

### PC32 — Segment Commands Helper Logic (new files)

- Extracted stream helper logic from `src-tauri/src/commands.rs` into `src-tauri/src/commands/streaming_helpers.rs` (URL normalization, stream dedupe/prepare, query-id fallback construction, torrent file matching)
- Extracted watch-history helper logic into `src-tauri/src/commands/history_helpers.rs` (watch-progress sanitize/skip-save checks, resume metadata hydration, history candidate chooser)
- Replaced repeated store filename literals with shared store constants to reduce drift and keep command-store access consistent

Status: [x]

### PC33 — Stream Ranking Helper Segmentation + Resolve Flow Polish

- Moved stream ranking helpers (`build_addon_source_priority_map`, `stream_source_priority`, `stream_resolution_priority`) from `src-tauri/src/commands.rs` into `src-tauri/src/commands/streaming_helpers.rs`
- Reduced redundant work in `resolve_best_stream(...)` by computing stream query IDs once and cloning per-addon instead of rebuilding the same vector in each loop iteration
- Removed a duplicate `build_magnet(None, None)` unit test to reduce redundant test noise while preserving meaningful coverage

Status: [x]

### PC34 — Keep Explicit Empty Addon Lists Empty

- Changed addon config persistence to store an explicit empty list instead of deleting the key, so clearing all addons no longer resurrects legacy `torrentio_config` state on the next load
- Added load-time normalization for stored addon configs to recover blank IDs/names from the normalized addon URL/host without broad refactors
- Added regression tests covering explicit-empty resolution and stored addon normalization

Status: [x]

### PC35 — Harden Watch-Progress Type Validation

- Changed `sanitize_watch_progress(...)` to reject unsupported media types instead of silently persisting arbitrary strings into history data
- Applied the stricter sanitization consistently across history migration, save, import, and single-entry read paths so malformed rows are skipped instead of leaking downstream
- Added regression coverage for valid anime canonicalization and invalid-type rejection

Status: [x]

### PC36 — Fix Kitsu Episode Page Season Defaults

- Added a pure Kitsu episode-page builder that defaults an unspecified season to season 1 (or the first available season) instead of returning mixed-season episode pages
- Corrected `total` to represent the full episode count while keeping `total_in_season` season-scoped for UI paging
- Added provider tests covering default-season selection and total-count preservation

Status: [x]

### PC37 — Narrow Torrent Extra-File Heuristics

- Replaced broad `contains("sample" | "trailer")` file rejection with segment-aware extra-directory checks plus explicit sample/trailer filename handling
- Prevents valid titles like “Trailer Park Boys …” from being discarded during fallback file selection while still filtering obvious extras
- Added regression coverage for movie fallback selection with a title containing `trailer`

Status: [x]

### PC38 — Segment Store-Backed Command Helpers

- Extracted library, watch-status, and addon-config normalization/migration helpers from `src-tauri/src/commands.rs` into `src-tauri/src/commands/store_helpers.rs`
- Kept store keys, merge behavior, and import/export-facing normalization logic unchanged while reducing inline helper density in the command surface
- Makes store-backed command flows easier to audit without splitting actual Tauri command entry points across more files

Status: [x]

### PC39 — Segment List Models And Store Keys

- Moved `UserList`, `UserListWithItems`, and list store key/order helpers into `src-tauri/src/commands/list_helpers.rs`
- Keeps list persistence conventions local to one helper module while leaving command handlers in `src-tauri/src/commands.rs`
- Reduces structural noise in the main command file without over-fragmenting list behavior

Status: [x]

### PC40 — Move Command Tests Into A Dedicated Submodule

- Moved backend command unit tests from the bottom of `src-tauri/src/commands.rs` into `src-tauri/src/commands/tests.rs`
- Preserved existing coverage while keeping runtime code separate from test-only helpers and assertions
- Verified the extracted test module still passes through the normal `cargo test` flow

Status: [x]

### PC41 — Share Provider HTTP Client Construction

- Added shared provider client construction in `src-tauri/src/providers/mod.rs` so metadata providers use one timeout/user-agent/pool configuration path
- Reused the helper in Cinemeta, Kitsu, and Netflix instead of keeping near-identical `reqwest::Client::builder()` blocks in each file
- Collapsed Netflix catalog response mapping to one helper so both fetch paths stay aligned with a single item-conversion routine

Status: [x]

### PC42 — Harden Empty Detail Responses In Metadata Providers

- Changed Cinemeta and Kitsu detail-body parsing to treat `{}` or other missing-`meta` wrappers as a clean not-found path instead of surfacing a low-level serde missing-field error
- Preserved debug snippets for genuinely malformed JSON while replacing the user-facing empty-wrapper failure with `Metadata not found.`
- Added regression tests covering empty-object detail payloads for both providers

Status: [x]

### PC43 — Tolerate Empty Catalog Payload Objects

- Marked provider catalog wrappers with default `metas` handling so addon endpoints returning `{}` now degrade to an empty list instead of a parse failure
- Applied the guard consistently across Cinemeta, Kitsu, and Netflix catalog parsing paths
- Added provider tests covering empty-object catalog responses

Status: [x]

### PC44 — Normalize Duplicate Addon Config Entries On Load And Save

- Hardened addon-config normalization so duplicate URLs are collapsed and duplicate IDs for distinct URLs are repaired to a stable URL-backed ID
- Reused the same normalization on `save_addon_configs(...)` so malformed external/UI payloads do not persist broken addon identifiers back into settings
- Added regression coverage for duplicate URL collapse and duplicate-ID repair behavior

Status: [x]

### PC45 — Sanitize Loaded List Order Keys

- Hardened `load_lists_order(...)` to ignore blank and duplicate list IDs before command handlers consume ordering state
- Prevents malformed `lists_order` store entries from producing duplicate rows or invalid list lookups after import/manual store edits
- Kept list command flow unchanged for valid data while making corrupted store state degrade predictably

Status: [x]

---

## STREAMING QUALITY & MULTI-ADDON SCALING

### SM1 — Segment Stream Selector Core Logic

- Extracted stream filtering/sorting/stat helpers into `src/lib/stream-selector-utils.ts`
- Centralized capabilities: debrid-playable detection, source labels, quality bucketing, dedup keys
- Reduced `stream-selector.tsx` local complexity by removing duplicated helper logic

Status: [x]

### SM2 — Intelligent Batch/Episode Stream Management

- Added batch-aware filter mode (`episodes | packs | all`) in Stream Selector
- Default behavior auto-focuses episode-only streams for routed series episodes (packs hidden by default)
- Added PACK indicator badge to stream cards for quick visual distinction

Status: [x]

### SM3 — Multi-Addon Priority Controls in Settings

- Added explicit source priority controls (move up/down) in Streaming settings
- Added active source summary and order-impact hint to avoid hidden precedence confusion
- Persisted order immediately through existing addon config save pipeline

Status: [x]

### SM4 — Backend Addon Stream Pipeline Segmentation

- Refactored duplicated addon stream post-processing in `commands.rs` into shared helpers:
  `stream_dedup_key`, `prepare_addon_streams`, `merge_unique_streams`
- Wired helpers into `get_streams`, `get_streams_for_addon`, and `resolve_best_stream`
- Added unit tests for dedup key preference, addon stream preparation, and unique merge behavior

Status: [x]

### SM5 — Stream Lookup Continuity To Player

- Stream selector now passes `streamLookupId` when navigating to player
- Preserves multi-addon/debrid lookup identity for resume, stale-link recovery, and next-episode prefetch in player

Status: [x]

### SM6 — Working Drag Reorder For Stream Sources

- Replaced visual-only drag handle with active DnD ordering in Streaming settings
- Implemented `DndContext + SortableContext` ordering for addon rows while keeping move up/down controls
- Reordered priorities persist through existing addon save pipeline

Status: [x]

### SM7 — Addon Health Telemetry In Stream Selector

- Added per-addon health chips showing status, stream count, and fetch latency
- Added status summary (`healthy / degraded / offline`) and quick source filter toggle from telemetry chips
- Detects degraded sources on high latency or zero-result success responses

Status: [x]

### SM8 — Limit Provider Fallback Probes To Torrentio-Like Hosts

- Added host gating so `/stream/...` fallback probes only run for Torrentio-like addon hosts
- Added short per-request timeout and parallelized origin/public fallback probes to cap latency impact when fallback is used
- Preserved fallback behavior for Torrentio-style hosts while skipping expensive probes on non-Torrentio addons

Status: [x]

---

## TORRENT ENGINE

### T1 — Architecture Decisions (Locked)

- Embed `librqbit` directly (no sidecar, no Axum server)
- librqbit's built-in hyper HTTP server starts on `127.0.0.1:0` (OS-assigned port)
- Port stored in `TorrentManager`; `torrent_get_stream_url` returns `http://127.0.0.1:{port}/torrents/{id}/stream/{file_idx}`
- mpv opens that URL directly; Range requests + seek reprioritization handled by librqbit automatically
- All control ops (add/pause/resume/list/remove/settings) stay as Tauri commands — consistent with existing 50+ command surface
- Progress uses `Emitter::emit("torrent://progress", ...)` — same pattern as `download://progress`
- `TorrentManager` must mirror `DownloadManager` exactly (Arc/Mutex/HashMap, save_lock, app_handle)
- Persist to `torrents.json` with atomic tmp→rename writes (same as `downloads.json`)
- On startup: fastresume all incomplete sessions from `torrents.json`
- No seeding by default; auto-stop at completion unless user enables seeding in settings

Status: [ ]

---

### T2 — Rust Backend

#### T2-A TorrentManager struct (src-tauri/src/torrent.rs — new file)

- Fields: `session: Arc<librqbit::Session>`, `jobs: Arc<Mutex<HashMap<String, TorrentJob>>>`, `save_lock: Arc<Mutex<()>>`, `http_port: u16`, `app_handle: AppHandle`
- `TorrentJob`: id (uuid), title, poster, media_id, season, episode, status (TorrentStatus enum), info_hash, file_idx, file_path, created_at, speed, downloaded, total_size, seeders, peers
- `TorrentStatus` enum: Pending / Downloading / Paused / Completed / Error(String) — serde-serializable
- `new()`: start librqbit session, bind HTTP on 127.0.0.1:0, store port, call `load_jobs()`
- `load_jobs()`: read torrents.json, fastresume all non-completed/non-error jobs
- `save_jobs()`: atomic tmp→rename write, serialise under save_lock (identical to save_to_disk in downloader.rs)
- Spawn progress-emit loop per active job: emit `torrent://progress` every 500ms while downloading

Status: [ ]

#### T2-B Tauri Commands (src-tauri/src/commands.rs additions)

```
get_torrent_settings      → TorrentSettings from settings.json
save_torrent_settings     → persist TorrentSettings to settings.json, clear torrent state if needed
torrent_add               → add magnet/hash, returns job id
torrent_list              → Vec<TorrentJob>
torrent_pause             → pause by id
torrent_resume            → resume by id
torrent_stop              → stop + remove from session (keep file)
torrent_remove            → stop + optionally delete file
torrent_list_files        → list files inside a torrent by job id
torrent_select_files      → set priority / enable only selected files
torrent_get_stream_url    → returns http://127.0.0.1:{port}/torrents/{id}/stream/{file_idx}
```

- Register all 10 in `lib.rs` `invoke_handler!` block
- `manage(TorrentManager::new(handle.clone()))` in `lib.rs` setup block

Status: [ ]

#### T2-C TorrentSettings struct

```
max_peers: u32           default 150
max_connections: u32     default 50
dht_enabled: bool        default true
seeding_enabled: bool    default false
default_save_path: String
```

- Persisted under `"torrent_settings"` key in settings.json via `tauri-plugin-store`

Status: [ ]

#### T2-D librqbit wiring in Cargo.toml

- Add: `librqbit = { version = "...", features = ["http-api"] }` (check latest compatible version)
- Confirm tokio feature set covers librqbit's async runtime requirements
- Verify no conflict with existing `tauri-plugin-libmpv` DLL linkage on Windows

Status: [ ]

---

### T3 — Torrentio Compatibility (torrentio.rs updates)

- `get_streams` already accepts `config_url`; add a `mode: StreamMode` param (`Debrid | Torrent`)
- When mode = `Torrent`: call `merge_torrent_capable_unique` unconditionally (method already exists)
- If configured URL returns no `info_hash` entries AND mode = `Torrent`: query fallback URL automatically
- Default fallback: `https://torrentio.strem.fun/qualityfilter=unknown,cam,scr,480p`
- `get_streams` in `commands.rs`: read `stream_mode` from settings.json, pass through
- Frontend `stream-selector.tsx`: read mode from settings / local state, pass `stream_mode` arg to `get_streams`

Status: [ ]

---

### T4 — Frontend

#### T4-A Stream Selector Toggle (stream-selector.tsx)

- Add `Debrid | Torrent` pill toggle at top of StreamSelector
- When `Torrent`: filter displayed streams to those with `infoHash` or magnet URL
- When `Torrent` + user selects stream: call `torrent_add` instead of `resolve_stream`
- Return value of `torrent_add` = job id; call `torrent_get_stream_url(job_id, file_idx)` to get playback URL
- Navigate to player with that URL, `isOffline: false`, `format: "video/mp4"`
- Persist last-used mode to localStorage (`streamy_stream_mode`)
- Empty state when no torrent-capable streams found: "No torrent sources found. Add a torrent-capable Torrentio URL in Settings."

Status: [ ]

#### T4-B Torrent Context (src/contexts/torrent-context.tsx — new file)

- Mirror `DownloadContext` exactly
- Subscribe to `torrent://progress` Tauri events, update local state
- Expose: `torrentJobs`, `activeCount`, `addTorrent`, `pauseTorrent`, `resumeTorrent`, `stopTorrent`, `removeTorrent`, `getStreamUrl`
- Register `TorrentProvider` in `App.tsx` wrapping routes (same level as `DownloadProvider`)

Status: [ ]

#### T4-C Downloads Page (downloads.tsx)

- Add "Torrents" tab alongside existing Active / Completed tabs
- `TorrentCard` component: show poster, title, S/E badge, progress bar, speed (MB/s), peers, seeders, ETA, status chip
- Pause / Resume / Stop / Remove actions per card
- "Play" button on completed torrent jobs (calls `torrent_get_stream_url`)
- Active torrent count badge on sidebar Downloads icon (combine with active HTTP download count)

Status: [ ]

#### T4-D Player Integration (player.tsx)

- No changes needed to core render path — torrent stream URL is a plain HTTP URL
- `recoverFromSlowStartup` / stale link recovery should treat torrent URLs as non-bypassable (localhost URL, never stale)
- Add guard: if `activeStreamUrl` starts with `http://127.0.0.1:`, skip `shouldBypassSavedStream` check entirely

Status: [ ]

#### T4-E Settings Panel (settings.tsx)

- New `TorrentConfig` component (mirrors `TorrentioConfig` component pattern)
- Controls: Default mode toggle (Debrid / Torrent), max peers slider, seeding toggle, default save path picker
- Save via `save_torrent_settings` command
- Load via `get_torrent_settings` command on mount
- Place in Settings page between Torrentio section and Keyboard Shortcuts

Status: [ ]

---

### T5 — Hardening & Edge Cases

- [ ] Startup watchdog: if librqbit session init fails (port bind error), log and disable torrent mode gracefully — do not crash app
- [ ] Fastresume failures (corrupt resume data): catch per-job, mark job as Error, continue others
- [ ] Peer health check: if job has 0 peers after 60s, emit `torrent://state` with `low_peers` flag — frontend toasts "Low peer count, stream may be slow"
- [ ] Batch packs: on `torrent_add`, only enable file matching the requested season/episode; other files set to `Priority::Skip`
- [ ] Next-episode warm: when `nextEpisodePrefetchRef` fires in player, also call `torrent_add` with next ep index if current job is a batch pack, pre-seed buffer
- [ ] On app quit (Tauri `on_window_event CloseRequested`): pause all active torrent sessions cleanly before exit
- [ ] Torrent URLs must never be saved to `last_stream_url` in watch progress (localhost URL is meaningless after restart)

Status: [ ]

---

### T6 — Integration Test Checklist

- [ ] Magnet link resolves → stream URL works in mpv
- [ ] Seek forward 10 min doesn't stall (librqbit reprioritizes pieces)
- [ ] Pause job → resume → continues from correct byte offset
- [ ] App restart → fastresume restores in-progress job
- [ ] Batch pack → only requested episode file is downloaded
- [ ] Torrent job appears in Downloads page with live speed/peer count
- [ ] Watch history records correct `last_stream_lookup_id` (not localhost URL)
- [ ] Debrid mode unaffected by torrent feature (regression test)

Status: [ ]

---

## PLAYER FIXES & ENHANCEMENTS

### P1 — In-Player Stream/Quality Hot-Swap

- Add swap icon in player controls (next to settings gear)
- Opens inline popover with same stream list (reuse `StreamSelector` component, `inlineMode` prop)
- On selection: call `resolve_stream`, swap `activeStreamUrl`, seek to `currentTimeRef` value
- `showStreamSelector` state + `selectedEpisodeForStream` already exist — wire them up
- Status: [ ]

### P2 — Subtitle File Loading (in-player)

- "Load subtitle file…" option in subtitle track menu
- Use `tauri-plugin-dialog` (already dep) to open `.srt / .ass / .vtt` file picker
- Send path to mpv via `sub-add` command
- Status: [ ]

### P3 — Resume Toast via OSD

- When `resumeFromHistory = true` and `startTime > 60`, call `triggerOsd` with "Resuming from HH:MM:SS"
- OSD system already exists (triggerOsd L722 in player.tsx) — trivial to wire
- Status: [x]

### P4 — Escape Key Dismisses Up-Next

- `handleKeyDown` (L1347) does not wire Escape → `dismissUpNext` when `showUpNext` is true
- Add: `if (e.key === 'Escape' && showUpNext) { dismissUpNext(); return; }`
- Status: [x]

### P5 — Ephemeral Subtitle Settings Persist

- Subtitle delay, position, scale reset every session
- Persist to localStorage under `streamy_subtitle_prefs` keyed by `{delay, pos, scale}`
- Apply on player init before first frame
- Status: [ ]

### P6 — Auto-Play Episode Limit ("Still Watching?")

- Configurable in Settings: "Stop auto-playing after N episodes" (default off)
- Counter increments on each `playNext()` call; resets on manual navigation
- At limit: pause, show "Still watching?" modal, reset counter on confirm
- Status: [ ]

### P7 — Audio Normalization Toggle

- Expose mpv `af=loudnorm` as a toggle in the audio menu panel
- Store preference in localStorage `streamy_audio_norm`
- Apply via mpv `set_property("af", "loudnorm")` / `""`
- Status: [ ]

### P8 — Startup Watchdog Teardown Audit

- `startupWatchdogTimerRef` (L478) — verify it is cleared in `clearTimers` (L691)
- If not: ghost recovery attempt can fire after successful playback start
- Status: [ ]

### P9 — Torrent URL Bypass in Stale Link Check

- `shouldBypassSavedStream` must return false when URL starts with `http://127.0.0.1:`
- Add guard at top of function in `api.ts`
- Status: [x]

### P10 — `last_watched` Timestamp Unit Bug Audit

- `WatchProgress.last_watched` is `u64` Unix **seconds** in Rust
- `shouldBypassSavedStream` compares against `Date.now()` (milliseconds)
- Verify all frontend consumers multiply `last_watched * 1000` before comparing to `Date.now()`
- Check: `resume-section.tsx`, `profile.tsx` (HistoryListRow L772), `media-card-context-menu.tsx` (L222)
- Status: [ ]

### P11 — SAVED_STREAM_HTTP_MAX_AGE_MS Too Aggressive

- Current: 6h — forces re-resolve even for valid RealDebrid links (typically 24–72h TTL)
- Increase to 20h or make configurable per debrid provider
- Implemented: increased the frontend stale-link bypass threshold in `src/lib/api.ts` from 6h to 20h so valid RealDebrid links are reused longer before a forced fresh resolve.
- Status: [x]

### P12 — Track-List Dedup + Normalization For Audio/Subtitle Menus

- Player now normalizes MPV `track-list` payloads and de-dupes repeated `type:id` entries before rendering
- Prevents duplicated audio/subtitle rows caused by duplicate observer payload variants
- Keeps deterministic ordering for stable menu rendering

Status: [x]

### P13 — Confirmed Track Switching (No Optimistic Success Toast)

- `setTrack` now writes MPV property and verifies effective selection via `getProperty('track-list', 'node')`
- Success toast is only shown after switch confirmation; failures now report as actual switch failures
- Removed optimistic local selected-track mutation that could drift from real MPV state

Status: [x]

### P14 — Track Switch UX Hardening

- Added per-type in-flight guards so concurrent track switch requests cannot race each other
- Audio/subtitle buttons disable while switching and show spinner on active row
- Duplicate-visible labels are disambiguated (`Label #id`) so users can pick the intended track reliably

Status: [x]

### P15 — Prevent Auto Track-Pref Retry Loops

- Auto language preference application now marks attempts as completed per stream even when no matching track exists or switch verification fails
- Prevents repeated silent retry loops that could spam MPV commands and destabilize playback sessions

Status: [x]

### P16 — Continue Watching Resume Precision + Prewarm

- Resume cards now fetch precise per-episode progress when card-level position is `0:00` before navigation
- When saved links are stale, resume flow now prewarms `resolve_best_stream` with cache bypass for faster startup feedback
- Applied the same resume-position and stale-link prewarm safeguards across profile history rows and media-card context-menu resume actions

Status: [x]

### P17 — Runtime Stale-Link Recovery Hardening In Player

- Added `idle-active` recovery path to react to mid-session stream disconnects and attempt intelligent fallback
- Slow-start / stale-link recovery now bypasses cached `resolve_best_stream` results to avoid reusing broken URLs
- History-resume startup watchdog now triggers earlier for faster recovery UX

Status: [x]

---

## DOWNLOADS FIXES & ENHANCEMENTS

### D1 — ETA Rendered on Download Cards

- `calculateEta` (L46 downloads.tsx) exists but verify it is rendered in `DownloadCard` JSX
- Add "~X min left" label below progress bar if ETA > 0 and status = downloading
- Status: [ ]

### D2 — Retry Failed Downloads

- "Retry" button on Error-status cards
- Re-resolve stream URL if `last_stream_url` is stale (call `resolve_best_stream`), then restart download
- Status: [ ]

### D3 — Download Completion System Notification

- Add `tauri-plugin-notification` to Cargo.toml
- On `DownloadStatus::Completed` transition in `spawn_download_task`: emit OS notification with title + "Play Now" action
- Frontend notification preference toggle in Settings
- Status: [ ]

### D4 — Sidebar Badge Shows Error Count

- Currently badge only counts `downloading | pending | paused`
- Add red dot indicator for error-status downloads so users notice failures
- Status: [ ]

### D5 — "Open with System Player" Context Menu

- On completed downloads: right-click → "Open with system player"
- Use `tauri-plugin-opener` (already dep) to shell-open the file path
- Status: [ ]

### D6 — Auto-Delete After Watching

- Settings toggle: "Delete downloaded file after watching"
- `save_watch_progress` command: if progress ≥ 95% AND `is_local_file` AND setting enabled → schedule deletion after configurable grace (default 7 days)
- Store pending-deletion list in settings.json; check on startup
- Status: [ ]

### D7 — Storage Usage Bar

- New `get_disk_stats` Tauri command: returns `{ used_bytes: u64, available_bytes: u64 }` using `std::fs::metadata` on download directory
- Render visual storage bar in Downloads page header
- Status: [ ]

---

## SEARCH & DISCOVERY

### S1 — "Similar Titles" Row on Details Page

- `relations` field already exists on `MediaDetails` struct (mod.rs) and is fetched by Kitsu provider
- Cinemeta does not populate it — fine, show row conditionally when `relations.length > 0`
- Render as horizontal `MediaRow` at bottom of Details page: "You Might Also Like"
- Status: [ ]

### S2 — Rich Recent Search History

- Change `recentSearches` from `string[]` to `{query, poster, type, id}[]`
- Store on each search confirm in `addToRecent`
- Render tiny poster thumbnail next to query text in suggestions dropdown
- Status: [ ]

### S3 — Multi-Provider Unified Search

- "Search All" mode fires Cinemeta + Kitsu queries in parallel (already done per-type separately)
- Deduplicate by id, show source badge (Cinemeta / Kitsu) per result
- Status: [ ]

### S4 — Hero Auto-Rotate Pauses on Hover

- `Hero` component rotates every 10s unconditionally
- Clear interval on `mouseenter`, restart on `mouseleave`
- Status: [x]

### S5 — Calendar Movie Date Precision

- Movies with full `YYYY-MM-DD` year string placed on Jan 1 (calendar.tsx L63–79)
- Parse full date when available from `releaseInfo` field; fall back to Jan 1 only for year-only strings
- Implemented: `calendar.tsx` now parses full `YYYY-MM-DD` release strings when present and only falls back to Jan 1 when the value is year-only (or year-range text). This preserves exact movie calendar placement without regressing partial-date inputs.
- Status: [x]

### S6 — Calendar Includes "Watching" Status Items

- Calendar currently only uses library items
- Also include items with `watchStatus = 'watching'` from `allWatchStatuses`
- Implemented: Added `watch-statuses` + `watch-history` queries to `calendar.tsx` and merged `'watching'` items (when metadata is available from history) into the schedulable set, deduplicated with library entries by `{type}:{id}`.
- Status: [x]

### S7 — Hero Scroll/Transition Stability

- Throttled hero scroll-opacity updates in `src/components/hero.tsx` with `requestAnimationFrame` to reduce scroll-driven rerenders on the Home page
- Added transition-timeout cleanup so rapid slide changes/unmounts cannot leave stale delayed state updates behind
- Switched hero rendering/prefetching to a safe derived active index so shrinking hero item arrays do not blank the banner between query refreshes
- Status: [x]

---

## PROFILE & LIBRARY

### L1 — Watch Time Analytics Tab

- New "Stats" tab in Profile
- Compute from existing watch history (position + duration per item, last_watched timestamps):
  - Total hours watched
  - Watch streak (days-in-a-row from last_watched)
  - Completion rate (items with progress ≥ 95% / total)
  - Most-watched type (movie vs series vs anime)
  - Activity heatmap grid (GitHub-style, last 12 weeks)
- All computable client-side from data already stored — no new backend needed
- Status: [ ]

### L2 — Library Genre & Year Filters

- Add genre and year filter pills to library tab
- Source genre/year from cached `details` queries (already prefetched for calendar)
- Status: [ ]

### L3 — Arc / Saga Grouping for Long-Running Series

- In Details episode list: group by arc for series with 100+ episodes
- Static arc-range config for top 20 shows (lookup by IMDB ID); fallback groups of 25
- Collapsible arc sections in episode list
- Status: [ ]

### L4 — Profile "Member Since" Full Date

- `memberSince` is an ISO date string; profile currently renders only year
- Use `date-fns format(parseISO(...), 'MMMM yyyy')` — date-fns already in deps
- Status: [ ]

### L5 — Episode Completion Watch Status Prompt

- After player saves progress ≥ 90% for final episode of a season: toast "You finished Season N of X — mark as Completed?"
- Confirm → call `set_watch_status`
- Status: [ ]

---

## SETTINGS ENHANCEMENTS

### SE1 — Player Settings Section

- Surface in Settings (currently only accessible in-player):
  - Default playback speed
  - Hardware decoding toggle (currently hardcoded `hwdec: 'auto'` in player.tsx L1614)
  - Subtitle font size default
  - Audio normalization default
- Persist via existing `save_playback_language_preferences` pattern (extend or add new command)
- Status: [ ]

### SE2 — Startup Behavior Settings

- Launch page selector: Home / Resume Watching / Search / Downloads
- Restore last window size on launch (save dimensions to settings.json on resize)
- Status: [ ]

### SE3 — Toast Duration Consistency

- Toast durations scattered: 6000, 8000, default across codebase
- Export single `TOAST_DURATION = { short: 4000, normal: 6000, long: 9000 }` from `utils.ts`
- Replace all hardcoded durations
- Status: [ ]

### SE4 — Addon/History Cache Invalidation Audit

- Replaced incorrect `['streams']` invalidation in `settings.tsx` with `['streamsByAddon']` so Stream Selector source changes invalidate the actual query family it uses
- Removed duplicate post-add invalidation from the add-addon success callback and kept the shared mutation success path as the single cache refresh source
- Expanded history clear/import invalidation to include `['watch-history-for-id']` so Details page episode-progress caches refresh immediately after data wipes or backup restore
- Status: [x]

---

## STABILITY & ARCHITECTURE

### A1 — React Error Boundaries

- No `ErrorBoundary` anywhere in App.tsx or Layout
- A crash in Details or Player renders blank screen with no recovery path
- Wrap each route in `<ErrorBoundary fallback={<ErrorFallback />}>` with "Go back" button
- Status: [ ]

### A2 — mini-player stub cleanup

- `player-context.tsx` is explicitly a stub ("full implementation lives in mini-player feature branch")
- Dead refs: `mpvPreservedRef`, `togglePlayRef`, `playerRoute`, `playerLocationState`
- Either implement mini-player or delete stub + refs; currently causes confusion during code reading
- Implemented: Removed the unused `src/contexts/player-context.tsx` stub entirely after verifying there are no imports/usages left in the app. This eliminates dead mini-player API surface and avoids future readers assuming a real shared player context exists.
- Status: [x]

### A3 — Manga Pages Dead Code

- `src/pages/manga/` (index.tsx, details.tsx, reader.tsx) exist but index.tsx is empty and no routes registered in App.tsx
- Remove directory entirely or register routes and stub content
- Status: [ ]

### A4 — Stream Cache Disk Persistence

- `Torrentio` stream cache is in-memory only; lost on restart
- Persist `HashMap<String, CachedStreams>` to a `stream_cache.json` in app data dir on write
- Load on `Torrentio::new()` with TTL eviction applied at load time
- Status: [ ]

### A5 — `useOnlineStatus` Scope Gaps

- `useOnlineStatus` used in home.tsx and search.tsx but not in:
  - `stream-selector.tsx` — still fires `get_streams` when offline
  - `resume-section.tsx` warmup effect — fires `resolveBestStream` when offline
- Add online guard to both
- Implemented: Added `useOnlineStatus` guard in `stream-selector.tsx` so streams query only runs when online, with an explicit offline empty state. Added online guard in `resume-section.tsx` warmup effect so speculative `resolveBestStream` calls are skipped while offline.
- Status: [x]

### A6 — REDIRECT_CLIENT Timeout Reduction

- Current: `connect_timeout(10s)`, `timeout(20s)` on HEAD requests in `resolve_final_direct_url`
- A stalled debrid CDN will block resolution for 20s — very noticeable in UI
- Reduce to `connect_timeout(5s)`, `timeout(8s)` with single retry
- Implemented: Updated shared `REDIRECT_CLIENT` in `commands.rs` to `connect_timeout(5s)` and `timeout(8s)`. The existing HEAD→GET fallback still provides a second attempt path, but worst-case wait time per request path is now substantially lower under stalled CDN responses.
- Status: [x]

### A7 — Tauri Capabilities Audit

- Review `src-tauri/capabilities/` — verify CSP does not allow arbitrary inline scripts
- Confirm `tauri-plugin-http` allowed origins are restricted (no wildcard in production)
- Status: [ ]

### A8 — libmpv DLL Version Audit

- `tauri-plugin-libmpv = "0.3.2"` + custom `libmpv-2.dll` in `src-tauri/`
- DLL version mismatch is a silent crash source on fresh installs
- Document required DLL version in README; add startup version check
- Status: [ ]

### A9 — Incognito Client-State Cleanup De-duplication

- Added `src/lib/privacy-utils.ts` with a shared `clearIncognitoClientState(...)` helper for recent-search and watch-history cache cleanup
- Replaced duplicated side-effect logic in `layout.tsx` and `sidebar.tsx` with the shared helper
- Expanded cleanup to remove `watch-history-full` and `watch-history-for-id` caches in addition to the top-level history list
- Status: [x]

### A10 — `useOnlineStatus` Listener Consolidation

- Replaced per-consumer `useState + useEffect` online/offline listeners with a `useSyncExternalStore` implementation in `src/hooks/use-online-status.ts`
- This removes repeated event-listener setup across Home, Search, Resume, and Stream Selector while remaining SSR-safe
- Status: [x]

### A11 — Local Profile Storage Hardening

- `src/hooks/use-local-profile.ts` now sanitizes loaded/saved profile payloads (username, bio, accent color, memberSince) instead of trusting raw localStorage JSON
- Default `memberSince` now matches its documented ISO-string shape, and legacy year-only values are normalized during load
- `ProfileSettingsPopover` now keeps accent-color edits local until Save, preventing partial invalid hex values from being persisted and applied live throughout the Profile page
- Status: [x]

### A12 — Backend Dead-Path And Dedupe Cleanup

- Removed the unused Real-Debrid transcoding response type and method from `src-tauri/src/providers/realdebrid.rs` after verifying there were no call sites anywhere in the backend
- Extracted named stream-identity helpers in `src-tauri/src/providers/torrentio.rs` so provider dedupe paths no longer rely on repeated inline equality blocks
- Left the rest of the backend unchanged after audit where the existing structure was already coherent and clippy-clean
- Status: [x]

---

## NICE-TO-HAVE / BACKLOG

### N1 — Boss Key Global Shortcut

- `tauri-plugin-global-shortcut` (add dep)
- Configurable hotkey (default F12): pause mpv, mute mpv, minimize window
- Status: [ ]

### N2 — In-Player Screenshot

- Camera icon or PrintScreen hotkey → mpv `screenshot` command → save to Pictures folder
- Toast with "Show in folder" action using `open_folder`
- Status: [ ]

### N3 — Random Episode Button

- Dice icon on Details page for series
- Picks random unwatched episode, opens StreamSelector for it
- Status: [ ]

### N4 — Multiple Debrid Provider Support

- `DebridProvider` trait (mirrors `Provider` trait)
- Add AllDebrid or Premiumize as alternative providers
- `DebridConfig.provider` enum already exists in commands.rs
- Status: [ ]

### N5 — Keyboard-First Navigation

- Arrow key navigation in media rows, Enter to open Details
- Tab-based focus rings on cards
- `?` key opens shortcut reference modal (APP_SHORTCUTS + PLAYER_SHORTCUTS already defined in settings.tsx)
- Status: [ ]

### N6 — "Mark Watched Up To Here" Episode Right-Click

- Right-click any episode card in Details → "Mark watched up to here"
- Calls `set_watch_status` for all previous episodes up to this one
- Status: [ ]

---

## REFERENCE

- rqbit repo: https://github.com/ikatson/rqbit
- librqbit docs: https://docs.rs/librqbit/latest/librqbit/
- Files touched for torrent: `src-tauri/src/torrent.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/Cargo.toml`, `src/contexts/torrent-context.tsx` (new), `src/components/stream-selector.tsx`, `src/pages/downloads.tsx`, `src/pages/settings.tsx`, `src/lib/api.ts`
- Files NOT to touch for torrent: `player.tsx` (beyond P9 guard), `downloader.rs`, existing `commands.rs` stream resolution flow

---

## STREAM SELECTOR DEEP FINDINGS

### SS1 — Debrid Mode Filter Is Too Strict (isDebridCapable)

- `isDebridCapable` filters to only cached or direct-HTTP streams before any display
- Streams with `infoHash` only (no `cached`, no direct URL) are silently dropped from the list
- In Torrent mode these are exactly the streams we want — `isDebridCapable` must not apply when mode = `Torrent`
- Fix: branch the base filter in `debridStreams` memo on `streamMode`
- Status: [ ]

### SS2 — StreamSelector Has No "No Results" Empty State for Torrent Mode

- When `debridStreams.length === 0` and mode = `Torrent`: current UI shows generic empty state
- Add specific message: "No torrent-capable streams found. Make sure your Torrentio URL supports P2P metadata (infoHash)."
- Status: [ ]

### SS3 — Seeder Count Not Displayed on Stream Items

- `stream.seeders` is parsed and stored (hydrate_stream in torrentio.rs), surfaced on `TorrentioStream`
- `StreamItem` component never renders seeder count — only size label and source label shown in meta row
- Add seeder count badge next to size label: `🌱 142` when `stream.seeders > 0`
- Implemented: `StreamItem` now renders a `🌱 {seeders}` meta badge in the stream row when `seeders > 0`, improving torrent quality/health visibility while browsing candidates.
- Status: [x]

### SS4 — Filter State Not Reset on Close/Reopen

- `qualityFilter`, `sourceFilter`, `sortMode` are component-level state, not reset when dialog closes and reopens for a different episode
- A user who filtered to "1080p" for one episode reopens the selector on a 4K-only episode and sees nothing
- Reset all three to defaults in a `useEffect` on `open` becoming true
- Status: [x]

### SS5 — resolveStreamCandidate Fires for Direct HTTP Streams Unnecessarily

- When `stream.url?.startsWith('http')` is true (direct URL), `resolveStreamCandidate` still calls `api.checkApiKeys()` unconditionally before the early-return
- This adds a redundant Tauri IPC round-trip for every direct-URL stream click
- Move `checkApiKeys` guard inside the `if (!url)` branch only
- Status: [x] — `checkApiKeys` already gated inside `if (!url)` branch; no extra IPC for direct-URL streams

### SS6 — StreamSelector staleTime is 5 min but bestStreamCache TTL is 8 min

- React Query `staleTime: 1000 * 60 * 5` for `get_streams` query in StreamSelector
- Frontend `BEST_STREAM_CACHE_TTL_MS = 1000 * 60 * 8` for best-stream cache
- Rust-side `STREAM_CACHE_TTL` (torrentio.rs) may differ — verify all three are consistent
- Recommend: streams cache 3 min (React Query), best-stream 8 min, Rust 5 min
- Implemented: StreamSelector `get_streams` query stale time is now `3 min`, aligned with frontend streams cache TTL (`STREAMS_CACHE_TTL_MS = 3 min`) and Rust provider stream-cache TTL (`STREAM_CACHE_TTL = 180s`). Best-stream TTL remains `8 min`.
- Status: [x]

### SS7 — Reset StreamSelector State On Session Identity Change

- Added an open-session identity guard in `src/components/stream-selector.tsx` keyed by media/episode context
- When the selector opens for a different media item or episode, filters and in-flight resolve UI now reset even if the parent changed props without the selector driving the close path
- Prevents stale quality/addon filter state from bleeding into the next stream-selection session
- Status: [x]

---

## COMMANDS.RS DEEP FINDINGS

### C1 — resolve_stream Does Not Validate magnet Parameter

- `resolve_stream` receives `magnet: String` — if caller passes empty string AND no `url`, `build_magnet` returns `None`
- `resolve_stream_inner` then falls through to `add_magnet` with an empty string, producing a confusing RD error
- Add early validation: if `magnet.trim().is_empty() && url.is_none()` return `Err("No stream source provided")`
- Implemented: Added an early source-validation guard in `resolve_stream` that requires at least one valid source (`url` normalizes to http/https OR `build_magnet(...)` succeeds from magnet/info-hash). Invalid payloads now fail fast with a clear error before any RD API calls.
- Status: [x]

### C2 — get_app_config Returns Stale Data After Settings Changes

- `get_app_config` reads from `settings.json` store on every call but the frontend caches it via React Query with a long staleTime
- After `save_debrid_config` or `save_torrentio_config`, the `get_app_config` cache is not invalidated
- Check all settings mutation `onSuccess` handlers — add `queryClient.invalidateQueries({ queryKey: ['appConfig'] })` where missing
- Implemented: Added `queryClient.invalidateQueries({ queryKey: ['appConfig'] })` to `onSuccess` handlers in both `PlaybackLanguageConfig` (language pref save) and `TorrentioConfig` (save + clear mutations) in `settings.tsx`. Each handler now invalidates `['appConfig']` in addition to its own specific query key, ensuring any future consumer of `get_app_config` always sees fresh data immediately after a settings mutation.
- Status: [x]

### C3 — find_best_matching_file Fallback Is "Largest File" Not "Most Video-Like"

- When no SxxExx / NxN / Exx pattern matches, `find_largest_file_idx` returns the biggest file by byte count
- For batch packs with extras/featurettes, the largest file might not be the episode (e.g. a making-of can be large)
- Improve fallback: prefer largest file that also passes `is_valid_video` check before falling back to absolute largest
- Implemented: Added `find_largest_video_file_idx` helper in `commands.rs` that filters to selected files with a recognised video extension (mp4/mkv/avi/webm/mov/m4v/ts) and excludes sample/trailer files, then picks the largest among them; falls back to `find_largest_file_idx` only when no valid video file is found. Both the movie early-return path and the step-4 fallback in `find_best_matching_file` now call this helper instead of `find_largest_file_idx` directly.
- Follow-up hardening: strict `SxxExx` and `NxN` passes now prefer non-extras paths first (with extras as fallback), and extension parsing now requires a real `.ext` suffix to avoid false positives like filenames ending in `_mkv`.
- Status: [x]

### C4 — BEST_STREAM_CANDIDATE_TIMEOUT_SECS = 10 Is Shared for All Candidates

- All 3 candidate attempts use the same 10s timeout
- First candidate (cached/best) could reasonably have a tighter 6s timeout; fallback candidates warrant the full 10s
- Reduces worst-case resolution time from 30s (3×10s all timeout) to ~22s
- Implemented: Split into two constants — `BEST_STREAM_FIRST_CANDIDATE_TIMEOUT_SECS = 6` and `BEST_STREAM_CANDIDATE_TIMEOUT_SECS = 10`. Each spawned JoinSet task now computes `candidate_timeout_secs` based on its index and captures it in the returned tuple `(idx, result, candidate_timeout_secs)`, so the timeout error message accurately reports which timeout fired per candidate. First candidate uses 6s; candidates 1 and 2 use 10s.
- Status: [x]

### C5 — watch_progress history_item_key Migration Runs on Every Cold Start

- `load_or_migrate_history_index` checks for old flat `HISTORY_MAP_KEY` on every startup
- Once migrated, the old key is deleted but the migration function still runs the `store.get(HISTORY_INDEX_KEY)` check on every launch
- This is fine but add a `#[cfg(debug_assertions)]` log when migration path is taken to confirm it's not running repeatedly in production
- Implemented: Added `#[cfg(debug_assertions)] eprintln!(...)` immediately after `history.len()` is known in the migration branch. The log prints item count and is stripped entirely from release builds by the compiler, so there is zero production overhead. Normal startup (index already exists) and the already-migrated fast-path both remain completely silent.
- Status: [x]

### C6 — export_app_data / import_app_data Scope Audit

- Verify both commands include: watch history index + all `history_item:*` keys, library map, lists, watch statuses
- `history_item:*` keys are not a simple `store.get("history")` — they require iterating `HISTORY_INDEX_KEY` entries
- If import only writes the index but not the individual `history_item:*` keys, history will appear populated but items will be empty on access
- Verified: `export_app_data` iterates `HISTORY_INDEX_KEY` and fetches each `history_item:` key individually via `load_or_migrate_history_index`. `import_app_data` writes each `history_item:` key AND updates the index in the same transaction. Library, lists, and watch-status exports/imports all use their indexed accessor helpers (`load_library_map`, `load_watch_statuses_map`, per-item store keys for lists) — no data is silently dropped on round-trip.
- Status: [x]

---

## DOWNLOADER.RS DEEP FINDINGS

### DR1 — Error Status Downloads Are Never Retried on Restart

- `load_downloads` resets `Downloading` and `Pending` → `Paused` on startup (good)
- `Error` status downloads are left as-is — no indication to user, no auto-retry option
- On restart, surface error downloads in the UI with a "Retry" action that calls `resume_download` after re-resolving URL
- Implemented: Error download cards now have a persistent (non-hover-only) `RotateCcw` retry button with a red tint, plus a distinct red-ringed card background so failed downloads stand out without the user needing to visit the Failed tab. The retry button calls `resume_download` which correctly clears the error state and re-spawns the download task.
- Status: [x]

### DR2 — Bandwidth Throttle Window Resets Every 1s but Global Limit Snapshot Refreshes Every 500ms

- `cached_global_limit` refreshes every emit interval (500ms) via `bandwidth_limit.lock().await`
- `throttle_window_start` resets every 1000ms
- A user who sets a limit mid-download sees the new limit take effect within 500ms (good) but the throttle accumulator may briefly over-allow bytes in the window gap
- Low severity, but document the ~500ms transition delay in a comment
- Implemented: Added a `NOTE` comment directly above `cached_global_limit` initialization in `downloader.rs` explaining the intentional ~500ms transition window between limit changes and throttle enforcement, and why this is an acceptable design trade-off.
- Status: [x]

### DR3 — Completed Download File-Missing Detection Only Runs at Startup

- `load_downloads`: if status = `Completed` but file missing → mark as `Error` ✓
- But if a file is deleted _while the app is running_, the download card still shows "Completed"
- Add a `verify_file_exists` check when user clicks "Play" on a completed download card; if missing, show "File was deleted" error with option to re-download
- Implemented: Added `DownloadManager::check_file_exists` in `downloader.rs` and the corresponding `check_download_file_exists` Tauri command in `commands.rs`. The `handlePlay` handler in `downloads.tsx` now calls this check before any navigation for completed-status cards; if the file is missing the backend transitions the item to `Error` (normalizes `downloaded_size/progress/speed`) and emits `download://progress` immediately, while the frontend shows a toast and triggers a refetch for guaranteed UI consistency.
- Status: [x]

### DR4 — HTTP 416 (Range Not Satisfiable) Treated as Completed Without Verification

- When server returns 416, download is marked Completed (L375-ish in downloader.rs)
- 416 means server says "you already have all the bytes" — generally correct
- But if `downloaded_size` was corrupted (e.g. partial write), file may be truncated
- Add: compare `downloaded_size` to a re-read of the file's actual on-disk size before marking complete
- Implemented: 416 handler now reads the actual on-disk file size via `tokio::fs::metadata`. If the on-disk size is >64 KiB and >1% smaller than the recorded `downloaded_size` (truncation heuristic), the item is marked `Paused` and `downloaded_size` is corrected to the real on-disk value so a subsequent resume starts from the right byte offset. If the file looks intact, `downloaded_size` is reconciled to the on-disk value before marking `Completed`. Follow-up polish: the Downloads UI now exposes direct resume/retry action for `error` rows, so failed/truncated jobs are one-click recoverable.
- Status: [x]

### DR5 — Harden Download Input Normalization And Filename Safety

- `start_download` previously trusted incoming URL / file path / file name fields as-is
- A malformed or hostile file name could attempt path traversal or produce invalid Windows device names, and non-http URLs were not rejected at the backend boundary
- Implemented: `downloader.rs` now normalizes download URLs to valid http(s), trims optional metadata, sanitizes file names (path-segment stripping, invalid-character replacement, Windows reserved-name guard, length cap), and persists sanitized values. Startup load now self-heals old stored entries and marks invalid persisted rows as `Error` instead of trusting them blindly.
- Status: [x]

### DR6 — Prevent Duplicate Destination Writes And Overlapping Download Tasks

- New downloads could target an already-tracked destination path, and rapid repeated resume actions could spawn multiple tasks for the same download ID before the in-memory status flipped to `Downloading`
- That combination risked double writers appending to the same file and corrupting partial downloads
- Implemented: `start_download` now rejects duplicate destination paths, `spawn_download_task` now reserves one active task per ID, and finished tasks remove their abort-handle entry on exit so later resumes are clean. `resume_download` now treats an already-active task as a no-op instead of racing another spawn.
- Status: [x]

### DR7 — Persist Terminal Download States And Startup Self-Healing

- Several failure branches in `spawn_download_task` only updated in-memory state / UI events without saving corrected error state, byte counts, or startup repairs back to `downloads.json`
- That made some failures non-persistent across app restarts and left `updated_at` largely unused
- Implemented: added shared `apply_download_state_update(...)` for terminal transitions so file/request/stream/write/check-file errors all emit and persist consistently, and startup reconciliation now writes repaired paused/error/completed state back to disk immediately. `updated_at` is now refreshed whenever a task emits progress or transitions state.
- Status: [x]

### DR8 — Add Transient HTTP Retry / Reconnect Backoff

- Request/connect/body-stream hiccups previously failed a download immediately even when a simple reconnect from the current byte offset would have recovered automatically
- Implemented: the download task now retries transient HTTP statuses (`408/409/425/429/5xx`) and transient reqwest errors with bounded exponential backoff, resuming from the current partial offset. Successful chunks reset the retry budget so long-running downloads tolerate intermittent network blips without silently exhausting a single global retry counter.
- Status: [x]

---

## PROVIDER DEEP FINDINGS

### PR1 — Cinemeta get_catalog Always Fetches Single Page (Pagination Disabled)

- Comment in `get_catalog` explicitly states: "Cinemeta's `?skip=N` does NOT return different items — verified by live testing"
- This means the Search page's infinite scroll for Cinemeta providers always shows the same ~50 items regardless of how far the user scrolls
- `providerSupportsPagination` in search.tsx should return `false` for Cinemeta to hide the "load more" sentinel entirely
- Status: [ ]

### PR2 — Kitsu fetch_relations Makes N+1 Requests

- `fetch_relations` in kitsu.rs fetches relation data per-item in a loop
- For anime with many relations (sequels, prequels, spinoffs) this can be 5–10 sequential requests
- Batch with `tokio::join!` or limit to first 6 relations to cap latency
- Implemented: `fetch_relations` already uses a single `include=destination` request (the original N+1 concern was moot); added `page[limit]=8` to the Kitsu API URL to cap the response body for popular anime (One Piece etc. have 40+ relations), plus a Rust-side `.take(RELATION_LIMIT)` safety guard on the iterator.
- Status: [x]

### PR3 — skip_times MAL ID Resolution Has No Cache

- `resolve_mal_id` in skip_times.rs calls `https://kitsu.io/api/edge/anime/{id}/mappings` on every `get_skip_times` invocation
- No in-memory or disk cache — same MAL ID resolved fresh on every episode open
- Add a `LazyLock<Mutex<HashMap<String, Option<u64>>>>` MAL ID cache (same pattern as Torrentio stream cache)
- Implemented: Added `mal_id_cache: Mutex<HashMap<String, Option<u64>>>` to `SkipTimesProvider` struct. Both positive (`Some(id)`) and negative (`None`) results are cached so repeated invocations for the same show (e.g. switching episodes) never hit the network after the first resolution. Follow-up polish: cache size is bounded (`MAL_ID_CACHE_MAX_ENTRIES`) to avoid unbounded growth in long-running sessions.
- Status: [x]

### PR4 — Netflix Provider catalog skip Parameter Behavior Unknown

- `get_netflix_catalog` accepts a `skip` parameter but it's unclear if the Netflix/HBO/Disney catalog endpoints actually honor it
- If they don't (like Cinemeta), the infinite scroll in search.tsx for those providers silently repeats items
- Test each provider and set `providerSupportsPagination` accordingly; add a comment documenting verified behavior
- Implemented: Extracted `PROVIDERS_WITH_SKIP_PAGINATION = new Set<ProviderId>(['netflix','hbo','disney','prime','apple','kitsu'])` as a module-level constant in search.tsx with verified-behaviour documentation for each provider. Replaced the terse `activeProvider !== 'cinemeta'` expression. Added matching documentation block to `Netflix.get_catalog` in netflix.rs explaining the skip/404 contract and the id-dedup safety net.
- Status: [x]

---

## FRONTEND DEEP FINDINGS

### F1 — MediaCard Popup Position Not Recalculated on Window Resize

- `computePopupPos` (L102) calculates position once on hover based on `cardRef.getBoundingClientRect()`
- If the user resizes the window while a popup is open, the popup position is stale and may clip off-screen
- Add a `ResizeObserver` or `window resize` listener that calls `computePopupPos` while popup is open
- Status: [x]

### F2 — MediaCard RAF in onScroll Is Not Always Cancelled

- `rafId` (L206) is set inside the scroll handler closure
- If the component unmounts while a RAF is pending the callback fires on a dead component
- Store `rafId` in a `useRef` and cancel in the cleanup function of the `useEffect` that registers the scroll listener
- Status: [x]

### F3 — Details Page Episode Grid Has No Virtualization

- `filteredEpisodes.map(...)` renders all episodes as DOM nodes
- For long-running series (One Piece: 1100+ episodes, Naruto: 700+) this creates 1000+ DOM nodes at once
- Add windowed rendering using `@tanstack/react-virtual` (not yet a dep) or simple chunked lazy-render (show first 50, "Show more" button)
- Status: [x] — Implemented via `shouldUseLongSeasonPaging` (>100 eps → 50/page w/ prev/next) + "Show More" for shorter seasons

### F4 — Details Page handleContinueDirect Does Not Pass logo to Player State

- `handleContinueDirect` (L394) builds player navigation state with: streamUrl, title, poster, backdrop, format, streamLookupId, startTime, resumeFromHistory, isOffline, from
- `logo` is missing — other navigation paths (handleWatchEpisode → StreamSelector → onSuccess) do pass `logo`
- Player uses `logo` for the loading screen overlay. Add `logo: item.logo` to the state object in `handleContinueDirect`
- Status: [x] — `logo: item.logo` already present in handleContinueDirect player state

### F5 — Profile continueWatchingItems Derived from Same history Query, Not Deduplicated by Show

- `continueWatchingItems` (L166) filters history for items with progress < 95%
- For a binge session (watched 10 episodes of one show), the Continue Watching tab shows 10 separate cards for the same show
- Deduplicate: for series, keep only the most recently watched episode per `item.id`
- This matches the behavior of `ResumeSection` on the home page but is missing in the Profile tab
- Status: [x]

### F6 — Home Page Secondary Row Delay Is Fixed 600ms Regardless of Connection Speed

- `SECONDARY_ROW_DELAY_MS = 600` always waits 600ms before showing secondary rows
- On fast connections/local cache hits, primary content renders in <100ms — 600ms delay is perceptible
- On slow connections, hero itself may not be rendered by 600ms — secondary rows appear before the hero is visible
- Change to: trigger secondary rows after hero's `onLoad` event fires OR after 600ms, whichever comes first
- Status: [x]

### F7 — ResumeSection Warmup Fires Even for Kitsu Anime Without imdbSeason/imdbEpisode

- The warmup effect in `resume-section.tsx` skips series without episode context (good)
- But for Kitsu anime, `last_stream_lookup_id` may contain a Kitsu ID (`kitsu:12345`) while `season`/`episode` are set
- `resolveBestStream` will be called with `type='series'` and the Kitsu ID — this may produce an incorrect Torrentio query
- Add a guard: only warm if `last_stream_lookup_id` starts with `tt` (IMDB format) OR is undefined (use item.id which is IMDB for Cinemeta)
- Status: [x]

### F8 — Player handleKeyDown Does Not Guard Against Input Focus

- `handleKeyDown` (L1347) fires on keydown events globally on the player container
- If a subtitle delay input or any text field inside the player controls is focused, pressing `Space` or arrow keys both triggers player actions AND types into the field
- Add: `if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;`
- Status: [x]

### F9 — Player nextEpisodePrefetch Does Not Cancel on Manual Navigation

- `nextEpisodePrefetchRef` and `nextEpisodePrefetchInFlightRef` (L488–494) manage prefetch state
- If the user manually navigates to a different episode (via episode list in-player) before prefetch resolves, the prefetch result for the old "next" episode may overwrite state
- Add: cancel/ignore prefetch result if `nextEpisodePrefetchRef.current?.lookupId !== currentNextEpisodeLookupId` at resolution time
- Status: [x]

### F10 — Settings TorrentioConfig "Copy Example" Copies Partial URL

- `exampleUrl` in `TorrentioConfig` (L350–351) is a partial Torrentio URL used as a placeholder
- `handleCopyExample` (L353) writes it to clipboard — but the example likely needs the user's RD token interpolated to be useful
- Change copy behavior to: if RD token is configured, offer to copy the full pre-filled URL with token; otherwise copy the base example and toast "Add your API key to the URL"
- Status: [x]

---

## DATA & PERSISTENCE FINDINGS

### DP1 — tauri-plugin-store Has Size Limits for Large History

- History uses an indexed pattern (`HISTORY_INDEX_KEY` + per-item keys) specifically to avoid store size limits
- But library, lists, and watch statuses are still stored as single large JSON values under a single key
- For users with 500+ library items or huge lists, the store value may approach limits
- Migrate library and lists to the same indexed pattern as history: `library_index` key + `library_item:{id}` keys
- Status: [x]

### DP2 — settings.json and app data store Are the Same File

- `app.store("settings.json")` is used for both user settings (torrentio URL, debrid key, language prefs) AND all app data (history index, library, lists, statuses)
- These should be separate files: `settings.json` (config only) and `appdata.json` (user content)
- Mixing them means a corrupt app data entry can brick the settings store and vice versa
- Status: [x]

### DP3 — No Schema Version / Migration System

- Data stored in `tauri-plugin-store` has no version field
- If a future update changes the shape of a stored struct (e.g. adds a required field to `WatchProgress`), old data will silently fail to deserialize
- Add a `schema_version: u32` key to settings.json; on load, run migrations if version < current
- Status: [ ]

---

## QUICK WINS (Low effort, high polish)

### QW1 — Sidebar Tooltip Labels

- All sidebar icons have `title` attributes but no styled tooltip component
- On hover, native browser title tooltips appear with OS-default styling (ugly, delayed)
- Replace with shadcn `<Tooltip>` component wrapping each sidebar button for consistent, instant labels
- Status: [x]

### QW2 — Download Modal Priority Labels Reorder

- Priority buttons: Low (2MB/s) → Medium (10MB/s) → High (Unlimited) — left to right is correct
- But "High" is the default selection and is highlighted last (rightmost) — visually counterintuitive
- Either make "Medium" the default or reorder to High → Medium → Low (fastest-first mental model)
- Status: [x]

### QW3 — Episode Release Date Locale Formatting

- Episode cards in Details render: `new Date(ep.released).toLocaleDateString(undefined, {...})`
- `undefined` locale falls back to OS locale which may produce inconsistent formats across systems
- Pin to `'en-US'` or use `date-fns format()` (already a dep) for consistent output
- Status: [x]

### QW4 — MediaCard Progress Bar Shows for 0% Progress

- `showProgress` in MediaCard checks `progressValue !== undefined` — but `progressValue` is set when `progressPercent > 0`
- Edge case: if `item.position = 0.001` and `item.duration = 3600`, `progressPercent ≈ 0` but `progressValue` is defined as a tiny number
- Add a minimum threshold: only show progress bar if `progressPercent >= 2`
- Status: [x]

### QW5 — Hero "Watch Now" Button Goes to Details, Not Directly to Player

- `Hero` "Watch Now" button navigates to `/details/${item.type}/${item.id}` (details page)
- For returning users who already have a resume point, this adds an extra click
- Consider: if `watchHistory` has an entry for this item at > 5% progress, change button to "Continue Watching" and navigate directly to player (same pattern as `handleContinueDirect` in details.tsx)
- Status: [ ]

### QW6 — Search Page URL State Does Not Preserve yearFrom / yearTo

- `yearFrom` and `yearTo` (L107–108 search.tsx) are component state but NOT synced to URL params
- If user navigates away and back, year filter is lost (unlike type/provider/genre which are URL-synced via `setSearchParams`)
- Add `yearFrom` and `yearTo` to URL params alongside the existing ones
- Status: [x]

### QW7 — Calendar "Today" Button Active State Is Missing

- `handleToday` sets `currentMonth` to `new Date()` but the "Today" button has no visual active/disabled state when already on the current month
- Disable the button (or apply an active style) when `isSameMonth(currentMonth, new Date())` is true
- Status: [x]

### QW8 — Profile Stats Chips Are Not Clickable to Filter

- `StatChip` components (L864) in Profile show counts for library/lists/history/continue-watching
- Clicking a stat chip should navigate to / activate the corresponding tab — currently they are purely decorative
- Add `onClick={() => setActiveTab(tabKey)}` to each chip
- Status: [ ]

---

## ROUND 2 FINDINGS

---

## LONG-RUNNING SERIES (One Piece / Naruto / Bleach class)

### LS1 — Kitsu `get_details` Returns ALL Episodes in One Response — No Episode Pagination

- `kitsu.rs get_details` fetches `{BASE_URL}/meta/anime/{id}.json` which returns the full `videos` array in a single JSON blob
- One Piece has 1100+ episodes; the Kitsu Stremio addon response for this single endpoint can be several MB
- The entire array is deserialized and returned to the frontend as `item.episodes` — no chunking, no lazy loading
- This single request drives: `filteredEpisodes` memo, `episodeProgressMap` memo, `seasons` derived set, `nextEpisode` in the player, `episodeCountInSeason`, and `maxWatchedEpisodeInSeason`
- Fix: add server-side episode pagination to `get_details` (accept `episode_page` param, return 50 at a time) OR lazy-load episodes separately via a new `get_episodes` command that accepts `season` + `page`
- Frontend would then fetch the next page when the user switches season or scrolls near the end of the episode list
- Status: [x]

### LS2 — Episode Thumbnail Images for Long Series Are Fetched All at Once

- `filteredEpisodes.map(...)` in `details.tsx` renders every episode card immediately with `<img loading='lazy'>` tags
- `loading='lazy'` only defers images that are off-screen at render time — if 1100 `<img>` elements exist in the DOM, the browser still registers all 1100 load observers simultaneously
- Combined with the Kitsu CDN thumbnail URL pattern (`https://media.kitsu.app/episodes/thumbnails/{id}/large.jpg`) this can fire 1000+ network requests as the user scrolls
- Fix: pair with LS1 (virtual/chunked rendering) so only ~50 episode cards exist in the DOM at once; all 1100 thumbnails are never simultaneously registered
- Status: [x]

### LS3 — Season Selector for Anime Uses IMDb Season Numbers, Not Anime Arcs/Sagas

- `seasons` derived set in `details.tsx` (L110) uses `e.season` which for Kitsu anime maps to `imdb_season`
- For One Piece (1 IMDb season with 1100+ episodes) this means the season dropdown shows only "Season 1" with all episodes
- The episode grid then renders all 1100+ episodes under that single season with no sub-grouping
- Enhancement: for shows with > 100 episodes in a single season, auto-group by arc/saga using episode number ranges OR simply show episodes in pages of 50 with prev/next controls
- Status: [x]

### LS4 — `build_stream_query_ids` Season-1 Fallback Sends Episode 1000 to Torrentio

- In `commands.rs` `build_stream_query_ids`, when `media_type == "anime"` and `s != 1`, a fallback query `tt...:1:{e}` is added
- For One Piece episode 1000, this produces `tt0388629:1:1000` as a fallback — valid, and torrentio indexes absolute episode numbers this way
- However when `s == 1` already (because Kitsu already mapped it), there is NO absolute-number fallback
- Some providers index by absolute episode number even for multi-season shows; add an absolute-episode fallback that uses the episode's `imdb_episode` field (which is already in the `Episode` struct) when it differs from `episode`
- Status: [x]

### LS5 — `watchHistoryFull` Query Loads Every Episode of Every Series Into Memory

- `get_watch_history_full` returns ALL watch history rows (potentially thousands for a heavy watcher), not scoped to the currently viewed show
- `episodeProgressMap` in `details.tsx` builds a `Map` keyed by `id:season:episode` from this full dataset, then discards all rows that don't belong to the current show
- For users with 5000+ history entries this materialises a large array → full Map iteration → discard on every details page load
- Fix: add a `get_watch_history_for_id(id: String)` command that filters server-side and returns only rows matching that show's ID; replace the `watch-history-full` query in `details.tsx` with this scoped query
- Status: [x]

---

## STREAM RESOLUTION ROUND 2

### SR1 — `resolve_stream_inner` Calls `select_files` Then Immediately Polls — Race Condition

- After `select_files` (L~810 commands.rs) the code immediately starts the poll loop
- Real-Debrid's API processes file selection asynchronously; the first poll may return status `"queued"` or `"downloading"` and the loop will spin for up to 30 s
- The poll interval is 500 ms with no exponential back-off — 30 s / 0.5 s = up to 60 HTTP requests per stream resolution attempt
- Fix: add a short initial sleep (1–2 s) before the first poll to let RD process the selection, and increase poll interval to 1 s after the first 3 attempts
- Status: [x]

### SR2 — `resolve_best_stream` Uses the Same 10 s Timeout for All 3 Candidates Serially

- `BEST_STREAM_CANDIDATE_TIMEOUT_SECS = 10` is applied per-candidate, and candidates are tried serially
- Worst case: 3 candidates × 10 s = 30 s before the user sees an error — this is the "spinning wheel of death" scenario
- Fix: try candidates with `tokio::select!` in parallel, take the first success, cancel the rest — reduces worst-case latency to 10 s total
- Status: [x]

### SR3 — No Retry Differentiation Between Transient and Permanent Errors in `resolve_stream_inner`

- Auth errors (401/403) correctly short-circuit, but network errors, RD server errors (500/502/503), and timeout errors all fall through to the same "unable to resolve" message
- Transient errors (500, timeout) should trigger an automatic single retry with a small delay
- Permanent errors (magnet_error, dead, 403 auth) should fail fast and surface a user-friendly message
- Implemented: added transient-error detection + one-shot retry helper in `resolve_stream_inner` (availability, add magnet, get info, select files, and polling path), with fast-fail auth/permanent handling and clearer user-facing transient error messages.
- Status: [x]

### SR4 — `find_best_matching_file` Episode-Only Pattern `e{:02}` Is Too Broad

- Pattern 3 in `find_best_matching_file` matches any file containing `e01`, `e02`, etc.
- A torrent named `Extras/Making.of.E01.mkv` would match for episode 1 before the actual `S01E01` episode file
- The function already tries SxxExx and NxNN first; the `e_only_pattern` fallback should be restricted to files that are also valid video files (already checked) AND do not appear under a subdirectory path component that looks like extras/special/bonus
- Implemented: episode-only fallback now excludes extras/special/bonus-like path segments, and unit coverage was added to guard against regressions.
- Status: [x]

---

## PLAYER ROUND 2

### PL1 — `nextEpisode` Lookup Crosses Season Boundary Without Verifying Episode 1 Exists

- `nextEpisode` in `player.tsx` (L638) finds the next episode by checking `ep.season === s && ep.episode === e + 1` OR `ep.season === s + 1 && ep.episode === 1`
- The cross-season match (`ep.season === s+1 && ep.episode === 1`) assumes season N+1 always starts at episode 1
- Some providers index seasons starting at episode 0 (specials) or episode 2 (split-cour anime); the lookup will return null and up-next will not show even though a next episode exists
- Fix: instead of hardcoding `episode === 1`, find the minimum episode number in season `s+1`
- Status: [x]

### PL2 — Player `initPlayer` mpv Config Always Sets `pause: true` — Black Frame on Auto-Play

- `mpvConfig.initialOptions.pause = true` (L1619) unconditionally pauses mpv on init
- The player then calls `play` once the URL is loaded, causing a visible single black frame flash before playback begins on auto-play transitions (e.g. up-next auto-navigate)
- Fix: set `pause: false` when `activeStreamUrl` is already known at init time (i.e., navigated with a pre-resolved URL); keep `pause: true` only when auto-resolving without a URL
- Implemented: player now distinguishes pre-resolved route URLs from auto-resolved launches and sets mpv initial pause accordingly to remove black-frame flash on auto-play transitions.
- Status: [x]

### PL3 — `saveProgress` Sends `Date.now()` as `last_watched` (milliseconds), Backend Expects It But Confirmation Needed

- `saveProgress` in `player.tsx` (L762) sends `last_watched: Date.now()` — this is Unix milliseconds
- `save_watch_progress` in `commands.rs` (L1339) defaults to `now_unix_millis()` if `last_watched == 0`, so it accepts whatever value the frontend sends
- `now_unix_millis()` (L221) returns `duration.as_millis() as u64` — confirmed milliseconds
- `get_watch_history` sorting uses `b.last_watched.cmp(&a.last_watched)` — works correctly for ms values
- **Verdict**: units ARE consistent (both ms) — the P10 concern from Round 1 is partially mitigated. However `shouldBypassSavedStream` in the frontend `api.ts` must also be verified to compare `Date.now()` (ms) against `last_watched` (ms) — track this verification
- Implemented: verified frontend comparison uses milliseconds and added a defensive normalizer in `shouldBypassSavedStream` to tolerate legacy second-based timestamps.
- Status: [x]

### PL4 — Volume Preference Saved to `localStorage` Via `useLocalStorage` Hook — Not Synced to Settings Store

- `volume` and `playbackSpeed` use `useLocalStorage` (custom hook via `saved` in `InnerPlayer`)
- These are stored in the browser's `localStorage`, not in `settings.json` via the Tauri store
- On first launch after a data wipe, or when two windows open, preferences can diverge
- Move `volume` and `playbackSpeed` persistence to `settings.json` via the existing `save_playback_language_preferences` pattern (add fields to that command or create `save_player_preferences`)
- Status: [ ]

### PL5 — Startup Watchdog `recoverFromSlowStartup` Fires API Call During Player Teardown

- `recoverFromSlowStartup` (L899) calls `api.resolveBestStream` inside a `setTimeout` of 8–12 s
- If the user navigates away from the player before the watchdog fires, the timer is cleared in `clearTimers` (L691)… but `clearTimers` is only called in the `useEffect` cleanup, which runs **after** React's reconciliation phase
- There is a narrow window where the Tauri `resolveBestStream` command starts execution as the component unmounts, and the result is written to `setActiveStreamUrl` on a dead component
- The `mountedRef.current` guard (L466) should prevent the state write, but the Tauri IPC call itself still runs — wasteful and can cause log noise
- Fix: use an `AbortController`-equivalent (a `cancelled` ref set in the `useEffect` cleanup) to skip the watchdog resolution entirely if the component is unmounted
- Implemented: added a dedicated watchdog cancellation ref that is flipped in watchdog cleanup and checked before/after slow-start resolution attempts so teardown skips recovery IPC work.
- Status: [x]

---

## KITSU / ANIME ROUND 2

### KA1 — `get_anime_catalog` Makes Up to 10 Serial HTTP Requests Per Browse Page Load

- `kitsu.rs get_anime_catalog` (L27) runs a loop of up to 10 pages × 20 items each, all serial (`await` inside `for` loop)
- On the home page, `getKitsuCatalog('kitsu-anime-trending')` is called — this alone can fire 10 sequential requests before returning
- Fix: cap `max_pages` to 3 for initial browse (skip=0 case) to keep latency under 1 s; use the `(start_skip, 3)` branch for subsequent infinite-scroll pages
- The current code already does `(None => (0, 10), Some(s) => (s, 3))` but `max_pages = 10` for the initial load is still too high — reduce to 5 at most
- Status: [x]

### KA2 — Kitsu Anime `imdb_season` / `imdb_episode` Mapping Absent for Many Episodes

- `MetaVideo.imdb_season` and `imdb_episode` are `Option<u32>` (L526–528 kitsu.rs)
- For episodes that Kitsu has not mapped to IMDb (common for newer or less-popular anime), these fields are `None`
- The fallback `display_season = v.imdb_season.or(v.season).unwrap_or(1)` works, but the stream lookup will then use `kitsu_season:episode` coordinates which Torrentio may not recognise
- The `build_stream_query_ids` anime path only generates useful fallbacks for `tt`-prefixed IDs; Kitsu IDs (`kitsu:12345`) only produce a single query with no fallback
- Enhancement: for Kitsu anime, always prefer `imdbId` from the show-level for the stream query even if the episode-level `imdb_episode` is missing; use the Kitsu absolute episode number as the episode coordinate
- Implemented: infer missing `imdbSeason` from nearest mapped neighbors so isolated unmapped rows (e.g. One Piece ep 590) no longer collapse into Season 1; keep episode number fallback stable
- Implemented: season-local thumbnail fallback reuse for sparse late-episode metadata gaps
- Status: [x]

### KA3 — AniSkip Uses Absolute Episode Number But Player Passes Parsed Route `episode`

- `get_skip_times` in `commands.rs` passes `ep = episode.unwrap_or(1)` directly to `get_aniskip_segments`
- AniSkip expects the **absolute** episode number (e.g., 1050 for One Piece episode 1050), not a season-relative one
- For Kitsu anime, the player route is `/player/anime/{kitsuId}/{season}/{episode}` where `episode` is the IMDb-mapped episode number
- For shows mapped to IMDb season 1 with absolute numbering, this is correct; but for multi-season IMDb mappings the passed episode is the season-relative number — AniSkip will return wrong (or no) segments
- Fix: store and pass the `imdb_episode` (absolute) from the `Episode` struct through to the player state, and use that value for AniSkip queries
- Implemented: Stream selector now carries an `aniskipEpisode` value in navigation state; details/player send IMDb absolute episode when available and player skip-time fetch prefers that value for AniSkip.
- Implemented: up-next/prefetch stream resolution now uses IMDb season/episode coordinates when present, avoiding mismatched lookups for Kitsu multi-season mappings.
- Status: [x]

---

## DATA & PERSISTENCE ROUND 2

### DP4 — `library.json` Stores All Items Under a Single `"library"` Key as a Map

- `load_library_map` (L324) deserialises the entire library from a single `store.get("library")` call
- For users with 500+ library items, the serialised JSON stored under one key can be very large
- `tauri-plugin-store` serialises the entire store file on every `store.save()` — adding one library item rewrites the whole file
- For large libraries this introduces noticeable I/O latency on every `add_to_library` / `remove_from_library` call
- Fix: migrate to the same indexed pattern as history — `library_index` key + `library_item:{id}` per-item keys
- Implemented: migrated library storage to indexed per-item keys with legacy-map migration and index/item cleanup on read.
- Status: [x]

### DP5 — `watch_status.json` Stores ALL Statuses Under One Key as a `HashMap<String,String>`

- `set_watch_status` (L1983) loads the full statuses map, inserts, and saves the whole file
- Same single-key serialisation problem as DP4 — scales poorly with large numbers of tracked shows
- Additionally, `get_all_watch_statuses` returns the full map to the frontend, which must iterate it on every render that needs status badges
- Fix: use per-item keys `watch_status:{id}` with an index, matching the history pattern
- Implemented: migrated watch statuses to `watch_status_index` + `watch_status:{id}` keys with backward-compatible legacy migration.
- Status: [x]

### DP6 — `lists.json` List Items Are Stored Per-Item but `item_ids` Array Is Duplicated in Meta

- `UserList.item_ids` (L1739) stores the ordered list of item IDs inside the list metadata key
- The same IDs are also stored individually as `list_item:{list_id}:{item_id}` keys
- On `reorder_list_items` (L1916), only `item_ids` in the meta is updated — the per-item keys are unaffected, which is fine — but the meta key holds a potentially large array for big lists
- If `item_ids` and the per-item keys ever get out of sync (e.g., interrupted write), the list will show phantom items or miss items
- Fix: derive order purely from `item_ids` (already the source of truth) and add a consistency check on `get_lists` to remove `item_ids` entries that have no corresponding per-item key
- Implemented: `get_lists` now self-heals list metadata by removing dangling `item_ids` with no per-item key and persists repaired list meta.
- Status: [x]

---

## SEARCH & DISCOVERY ROUND 2

### SD1 — Kitsu Search (`searchKitsu`) Has No Pagination — Returns First 20 Results Only

- `search_kitsu` command calls `kitsu.search_anime(query)` which calls `build_search_url` with no `skip` — a single page of 20 results
- The search page `useInfiniteQuery` calls `api.searchKitsu(debouncedQuery)` and `getNextPageParam` returns `undefined` for search queries (correct, by design)
- But 20 results for a broad query (e.g. "one piece") is far too few — users cannot find sequel seasons or spin-offs
- Fix: use `build_search_url` with pagination in `search_anime`, return up to 100 results (5 pages × 20) for search queries; or expose a `skip` param and let the frontend paginate
- Implemented: `Kitsu::search_anime` now paginates up to 5 pages (deduped), returning up to ~100 results for broad queries.
- Status: [x]

### SD2 — Cinemeta `search` Only Queries `top` Catalog — Misses `imdbRating` Results

- `cinemeta.rs search` (L~290) builds movie and series URLs against the `top` catalog only
- Some titles appear in `imdbRating` but not `top` (e.g. cult classics with high IMDb scores but lower streaming popularity)
- Fix: parallel-fetch both `top/search={query}` and `imdbRating/search={query}` for both movie and series (4 parallel requests total) and merge with deduplication — same pattern as `get_discover_catalog`
- Implemented: `Cinemeta::search` now parallel-fetches movie/series across `top` + `imdbRating` catalogs (4 requests) and returns deduplicated merged results.
- Status: [x]

### SD3 — Search Page `getNextPageParam` Safety Cap of 2000 Items Is Never Surfaced to User

- `getNextPageParam` (L332) returns `undefined` when `totalFetched >= 2000`
- When this cap is hit, `hasNextPage` becomes false and the sentinel observer stops firing
- The UI shows no "end of results" message and no indicator that fetching was capped — user may think results just dried up
- Add: when `showEndMsg` is true (L477) AND `totalItems >= 1900`, show "Showing top 2000 results — refine your search for more" instead of the generic end message
- Implemented: added cap-aware end-state messaging in `search.tsx` that shows "Showing top 2000 results — refine your search for more" when near/at cap.
- Status: [x]

### SD4 — Multi-Genre Mode Does Not Support Infinite Scroll

- `perGenreQueries` (L369) in multi-genre mode fetches one page per genre with no pagination
- If the user selects 2+ genres, `hasNextPage` is always `false` (multi-genre mode bypasses `useInfiniteQuery`)
- For Kitsu/Netflix providers that support skip, this means multi-genre results are capped at a single page (~20–100 items)
- Fix: in multi-genre mode, add a "Load more" button that triggers additional `fetchForGenre` calls with incremented skip for each active genre and appends results
- Implemented: multi-genre mode now loads paged per-genre queries and exposes a `Load more` action (anime/Kitsu path) that appends additional skipped pages per selected genre.
- Status: [x]

### SD5 — Search URL Sync + Discover Query Churn Cleanup

- Search page now initializes type/provider/feed/sort/genres directly from the URL, avoiding a default-state fetch before URL sync applies
- Persisted multi-genre selections and sort mode back into the URL, and stopped redundant `setSearchParams(...)`/recent-search rewrites when only unrelated filters change
- Gated the main infinite search/discover query on online status and memoized filtered genre options to trim repeated render work in the popover
- Status: [x]

---

## BACKEND ARCHITECTURE ROUND 2

### BA1 — All Tauri State Providers Are Constructed Once at App Startup With No Health-Check

- `Cinemeta`, `Kitsu`, `Torrentio`, `RealDebrid`, `SkipTimesProvider` are instantiated once in `lib.rs` and stored as Tauri managed state
- If any provider's underlying `reqwest::Client` enters a broken state (e.g., DNS cache poisoned, TLS session expired), there is no mechanism to recreate it
- Worst case: app requires a full restart to recover from a stale HTTP client
- Fix: add a `health_check` command per provider that creates a test request; if it fails, swap the managed state with a fresh instance (requires `Arc<RwLock<Provider>>` pattern instead of bare `Provider`)
- Status: [ ]

### BA2 — `get_app_config` Does Not Return `debrid_provider` — Frontend Has to Call `get_debrid_config` Separately

- `get_app_config` (L1119) returns `has_rd_token`, `torrentio_config`, language prefs but NOT `debrid_provider`
- The stream selector and settings page must call `get_debrid_config` separately to know which debrid provider is active
- This causes two sequential Tauri IPC calls on page load where one would suffice
- Fix: add `debrid_provider` to the `get_app_config` response
- Implemented: added `debrid_provider` to `get_app_config` response and centralized provider inference with shared fallback logic used by both `get_app_config` and `get_debrid_config`.
- Status: [x]

### BA3 — `open_folder` Command Uses `explorer` Hardcoded — Windows Only

- `open_folder` (L2498) uses a `std::process::Command` that assumes Windows `explorer.exe`
- On non-Windows Tauri builds this will silently fail or produce an error
- Fix: use `tauri::api::shell::open()` or a cross-platform crate like `opener` which dispatches to `xdg-open` / `open` / `explorer` by OS
- Implemented: `open_folder` now validates input path and opens directories/files robustly via `tauri-plugin-opener` with cross-platform path handling.
- Status: [x]

### BA4 — History Index `load_or_migrate_history_index` Runs a Full Store Scan on Legacy Migration Every Cold Start

- `load_or_migrate_history_index` (L333) checks for `HISTORY_INDEX_KEY` first (fast path) but then falls back to reading the old `"history"` map key
- On every cold start, if `HISTORY_INDEX_KEY` is present, the fast path exits immediately — fine
- But if `HISTORY_INDEX_KEY` is ever accidentally deleted (e.g., by a corrupt store write), the migration re-runs and rewrites ALL history items — potentially causing data duplication if partially-written history_item keys already exist
- Fix: after migration, verify the item count matches and add a `"history_migration_v1_complete": true` sentinel key that prevents re-migration even if the index is missing
- Implemented: added `history_migration_v1_complete` sentinel, migration count verification, normalized migrated keys/items, and a guarded non-remigration path when sentinel is already set.
- Status: [x]

---

## UX & POLISH ROUND 2

### UX1 — Details Page "Play" Button Text Does Not Update When Season Changes

- `playButtonText` (L362) uses `seriesResume.canResume` which is derived from `seriesProgress` (L334)
- `seriesProgress` is the most recent history entry for the show regardless of season
- If the user has watched S1 fully and switches to S2 in the season dropdown, `playButtonText` still shows "Continue" pointing at the last S1 episode — not the start of S2
- Fix: `playButtonText` for series should check if `seriesProgress.season === selectedSeason`; if not, show "Start Watching" for the newly selected season
- Status: [x]

### UX2 — Episode Card "Resume" Badge Shows on Only One Episode — Not Visually Distinct Enough

- `isResumeEp` badge (L809) is applied to one episode card with a small white `"Resume"` chip
- The rest of the episode list uses the same grey/dark card style for unwatched episodes
- A user scanning a 100+ episode list cannot easily find where they left off
- Enhancement: scroll the episode list to the resume episode on mount (use `useEffect` + `scrollIntoView`) and apply a more prominent visual treatment (accent border, brighter background) to that card
- Status: [x]

### UX3 — Stream Selector Closes on Escape Key Even While a Stream Is Resolving

- `StreamSelector` is wrapped in a `<Dialog>` whose `onOpenChange` is called on Escape key press
- If a stream is currently resolving (`isAnyResolving === true`), pressing Escape closes the dialog but the underlying Tauri `resolve_stream` command continues running
- The mutation will call `navigate(playerRoute, ...)` after the dialog is already gone, causing a spurious navigation
- Fix: in `onOpenChange`, if `isAnyResolving` is true, ignore the close event (or show a "Cancelling…" state and abort)
- Status: [x]

### UX4 — Details Page Error State Has Only a "Retry" Button That Reloads the Page

- The error fallback (L378 details.tsx) shows "Error loading details" with a `window.location.reload()` button
- `reload()` throws away the entire React state including navigation history — pressing back after a reload takes the user somewhere unexpected
- Fix: replace `window.location.reload()` with `queryClient.invalidateQueries({ queryKey: ['details', type, id] })` followed by a re-render; this retries the query without a full page reload
- Status: [x]

### UX5 — No Loading Skeleton for Episode Grid While `watchHistoryFull` Is Fetching

- When the Details page loads, `item` data arrives quickly (details query) but `watchHistoryFull` may still be loading
- During this window, episode cards render without progress bars, watched checkmarks, or resume badges — they "pop in" once history loads
- This is visually jarring for heavy watchers browsing mid-series
- Fix: show a skeleton/shimmer overlay on episode cards while `watchHistoryFull` is loading (`isLoadingHistoryFull` state check)
- Status: [x]

### UX6 — Player Error Overlay Has No "Try Different Stream" Shortcut

- When `error` is set and the error overlay is shown, the only actions are "Retry" (re-runs `resolve_best_stream`) and "Go Back"
- If the best stream consistently fails (e.g., all top-3 candidates are RD-uncached), the user has no in-player way to open the stream selector to pick a different stream manually
- Fix: add a "Choose Stream" button to the error overlay that sets `showStreamSelector(true)` — same as what the back-navigation does via `reopenSelectorState`
- Status: [x]

---

## TORRENTIO / STREAM PROVIDER ROUND 2

### TP1 — Torrentio Cache Key Does Not Include the RD Token — Different Users Share Cached Streams

- `cache_key` in `torrentio.rs get_streams` (L~286) is `format!("{}|{}", type_, id)`
- If two users (or the same user switching RD accounts) call `get_streams` for the same content, the second call returns the first user's cached stream list — which may have `cached: true` flags set for the wrong account's RD availability
- Fix: include a hash of the RD token (or `None`) in the cache key: `format!("{}|{}|{}", type_, id, token_hash)`
- Implemented: cache key now includes a hashed RD token segment (or `rd:none`) so cached availability/state does not bleed across accounts.
- Status: [x]

### TP2 — `truncate_streams_for_mode` Hardcodes Limits (15 debrid / 20 torrent / 35 total)

- These constants are buried inside `fn truncate_streams_for_mode` with no named constants
- If the stream selector UI changes to show more/fewer items or if user wants more torrent options, these must be found and changed in the source
- Extract as named constants: `DEBRID_STREAMS_MAX`, `TORRENT_STREAMS_MAX`, `TOTAL_STREAMS_MAX`
- Implemented: extracted and applied named limits (`DEFAULT_STREAMS_MAX`, `DEBRID_STREAMS_MAX`, `TORRENT_STREAMS_MAX`, `TOTAL_STREAMS_MAX`) across truncation logic and tests.
- Status: [x]

### TP3 — Fallback to `torrentio.strem.fun` Public Endpoint Leaks User Content Queries Without Token

- `fetch_fallback_streams` (L698) makes a plain unauthenticated request to `https://torrentio.strem.fun/stream/{type}/{id}.json`
- This is a public endpoint — every content lookup is logged by the public Torrentio server without the user's knowledge or consent
- Users who have configured a private/self-hosted Torrentio instance may not expect their queries to fall back to the public endpoint
- Fix: make the public fallback opt-in via a setting (`allow_public_torrentio_fallback: bool`, default false); or at minimum document this behaviour in the settings UI
- Status: [ ]

### TP4 — RD Availability Check Chunks at 50 Hashes but Response Parsing Assumes All Keys Present

- In `torrentio.rs` the RD availability loop chunks hashes into groups of 50 (L~440)
- `has_rd_variants` in `commands.rs` (L656) reads `availability.items.get(hash)` — if RD returns a partial response (some hashes missing), those streams are left with `cached: false` even if they are cached
- This is safe but silently under-marks availability; no logging or fallback
- Fix: after the availability loop, log the count of hashes sent vs hashes returned; emit a debug warning if >10% are missing from the response
- Status: [x]

---

## DETAILS / ANIME INTELLIGENCE ROUND 3

### AI1 — Season Selector Lacks Chronology Context for Anime

- Season dropdown only showed `Season N` even when release years are available
- Added per-season year range metadata from backend pagination (`seasonYears`) and surfaced labels like `Season 1 • 2023` / `Season 2 • 2024`
- Frontend now falls back to local episode release-date inference when backend year metadata is unavailable
- Status: [x]

### AI2 — Invalid Season Hints Could Lock Anime Details Into Empty Episode View

- Navigation/history season hints were trusted even if that season no longer exists in available seasons
- Added defensive validation and auto-recovery to nearest valid season when hints are stale/invalid
- Prevents dead-end empty grids for long-running anime and provider data shifts
- Status: [x]

### AI3 — Relations Tab Ordering Was Naive (No Franchise Similarity or Timeline)

- Related items were rendered in raw provider order, mixing spin-offs/sequels without chronology
- Added intelligent dedupe + scoring by franchise title-token overlap (anime-safe), then chronology sort by year with stable fallback ordering
- Includes conservative fallback when strict similarity filtering returns no items (avoids hiding all relations)
- Status: [x]

### AI4 — Related Season Picks Navigated Away Instead of Updating In-Place

- Season candidates in the selector previously called route navigation (`/details/...`), which felt like a page jump
- Reworked to switch related title details inline on the current details screen (metadata + episodes update in-place)
- Added a clear inline-mode affordance with a one-click return to the original title context
- Status: [x]

### AI5 — Details Could Land on Relations Instead of Episodes

- Strengthened episodes-first behavior with a derived tab fallback that only shows Relations when Episodes are genuinely unavailable
- Keeps opening behavior consistent and avoids accidental Relations-first landings for normal shows/anime
- Status: [x]

### AI6 — Anime Related-Season Detection Needed Lower False Positives

- Tightened same-show season candidate logic by excluding movie/OVA/special/recap-style relation titles
- Preserves high-confidence season stitching (e.g., numbered sequel seasons) without over-sensitive matching
- Status: [x]

---

## UI POLISH ROUND 3

### POL1 — Hero Type Badge Was Too Pill-Shaped

- The series/movie badge used `rounded-full` (fully circular ends), giving it an overly decorative pill look
- Reduced to `rounded` (4 px) with slightly tighter padding (`px-2 py-1`)
- Dot indicator and label unchanged; background opacity slightly reduced for subtlety
- Status: [x]

### POL2 — Episode Card Hover Effect Was Too Heavy

- Cards had `hover:-translate-y-0.5` (lift) + `hover:shadow-lg` on every hover, which felt basic and intrusive
- Removed the translate lift and drop shadow; retained a subtle background/border brightening (`hover:bg-white/[0.05] hover:border-white/[0.1]`)
- Transition changed from `transition-all duration-300` to `transition-colors duration-200` for a snappier, less theatrical feel
- Status: [x]

### POL3 — Episode Thumbnail Opacity Dimmed High-Quality Images

- Non-watched thumbnails were rendered at `opacity-90 group-hover:opacity-100`, making every episode image look slightly washed out
- Changed to `opacity-100` (full quality at rest)
- Watched-but-not-resume thumbnails tightened: `opacity-45 saturate-[0.4]` (more de-emphasised than before) with a gentler group-hover recovery (`opacity-70 saturate-75`)
- Progress bar upgraded from `h-0.5` white gradient to `h-[3px] bg-primary/90` (thicker, accent-coloured, flush edges)
- Play overlay darkened from `bg-black/20` to `bg-black/40` for better contrast; play button simplified (no `backdrop-blur`)
- Status: [x]

### POL4 — Episode Info Layout Had Awkward Duration `pt-5` Hack

- Duration label used `pt-5` to push it below the episode number in a flex row, creating misalignment at different font sizes
- Restructured info column: meta row (EP number + watch check + Resume badge + duration) sits on one line with `justify-between`
- Title on its own line below; description and air date follow naturally
- Resume badge rounding reduced to `rounded` (from `rounded-md`) for consistency with POL1
- Status: [x]

---

## STREAM HANDLING & RECOVERY AUDIT

### PC46 — Fix Recovery-Defeating activeStreamUrl Sync Effect (player.tsx)

- The `activeStreamUrl` sync effect compared `state?.streamUrl !== activeStreamUrl` on every URL change, reverting stream-recovery-set URLs back to the stale saved URL
- Replaced with a ref-tracking approach: `lastRouteStreamUrlRef` tracks the last route-provided URL, so the effect only fires when genuinely new navigation state arrives — not when recovery changes the URL
- Prevents infinite revert cycles where stale-link recovery and slow-start recovery are silently undone

Status: [x]

### PC47 — Stabilize MPV Init Effect Dependencies (player.tsx)

- `handleEnded` and `saveProgress` were direct deps of the MPV init/teardown effect, causing full MPV restarts when async data (details query, `nextEpisode`) changed their callback identities
- Moved both to stable refs (`saveProgressRef`, `handleEndedRef`) synced via lightweight effects, and removed them from the init effect dep array
- MPV observer reads `handleEndedRef.current?.()` and cleanup calls `saveProgressRef.current?.()`, eliminating mid-playback reinit from late-resolving metadata

Status: [x]

### PC48 — Add Timed Result Cache for resolveStream (api.ts)

- `resolveStream` had only in-flight dedup but no result cache, causing redundant debrid API round-trips when the user clicked the same stream multiple times (e.g. back-and-retry)
- Added 5-minute timed cache (`resolveStreamCache`) following the same pattern as `bestStreamCache` and `streamsCache`
- Included `resolveStreamCache` in `clearStreamingCaches()` so addon config changes properly invalidate

Status: [x]

### PC49 — Remove Wrong-Episode Resume Fallback (history-playback.ts)

- `recoverPreciseResumeStartTime` had a fallback that returned the position from _any_ episode with a non-zero position when the exact episode match wasn't found
- This could cause resume to jump to a completely wrong timestamp from a different episode
- Removed the `nearestMeaningful` fallback so the function returns 0 (start from beginning) when the exact episode isn't found

Status: [x]

### PC50 — Keep Player Recovery Alive Across Stream Teardowns (player.tsx)

- `mountedRef` was serving two unrelated jobs at once: real component lifetime and per-stream MPV session teardown
- Stale-link recovery can intentionally clear `activeStreamUrl` to re-enter auto-resolve, but the outgoing MPV cleanup flipped `mountedRef.current = false`, which caused the follow-up resolve path to bail out and left the player stuck loading
- Scoped `mountedRef` back to true component mount/unmount only, while per-stream teardown continues to use the existing local cancel flag plus `isDestroyedRef`

Status: [x]

### PC51 — Remove Auto-Resolve Startup Pause Flicker (player.tsx)

- The player was intentionally starting paused whenever playback came from an auto-resolve path without a route-provided `streamUrl`, then immediately unpausing after `loadfile`
- That extra pause cycle created a visible play/pause flicker during Continue Watching launches even when no resume-seek pause was needed
- Startup pausing is now reserved for meaningful resume seeks only; normal auto-resolved playback starts directly

Status: [x]

### PC52 — Quiet Noisy Stream Debug Logging (streaming_helpers.rs, torrentio.rs)

- Removed the low-signal dev-only `build_stream_query_ids` and per-cache-hit Torrentio debug prints that were flooding the terminal during normal resume/startup flows
- Kept functional stream resolution behavior unchanged while making startup logs more readable

Status: [x]

### PC53 — Mark The Active Stream In Player Selector (stream-selector.tsx)

- Stream selector navigation now forwards the chosen stream key into player route state
- Player passes that key back into the inline selector only while the current route stream still matches the active stream URL, so recovery-driven swaps do not show stale badges
- Added a `Current` badge plus active styling in the selector list so users can identify the stream already in use before switching

Status: [x]

### PC54 — Persist Selected Stream Identity In Watch History (frontend + backend)

- Added `last_stream_key` to watch-progress persistence and history aggregation so Continue Watching launches can carry the previously selected stream identity back into player state
- Player now saves the active stream key only when the current route stream still matches the active URL, preventing stale key persistence after recovery-driven stream swaps
- Selector active-row highlighting now also falls back to direct URL matching when stream keys are missing (legacy history rows)

Status: [x]

### PC55 — Restore Debrid Settings Surface + Normalize Token State (settings.tsx, commands.rs, api.ts)

- Added a dedicated Streaming settings card for Real-Debrid connection, account verification, disconnect flow, and saved-status feedback
- Normalized backend debrid provider handling so only supported providers persist, explicit disable no longer leaves legacy `rd_access_token` state behind, and `get_debrid_config` only exposes a token when Real-Debrid is actually active
- Exposed frontend `rdLogout` so disconnecting also clears persisted debrid stream URLs from watch history instead of leaving stale signed links behind

Status: [x]

### PC56 — Harden Continue-Watching Resume Interactions (resume-section.tsx, profile.tsx, media-card-context-menu.tsx)

- Wrapped continue-watching / history resume launches in explicit error handling so playback-plan failures now surface a toast instead of causing silent promise rejections
- Kept unknown-duration in-progress rows visible in the profile Continue Watching tab to match the home resume rail instead of dropping partially hydrated history items
- Fixed episode subtitle rendering to use explicit numeric checks so specials / episode zero style rows are not hidden by falsy `0` checks

Status: [x]

### PC57 — Add Debrid Resolve Preflight Messaging (stream-selector.tsx)

- Stream resolution now checks both addon availability and debrid configuration before attempting magnet-based resolution, so missing Real-Debrid setup fails early with a clear Settings hint
- Added dedicated Real-Debrid setup/auth toast messaging distinct from generic resolve failures and caching-in-progress states
- Keeps direct HTTP streams unchanged while making torrent-backed resolve errors substantially more actionable

Status: [x]

### PC58 — Return Streaming Settings To Source-First UI (settings.tsx, api.ts)

- Removed the standalone Debrid Connection card from the Streaming settings tab so stream sources remain the primary settings surface
- Trimmed the now-unused frontend debrid settings helpers and account-info type from `src/lib/api.ts` while leaving backend debrid command support intact for stream resolution
- Updated stale data-management copy that still referenced the removed debrid key settings flow

Status: [x]

### PC59 — Tighten Kitsu And Cinemeta Provider Internals (kitsu.rs, cinemeta.rs)

- Extracted shared Kitsu page-size constants, removed a redundant thumbnail clone in episode mapping, and clarified why search URL extras are always emitted as a single path segment
- Added shared Cinemeta URL builders for catalog and search endpoints to reduce duplicated string formatting across discovery and search paths
- Kept provider behavior unchanged while shrinking small pockets of repetitive / redundant code in high-traffic metadata paths

Status: [x]

### PC60 — Stabilize Settings JSX And Tighten Browse Pages (settings.tsx, home.tsx, search.tsx, calendar.tsx)

- Rebuilt the `DataManager` return tail in `src/pages/settings.tsx` so the card structure has an unambiguous parent tree, which clears the transient JSX parse failures reported around the closing section
- Extracted shared lightweight helpers/constants in Home and Search to remove repeated prefetch/page-size/year parsing logic while preserving the existing fetch and filter behavior
- Tightened Calendar event flattening with a single current-year capture and clearer query iteration, keeping the release schedule output unchanged while reducing small pockets of repetition

Status: [x]

### PC61 — Harden Next-Episode, Stream URL, And Cinemeta Failure Paths (player.tsx, stream-selector.tsx, stream-selector-utils.ts, cinemeta.rs, search.tsx)

- Replaced strict `episode + 1` next-episode lookup with a sorted next-candidate helper so sparse or slightly irregular episode data still advances predictably across season boundaries
- Normalized direct HTTP stream detection to trim and compare URLs case-insensitively before filtering, sorting, or resolving selector items, preventing valid direct links from being hidden by trivial formatting variance
- Changed Cinemeta search to surface a real provider error when all parallel catalog searches fail instead of quietly returning an empty result set, and aligned the search result cap message to the actual 2000-item cap

Status: [x]

### PC62 — Unify Resume Fallbacks Across Continue Watching And Details (history-playback.ts, details.tsx)

- Changed continue-watching warmup to pre-resolve a fresh best-stream backup even when a saved remote HTTP stream still exists, so history launches have a faster fallback ready if the persisted link has expired
- Replaced the duplicated Details-page continue/resume branch with the shared `buildHistoryPlaybackPlan(...)` flow so movie and series resume actions now follow the same saved-stream, backup-resolve, and player-route behavior as the home/profile continue-watching surfaces
- Removed the old Details-specific direct-resume branch that could fall back to the stream selector instead of auto-playing the best configured backup stream

Status: [x]
