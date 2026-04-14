import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useDebounce } from '@/hooks/use-debounce';
import { useLegacyStorageImport } from '@/hooks/use-legacy-storage-import';
import { api, type MediaItem } from '@/lib/api';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import {
  clearLegacySearchHistory,
  readLegacySearchHistory,
  type SearchHistoryEntry,
  type SearchHistoryEntryInput,
} from '@/lib/search-history';
import {
  areStringArraysEqual,
  getSearchFeedLabel,
  getSearchGenresForType,
  getSearchSortLabel,
  normalizeSearchYearRange,
  parseGenresParam,
  parseSearchSortParam,
  parseSearchYearParam,
  resolveSearchUrlFeed,
  resolveSearchUrlProvider,
  resolveSearchUrlType,
  SEARCH_PROVIDERS,
  type SearchDiscoverFeed,
  type SearchMediaType,
  type SearchProviderId,
  type SearchSortOption,
} from '@/lib/search-page-state';

const SEARCH_HISTORY_QUERY_KEY = ['search-history'] as const;
const SEARCH_SCROLL_PERSIST_DEBOUNCE_MS = 180;

function useSearchHistoryState() {
  const queryClient = useQueryClient();
  const legacySearchHistoryRead = useMemo(() => readLegacySearchHistory(), []);
  const searchHistoryQuery = useQuery({
    queryKey: SEARCH_HISTORY_QUERY_KEY,
    queryFn: api.getSearchHistory,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const recentSearches = searchHistoryQuery.data ?? [];

  useLegacyStorageImport({
    clearLegacy: clearLegacySearchHistory,
    enabled: searchHistoryQuery.isSuccess,
    feature: 'search-history',
    importLegacy: api.importSearchHistoryEntries,
    onImported: (importedEntries) => {
      queryClient.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_QUERY_KEY, importedEntries);
    },
    onSkipped: clearLegacySearchHistory,
    readResult: legacySearchHistoryRead,
    skipImport: recentSearches.length > 0,
  });

  const addSearchEntry = useCallback(
    async (entry: SearchHistoryEntryInput) => {
      const nextEntries = await api.pushSearchHistoryEntry(entry);
      queryClient.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_QUERY_KEY, nextEntries);
      return nextEntries;
    },
    [queryClient],
  );

  const removeSearchEntry = useCallback(
    async (entry: SearchHistoryEntry) => {
      const nextEntries = await api.removeSearchHistoryEntry(entry);
      queryClient.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_QUERY_KEY, nextEntries);
      return nextEntries;
    },
    [queryClient],
  );

  const clearSearchHistory = useCallback(async () => {
    clearLegacySearchHistory();
    await api.clearSearchHistory();
    queryClient.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_QUERY_KEY, []);
  }, [queryClient]);

  return {
    addSearchEntry,
    clearSearchHistory,
    recentSearches,
    removeSearchEntry,
  };
}

export function useSearchPageState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlQuery = searchParams.get('q') || '';
  const urlType = searchParams.get('type');
  const urlProvider = searchParams.get('provider');
  const urlGenre = searchParams.get('genre');
  const urlFeed = searchParams.get('feed');
  const urlSort = searchParams.get('sort');
  const normalizedUrlYears = normalizeSearchYearRange(
    parseSearchYearParam(searchParams.get('yearFrom')),
    parseSearchYearParam(searchParams.get('yearTo')),
  );
  const parsedUrlType = resolveSearchUrlType(urlType);
  const parsedUrlProvider = resolveSearchUrlProvider(parsedUrlType, urlProvider);
  const parsedUrlGenres = useMemo(() => parseGenresParam(urlGenre), [urlGenre]);
  const parsedUrlFeed = resolveSearchUrlFeed(parsedUrlType, urlFeed);
  const parsedUrlSort = parseSearchSortParam(urlSort);

  const [query, setQuery] = useState(urlQuery);
  const debouncedQuery = useDebounce(query, 500);
  const suggestionDebounce = useDebounce(query, 250);
  const [activeType, setActiveType] = useState<SearchMediaType>(parsedUrlType);
  const [activeProvider, setActiveProvider] = useState<SearchProviderId>(parsedUrlProvider);
  const [activeGenres, setActiveGenres] = useState<string[]>(parsedUrlGenres);
  const [activeFeed, setActiveFeed] = useState<SearchDiscoverFeed>(parsedUrlFeed);
  const [activeSort, setActiveSort] = useState<SearchSortOption>(parsedUrlSort);
  const [yearFrom, setYearFrom] = useState<number | null>(normalizedUrlYears.yearFrom);
  const [yearTo, setYearTo] = useState<number | null>(normalizedUrlYears.yearTo);
  const [genreSearch, setGenreSearch] = useState('');
  const [genrePopoverOpen, setGenrePopoverOpen] = useState(false);
  const [suggestFocused, setSuggestFocused] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const restoredScrollTopRef = useRef(0);
  const hasInitializedBrowseScrollRef = useRef(false);
  const persistTimeoutRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef<number | null>(null);
  const currentRoute = `${location.pathname}${location.search}`;
  const trimmedDebouncedQuery = debouncedQuery.trim();
  const scrollStorageKey = useMemo(() => `search-scroll:${currentRoute}`, [currentRoute]);
  const resetScrollKey = useMemo(
    () =>
      [
        trimmedDebouncedQuery,
        activeType,
        activeProvider,
        activeFeed,
        activeGenres.join('|'),
        activeSort,
        yearFrom ?? 'na',
        yearTo ?? 'na',
      ].join('|'),
    [
      activeFeed,
      activeGenres,
      activeProvider,
      activeSort,
      activeType,
      trimmedDebouncedQuery,
      yearFrom,
      yearTo,
    ],
  );

  const flushPendingScrollTop = useCallback(() => {
    if (pendingScrollTopRef.current === null) {
      return;
    }

    sessionStorage.setItem(scrollStorageKey, String(pendingScrollTopRef.current));
    pendingScrollTopRef.current = null;
  }, [scrollStorageKey]);

  const scheduleScrollPersistence = useCallback(
    (scrollTop: number) => {
      pendingScrollTopRef.current = scrollTop;

      if (persistTimeoutRef.current !== null) {
        return;
      }

      persistTimeoutRef.current = window.setTimeout(() => {
        persistTimeoutRef.current = null;
        flushPendingScrollTop();
      }, SEARCH_SCROLL_PERSIST_DEBOUNCE_MS);
    },
    [flushPendingScrollTop],
  );

  const saveScrollSnapshot = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    sessionStorage.setItem(scrollStorageKey, String(scrollContainer.scrollTop));
  }, [scrollStorageKey]);

  const updateYearRange = useCallback((nextYearFrom: number | null, nextYearTo: number | null) => {
    const normalizedRange = normalizeSearchYearRange(nextYearFrom, nextYearTo);
    setYearFrom(normalizedRange.yearFrom);
    setYearTo(normalizedRange.yearTo);
  }, []);

  const { recentSearches, addSearchEntry, clearSearchHistory, removeSearchEntry } =
    useSearchHistoryState();

  const addToRecent = useCallback(
    async (nextQuery: string) => {
      if (!nextQuery.trim()) {
        return;
      }

      const normalizedYears = normalizeSearchYearRange(yearFrom, yearTo);

      try {
        await addSearchEntry({
          query: nextQuery,
          mediaType: activeType,
          provider: activeProvider,
          feed: activeFeed,
          sort: activeSort,
          genres: activeGenres,
          yearFrom: normalizedYears.yearFrom,
          yearTo: normalizedYears.yearTo,
        });
      } catch {
        // Search history persistence is best-effort only.
      }
    },
    [
      activeFeed,
      activeGenres,
      activeProvider,
      activeSort,
      activeType,
      addSearchEntry,
      yearFrom,
      yearTo,
    ],
  );

  const clearRecent = useCallback(() => {
    void clearSearchHistory().catch(() => undefined);
  }, [clearSearchHistory]);

  const removeRecent = useCallback(
    (entry: SearchHistoryEntry, event: ReactMouseEvent<Element>) => {
      event.stopPropagation();
      void removeSearchEntry(entry).catch(() => undefined);
    },
    [removeSearchEntry],
  );

  const applyRecentSearch = useCallback(
    (entry: SearchHistoryEntry) => {
      const nextType = resolveSearchUrlType(entry.mediaType ?? null);
      const nextProvider = resolveSearchUrlProvider(nextType, entry.provider ?? null);
      const nextFeed = resolveSearchUrlFeed(nextType, entry.feed ?? null);
      const nextSort = parseSearchSortParam(entry.sort ?? null);
      const allowedGenres = new Set(getSearchGenresForType(nextType));
      const nextGenres = (entry.genres ?? []).filter((genre) => allowedGenres.has(genre));
      const normalizedYears = normalizeSearchYearRange(
        entry.yearFrom ?? null,
        entry.yearTo ?? null,
      );

      setActiveType(nextType);
      setActiveProvider(nextProvider);
      setActiveFeed(nextFeed);
      setActiveSort(nextSort);
      setActiveGenres(nextGenres);
      updateYearRange(normalizedYears.yearFrom, normalizedYears.yearTo);
      setQuery(entry.query);
      setSuggestFocused(false);
    },
    [updateYearRange],
  );

  useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    restoredScrollTopRef.current = 0;
    const savedScrollTop = sessionStorage.getItem(scrollStorageKey);
    if (!savedScrollTop) {
      return;
    }

    const parsedScrollTop = Number.parseFloat(savedScrollTop);
    if (!Number.isFinite(parsedScrollTop) || parsedScrollTop < 0) {
      return;
    }

    restoredScrollTopRef.current = parsedScrollTop;

    const frame = window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = parsedScrollTop;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrollStorageKey]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const persistScrollTop = () => {
      scheduleScrollPersistence(scrollContainer.scrollTop);
    };

    persistScrollTop();
    scrollContainer.addEventListener('scroll', persistScrollTop, { passive: true });

    return () => {
      persistScrollTop();
      flushPendingScrollTop();
      scrollContainer.removeEventListener('scroll', persistScrollTop);
    };
  }, [flushPendingScrollTop, scheduleScrollPersistence]);

  useEffect(() => {
    return () => {
      if (persistTimeoutRef.current !== null) {
        window.clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = null;
      }

      flushPendingScrollTop();
    };
  }, [flushPendingScrollTop]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingScrollTop();
      }
    };

    window.addEventListener('pagehide', flushPendingScrollTop);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', flushPendingScrollTop);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushPendingScrollTop]);

  const resetBrowseScroll = useEffectEvent((_resetKey: string) => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    if (!hasInitializedBrowseScrollRef.current) {
      hasInitializedBrowseScrollRef.current = true;
      return;
    }

    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });

  useEffect(() => {
    resetBrowseScroll(resetScrollKey);
  }, [resetScrollKey]);

  useEffect(() => {
    setActiveType(parsedUrlType);
    setActiveProvider(parsedUrlProvider);
    setActiveGenres((previousGenres) =>
      areStringArraysEqual(previousGenres, parsedUrlGenres) ? previousGenres : parsedUrlGenres,
    );
    setActiveFeed(parsedUrlFeed);
    setActiveSort(parsedUrlSort);
    updateYearRange(normalizedUrlYears.yearFrom, normalizedUrlYears.yearTo);
  }, [
    normalizedUrlYears.yearFrom,
    normalizedUrlYears.yearTo,
    parsedUrlFeed,
    parsedUrlGenres,
    parsedUrlProvider,
    parsedUrlSort,
    parsedUrlType,
    updateYearRange,
  ]);

  useEffect(() => {
    if (!trimmedDebouncedQuery) {
      return;
    }

    void addToRecent(trimmedDebouncedQuery);
  }, [addToRecent, trimmedDebouncedQuery]);

  useEffect(() => {
    const nextParams = new URLSearchParams();
    nextParams.set('type', activeType);
    nextParams.set('provider', activeProvider);
    if (trimmedDebouncedQuery) {
      nextParams.set('q', trimmedDebouncedQuery);
    }
    if (activeGenres.length > 0) {
      nextParams.set('genre', activeGenres.join(','));
    }
    if (!trimmedDebouncedQuery) {
      nextParams.set('feed', activeFeed);
    }
    if (activeSort !== 'default') {
      nextParams.set('sort', activeSort);
    }
    if (yearFrom !== null) {
      nextParams.set('yearFrom', String(yearFrom));
    }
    if (yearTo !== null) {
      nextParams.set('yearTo', String(yearTo));
    }

    if (searchParams.toString() === nextParams.toString()) {
      return;
    }

    setSearchParams(nextParams, { replace: true });
  }, [
    activeFeed,
    activeGenres,
    activeProvider,
    activeSort,
    activeType,
    searchParams,
    setSearchParams,
    trimmedDebouncedQuery,
    yearFrom,
    yearTo,
  ]);

  const handleTypeChange = useCallback(
    (nextType: SearchMediaType) => {
      setActiveType(nextType);
      setActiveGenres([]);
      setActiveFeed(nextType === 'anime' ? 'trending' : 'popular');
      setActiveSort('default');
      updateYearRange(null, null);

      if (nextType === 'anime') {
        setActiveProvider('kitsu');
        return;
      }

      const currentProvider = SEARCH_PROVIDERS.find((provider) => provider.id === activeProvider);
      if (currentProvider && !currentProvider.types.includes(nextType)) {
        setActiveProvider('cinemeta');
      }
    },
    [activeProvider, updateYearRange],
  );

  const handleProviderChange = useCallback((provider: SearchProviderId) => {
    setActiveProvider(provider);

    if (provider !== 'cinemeta') {
      setActiveGenres([]);
      setGenrePopoverOpen(false);
      setGenreSearch('');
    }
  }, []);

  const toggleGenre = useCallback((genre: string) => {
    setActiveGenres((previousGenres) =>
      previousGenres.includes(genre)
        ? previousGenres.filter((currentGenre) => currentGenre !== genre)
        : [...previousGenres, genre],
    );
  }, []);

  const clearAllFilters = useCallback(() => {
    setActiveGenres([]);
    setActiveSort('default');
    updateYearRange(null, null);
  }, [updateYearRange]);

  const hasActiveFilters =
    activeGenres.length > 0 || activeSort !== 'default' || yearFrom !== null || yearTo !== null;

  useEffect(() => {
    if (activeType === 'anime' || activeProvider === 'cinemeta' || activeGenres.length === 0) {
      return;
    }

    setActiveGenres([]);
    setGenrePopoverOpen(false);
    setGenreSearch('');
  }, [activeGenres.length, activeProvider, activeType]);

  const handleSuggestionSelect = useCallback(
    (item: MediaItem) => {
      saveScrollSnapshot();
      prefetchDetailsRouteData(queryClient, {
        mediaId: item.id,
        mediaType: item.type,
      });
      const detailsType = resolvePlayerRouteMediaType(item.type, item.id);
      setSuggestFocused(false);
      navigate(`/details/${detailsType}/${item.id}`, { state: { from: currentRoute } });
    },
    [currentRoute, navigate, queryClient, saveScrollSnapshot],
  );

  const currentGenres = useMemo(() => getSearchGenresForType(activeType), [activeType]);
  const filteredGenreOptions = useMemo(() => {
    const normalizedGenreSearch = genreSearch.trim().toLowerCase();
    if (!normalizedGenreSearch) {
      return currentGenres;
    }

    return currentGenres.filter((genre) => genre.toLowerCase().includes(normalizedGenreSearch));
  }, [currentGenres, genreSearch]);
  const canUseGenreFilters = activeType === 'anime' || activeProvider === 'cinemeta';
  const supportsBrowseControls = !trimmedDebouncedQuery;
  const supportsGenreFilters = supportsBrowseControls && canUseGenreFilters;
  const supportsFeed = supportsBrowseControls && canUseGenreFilters;
  const activeFeedLabel = getSearchFeedLabel(activeType, activeFeed);
  const activeSortLabel = getSearchSortLabel(activeSort);
  const kitsuBrowseNotice = useMemo(() => {
    if (activeType !== 'anime' || trimmedDebouncedQuery) {
      return null;
    }

    return `${activeFeedLabel} anime browse currently loads a single verified Kitsu page for reliability. Use search when you need a wider catalog.`;
  }, [activeFeedLabel, activeType, trimmedDebouncedQuery]);

  return {
    activeFeed,
    activeFeedLabel,
    activeGenres,
    activeProvider,
    activeSort,
    activeSortLabel,
    activeType,
    applyRecentSearch,
    clearAllFilters,
    clearRecent,
    currentGenres,
    debouncedQuery,
    filteredGenreOptions,
    genrePopoverOpen,
    genreSearch,
    handleProviderChange,
    handleSuggestionSelect,
    handleTypeChange,
    hasActiveFilters,
    kitsuBrowseNotice,
    query,
    recentSearches,
    removeRecent,
    restoredScrollTopRef,
    scrollContainerRef,
    setActiveFeed,
    setActiveGenres,
    setActiveSort,
    setGenrePopoverOpen,
    setGenreSearch,
    setQuery,
    setSuggestFocused,
    suggestFocused,
    suggestionDebounce,
    supportsBrowseControls,
    supportsFeed,
    supportsGenreFilters,
    toggleGenre,
    trimmedDebouncedQuery,
    updateYearRange,
    yearFrom,
    yearTo,
  };
}
