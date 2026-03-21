import { useSearchParams, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { api, type MediaItem, getErrorMessage } from '@/lib/api';
import { MediaCard, MediaCardSkeleton } from '@/components/media-card';
import {
  Search as SearchIcon, X, Filter, History, ChevronDown, TrendingUp, Sparkles,
  VenetianMask, Loader2, WifiOff, AlertCircle, Check,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePrivacy } from '@/contexts/privacy-context';

type MediaType = 'movie' | 'series' | 'anime';
type ProviderId = 'cinemeta' | 'netflix' | 'hbo' | 'disney' | 'prime' | 'apple' | 'kitsu';
type DiscoverFeed = 'popular' | 'featured' | 'trending' | 'airing' | 'rating';
type SortOption = 'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';

const PROVIDERS: { id: ProviderId; name: string; short: string; color: string; types: MediaType[] }[] = [
  { id: 'cinemeta', name: 'All Sources',  short: 'All',      color: 'bg-zinc-700',    types: ['movie', 'series', 'anime'] },
  { id: 'netflix',  name: 'Netflix',      short: 'Netflix',  color: 'bg-[#E50914]',   types: ['movie', 'series'] },
  { id: 'hbo',      name: 'HBO Max',      short: 'HBO',      color: 'bg-[#5B2E91]',   types: ['movie', 'series'] },
  { id: 'disney',   name: 'Disney+',      short: 'Disney+',  color: 'bg-[#0063e5]',   types: ['movie', 'series'] },
  { id: 'prime',    name: 'Prime Video',  short: 'Prime',    color: 'bg-[#00A8E1]',   types: ['movie', 'series'] },
  { id: 'apple',    name: 'Apple TV+',    short: 'Apple TV', color: 'bg-zinc-600',     types: ['movie', 'series'] },
  { id: 'kitsu',    name: 'Anime Kitsu',  short: 'Kitsu',    color: 'bg-[#FD755C]',   types: ['anime'] },
];

// Aligned with Cinemeta v3 manifest — exact strings matter for the API URL.
const GENRES = [
  "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime",
  "Documentary", "Drama", "Family", "Fantasy", "History", "Horror",
  "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western",
  "Reality-TV", "Talk-Show", "Game-Show",
];

// Aligned with the Kitsu addon manifest.
const ANIME_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Sci-Fi", "Space", "Mystery",
  "Magic", "Supernatural", "Police", "Fantasy", "Sports", "Romance",
  "Slice of Life", "Racing", "Horror", "Psychological", "Thriller",
  "Martial Arts", "Super Power", "School", "Ecchi", "Vampire", "Historical",
  "Military", "Mecha", "Demons", "Samurai", "Harem", "Music", "Parody",
  "Shoujo Ai", "Game", "Shounen Ai", "Kids", "Yuri", "Yaoi", "Gender Bender",
  "Mahou Shoujo", "Gore", "Law", "Cooking", "Mature", "Medical", "Political",
  "Youth", "Workplace", "Crime", "Zombies", "Documentary", "Family", "Food",
  "Friendship", "Tragedy",
];

const CINEMETA_FEEDS: { id: Extract<DiscoverFeed, 'popular' | 'featured'>; label: string; catalogId: string }[] = [
  { id: 'popular',  label: 'Popular',  catalogId: 'top' },
  { id: 'featured', label: 'Featured', catalogId: 'imdbRating' },
];

const KITSU_FEEDS: { id: Extract<DiscoverFeed, 'trending' | 'popular' | 'airing' | 'rating'>; label: string; catalogId: string }[] = [
  { id: 'trending', label: 'Trending',   catalogId: 'kitsu-anime-trending' },
  { id: 'popular',  label: 'Popular',    catalogId: 'kitsu-anime-popular' },
  { id: 'rating',   label: 'Top Rated',  catalogId: 'kitsu-anime-rating' },
  { id: 'airing',   label: 'Top Airing', catalogId: 'kitsu-anime-airing' },
];

const SORT_OPTIONS: { id: SortOption; label: string }[] = [
  { id: 'default',    label: 'Default' },
  { id: 'year-desc',  label: 'Newest First' },
  { id: 'year-asc',   label: 'Oldest First' },
  { id: 'title-asc',  label: 'Title A-Z' },
  { id: 'title-desc', label: 'Title Z-A' },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS: number[] = Array.from({ length: CURRENT_YEAR - 1889 }, (_, i) => CURRENT_YEAR - i);

const CINEMETA_PAGE_SIZE = 50;
const KITSU_PAGE_SIZE   = 20;
const NETFLIX_PAGE_SIZE = 100;
const SEARCH_RESULT_CAP = 2000;

function getMinimumUsefulPageSize(pageSize: number): number {
  return Math.max(3, Math.floor(pageSize / 4));
}

function getPrimaryYear(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.split('-')[0] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Verified skip-pagination support per provider (live-tested 2026-03).
//
// • cinemeta  — skip param is non-functional; the same first page is always
//               returned regardless of offset. Confirmed by live testing.
//               Must NOT be in this set.
//
// • netflix / hbo / disney / prime / apple
//             — Stremio catalog addon honours skip= path segments.
//               A 404 response signals end-of-catalog; dedup in the Rust
//               Netflix provider + frontend id-dedup makes this safe even for
//               mirrors that ignore skip.
//
// • kitsu     — Natively supports skip in all browse catalog endpoints.
//
// Update this set whenever a provider's skip behaviour changes.
const PROVIDERS_WITH_SKIP_PAGINATION = new Set<ProviderId>([
  'netflix', 'hbo', 'disney', 'prime', 'apple', 'kitsu',
]);

function parseYearParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1889 || parsed > CURRENT_YEAR) return null;
  return parsed;
}

function parseGenresParam(value: string | null): string[] {
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

function parseSortParam(value: string | null): SortOption {
  return SORT_OPTIONS.some((option) => option.id === value)
    ? (value as SortOption)
    : 'default';
}

function resolveUrlType(value: string | null): MediaType {
  return value === 'series' || value === 'anime' ? value : 'movie';
}

function resolveUrlProvider(type: MediaType, value: string | null): ProviderId {
  if (type === 'anime') return 'kitsu';
  const provider = PROVIDERS.find((entry) => entry.id === value && entry.types.includes(type));
  return provider?.id ?? 'cinemeta';
}

function resolveUrlFeed(type: MediaType, value: string | null): DiscoverFeed {
  const allowedFeeds: DiscoverFeed[] =
    type === 'anime'
      ? ['trending', 'popular', 'airing', 'rating']
      : ['popular', 'featured'];
  const defaultFeed: DiscoverFeed = type === 'anime' ? 'trending' : 'popular';
  return allowedFeeds.includes(value as DiscoverFeed) ? (value as DiscoverFeed) : defaultFeed;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery    = searchParams.get('q') || '';
  const urlType     = searchParams.get('type');
  const urlProvider = searchParams.get('provider');
  const urlGenre    = searchParams.get('genre');
  const urlFeed     = searchParams.get('feed');
  const urlSort     = searchParams.get('sort');
  const urlYearFrom = parseYearParam(searchParams.get('yearFrom'));
  const urlYearTo   = parseYearParam(searchParams.get('yearTo'));
  const parsedUrlType = resolveUrlType(urlType);
  const parsedUrlProvider = resolveUrlProvider(parsedUrlType, urlProvider);
  const parsedUrlGenres = useMemo(() => parseGenresParam(urlGenre), [urlGenre]);
  const parsedUrlFeed = resolveUrlFeed(parsedUrlType, urlFeed);
  const parsedUrlSort = parseSortParam(urlSort);

  const [query,          setQuery]          = useState(urlQuery);
  const debouncedQuery = useDebounce(query, 500);
  // Faster debounce for autocomplete suggestions — fires before the main search
  const suggestionDebounce = useDebounce(query, 250);
  const [activeType,     setActiveType]     = useState<MediaType>(parsedUrlType);
  const [activeProvider, setActiveProvider] = useState<ProviderId>(parsedUrlProvider);
  // activeGenres — full array; OR semantics: union one API-call-per-genre
  const [activeGenres,   setActiveGenres]   = useState<string[]>(parsedUrlGenres);
  const [activeFeed,     setActiveFeed]     = useState<DiscoverFeed>(parsedUrlFeed);
  const [activeSort,     setActiveSort]     = useState<SortOption>(parsedUrlSort);
  const [yearFrom,       setYearFrom]       = useState<number | null>(urlYearFrom);
  const [yearTo,         setYearTo]         = useState<number | null>(urlYearTo);
  const [genreSearch, setGenreSearch] = useState('');
  const [genrePopoverOpen, setGenrePopoverOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  // Suggestion state — shows a live dropdown while the user is typing
  const [suggestFocused, setSuggestFocused] = useState(false);
  const suggestContainerRef = useRef<HTMLDivElement>(null);
  const suggestionInputRef = useRef<HTMLInputElement>(null);

  const { isIncognito } = usePrivacy();
  const isOnline        = useOnlineStatus();
  const navigate        = useNavigate();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ── Recent searches ─────────────────────────────────────────────────────
  useEffect(() => {
    if (isIncognito) {
      setRecentSearches([]);
      localStorage.removeItem('recent_searches');
      return;
    }
    const saved = localStorage.getItem('recent_searches');
    if (saved) {
      try { setRecentSearches(JSON.parse(saved)); } catch { /* ignore */ }
    }
  }, [isIncognito]);

  const addToRecent = useCallback((q: string) => {
    if (!q.trim() || isIncognito) return;
    setRecentSearches(prev => {
      const next = [q, ...prev.filter(s => s !== q)].slice(0, 10);
      localStorage.setItem('recent_searches', JSON.stringify(next));
      return next;
    });
  }, [isIncognito]);

  const clearRecent = () => {
    setRecentSearches([]);
    localStorage.removeItem('recent_searches');
  };

  const removeRecent = (q: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = recentSearches.filter(s => s !== q);
    setRecentSearches(next);
    localStorage.setItem('recent_searches', JSON.stringify(next));
  };

  // ── Sync URL -> state ──────────────────────────────────────────────────
  useEffect(() => { setQuery(urlQuery); }, [urlQuery]);

  useEffect(() => {
    setActiveType(parsedUrlType);
    setActiveProvider(parsedUrlProvider);
    setActiveGenres((prev) => (
      areStringArraysEqual(prev, parsedUrlGenres) ? prev : parsedUrlGenres
    ));
    setActiveFeed(parsedUrlFeed);
    setActiveSort(parsedUrlSort);
    setYearFrom(urlYearFrom);
    setYearTo(urlYearTo);
  }, [parsedUrlType, parsedUrlProvider, parsedUrlGenres, parsedUrlFeed, parsedUrlSort, urlYearFrom, urlYearTo]);

  const trimmedDebouncedQuery = debouncedQuery.trim();

  useEffect(() => {
    if (!trimmedDebouncedQuery) return;
    addToRecent(trimmedDebouncedQuery);
  }, [trimmedDebouncedQuery, addToRecent]);

  // ── Sync state -> URL ──────────────────────────────────────────────────
  useEffect(() => {
    const nextParams = new URLSearchParams();
    nextParams.set('type', activeType);
    nextParams.set('provider', activeProvider);
    if (trimmedDebouncedQuery) {
      nextParams.set('q', trimmedDebouncedQuery);
    }
    if (activeGenres.length > 0) nextParams.set('genre', activeGenres.join(','));
    if (!trimmedDebouncedQuery) nextParams.set('feed', activeFeed);
    if (activeSort !== 'default') nextParams.set('sort', activeSort);
    if (yearFrom !== null) nextParams.set('yearFrom', String(yearFrom));
    if (yearTo !== null) nextParams.set('yearTo', String(yearTo));

    if (searchParams.toString() === nextParams.toString()) return;
    setSearchParams(nextParams, { replace: true });
  }, [trimmedDebouncedQuery, activeType, activeProvider, activeGenres, activeFeed, activeSort, yearFrom, yearTo, searchParams, setSearchParams]);

  // ── Type change handler ────────────────────────────────────────────────
  const handleTypeChange = (val: string) => {
    const newType = val as MediaType;
    setActiveType(newType);
    setActiveGenres([]);
    setActiveFeed(newType === 'anime' ? 'trending' : 'popular');
    setActiveSort('default');
    setYearFrom(null);
    setYearTo(null);
    if (newType === 'anime') {
      setActiveProvider('kitsu');
    } else {
      const cur = PROVIDERS.find(p => p.id === activeProvider);
      if (cur && !cur.types.includes(newType)) setActiveProvider('cinemeta');
    }
  };

  const toggleGenre = (genre: string) => {
    setActiveGenres(prev =>
      prev.includes(genre) ? prev.filter(g => g !== genre) : [...prev, genre]
    );
  };

  const clearAllFilters = () => {
    setActiveGenres([]);
    setActiveSort('default');
    setYearFrom(null);
    setYearTo(null);
  };

  const hasActiveFilters = activeGenres.length > 0 || activeSort !== 'default'
    || yearFrom !== null || yearTo !== null;

  // ── Click-outside: close suggestions when user clicks elsewhere ──────
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (suggestContainerRef.current && !suggestContainerRef.current.contains(e.target as Node)) {
        setSuggestFocused(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  // ── Keep navigation feeling consistent: return to top on major scope changes ──
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
  }, [debouncedQuery, activeType, activeProvider, activeFeed, activeGenres, activeSort]);

  // ── Live suggestion query (250 ms debounce \u2014 outruns main 500 ms search) ─
  const { data: rawSuggestions = [] } = useQuery({
    queryKey: ['suggestions', suggestionDebounce.trim(), activeType],
    queryFn: () => {
      const q = suggestionDebounce.trim();
      if (activeType === 'anime') return api.searchKitsu(q);
      return api.searchMedia(q);
    },
    enabled: isOnline && suggestFocused && suggestionDebounce.trim().length >= 2,
    staleTime: 1000 * 60 * 2,
    // Keep previous results to avoid flickering between keystrokes
    placeholderData: (prev) => prev,
  });

  const suggestions = useMemo(() => rawSuggestions.slice(0, 6), [rawSuggestions]);
  const showSuggestions = suggestFocused && query.trim().length >= 2 && suggestions.length > 0;

  const handleSuggestionSelect = useCallback((item: MediaItem) => {
    setSuggestFocused(false);
    // Navigate directly to the details page for the selected item
    navigate(`/details/${item.type}/${item.id}`, { state: { from: '/search' } });
  }, [navigate]);

  // ── Fetch helpers ──────────────────────────────────────────────────────

  // Determines whether the current provider supports real skip-based pagination.
  // See the module-level PROVIDERS_WITH_SKIP_PAGINATION constant for the
  // verified behaviour of each provider.
  const providerSupportsPagination =
    activeType === 'anime' || PROVIDERS_WITH_SKIP_PAGINATION.has(activeProvider);

  // Fetches content for a given genre and optional skip offset.
  // For Cinemeta: uses the discover endpoint (merges top + imdbRating) — no skip.
  // For Kitsu / streaming providers: supports real skip-based pagination.
  const fetchForGenre = useCallback(async (genre: string | null, skip?: number): Promise<MediaItem[]> => {
    const pageSkip = typeof skip === 'number' && skip > 0 ? skip : undefined;

    if (activeType === 'anime') {
      const feed = KITSU_FEEDS.find(f => f.id === activeFeed) ?? KITSU_FEEDS[0];
      return api.getKitsuCatalog(feed.catalogId, genre || undefined, pageSkip);
    }

    const cinemetaFeed = CINEMETA_FEEDS.find(f => f.id === (activeFeed as 'popular' | 'featured')) ?? CINEMETA_FEEDS[0];

    if (activeProvider === 'cinemeta' || genre) {
      // Use the discover endpoint (merges both catalogs) for initial load.
      // For subsequent pages (skip > 0), Cinemeta can't paginate anyway,
      // so return empty to signal "all loaded".
      if (pageSkip) return [];
      return api.getCinemetaDiscover(activeType, cinemetaFeed.catalogId, genre || undefined);
    }

    const catalogMap: Record<string, string> = {
      netflix: 'nfx', hbo: 'hbm', disney: 'dnp', prime: 'amp', apple: 'atp',
    };
    return api.getNetflixCatalog(catalogMap[activeProvider] ?? 'nfx', activeType, pageSkip);
  }, [activeType, activeProvider, activeFeed]);

  // ── Mode: are we in multi-genre OR mode? ──────────────────────────────
  // Multi-genre (2+ genres, discover mode): run a parallel query PER GENRE, then union.
  // Single/no genre or search: use useInfiniteQuery for infinite scroll.
  const isMultiGenreMode = activeGenres.length > 1 && !debouncedQuery;
  const [multiGenrePageCount, setMultiGenrePageCount] = useState(1);

  useEffect(() => {
    setMultiGenrePageCount(1);
  }, [isMultiGenreMode, activeGenres, activeType, activeProvider, activeFeed, debouncedQuery]);

  const multiGenrePageSize = activeType === 'anime' ? KITSU_PAGE_SIZE : NETFLIX_PAGE_SIZE;
  const multiGenreSupportsPagination = isMultiGenreMode && activeType === 'anime';

  // ── Mode A: infinite query (search / 0-1 genres) ──────────────────────
  const singleApiGenre = activeGenres[0] ?? null;

  // Page size thresholds used by getNextPageParam to decide if more data exists.
  // These should match what the backend actually returns per batch.
  const pageSize = activeType === 'anime' ? KITSU_PAGE_SIZE
    : (activeProvider !== 'cinemeta' && !singleApiGenre) ? NETFLIX_PAGE_SIZE
    : CINEMETA_PAGE_SIZE;

  const {
    data: infiniteData,
    isLoading: infiniteLoading,
    isFetching: infiniteFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    isError: infiniteError,
    error: infiniteErrorObj,
  } = useInfiniteQuery({
    queryKey: ['search', debouncedQuery, activeType, activeProvider, singleApiGenre, activeFeed],
    queryFn: ({ pageParam }) => {
      if (debouncedQuery) {
        if (activeProvider === 'kitsu' || activeType === 'anime') return api.searchKitsu(debouncedQuery);
        return api.searchMedia(debouncedQuery);
      }
      return fetchForGenre(singleApiGenre, pageParam as number);
    },
    getNextPageParam: (lastPage, allPages) => {
      // Search results aren't paginated
      if (debouncedQuery) return undefined;
      // Cinemeta / non-paginatable providers: all content comes in the first batch
      if (!providerSupportsPagination) return undefined;
      // Empty or very small page → no more data
      if (lastPage.length === 0 || lastPage.length < getMinimumUsefulPageSize(pageSize)) return undefined;
      // Check for genuine new items (handles the Kitsu skip=20 overlap)
      const previousIds = new Set<string>();
      for (let i = 0; i < allPages.length - 1; i++) {
        for (const item of allPages[i]) previousIds.add(item.id);
      }
      const uniqueNew = lastPage.reduce((c, item) => previousIds.has(item.id) ? c : c + 1, 0);
      if (uniqueNew === 0) return undefined;
      // Safety cap
      const totalFetched = allPages.reduce((s, p) => s + p.length, 0);
      if (totalFetched >= SEARCH_RESULT_CAP) return undefined;
      return totalFetched;
    },
    initialPageParam: 0,
    staleTime: 1000 * 60 * 5,
    enabled: isOnline && !isMultiGenreMode,
  });

  // ── Auto-prefetch: eagerly load more content right after initial data arrives ──
  useEffect(() => {
    if (isMultiGenreMode || !providerSupportsPagination) return;
    if (!infiniteData || infiniteFetching || !hasNextPage) return;
    // Auto-fetch next page if we have fewer than 300 items (keeps the scroll buffer full)
    const totalItems = infiniteData.pages.reduce((s, p) => s + p.length, 0);
    if (totalItems < 300) {
      void fetchNextPage();
    }
  }, [isMultiGenreMode, providerSupportsPagination, infiniteData, infiniteFetching, hasNextPage, fetchNextPage]);

  // ── Mode B: parallel per-genre queries (multi-genre union) ─────────────
  // Each genre gets its own API call. Results are unioned and deduplicated.
  const perGenreQueries = useQueries({
    queries: isMultiGenreMode
      ? activeGenres.flatMap(genre =>
          Array.from({ length: multiGenrePageCount }, (_, pageIndex) => ({
            queryKey: ['genre-catalog', activeType, activeProvider, genre, activeFeed, pageIndex],
            queryFn: () => fetchForGenre(genre, pageIndex * multiGenrePageSize),
            staleTime: 1000 * 60 * 5,
            enabled: isOnline,
          }))
        )
      : [],
  });

  const multiGenreCanLoadMore = useMemo(() => {
    if (!multiGenreSupportsPagination || activeGenres.length === 0) return false;
    const minimumUsefulPageSize = getMinimumUsefulPageSize(multiGenrePageSize);
    return activeGenres.some((_, genreIndex) => {
      const queryIndex = genreIndex * multiGenrePageCount + (multiGenrePageCount - 1);
      const lastQuery = perGenreQueries[queryIndex];
      const pageLength = lastQuery?.data?.length ?? 0;
      return pageLength >= minimumUsefulPageSize;
    });
  }, [
    multiGenreSupportsPagination,
    activeGenres,
    multiGenrePageSize,
    multiGenrePageCount,
    perGenreQueries,
  ]);

  // ── Raw results (deduplicated) ─────────────────────────────────────────
  const rawResults = useMemo<MediaItem[]>(() => {
    const seen = new Set<string>();
    const out: MediaItem[] = [];

    if (isMultiGenreMode) {
      // Union of all per-genre results
      for (const q of perGenreQueries) {
        if (q.data) {
          for (const item of q.data) {
            if (!seen.has(item.id)) { seen.add(item.id); out.push(item); }
          }
        }
      }
    } else {
      // Flatten infinite pages
      for (const page of infiniteData?.pages ?? []) {
        for (const item of page) {
          if (!seen.has(item.id)) { seen.add(item.id); out.push(item); }
        }
      }
    }

    return out;
  }, [isMultiGenreMode, perGenreQueries, infiniteData?.pages]);

  // ── Client-side post-filters: year range + sort ────────────────────────
  // NOTE: Genre is now handled by the API (parallel calls), not client-side text matching.
  const filteredResults = useMemo<MediaItem[]>(() => {
    let items = rawResults;

    if (yearFrom !== null || yearTo !== null) {
      items = items.filter(item => {
        const y = getPrimaryYear(item.year);
        if (y === null) return true; // keep items with no year info rather than hiding them
        if (yearFrom !== null && y < yearFrom) return false;
        if (yearTo   !== null && y > yearTo)   return false;
        return true;
      });
    }

    if (activeSort !== 'default') {
      items = [...items].sort((a, b) => {
        if (activeSort === 'title-asc') return (a.title ?? '').localeCompare(b.title ?? '');
        if (activeSort === 'title-desc') return (b.title ?? '').localeCompare(a.title ?? '');
        const ya = getPrimaryYear(a.year) ?? 0;
        const yb = getPrimaryYear(b.year) ?? 0;
        if (activeSort === 'year-desc') return yb - ya;
        if (activeSort === 'year-asc')  return ya - yb;
        return 0;
      });
    }

    return items;
  }, [rawResults, yearFrom, yearTo, activeSort]);

  // ── Infinite scroll sentinel ───────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isMultiGenreMode || !providerSupportsPagination) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasNextPage && !infiniteFetching) void fetchNextPage(); },
      { rootMargin: '800px', root: scrollContainerRef.current },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [isMultiGenreMode, providerSupportsPagination, hasNextPage, infiniteFetching, fetchNextPage, infiniteData]);

  // ── Derived UI state ───────────────────────────────────────────────────
  const currentGenres  = activeType === 'anime' ? ANIME_GENRES : GENRES;
  const filteredGenreOptions = useMemo(() => {
    const normalizedGenreSearch = genreSearch.trim().toLowerCase();
    if (!normalizedGenreSearch) return currentGenres;
    return currentGenres.filter((genre) => genre.toLowerCase().includes(normalizedGenreSearch));
  }, [currentGenres, genreSearch]);
  const supportsGenre  = !debouncedQuery;
  const supportsFeed   = supportsGenre && (activeType === 'anime' || activeProvider === 'cinemeta');
  const activeFeedLabel = activeType === 'anime'
    ? (KITSU_FEEDS.find(f => f.id === activeFeed)?.label ?? 'Trending')
    : (CINEMETA_FEEDS.find(f => f.id === activeFeed)?.label ?? 'Popular');
  const activeSortLabel = SORT_OPTIONS.find(s => s.id === activeSort)?.label ?? 'Default';

  const isLoading = isMultiGenreMode
    ? perGenreQueries.some(q => q.isLoading)
    : infiniteLoading;
  const isFetching = isMultiGenreMode
    ? perGenreQueries.some(q => q.isFetching)
    : infiniteFetching;
  const isError = isMultiGenreMode
    ? perGenreQueries.some(q => q.isError)
    : infiniteError;
  const errorObj = isMultiGenreMode
    ? (perGenreQueries.find(q => q.error)?.error ?? null)
    : infiniteErrorObj;

  const pagesLoaded  = infiniteData?.pages?.length ?? 0;
  const totalFetched = infiniteData?.pages?.reduce((sum, page) => sum + page.length, 0) ?? 0;
  // Show "All titles loaded" only when there genuinely were multiple pages of content
  // For non-paginatable providers (Cinemeta), never show since there's only one batch
  const showEndMsg = !isMultiGenreMode && providerSupportsPagination && !hasNextPage && pagesLoaded > 1;
  const showSearchCapMsg = showEndMsg && totalFetched >= SEARCH_RESULT_CAP;
  const showSkeleton = !isError && (isLoading || (isFetching && !isFetchingNextPage && rawResults.length === 0));

  return (
    <div className="h-screen flex flex-col pt-10 container max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <div ref={suggestContainerRef} className="max-w-4xl mx-auto w-full relative mb-3 flex-shrink-0 z-20 flex flex-col gap-2">

        <div className="relative group">
          <Input
            ref={suggestionInputRef}
            type="text"
            placeholder="Search movies, shows, anime..."
            className="w-full h-12 pl-11 pr-10 text-[15px] bg-white/[0.04] border-white/[0.06] group-hover:border-white/10 focus:border-white/15 focus:bg-white/[0.06] rounded-xl shadow-sm transition-all duration-200 placeholder:text-zinc-600 text-zinc-100"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSuggestFocused(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSuggestFocused(false);
            }}
          />
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4.5 w-4.5 h-[18px] w-[18px] text-zinc-500 pointer-events-none" />
          {query && (
            <button type="button"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 h-6 w-6 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
              onClick={() => setQuery('')}
            ><X className="h-3.5 w-3.5" /></button>
          )}

          {/* ── Unified focus dropdown: recent searches OR autocomplete ── */}
          {suggestFocused && (
            <>
              {/* Recent searches — shown when input is empty */}
              {!query.trim() && !isIncognito && recentSearches.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-zinc-950/98 backdrop-blur-xl border border-white/[0.07] rounded-xl shadow-2xl z-50 overflow-hidden py-1">
                  <div className="flex items-center justify-between px-3 pt-1.5 pb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 flex items-center gap-1.5">
                      <History className="h-3 w-3" /> Recent
                    </span>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={clearRecent}
                      className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
                    >Clear</button>
                  </div>
                  {recentSearches.map(term => (
                    <button key={term} type="button"
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left group"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setQuery(term); setSuggestFocused(false); }}
                    >
                      <History className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                      <span className="flex-1 text-[13px] text-zinc-400 group-hover:text-zinc-200 transition-colors truncate">{term}</span>
                      <X className="h-3 w-3 text-zinc-700 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all shrink-0"
                        onClick={(e) => removeRecent(term, e)} />
                    </button>
                  ))}
                </div>
              )}

              {/* Autocomplete — shown when typing */}
              {showSuggestions && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-zinc-950/98 backdrop-blur-xl border border-white/[0.07] rounded-xl shadow-2xl z-50 overflow-hidden py-1">
                  {suggestions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left group"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSuggestionSelect(item)}
                    >
                      {item.poster ? (
                        <img
                          src={item.poster}
                          alt=""
                          className="w-7 h-[38px] object-cover rounded-md flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity"
                        />
                      ) : (
                        <div className="w-7 h-[38px] bg-white/5 rounded-md flex-shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-zinc-300 group-hover:text-white truncate leading-tight">
                          {item.title}
                        </p>
                        <p className="text-[11px] text-zinc-600 mt-0.5">
                          {[item.year?.split('-')[0], item.type === 'series' ? 'Series' : item.type === 'movie' ? 'Movie' : 'Anime']
                            .filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="w-full flex items-center gap-2.5 px-3 py-2 border-t border-white/[0.05] hover:bg-white/[0.04] transition-colors text-left mt-0.5"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSuggestFocused(false)}
                  >
                    <SearchIcon className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                    <span className="text-[12px] text-zinc-500">
                      Show all results for <span className="text-zinc-300">&ldquo;{query}&rdquo;</span>
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Compact filter bar — all controls in one non-shifting row ── */}
        <div className="flex flex-wrap items-center gap-2.5 w-full">
          {/* Type toggles */}
          <div className="flex gap-1 bg-white/[0.03] border border-white/[0.08] rounded-xl p-1">
            {(['movie', 'series', 'anime'] as const).map(t => (
              <button key={t} type="button"
                className={cn(
                  'px-4 py-2 rounded-lg text-[13px] font-medium transition-all leading-none',
                  activeType === t
                    ? 'bg-white/[0.12] text-white shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
                )}
                onClick={() => handleTypeChange(t)}
              >
                {t === 'movie' ? 'Movies' : t === 'series' ? 'Series' : 'Anime'}
              </button>
            ))}
          </div>

          {/* Feed */}
          {supportsFeed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost"
                  className="h-10 px-4 gap-2 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-white/20 rounded-xl font-medium transition-all"
                >
                  {activeFeed === 'trending'
                    ? <TrendingUp className="h-4 w-4 text-orange-400 shrink-0" />
                    : <Sparkles   className="h-4 w-4 text-yellow-400 shrink-0" />}
                  {activeFeedLabel}
                  <ChevronDown className="h-4 w-4 opacity-40 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-xl min-w-[140px] p-1.5">
                {(activeType === 'anime' ? KITSU_FEEDS : CINEMETA_FEEDS).map(feed => (
                  <DropdownMenuItem key={feed.id} onClick={() => setActiveFeed(feed.id as DiscoverFeed)}
                    className={cn("gap-2.5 rounded-lg cursor-pointer text-[13px] py-2", activeFeed === feed.id && 'bg-white/10 font-medium')}
                  >
                    {activeFeed === feed.id ? <Check className="h-4 w-4 opacity-60 shrink-0" /> : <div className="w-4 shrink-0" />}
                    {feed.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Genre */}
          {supportsGenre && (
            <Popover open={genrePopoverOpen} onOpenChange={(open) => { setGenrePopoverOpen(open); if (!open) setGenreSearch(''); }}>
              <PopoverTrigger asChild>
                <Button variant="ghost"
                  className={cn(
                    "h-10 px-4 gap-2 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-white/20 rounded-xl font-medium transition-all",
                    activeGenres.length > 0 && "text-white border-white/20 bg-white/[0.08]"
                  )}
                >
                  Genre
                  {activeGenres.length > 0 && (
                    <span className="h-5 min-w-[20px] px-1 rounded bg-white/20 text-[11px] font-bold flex items-center justify-center ml-1">
                      {activeGenres.length}
                    </span>
                  )}
                  <ChevronDown className="h-4 w-4 opacity-40 ml-1" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={8}
                className="w-[320px] p-0 bg-zinc-950/95 border-white/10 backdrop-blur-xl shadow-2xl rounded-xl"
              >
                <div className="p-2.5 border-b border-white/[0.08]">
                  <div className="relative">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none" />
                    <Input type="text" placeholder="Search genres..."
                      className="h-9 pl-9 pr-3 text-[13px] bg-white/5 border-white/[0.08] focus:border-white/20 rounded-lg"
                      value={genreSearch}
                      onChange={(e) => setGenreSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
                <ScrollArea className="max-h-[280px]">
                  <div className="p-2 flex flex-wrap gap-1.5">
                    {filteredGenreOptions.map(genre => {
                      const active = activeGenres.includes(genre);
                      return (
                        <button key={genre} type="button" onClick={() => toggleGenre(genre)}
                          className={cn(
                            'px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-all border inline-flex items-center gap-1.5',
                            active
                              ? 'bg-white/15 text-white border-white/30'
                              : 'bg-white/[0.03] text-zinc-400 border-white/[0.08] hover:border-white/20 hover:text-zinc-200 hover:bg-white/5'
                          )}
                        >
                          {active && <Check className="h-3 w-3 shrink-0" />}
                          {genre}
                        </button>
                      );
                    })}
                    {filteredGenreOptions.length === 0 && (
                      <p className="text-[13px] text-zinc-500 px-3 py-4 w-full text-center">No matching genres</p>
                    )}
                  </div>
                </ScrollArea>
                {activeGenres.length > 0 && (
                  <div className="p-2.5 border-t border-white/[0.08] flex justify-between items-center bg-white/[0.02]">
                    <span className="text-[12px] text-zinc-500">{activeGenres.length} selected</span>
                    <button type="button" onClick={() => setActiveGenres([])}
                      className="text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors"
                    >Clear all</button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Source (non-anime only, discover mode) */}
          {supportsGenre && activeType !== 'anime' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost"
                  className={cn(
                    "h-10 px-4 gap-2 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-white/20 rounded-xl font-medium transition-all",
                    activeProvider !== 'cinemeta' && "text-white border-white/20 bg-white/[0.08]"
                  )}
                >
                  {PROVIDERS.find(p => p.id === activeProvider)?.short ?? 'All'}
                  <ChevronDown className="h-4 w-4 opacity-40 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-xl min-w-[140px] p-1.5">
                {PROVIDERS.filter(p => p.types.includes(activeType)).map(p => (
                  <DropdownMenuItem key={p.id} onClick={() => setActiveProvider(p.id)}
                    className={cn("gap-2.5 rounded-lg cursor-pointer text-[13px] py-2", activeProvider === p.id && 'bg-white/10 font-medium')}
                  >
                    {activeProvider === p.id ? <Check className="h-4 w-4 opacity-60 shrink-0" /> : <div className="w-4 shrink-0" />}
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Year — compact popover with From/To */}
          {supportsGenre && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost"
                  className={cn(
                    "h-10 px-4 gap-2 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-white/20 rounded-xl font-medium transition-all",
                    (yearFrom !== null || yearTo !== null) && "text-white border-white/20 bg-white/[0.08]"
                  )}
                >
                  {yearFrom !== null || yearTo !== null
                    ? `${yearFrom ?? '…'}\u2013${yearTo ?? '…'}`
                    : 'Year'}
                  <ChevronDown className="h-4 w-4 opacity-40 ml-1" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={8}
                className="w-[220px] p-4 bg-zinc-950/95 border-white/10 backdrop-blur-xl shadow-2xl rounded-xl space-y-4"
              >
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">From</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline"
                        className="w-full justify-between bg-white/[0.03] border-white/[0.08] hover:border-white/20 h-10 text-[13px] rounded-lg"
                      >
                        {yearFrom ?? 'Any'} <ChevronDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-[240px] overflow-y-auto min-w-[120px] rounded-xl bg-zinc-950/95 border-white/10 p-1.5">
                      <DropdownMenuItem className="py-2 text-[13px] rounded-lg" onClick={() => setYearFrom(null)}>Any</DropdownMenuItem>
                      {YEAR_OPTIONS.map(y => (
                        <DropdownMenuItem key={y} onClick={() => setYearFrom(y)}
                          className={cn("py-2 text-[13px] rounded-lg", yearFrom === y && 'bg-white/10 font-medium')}
                        >{y}</DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">To</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline"
                        className="w-full justify-between bg-white/[0.03] border-white/[0.08] hover:border-white/20 h-10 text-[13px] rounded-lg"
                      >
                        {yearTo ?? 'Any'} <ChevronDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-[240px] overflow-y-auto min-w-[120px] rounded-xl bg-zinc-950/95 border-white/10 p-1.5">
                      <DropdownMenuItem className="py-2 text-[13px] rounded-lg" onClick={() => setYearTo(null)}>Any</DropdownMenuItem>
                      {YEAR_OPTIONS.map(y => (
                        <DropdownMenuItem key={y} onClick={() => setYearTo(y)}
                          className={cn("py-2 text-[13px] rounded-lg", yearTo === y && 'bg-white/10 font-medium')}
                        >{y}</DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {(yearFrom !== null || yearTo !== null) && (
                  <button type="button" onClick={() => { setYearFrom(null); setYearTo(null); }}
                    className="text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors w-full text-right pt-2 border-t border-white/[0.08]"
                  >Clear</button>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost"
                className={cn(
                  "h-10 px-4 gap-2 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-white/20 rounded-xl font-medium transition-all",
                  activeSort !== 'default' && "text-white border-white/20 bg-white/[0.08]"
                )}
              >
                {activeSortLabel}
                <ChevronDown className="h-4 w-4 opacity-40 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-xl min-w-[160px] p-1.5">
              {SORT_OPTIONS.map(opt => (
                <DropdownMenuItem key={opt.id} onClick={() => setActiveSort(opt.id)}
                  className={cn("gap-2.5 rounded-lg cursor-pointer text-[13px] py-2", activeSort === opt.id && 'bg-white/10 font-medium')}
                >
                  {activeSort === opt.id ? <Check className="h-4 w-4 opacity-60 shrink-0" /> : <div className="w-4 shrink-0" />}
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Clear all active filters */}
          {hasActiveFilters && (
            <button type="button" onClick={clearAllFilters}
              className="h-10 px-3 rounded-xl text-[13px] font-medium text-zinc-400 hover:text-red-400 flex items-center gap-1.5 transition-colors ml-auto bg-white/[0.02] hover:bg-red-500/10 border border-transparent hover:border-red-500/20"
            >
              <X className="h-4 w-4" /> Clear All
            </button>
          )}
        </div>

        {/* Active genre chips — no layout shift */}
        {activeGenres.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mt-1">
            {activeGenres.map(g => (
              <Badge key={g} variant="secondary"
                className="h-7 bg-white/[0.06] text-white/90 border border-white/[0.1] hover:bg-white/[0.1] text-[12px] pl-3 pr-2 flex items-center gap-1.5 cursor-default rounded-lg transition-colors"
              >
                {g}
                <X className="h-3 w-3 cursor-pointer opacity-50 hover:opacity-100 hover:text-red-400 transition-all"
                  onClick={() => toggleGenre(g)} />
              </Badge>
            ))}
            {activeGenres.length > 1 && (
              <button type="button" onClick={() => setActiveGenres([])}
                className="text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors ml-1"
              >Clear</button>
            )}
          </div>
        )}

        {isIncognito && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
            <VenetianMask className="h-3.5 w-3.5 text-white/40 shrink-0" />
            <span>Private mode &mdash; search history and recent activity won&apos;t be saved.</span>
          </div>
        )}
      </div>

      {/* ── Scrollable content ──────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        data-media-scroll-container="true"
        className="flex-1 overflow-y-auto scroll-smooth min-h-0 -mr-4 pr-4 -ml-4 pl-4 pb-10 pt-3"
      >
        <div className="w-full">

          {/* Recent searches are now shown in the focus dropdown above */}

          {/* ── Main results area ─────────────────────────────────────── */}
          {!isOnline ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <WifiOff className="h-10 w-10 mb-4 opacity-40" />
              <p className="font-medium">You&apos;re offline</p>
              <p className="text-sm opacity-50 mt-1">Connect to the internet to browse and search</p>
            </div>
          ) : showSkeleton ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9 gap-4 pb-20">
              {Array.from({ length: 24 }).map((_, i) => <MediaCardSkeleton key={i} />)}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
              <AlertCircle className="h-10 w-10 mb-2 text-red-400/60" />
              <p className="font-medium text-red-400/80">Failed to load content</p>
              <p className="text-sm opacity-50">{getErrorMessage(errorObj)}</p>
            </div>
          ) : filteredResults.length > 0 ? (
            <>
              {/* Result count bar */}
              <div className="flex items-center justify-between mb-3 px-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5 flex-wrap">
                  {debouncedQuery ? (
                    <>
                      {filteredResults.length} results for &ldquo;{debouncedQuery}&rdquo;
                      {activeType === 'anime' && ' in Anime'}
                    </>
                  ) : isMultiGenreMode ? (
                    <>
                      <span>{filteredResults.length} titles</span>
                      <span className="opacity-40">— union of:</span>
                      {activeGenres.map(g => (
                        <Badge key={g} variant="outline" className="text-[10px] px-1.5 py-0 border-white/15">{g}</Badge>
                      ))}
                    </>
                  ) : (
                    <>
                      {filteredResults.length} titles
                      {rawResults.length !== filteredResults.length && (
                        <span className="opacity-40 ml-0.5">of {rawResults.length} fetched</span>
                      )}
                      {supportsFeed && (
                        <span className="inline-flex items-center gap-1 opacity-55">
                          {activeFeed === 'trending'
                            ? <TrendingUp className="h-3 w-3" />
                            : <Sparkles    className="h-3 w-3" />}
                          {activeFeedLabel}
                        </span>
                      )}
                    </>
                  )}
                </span>
                {hasActiveFilters && (
                  <button type="button" onClick={clearAllFilters}
                    className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors flex items-center gap-1 shrink-0"
                  >
                    <Filter className="h-3 w-3" /> Clear all
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9 gap-4">
                {filteredResults.map(item => <MediaCard key={item.id} item={item} />)}
              </div>

              {/* Infinite scroll sentinel (paginatable providers only) */}
              {!isMultiGenreMode && providerSupportsPagination && (
                <div ref={sentinelRef} className="h-1 w-full mt-4" />
              )}
              {isFetchingNextPage && (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-white/30" />
                </div>
              )}
              {showEndMsg && (
                <p className="text-center text-xs text-zinc-600 py-6">
                  {showSearchCapMsg
                    ? `Showing top ${SEARCH_RESULT_CAP} results — refine your search for more`
                    : 'All titles loaded'}
                </p>
              )}
              {isMultiGenreMode && multiGenreSupportsPagination && (
                <div className="flex justify-center py-6">
                  <Button
                    variant="outline"
                    className="bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white"
                    disabled={!multiGenreCanLoadMore || isFetching}
                    onClick={() => setMultiGenrePageCount((prev) => prev + 1)}
                  >
                    {isFetching ? 'Loading…' : multiGenreCanLoadMore ? `Load more (${multiGenrePageSize} per genre)` : 'All genre results loaded'}
                  </Button>
                </div>
              )}
              {isMultiGenreMode && isFetching && (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-white/30" />
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-1">
              <Filter className="h-10 w-10 mb-3 opacity-20" />
              <p className="font-medium">
                {debouncedQuery ? `No results for \u201c${debouncedQuery}\u201d` : 'No content available'}
              </p>
              <p className="text-sm opacity-50 mt-0.5">
                {hasActiveFilters && !debouncedQuery
                  ? 'Try removing some filters'
                  : debouncedQuery
                    ? activeType === 'anime'
                      ? 'Try a different term or check the spelling'
                      : 'Try a different term or switch category'
                    : activeGenres.length > 0
                      ? 'No titles found for the selected genres'
                      : 'Try changing the category or feed'}
              </p>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearAllFilters}
                  className="mt-2 h-8 text-xs text-zinc-500 hover:text-white rounded-md"
                >Clear all filters</Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
