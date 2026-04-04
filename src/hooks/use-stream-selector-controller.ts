import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import {
  api,
  getErrorMessage,
  type StreamSelectorPreferencesState,
  type TorrentioStream,
} from '@/lib/api';
import { useDebounce } from '@/hooks/use-debounce';
import { useLegacyStorageImport } from '@/hooks/use-legacy-storage-import';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  clearLegacyStorageFeatureKeys,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';
import { buildPlayerNavigationTarget } from '@/lib/player-navigation';
import { buildStreamRankingOptions } from '@/lib/stream-ranking';
import { resolveStreamCandidate as resolvePlayableStreamCandidate } from '@/lib/stream-resolution';
import {
  buildStreamStats,
  DEFAULT_FILTERS,
  filterAndSortStreams,
  type BatchFilter,
  type FilterState,
  type QualityFilter,
  type SortMode,
  type SourceFilter,
} from '@/lib/stream-selector-utils';

const isDev = import.meta.env.DEV;
const LEGACY_STREAM_SELECTOR_FILTERS_STORAGE_KEY = 'streamy_stream_selector_filters';
const STREAM_SELECTOR_LEGACY_STORAGE_FEATURE = 'stream-selector-preferences';
const STREAM_SELECTOR_PREFERENCES_QUERY_KEY = ['streamSelectorPreferences'] as const;
const QUALITY_FILTER_VALUES: QualityFilter[] = ['all', '4k', '1080p', '720p', 'sd'];
const SOURCE_FILTER_VALUES: SourceFilter[] = ['all', 'cached'];
const SORT_MODE_VALUES: SortMode[] = ['smart', 'quality', 'size', 'seeds'];
const BATCH_FILTER_VALUES: BatchFilter[] = ['all', 'episodes', 'packs'];
const STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS = 200;

export interface AddonHealthMetric {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'loading';
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

interface ActiveResolveFeedback {
  mode: 'play' | 'download';
  subtitle: string;
  title: string;
}

interface UseStreamSelectorControllerArgs {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  type: 'movie' | 'series' | 'anime';
  id: string;
  imdbId?: string;
  streamId?: string;
  currentStreamUrl?: string;
  season?: number;
  episode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  aniskipEpisode?: number;
  startTime?: number;
  title: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  from?: string;
  inlineMode?: boolean;
  onStreamResolved?: (data: {
    url: string;
    format: string;
    is_web_friendly: boolean;
    selectedStreamKey: string;
    sourceName?: string;
    streamFamily?: string;
  }) => void | Promise<void>;
}

interface ResolvedStreamSelection {
  format: string;
  is_web_friendly: boolean;
  selectedStreamKey: string;
  sourceName?: string;
  streamFamily?: string;
  url: string;
}

interface UseSelectorPreferencesStateArgs {
  episode?: number;
  isSeriesLike: boolean;
  open: boolean;
  season?: number;
  selectorSessionKey: string;
}

interface UseSelectorResolutionArgs {
  absoluteEpisode?: number;
  absoluteSeason?: number;
  aniskipEpisode?: number;
  backdrop?: string;
  episode?: number;
  from?: string;
  id: string;
  imdbId?: string;
  logo?: string;
  lookupId: string;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  onClose: () => void;
  onStreamResolved?: (data: ResolvedStreamSelection) => void | Promise<void>;
  open: boolean;
  poster?: string;
  season?: number;
  selectorSessionKey: string;
  startTime?: number;
  streamMediaType: 'movie' | 'series' | 'anime';
  title: string;
}

const SKIP_TIMES_STALE_TIME_MS = 1000 * 60 * 60 * 12;
const SKIP_TIMES_GC_TIME_MS = 1000 * 60 * 60 * 24;

function areFilterStatesEqual(left: FilterState, right: FilterState): boolean {
  return (
    left.quality === right.quality &&
    left.source === right.source &&
    left.addon === right.addon &&
    left.sort === right.sort &&
    left.batch === right.batch
  );
}

function buildFilterStateKey(filters: FilterState): string {
  return [filters.quality, filters.source, filters.addon, filters.sort, filters.batch].join('|');
}

function normalizeStoredFilters(candidate: unknown, defaults: FilterState): FilterState {
  if (!candidate || typeof candidate !== 'object') {
    return defaults;
  }

  const stored = candidate as Partial<Record<keyof FilterState, unknown>>;
  const quality = QUALITY_FILTER_VALUES.includes(stored.quality as QualityFilter)
    ? (stored.quality as QualityFilter)
    : defaults.quality;
  const source = SOURCE_FILTER_VALUES.includes(stored.source as SourceFilter)
    ? (stored.source as SourceFilter)
    : defaults.source;
  const sort = SORT_MODE_VALUES.includes(stored.sort as SortMode)
    ? (stored.sort as SortMode)
    : defaults.sort;
  const storedBatch = BATCH_FILTER_VALUES.includes(stored.batch as BatchFilter)
    ? (stored.batch as BatchFilter)
    : defaults.batch;
  const batch = defaults.batch === 'all' && storedBatch !== 'all' ? 'all' : storedBatch;
  const addon =
    typeof stored.addon === 'string' && stored.addon.trim().length > 0
      ? stored.addon.trim()
      : defaults.addon;

  return {
    quality,
    source,
    addon,
    sort,
    batch,
  };
}

function readLegacyStreamSelectorPreferences(
  defaults: FilterState,
): LegacyStorageReadResult<FilterState> {
  return readLegacyStorageFeature(STREAM_SELECTOR_LEGACY_STORAGE_FEATURE, (storage) => {
    try {
      const raw = storage.getItem(LEGACY_STREAM_SELECTOR_FILTERS_STORAGE_KEY);
      if (!raw) {
        return { hasLegacyData: false, value: null };
      }

      return {
        hasLegacyData: true,
        value: normalizeStoredFilters(JSON.parse(raw), defaults),
      };
    } catch {
      return { hasLegacyData: true, value: null };
    }
  });
}

function clearLegacyStreamSelectorPreferences() {
  clearLegacyStorageFeatureKeys(STREAM_SELECTOR_LEGACY_STORAGE_FEATURE, [
    LEGACY_STREAM_SELECTOR_FILTERS_STORAGE_KEY,
  ]);
}

function isDebridProcessingError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('currently downloading on real-debrid') ||
    lower.includes('timeout waiting for real-debrid')
  );
}

function isDebridSetupError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('requires a configured debrid provider') ||
    lower.includes('requires debrid or a direct-link addon') ||
    lower.includes('api token is invalid or expired') ||
    lower.includes('real-debrid auth error')
  );
}

function isCloudflareError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('cloudflare') ||
    lower.includes('cf-ray') ||
    lower.includes('access denied') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('429') ||
    lower.includes('403 forbidden')
  );
}

function buildResolveFeedback(
  stream: TorrentioStream,
  mode: 'play' | 'download',
): ActiveResolveFeedback {
  const normalizedTitle =
    stream.presentation.streamTitle.trim() ||
    stream.presentation.sourceName.trim() ||
    'Selected stream';
  const subtitle = [stream.source_name?.trim(), stream.presentation.deliveryLabel]
    .filter(Boolean)
    .join(' | ');

  return {
    mode,
    subtitle,
    title: normalizedTitle,
  };
}

function useSelectorPreferencesState({
  episode,
  isSeriesLike,
  open,
  season,
  selectorSessionKey,
}: UseSelectorPreferencesStateArgs) {
  const queryClient = useQueryClient();
  const openSessionKeyRef = useRef<string | null>(null);
  const hasHydratedFiltersRef = useRef(false);
  const skipNextPreferenceSaveRef = useRef(false);
  const saveStreamSelectorPreferencesQueueRef = useRef(Promise.resolve<void>(undefined));
  const lastRequestedPreferenceKeyRef = useRef<string | null>(null);

  const defaultFilters = useMemo<FilterState>(() => {
    const preferEpisodeOnly = isSeriesLike && season !== undefined && episode !== undefined;
    return {
      ...DEFAULT_FILTERS,
      batch: preferEpisodeOnly ? 'episodes' : 'all',
    };
  }, [episode, isSeriesLike, season]);

  const legacyStreamSelectorPreferencesRead = useMemo(
    () => readLegacyStreamSelectorPreferences(defaultFilters),
    [defaultFilters],
  );
  const legacyStreamSelectorPreferences = legacyStreamSelectorPreferencesRead.value;
  const [filters, setFilters] = useState<FilterState>(() =>
    normalizeStoredFilters(legacyStreamSelectorPreferences, defaultFilters),
  );
  const latestFiltersRef = useRef(filters);
  const debouncedFilters = useDebounce(filters, STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS);

  useEffect(() => {
    latestFiltersRef.current = filters;
  }, [filters]);

  const streamSelectorPreferencesQuery = useQuery({
    queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
    queryFn: api.getStreamSelectorPreferences,
    enabled: open,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const persistedStreamSelectorPreferences = streamSelectorPreferencesQuery.isSuccess
    ? streamSelectorPreferencesQuery.data.initialized
      ? streamSelectorPreferencesQuery.data.preferences
      : (legacyStreamSelectorPreferences ?? defaultFilters)
    : (legacyStreamSelectorPreferences ?? defaultFilters);
  const normalizedPersistedFilters = useMemo(
    () => normalizeStoredFilters(persistedStreamSelectorPreferences, defaultFilters),
    [defaultFilters, persistedStreamSelectorPreferences],
  );

  const persistStreamSelectorPreferences = useEffectEvent((nextFilters: FilterState) => {
    const nextPreferenceKey = buildFilterStateKey(nextFilters);
    if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
      return;
    }

    lastRequestedPreferenceKeyRef.current = nextPreferenceKey;
    saveStreamSelectorPreferencesQueueRef.current = saveStreamSelectorPreferencesQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const savedPreferences = await api.saveStreamSelectorPreferences(nextFilters);
        lastRequestedPreferenceKeyRef.current = buildFilterStateKey(savedPreferences);
        queryClient.setQueryData<StreamSelectorPreferencesState>(
          STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
          {
            preferences: savedPreferences,
            initialized: true,
          },
        );
      })
      .catch(() => {
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current = null;
        }
      });
  });

  useLegacyStorageImport({
    clearLegacy: clearLegacyStreamSelectorPreferences,
    enabled: streamSelectorPreferencesQuery.isSuccess,
    feature: STREAM_SELECTOR_LEGACY_STORAGE_FEATURE,
    importLegacy: api.importLegacyStreamSelectorPreferences,
    onImported: (savedPreferences) => {
      queryClient.setQueryData<StreamSelectorPreferencesState>(
        STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
        {
          preferences: savedPreferences,
          initialized: true,
        },
      );
    },
    readResult: legacyStreamSelectorPreferencesRead,
  });

  useEffect(() => {
    if (!open) {
      if (streamSelectorPreferencesQuery.isSuccess && hasHydratedFiltersRef.current) {
        if (skipNextPreferenceSaveRef.current) {
          skipNextPreferenceSaveRef.current = false;
        } else {
          const latestFilters = latestFiltersRef.current;
          if (!areFilterStatesEqual(latestFilters, normalizedPersistedFilters)) {
            persistStreamSelectorPreferences(latestFilters);
          }
        }
      }

      openSessionKeyRef.current = null;
      hasHydratedFiltersRef.current = false;
      return;
    }

    if (!streamSelectorPreferencesQuery.isSuccess) {
      return;
    }

    if (openSessionKeyRef.current === selectorSessionKey && hasHydratedFiltersRef.current) {
      return;
    }

    openSessionKeyRef.current = selectorSessionKey;
    hasHydratedFiltersRef.current = true;
    skipNextPreferenceSaveRef.current = true;
    lastRequestedPreferenceKeyRef.current = buildFilterStateKey(normalizedPersistedFilters);

    const timer = window.setTimeout(() => {
      setFilters(normalizedPersistedFilters);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    normalizedPersistedFilters,
    open,
    selectorSessionKey,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  useEffect(() => {
    if (!open || !streamSelectorPreferencesQuery.isSuccess || !hasHydratedFiltersRef.current) {
      return;
    }

    if (skipNextPreferenceSaveRef.current) {
      skipNextPreferenceSaveRef.current = false;
      return;
    }

    if (areFilterStatesEqual(debouncedFilters, normalizedPersistedFilters)) {
      return;
    }

    persistStreamSelectorPreferences(debouncedFilters);
  }, [
    debouncedFilters,
    normalizedPersistedFilters,
    open,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  return {
    batchFilter: filters.batch,
    defaultFilters,
    filters,
    hasActiveFilter: !areFilterStatesEqual(filters, defaultFilters),
    qualityFilter: filters.quality,
    setFilters,
    sortMode: filters.sort,
    sourceFilter: filters.source,
  };
}

function useSelectorResolution({
  absoluteEpisode,
  absoluteSeason,
  aniskipEpisode,
  backdrop,
  episode,
  from,
  id,
  imdbId,
  logo,
  lookupId,
  onBeforePlayerNavigation,
  onClose,
  onStreamResolved,
  open,
  poster,
  season,
  selectorSessionKey,
  startTime,
  streamMediaType,
  title,
}: UseSelectorResolutionArgs) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadData, setDownloadData] = useState<{ title: string; url: string } | null>(null);
  const [activeResolveKey, setActiveResolveKey] = useState<string | null>(null);
  const [activeResolveSessionKey, setActiveResolveSessionKey] = useState<string | null>(null);
  const [activeResolveFeedback, setActiveResolveFeedback] = useState<ActiveResolveFeedback | null>(
    null,
  );
  const isActiveResolveInCurrentSession = activeResolveSessionKey === selectorSessionKey;

  const resetActiveResolveState = useCallback(() => {
    setActiveResolveSessionKey(null);
    setActiveResolveKey(null);
    setActiveResolveFeedback(null);
  }, []);

  const closeSelector = useCallback(() => {
    resetActiveResolveState();
    onClose();
  }, [onClose, resetActiveResolveState]);

  const prefetchSkipTimes = useCallback(() => {
    if (streamMediaType === 'movie') {
      return;
    }

    const canonicalSeason = absoluteSeason ?? season;
    const canonicalEpisode = absoluteEpisode ?? episode;
    const skipTimesEpisode =
      streamMediaType === 'anime' ? (aniskipEpisode ?? canonicalEpisode) : canonicalEpisode;
    const normalizedImdbId = imdbId?.trim() || (id.trim().startsWith('tt') ? id.trim() : undefined);

    if (!canonicalEpisode || !skipTimesEpisode) {
      return;
    }

    if (streamMediaType === 'series' && !normalizedImdbId) {
      return;
    }

    void queryClient.prefetchQuery({
      queryKey: [
        'skip-times',
        streamMediaType,
        id,
        normalizedImdbId,
        canonicalSeason,
        canonicalEpisode,
        skipTimesEpisode,
        0,
      ],
      queryFn: () =>
        api.getSkipTimes(streamMediaType, id, normalizedImdbId, canonicalSeason, skipTimesEpisode),
      staleTime: SKIP_TIMES_STALE_TIME_MS,
      gcTime: SKIP_TIMES_GC_TIME_MS,
    });
  }, [
    absoluteEpisode,
    absoluteSeason,
    aniskipEpisode,
    episode,
    id,
    imdbId,
    queryClient,
    season,
    streamMediaType,
  ]);

  const clearClosedSelectorState = useEffectEvent(() => {
    resetActiveResolveState();
    setDownloadData(null);
    setDownloadModalOpen(false);
  });

  useEffect(() => {
    if (open) {
      return;
    }

    clearClosedSelectorState();
  }, [open]);

  const resolveStreamCandidate = useCallback(
    (stream: TorrentioStream) =>
      resolvePlayableStreamCandidate(stream, {
        episode,
        season,
      }),
    [episode, season],
  );

  const resolveStreamMutation = useMutation({
    mutationFn: resolveStreamCandidate,
    onMutate: (stream) => {
      setActiveResolveSessionKey(selectorSessionKey);
      setActiveResolveKey(stream.streamKey);
      setActiveResolveFeedback(buildResolveFeedback(stream, 'play'));
    },
    onSuccess: async (data, stream) => {
      const feedback = buildResolveFeedback(stream, 'play');
      prefetchSkipTimes();

      if (onStreamResolved) {
        void Promise.resolve(
          onStreamResolved({
            ...data,
            selectedStreamKey: stream.streamKey,
            sourceName: stream.source_name?.trim() || undefined,
            streamFamily: stream.stream_family?.trim() || undefined,
          }),
        ).finally(() => {
          closeSelector();
        });
        return;
      }

      const playerNavigation = buildPlayerNavigationTarget(streamMediaType, id, {
        absoluteEpisode,
        absoluteSeason: absoluteSeason ?? season,
        aniskipEpisode,
        backdrop,
        format: data.format,
        from,
        logo,
        openingStreamName: feedback.title,
        openingStreamSource: feedback.subtitle,
        poster,
        selectedStreamKey: stream.streamKey,
        startTime,
        streamEpisode: episode,
        streamFamily: stream.stream_family,
        streamLookupId: lookupId,
        streamSeason: season,
        streamSourceName: stream.source_name,
        streamUrl: data.url,
        title,
      });

      await Promise.resolve(onBeforePlayerNavigation?.()).catch(() => undefined);
      navigate(playerNavigation.target, { state: playerNavigation.state });
      closeSelector();
    },
    onError: (error) => {
      if (isDev) {
        console.error('Stream resolution failed:', error);
      }

      const message = getErrorMessage(error);
      if (isDebridProcessingError(message)) {
        toast.info('Still downloading on Debrid', {
          description: 'Real-Debrid is caching this file. Try again in a moment.',
          duration: 4500,
        });
      } else if (isDebridSetupError(message)) {
        toast.error('Stream needs debrid or direct playback', {
          description: message,
          duration: 6000,
        });
      } else if (isCloudflareError(message)) {
        toast.warning('Blocked by Cloudflare / rate limit', {
          description:
            'The stream provider is rate-limiting requests. Wait 30 s then retry, or try another stream.',
          duration: 7000,
        });
      } else {
        toast.error('Failed to resolve stream', { description: message, duration: 5000 });
      }
    },
    onSettled: () => {
      resetActiveResolveState();
    },
  });

  const resolveDownloadMutation = useMutation({
    mutationFn: resolveStreamCandidate,
    onMutate: (stream) => {
      setActiveResolveSessionKey(selectorSessionKey);
      setActiveResolveKey(stream.streamKey);
      setActiveResolveFeedback(buildResolveFeedback(stream, 'download'));
    },
    onSuccess: (data) => {
      setDownloadData({ title, url: data.url });
      setDownloadModalOpen(true);
    },
    onError: (error) => {
      toast.error('Failed to resolve stream for download', {
        description: getErrorMessage(error),
      });
    },
    onSettled: () => {
      resetActiveResolveState();
    },
  });

  const isAnyResolving = resolveStreamMutation.isPending || resolveDownloadMutation.isPending;

  const handleRequestClose = useCallback(() => {
    if (isAnyResolving) {
      return;
    }

    closeSelector();
  }, [closeSelector, isAnyResolving]);

  const handleSelectStream = useCallback(
    (stream: TorrentioStream) => {
      if (isAnyResolving) {
        return;
      }

      resolveStreamMutation.mutate(stream);
    },
    [isAnyResolving, resolveStreamMutation],
  );

  const handleDownloadStream = useCallback(
    (stream: TorrentioStream) => {
      if (isAnyResolving) {
        return;
      }

      resolveDownloadMutation.mutate(stream);
    },
    [isAnyResolving, resolveDownloadMutation],
  );

  return {
    activeResolveFeedback: isActiveResolveInCurrentSession ? activeResolveFeedback : null,
    activeResolveKey: isActiveResolveInCurrentSession ? activeResolveKey : null,
    downloadData,
    downloadModalOpen,
    handleDownloadStream,
    handleRequestClose,
    handleSelectStream,
    isAnyResolving,
    setDownloadModalOpen,
  };
}

export function useStreamSelectorController({
  open,
  onClose,
  onBeforePlayerNavigation,
  type,
  id,
  imdbId,
  streamId,
  currentStreamUrl,
  season,
  episode,
  absoluteSeason,
  absoluteEpisode,
  aniskipEpisode,
  startTime,
  title,
  overview,
  poster,
  backdrop,
  logo,
  from,
  inlineMode = false,
  onStreamResolved,
}: UseStreamSelectorControllerArgs) {
  const isOnline = useOnlineStatus();
  const isSeriesLike = type === 'series' || type === 'anime';
  const streamMediaType: 'movie' | 'series' | 'anime' =
    type === 'anime' || (type === 'series' && id.trim().toLowerCase().startsWith('kitsu:'))
      ? 'anime'
      : type;

  const lookupId = streamId || id;
  const normalizedCurrentStreamUrl = currentStreamUrl?.trim();
  const selectorSessionKey = `${inlineMode ? 'inline' : 'dialog'}|${lookupId}|${season ?? 'na'}|${episode ?? 'na'}|${absoluteEpisode ?? 'na'}`;
  const {
    batchFilter,
    defaultFilters,
    filters,
    hasActiveFilter,
    qualityFilter,
    setFilters,
    sortMode,
    sourceFilter,
  } = useSelectorPreferencesState({
    episode,
    isSeriesLike,
    open,
    season,
    selectorSessionKey,
  });
  const compactOverview = useMemo(() => {
    if (!overview) return '';
    const normalized = overview.replace(/\s+/g, ' ').trim();
    const maxChars = 200;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}…`;
  }, [overview]);
  const {
    activeResolveFeedback,
    activeResolveKey,
    downloadData,
    downloadModalOpen,
    handleDownloadStream,
    handleRequestClose,
    handleSelectStream,
    isAnyResolving,
    setDownloadModalOpen,
  } = useSelectorResolution({
    absoluteEpisode,
    absoluteSeason,
    aniskipEpisode,
    backdrop,
    episode,
    from,
    id,
    imdbId,
    logo,
    lookupId,
    onBeforePlayerNavigation,
    onClose,
    onStreamResolved,
    open,
    poster,
    season,
    selectorSessionKey,
    startTime,
    streamMediaType,
    title,
  });

  const {
    data: addonConfigs = [],
    refetch: refetchAddonConfigs,
    isLoading: isLoadingAddonConfigs,
  } = useQuery({
    queryKey: ['addonConfigs'],
    queryFn: api.getAddonConfigs,
    enabled: open && isOnline,
    staleTime: 1000 * 60 * 5,
  });

  const enabledAddons = useMemo(
    () => addonConfigs.filter((addon) => addon.enabled && addon.url.trim().length > 0),
    [addonConfigs],
  );

  const effectiveAddonFilter = useMemo(() => {
    if (filters.addon === 'all') return 'all';
    return enabledAddons.some((addon) => addon.name === filters.addon) ? filters.addon : 'all';
  }, [enabledAddons, filters.addon]);

  const effectiveFilters = useMemo<FilterState>(() => {
    if (effectiveAddonFilter === filters.addon) {
      return filters;
    }

    return {
      ...filters,
      addon: effectiveAddonFilter,
    };
  }, [effectiveAddonFilter, filters]);

  const {
    data: streamSelectorData,
    error: streamSelectorDataError,
    isLoading: isLoadingStreamSelectorData,
    refetch: refetchStreamSelectorData,
  } = useQuery({
    queryKey: ['streams', 'selector', streamMediaType, lookupId, season, episode, absoluteEpisode],
    queryFn: () =>
      api.getStreamSelectorData(
        streamMediaType,
        lookupId,
        season,
        episode,
        absoluteEpisode,
        buildStreamRankingOptions({
          mediaId: id,
          mediaType: streamMediaType,
          season: absoluteSeason ?? season,
          episode: absoluteEpisode ?? episode,
          title,
        }),
      ),
    enabled: open && !!lookupId && isOnline,
    staleTime: 1000 * 60 * 3,
    retry: 0,
  });
  const streams = useMemo(() => streamSelectorData?.streams ?? [], [streamSelectorData?.streams]);

  const isLoading =
    isLoadingAddonConfigs ||
    (enabledAddons.length > 0 && streams.length === 0 && isLoadingStreamSelectorData);
  const fatalAddonError =
    streams.length === 0
      ? (streamSelectorData?.fatalErrorMessage ?? streamSelectorDataError ?? null)
      : null;

  const refetchStreams = useCallback(() => {
    void refetchAddonConfigs();
    void refetchStreamSelectorData();
  }, [refetchAddonConfigs, refetchStreamSelectorData]);

  const addonHealthMetrics = useMemo<AddonHealthMetric[]>(() => {
    if (streamSelectorData?.sourceSummaries?.length) {
      return streamSelectorData.sourceSummaries;
    }

    if (!open || enabledAddons.length === 0) {
      return [];
    }

    if (isLoadingStreamSelectorData) {
      return enabledAddons.map((addon) => ({
        id: addon.id,
        name: addon.name,
        status: 'loading' as const,
        streamCount: 0,
      }));
    }

    return [];
  }, [enabledAddons, isLoadingStreamSelectorData, open, streamSelectorData?.sourceSummaries]);

  const healthSummary = useMemo(() => {
    let healthy = 0;
    let degraded = 0;
    let offline = 0;

    for (const metric of addonHealthMetrics) {
      if (metric.status === 'healthy') healthy += 1;
      else if (metric.status === 'degraded') degraded += 1;
      else if (metric.status === 'offline') offline += 1;
    }

    return { healthy, degraded, offline };
  }, [addonHealthMetrics]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleRequestClose();
      }
    },
    [handleRequestClose],
  );

  const debridStreams = useMemo(
    () => streams.filter((stream) => stream.presentation.isInstantlyPlayable),
    [streams],
  );

  const sortedStreams = useMemo(() => {
    if (!debridStreams.length) return [];
    return filterAndSortStreams(debridStreams, effectiveFilters);
  }, [debridStreams, effectiveFilters]);

  const streamStats = useMemo(() => buildStreamStats(debridStreams), [debridStreams]);
  const showBatchFilter = isSeriesLike && season !== undefined && episode !== undefined;
  const hasSelectedFilter = hasActiveFilter || effectiveAddonFilter !== defaultFilters.addon;

  return {
    activeResolveFeedback,
    activeResolveKey,
    addonHealthMetrics,
    batchFilter,
    compactOverview,
    debridStreams,
    defaultFilters,
    downloadData,
    downloadModalOpen,
    effectiveAddonFilter,
    enabledAddons,
    fatalAddonError,
    filters,
    handleDialogOpenChange,
    handleDownloadStream,
    handleRequestClose,
    handleSelectStream,
    hasActiveFilter: hasSelectedFilter,
    healthSummary,
    isAnyResolving,
    isLoading,
    isLoadingAddonConfigs,
    isOnline,
    normalizedCurrentStreamUrl,
    qualityFilter,
    refetchStreams,
    setDownloadModalOpen,
    setFilters,
    showBatchFilter,
    sortMode,
    sortedStreams,
    sourceFilter,
    streamStats,
    streams,
  };
}
