import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { type Episode, type MediaDetails, api, type MediaEpisodesPage, type WatchProgress } from '@/lib/api';
import {
  buildEpisodeApiPageNumbersForDisplayRange,
  mergeEpisodePages,
  sliceVisibleEpisodesFromPages,
} from '@/lib/episode-pagination';
import { type LocalSeasonEntry } from '@/components/details-season-switcher';

const EPISODE_FETCH_PAGE_SIZE = 50;
const EPISODE_DISPLAY_PAGE_SIZE = 4;

function isSeriesLikeHistoryEntryType(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'series' || normalized === 'anime';
}

function formatSeasonLabel(seasonNumber: number, yearLabel?: string): string {
  return yearLabel ? `Season ${seasonNumber} • ${yearLabel}` : `Season ${seasonNumber}`;
}

interface UseDetailsEpisodePaneArgs {
  item?: MediaDetails;
  effectiveRouteType: string;
  effectiveRouteId: string;
  locationSeason: number | null;
  watchHistory?: WatchProgress[];
  isLoadingWatchHistory: boolean;
}

interface UseDetailsEpisodePaneResult {
  shouldUsePagedEpisodes: boolean;
  seasons: number[];
  seasonCount: number;
  selectedSeason: number | null;
  localSeasonEntries: LocalSeasonEntry[];
  seasonEpisodes: Episode[];
  visibleEpisodes: Episode[];
  episodeSearch: string;
  setEpisodeSearch: React.Dispatch<React.SetStateAction<string>>;
  clearEpisodeSearch: () => void;
  selectSeason: (seasonNumber: number) => void;
  resetEpisodePane: (preferredSeason?: number | null) => void;
  hasEpisodesForSelectedSeason: boolean;
  shouldShowEpisodeSearch: boolean;
  episodeRangeLabel: string;
  totalEpisodeCount: number;
  totalEpisodePages: number;
  activeEpisodePageIndex: number;
  visibleEpisodeStart: number;
  hasPreviousEpisodes: boolean;
  hasMoreEpisodes: boolean;
  changeEpisodePage: (direction: 'previous' | 'next') => void;
  shouldShowEpisodeProgressSkeleton: boolean;
}

export function useDetailsEpisodePane({
  item,
  effectiveRouteType,
  effectiveRouteId,
  locationSeason,
  watchHistory,
  isLoadingWatchHistory,
}: UseDetailsEpisodePaneArgs): UseDetailsEpisodePaneResult {
  const [userSelectedSeason, setUserSelectedSeason] = useState<number | null>(null);
  const [episodeSearch, setEpisodeSearch] = useState('');
  const [episodePagination, setEpisodePagination] = useState<Record<string, number>>({});

  const shouldUsePagedEpisodes = !!(item?.id?.startsWith('kitsu:') && item.type === 'series');
  const resumeSeasonFromHistory = watchHistory?.find(
    (entry) => entry.id === item?.id && isSeriesLikeHistoryEntryType(entry.type_),
  )?.season;
  const normalizedLocationSeason =
    locationSeason !== null && Number.isFinite(locationSeason) ? locationSeason : null;
  const selectedSeasonHint =
    userSelectedSeason ??
    normalizedLocationSeason ??
    (typeof resumeSeasonFromHistory === 'number' ? resumeSeasonFromHistory : null);
  const requestSeasonHint = selectedSeasonHint ?? undefined;

  const {
    data: pagedEpisodesData,
    isLoading: isLoadingPagedEpisodes,
  } = useQuery({
    queryKey: ['media-episodes', effectiveRouteType, item?.id, requestSeasonHint, 0, EPISODE_FETCH_PAGE_SIZE],
    queryFn: () =>
      api.getMediaEpisodes(
        effectiveRouteType || 'anime',
        item!.id,
        requestSeasonHint,
        0,
        EPISODE_FETCH_PAGE_SIZE,
      ),
    enabled: shouldUsePagedEpisodes && !!item?.id,
    staleTime: 1000 * 60 * 5,
  });

  const seasons = useMemo(() => {
    if (shouldUsePagedEpisodes) {
      return (pagedEpisodesData?.seasons ?? []).slice().sort((left, right) => left - right);
    }

    if (!item?.episodes) return [];
    return Array.from(new Set(item.episodes.map((episode) => episode.season))).sort(
      (left, right) => left - right,
    );
  }, [item, pagedEpisodesData?.seasons, shouldUsePagedEpisodes]);

  const selectedSeason = useMemo(() => {
    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) {
      return selectedSeasonHint;
    }
    if (seasons.length === 0) return null;
    return seasons.includes(1) ? 1 : seasons[0];
  }, [selectedSeasonHint, seasons]);

  const totalBackendEpisodePages = useMemo(() => {
    if (!shouldUsePagedEpisodes) return 0;
    const totalInSeason = pagedEpisodesData?.totalInSeason ?? 0;
    return Math.max(1, Math.ceil(totalInSeason / EPISODE_FETCH_PAGE_SIZE));
  }, [pagedEpisodesData?.totalInSeason, shouldUsePagedEpisodes]);

  const syncPagedSeasonSelection = useEffectEvent((nextSeason: number) => {
    setUserSelectedSeason((previous) => (previous === nextSeason ? previous : nextSeason));
  });

  useEffect(() => {
    if (!shouldUsePagedEpisodes || seasons.length === 0) return;
    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) return;

    const nextSeason = seasons.includes(1) ? 1 : seasons[0];
    syncPagedSeasonSelection(nextSeason);
  }, [seasons, selectedSeasonHint, shouldUsePagedEpisodes]);

  const seasonYears = shouldUsePagedEpisodes ? pagedEpisodesData?.seasonYears : item?.seasonYears;

  const seasonYearLabelMap = useMemo(() => {
    const map = new Map<number, string>();

    Object.entries(seasonYears ?? {}).forEach(([seasonKey, label]) => {
      const seasonNumber = Number(seasonKey);
      if (Number.isFinite(seasonNumber) && typeof label === 'string' && label.trim().length > 0) {
        map.set(seasonNumber, label.trim());
      }
    });

    return map;
  }, [seasonYears]);

  const localSeasonEntries = useMemo(
    () =>
      seasons.map((seasonNumber) => ({
        number: seasonNumber,
        label: formatSeasonLabel(seasonNumber, seasonYearLabelMap.get(seasonNumber)),
      })),
    [seasonYearLabelMap, seasons],
  );

  const currentEpisodeSeasonKey = `${item?.id || effectiveRouteId || 'unknown'}:${selectedSeason ?? selectedSeasonHint ?? 'none'}`;
  const hasEpisodeSearch = episodeSearch.trim().length > 0;
  const resumeEpisodeForSelectedSeason = useMemo(() => {
    if (!watchHistory || !item || item.type !== 'series' || selectedSeason === null) return null;

    const entry = watchHistory.find((historyEntry) => historyEntry.id === item.id && historyEntry.type_ === 'series');
    if (!entry || entry.season !== selectedSeason || entry.episode === undefined) return null;
    return entry.episode;
  }, [item, selectedSeason, watchHistory]);
  const defaultEpisodePageIndex = hasEpisodeSearch
    ? 0
    : typeof resumeEpisodeForSelectedSeason === 'number' && resumeEpisodeForSelectedSeason > 0
      ? Math.floor((resumeEpisodeForSelectedSeason - 1) / EPISODE_DISPLAY_PAGE_SIZE)
      : 0;
  const requestedEpisodePageIndex = hasEpisodeSearch
    ? 0
    : (episodePagination[currentEpisodeSeasonKey] ?? defaultEpisodePageIndex);

  const episodeApiPageNumbersToLoad = useMemo(() => {
    if (!shouldUsePagedEpisodes || !item?.id || selectedSeason === null || totalBackendEpisodePages <= 0) {
      return [];
    }

    if (hasEpisodeSearch) {
      return Array.from({ length: totalBackendEpisodePages }, (_, index) => index);
    }

    return buildEpisodeApiPageNumbersForDisplayRange(
      requestedEpisodePageIndex,
      EPISODE_DISPLAY_PAGE_SIZE,
      EPISODE_FETCH_PAGE_SIZE,
    ).filter((page) => page < totalBackendEpisodePages);
  }, [
    hasEpisodeSearch,
    item?.id,
    requestedEpisodePageIndex,
    selectedSeason,
    shouldUsePagedEpisodes,
    totalBackendEpisodePages,
  ]);

  const additionalEpisodePageQueries = useQueries({
    queries:
      shouldUsePagedEpisodes && !!item?.id && selectedSeason !== null
        ? episodeApiPageNumbersToLoad
            .filter((page) => page !== 0)
            .map((page) => ({
              queryKey: ['media-episodes', effectiveRouteType, item.id, selectedSeason, page, EPISODE_FETCH_PAGE_SIZE],
              queryFn: () =>
                api.getMediaEpisodes(
                  effectiveRouteType || 'anime',
                  item.id,
                  selectedSeason,
                  page,
                  EPISODE_FETCH_PAGE_SIZE,
                ),
              staleTime: 1000 * 60 * 5,
            }))
        : [],
  });

  const loadedPagedEpisodePages = useMemo(() => {
    const loadedPages: MediaEpisodesPage[] = [];

    if (pagedEpisodesData) {
      loadedPages.push(pagedEpisodesData);
    }

    for (const query of additionalEpisodePageQueries) {
      if (query.data) {
        loadedPages.push(query.data);
      }
    }

    loadedPages.sort((left, right) => left.page - right.page);
    return loadedPages;
  }, [additionalEpisodePageQueries, pagedEpisodesData]);

  const seasonEpisodes = useMemo(() => {
    if (selectedSeason === null) return [];
    if (shouldUsePagedEpisodes) {
      return mergeEpisodePages(loadedPagedEpisodePages, selectedSeason);
    }
    if (!item?.episodes) return [];

    return item.episodes
      .filter((episode) => episode.season === selectedSeason)
      .sort((left, right) => left.episode - right.episode);
  }, [item, loadedPagedEpisodePages, selectedSeason, shouldUsePagedEpisodes]);

  const searchFilteredEpisodes = useMemo(() => {
    if (!hasEpisodeSearch) return seasonEpisodes;

    const normalizedQuery = episodeSearch.toLowerCase().trim();
    return seasonEpisodes.filter((episode) => {
      if (String(episode.episode).includes(normalizedQuery)) return true;
      if (episode.title?.toLowerCase().includes(normalizedQuery)) return true;
      if (episode.overview?.toLowerCase().includes(normalizedQuery)) return true;
      return false;
    });
  }, [episodeSearch, hasEpisodeSearch, seasonEpisodes]);

  const totalEpisodesForSelectedSeason = shouldUsePagedEpisodes
    ? (pagedEpisodesData?.totalInSeason ?? 0)
    : seasonEpisodes.length;
  const totalEpisodeCount = hasEpisodeSearch
    ? searchFilteredEpisodes.length
    : totalEpisodesForSelectedSeason;
  const totalEpisodePages = Math.max(1, Math.ceil(totalEpisodeCount / EPISODE_DISPLAY_PAGE_SIZE));
  const activeEpisodePageIndex = Math.min(requestedEpisodePageIndex, totalEpisodePages - 1);

  const changeEpisodePage = useCallback(
    (direction: 'previous' | 'next') => {
      setEpisodePagination((previous) => {
        const currentPage = previous[currentEpisodeSeasonKey] ?? defaultEpisodePageIndex;
        const delta = direction === 'previous' ? -1 : 1;
        const nextPage = Math.max(0, Math.min(currentPage + delta, totalEpisodePages - 1));

        if (currentPage === nextPage) {
          return previous;
        }

        return {
          ...previous,
          [currentEpisodeSeasonKey]: nextPage,
        };
      });
    },
    [currentEpisodeSeasonKey, defaultEpisodePageIndex, totalEpisodePages],
  );

  const visibleEpisodes = useMemo(() => {
    if (selectedSeason === null) return [];

    if (shouldUsePagedEpisodes && !hasEpisodeSearch) {
      return sliceVisibleEpisodesFromPages(
        loadedPagedEpisodePages,
        activeEpisodePageIndex,
        EPISODE_DISPLAY_PAGE_SIZE,
        EPISODE_FETCH_PAGE_SIZE,
        selectedSeason,
      );
    }

    const start = activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE;
    return searchFilteredEpisodes.slice(start, start + EPISODE_DISPLAY_PAGE_SIZE);
  }, [
    activeEpisodePageIndex,
    hasEpisodeSearch,
    loadedPagedEpisodePages,
    searchFilteredEpisodes,
    selectedSeason,
    shouldUsePagedEpisodes,
  ]);

  const isLoadingVisibleEpisodeData =
    shouldUsePagedEpisodes &&
    ((!pagedEpisodesData && isLoadingPagedEpisodes) ||
      additionalEpisodePageQueries.some((query) => query.isLoading && !query.data));
  const hasEpisodesForSelectedSeason = totalEpisodesForSelectedSeason > 0;
  const shouldShowEpisodeSearch = totalEpisodesForSelectedSeason > 5;
  const hasPreviousEpisodes = activeEpisodePageIndex > 0;
  const hasMoreEpisodes = activeEpisodePageIndex < totalEpisodePages - 1;
  const visibleEpisodeStart =
    totalEpisodeCount === 0 ? 0 : activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE + 1;
  const visibleEpisodeEnd =
    totalEpisodeCount === 0
      ? 0
      : Math.min(totalEpisodeCount, visibleEpisodeStart + visibleEpisodes.length - 1);
  const episodeRangeLabel =
    visibleEpisodeStart > 0
      ? `Episodes ${visibleEpisodeStart}-${visibleEpisodeEnd}`
      : 'Episodes';
  const shouldShowEpisodeProgressSkeleton =
    item?.type === 'series' && (isLoadingWatchHistory || isLoadingVisibleEpisodeData);

  const selectSeason = useCallback((seasonNumber: number) => {
    setUserSelectedSeason((previous) => (previous === seasonNumber ? previous : seasonNumber));
    setEpisodeSearch('');
  }, []);

  const resetEpisodePane = useCallback((preferredSeason?: number | null) => {
    setEpisodePagination({});
    setEpisodeSearch('');
    if (typeof preferredSeason === 'number' && Number.isFinite(preferredSeason) && preferredSeason > 0) {
      setUserSelectedSeason(preferredSeason);
      return;
    }
    setUserSelectedSeason(null);
  }, []);

  const clearEpisodeSearch = useCallback(() => {
    setEpisodeSearch('');
  }, []);

  return {
    shouldUsePagedEpisodes,
    seasons,
    seasonCount: seasons.length,
    selectedSeason,
    localSeasonEntries,
    seasonEpisodes,
    visibleEpisodes,
    episodeSearch,
    setEpisodeSearch,
    clearEpisodeSearch,
    selectSeason,
    resetEpisodePane,
    hasEpisodesForSelectedSeason,
    shouldShowEpisodeSearch,
    episodeRangeLabel,
    totalEpisodeCount,
    totalEpisodePages,
    activeEpisodePageIndex,
    visibleEpisodeStart,
    hasPreviousEpisodes,
    hasMoreEpisodes,
    changeEpisodePage,
    shouldShowEpisodeProgressSkeleton,
  };
}