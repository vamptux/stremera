import {
  buildMediaDetailsCacheKey,
  getTimedCache,
  normalizeGenreFilters,
  normalizeSearchQuery,
  runCachedRequest,
  setTimedCache,
  type RequestCache,
} from '@/lib/api-cache';
import type {
  AnimeSupplementalMetadata,
  MediaDetails,
  MediaEpisodesPage,
  MediaItem,
  NextPlaybackPlan,
  SearchCatalogPage,
  SearchCatalogQuery,
} from '@/lib/api';
import type { SearchHistoryEntry, SearchHistoryEntryInput } from '@/lib/search-history';

type InvokeApi = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface DiscoveryApiContext {
  safeInvoke: InvokeApi;
  mediaDetailsCache: RequestCache<MediaDetails>;
  searchCatalogCache: RequestCache<SearchCatalogPage>;
  searchResultsCache: RequestCache<MediaItem[]>;
}

export function createDiscoveryApi({
  safeInvoke,
  mediaDetailsCache,
  searchCatalogCache,
  searchResultsCache,
}: DiscoveryApiContext) {
  const querySearchCatalogPage = ({
    query,
    mediaType,
    provider,
    feed,
    sort,
    genres,
    yearFrom,
    yearTo,
    skip,
    limit,
  }: SearchCatalogQuery) => {
    const normalizedQuery = typeof query === 'string' ? normalizeSearchQuery(query) : undefined;
    const normalizedGenres = genres ? normalizeGenreFilters(genres) : undefined;
    const normalizedMediaType = mediaType?.trim().toLowerCase() as SearchCatalogQuery['mediaType'];
    const normalizedProvider = provider?.trim().toLowerCase() as SearchCatalogQuery['provider'];
    const normalizedFeed = feed?.trim().toLowerCase() as SearchCatalogQuery['feed'];
    const normalizedSort = sort?.trim().toLowerCase() as SearchCatalogQuery['sort'];
    const normalizedSkip =
      typeof skip === 'number' && Number.isFinite(skip) && skip > 0 ? skip : undefined;
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : undefined;
    const normalizedYearFrom =
      typeof yearFrom === 'number' && Number.isInteger(yearFrom) ? yearFrom : undefined;
    const normalizedYearTo =
      typeof yearTo === 'number' && Number.isInteger(yearTo) ? yearTo : undefined;

    const cacheKey = [
      normalizedQuery ?? '',
      normalizedMediaType ?? '',
      normalizedProvider ?? '',
      normalizedFeed ?? '',
      normalizedSort ?? '',
      normalizedGenres?.join('|') ?? '',
      normalizedYearFrom ?? '',
      normalizedYearTo ?? '',
      normalizedSkip ?? 0,
      normalizedLimit ?? 0,
    ].join('|');

    return runCachedRequest(searchCatalogCache, cacheKey, () =>
      safeInvoke<SearchCatalogPage>('query_search_catalog', {
        request: {
          query: normalizedQuery,
          mediaType: normalizedMediaType,
          provider: normalizedProvider,
          feed: normalizedFeed,
          sort: normalizedSort,
          genres: normalizedGenres,
          yearFrom: normalizedYearFrom,
          yearTo: normalizedYearTo,
          skip: normalizedSkip,
          limit: normalizedLimit,
        },
      }),
    );
  };

  const searchMedia = (query: string, mediaType?: 'movie' | 'series') => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return Promise.resolve([]);

    const normalizedMediaType = mediaType?.trim().toLowerCase() as 'movie' | 'series' | undefined;
    const cacheKey = `${normalizedMediaType ?? 'all'}|${normalizedQuery.toLowerCase()}`;
    return runCachedRequest(searchResultsCache, cacheKey, () =>
      querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: normalizedMediaType,
        provider: 'cinemeta',
      }).then((page) => page.items),
    );
  };

  const getMediaDetails = (type: string, id: string, options?: { includeEpisodes?: boolean }) => {
    const normalizedType = type.trim();
    const normalizedId = id.trim();
    const includeEpisodes = options?.includeEpisodes ?? true;
    const cacheKey = `${buildMediaDetailsCacheKey(normalizedType, normalizedId)}|${includeEpisodes ? 'full' : 'lite'}`;

    if (!includeEpisodes) {
      const fullCacheKey = `${buildMediaDetailsCacheKey(normalizedType, normalizedId)}|full`;
      const cachedFullDetails = getTimedCache(mediaDetailsCache.values, fullCacheKey);
      if (cachedFullDetails) {
        setTimedCache(
          mediaDetailsCache.values,
          cacheKey,
          cachedFullDetails,
          mediaDetailsCache.ttlMs,
        );
        return Promise.resolve(cachedFullDetails);
      }

      const inFlightFullDetails = mediaDetailsCache.inFlight.get(fullCacheKey);
      if (inFlightFullDetails) {
        return inFlightFullDetails;
      }
    }

    return runCachedRequest(mediaDetailsCache, cacheKey, () =>
      safeInvoke<MediaDetails>('get_media_details', {
        mediaType: normalizedType,
        id: normalizedId,
        include_episodes: includeEpisodes,
      }),
    );
  };

  const searchKitsu = (query: string) => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return Promise.resolve([]);

    const cacheKey = `kitsu|${normalizedQuery.toLowerCase()}`;
    return runCachedRequest(searchResultsCache, cacheKey, () =>
      querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: 'anime',
        provider: 'kitsu',
      }).then((page) => page.items),
    );
  };

  return {
    getTrendingMovies: (genre?: string) =>
      safeInvoke<MediaItem[]>('get_trending_movies', { genre }),
    getTrendingSeries: (genre?: string) =>
      safeInvoke<MediaItem[]>('get_trending_series', { genre }),
    getTrendingAnime: (genre?: string) =>
      safeInvoke<MediaItem[]>('get_trending_anime', { genre }),
    getSearchHistory: () => safeInvoke<SearchHistoryEntry[]>('get_search_history'),
    importSearchHistoryEntries: (entries: SearchHistoryEntry[]) =>
      safeInvoke<SearchHistoryEntry[]>('import_search_history_entries', { entries }),
    pushSearchHistoryEntry: (entry: SearchHistoryEntryInput) =>
      safeInvoke<SearchHistoryEntry[]>('push_search_history_entry', { entry }),
    removeSearchHistoryEntry: (entry: SearchHistoryEntry) =>
      safeInvoke<SearchHistoryEntry[]>('remove_search_history_entry', { entry }),
    clearSearchHistory: () => safeInvoke<void>('clear_search_history'),
    querySearchCatalogPage,
    searchMedia,
    getMediaDetails,
    getMediaEpisodes: (
      type: string,
      id: string,
      season?: number,
      page?: number,
      pageSize?: number,
    ) =>
      safeInvoke<MediaEpisodesPage>('get_media_episodes', {
        mediaType: type,
        id,
        season,
        page,
        page_size: pageSize,
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
    searchKitsu,
  };
}