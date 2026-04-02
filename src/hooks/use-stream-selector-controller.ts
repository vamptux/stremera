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
import {
  clearLegacyStorageFeatureKeys,
  markLegacyStorageFeatureComplete,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  buildStreamStats,
  DEFAULT_FILTERS,
  filterAndSortStreams,
  type BatchFilter,
  type FilterState,
  type QualityFilter,
  type SourceFilter,
  type SortMode,
} from '@/lib/stream-selector-utils';
import { buildPlayerNavigationTarget } from '@/lib/player-navigation';
import { buildStreamRankingOptions } from '@/lib/stream-ranking';
import { resolveStreamCandidate as resolvePlayableStreamCandidate } from '@/lib/stream-resolution';

const isDev = import.meta.env.DEV;
const LEGACY_STREAM_SELECTOR_FILTERS_STORAGE_KEY = 'streamy_stream_selector_filters';
const STREAM_SELECTOR_LEGACY_STORAGE_FEATURE = 'stream-selector-preferences';
const QUALITY_FILTER_VALUES: QualityFilter[] = ['all', '4k', '1080p', '720p', 'sd'];
const SOURCE_FILTER_VALUES: SourceFilter[] = ['all', 'cached'];
const SORT_MODE_VALUES: SortMode[] = ['smart', 'quality', 'size', 'seeds'];
const BATCH_FILTER_VALUES: BatchFilter[] = ['all', 'episodes', 'packs'];

export interface AddonHealthMetric {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'loading';
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface ActiveResolveFeedback {
  mode: 'play' | 'download';
  title: string;
  subtitle: string;
}

interface UseStreamSelectorControllerArgs {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  type: 'movie' | 'series' | 'anime';
  id: string;
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
    .join(' • ');

  return {
    mode,
    title: normalizedTitle,
    subtitle,
  };
}

export function useStreamSelectorController({
  open,
  onClose,
  onBeforePlayerNavigation,
  type,
  id,
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadData, setDownloadData] = useState<{ url: string; title: string } | null>(null);
  const [activeResolveKey, setActiveResolveKey] = useState<string | null>(null);
  const [activeResolveFeedback, setActiveResolveFeedback] =
    useState<ActiveResolveFeedback | null>(null);
  const openSessionKeyRef = useRef<string | null>(null);
  const hasHydratedFiltersRef = useRef(false);
  const skipNextPreferenceSaveRef = useRef(false);
  const isSeriesLike = type === 'series' || type === 'anime';
  const streamMediaType: 'movie' | 'series' | 'anime' =
    type === 'anime' || (type === 'series' && id.trim().toLowerCase().startsWith('kitsu:'))
      ? 'anime'
      : type;

  const defaultFilters = useMemo<FilterState>(() => {
    const preferEpisodeOnly = isSeriesLike && season !== undefined && episode !== undefined;
    return {
      ...DEFAULT_FILTERS,
      batch: preferEpisodeOnly ? 'episodes' : 'all',
    };
  }, [isSeriesLike, season, episode]);

  const legacyStreamSelectorPreferencesRead = useMemo(
    () => readLegacyStreamSelectorPreferences(defaultFilters),
    [defaultFilters],
  );
  const legacyStreamSelectorPreferences = legacyStreamSelectorPreferencesRead.value;
  const [hasImportedLegacyStreamSelectorPreferences, setHasImportedLegacyStreamSelectorPreferences] =
    useState(() => !legacyStreamSelectorPreferencesRead.hasLegacyData);
  const markLegacyImportHandled = useEffectEvent(() => {
    setHasImportedLegacyStreamSelectorPreferences(true);
  });
  const [filters, setFilters] = useState<FilterState>(() =>
    normalizeStoredFilters(legacyStreamSelectorPreferences, defaultFilters),
  );
  const {
    quality: qualityFilter,
    source: sourceFilter,
    sort: sortMode,
    batch: batchFilter,
  } = filters;

  const closeSelector = useCallback(() => {
    setActiveResolveKey(null);
    setActiveResolveFeedback(null);
    onClose();
  }, [onClose]);

  const lookupId = streamId || id;
  const normalizedCurrentStreamUrl = currentStreamUrl?.trim();
  const selectorSessionKey = `${inlineMode ? 'inline' : 'dialog'}|${lookupId}|${season ?? 'na'}|${episode ?? 'na'}|${absoluteEpisode ?? 'na'}`;
  const streamSelectorPreferencesQuery = useQuery({
    queryKey: ['streamSelectorPreferences'],
    queryFn: api.getStreamSelectorPreferences,
    enabled: open,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const persistedStreamSelectorPreferences =
    streamSelectorPreferencesQuery.isSuccess
      ? streamSelectorPreferencesQuery.data.initialized
        ? streamSelectorPreferencesQuery.data.preferences
        : legacyStreamSelectorPreferences ?? defaultFilters
      : legacyStreamSelectorPreferences ?? defaultFilters;
  const compactOverview = useMemo(() => {
    if (!overview) return '';
    const normalized = overview.replace(/\s+/g, ' ').trim();
    const maxChars = 200;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}…`;
  }, [overview]);

  useEffect(() => {
    if (!legacyStreamSelectorPreferencesRead.hasLegacyData) {
      markLegacyStorageFeatureComplete(STREAM_SELECTOR_LEGACY_STORAGE_FEATURE);
    }
  }, [legacyStreamSelectorPreferencesRead.hasLegacyData]);

  useEffect(() => {
    if (!open) {
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

    const timer = window.setTimeout(() => {
      setFilters(normalizeStoredFilters(persistedStreamSelectorPreferences, defaultFilters));
      setActiveResolveKey(null);
      setActiveResolveFeedback(null);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    defaultFilters,
    open,
    persistedStreamSelectorPreferences,
    selectorSessionKey,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  useEffect(() => {
    if (hasImportedLegacyStreamSelectorPreferences || !streamSelectorPreferencesQuery.isSuccess) {
      return;
    }

    if (!legacyStreamSelectorPreferencesRead.hasLegacyData) {
      markLegacyImportHandled();
      return;
    }

    if (!legacyStreamSelectorPreferences) {
      clearLegacyStreamSelectorPreferences();
      markLegacyImportHandled();
      return;
    }

    let cancelled = false;

    void api
      .importLegacyStreamSelectorPreferences(legacyStreamSelectorPreferences)
      .then((savedPreferences) => {
        if (cancelled) {
          return;
        }

        queryClient.setQueryData<StreamSelectorPreferencesState>(
          ['streamSelectorPreferences'],
          {
            preferences: savedPreferences,
            initialized: true,
          },
        );
        clearLegacyStreamSelectorPreferences();
        markLegacyImportHandled();
      })
      .catch(() => {
        if (!cancelled) {
          markLegacyImportHandled();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasImportedLegacyStreamSelectorPreferences,
    legacyStreamSelectorPreferences,
    legacyStreamSelectorPreferencesRead.hasLegacyData,
    queryClient,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  const persistStreamSelectorPreferences = useEffectEvent((nextFilters: FilterState) => {
    void api.saveStreamSelectorPreferences(nextFilters).then((savedPreferences) => {
      queryClient.setQueryData<StreamSelectorPreferencesState>(
        ['streamSelectorPreferences'],
        {
          preferences: savedPreferences,
          initialized: true,
        },
      );
    });
  });

  useEffect(() => {
    if (!open || !streamSelectorPreferencesQuery.isSuccess || !hasHydratedFiltersRef.current) {
      return;
    }

    if (skipNextPreferenceSaveRef.current) {
      skipNextPreferenceSaveRef.current = false;
      return;
    }

    persistStreamSelectorPreferences(filters);
  }, [filters, open, streamSelectorPreferencesQuery.isSuccess]);

  const resolveStreamCandidate = useCallback(
    (stream: TorrentioStream) =>
      resolvePlayableStreamCandidate(stream, {
        season,
        episode,
      }),
    [season, episode],
  );

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

  const resolveStreamMutation = useMutation({
    mutationFn: resolveStreamCandidate,
    onMutate: (stream) => {
      setActiveResolveKey(stream.streamKey);
      setActiveResolveFeedback(buildResolveFeedback(stream, 'play'));
    },
    onSuccess: async (data, stream) => {
      const feedback = buildResolveFeedback(stream, 'play');
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

      const playerSeason = absoluteSeason ?? season;
      const playerEpisode = absoluteEpisode ?? episode;
      const playerNavigation = buildPlayerNavigationTarget(streamMediaType, id, {
        streamUrl: data.url,
        streamLookupId: lookupId,
        streamSeason: season,
        streamEpisode: episode,
        absoluteSeason: playerSeason,
        absoluteEpisode: playerEpisode,
        selectedStreamKey: stream.streamKey,
        streamSourceName: stream.source_name,
        streamFamily: stream.stream_family,
        openingStreamName: feedback.title,
        openingStreamSource: feedback.subtitle,
        title,
        poster,
        backdrop,
        logo,
        format: data.format,
        startTime,
        aniskipEpisode,
        from,
      });

      await Promise.resolve(onBeforePlayerNavigation?.()).catch(() => undefined);

      navigate(playerNavigation.target, { state: playerNavigation.state });
      closeSelector();
    },
    onError: (error) => {
      if (isDev) console.error('Stream resolution failed:', error);
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
      setActiveResolveKey(null);
      setActiveResolveFeedback(null);
    },
  });

  const resolveDownloadMutation = useMutation({
    mutationFn: resolveStreamCandidate,
    onMutate: (stream) => {
      setActiveResolveKey(stream.streamKey);
      setActiveResolveFeedback(buildResolveFeedback(stream, 'download'));
    },
    onSuccess: (data) => {
      setDownloadData({ url: data.url, title });
      setDownloadModalOpen(true);
    },
    onError: (error) => {
      toast.error('Failed to resolve stream for download', {
        description: getErrorMessage(error),
      });
    },
    onSettled: () => {
      setActiveResolveKey(null);
      setActiveResolveFeedback(null);
    },
  });

  const isAnyResolving = resolveStreamMutation.isPending || resolveDownloadMutation.isPending;

  const handleRequestClose = useCallback(() => {
    if (isAnyResolving) return;
    closeSelector();
  }, [closeSelector, isAnyResolving]);

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
  const hasActiveFilter =
    qualityFilter !== defaultFilters.quality ||
    sourceFilter !== defaultFilters.source ||
    effectiveAddonFilter !== defaultFilters.addon ||
    sortMode !== defaultFilters.sort ||
    batchFilter !== defaultFilters.batch;

  const handleSelectStream = useCallback(
    (stream: TorrentioStream) => {
      if (isAnyResolving) return;
      resolveStreamMutation.mutate(stream);
    },
    [isAnyResolving, resolveStreamMutation],
  );

  const handleDownloadStream = useCallback(
    (stream: TorrentioStream) => {
      if (isAnyResolving) return;
      resolveDownloadMutation.mutate(stream);
    },
    [isAnyResolving, resolveDownloadMutation],
  );

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
    hasActiveFilter,
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