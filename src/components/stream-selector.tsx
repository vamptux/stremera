import { useQuery, useMutation, useQueries } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, getErrorMessage, type TorrentioStream } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, FileVideo, X, SlidersHorizontal } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DownloadModal } from '@/components/download-modal';
import { StreamItem } from '@/components/stream-selector-item';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  buildStreamStats,
  DEFAULT_FILTERS,
  filterAndSortStreams,
  getStreamKey,
  isHttpStreamUrl,
  isDebridCapable,
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

/** Returns true when the error message indicates RD is still caching the torrent. */
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

/** Returns true when the error message indicates a Cloudflare / rate-limit block. */
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

interface StreamSelectorProps {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  type: 'movie' | 'series' | 'anime';
  id: string;
  streamId?: string;
  currentStreamKey?: string;
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

interface AddonStreamQueryResult {
  streams: TorrentioStream[];
  latencyMs: number;
}

type AddonHealthStatus = 'healthy' | 'degraded' | 'offline' | 'loading';

interface AddonHealthMetric {
  id: string;
  name: string;
  status: AddonHealthStatus;
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

interface ActiveResolveFeedback {
  mode: 'play' | 'download';
  title: string;
  subtitle: string;
}

const STREAM_SELECTOR_FILTERS_STORAGE_KEY = 'streamy_stream_selector_filters';
const QUALITY_FILTER_VALUES: QualityFilter[] = ['all', '4k', '1080p', '720p', 'sd'];
const SOURCE_FILTER_VALUES: SourceFilter[] = ['all', 'cached'];
const SORT_MODE_VALUES: SortMode[] = ['smart', 'quality', 'size', 'seeds'];
const BATCH_FILTER_VALUES: BatchFilter[] = ['all', 'episodes', 'packs'];

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

function loadStoredFilters(defaults: FilterState): FilterState {
  try {
    const raw = window.localStorage.getItem(STREAM_SELECTOR_FILTERS_STORAGE_KEY);
    if (!raw) {
      return defaults;
    }

    return normalizeStoredFilters(JSON.parse(raw), defaults);
  } catch {
    return defaults;
  }
}

function buildResolveFeedback(
  stream: TorrentioStream,
  mode: 'play' | 'download',
): ActiveResolveFeedback {
  const primaryLine =
    stream.name
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ||
    stream.title
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ||
    'Selected stream';

  const normalizedTitle = primaryLine.replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Selected stream';
  const deliveryLabel = stream.cached ? 'RD+' : isHttpStreamUrl(stream.url) ? 'HTTP' : 'Torrent';
  const subtitle = [stream.source_name?.trim(), deliveryLabel].filter(Boolean).join(' • ');

  return {
    mode,
    title: normalizedTitle,
    subtitle,
  };
}

export function StreamSelector({
  open,
  onClose,
  onBeforePlayerNavigation,
  type,
  id,
  streamId,
  currentStreamKey,
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
}: StreamSelectorProps) {
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadData, setDownloadData] = useState<{ url: string; title: string } | null>(null);
  const [activeResolveKey, setActiveResolveKey] = useState<string | null>(null);
  const [activeResolveFeedback, setActiveResolveFeedback] = useState<ActiveResolveFeedback | null>(
    null,
  );
  const openSessionKeyRef = useRef<string | null>(null);
  const isSeriesLike = type === 'series' || type === 'anime';
  // Kitsu-backed anime can surface as `series`; force anime stream lookup mode.
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

  // Filter + sort state
  const [filters, setFilters] = useState<FilterState>(() => loadStoredFilters(defaultFilters));
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
  const compactOverview = useMemo(() => {
    if (!overview) return '';
    const normalized = overview.replace(/\s+/g, ' ').trim();
    const maxChars = 200;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}…`;
  }, [overview]);

  useEffect(() => {
    if (!open) {
      openSessionKeyRef.current = null;
      return;
    }

    if (openSessionKeyRef.current === selectorSessionKey) return;
    openSessionKeyRef.current = selectorSessionKey;

    const timer = window.setTimeout(() => {
      setFilters(loadStoredFilters(defaultFilters));
      setActiveResolveKey(null);
      setActiveResolveFeedback(null);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [open, selectorSessionKey, defaultFilters]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STREAM_SELECTOR_FILTERS_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Ignore storage failures and keep the selector usable.
    }
  }, [filters]);

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
    data: rankedStreams = [],
    error: rankedStreamsError,
    isLoading: isLoadingRankedStreams,
    refetch: refetchRankedStreams,
  } = useQuery({
    queryKey: ['streams', streamMediaType, lookupId, season, episode, absoluteEpisode],
    queryFn: () =>
      api.getStreams(
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

  const addonStreamQueries = useQueries({
    queries: enabledAddons.map((addon) => ({
      queryKey: [
        'streamsByAddon',
        addon.id,
        addon.url,
        streamMediaType,
        lookupId,
        season,
        episode,
        absoluteEpisode,
      ],
      queryFn: () =>
        (async (): Promise<AddonStreamQueryResult> => {
          const startedAt = performance.now();
          const streams = await api.getStreamsForAddon(
            streamMediaType,
            lookupId,
            addon.url,
            addon.name,
            season,
            episode,
            absoluteEpisode,
          );

          return {
            streams,
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          };
        })(),
      enabled: open && !!lookupId && isOnline,
      staleTime: 1000 * 60 * 3,
      retry: 0,
    })),
  });

  const streams = rankedStreams;

  const settledAddonQueryCount = addonStreamQueries.filter((q) => q.isSuccess || q.isError).length;
  const hasPendingAddonQueries = addonStreamQueries.some((q) => q.isPending || q.isFetching);
  const isLoading =
    isLoadingAddonConfigs ||
    (enabledAddons.length > 0 && streams.length === 0 && (isLoadingRankedStreams || hasPendingAddonQueries));
  const isBackgroundLoadingSources =
    streams.length > 0 &&
    addonStreamQueries.length > 0 &&
    settledAddonQueryCount < addonStreamQueries.length;
  const fatalAddonError =
    streams.length === 0
      ? (rankedStreamsError ??
          (addonStreamQueries.length > 0 && addonStreamQueries.every((q) => q.isError)
            ? (addonStreamQueries.find((q) => q.error)?.error ?? null)
            : null))
      : null;

  const refetchStreams = () => {
    void refetchAddonConfigs();
    void refetchRankedStreams();
    for (const query of addonStreamQueries) {
      void query.refetch();
    }
  };

  const addonHealthMetrics = useMemo<AddonHealthMetric[]>(() => {
    return enabledAddons.map((addon, index) => {
      const query = addonStreamQueries[index];
      const streamCount = query?.data?.streams?.length ?? 0;
      const latencyMs = query?.data?.latencyMs;
      const errorMessage = query?.error ? getErrorMessage(query.error) : undefined;

      let status: AddonHealthStatus = 'loading';
      if (query?.isError) {
        status = 'offline';
      } else if (query?.isSuccess) {
        if (streamCount === 0) {
          status = 'degraded';
        } else if (typeof latencyMs === 'number' && latencyMs > 4500) {
          status = 'degraded';
        } else {
          status = 'healthy';
        }
      }

      return {
        id: addon.id,
        name: addon.name,
        status,
        streamCount,
        latencyMs,
        errorMessage,
      };
    });
  }, [enabledAddons, addonStreamQueries]);

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
      setActiveResolveKey(getStreamKey(stream));
      setActiveResolveFeedback(buildResolveFeedback(stream, 'play'));
    },
    onSuccess: async (data, stream) => {
      const feedback = buildResolveFeedback(stream, 'play');
      if (onStreamResolved) {
        void Promise.resolve(
          onStreamResolved({
            ...data,
            selectedStreamKey: getStreamKey(stream),
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
        selectedStreamKey: getStreamKey(stream),
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
    onError: (err) => {
      if (isDev) console.error('Stream resolution failed:', err);
      const msg = getErrorMessage(err);

      if (isDebridProcessingError(msg)) {
        toast.info('Still downloading on Debrid', {
          description: 'Real-Debrid is caching this file. Try again in a moment.',
          duration: 4500,
        });
      } else if (isDebridSetupError(msg)) {
        toast.error('Stream needs debrid or direct playback', {
          description: msg,
          duration: 6000,
        });
      } else if (isCloudflareError(msg)) {
        toast.warning('Blocked by Cloudflare / rate limit', {
          description:
            'The stream provider is rate-limiting requests. Wait 30 s then retry, or try another stream.',
          duration: 7000,
        });
      } else {
        toast.error('Failed to resolve stream', { description: msg, duration: 5000 });
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
      setActiveResolveKey(getStreamKey(stream));
      setActiveResolveFeedback(buildResolveFeedback(stream, 'download'));
    },
    onSuccess: (data) => {
      setDownloadData({ url: data.url, title });
      setDownloadModalOpen(true);
    },
    onError: (err) => {
      toast.error('Failed to resolve stream for download', { description: getErrorMessage(err) });
    },
    onSettled: () => {
      setActiveResolveKey(null);
      setActiveResolveFeedback(null);
    },
  });

  const isAnyResolving = resolveStreamMutation.isPending || resolveDownloadMutation.isPending;

  const handleRequestClose = () => {
    if (isAnyResolving) return;
    closeSelector();
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      handleRequestClose();
    }
  };

  // Base: only streams that can actually be resolved (debrid-cached or direct HTTP).
  // All downstream filtering, counts and display work from this set — never the raw list.
  const debridStreams = useMemo(() => streams.filter(isDebridCapable), [streams]);

  const sortedStreams = useMemo(() => {
    if (!debridStreams.length) return [];
    return filterAndSortStreams(debridStreams, effectiveFilters);
  }, [debridStreams, effectiveFilters]);

  const streamStats = useMemo(() => {
    return buildStreamStats(debridStreams);
  }, [debridStreams]);

  const showBatchFilter = isSeriesLike && season !== undefined && episode !== undefined;

  const hasActiveFilter =
    qualityFilter !== defaultFilters.quality ||
    sourceFilter !== defaultFilters.source ||
    effectiveAddonFilter !== defaultFilters.addon ||
    sortMode !== defaultFilters.sort ||
    batchFilter !== defaultFilters.batch;

  const handleSelectStream = (stream: TorrentioStream) => {
    if (isAnyResolving) return;
    resolveStreamMutation.mutate(stream);
  };

  const handleDownloadStream = (stream: TorrentioStream) => {
    if (isAnyResolving) return;
    resolveDownloadMutation.mutate(stream);
  };

  if (inlineMode && !open) return null;

  const streamPanel = (
    <div
      className={cn(
        'relative flex flex-col p-0 bg-zinc-950 border-zinc-800/60 gap-0 overflow-hidden shadow-2xl rounded-md',
        inlineMode ? 'w-[430px] h-[70vh] max-h-[560px] border' : 'sm:max-w-4xl h-[82vh]',
      )}
    >
      {/* Header */}
      <div className={cn('relative flex-shrink-0 overflow-hidden', inlineMode ? 'h-40' : 'h-56')}>
        {backdrop ? (
          <div className='absolute inset-0 z-0'>
            <img src={backdrop} className='w-full h-full object-cover opacity-30' alt='' />
            <div className='absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent' />
            <div className='absolute inset-0 bg-gradient-to-r from-zinc-950/80 via-transparent to-transparent' />
          </div>
        ) : (
          <div className='absolute inset-0 bg-zinc-900/60 z-0' />
        )}

        <DialogHeader className='relative z-10 p-6 h-full flex flex-col justify-end text-left'>
          <div className='flex items-end gap-4'>
            {poster && !inlineMode && (
              <img
                src={poster}
                className='w-20 h-[120px] rounded-md shadow-2xl border border-white/10 object-cover hidden sm:block mb-0.5 flex-shrink-0'
                alt=''
              />
            )}
            <div className='flex flex-col gap-2 min-w-0'>
              <DialogTitle
                className={cn(
                  'font-black text-white leading-tight drop-shadow-xl tracking-tight truncate',
                  inlineMode ? 'text-lg' : 'text-2xl',
                )}
              >
                {title}
              </DialogTitle>
              <div className='flex items-center gap-2 flex-wrap min-w-0'>
                {season !== undefined && episode !== undefined && (
                  <>
                    <Badge
                      variant='outline'
                      className='h-5 border-white/15 text-white/80 bg-white/5 px-2 text-[10px] font-semibold'
                    >
                      S{season}
                    </Badge>
                    <Badge
                      variant='outline'
                      className='h-5 border-white/15 text-white/80 bg-white/5 px-2 text-[10px] font-semibold'
                    >
                      E{episode}
                    </Badge>
                  </>
                )}
                {compactOverview && (
                  <p className='text-xs text-zinc-400 leading-relaxed hidden sm:block min-w-0 max-w-full basis-full overflow-hidden text-ellipsis whitespace-nowrap'>
                    {compactOverview}
                  </p>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <button
          onClick={handleRequestClose}
          className='absolute top-3 right-3 z-20 p-1.5 rounded bg-black/30 hover:bg-white/10 text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
          aria-label='Close'
          disabled={isAnyResolving}
        >
          <X className='w-3.5 h-3.5' />
        </button>
      </div>

      {/* Divider */}
      <div className='h-px bg-white/5 flex-shrink-0' />

      {/* Stream list */}
      <div className='flex-1 min-h-0 bg-zinc-950'>
        {isLoading ? (
          <div className='h-full flex flex-col items-center justify-center gap-3 text-muted-foreground'>
            <Loader2 className='w-6 h-6 animate-spin text-white/20' />
            <p className='text-[11px] font-semibold uppercase tracking-widest text-white/30 animate-pulse'>
              {enabledAddons.length > 0
                ? `Searching streams… ${settledAddonQueryCount}/${enabledAddons.length} sources`
                : 'Preparing sources…'}
            </p>
          </div>
        ) : fatalAddonError ? (
          <div className='h-full flex flex-col items-center justify-center gap-3 text-red-400'>
            <p className='text-sm'>Failed to load streams.</p>
            <p className='text-xs text-zinc-500 max-w-sm text-center'>
              {getErrorMessage(fatalAddonError)}
            </p>
            <Button variant='outline' size='sm' onClick={refetchStreams}>
              Retry
            </Button>
          </div>
        ) : !isOnline ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>You&apos;re offline.</p>
            <p className='text-xs text-zinc-500'>Reconnect to load stream sources.</p>
          </div>
        ) : !isLoadingAddonConfigs && enabledAddons.length === 0 ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No enabled stream sources.</p>
            <p className='text-xs text-zinc-500 leading-relaxed max-w-sm'>
              Enable at least one addon in Settings → Streaming, then try again.
            </p>
          </div>
        ) : debridStreams.length > 0 ? (
          <ScrollArea className='h-full [&>[data-radix-scroll-area-viewport]]:h-full'>
            <div className={cn('p-3 space-y-1 pb-6', isAnyResolving && 'pointer-events-none')}>
              {/* Addon telemetry */}
              {addonHealthMetrics.length > 0 && (
                <div className='bg-zinc-900/80 border border-white/[0.10] rounded-md px-3 py-2.5 mb-3'>
                  <div className='flex items-center gap-2 flex-wrap'>
                    {addonHealthMetrics.map((metric) => {
                      const isSelected = effectiveAddonFilter === metric.name;
                      const statusDot =
                        metric.status === 'healthy'
                          ? 'bg-emerald-400'
                          : metric.status === 'degraded'
                            ? 'bg-amber-400'
                            : metric.status === 'offline'
                              ? 'bg-red-400'
                              : 'bg-zinc-500 animate-pulse';

                      return (
                        <button
                          key={metric.id}
                          type='button'
                          title={metric.errorMessage || undefined}
                          onClick={() =>
                            setFilters((prev) => ({
                              ...prev,
                              addon: prev.addon === metric.name ? 'all' : metric.name,
                            }))
                          }
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all border',
                            isSelected
                              ? 'bg-indigo-500/20 text-indigo-200 border-indigo-400/30'
                              : 'bg-black/40 text-zinc-300 border-white/10 hover:border-white/20 hover:text-white',
                          )}
                        >
                          <span className={cn('h-1.5 w-1.5 rounded-full', statusDot)} />
                          <span className='truncate max-w-[90px]'>{metric.name}</span>
                          <span className='text-zinc-500'>{metric.streamCount}</span>
                          {typeof metric.latencyMs === 'number' && (
                            <span className='text-zinc-500 tabular-nums'>{metric.latencyMs}ms</span>
                          )}
                        </button>
                      );
                    })}

                    <span className='ml-auto text-[10px] text-zinc-500 font-semibold whitespace-nowrap'>
                      {healthSummary.healthy} healthy • {healthSummary.degraded} degraded •{' '}
                      {healthSummary.offline} offline
                    </span>
                  </div>
                </div>
              )}

              {/* Filter + sort bar */}
              <div className='bg-zinc-900/80 border border-white/[0.10] rounded-md px-3 py-2.5 mb-3'>
                {/* Row 2: Quality + Cached + Sort filters */}
                <div className='flex items-center gap-2 flex-wrap'>
                  {/* Quality filter segment */}
                  <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                    {(
                      [
                        ['all', 'All'],
                        ['4k', '4K'],
                        ['1080p', '1080p'],
                        ['720p', '720p'],
                        ['sd', 'SD'],
                      ] as [QualityFilter, string][]
                    ).map(([val, label]) => {
                      const count =
                        val === 'all' ? debridStreams.length : streamStats.resCounts[val];
                      if (val !== 'all' && count === 0) return null;
                      return (
                        <button
                          key={val}
                          type='button'
                          onClick={() => setFilters((f) => ({ ...f, quality: val }))}
                          className={cn(
                            'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                            qualityFilter === val
                              ? 'bg-white/20 text-white shadow-sm'
                              : 'text-zinc-400 hover:text-zinc-200',
                          )}
                        >
                          {label}
                          {val !== 'all' && (
                            <span className='ml-1 opacity-50 font-normal text-[9px]'>{count}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Cached filter — only shown when cached streams exist */}
                  {streamStats.cachedCount > 0 && (
                    <>
                      <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />
                      <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                        {(['all', 'cached'] as SourceFilter[]).map((val) => (
                          <button
                            key={val}
                            type='button'
                            onClick={() => setFilters((f) => ({ ...f, source: val }))}
                            className={cn(
                              'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                              sourceFilter === val
                                ? val === 'cached'
                                  ? 'bg-emerald-500/25 text-emerald-300 shadow-sm'
                                  : 'bg-white/20 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-zinc-200',
                            )}
                          >
                            {val === 'cached' ? `Cached ${streamStats.cachedCount}` : 'All'}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {showBatchFilter &&
                    (streamStats.batchCount > 0 || streamStats.episodeLikeCount > 0) && (
                      <>
                        <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />
                        <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                          {(
                            [
                              ['episodes', 'Episodes', streamStats.episodeLikeCount],
                              ['packs', 'Packs', streamStats.batchCount],
                              ['all', 'All', debridStreams.length],
                            ] as [BatchFilter, string, number][]
                          )
                            .filter((entry) => (entry[0] === 'all' ? true : entry[2] > 0))
                            .map(([value, label, count]) => (
                              <button
                                key={value}
                                type='button'
                                onClick={() => setFilters((f) => ({ ...f, batch: value }))}
                                className={cn(
                                  'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                                  batchFilter === value
                                    ? value === 'packs'
                                      ? 'bg-amber-500/25 text-amber-300 shadow-sm'
                                      : value === 'episodes'
                                        ? 'bg-sky-500/25 text-sky-300 shadow-sm'
                                        : 'bg-white/20 text-white shadow-sm'
                                    : 'text-zinc-400 hover:text-zinc-200',
                                )}
                              >
                                {label}
                                {value !== 'all' && (
                                  <span className='ml-1 opacity-60 font-normal text-[9px]'>
                                    {count}
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                      </>
                    )}

                  <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />

                  {/* Sort mode segment */}
                  <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                    <SlidersHorizontal className='w-3 h-3 text-zinc-500 ml-1.5 mr-0.5 flex-shrink-0' />
                    {(
                      [
                        ['smart', 'Smart'],
                        ['quality', 'Quality'],
                        ['size', 'Size'],
                        ['seeds', 'Seeds'],
                      ] as [SortMode, string][]
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type='button'
                        onClick={() => setFilters((f) => ({ ...f, sort: val }))}
                        className={cn(
                          'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                          sortMode === val
                            ? 'bg-white/20 text-white shadow-sm'
                            : 'text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className='ml-auto flex items-center gap-2 flex-shrink-0'>
                    {isBackgroundLoadingSources && (
                      <span className='text-[10px] font-medium text-zinc-500'>
                        Loading {settledAddonQueryCount}/{addonStreamQueries.length} sources…
                      </span>
                    )}
                    <span className='text-[10px] font-semibold text-zinc-500 tabular-nums'>
                      {sortedStreams.length === debridStreams.length
                        ? `${sortedStreams.length} streams`
                        : `${sortedStreams.length} / ${debridStreams.length}`}
                    </span>
                    {hasActiveFilter && (
                      <button
                        type='button'
                        onClick={() => setFilters(defaultFilters)}
                        className='text-[9px] text-zinc-600 hover:text-red-400 transition-colors font-semibold uppercase tracking-wider'
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {sortedStreams.length > 0 ? (
                sortedStreams.map((stream) => {
                  const streamKey = getStreamKey(stream);
                  const streamUrl = stream.url?.trim();
                  const isUrlMatch =
                    !!normalizedCurrentStreamUrl &&
                    !!streamUrl &&
                    streamUrl === normalizedCurrentStreamUrl;

                  return (
                    <StreamItem
                      key={streamKey}
                      stream={stream}
                      onSelect={() => handleSelectStream(stream)}
                      onDownload={() => handleDownloadStream(stream)}
                      isActive={currentStreamKey === streamKey || isUrlMatch}
                      isResolving={isAnyResolving && activeResolveKey === streamKey}
                      disabled={isAnyResolving}
                    />
                  );
                })
              ) : (
                <div className='flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground'>
                  <FileVideo className='w-8 h-8 opacity-15' />
                  <p className='text-xs text-zinc-500'>No streams match the current filters.</p>
                  <button
                    type='button'
                    onClick={() => setFilters(defaultFilters)}
                    className='text-xs text-zinc-500 hover:text-white transition-colors mt-1 underline underline-offset-2'
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : streams.length > 0 ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No instantly playable streams.</p>
            <p className='text-xs text-zinc-500 leading-relaxed max-w-sm'>
              Found {streams.length} candidates, but none include a cached or direct URL yet. Try
              another source/addon, or retry in a moment while debrid finishes caching.
            </p>
          </div>
        ) : (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No streams found.</p>
          </div>
        )}
      </div>

      {activeResolveFeedback && (
        <div className='pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center'>
          <div className='animate-in fade-in slide-in-from-bottom-2 duration-200 w-full max-w-sm rounded-2xl border border-white/10 bg-black/75 px-3.5 py-2.5 shadow-xl backdrop-blur-xl'>
            <div className='flex items-center gap-2.5'>
              <div className='flex items-center gap-[3px]'>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className='h-1.5 w-1.5 rounded-full bg-white/50 animate-bounce'
                    style={{ animationDelay: `${i * 130}ms`, animationDuration: '0.9s' }}
                  />
                ))}
              </div>

              <div className='min-w-0 flex-1'>
                <p className='mb-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/35'>
                  {activeResolveFeedback.mode === 'download'
                    ? 'Preparing Download'
                    : 'Opening Stream'}
                </p>
                <p className='truncate text-sm font-medium leading-tight text-white/90'>
                  {activeResolveFeedback.title}
                </p>
                {activeResolveFeedback.subtitle && (
                  <p className='truncate text-[11px] leading-snug text-white/40'>
                    {activeResolveFeedback.subtitle}
                  </p>
                )}
              </div>

              <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-white/40' />
            </div>

            <div className='relative mt-2 h-[2px] overflow-hidden rounded-full bg-white/10'>
              <div className='absolute inset-y-0 w-1/3 rounded-full bg-white/45 animate-[progress-slide_1.6s_linear_infinite]' />
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {inlineMode ? (
        streamPanel
      ) : (
        <Dialog open={open} onOpenChange={handleDialogOpenChange}>
          <DialogContent className='sm:max-w-4xl h-[82vh] flex flex-col p-0 bg-transparent border-none shadow-none rounded-md [&>button]:hidden'>
            {streamPanel}
          </DialogContent>
        </Dialog>
      )}

      {downloadData && (
        <DownloadModal
          open={downloadModalOpen}
          onOpenChange={setDownloadModalOpen}
          title={downloadData.title}
          url={downloadData.url}
          fileName={`${downloadData.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`}
          poster={poster}
          mediaType={type}
          mediaId={id}
          season={season}
          episode={episode}
          backdrop={backdrop}
        />
      )}
    </>
  );
}
