import { invoke } from '@tauri-apps/api/core';
import type {
  PlaybackStreamOutcomeReport,
  PlaybackStreamReusePolicy,
} from '@/lib/playback-stream-health';
import { handlePreviewInvoke } from '@/lib/api-preview-mocks';
import {
  buildStreamRankingCacheKey,
  buildStreamRankingInvokePayload,
  type StreamRankingOptions,
} from '@/lib/stream-ranking';

const isDev = import.meta.env.DEV;

function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Shared error-message extractor (exported for use across the app)
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error;
    if (typeof anyErr.err === 'string' && anyErr.err) return anyErr.err;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauriDesktopRuntime()) {
      return await invoke<T>(command, args);
    }

    if (isDev) console.warn(`[Preview] invoking ${command}`);
    return await handlePreviewInvoke<T>(command, args);
  } catch (e) {
    if (isDev) console.error(`Raw invoke error for ${command}:`, e);
    const message = getErrorMessage(e);
    if (isDev) console.error(`Processed error message for ${command}:`, message);
    throw new Error(message || 'Unknown error (empty message)');
  }
}

export interface MediaItem {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  description?: string;
  year?: string;
  type: 'movie' | 'series';
  relationRole?: string;
}

export interface Episode {
  id: string;
  title?: string;
  season: number;
  episode: number;
  released?: string;
  overview?: string;
  thumbnail?: string;
  /** IMDB ID of the parent series (e.g. "tt0388629") — present for Kitsu anime */
  imdbId?: string;
  /** IMDB season number — may differ from source season for long-running anime */
  imdbSeason?: number;
  /** IMDB episode number within the IMDB season */
  imdbEpisode?: number;
}

export interface Trailer {
  id: string;
  source: string;
  url: string;
}

export interface MediaDetails extends MediaItem {
  imdbId?: string;
  description?: string;
  rating?: string;
  cast?: string[];
  genres?: string[];
  trailers?: Trailer[];
  episodes?: Episode[];
  relations?: MediaItem[];
}

export interface MediaEpisodesPage {
  episodes: Episode[];
  seasons: number[];
  seasonYears?: Record<string, string>;
  total: number;
  totalInSeason: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface UserList {
  id: string;
  name: string;
  icon: string;
  item_ids: string[];
  items: MediaItem[];
}

export type WatchStatus = 'watching' | 'watched' | 'plan_to_watch' | 'dropped';

export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  watching: 'Watching',
  watched: 'Watched',
  plan_to_watch: 'Plan to Watch',
  dropped: 'Dropped',
};

export const WATCH_STATUS_COLORS: Record<
  WatchStatus,
  { text: string; bg: string; border: string }
> = {
  watching: { text: 'text-blue-400', bg: 'bg-blue-500/15', border: 'border-blue-500/30' },
  watched: { text: 'text-green-400', bg: 'bg-green-500/15', border: 'border-green-500/30' },
  plan_to_watch: {
    text: 'text-yellow-400',
    bg: 'bg-yellow-500/15',
    border: 'border-yellow-500/30',
  },
  dropped: { text: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30' },
};

export interface TorrentioStream {
  name?: string;
  title?: string;
  infoHash?: string;
  url?: string;
  fileIdx?: number;
  behaviorHints?: {
    bingeGroup?: string;
  };
  cached?: boolean;
  seeders?: number;
  size_bytes?: number;
  /** Addon/source that returned this stream (set by the backend). */
  source_name?: string;
  /** Stable backend-derived release family used for adjacent-episode ranking. */
  stream_family?: string;
  /** Backend coordinator explanation for why this stream ranks where it does. */
  recommendation_reasons?: string[];
}

export interface PreparedPlaybackStream {
  url: string;
  format: string;
  sourceName?: string;
  streamFamily?: string;
}

export interface NextPlaybackCanonicalEpisode {
  title?: string;
  season: number;
  episode: number;
}

export interface NextPlaybackSourceCoordinates {
  lookupId: string;
  season: number;
  episode: number;
  aniskipEpisode: number;
}

export interface NextPlaybackPlan {
  canonical: NextPlaybackCanonicalEpisode;
  source: NextPlaybackSourceCoordinates;
  lookupKey: string;
  primaryStream?: PreparedPlaybackStream;
  backupStream?: PreparedPlaybackStream;
}

export interface EpisodeStreamMapping {
  lookupId: string;
  canonicalSeason: number;
  canonicalEpisode: number;
  sourceSeason: number;
  sourceEpisode: number;
  aniskipEpisode: number;
}

export interface AnimeCharacterProfile {
  name: string;
  role?: string;
  image?: string;
  description?: string;
}

export interface AnimeStaffProfile {
  name: string;
  roles: string[];
  image?: string;
  description?: string;
}

export interface AnimeProductionCompanyProfile {
  name: string;
  roles: string[];
  logo?: string;
  description?: string;
}

export interface AnimeStreamingPlatformProfile {
  name: string;
  url: string;
  logo?: string;
  subLanguages: string[];
  dubLanguages: string[];
}

export interface AnimeSupplementalMetadata {
  characters: AnimeCharacterProfile[];
  staff: AnimeStaffProfile[];
  productions: AnimeProductionCompanyProfile[];
  platforms: AnimeStreamingPlatformProfile[];
  warnings: string[];
}

export interface ResolvedStream {
  url: string;
  is_web_friendly: boolean;
  format: string;
}

export interface BestResolvedStream extends ResolvedStream {
  used_fallback: boolean;
  source_name?: string;
  stream_family?: string;
}

export interface ResolveBestStreamOptions extends StreamRankingOptions {
  bypassCache?: boolean;
}

export interface PlaybackSessionTouchRequest {
  id: string;
  type_: string;
  season?: number;
  episode?: number;
  absolute_season?: number;
  absolute_episode?: number;
  stream_season?: number;
  stream_episode?: number;
  aniskip_episode?: number;
  title: string;
  stream_url?: string;
  stream_format?: string;
  stream_lookup_id?: string;
  stream_key?: string;
  source_name?: string;
  stream_family?: string;
  position?: number;
  duration?: number;
}

/** A user-configured Stremio-compatible addon source. */
export interface AddonConfig {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
}

/** Parsed name/description from a Stremio addon's manifest.json. */
export interface AddonManifest {
  name: string;
  description?: string;
  version?: string;
}

const BEST_STREAM_CACHE_TTL_MS = 1000 * 60 * 8;
const STREAMS_CACHE_TTL_MS = 1000 * 60 * 3;
const MEDIA_DETAILS_CACHE_TTL_MS = 1000 * 60 * 30;
const SEARCH_CACHE_TTL_MS = 1000 * 60 * 2;
const API_CACHE_MAX_ENTRIES = 200;
const RESOLVE_STREAM_CACHE_TTL_MS = 1000 * 60 * 5;
const MULTI_GENRE_CACHE_TTL_MS = 1000 * 60 * 5;

type TimedCacheEntry<T> = { value: T; expiresAt: number };

interface RequestCache<T> {
  ttlMs: number;
  values: Map<string, TimedCacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  clear: () => void;
}

function createRequestCache<T>(ttlMs: number): RequestCache<T> {
  const values = new Map<string, TimedCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    ttlMs,
    values,
    inFlight,
    clear: () => {
      values.clear();
      inFlight.clear();
    },
  };
}

const bestStreamRequestCache = createRequestCache<BestResolvedStream>(BEST_STREAM_CACHE_TTL_MS);
const resolveStreamRequestCache = createRequestCache<ResolvedStream>(RESOLVE_STREAM_CACHE_TTL_MS);
const streamsRequestCache = createRequestCache<TorrentioStream[]>(STREAMS_CACHE_TTL_MS);
const mediaDetailsRequestCache = createRequestCache<MediaDetails>(MEDIA_DETAILS_CACHE_TTL_MS);
const searchRequestCache = createRequestCache<MediaItem[]>(SEARCH_CACHE_TTL_MS);
const multiGenreRequestCache = createRequestCache<MultiGenreCatalogPage>(MULTI_GENRE_CACHE_TTL_MS);

function pruneTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  maxEntries = API_CACHE_MAX_ENTRIES,
) {
  const now = Date.now();

  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function setTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  pruneTimedCache(cache);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  pruneTimedCache(cache);
}

function getTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
): T | null {
  const now = Date.now();
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function runCachedRequest<T>(
  cache: RequestCache<T>,
  cacheKey: string,
  load: () => Promise<T>,
  options?: { bypassCache?: boolean; inFlightKey?: string },
): Promise<T> {
  const bypassCache = options?.bypassCache ?? false;
  const inFlightKey = options?.inFlightKey ?? cacheKey;

  if (!bypassCache) {
    const cached = getTimedCache(cache.values, cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }
  } else {
    cache.values.delete(cacheKey);
  }

  const inFlight = cache.inFlight.get(inFlightKey);
  if (inFlight) {
    return inFlight;
  }

  const request = load()
    .then((result) => {
      setTimedCache(cache.values, cacheKey, result, cache.ttlMs);
      return result;
    })
    .finally(() => {
      cache.inFlight.delete(inFlightKey);
    });

  cache.inFlight.set(inFlightKey, request);
  return request;
}

function clearRequestCaches(...caches: Array<RequestCache<unknown>>) {
  for (const cache of caches) {
    cache.clear();
  }
}

function clearStreamingCaches() {
  clearRequestCaches(streamsRequestCache, bestStreamRequestCache, resolveStreamRequestCache);
}

function buildResolveStreamKey(
  magnet: string,
  infoHash?: string,
  fileIdx?: number,
  season?: number,
  episode?: number,
  url?: string,
): string {
  return [
    magnet,
    infoHash ?? 'na',
    fileIdx ?? 'na',
    season ?? 'na',
    episode ?? 'na',
    url ?? 'na',
  ].join('|');
}

function buildStreamCacheKey(
  type: string,
  id: string,
  season?: number,
  episode?: number,
  absoluteEpisode?: number,
): string {
  return `${type}|${id}|${season ?? 'na'}|${episode ?? 'na'}|${absoluteEpisode ?? 'na'}`;
}

function normalizeStreamMediaType(type: string, id: string): string {
  const normalizedType = type.trim().toLowerCase();
  if (normalizedType === 'movie' || normalizedType === 'anime') return normalizedType;
  if (normalizedType === 'series' && id.trim().toLowerCase().startsWith('kitsu:')) {
    return 'anime';
  }
  return normalizedType;
}

function buildMediaDetailsCacheKey(type: string, id: string): string {
  return `${type.trim().toLowerCase()}|${id.trim()}`;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

function normalizeGenreFilters(genres: string[]): string[] {
  return Array.from(
    new Set(
      genres
        .map((genre) => genre.trim())
        .filter((genre) => genre.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export interface PlaybackLanguagePreferences {
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

export interface MultiGenreCatalogPage {
  items: MediaItem[];
  hasMore: boolean;
}

export const api = {
  getTrendingMovies: (genre?: string) => safeInvoke<MediaItem[]>('get_trending_movies', { genre }),
  getTrendingSeries: (genre?: string) => safeInvoke<MediaItem[]>('get_trending_series', { genre }),
  getTrendingAnime: (genre?: string) => safeInvoke<MediaItem[]>('get_trending_anime', { genre }),
  getCinemetaCatalog: (mediaType: string, catalogId: string, genre?: string, skip?: number) =>
    safeInvoke<MediaItem[]>('get_cinemeta_catalog', { mediaType, catalogId, genre, skip }),
  /** Browse-optimised: merges both top + imdbRating catalogs for ~2x content */
  getCinemetaDiscover: (mediaType: string, catalogId: string, genre?: string) =>
    safeInvoke<MediaItem[]>('get_cinemeta_discover', { mediaType, catalogId, genre }),
  getMultiGenreCatalog: (
    mediaType: string,
    catalogId: string,
    genres: string[],
    skip?: number,
  ) => {
    const normalizedGenres = normalizeGenreFilters(genres);
    const cacheKey = [
      mediaType.trim().toLowerCase(),
      catalogId.trim(),
      normalizedGenres.join('|'),
      skip ?? 0,
    ].join('|');

    return runCachedRequest(multiGenreRequestCache, cacheKey, () =>
      safeInvoke<MultiGenreCatalogPage>('get_multi_genre_catalog', {
        mediaType,
        catalogId,
        genres: normalizedGenres,
        skip,
      }),
    );
  },
  searchMedia: (query: string) => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return Promise.resolve([]);

    const cacheKey = normalizedQuery.toLowerCase();
    return runCachedRequest(searchRequestCache, cacheKey, () =>
      safeInvoke<MediaItem[]>('search_media', { query: normalizedQuery }),
    );
  },
  getMediaDetails: (type: string, id: string, options?: { includeEpisodes?: boolean }) => {
    const normalizedType = type.trim();
    const normalizedId = id.trim();
    const includeEpisodes = options?.includeEpisodes ?? true;
    const cacheKey = `${buildMediaDetailsCacheKey(normalizedType, normalizedId)}|${includeEpisodes ? 'full' : 'lite'}`;

    return runCachedRequest(mediaDetailsRequestCache, cacheKey, () =>
      safeInvoke<MediaDetails>('get_media_details', {
        mediaType: normalizedType,
        id: normalizedId,
        include_episodes: includeEpisodes,
      }),
    );
  },
  getMediaEpisodes: (type: string, id: string, season?: number, page?: number, pageSize?: number) =>
    safeInvoke<MediaEpisodesPage>('get_media_episodes', {
      mediaType: type,
      id,
      season,
      page,
      page_size: pageSize,
    }),
  getEpisodeStreamMapping: (
    type: string,
    id: string,
    canonicalSeason: number,
    canonicalEpisode: number,
  ) =>
    safeInvoke<EpisodeStreamMapping | null>('get_episode_stream_mapping', {
      mediaType: type,
      id,
      canonical_season: canonicalSeason,
      canonical_episode: canonicalEpisode,
    }),
  getKitsuAnimeMetadata: (id: string) =>
    safeInvoke<AnimeSupplementalMetadata>('get_kitsu_anime_metadata', {
      id,
    }),
  prepareNextPlaybackPlan: (
    type: string,
    id: string,
    currentSeason: number,
    currentEpisode: number,
    currentStreamLookupId?: string,
  ) =>
    safeInvoke<NextPlaybackPlan | null>('prepare_next_playback_plan', {
      mediaType: type,
      id,
      current_season: currentSeason,
      current_episode: currentEpisode,
      current_stream_lookup_id: currentStreamLookupId,
    }),

  // Streaming
  getStreams: (
    type: string,
    id: string,
    season?: number,
    episode?: number,
    absoluteEpisode?: number,
    options?: StreamRankingOptions,
  ) => {
    const normalizedType = normalizeStreamMediaType(type, id);
    const cacheKey = `${buildStreamCacheKey(normalizedType, id, season, episode, absoluteEpisode)}|${buildStreamRankingCacheKey(options)}`;
    return runCachedRequest(streamsRequestCache, cacheKey, () =>
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
  getStreamsForAddon: (
    type: string,
    id: string,
    addonUrl: string,
    addonName?: string,
    season?: number,
    episode?: number,
    absoluteEpisode?: number,
  ) => {
    const normalizedType = normalizeStreamMediaType(type, id);
    return safeInvoke<TorrentioStream[]>('get_streams_for_addon', {
      mediaType: normalizedType,
      id,
      addonUrl,
      addonName,
      season,
      episode,
      absolute_episode: absoluteEpisode,
    });
  },
  resolveStream: (
    magnet: string,
    infoHash?: string,
    fileIdx?: number,
    season?: number,
    episode?: number,
    url?: string,
  ) => {
    const cacheKey = buildResolveStreamKey(magnet, infoHash, fileIdx, season, episode, url);
    return runCachedRequest(resolveStreamRequestCache, cacheKey, () =>
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
    const normalizedType = normalizeStreamMediaType(type, id);
    const cacheKey = `${buildStreamCacheKey(normalizedType, id, season, episode, absoluteEpisode)}|${buildStreamRankingCacheKey(options)}`;
    const bypassCache = !!options?.bypassCache;
    const inFlightKey = bypassCache ? `${cacheKey}|bypass` : cacheKey;

    return runCachedRequest(
      bestStreamRequestCache,
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

  // Settings
  getAddonConfigs: () => safeInvoke<AddonConfig[]>('get_addon_configs'),
  saveAddonConfigs: async (configs: AddonConfig[]) => {
    await safeInvoke<void>('save_addon_configs', { configs });
    clearStreamingCaches();
  },
  fetchAddonManifest: (url: string) => safeInvoke<AddonManifest>('fetch_addon_manifest', { url }),
  savePlaybackLanguagePreferences: (
    preferredAudioLanguage?: string,
    preferredSubtitleLanguage?: string,
  ) =>
    safeInvoke<void>('save_playback_language_preferences', {
      preferredAudioLanguage,
      preferredSubtitleLanguage,
    }).then(() => {
      clearStreamingCaches();
    }),
  getPlaybackLanguagePreferences: () =>
    safeInvoke<PlaybackLanguagePreferences>('get_playback_language_preferences'),
  getEffectivePlaybackLanguagePreferences: (mediaId?: string, mediaType?: string) =>
    safeInvoke<PlaybackLanguagePreferences>('get_effective_playback_language_preferences', {
      media_id: mediaId,
      media_type: mediaType,
    }),
  savePlaybackLanguagePreferenceOutcome: (
    mediaId: string,
    mediaType: string,
    preferredAudioLanguage?: string,
    preferredSubtitleLanguage?: string,
  ) =>
    safeInvoke<void>('save_playback_language_preference_outcome', {
      media_id: mediaId,
      media_type: mediaType,
      preferred_audio_language: preferredAudioLanguage,
      preferred_subtitle_language: preferredSubtitleLanguage,
    }),
  getPlaybackStreamReusePolicy: (id: string, type: string, season?: number, episode?: number) =>
    safeInvoke<PlaybackStreamReusePolicy>('get_playback_stream_reuse_policy', {
      id,
      type: type,
      season,
      episode,
    }),
  touchPlaybackSession: (session: PlaybackSessionTouchRequest) =>
    safeInvoke<void>('touch_playback_session', {
      session,
    }),
  reportPlaybackStreamOutcome: (report: PlaybackStreamOutcomeReport) =>
    safeInvoke<void>('report_playback_stream_outcome', report as unknown as Record<string, unknown>),

  // Watch History
  saveWatchProgress: (progress: WatchProgress) => safeInvoke('save_watch_progress', { progress }),
  getWatchHistory: () => safeInvoke<WatchProgress[]>('get_watch_history'),
  getContinueWatching: () => safeInvoke<WatchProgress[]>('get_continue_watching'),
  getWatchHistoryFull: () => safeInvoke<WatchProgress[]>('get_watch_history_full'),
  getWatchHistoryForId: (id: string) =>
    safeInvoke<WatchProgress[]>('get_watch_history_for_id', { id }),
  getWatchProgress: (id: string, type: string, season?: number, episode?: number) =>
    safeInvoke<WatchProgress | null>('get_watch_progress', { id, type: type, season, episode }),
  removeFromWatchHistory: (id: string, type: string, season?: number, episode?: number) =>
    safeInvoke('remove_from_watch_history', { id, type: type, season, episode }),
  /** Remove every episode/entry for a given title – use this from the trash button. */
  removeAllFromWatchHistory: (id: string, type: string) =>
    safeInvoke('remove_all_from_watch_history', { id, type: type }),

  // Library
  addToLibrary: (item: MediaItem) => safeInvoke('add_to_library', { item }),
  removeFromLibrary: (id: string) => safeInvoke('remove_from_library', { id }),
  getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
  checkLibrary: (id: string) => safeInvoke<boolean>('check_library', { id }),

  // Custom Lists
  createList: (name: string, icon?: string) => safeInvoke<UserList>('create_list', { name, icon }),
  deleteList: (listId: string) => safeInvoke<void>('delete_list', { listId }),
  renameList: (listId: string, name: string, icon?: string) =>
    safeInvoke<void>('rename_list', { listId, name, icon }),
  addToList: (listId: string, item: MediaItem) => safeInvoke<void>('add_to_list', { listId, item }),
  removeFromList: (listId: string, itemId: string) =>
    safeInvoke<void>('remove_from_list', { listId, itemId }),
  getLists: () => safeInvoke<UserList[]>('get_lists'),
  reorderListItems: (listId: string, itemIds: string[]) =>
    safeInvoke<void>('reorder_list_items', { listId, itemIds }),
  reorderLists: (listIds: string[]) => safeInvoke<void>('reorder_lists', { listIds }),
  checkItemInLists: (itemId: string) => safeInvoke<string[]>('check_item_in_lists', { itemId }),

  // Watch Status
  setWatchStatus: (itemId: string, status: WatchStatus | null) =>
    safeInvoke<void>('set_watch_status', { itemId, status }),
  getWatchStatus: (itemId: string) =>
    safeInvoke<WatchStatus | null>('get_watch_status', { itemId }),
  getAllWatchStatuses: () => safeInvoke<Record<string, WatchStatus>>('get_all_watch_statuses'),

  // Netflix & Kitsu
  getNetflixCatalog: (catalogId: string, type: string, skip?: number) =>
    safeInvoke<MediaItem[]>('get_netflix_catalog', { catalogId, mediaType: type, skip }),
  getKitsuCatalog: (catalogId: string, genre?: string, skip?: number) =>
    safeInvoke<MediaItem[]>('get_kitsu_catalog', { catalogId, genre, skip }),
  searchKitsu: (query: string) => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return Promise.resolve([]);

    const cacheKey = `kitsu|${normalizedQuery.toLowerCase()}`;
    return runCachedRequest(searchRequestCache, cacheKey, () =>
      safeInvoke<MediaItem[]>('search_kitsu', { query: normalizedQuery }),
    );
  },

  /**
   * Fetch skippable segment timestamps for a TV episode.
   *
   * - Anime (`type === 'anime'` or `id` starts with `'kitsu:'`): resolves MAL mapping via
   *   Kitsu and queries AniSkip v2.
   * - Series (`type === 'series'`): queries IntroDB using the IMDb ID.
   *
   * Returns an empty array when no data is available (crowdsourced – may not exist).
   */
  getSkipTimes: (
    mediaType: string,
    id: string,
    imdbId: string | undefined,
    season: number | undefined,
    episode: number | undefined,
    duration?: number,
  ) =>
    safeInvoke<SkipSegment[]>('get_skip_times', {
      mediaType,
      id,
      imdbId,
      season,
      episode,
      duration: duration ?? 0,
    }),

  // Returns true when at least one enabled addon is configured (stream resolution is possible)
  checkApiKeys: async () => {
    try {
      const addons = await api.getAddonConfigs();
      return addons.some((a) => a.enabled && a.url.trim().length > 0);
    } catch {
      return false;
    }
  },

  // Downloads
  startDownload: (params: StartDownloadParams) =>
    safeInvoke<string>('start_download', params as unknown as Record<string, unknown>),
  pauseDownload: (id: string) => safeInvoke<void>('pause_download', { id }),
  pauseActiveDownloads: () => safeInvoke<number>('pause_active_downloads'),
  resumeDownload: (id: string) => safeInvoke<void>('resume_download', { id }),
  cancelDownload: (id: string) => safeInvoke<void>('cancel_download', { id }),
  /** Verifies the on-disk file for a completed download still exists.
   *  Returns false (and marks the item as Error in the backend) if missing. */
  checkDownloadFileExists: (id: string) =>
    safeInvoke<boolean>('check_download_file_exists', { id }),
  removeDownload: (id: string, deleteFile: boolean) =>
    safeInvoke<void>('remove_download', { id, deleteFile }),
  clearCompletedDownloads: (deleteFile = false) =>
    safeInvoke<number>('clear_completed_downloads', { deleteFile }),
  getDownloads: () => safeInvoke<DownloadItem[]>('get_downloads'),
  setDownloadBandwidth: (limit?: number) => safeInvoke<void>('set_download_bandwidth', { limit }),
  getDefaultDownloadPath: () => safeInvoke<string>('get_default_download_path'),
  openFolder: (path: string) => safeInvoke<void>('open_folder', { path }),

  // Data Management
  getDataStats: () => safeInvoke<DataStats>('get_data_stats'),
  clearWatchHistory: () => safeInvoke<void>('clear_watch_history'),
  clearLibrary: () => safeInvoke<void>('clear_library'),
  clearAllLists: () => safeInvoke<void>('clear_all_lists'),
  clearAllWatchStatuses: () => safeInvoke<void>('clear_all_watch_statuses'),
  /** Serialises all user data (history, library, lists, statuses) to a JSON string for download. */
  exportAppData: () => safeInvoke<string>('export_app_data'),
  /** Exports all data directly to a user-selected file path on desktop. */
  exportAppDataToFile: (path: string) => safeInvoke<void>('export_app_data_to_file', { path }),
  /** Merges a previously exported JSON backup into current stores. Returns import counts. */
  importAppData: (data: string) => safeInvoke<ImportResult>('import_app_data', { data }),
  /** Imports backup data directly from a selected JSON file path on desktop. */
  importAppDataFromFile: (path: string) =>
    safeInvoke<ImportResult>('import_app_data_from_file', { path }),
};

export interface DownloadItem {
  id: string;
  title: string;
  url: string;
  filePath: string;
  fileName: string;
  totalSize: number;
  downloadedSize: number;
  speed: number;
  progress: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
  error?: string;
  createdAt: number;
  updatedAt: number;
  poster?: string;
  mediaType?: string;
  bandwidthLimit?: number;
  mediaId?: string;
  season?: number;
  episode?: number;
}

export interface StartDownloadParams {
  title: string;
  url: string;
  filePath: string;
  fileName: string;
  poster?: string;
  mediaType?: string;
  bandwidthLimit?: number;
  mediaId?: string;
  season?: number;
  episode?: number;
}

export interface DataStats {
  history_count: number;
  library_count: number;
  lists_count: number;
  watch_statuses_count: number;
}

export interface ImportResult {
  history_imported: number;
  library_imported: number;
  lists_imported: number;
  statuses_imported: number;
}

export interface DownloadProgressEvent {
  id: string;
  downloadedSize: number;
  totalSize: number;
  speed: number;
  progress: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
}

export interface WatchProgress {
  id: string;
  type_: string;
  season?: number;
  episode?: number;
  absolute_season?: number;
  absolute_episode?: number;
  stream_season?: number;
  stream_episode?: number;
  aniskip_episode?: number;
  position: number;
  duration: number;
  last_watched: number;
  title: string;
  poster?: string;
  backdrop?: string;
  last_stream_url?: string;
  last_stream_format?: string;
  last_stream_lookup_id?: string;
  last_stream_key?: string;
  source_name?: string;
  stream_family?: string;
}

/**
 * A single skippable playback segment returned by either AniSkip (anime)
 * or IntroDB (TV series).
 *
 * Anime skip types:  "op" | "ed" | "mixed-op" | "mixed-ed" | "recap"
 * TV series types:   "intro" | "recap" | "outro"
 */
export interface SkipSegment {
  /** Segment category identifier */
  type: string;
  /** Segment start in seconds */
  start_time: number;
  /** Segment end in seconds */
  end_time: number;
}
