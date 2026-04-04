import type { SearchHistoryEntry } from '@/lib/search-history';

export type SearchMediaType = 'movie' | 'series' | 'anime';
export type SearchProviderId =
  | 'cinemeta'
  | 'netflix'
  | 'hbo'
  | 'disney'
  | 'prime'
  | 'apple'
  | 'kitsu';
export type SearchDiscoverFeed = 'popular' | 'featured' | 'trending' | 'airing' | 'rating';
export type SearchSortOption =
  | 'default'
  | 'title-asc'
  | 'title-desc'
  | 'year-desc'
  | 'year-asc';

export interface SearchProviderOption {
  color: string;
  id: SearchProviderId;
  name: string;
  short: string;
  types: SearchMediaType[];
}

export interface SearchFeedOption<TFeed extends SearchDiscoverFeed = SearchDiscoverFeed> {
  catalogId: string;
  id: TFeed;
  label: string;
}

export interface SearchSortOptionConfig {
  id: SearchSortOption;
  label: string;
}

export const SEARCH_PROVIDERS: SearchProviderOption[] = [
  {
    id: 'cinemeta',
    name: 'All Sources',
    short: 'All',
    color: 'bg-zinc-700',
    types: ['movie', 'series', 'anime'],
  },
  {
    id: 'netflix',
    name: 'Netflix',
    short: 'Netflix',
    color: 'bg-[#E50914]',
    types: ['movie', 'series'],
  },
  {
    id: 'hbo',
    name: 'HBO Max',
    short: 'HBO',
    color: 'bg-[#5B2E91]',
    types: ['movie', 'series'],
  },
  {
    id: 'disney',
    name: 'Disney+',
    short: 'Disney+',
    color: 'bg-[#0063e5]',
    types: ['movie', 'series'],
  },
  {
    id: 'prime',
    name: 'Prime Video',
    short: 'Prime',
    color: 'bg-[#00A8E1]',
    types: ['movie', 'series'],
  },
  {
    id: 'apple',
    name: 'Apple TV+',
    short: 'Apple TV',
    color: 'bg-zinc-600',
    types: ['movie', 'series'],
  },
  {
    id: 'kitsu',
    name: 'Anime Kitsu',
    short: 'Kitsu',
    color: 'bg-[#FD755C]',
    types: ['anime'],
  },
];

export const SEARCH_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Sport',
  'Thriller',
  'War',
  'Western',
  'Reality-TV',
  'Talk-Show',
  'Game-Show',
];

export const SEARCH_ANIME_GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Sci-Fi',
  'Space',
  'Mystery',
  'Magic',
  'Supernatural',
  'Police',
  'Fantasy',
  'Sports',
  'Romance',
  'Slice of Life',
  'Racing',
  'Horror',
  'Psychological',
  'Thriller',
  'Martial Arts',
  'Super Power',
  'School',
  'Ecchi',
  'Vampire',
  'Historical',
  'Military',
  'Mecha',
  'Demons',
  'Samurai',
  'Harem',
  'Music',
  'Parody',
  'Shoujo Ai',
  'Game',
  'Shounen Ai',
  'Kids',
  'Yuri',
  'Yaoi',
  'Gender Bender',
  'Mahou Shoujo',
  'Gore',
  'Law',
  'Cooking',
  'Mature',
  'Medical',
  'Political',
  'Youth',
  'Workplace',
  'Crime',
  'Zombies',
  'Documentary',
  'Family',
  'Food',
  'Friendship',
  'Tragedy',
];

export const SEARCH_CINEMETA_FEEDS: SearchFeedOption<'popular' | 'featured'>[] = [
  { id: 'popular', label: 'Popular', catalogId: 'top' },
  { id: 'featured', label: 'Featured', catalogId: 'imdbRating' },
];

export const SEARCH_KITSU_FEEDS: SearchFeedOption<'trending' | 'popular' | 'airing' | 'rating'>[] =
  [
    { id: 'trending', label: 'Trending', catalogId: 'kitsu-anime-trending' },
    { id: 'popular', label: 'Popular', catalogId: 'kitsu-anime-popular' },
    { id: 'rating', label: 'Top Rated', catalogId: 'kitsu-anime-rating' },
    { id: 'airing', label: 'Top Airing', catalogId: 'kitsu-anime-airing' },
  ];

export const SEARCH_SORT_OPTIONS: SearchSortOptionConfig[] = [
  { id: 'default', label: 'Default' },
  { id: 'year-desc', label: 'Newest First' },
  { id: 'year-asc', label: 'Oldest First' },
  { id: 'title-asc', label: 'Title A-Z' },
  { id: 'title-desc', label: 'Title Z-A' },
];

export const SEARCH_YEAR_MIN = 1889;
export const SEARCH_CURRENT_YEAR = new Date().getFullYear();
export const SEARCH_YEAR_OPTIONS: number[] = Array.from(
  { length: SEARCH_CURRENT_YEAR - SEARCH_YEAR_MIN + 1 },
  (_, index) => SEARCH_CURRENT_YEAR - index,
);

export interface SearchYearRange {
  yearFrom: number | null;
  yearTo: number | null;
}

export function normalizeSearchYearValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < SEARCH_YEAR_MIN || value > SEARCH_CURRENT_YEAR) return undefined;
  return value;
}

export function parseSearchYearParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return normalizeSearchYearValue(parsed) ?? null;
}

export function normalizeSearchYearRange(
  yearFrom: number | null,
  yearTo: number | null,
): SearchYearRange {
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    return {
      yearFrom: yearTo,
      yearTo: yearFrom,
    };
  }

  return { yearFrom, yearTo };
}

export function parseGenresParam(value: string | null): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(',')
        .map((genre) => genre.trim())
        .filter(Boolean),
    ),
  );
}

export function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function parseSearchSortParam(value: string | null): SearchSortOption {
  return SEARCH_SORT_OPTIONS.some((option) => option.id === value)
    ? (value as SearchSortOption)
    : 'default';
}

export function resolveSearchUrlType(value: string | null): SearchMediaType {
  return value === 'series' || value === 'anime' ? value : 'movie';
}

export function resolveSearchUrlProvider(
  type: SearchMediaType,
  value: string | null,
): SearchProviderId {
  if (type === 'anime') {
    return 'kitsu';
  }

  const provider = SEARCH_PROVIDERS.find(
    (entry) => entry.id === value && entry.types.includes(type),
  );
  return provider?.id ?? 'cinemeta';
}

export function resolveSearchUrlFeed(
  type: SearchMediaType,
  value: string | null,
): SearchDiscoverFeed {
  const feedOptions = type === 'anime' ? SEARCH_KITSU_FEEDS : SEARCH_CINEMETA_FEEDS;
  const defaultFeed: SearchDiscoverFeed = type === 'anime' ? 'trending' : 'popular';

  return feedOptions.some((feed) => feed.id === value)
    ? (value as SearchDiscoverFeed)
    : defaultFeed;
}

export function getSearchFeedLabel(
  type: SearchMediaType,
  feed: SearchDiscoverFeed,
): string {
  const feedOptions = type === 'anime' ? SEARCH_KITSU_FEEDS : SEARCH_CINEMETA_FEEDS;
  return feedOptions.find((option) => option.id === feed)?.label ?? 'Popular';
}

export function getSearchSortLabel(sort: SearchSortOption): string {
  return SEARCH_SORT_OPTIONS.find((option) => option.id === sort)?.label ?? 'Default';
}

export function getSearchGenresForType(type: SearchMediaType): string[] {
  return type === 'anime' ? SEARCH_ANIME_GENRES : SEARCH_GENRES;
}

export function formatRecentSearchContext(entry: SearchHistoryEntry): string {
  const parts: string[] = [];
  const normalizedYears = normalizeSearchYearRange(entry.yearFrom ?? null, entry.yearTo ?? null);

  if (entry.mediaType === 'anime') {
    parts.push('Anime');
  } else if (entry.mediaType === 'series') {
    parts.push('Series');
  } else if (entry.mediaType === 'movie') {
    parts.push('Movies');
  }

  const provider = SEARCH_PROVIDERS.find((item) => item.id === entry.provider);
  if (provider) {
    parts.push(provider.short);
  }

  if (entry.genres?.length) {
    parts.push(entry.genres.length === 1 ? entry.genres[0] : `${entry.genres.length} genres`);
  }

  if (normalizedYears.yearFrom && normalizedYears.yearTo) {
    parts.push(
      normalizedYears.yearFrom === normalizedYears.yearTo
        ? `${normalizedYears.yearFrom}`
        : `${normalizedYears.yearFrom}-${normalizedYears.yearTo}`,
    );
  } else if (normalizedYears.yearFrom) {
    parts.push(`${normalizedYears.yearFrom}+`);
  } else if (normalizedYears.yearTo) {
    parts.push(`Up to ${normalizedYears.yearTo}`);
  }

  return parts.join(' · ');
}
