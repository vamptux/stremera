import {
  clearLegacyStorageFeatureKeys,
  type LegacyStorageReadResult,
  markLegacyStorageFeatureComplete,
  readLegacyStorageFeature,
} from '@/lib/legacy-storage';
import { normalizeSearchYearRange, normalizeSearchYearValue } from '@/lib/search-page-state';

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

export interface SearchHistoryEntryInput extends Omit<SearchHistoryEntry, 'savedAt'> {
  savedAt?: number;
}

const SEARCH_HISTORY_STORAGE_KEY = 'search-history-v2';
const LEGACY_SEARCH_HISTORY_STORAGE_KEY = 'recent_searches';
const SEARCH_HISTORY_LEGACY_STORAGE_FEATURE = 'search-history';
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
      value.map((entry) => normalizeToken(entry)).filter((entry): entry is string => !!entry),
    ),
  );

  return genres.length > 0 ? genres : undefined;
}

function normalizeYear(value: unknown): number | null | undefined {
  return normalizeSearchYearValue(value);
}

function normalizeSavedAt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  return fallback;
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

export function buildSearchHistoryKey(
  entry: Pick<
    SearchHistoryEntry,
    'query' | 'mediaType' | 'provider' | 'feed' | 'sort' | 'genres' | 'yearFrom' | 'yearTo'
  >,
): string {
  const normalizedYears = normalizeSearchYearRange(entry.yearFrom ?? null, entry.yearTo ?? null);

  return [
    entry.query.trim().toLocaleLowerCase(),
    entry.mediaType?.trim().toLocaleLowerCase() ?? 'na',
    entry.provider?.trim().toLocaleLowerCase() ?? 'na',
    entry.feed?.trim().toLocaleLowerCase() ?? 'na',
    entry.sort?.trim().toLocaleLowerCase() ?? 'na',
    entry.genres
      ?.map((genre) => genre.toLocaleLowerCase())
      .sort()
      .join(',') ?? 'na',
    normalizedYears.yearFrom ?? 'na',
    normalizedYears.yearTo ?? 'na',
  ].join('|');
}

export function canonicalizeSearchHistoryEntries(values: readonly unknown[]): SearchHistoryEntry[] {
  const normalized = values
    .map(normalizeEntry)
    .filter((entry): entry is SearchHistoryEntry => entry !== null)
    .sort((left, right) => right.savedAt - left.savedAt);

  const seen = new Set<string>();
  return normalized
    .filter((entry) => {
      const key = buildSearchHistoryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SEARCH_HISTORY_ENTRIES);
}

export function readLegacySearchHistory(): LegacyStorageReadResult<SearchHistoryEntry[]> {
  return readLegacyStorageFeature(SEARCH_HISTORY_LEGACY_STORAGE_FEATURE, (storage) => {
    const raw =
      storage.getItem(SEARCH_HISTORY_STORAGE_KEY) ??
      storage.getItem(LEGACY_SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) {
      return { hasLegacyData: false, value: null };
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { hasLegacyData: true, value: [] };
      }

      return {
        hasLegacyData: true,
        value: canonicalizeSearchHistoryEntries(parsed),
      };
    } catch {
      return { hasLegacyData: true, value: [] };
    }
  });
}

export function clearLegacySearchHistory() {
  clearLegacyStorageFeatureKeys(SEARCH_HISTORY_LEGACY_STORAGE_FEATURE, [
    SEARCH_HISTORY_STORAGE_KEY,
    LEGACY_SEARCH_HISTORY_STORAGE_KEY,
  ]);
}

export function markLegacySearchHistoryMigrationComplete() {
  markLegacyStorageFeatureComplete(SEARCH_HISTORY_LEGACY_STORAGE_FEATURE);
}
