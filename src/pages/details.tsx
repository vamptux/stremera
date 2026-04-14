import { useQuery, useQueryClient } from '@tanstack/react-query';
import { openUrl as openExternal } from '@tauri-apps/plugin-opener';
import { motion } from 'framer-motion';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Search,
  Star,
  X,
  Youtube,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AnimeMetadataSection } from '@/components/anime-metadata-panel';
import { SeasonSwitcher } from '@/components/details-season-switcher';
import { MediaCard } from '@/components/media-card';
import { StreamSelector } from '@/components/stream-selector';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useDetailsEpisodePane } from '@/hooks/use-details-episode-pane';
import {
  useContinueWatching,
  useIsItemInLibrary,
  useToggleLibraryItem,
  useWatchHistory,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { api, type Episode, getErrorMessage, type MediaItem, type WatchProgress } from '@/lib/api';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { resolveEpisodeStreamTarget } from '@/lib/episode-stream-target';
import {
  type DetailsHistoryRouteState,
  getLatestEpisodeResumeStartTime,
  getPlayableResumeStartTime,
} from '@/lib/history-playback';
import { resolveTrailerEmbedUrl } from '@/lib/trailer-utils';
import { cn } from '@/lib/utils';

const EPISODE_DISPLAY_PAGE_SIZE = 4;
const EPISODE_SKELETON_KEYS = [
  'episode-skeleton-1',
  'episode-skeleton-2',
  'episode-skeleton-3',
  'episode-skeleton-4',
] as const;

function formatRelationRoleLabel(role?: string | null): string | null {
  if (!role) return null;
  const trimmed = role.trim();
  if (!trimmed) return null;

  return trimmed
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

type DetailsTab = 'episodes' | 'relations' | 'anime-metadata';

function isSeriesLikeHistoryEntryType(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'series' || normalized === 'anime';
}

function getRelationRoleBadgeClass(role?: string | null): string {
  const normalizedRole = (role ?? '').trim().toLowerCase();

  if (normalizedRole === 'sequel') {
    return 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300';
  }

  if (normalizedRole === 'prequel') {
    return 'border-amber-500/30 bg-amber-500/15 text-amber-300';
  }

  return 'border-white/[0.08] bg-white/[0.04] text-zinc-400';
}

// Wrapper component to remount Details on id change
export function Details() {
  const { type, id } = useParams<{ type: string; id: string }>();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className='min-h-screen bg-background selection:bg-white/20'
    >
      <DetailsContent key={`${type}-${id}`} />
    </motion.div>
  );
}

function DetailsContent() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const baseRouteType = type || 'series';
  const baseRouteId = id || '';
  const baseRouteKey = `${baseRouteType}:${baseRouteId}`;
  const [inlineTarget, setInlineTarget] = useState<{
    type: string;
    id: string;
    originKey: string;
  } | null>(null);
  const scopedInlineTarget = inlineTarget?.originKey === baseRouteKey ? inlineTarget : null;
  const effectiveRouteType = scopedInlineTarget?.type || baseRouteType;
  const effectiveRouteId = scopedInlineTarget?.id || baseRouteId;
  const isKitsuRoute = !!effectiveRouteId.startsWith('kitsu:');
  const location = useLocation();
  const queryClient = useQueryClient();
  const { preferences: appUiPreferences } = useAppUiPreferences();
  const spoilerProtection = appUiPreferences.spoilerProtection;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const {
    data: item,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['details', effectiveRouteType, effectiveRouteId],
    queryFn: () =>
      api.getMediaDetails(effectiveRouteType, effectiveRouteId, {
        includeEpisodes: !(isKitsuRoute && effectiveRouteType === 'anime'),
      }),
    enabled: !!effectiveRouteType && !!effectiveRouteId,
    staleTime: 1000 * 60 * 30, // 30 minutes stale time for details
  });

  // Watch history (used for resume + episode progress)
  const { data: watchHistory, isLoading: isLoadingWatchHistory } = useWatchHistory({
    staleTime: 1000 * 60 * 3,
  });

  const { data: continueWatching } = useContinueWatching({
    enabled: item?.type === 'series' && !!item?.id,
    staleTime: 1000 * 60 * 3,
  });

  const itemId = item?.id;
  const watchHistoryForItem = useMemo(() => {
    if (!itemId || !watchHistory?.length) return [];
    return watchHistory.filter((entry) => entry.id === itemId);
  }, [watchHistory, itemId]);

  const isLoadingWatchHistoryForItem = item?.type === 'series' && isLoadingWatchHistory;

  const episodeProgressMap = useMemo(() => {
    const map = new Map<string, WatchProgress>();
    watchHistoryForItem?.forEach((entry) => {
      if (entry.type_ !== 'series') return;
      if (entry.season === undefined || entry.episode === undefined) return;
      map.set(`${entry.id}:${entry.season}:${entry.episode}`, entry);
    });
    return map;
  }, [watchHistoryForItem]);

  const { data: isInLibrary = false } = useIsItemInLibrary(item?.id);
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });

  const locationSeason = location.state?.season ? Number(location.state.season) : null;

  // Trailer State
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);

  const {
    shouldUsePagedEpisodes,
    seasons,
    seasonCount,
    selectedSeason,
    localSeasonEntries,
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
  } = useDetailsEpisodePane({
    item,
    effectiveRouteType,
    effectiveRouteId,
    locationSeason,
    watchHistory,
    isLoadingWatchHistory: isLoadingWatchHistoryForItem,
  });

  const [activeTab, setActiveTab] = useState<DetailsTab>('episodes');

  const prefetchInlineDetailsTarget = useCallback(
    (nextType: string, nextId: string, preferredSeason?: number | null) => {
      const normalizedType = nextType.trim();
      const normalizedId = nextId.trim();
      if (!normalizedType || !normalizedId) return;

      prefetchDetailsRouteData(queryClient, {
        mediaId: normalizedId,
        mediaType: normalizedType,
        preferredSeason,
        episodePageSize: EPISODE_DISPLAY_PAGE_SIZE,
      });
    },
    [queryClient],
  );

  const handleInlineDetailsSwitch = useCallback(
    (nextType: string, nextId: string, preferredSeason?: number | null) => {
      const normalizedType = nextType.trim();
      const normalizedId = nextId.trim();
      if (!normalizedType || !normalizedId) return;

      if (normalizedType === effectiveRouteType && normalizedId === effectiveRouteId) {
        setActiveTab('episodes');
        if (
          typeof preferredSeason === 'number' &&
          Number.isFinite(preferredSeason) &&
          preferredSeason > 0
        ) {
          selectSeason(preferredSeason);
        }
        return;
      }

      setInlineTarget({
        type: normalizedType,
        id: normalizedId,
        originKey: baseRouteKey,
      });
      setActiveTab('episodes');
      resetEpisodePane(preferredSeason);
    },
    [baseRouteKey, effectiveRouteId, effectiveRouteType, resetEpisodePane, selectSeason],
  );

  const relatedItems = useMemo(() => {
    const relations = item?.relations ?? [];
    if (relations.length === 0) return [];

    const deduped = new Map<string, MediaItem>();
    relations.forEach((relation) => {
      if (!relation?.id) return;
      if (!deduped.has(relation.id)) deduped.set(relation.id, relation);
    });

    return Array.from(deduped.values());
  }, [item?.relations]);

  const hasEpisodesTab =
    item?.type === 'series' &&
    (shouldUsePagedEpisodes || !!item?.episodes?.length || seasons.length > 0);
  const hasRelationsTab = relatedItems.length > 0;
  const hasAnimeMetadataTab = !!item?.id?.startsWith('kitsu:');
  const availableTabs = useMemo(() => {
    const tabs: DetailsTab[] = [];
    if (hasEpisodesTab) tabs.push('episodes');
    if (hasRelationsTab) tabs.push('relations');
    if (hasAnimeMetadataTab) tabs.push('anime-metadata');
    return tabs;
  }, [hasAnimeMetadataTab, hasEpisodesTab, hasRelationsTab]);
  const resolvedActiveTab: DetailsTab = availableTabs.includes(activeTab)
    ? activeTab
    : (availableTabs[0] ?? 'episodes');

  const resumeEpisodeRef = useRef<HTMLButtonElement | null>(null);
  // Stream Selector State
  type StreamParams = {
    id: string;
    streamId: string;
    season?: number;
    episode?: number;
    absoluteSeason?: number;
    absoluteEpisode?: number;
    aniskipEpisode?: number;
    startTime?: number;
    title: string;
    overview?: string;
  };

  const [streamSelectorOpen, setStreamSelectorOpen] = useState(false);
  const [streamParams, setStreamParams] = useState<StreamParams | null>(null);

  const preferredStreamId = useMemo(() => {
    if (!item) return undefined;
    // Most addon feeds key streams by IMDb IDs; fall back to the source ID when needed.
    return item.imdbId || item.id;
  }, [item]);
  const [reopenSelectorConsumed, setReopenSelectorConsumed] = useState(false);

  const isKitsuAnime = !!item?.id?.startsWith('kitsu:');
  const streamSelectorType: 'movie' | 'series' | 'anime' =
    item?.type === 'movie'
      ? 'movie'
      : isKitsuAnime || effectiveRouteType === 'anime'
        ? 'anime'
        : 'series';

  // Spoiler protection: determine the furthest watched episode in the selected season.
  // Episodes beyond that point will have thumbnails blurred and descriptions hidden.
  const maxWatchedEpisodeInSeason = useMemo(() => {
    if (!spoilerProtection || selectedSeason === null || !item) return null;
    let max: number | null = null;

    for (const entry of watchHistoryForItem ?? []) {
      if (entry.type_ !== 'series' && entry.type_ !== 'anime') {
        continue;
      }

      if (entry.season !== selectedSeason || entry.episode === undefined || entry.duration <= 0) {
        continue;
      }

      if (entry.position / entry.duration > 0.05) {
        if (max === null || entry.episode > max) max = entry.episode;
      }
    }

    // Fallback to series-level progress entry when episode-scoped rows are sparse.
    const seriesResumeEpisode = watchHistory?.find(
      (w) =>
        w.id === item.id && isSeriesLikeHistoryEntryType(w.type_) && w.season === selectedSeason,
    )?.episode;
    if (typeof seriesResumeEpisode === 'number') {
      if (max === null || seriesResumeEpisode > max) {
        max = seriesResumeEpisode;
      }
    }

    return max;
  }, [spoilerProtection, selectedSeason, item, watchHistory, watchHistoryForItem]);

  const isEpisodeSpoiler = useCallback(
    (ep: Episode): boolean => {
      if (!spoilerProtection || maxWatchedEpisodeInSeason === null || !item) return false;
      const prog = episodeProgressMap.get(`${item.id}:${ep.season}:${ep.episode}`);
      // Episodes the user has started watching are never considered spoilers
      if (prog && prog.duration > 0 && prog.position / prog.duration > 0.05) return false;
      return ep.episode > maxWatchedEpisodeInSeason;
    },
    [spoilerProtection, maxWatchedEpisodeInSeason, episodeProgressMap, item],
  );

  const handleWatchMovie = useCallback(
    (startTime?: number) => {
      if (!item || !preferredStreamId) return;
      setStreamParams({
        id: item.id,
        streamId: preferredStreamId,
        title: item.title,
        overview: item.description,
        startTime,
      });
      setStreamSelectorOpen(true);
    },
    [item, preferredStreamId],
  );

  const openEpisodeStreamSelector = useCallback(
    async (
      episodeInput: Pick<
        Episode,
        | 'season'
        | 'episode'
        | 'streamLookupId'
        | 'streamSeason'
        | 'streamEpisode'
        | 'aniskipEpisode'
      >,
      options?: {
        overview?: string;
        isCancelled?: () => boolean;
        startTime?: number;
        title?: string;
      },
    ) => {
      if (!item || !preferredStreamId) return false;

      const target = await resolveEpisodeStreamTarget(
        streamSelectorType,
        item.id,
        preferredStreamId,
        episodeInput,
      );

      if (options?.isCancelled?.()) {
        return false;
      }

      setStreamParams({
        id: item.id,
        streamId: target.streamId,
        season: target.season,
        episode: target.episode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        aniskipEpisode: target.aniskipEpisode,
        title: options?.title || `${item.title} S${episodeInput.season}E${episodeInput.episode}`,
        overview: options?.overview,
        startTime: options?.startTime,
      });
      setStreamSelectorOpen(true);
      return true;
    },
    [item, preferredStreamId, streamSelectorType],
  );

  const openDetailsReopenSelector = useCallback(
    async (
      state?: Pick<
        DetailsHistoryRouteState,
        'reopenStreamSelector' | 'reopenStreamSeason' | 'reopenStreamEpisode' | 'reopenStartTime'
      >,
      options?: {
        isCancelled?: () => boolean;
      },
    ) => {
      if (!state?.reopenStreamSelector || !item || !preferredStreamId) {
        return false;
      }

      const startTime =
        typeof state.reopenStartTime === 'number' && state.reopenStartTime > 0
          ? state.reopenStartTime
          : undefined;

      if (item.type === 'movie') {
        if (options?.isCancelled?.()) {
          return false;
        }

        handleWatchMovie(startTime);
        return true;
      }

      const reopenSeason =
        typeof state.reopenStreamSeason === 'number' ? state.reopenStreamSeason : undefined;
      const reopenEpisode =
        typeof state.reopenStreamEpisode === 'number' ? state.reopenStreamEpisode : undefined;

      if (reopenSeason === undefined || reopenEpisode === undefined) {
        return false;
      }

      const targetEpisode = item.episodes?.find(
        (ep) => ep.season === reopenSeason && ep.episode === reopenEpisode,
      );

      return openEpisodeStreamSelector(
        {
          season: reopenSeason,
          episode: reopenEpisode,
          streamLookupId: targetEpisode?.streamLookupId,
          streamSeason: targetEpisode?.streamSeason,
          streamEpisode: targetEpisode?.streamEpisode,
          aniskipEpisode: targetEpisode?.aniskipEpisode,
        },
        {
          overview: targetEpisode?.overview || item.description,
          isCancelled: options?.isCancelled,
          startTime,
          title: `${item.title} S${reopenSeason}E${reopenEpisode}`,
        },
      );
    },
    [handleWatchMovie, item, openEpisodeStreamSelector, preferredStreamId],
  );

  const handleWatchEpisode = (ep: Episode) => {
    if (!item) return;

    void getLatestEpisodeResumeStartTime(item.id, item.type, ep.season, ep.episode).then(
      (startTime) => {
        void openEpisodeStreamSelector(ep, {
          overview: ep.overview || item.description,
          startTime,
        });
      },
    );
  };

  useEffect(() => {
    if (
      reopenSelectorConsumed ||
      !item ||
      !preferredStreamId ||
      streamParams ||
      streamSelectorOpen
    ) {
      return;
    }

    const navState = location.state as DetailsHistoryRouteState | undefined;

    if (!navState?.reopenStreamSelector) return;
    let cancelled = false;

    void (async () => {
      const opened = await openDetailsReopenSelector(navState, {
        isCancelled: () => cancelled,
      });

      if (!cancelled && opened) {
        setReopenSelectorConsumed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    item,
    location.state,
    openDetailsReopenSelector,
    preferredStreamId,
    reopenSelectorConsumed,
    streamParams,
    streamSelectorOpen,
  ]);

  const effectiveStreamParams = streamParams;
  const effectiveStreamSelectorOpen = streamSelectorOpen;

  const progress = useMemo(() => {
    if (!watchHistory || !item) return null;
    if (item.type === 'movie') {
      return watchHistory.find((w) => w.id === item.id && w.type_ === 'movie') ?? null;
    }
    return null;
  }, [watchHistory, item]);

  const seriesProgress = useMemo(() => {
    if (!item || item.type !== 'series') return null;

    const continueWatchingEntry = continueWatching?.find(
      (entry) => entry.id === item.id && isSeriesLikeHistoryEntryType(entry.type_),
    );
    if (continueWatchingEntry) {
      return continueWatchingEntry;
    }

    return (
      watchHistory?.find(
        (entry) => entry.id === item.id && isSeriesLikeHistoryEntryType(entry.type_),
      ) ?? null
    );
  }, [continueWatching, watchHistory, item]);

  const getResumeInfo = useCallback((entry: WatchProgress | null) => {
    const startTime = getPlayableResumeStartTime(entry);
    if (!startTime) {
      return { canResume: false, startTime: undefined as number | undefined };
    }
    return { canResume: true, startTime };
  }, []);

  const movieResume = getResumeInfo(progress);
  const seriesResume = getResumeInfo(seriesProgress);
  const resumeEpisodeCoords = useMemo(() => {
    if (!seriesProgress || !seriesResume.canResume) return null;
    if (seriesProgress.season === undefined || seriesProgress.episode === undefined) return null;
    return { season: seriesProgress.season, episode: seriesProgress.episode };
  }, [seriesProgress, seriesResume.canResume]);
  const canResumeInSelectedSeason =
    item?.type === 'series' &&
    !!seriesProgress &&
    seriesResume.canResume &&
    seriesProgress.season !== undefined &&
    (selectedSeason === null || seriesProgress.season === selectedSeason);
  const primaryPlaybackHistoryEntry =
    item?.type === 'movie'
      ? progress && movieResume.canResume
        ? progress
        : null
      : seriesProgress && canResumeInSelectedSeason
        ? seriesProgress
        : null;

  const scrollToEpisodes = useCallback(() => {
    document.getElementById('episodes-section')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handlePrimaryHistoryDetailsPlan = useCallback(
    (plan: { state: unknown; reason?: string }) => {
      if (plan.reason !== 'missing-saved-stream') {
        return false;
      }

      return openDetailsReopenSelector(plan.state as DetailsHistoryRouteState);
    },
    [openDetailsReopenSelector],
  );

  const primaryPlayback = useMediaPrimaryPlayback({
    from: `${location.pathname}${location.search}`,
    historyEntry: primaryPlaybackHistoryEntry,
    item,
    onHandleHistoryDetailsPlan: handlePrimaryHistoryDetailsPlan,
    onPlayMovieWithoutHistory:
      item?.type === 'movie'
        ? async () => {
            handleWatchMovie();
          }
        : undefined,
    onSelectEpisode:
      item?.type === 'series'
        ? async () => {
            scrollToEpisodes();
          }
        : undefined,
    surface: 'details',
  });

  const handleRetryDetails = () => {
    if (!effectiveRouteType || !effectiveRouteId) return;
    queryClient.invalidateQueries({ queryKey: ['details', effectiveRouteType, effectiveRouteId] });
  };

  const handleOpenTrailer = useCallback(async () => {
    const primaryTrailerUrl = item?.trailers?.[0]?.url?.trim();
    if (!primaryTrailerUrl) return;

    const embedUrl = resolveTrailerEmbedUrl(primaryTrailerUrl, { autoplay: true });
    if (embedUrl) {
      setTrailerUrl(embedUrl);
      setTrailerOpen(true);
      return;
    }

    try {
      await openExternal(primaryTrailerUrl);
    } catch (error) {
      toast.error('Failed to open trailer', {
        description: getErrorMessage(error),
      });
    }
  }, [item]);

  useEffect(() => {
    if (!resumeEpisodeCoords) return;
    if (selectedSeason !== resumeEpisodeCoords.season) return;
    if (!visibleEpisodes.some((ep) => ep.episode === resumeEpisodeCoords.episode)) return;

    const timer = window.setTimeout(() => {
      resumeEpisodeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [visibleEpisodes, resumeEpisodeCoords, selectedSeason]);

  if (isLoading) return <DetailsSkeleton />;

  if (error) {
    return (
      <div className='min-h-screen bg-background flex flex-col items-center justify-center text-destructive gap-4'>
        <p className='text-xl font-bold'>Error loading details</p>
        <Button variant='outline' onClick={handleRetryDetails}>
          Retry
        </Button>
      </div>
    );
  }

  if (!item) return null;

  const backdropUrl = item.backdrop || item.poster;

  return (
    <div className='relative pb-20'>
      {/* Hero Section - Immersive */}
      <div className='relative min-h-[70vh] flex items-end pt-32 pb-24 w-full -mt-8'>
        {/* Backdrop */}
        {backdropUrl && (
          <motion.div
            initial={{ scale: 1.02, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className='absolute inset-0 z-0'
          >
            <div className='absolute inset-0 bg-black/30 z-10' />
            <div className='absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent z-10' />
            <div className='absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-background via-background/90 to-transparent z-10' />
            <div className='absolute inset-0 bg-gradient-to-r from-background via-background/60 to-transparent z-10' />
            <img
              src={backdropUrl}
              alt='Backdrop'
              className='w-full h-full object-cover'
              loading='eager'
              decoding='async'
              style={{ objectPosition: 'center 20%' }}
            />
          </motion.div>
        )}

        {/* Content */}
        <div className='relative z-20 container md:pl-24 lg:pl-28 flex flex-col'>
          <div className='flex flex-col gap-6 w-full max-w-4xl'>
            {/* Info */}
            <div className='space-y-6 w-full'>
              <motion.div
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.1, duration: 0.4 }}
              >
                {item.logo ? (
                  <img
                    src={item.logo}
                    alt={item.title}
                    className='h-24 md:h-32 object-contain origin-left mb-6 drop-shadow-2xl'
                  />
                ) : (
                  <h1 className='text-5xl md:text-7xl lg:text-8xl font-serif font-bold tracking-tight text-white mb-6 leading-[1.1] drop-shadow-2xl'>
                    {item.title}
                  </h1>
                )}

                {/* Metadata Row */}
                <div className='flex flex-wrap items-center gap-4 text-sm font-medium text-white/90'>
                  <span>{item.displayYear ?? 'Unknown'}</span>

                  {item.type === 'series' && (
                    <span>
                      {hasEpisodesTab && seasonCount > 0 ? `${seasonCount} Seasons` : 'TV Series'}
                    </span>
                  )}
                  {item.type === 'movie' && <span>Movie</span>}

                  {item.genres && item.genres.length > 0 && (
                    <div className='px-3 py-1 rounded-full border border-white/20 bg-white/5 backdrop-blur-md text-xs tracking-wide'>
                      {item.genres[0]}
                    </div>
                  )}

                  {item.rating && (
                    <div className='flex items-center gap-1.5'>
                      <div className='flex text-amber-500'>
                        {[1, 2, 3, 4, 5].map((starNumber) => (
                          <Star
                            key={`rating-star-${starNumber}`}
                            className={cn(
                              'w-4 h-4 fill-current',
                              starNumber > Math.round(Number(item.rating) / 2) && 'opacity-30',
                            )}
                          />
                        ))}
                      </div>
                      <span className='ml-1 font-semibold'>{item.rating}</span>
                    </div>
                  )}
                </div>
              </motion.div>

              <motion.p
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.15, duration: 0.4 }}
                className='text-base md:text-[17px] text-white/70 max-w-2xl leading-relaxed line-clamp-3 md:line-clamp-4 font-normal drop-shadow-md'
              >
                {item.description}
              </motion.p>

              <motion.div
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.4 }}
                className='flex flex-wrap items-center gap-4 pt-4'
              >
                <button
                  type='button'
                  className='flex items-center gap-3 group'
                  onClick={() => {
                    void primaryPlayback.handlePrimaryAction();
                  }}
                >
                  <div className='h-11 md:h-12 px-6 md:px-7 rounded-lg bg-gradient-to-b from-zinc-200 to-zinc-300 text-black flex items-center justify-center gap-2.5 group-hover:from-white group-hover:to-zinc-200 group-active:scale-[0.97] transition-all duration-200 shadow-md'>
                    <Play className='w-4.5 h-4.5 fill-current' />
                    <span className='text-sm font-semibold tracking-tight'>
                      {primaryPlayback.primaryActionLabel}
                    </span>
                  </div>
                </button>

                <div className='flex gap-2.5 ml-1'>
                  <button
                    type='button'
                    className={cn(
                      'w-11 h-11 md:h-12 md:w-12 rounded-lg border border-white/[0.12] bg-white/[0.06] flex items-center justify-center text-white/70 hover:bg-white/[0.1] hover:text-white hover:border-white/[0.2] transition-all duration-200 backdrop-blur-sm',
                      isInLibrary &&
                        'border-green-500/30 text-green-400 bg-green-500/[0.06] hover:bg-green-500/[0.12]',
                    )}
                    onClick={() => toggleLibrary.mutate()}
                  >
                    {toggleLibrary.isPending ? (
                      <Loader2 className='w-5 h-5 animate-spin' />
                    ) : isInLibrary ? (
                      <Check className='w-5 h-5' />
                    ) : (
                      <Plus className='w-6 h-6' />
                    )}
                  </button>

                  {item.trailers && item.trailers.length > 0 && (
                    <button
                      type='button'
                      className='w-11 h-11 md:h-12 md:w-12 rounded-lg border border-white/[0.12] bg-white/[0.06] flex items-center justify-center text-white/70 hover:bg-white/[0.1] hover:text-white hover:border-white/[0.2] transition-all duration-200 backdrop-blur-sm hover:text-red-400 hover:border-red-500/25 hover:bg-red-500/[0.06]'
                      onClick={() => {
                        void handleOpenTrailer();
                      }}
                    >
                      <Youtube className='w-5 h-5' />
                    </button>
                  )}
                </div>
              </motion.div>

              {/* Cast Section */}
              {item.cast && item.cast.length > 0 && (
                <motion.div
                  initial={{ y: 12, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.25, duration: 0.4 }}
                  className='pt-6 max-w-3xl'
                >
                  <div className='flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] md:text-[14px]'>
                    <span className='font-semibold text-white/50 mr-1'>Starring:</span>
                    {item.cast.slice(0, 5).map((actor, i, cast) => (
                      <span key={actor} className='flex items-center'>
                        <span className='text-zinc-300 hover:text-white transition-colors cursor-default'>
                          {actor}
                        </span>
                        {i < cast.length - 1 && <span className='text-white/20 mx-2'>,</span>}
                      </span>
                    ))}
                    {item.cast.length > 5 && (
                      <span className='text-zinc-500 italic ml-1'>and more</span>
                    )}
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs Section */}
      {(hasEpisodesTab || hasRelationsTab || hasAnimeMetadataTab) && (
        <div id='episodes-section' className='container md:pl-24 lg:pl-28 py-8'>
          <Tabs
            value={resolvedActiveTab}
            onValueChange={(value) => setActiveTab(value as DetailsTab)}
            className='w-full space-y-6'
          >
            <div className='flex flex-col gap-4 border-b border-white/5 pb-0'>
              <TabsList className='bg-transparent p-0 gap-8 h-auto justify-start'>
                {hasEpisodesTab && (
                  <TabsTrigger
                    value='episodes'
                    className='rounded-none border-b-2 border-transparent data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-white text-zinc-500 text-lg px-2 pb-3 font-semibold transition-all hover:text-zinc-300'
                  >
                    Episodes
                  </TabsTrigger>
                )}
                {hasRelationsTab && (
                  <TabsTrigger
                    value='relations'
                    className='rounded-none border-b-2 border-transparent data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-white text-zinc-500 text-lg px-2 pb-3 font-semibold transition-all hover:text-zinc-300'
                  >
                    Relations
                  </TabsTrigger>
                )}
                {hasAnimeMetadataTab && (
                  <TabsTrigger
                    value='anime-metadata'
                    className='rounded-none border-b-2 border-transparent data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-white text-zinc-500 text-lg px-2 pb-3 font-semibold transition-all hover:text-zinc-300'
                  >
                    Cast & Info
                  </TabsTrigger>
                )}
              </TabsList>
            </div>

            <TabsContent
              value='episodes'
              className='mt-0 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col gap-6'
            >
              {/* Season Selector */}
              {hasEpisodesTab && localSeasonEntries.length > 1 && (
                <div className='w-full'>
                  <SeasonSwitcher
                    localSeasons={localSeasonEntries}
                    activeSeason={selectedSeason ?? null}
                    onLocalSeason={(seasonNumber) => {
                      if (scopedInlineTarget) {
                        setInlineTarget(null);
                        resetEpisodePane(seasonNumber);
                        setActiveTab('episodes');
                        return;
                      }

                      selectSeason(seasonNumber);
                    }}
                  />
                </div>
              )}
              {item.type === 'series' &&
              (hasEpisodesForSelectedSeason || shouldShowEpisodeProgressSkeleton) ? (
                <>
                  {/* Episode search bar */}
                  {shouldShowEpisodeSearch && (
                    <div className='mb-4 relative'>
                      <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none z-10' />
                      <Input
                        placeholder='Search episodes…'
                        value={episodeSearch}
                        onChange={(e) => setEpisodeSearch(e.target.value)}
                        className='h-9 pl-9 pr-9 bg-white/[0.03] border-white/[0.08] text-sm text-white placeholder:text-zinc-600 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-md'
                      />
                      {episodeSearch && (
                        <button
                          type='button'
                          onClick={clearEpisodeSearch}
                          className='absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors'
                        >
                          <X className='h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>
                  )}
                  <div className='flex items-center justify-between gap-4'>
                    <div>
                      <p className='text-[12px] font-semibold tabular-nums text-zinc-400'>
                        {episodeRangeLabel}
                        {visibleEpisodeStart > 0 && (
                          <span className='text-zinc-600 font-medium'>
                            {` of ${totalEpisodeCount}`}
                          </span>
                        )}
                      </p>
                    </div>

                    {totalEpisodePages > 1 && (
                      <div className='flex items-center gap-2'>
                        <button
                          type='button'
                          onClick={() => changeEpisodePage('previous')}
                          disabled={!hasPreviousEpisodes}
                          className='flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-35'
                          aria-label='Show previous episodes'
                        >
                          <ChevronLeft className='h-3.5 w-3.5' />
                        </button>
                        <div className='min-w-[80px] text-center text-[11px] text-zinc-500 tabular-nums'>
                          {activeEpisodePageIndex + 1} / {totalEpisodePages}
                        </div>
                        <button
                          type='button'
                          onClick={() => changeEpisodePage('next')}
                          disabled={!hasMoreEpisodes}
                          className='flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-35'
                          aria-label='Show next episodes'
                        >
                          <ChevronRight className='h-3.5 w-3.5' />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className='grid grid-cols-1 gap-4 pb-2 sm:grid-cols-2 2xl:grid-cols-4'>
                    {shouldShowEpisodeProgressSkeleton ? (
                      EPISODE_SKELETON_KEYS.map((key) => (
                        <div
                          key={key}
                          className='aspect-video w-full rounded-xl bg-zinc-900/60 animate-pulse'
                        />
                      ))
                    ) : visibleEpisodes.length === 0 && episodeSearch.trim() ? (
                      <p className='col-span-full py-14 text-center text-sm text-zinc-600'>
                        No episodes match &ldquo;
                        <span className='text-zinc-400'>{episodeSearch}</span>&rdquo;
                      </p>
                    ) : (
                      visibleEpisodes.map((ep) => {
                        const epProgress = episodeProgressMap.get(
                          `${item.id}:${ep.season}:${ep.episode}`,
                        );
                        const progressRaw =
                          epProgress && epProgress.duration > 0
                            ? (epProgress.position / epProgress.duration) * 100
                            : 0;
                        const progressPercent = Math.min(100, Math.max(0, progressRaw));
                        const isResumeEp = !!(
                          seriesProgress &&
                          seriesProgress.season === ep.season &&
                          seriesProgress.episode === ep.episode &&
                          seriesResume.canResume
                        );
                        const isSpoiler = isEpisodeSpoiler(ep);

                        return (
                          <button
                            type='button'
                            key={ep.id}
                            ref={
                              isResumeEp
                                ? (el) => {
                                    resumeEpisodeRef.current = el;
                                  }
                                : undefined
                            }
                            className={cn(
                              'relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-900 text-left group block',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
                              isResumeEp && 'ring-2 ring-indigo-500',
                            )}
                            onClick={() => handleWatchEpisode(ep)}
                          >
                            {/* Thumbnail */}
                            {ep.thumbnail ? (
                              <img
                                src={ep.thumbnail}
                                alt={`Ep ${ep.episode}`}
                                className={cn(
                                  'absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105',
                                  isSpoiler && 'blur-md scale-110',
                                )}
                                loading='lazy'
                                decoding='async'
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                  const placeholder = e.currentTarget
                                    .nextElementSibling as HTMLElement | null;
                                  if (placeholder) placeholder.style.display = 'flex';
                                }}
                              />
                            ) : null}

                            {/* Placeholder fallback */}
                            <div
                              className='absolute inset-0 bg-zinc-900 items-center justify-center text-white/20 font-bold text-2xl'
                              style={{ display: ep.thumbnail ? 'none' : 'flex' }}
                            >
                              EP {ep.episode}
                            </div>

                            {/* Gradients */}
                            <div className='absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent pointer-events-none' />

                            {/* Hover Play Icon centered */}
                            <div className='absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none z-10'>
                              <div className='w-12 h-12 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 flex items-center justify-center shadow-2xl'>
                                <Play className='w-5 h-5 fill-white ml-0.5' />
                              </div>
                            </div>

                            {/* Title Bottom Left */}
                            <div className='absolute bottom-4 left-3 right-3 z-10 pointer-events-none'>
                              <h4 className='text-white font-semibold text-[15px] leading-tight drop-shadow-md line-clamp-2'>
                                {isSpoiler
                                  ? `Episode ${ep.episode}`
                                  : ep.title || `Episode ${ep.episode}`}
                              </h4>
                            </div>

                            {/* Progress Bar */}
                            {epProgress && progressPercent > 0 && (
                              <div className='absolute bottom-0 left-0 right-0 h-1 bg-white/20 z-20 pointer-events-none'>
                                <div
                                  className='h-full bg-indigo-500'
                                  style={{ width: `${progressPercent}%` }}
                                />
                              </div>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <div className='text-center py-24 text-zinc-600'>
                  {item.type === 'movie'
                    ? "Movies typically don't have episodes."
                    : 'No episodes found for this season.'}
                </div>
              )}
            </TabsContent>

            <TabsContent
              value='relations'
              className='mt-0 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-4 duration-500'
            >
              <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'>
                {relatedItems.map((rel, i) => (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.05 }}
                    key={rel.id}
                    onMouseEnter={() => {
                      const relationType = rel.id.startsWith('kitsu:') ? 'anime' : rel.type;
                      prefetchInlineDetailsTarget(
                        relationType,
                        rel.id,
                        rel.relationPreferredSeason,
                      );
                    }}
                  >
                    <div className='space-y-2'>
                      <MediaCard
                        item={rel}
                        subtitle={rel.relationContextLabel ?? undefined}
                        onPlay={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const relationType = rel.id.startsWith('kitsu:') ? 'anime' : rel.type;
                          handleInlineDetailsSwitch(
                            relationType,
                            rel.id,
                            rel.relationPreferredSeason,
                          );
                        }}
                      />
                      {(formatRelationRoleLabel(rel.relationRole) || rel.relationContextLabel) && (
                        <div className='flex items-center gap-1.5 pt-1.5'>
                          {formatRelationRoleLabel(rel.relationRole) && (
                            <span
                              className={cn(
                                'rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] leading-none whitespace-nowrap',
                                getRelationRoleBadgeClass(rel.relationRole),
                              )}
                            >
                              {formatRelationRoleLabel(rel.relationRole)}
                            </span>
                          )}
                          {rel.relationContextLabel && (
                            <span className='text-[10px] text-zinc-500 leading-none whitespace-nowrap'>
                              {rel.relationContextLabel}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
            </TabsContent>

            <TabsContent
              value='anime-metadata'
              className='mt-0 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-4 duration-500'
            >
              {item.id.startsWith('kitsu:') && (
                <AnimeMetadataSection mediaId={item.id} enabled={activeTab === 'anime-metadata'} />
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <StreamSelector
        open={effectiveStreamSelectorOpen}
        onClose={() => {
          setStreamSelectorOpen(false);
          setStreamParams(null);
          setReopenSelectorConsumed(true);
        }}
        type={streamSelectorType}
        id={effectiveStreamParams?.id || ''}
        streamId={effectiveStreamParams?.streamId || effectiveStreamParams?.id || ''}
        season={effectiveStreamParams?.season}
        episode={effectiveStreamParams?.episode}
        absoluteSeason={effectiveStreamParams?.absoluteSeason}
        absoluteEpisode={effectiveStreamParams?.absoluteEpisode}
        aniskipEpisode={effectiveStreamParams?.aniskipEpisode}
        startTime={effectiveStreamParams?.startTime}
        title={effectiveStreamParams?.title || ''}
        overview={effectiveStreamParams?.overview}
        imdbId={item?.imdbId}
        poster={item.poster}
        backdrop={item.backdrop}
        logo={item.logo}
        from={`${location.pathname}${location.search}`}
      />

      <Dialog
        open={trailerOpen}
        onOpenChange={(open) => {
          setTrailerOpen(open);
          if (!open) {
            setTrailerUrl(null);
          }
        }}
      >
        <DialogContent className='max-w-5xl p-0 overflow-hidden bg-black border-zinc-800'>
          {trailerUrl && (
            <div className='aspect-video w-full'>
              <iframe
                width='100%'
                height='100%'
                src={trailerUrl}
                title='Trailer'
                frameBorder='0'
                allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
                referrerPolicy='strict-origin-when-cross-origin'
                allowFullScreen
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className='min-h-screen bg-background'>
      {/* Mimics the hero backdrop area with a subtle shimmer instead of a solid block */}
      <div className='relative h-[70vh] w-full -mt-8 overflow-hidden'>
        <div className='absolute inset-0 bg-zinc-950' />
        <div className='absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent' />
        <div className='absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-background to-transparent' />
      </div>

      <div className='container md:pl-24 lg:pl-28 -mt-56 relative z-10'>
        <div className='flex flex-col gap-6 w-full max-w-4xl animate-pulse'>
          <Skeleton className='h-10 w-72 bg-zinc-800/60' />
          <div className='flex gap-3'>
            <Skeleton className='h-5 w-14 bg-zinc-800/50' />
            <Skeleton className='h-5 w-20 bg-zinc-800/50' />
            <Skeleton className='h-5 w-16 bg-zinc-800/50' />
          </div>
          <div className='space-y-2.5'>
            <Skeleton className='h-4 w-full max-w-lg bg-zinc-800/40' />
            <Skeleton className='h-4 w-4/5 max-w-md bg-zinc-800/40' />
          </div>
          <div className='flex gap-3 pt-3'>
            <Skeleton className='h-12 w-36 rounded-lg bg-zinc-800/50' />
            <Skeleton className='h-12 w-12 rounded-lg bg-zinc-800/40' />
          </div>
        </div>
      </div>
    </div>
  );
}
