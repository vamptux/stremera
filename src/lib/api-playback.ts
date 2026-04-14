import type {
  BestResolvedStream,
  HistoryPlaybackPlan,
  PlaybackLanguagePreferences,
  RecoverPlaybackStreamOptions,
  ResolveBestStreamOptions,
  ResolvedStream,
  SearchCatalogPage,
  SkipSegment,
  StreamSelectorData,
  StreamSelectorPreferences,
  TorrentioStream,
  TrackLanguageCandidate,
  TrackLanguageSelectionResolution,
  WatchProgress,
} from '@/lib/api';
import {
  type ApiCacheGroups,
  buildResolveStreamKey,
  buildStreamCacheKey,
  clearStreamingCaches,
  type RequestCache,
  runCachedRequest,
} from '@/lib/api-cache';
import type { PlaybackStreamOutcomeReport } from '@/lib/playback-stream-health';
import {
  buildStreamRankingCacheKey,
  buildStreamRankingInvokePayload,
  type StreamRankingOptions,
} from '@/lib/stream-ranking';

type InvokeApi = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface PlaybackApiCaches extends ApiCacheGroups {
  bestStream: RequestCache<BestResolvedStream>;
  resolveStream: RequestCache<ResolvedStream>;
  streams: RequestCache<TorrentioStream[]>;
  streamSelector: RequestCache<StreamSelectorData>;
  searchCatalog: RequestCache<SearchCatalogPage>;
}

interface PlaybackApiContext {
  safeInvoke: InvokeApi;
  caches: PlaybackApiCaches;
  normalizeStreamMediaType: (type: string) => string;
}

export function createPlaybackApi({
  safeInvoke,
  caches,
  normalizeStreamMediaType,
}: PlaybackApiContext) {
  return {
    getStreams: (
      type: string,
      id: string,
      season?: number,
      episode?: number,
      absoluteEpisode?: number,
      options?: StreamRankingOptions,
    ) => {
      const normalizedType = normalizeStreamMediaType(type);
      const cacheKey = `${buildStreamCacheKey(normalizedType, id, season, episode, absoluteEpisode)}|${buildStreamRankingCacheKey(options)}`;
      return runCachedRequest(caches.streams, cacheKey, () =>
        safeInvoke<TorrentioStream[]>('get_streams', {
          mediaType: normalizedType,
          id,
          season,
          episode,
          absolute_episode: absoluteEpisode,
          ...buildStreamRankingInvokePayload(options),
        }),
      );
    },
    getStreamSelectorData: (
      type: string,
      id: string,
      season?: number,
      episode?: number,
      absoluteEpisode?: number,
      options?: StreamRankingOptions,
    ) => {
      const normalizedType = normalizeStreamMediaType(type);
      const cacheKey = `${buildStreamCacheKey(normalizedType, id, season, episode, absoluteEpisode)}|${buildStreamRankingCacheKey(options)}`;
      return runCachedRequest(caches.streamSelector, cacheKey, () =>
        safeInvoke<StreamSelectorData>('get_stream_selector_data', {
          mediaType: normalizedType,
          id,
          season,
          episode,
          absolute_episode: absoluteEpisode,
          ...buildStreamRankingInvokePayload(options),
        }),
      );
    },
    filterStreamSelectorStreams: (streams: TorrentioStream[], filters: StreamSelectorPreferences) =>
      safeInvoke<TorrentioStream[]>('filter_stream_selector_streams', {
        streams,
        filters,
      }),
    resolveStream: (
      magnet: string,
      infoHash?: string,
      fileIdx?: number,
      season?: number,
      episode?: number,
      url?: string,
    ) => {
      const cacheKey = buildResolveStreamKey(magnet, infoHash, fileIdx, season, episode, url);
      return runCachedRequest(caches.resolveStream, cacheKey, () =>
        safeInvoke<ResolvedStream>('resolve_stream', {
          magnet,
          info_hash: infoHash,
          file_idx: fileIdx,
          season,
          episode,
          url,
        }),
      );
    },
    resolveBestStream: (
      type: string,
      id: string,
      season?: number,
      episode?: number,
      absoluteEpisode?: number,
      options?: ResolveBestStreamOptions,
    ) => {
      const normalizedType = normalizeStreamMediaType(type);
      const cacheKey = `${buildStreamCacheKey(normalizedType, id, season, episode, absoluteEpisode)}|${buildStreamRankingCacheKey(options)}`;
      const bypassCache = !!options?.bypassCache;
      const inFlightKey = bypassCache ? `${cacheKey}|bypass` : cacheKey;

      return runCachedRequest(
        caches.bestStream,
        cacheKey,
        () =>
          safeInvoke<BestResolvedStream>('resolve_best_stream', {
            mediaType: normalizedType,
            id,
            season,
            episode,
            absolute_episode: absoluteEpisode,
            ...buildStreamRankingInvokePayload(options),
          }),
        { bypassCache, inFlightKey },
      );
    },
    recoverPlaybackStream: ({
      mediaType,
      mediaId,
      streamSeason,
      streamEpisode,
      absoluteSeason,
      absoluteEpisode,
      streamLookupId,
      failedStreamUrl,
      failedStreamFormat,
      failedSourceName,
      failedStreamFamily,
      failedStreamKey,
      outcome,
      preparedBackupStream,
      ...rankingOptions
    }: RecoverPlaybackStreamOptions) => {
      const normalizedType = normalizeStreamMediaType(mediaType);

      return safeInvoke<BestResolvedStream | null>('recover_playback_stream', {
        mediaType: normalizedType,
        id: mediaId,
        season: streamSeason,
        episode: streamEpisode,
        absolute_season: absoluteSeason,
        absolute_episode: absoluteEpisode,
        stream_lookup_id: streamLookupId,
        failed_stream_url: failedStreamUrl,
        failed_stream_format: failedStreamFormat,
        failed_source_name: failedSourceName,
        failed_stream_family: failedStreamFamily,
        failed_stream_key: failedStreamKey,
        outcome,
        prepared_backup_stream: preparedBackupStream,
        ...buildStreamRankingInvokePayload(rankingOptions),
      });
    },
    savePlaybackLanguagePreferences: (
      preferredAudioLanguage?: string,
      preferredSubtitleLanguage?: string,
    ) =>
      safeInvoke<PlaybackLanguagePreferences>('save_playback_language_preferences', {
        preferredAudioLanguage,
        preferredSubtitleLanguage,
      }).then((savedPreferences) => {
        clearStreamingCaches(caches);
        return savedPreferences;
      }),
    getPlaybackLanguagePreferences: () =>
      safeInvoke<PlaybackLanguagePreferences>('get_playback_language_preferences'),
    getEffectivePlaybackLanguagePreferences: (mediaId?: string, mediaType?: string) =>
      safeInvoke<PlaybackLanguagePreferences>('get_effective_playback_language_preferences', {
        media_id: mediaId,
        media_type: mediaType,
      }),
    resolvePreferredTrackSelection: (
      tracks: TrackLanguageCandidate[],
      preferredLanguage?: string,
      selectedTrackId?: number,
    ) =>
      safeInvoke<TrackLanguageSelectionResolution>('resolve_preferred_track_selection', {
        tracks,
        preferred_language: preferredLanguage,
        selected_track_id: selectedTrackId,
      }),
    saveSelectedPlaybackLanguagePreference: (
      preferenceKind: 'audio' | 'sub',
      track?: TrackLanguageCandidate,
      subtitlesOff?: boolean,
    ) =>
      safeInvoke<PlaybackLanguagePreferences>('save_selected_playback_language_preference', {
        preference_kind: preferenceKind,
        track,
        subtitles_off: subtitlesOff,
      }),
    savePlaybackLanguagePreferenceOutcomeFromTracks: (
      mediaId: string,
      mediaType: string,
      audioTrack?: TrackLanguageCandidate,
      subtitleTrack?: TrackLanguageCandidate,
      subtitlesOff?: boolean,
    ) =>
      safeInvoke<void>('save_playback_language_preference_outcome_from_tracks', {
        media_id: mediaId,
        media_type: mediaType,
        audio_track: audioTrack,
        subtitle_track: subtitleTrack,
        subtitles_off: subtitlesOff,
      }),
    reportPlaybackStreamOutcome: (report: PlaybackStreamOutcomeReport) =>
      safeInvoke<void>(
        'report_playback_stream_outcome',
        report as unknown as Record<string, unknown>,
      ),
    saveWatchProgress: (progress: WatchProgress) =>
      safeInvoke<void>('save_watch_progress', { progress }),
    getWatchHistory: () => safeInvoke<WatchProgress[]>('get_watch_history'),
    getContinueWatching: () => safeInvoke<WatchProgress[]>('get_continue_watching'),
    getWatchHistoryFull: () => safeInvoke<WatchProgress[]>('get_watch_history_full'),
    getWatchHistoryForId: (id: string) =>
      safeInvoke<WatchProgress[]>('get_watch_history_for_id', { id }),
    buildHistoryPlaybackPlan: (item: WatchProgress, from: string) =>
      safeInvoke<HistoryPlaybackPlan>('build_history_playback_plan', { item, from }),
    getWatchProgress: (id: string, type: string, season?: number, episode?: number) =>
      safeInvoke<WatchProgress | null>('get_watch_progress', {
        id,
        type,
        season,
        episode,
      }),
    removeFromWatchHistory: (id: string, type: string, season?: number, episode?: number) =>
      safeInvoke<void>('remove_from_watch_history', { id, type, season, episode }),
    removeAllFromWatchHistory: (id: string, type: string) =>
      safeInvoke<void>('remove_all_from_watch_history', { id, type }),
    getSkipTimes: (
      mediaType: string,
      id: string,
      imdbId: string | undefined,
      season: number | undefined,
      episode: number | undefined,
      duration?: number,
    ) => {
      const normalizedDuration =
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? duration
          : undefined;

      return safeInvoke<SkipSegment[]>('get_skip_times', {
        mediaType,
        id,
        imdbId,
        season,
        episode,
        duration: normalizedDuration,
      });
    },
  };
}
