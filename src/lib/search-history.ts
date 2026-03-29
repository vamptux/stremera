import {
  normalizeSearchYearRange,
  normalizeSearchYearValue,
} from '@/lib/search-page-state';

export interface SearchHistoryEntry {
  query: string;
  mediaType?: string;
  provider?: string;
  feed?: string;
  sort?: string;
  genres?: string[];
  yearFrom?: number | null;
  yearTo?: number | null;
  savedAt: number;
}

const SEARCH_HISTORY_STORAGE_KEY = 'search-history-v2';
const LEGACY_SEARCH_HISTORY_STORAGE_KEY = 'recent_searches';
const MAX_SEARCH_HISTORY_ENTRIES = 10;

function normalizeQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : null;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGenres(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const genres = Array.from(
    new Set(
      value
        .map((entry) => normalizeToken(entry))
        .filter((entry): entry is string => !!entry),
    ),
  );

  return genres.length > 0 ? genres : undefined;
}

function normalizeYear(value: unknown): number | null | undefined {
  return normalizeSearchYearValue(value);
}

function normalizeSavedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  return Date.now();
}

function normalizeEntry(value: unknown): SearchHistoryEntry | null {
  if (typeof value === 'string') {
    const query = normalizeQuery(value);
    return query ? { query, savedAt: 0 } : null;
  }

  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<SearchHistoryEntry>;
  const query = normalizeQuery(candidate.query);
  if (!query) return null;

  return {
    ...normalizeSearchYearRange(
      normalizeYear(candidate.yearFrom) ?? null,
      normalizeYear(candidate.yearTo) ?? null,
    ),
    query,
    mediaType: normalizeToken(candidate.mediaType),
    provider: normalizeToken(candidate.provider),
    feed: normalizeToken(candidate.feed),
    sort: normalizeToken(candidate.sort),
    genres: normalizeGenres(candidate.genres),
    savedAt: normalizeSavedAt(candidate.savedAt),
  };
}

export function buildSearchHistoryKey(entry: Pick<SearchHistoryEntry, 'query' | 'mediaType' | 'provider' | 'feed' | 'sort' | 'genres' | 'yearFrom' | 'yearTo'>): string {
  const normalizedYears = normalizeSearchYearRange(entry.yearFrom ?? null, entry.yearTo ?? null);

  return [
    entry.query.trim().toLocaleLowerCase(),
    entry.mediaType?.trim().toLocaleLowerCase() ?? 'na',
    entry.provider?.trim().toLocaleLowerCase() ?? 'na',
    entry.feed?.trim().toLocaleLowerCase() ?? 'na',
    entry.sort?.trim().toLocaleLowerCase() ?? 'na',
    entry.genres?.map((genre) => genre.toLocaleLowerCase()).sort().join(',') ?? 'na',
    normalizedYears.yearFrom ?? 'na',
    normalizedYears.yearTo ?? 'na',
  ].join('|');
}

function writeSearchHistory(entries: SearchHistoryEntry[], storage: Storage) {
  storage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  storage.removeItem(LEGACY_SEARCH_HISTORY_STORAGE_KEY);
}

export function loadSearchHistory(storage: Storage = window.localStorage): SearchHistoryEntry[] {
  const raw = storage.getItem(SEARCH_HISTORY_STORAGE_KEY) ?? storage.getItem(LEGACY_SEARCH_HISTORY_STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const normalized = parsed
      .map(normalizeEntry)
      .filter((entry): entry is SearchHistoryEntry => entry !== null)
      .slice(0, MAX_SEARCH_HISTORY_ENTRIES);

    if (normalized.length > 0) {
      writeSearchHistory(normalized, storage);
    }

    return normalized;
  } catch {
    return [];
  }
}

export function pushSearchHistoryEntry(
  entries: SearchHistoryEntry[],
  entry: Omit<SearchHistoryEntry, 'savedAt'>,
  storage: Storage = window.localStorage,
): SearchHistoryEntry[] {
  const normalizedQuery = normalizeQuery(entry.query);
  if (!normalizedQuery) return entries;

  const normalizedYears = normalizeSearchYearRange(
    normalizeYear(entry.yearFrom) ?? null,
    normalizeYear(entry.yearTo) ?? null,
  );
  const nextEntry: SearchHistoryEntry = {
    query: normalizedQuery,
    mediaType: normalizeToken(entry.mediaType),
    provider: normalizeToken(entry.provider),
    feed: normalizeToken(entry.feed),
    sort: normalizeToken(entry.sort),
    genres: normalizeGenres(entry.genres),
    yearFrom: normalizedYears.yearFrom,
    yearTo: normalizedYears.yearTo,
    savedAt: Date.now(),
  };
  const nextKey = buildSearchHistoryKey(nextEntry);
  const deduped = entries.filter((existing) => buildSearchHistoryKey(existing) !== nextKey);
  const next = [nextEntry, ...deduped].slice(0, MAX_SEARCH_HISTORY_ENTRIES);

  writeSearchHistory(next, storage);
  return next;
}

export function removeSearchHistoryEntry(
  entries: SearchHistoryEntry[],
  entry: SearchHistoryEntry,
  storage: Storage = window.localStorage,
): SearchHistoryEntry[] {
  const entryKey = buildSearchHistoryKey(entry);
  const next = entries.filter((existing) => buildSearchHistoryKey(existing) !== entryKey);
  writeSearchHistory(next, storage);
  return next;
}

export function clearSearchHistory(storage: Storage = window.localStorage) {
  storage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
  storage.removeItem(LEGACY_SEARCH_HISTORY_STORAGE_KEY);
}
