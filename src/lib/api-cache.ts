const API_CACHE_MAX_ENTRIES = 200;
const SEARCH_QUERY_MAX_CHARS = 120;

export const BEST_STREAM_CACHE_TTL_MS = 1000 * 60 * 8;
export const STREAMS_CACHE_TTL_MS = 1000 * 60 * 3;
export const MEDIA_DETAILS_CACHE_TTL_MS = 1000 * 60 * 30;
export const SEARCH_CACHE_TTL_MS = 1000 * 60 * 2;
export const RESOLVE_STREAM_CACHE_TTL_MS = 1000 * 60 * 5;

type TimedCacheEntry<T> = { value: T; expiresAt: number };

export interface RequestCache<T> {
  ttlMs: number;
  values: Map<string, TimedCacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  clear: () => void;
}

export interface ApiCacheGroups {
  bestStream: { clear: () => void };
  resolveStream: { clear: () => void };
  streams: { clear: () => void };
  streamSelector: { clear: () => void };
  mediaDetails: { clear: () => void };
  searchCatalog: { clear: () => void };
  searchResults: { clear: () => void };
}

export function createRequestCache<T>(ttlMs: number): RequestCache<T> {
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

export function setTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  pruneTimedCache(cache);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  pruneTimedCache(cache);
}

export function getTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | null {
  const now = Date.now();
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

export function runCachedRequest<T>(
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

function clearCacheGroups(...caches: Array<{ clear: () => void }>) {
  for (const cache of caches) {
    cache.clear();
  }
}

export function clearStreamingCaches(caches: ApiCacheGroups) {
  clearCacheGroups(caches.streams, caches.streamSelector, caches.bestStream, caches.resolveStream);
}

export function clearSearchCaches(caches: ApiCacheGroups) {
  clearCacheGroups(caches.searchCatalog, caches.searchResults);
}

export function clearMediaDetailsCaches(caches: ApiCacheGroups) {
  clearCacheGroups(caches.mediaDetails);
}

export function clearProviderDataCaches(caches: ApiCacheGroups) {
  clearStreamingCaches(caches);
  clearMediaDetailsCaches(caches);
  clearSearchCaches(caches);
}

export function buildResolveStreamKey(
  magnet: string,
  infoHash?: string,
  fileIdx?: number,
  season?: number,
  episode?: number,
  url?: string,
): string {
  return [
    magnet.trim(),
    infoHash?.trim().toLowerCase() ?? 'na',
    fileIdx ?? 'na',
    season ?? 'na',
    episode ?? 'na',
    url?.trim() ?? 'na',
  ].join('|');
}

export function buildStreamCacheKey(
  type: string,
  id: string,
  season?: number,
  episode?: number,
  absoluteEpisode?: number,
): string {
  return `${type.trim().toLowerCase()}|${id.trim()}|${season ?? 'na'}|${episode ?? 'na'}|${absoluteEpisode ?? 'na'}`;
}

export function buildMediaDetailsCacheKey(type: string, id: string): string {
  return `${type.trim().toLowerCase()}|${id.trim()}`;
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').slice(0, SEARCH_QUERY_MAX_CHARS);
}

export function normalizeGenreFilters(genres: string[]): string[] {
  return Array.from(
    new Set(
      genres
        .map((genre) => genre.trim())
        .filter((genre) => genre.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}