import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';

import { api, type MediaItem, type SearchCatalogPage } from '@/lib/api';
import {
  type SearchDiscoverFeed,
  type SearchMediaType,
  type SearchProviderId,
  type SearchSortOption,
} from '@/lib/search-page-state';

export type {
  SearchDiscoverFeed,
  SearchMediaType,
  SearchProviderId,
  SearchSortOption,
} from '@/lib/search-page-state';

const SEARCH_AUTO_PREFETCH_RESULT_TARGET = 120;
const SEARCH_AUTO_PREFETCH_PAGE_LIMIT = 2;
const FILTERED_SEARCH_AUTO_PREFETCH_PAGE_LIMIT = 4;

function getNextSearchCatalogPageParam(
  lastPage: SearchCatalogPage,
  allPages: SearchCatalogPage[],
): number | undefined {
  const nextSkip = lastPage.nextSkip ?? undefined;
  if (nextSkip === undefined || lastPage.items.length === 0) {
    return undefined;
  }

  if (allPages.length <= 1) {
    return nextSkip;
  }

  const seenIds = new Set<string>();
  for (const page of allPages.slice(0, -1)) {
    for (const item of page.items) {
      seenIds.add(item.id);
    }
  }

  return lastPage.items.some((item) => !seenIds.has(item.id)) ? nextSkip : undefined;
}

interface UseSearchResultsArgs {
  query: string;
  suggestionQuery: string;
  activeType: SearchMediaType;
  activeProvider: SearchProviderId;
  activeFeed: SearchDiscoverFeed;
  activeGenres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  activeSort: SearchSortOption;
  isOnline: boolean;
  suggestFocused: boolean;
  restoredScrollTopRef: MutableRefObject<number>;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
}

export function useSearchResults({
  query,
  suggestionQuery,
  activeType,
  activeProvider,
  activeFeed,
  activeGenres,
  yearFrom,
  yearTo,
  activeSort,
  isOnline,
  suggestFocused,
  restoredScrollTopRef,
  scrollContainerRef,
}: UseSearchResultsArgs) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim();
  const normalizedSuggestionQuery = suggestionQuery.trim();
  const normalizedGenres = useMemo(
    () => [...activeGenres].sort((left, right) => left.localeCompare(right)),
    [activeGenres],
  );
  const effectiveBrowseProvider = activeType === 'anime' ? 'kitsu' : activeProvider;
  const supportsInfiniteScroll =
    !normalizedQuery && activeType !== 'anime' && effectiveBrowseProvider !== 'cinemeta';
  const autoPrefetchPageLimit =
    yearFrom !== null || yearTo !== null
      ? FILTERED_SEARCH_AUTO_PREFETCH_PAGE_LIMIT
      : SEARCH_AUTO_PREFETCH_PAGE_LIMIT;

  const { data: suggestionPage } = useQuery({
    queryKey: ['search-suggestions', normalizedSuggestionQuery, activeType],
    queryFn: () =>
      api.querySearchCatalogPage({
        query: normalizedSuggestionQuery,
        mediaType: activeType,
        provider: activeType === 'anime' ? 'kitsu' : 'cinemeta',
        sort: 'default',
        limit: 6,
      }),
    enabled: isOnline && suggestFocused && normalizedSuggestionQuery.length >= 2,
    staleTime: 1000 * 60 * 2,
    placeholderData: (previousPage) => previousPage,
  });

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: [
      'search-catalog',
      normalizedQuery || null,
      activeType,
      normalizedQuery ? 'query' : effectiveBrowseProvider,
      normalizedQuery ? null : activeFeed,
      activeSort,
      normalizedQuery ? '' : normalizedGenres.join('|'),
      yearFrom,
      yearTo,
    ],
    queryFn: ({ pageParam }) =>
      api.querySearchCatalogPage({
        query: normalizedQuery || undefined,
        mediaType: activeType,
        provider: normalizedQuery
          ? activeType === 'anime'
            ? 'kitsu'
            : 'cinemeta'
          : effectiveBrowseProvider,
        feed: normalizedQuery ? undefined : activeFeed,
        sort: activeSort,
        genres: normalizedQuery ? undefined : normalizedGenres,
        yearFrom: yearFrom ?? undefined,
        yearTo: yearTo ?? undefined,
        skip: typeof pageParam === 'number' && pageParam > 0 ? pageParam : undefined,
      }),
    getNextPageParam: getNextSearchCatalogPageParam,
    initialPageParam: 0,
    staleTime: 1000 * 60 * 5,
    enabled: isOnline,
  });

  const rawResults = useMemo(() => {
    const seenIds = new Set<string>();
    const items: MediaItem[] = [];

    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (seenIds.has(item.id)) {
          continue;
        }

        seenIds.add(item.id);
        items.push(item);
      }
    }

    return items;
  }, [data?.pages]);

  const results = rawResults;
  const suggestions = suggestionPage?.items ?? [];
  const pagesLoaded = data?.pages.length ?? 0;

  useEffect(() => {
    if (!supportsInfiniteScroll || !data || isFetching || isFetchingNextPage || !hasNextPage) {
      return;
    }

    if (restoredScrollTopRef.current > 0 || pagesLoaded >= autoPrefetchPageLimit) {
      return;
    }

    if (rawResults.length < SEARCH_AUTO_PREFETCH_RESULT_TARGET) {
      void fetchNextPage();
    }
  }, [
    autoPrefetchPageLimit,
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    pagesLoaded,
    rawResults.length,
    restoredScrollTopRef,
    supportsInfiniteScroll,
  ]);

  useEffect(() => {
    if (!supportsInfiniteScroll) {
      return;
    }

    const sentinelElement = sentinelRef.current;
    if (!sentinelElement) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '800px', root: scrollContainerRef.current },
    );

    observer.observe(sentinelElement);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, scrollContainerRef, supportsInfiniteScroll]);

  return {
    sentinelRef,
    results,
    suggestions,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isError,
    errorObj: error,
    hasNextPage,
    fetchNextPage,
    supportsInfiniteScroll,
    showEndMsg: supportsInfiniteScroll && !hasNextPage && pagesLoaded > 1,
  };
}