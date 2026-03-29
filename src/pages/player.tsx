import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Loader2,
  Play,
  Pause,
  X,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Volume1,
  Download,
  Rewind,
  FastForward,
  StepForward,
  ArrowLeftRight,
} from 'lucide-react';
import { api, type Episode, type SkipSegment } from '@/lib/api';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StreamSelector } from '@/components/stream-selector';
import {
  init,
  command,
  setProperty,
  observeProperties,
  MpvConfig,
  MpvObservableProperty,
  destroy,
} from 'tauri-plugin-libmpv-api';
import { cn } from '@/lib/utils';
import { Sidebar } from '@/components/sidebar';
import { DownloadModal } from '@/components/download-modal';
import {
  PlayerEpisodesPanel,
  PlayerEpisodesToggleButton,
} from '@/components/player-episodes-panel';
import { PlayerProgressBar } from '@/components/player-progress-bar';
import {
  type Track,
  normalizeTrackList,
  doesTrackSelectionMatch,
} from '@/lib/player-track-utils';
import { useStreamRecovery } from '@/hooks/use-stream-recovery';
import { usePlayerViewportMode } from '@/hooks/use-player-viewport-mode';
import { PlayerPlaybackSettings } from '@/components/player-playback-settings';
import { PlayerOsdOverlay, type PlayerOsdAction } from '@/components/player-osd-overlay';
import { PlayerSlider } from '@/components/player-slider';
import { PlayerActionOverlays } from '@/components/player-action-overlays';
import { usePlaybackProgressPersistence } from '@/hooks/use-playback-progress-persistence';
import { usePlaybackStreamHealth } from '@/hooks/use-playback-stream-health';
import { usePlayerTrackPreferences } from '@/hooks/use-player-track-preferences';
import { usePlayerResumeController } from '@/hooks/use-player-resume-controller';
import { usePlayerStreamSession } from '@/hooks/use-player-stream-session';
import { usePlayerRouteState } from '@/hooks/use-player-route-state';
import {
  usePlayerUpNext,
  type NextEpisodeStreamCoordinates,
} from '@/hooks/use-player-up-next';
import {
  buildEpisodeStreamTargetLookupKey,
  buildFallbackEpisodeStreamTarget,
  resolveEpisodeStreamTarget,
} from '@/lib/episode-stream-target';
import { buildPlayerRoute } from '@/lib/player-navigation';
import { resolveRankedBestStream } from '@/lib/stream-resolution';

// --- Types & Constants ---

const formatTime = (seconds: number) => {
  if (!seconds || isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

/** Maps a segment type to a user-visible "Skip" action label. */
function getSkipLabel(type: string): string {
  switch (type) {
    case 'op':
    case 'mixed-op':
    case 'intro':
      return 'Skip Intro';
    case 'ed':
    case 'mixed-ed':
    case 'outro':
      return 'Skip Outro';
    case 'recap':
      return 'Skip Recap';
    default:
      return 'Skip';
  }
}

interface PlayerLoadingCopy {
  headline: string;
  detail: string;
}

const OBSERVED_PROPERTIES = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['percent-pos', 'double', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['eof-reached', 'flag'],
  ['idle-active', 'flag'],
  ['speed', 'double'],
  ['core-idle', 'flag'],
  ['track-list', 'node'],
] as const satisfies MpvObservableProperty[];

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const TIME_UPDATE_THROTTLE_MS = 350;
const OPTIMISTIC_SEEK_HOLD_MS = 450;
const OPTIMISTIC_SEEK_SETTLED_DELTA_SECS = 1.1;
const TRACK_SWITCH_VERIFY_ATTEMPTS = 8;
const TRACK_SWITCH_VERIFY_DELAY_MS = 150;

// --- Component ---

export function Player() {
  const { season, episode } = useParams();
  // Force full remount on episode change to ensure clean state
  return <InnerPlayer key={`${season}:${episode}`} />;
}

function InnerPlayer() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const isNavigatingAwayRef = useRef(false);

  const {
    backdrop,
    effectiveResolveMediaType,
    episodeParam: episode,
    from,
    id,
    isHistoryResume,
    logo,
    openingStreamName,
    openingStreamSource,
    poster,
    preparedBackupStream,
    routeAbsoluteEpisode,
    routeAbsoluteSeason,
    routeAniSkipEpisode,
    routeEpisode,
    routeFormat,
    routeMarkedOffline,
    routeSeason,
    routeSelectedStreamKey,
    routeSourceName,
    routeStreamEpisode,
    routeStreamFamily,
    routeStreamLookupId,
    routeStreamSeason,
    routeStreamUrl,
    seasonParam: season,
    shouldBypassResolveCache,
    startTime,
    title,
    type,
  } = usePlayerRouteState();

  // -- State --
  const {
    activeStreamUrl,
    setActiveStreamUrl,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
    lastStreamUrlRef,
    isOffline,
  } = usePlayerStreamSession({
    routeStreamUrl,
    routeFormat,
    routeSourceName,
    routeStreamFamily,
    routeSelectedStreamKey,
    streamLookupId: routeStreamLookupId || id || undefined,
    mediaId: id,
    routeMarkedOffline,
  });

  useEffect(() => {
    setHasPlaybackStarted(false);
    setSeekPreviewTime(null);
  }, [activeStreamUrl]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('player:volume');
    return saved !== null ? Math.max(0, Math.min(100, parseInt(saved, 10))) : 75;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasPlaybackStarted, setHasPlaybackStarted] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveStatus, setResolveStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    const saved = localStorage.getItem('player:speed');
    return saved !== null ? parseFloat(saved) : 1.0;
  });
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [subtitlePos, setSubtitlePos] = useState(100);
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [subTracks, setSubTracks] = useState<Track[]>([]);
  const [trackSwitching, setTrackSwitching] = useState<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number>(() => {
    return routeAbsoluteSeason ?? 1;
  });
  const [isHoveringVolume, setIsHoveringVolume] = useState(false);
  const [subtitleScale, setSubtitleScale] = useState(1.0);

  // Stream Selector State
  const [showStreamSelector, setShowStreamSelector] = useState(false);
  const [selectedEpisodeForStream, setSelectedEpisodeForStream] = useState<Episode | null>(null);
  const [selectedEpisodeStreamTarget, setSelectedEpisodeStreamTarget] =
    useState<NextEpisodeStreamCoordinates | null>(null);

  const [showDownloadModal, setShowDownloadModal] = useState(false);

  // OSD (on-screen display) for keyboard/mouse action feedback
  const [osdAction, setOsdAction] = useState<PlayerOsdAction | null>(null);
  const [osdVisible, setOsdVisible] = useState(false);

  // Remaining time mode: click the clock to toggle between elapsed and remaining
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const watchHistoryInvalidatedRef = useRef(false);

  const restoreCursorVisibility = useCallback(() => {
    if (playerContainerRef.current) playerContainerRef.current.style.cursor = '';
    document.body.style.cursor = '';
    document.documentElement.style.cursor = '';
  }, []);

  const restoreBackgroundPresentation = useCallback(() => {
    document.body.style.backgroundColor = '';
    document.documentElement.style.backgroundColor = '';
    const root = document.getElementById('root');
    if (root) root.style.backgroundColor = '';
  }, []);

  const restorePlayerSurface = useCallback(() => {
    restoreCursorVisibility();
    restoreBackgroundPresentation();
  }, [restoreBackgroundPresentation, restoreCursorVisibility]);

  const {
    beginPlayerExit,
    cleanupViewportOnUnmount,
    isFullscreen,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  } = usePlayerViewportMode({
    onBeforeEnterFullscreen: () => {
      setShowEpisodes(false);
    },
  });

  const invalidateWatchHistoryOnce = useCallback(() => {
    if (watchHistoryInvalidatedRef.current) return;
    watchHistoryInvalidatedRef.current = true;
    void queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
    void queryClient.invalidateQueries({ queryKey: ['watch-history'] });
  }, [queryClient]);

  const flushPlaybackBeforeNavigation = useCallback(async () => {
    try {
      await saveProgressRef.current?.();
    } finally {
      if (!watchHistoryInvalidatedRef.current) {
        watchHistoryInvalidatedRef.current = true;
        void queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
        void queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      }
    }
  }, [queryClient]);

  // Intelligent back navigation: replace the player in history so pressing back
  // from the destination page never re-launches the player.
  const navigateBack = useCallback(async () => {
    if (isNavigatingAwayRef.current) return;
    isNavigatingAwayRef.current = true;

    setShowControls(true);
    setShowEpisodes(false);
    restorePlayerSurface();
    await flushPlaybackBeforeNavigation();
    await beginPlayerExit();

    const backSeason = selectedEpisodeForStream?.season ?? routeAbsoluteSeason;
    const backEpisode = selectedEpisodeForStream?.episode ?? routeAbsoluteEpisode;
    const reopenSelectorState = {
      reopenStreamSelector: true,
      reopenStreamSeason: backSeason,
      reopenStreamEpisode: backEpisode,
      reopenStartTime: currentTimeRef.current > 5 ? currentTimeRef.current : undefined,
    };

    // If we have a valid non-player origin, go there (replacing player in stack)
    if (from && !from.startsWith('/player')) {
      if (from.startsWith('/details/')) {
        navigate(from, { replace: true, state: reopenSelectorState });
      } else {
        navigate(from, { replace: true });
      }
    } else {
      // Otherwise go to the details page (replacing player in stack)
      navigate(`/details/${effectiveResolveMediaType}/${id}`, {
        replace: true,
        state: reopenSelectorState,
      });
    }
  }, [
    navigate,
    selectedEpisodeForStream?.season,
    selectedEpisodeForStream?.episode,
    routeAbsoluteSeason,
    routeAbsoluteEpisode,
    beginPlayerExit,
    from,
    flushPlaybackBeforeNavigation,
    effectiveResolveMediaType,
    id,
    restorePlayerSurface,
  ]);

  // -- Refs --
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const forceShowTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTimeUpdateRef = useRef(0);
  const pendingSeekDeadlineRef = useRef(0);
  const pendingSeekTargetRef = useRef<number | null>(null);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const isDestroyedRef = useRef(false);
  const mountedRef = useRef(true);
  const mpvInitializedRef = useRef(false);
  const volumeRef = useRef(volume);
  const isLoadingRef = useRef(true);
  // Stable refs for callbacks used in the MPV init effect — avoids restarting MPV
  // when async data (details, nextEpisode) changes these callback identities.
  const saveProgressRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const handleEndedRef = useRef<(() => void) | undefined>(undefined);
  const lastAutoResolveLookupIdRef = useRef<string | null>(null);
  const errorRef = useRef<string | null>(error);
  const osdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const osdClearTimerRef = useRef<NodeJS.Timeout | null>(null);
  const osdAnimationFrameRef = useRef<number | null>(null);
  const selectorOpenRequestIdRef = useRef(0);
  /** Always-current playing state — used in closures to avoid stale captures. */
  const isPlayingRef = useRef(false);
  const isDev = import.meta.env.DEV;
  const trackSwitchingRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const trackListRef = useRef<Track[]>([]);
  const setTrackRef = useRef<
    (
      type: 'audio' | 'sub',
      id: number | 'no',
      options?: { silent?: boolean; persistPreference?: boolean },
    ) => Promise<void> | void
  >(async () => undefined);

  // Component mount state must survive stream swaps so stale-link recovery can
  // tear down MPV and immediately re-enter auto-resolve on the same screen.
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentTimeRef.current = 0;
    durationRef.current = 0;
    pendingSeekTargetRef.current = null;
    pendingSeekDeadlineRef.current = 0;
    lastTimeUpdateRef.current = 0;
    setCurrentTime(0);
    setDuration(0);
  }, [activeStreamUrl]);

  // -- Queries --
  const { data: details, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['media', effectiveResolveMediaType, id],
    queryFn: () => api.getMediaDetails(effectiveResolveMediaType, id!),
    enabled: !!type && !!id && effectiveResolveMediaType !== 'movie' && !isOffline,
    staleTime: 1000 * 60 * 60,
  });

  const currentEpisodeFromRoute = useMemo(() => {
    if (!details?.episodes || routeSeason === undefined || routeEpisode === undefined) return null;
    return (
      details.episodes.find((ep) => ep.season === routeSeason && ep.episode === routeEpisode) ||
      null
    );
  }, [details?.episodes, routeSeason, routeEpisode]);

  const currentEpisodeFromAbsoluteRoute = useMemo(() => {
    if (!details?.episodes?.length) return null;
    if (routeAbsoluteSeason === undefined || routeAbsoluteEpisode === undefined) return null;

    return (
      details.episodes.find(
        (ep) => ep.season === routeAbsoluteSeason && ep.episode === routeAbsoluteEpisode,
      ) || null
    );
  }, [details?.episodes, routeAbsoluteSeason, routeAbsoluteEpisode]);

  // Route season/episode may be stream-query coordinates for anime launches, so all
  // player-side episode UI should prefer an absolute episode match when it exists.
  const sidebarCurrentEpisode = useMemo(() => {
    if (currentEpisodeFromRoute) return currentEpisodeFromRoute;
    if (currentEpisodeFromAbsoluteRoute) return currentEpisodeFromAbsoluteRoute;
    if (!details?.episodes?.length) return null;
    if (routeAbsoluteEpisode === undefined) return null;

    const absoluteMatch = details.episodes.find((ep) => ep.episode === routeAbsoluteEpisode);
    return absoluteMatch || null;
  }, [
    details?.episodes,
    currentEpisodeFromAbsoluteRoute,
    currentEpisodeFromRoute,
    routeAbsoluteEpisode,
  ]);

  const currentEpisodeStream = useMemo(() => {
    if (!sidebarCurrentEpisode || !type || !id) return null;
    const target = buildFallbackEpisodeStreamTarget(
      routeStreamLookupId || details?.imdbId || id,
      sidebarCurrentEpisode,
    );

    return {
      streamLookupId: target.streamId,
      streamSeason: target.season,
      streamEpisode: target.episode,
      absoluteSeason: target.absoluteSeason,
      absoluteEpisode: target.absoluteEpisode,
      aniskipEpisode: target.aniskipEpisode,
      lookupKey: buildEpisodeStreamTargetLookupKey(type, target),
    };
  }, [sidebarCurrentEpisode, type, id, routeStreamLookupId, details?.imdbId]);

  // -- Skip Times --
  // Anime: normalized from explicit anime routes and kitsu-backed series routes.
  const isAnime = effectiveResolveMediaType === 'anime';
  const isSeriesLike =
    effectiveResolveMediaType === 'series' || effectiveResolveMediaType === 'anime';
  const resolvedAbsoluteSeason = sidebarCurrentEpisode?.season ?? routeAbsoluteSeason;
  const resolvedAbsoluteEpisode = sidebarCurrentEpisode?.episode ?? routeAbsoluteEpisode;
  const resolvedStreamSeason =
    routeStreamSeason ?? currentEpisodeStream?.streamSeason ?? routeSeason;
  const resolvedStreamEpisode =
    routeStreamEpisode ?? currentEpisodeStream?.streamEpisode ?? routeEpisode;
  const resolvedAniSkipEpisode =
    routeAniSkipEpisode ?? currentEpisodeStream?.aniskipEpisode ?? routeEpisode;
  //
  // For series/TV: we query IntroDB which keys on IMDb ID.
  //   We can use the raw id if it looks like a tt-identifier OR wait for details to
  //   supply imdbId. Either way, if there's no valid IMDb anchor we skip the fetch
  //   rather than send a malformed request.
  const hasImdbAnchor = !!(details?.imdbId ?? (id?.startsWith('tt') ? id : null));
  const skipTimesEnabled =
    !!type &&
    !!id &&
    !!resolvedAbsoluteEpisode &&
    !isOffline &&
    (isAnime || (effectiveResolveMediaType === 'series' && hasImdbAnchor));

  const skipTimesEpisode = useMemo(() => {
    if (resolvedAbsoluteEpisode === undefined) return undefined;
    if (!isAnime) return resolvedAbsoluteEpisode;
    return resolvedAniSkipEpisode ?? resolvedAbsoluteEpisode;
  }, [resolvedAbsoluteEpisode, isAnime, resolvedAniSkipEpisode]);

  const { data: skipSegments = [] } = useQuery<SkipSegment[]>({
    queryKey: [
      'skip-times',
      effectiveResolveMediaType,
      id,
      details?.imdbId,
      resolvedAbsoluteSeason,
      resolvedAbsoluteEpisode,
      skipTimesEpisode,
    ],
    queryFn: () =>
      api.getSkipTimes(
        effectiveResolveMediaType,
        id!,
        details?.imdbId ?? undefined,
        resolvedAbsoluteSeason,
        skipTimesEpisode,
        // Pass 0 - AniSkip accepts 0 to skip length-based filtering.
        0,
      ),
    enabled: skipTimesEnabled && !!skipTimesEpisode,
    staleTime: 1000 * 60 * 60 * 12, // 12 h - crowdsourced data changes rarely
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  // -- Derived State --
  const seasons = useMemo(() => {
    if (!details?.episodes) return [];
    const s = new Set(details.episodes.map((e) => e.season));
    return Array.from(s).sort((a, b) => a - b);
  }, [details?.episodes]);

  useEffect(() => {
    if (seasons.length === 0) return;
    if (seasons.includes(selectedSeason)) return;

    const fallbackSeason =
      sidebarCurrentEpisode?.season ??
      (resolvedAbsoluteSeason !== undefined && seasons.includes(resolvedAbsoluteSeason)
        ? resolvedAbsoluteSeason
        : seasons[0]);

    const timer = window.setTimeout(() => {
      setSelectedSeason((prev) => (prev === fallbackSeason ? prev : fallbackSeason));
    }, 0);

    return () => window.clearTimeout(timer);
  }, [resolvedAbsoluteSeason, seasons, selectedSeason, sidebarCurrentEpisode?.season]);

  const episodeCountInSeason = useMemo(() => {
    const seasonForCount = sidebarCurrentEpisode?.season ?? resolvedAbsoluteSeason;
    if (seasonForCount === undefined || !details?.episodes) return null;
    return details.episodes.filter((ep) => ep.season === seasonForCount).length;
  }, [details?.episodes, resolvedAbsoluteSeason, sidebarCurrentEpisode?.season]);

  const detailsImdbId = details?.imdbId;
  const preferredStreamLookupId = useMemo(
    () => routeStreamLookupId || currentEpisodeStream?.streamLookupId || detailsImdbId,
    [routeStreamLookupId, currentEpisodeStream?.streamLookupId, detailsImdbId],
  );
  const streamLookupId = preferredStreamLookupId || id;
  const shouldWaitForResolvedLookupId = !!(
    !isOffline &&
    !!type &&
    isSeriesLike &&
    !!id &&
    isLoadingDetails &&
    ((!routeStreamLookupId && !id.startsWith('tt') && !detailsImdbId) ||
      ((resolvedAbsoluteEpisode !== undefined || resolvedAbsoluteSeason !== undefined) &&
        !routeStreamSeason &&
        !routeStreamEpisode &&
        !currentEpisodeStream))
  );

  const playerLoadingCopy = useMemo<PlayerLoadingCopy>(() => {
    if (isResolving) {
      return {
        headline: resolveStatus || 'Finding the best stream',
        detail: shouldWaitForResolvedLookupId
          ? 'Waiting for the correct episode mapping before resolving playback.'
          : 'Checking your enabled sources and ranking the fastest playable option.',
      };
    }

    if (activeStreamUrl) {
      if (isHistoryResume && routeStreamUrl && activeStreamUrl === routeStreamUrl) {
        return {
          headline: startTime && startTime > 5 ? 'Restoring saved stream' : 'Opening saved stream',
          detail: 'Using your last working stream first so Continue Watching feels immediate.',
        };
      }

      if (openingStreamName) {
        return {
          headline: 'Opening selected stream',
          detail: openingStreamSource?.trim() || openingStreamName.trim(),
        };
      }

      return {
        headline: isOffline ? 'Opening local playback' : 'Opening stream',
        detail: isOffline
          ? 'Loading your saved file into the player.'
          : 'Connecting to the selected source and buffering the first frames.',
      };
    }

    if (shouldWaitForResolvedLookupId) {
      return {
        headline: 'Matching the right episode',
        detail: 'Finalizing lookup identity so the player does not resolve the wrong stream.',
      };
    }

    if (isHistoryResume) {
      return {
        headline: 'Restoring Continue Watching',
        detail:
          'No fresh saved link was available, so the player is selecting the best current stream.',
      };
    }

    return {
      headline: 'Preparing playback',
      detail: 'Starting the player and getting the stream ready.',
    };
  }, [
    activeStreamUrl,
    isHistoryResume,
    isOffline,
    isResolving,
    resolveStatus,
    shouldWaitForResolvedLookupId,
    startTime,
    openingStreamName,
    openingStreamSource,
    routeStreamUrl,
  ]);

  /**
   * The skip segment (if any) that the current playback position falls inside.
   * A 1-second lead-in lets the button appear just before the segment starts.
   */
  const activeSkipSegment = useMemo<SkipSegment | null>(() => {
    if (!skipSegments.length || !duration) return null;
    return (
      skipSegments.find((seg) => currentTime >= seg.start_time - 1 && currentTime < seg.end_time) ??
      null
    );
  }, [skipSegments, currentTime, duration]);

  const activeAudioTrack = useMemo(
    () => audioTracks.find((track) => !!track.selected) ?? null,
    [audioTracks],
  );
  const activeSubTrack = useMemo(
    () => subTracks.find((track) => !!track.selected) ?? null,
    [subTracks],
  );
  const subtitlesOff = subTracks.length > 0 && !activeSubTrack;

  const { saveProgress } = usePlaybackProgressPersistence({
    mediaId: id,
    mediaType: type,
    title: title || 'Unknown',
    poster,
    backdrop,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamSeason: resolvedStreamSeason,
    streamEpisode: resolvedStreamEpisode,
    aniskipEpisode: resolvedAniSkipEpisode,
    isPlaying,
    currentTime,
    duration,
    activeStreamUrl,
    currentTimeRef,
    durationRef,
    lastStreamUrlRef,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  });

  const { reportFailure: reportStreamFailure, reportVerified: reportStreamVerified } =
    usePlaybackStreamHealth({
      mediaId: id,
      mediaType: type,
      absoluteSeason: resolvedAbsoluteSeason,
      absoluteEpisode: resolvedAbsoluteEpisode,
      activeStreamUrl,
      activeStreamFormatRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
    });

  const {
    dismissUpNext,
    getFreshPrefetchedPlan,
    nextPlaybackPlan,
    showUpNext,
    startUpNextCountdown,
    upNextCountdown,
  } = usePlayerUpNext({
    mediaType: effectiveResolveMediaType,
    mediaId: id,
    currentSeason: resolvedAbsoluteSeason,
    currentEpisode: resolvedAbsoluteEpisode,
    currentStreamLookupId: streamLookupId,
    currentTime,
    duration,
    hasPlaybackStarted,
  });

  const nextEpisode = useMemo(() => {
    if (!nextPlaybackPlan) return null;
    return {
      title: nextPlaybackPlan.canonical.title,
      episode: nextPlaybackPlan.canonical.episode,
    };
  }, [nextPlaybackPlan]);

  const nextEpisodeLabel = useMemo(() => {
    if (!nextPlaybackPlan) return '';
    const trimmedTitle = nextPlaybackPlan.canonical.title?.trim();
    if (trimmedTitle) return trimmedTitle;
    return `Episode ${nextPlaybackPlan.canonical.episode}`;
  }, [nextPlaybackPlan]);

  // -- Helpers --

  const setTransparent = useCallback((transparent: boolean) => {
    const val = transparent ? 'transparent' : 'black';
    document.body.style.backgroundColor = val;
    document.documentElement.style.backgroundColor = val;
    const root = document.getElementById('root');
    if (root) root.style.backgroundColor = val;
  }, []);

  const beginLoading = useCallback(() => {
    setIsLoading(true);
    isLoadingRef.current = true;
    setHasPlaybackStarted(false);
  }, []);

  const stopLoading = useCallback(
    (makeTransparent = false) => {
      setIsLoading(false);
      isLoadingRef.current = false;
      if (makeTransparent) {
        setTransparent(true);
      }
    },
    [setTransparent],
  );

  const {
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
    recoverFromStaleSavedStream,
  } = useStreamRecovery({
    activeStreamUrl,
    initialStreamUrl: routeStreamUrl,
    preparedBackupStream,
    isHistoryResume,
    isOffline,
    mediaType: effectiveResolveMediaType,
    mediaId: id,
    resolveSeason: resolvedStreamSeason,
    resolveEpisode: resolvedStreamEpisode,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamLookupId,
    currentTimeRef,
    durationRef,
    mountedRef,
    lastStreamUrlRef,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    errorRef,
    beginLoading,
    stopLoading,
    setError,
    setIsResolving,
    setResolveStatus,
    setActiveStreamUrl,
    reportStreamFailure,
  });

  const markPlaybackReady = useCallback(() => {
    markPlaybackStarted();
    stopLoading(true);
    setHasPlaybackStarted(true);
    setError(null);
    reportStreamVerified();
  }, [markPlaybackStarted, reportStreamVerified, stopLoading]);

  const clearUiTimers = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    if (forceShowTimeoutRef.current) {
      clearTimeout(forceShowTimeoutRef.current);
      forceShowTimeoutRef.current = null;
    }
    if (osdTimerRef.current) {
      clearTimeout(osdTimerRef.current);
      osdTimerRef.current = null;
    }
    if (osdClearTimerRef.current) {
      clearTimeout(osdClearTimerRef.current);
      osdClearTimerRef.current = null;
    }
    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }
  }, []);

  /**
   * Briefly show a centred on-screen indicator for keyboard/pointer actions.
   * The indicator fades out after ~1.1 s and is fully removed after the transition.
   */
  const triggerOsd = useCallback((action: PlayerOsdAction) => {
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    if (osdClearTimerRef.current) clearTimeout(osdClearTimerRef.current);
    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }

    setOsdVisible(false);
    setOsdAction(action);
    osdAnimationFrameRef.current = window.requestAnimationFrame(() => {
      osdAnimationFrameRef.current = null;
      setOsdVisible(true);
    });

    // Play/pause feedback is more intrusive — dismiss it faster than seek/volume.
    const visibleMs =
      action.kind === 'play' || action.kind === 'pause'
        ? 340
        : action.kind === 'message'
          ? 1600
          : 900;
    osdTimerRef.current = setTimeout(() => {
      setOsdVisible(false);
      osdTimerRef.current = null;
      osdClearTimerRef.current = setTimeout(() => {
        osdClearTimerRef.current = null;
        setOsdAction(null);
      }, 120);
    }, visibleMs);
  }, []);

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const { applyResumeIfReady, clearResumeRetryTimer, prepareForStreamLoad } =
    usePlayerResumeController({
      mediaId: id,
      mediaType: type,
      activeStreamUrl,
      startTime,
      absoluteSeason: resolvedAbsoluteSeason,
      absoluteEpisode: resolvedAbsoluteEpisode,
      isHistoryResume,
      mountedRef,
      isDestroyedRef,
      currentTimeRef,
      durationRef,
      onResumeMessage: (text) => {
        triggerOsd({ kind: 'message', text });
      },
    });

  const updateTracks = useCallback((rawTracks: unknown) => {
    const normalizedTracks = normalizeTrackList(rawTracks);
    trackListRef.current = normalizedTracks;
    setAudioTracks(normalizedTracks.filter((track) => track.type === 'audio'));
    setSubTracks(normalizedTracks.filter((track) => track.type === 'sub'));
    return normalizedTracks;
  }, []);

  const confirmTrackSwitch = useCallback(async (type: 'audio' | 'sub', id: number | 'no') => {
    if (doesTrackSelectionMatch(trackListRef.current, type, id)) {
      return true;
    }

    for (let attempt = 0; attempt < TRACK_SWITCH_VERIFY_ATTEMPTS; attempt += 1) {
      if (doesTrackSelectionMatch(trackListRef.current, type, id)) {
        return true;
      }
      if (attempt < TRACK_SWITCH_VERIFY_ATTEMPTS - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, TRACK_SWITCH_VERIFY_DELAY_MS));
      }
    }
    return false;
  }, []);

  // Keep refs in sync so MPV init effect reads latest versions without dep changes.
  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  const prepareForPlayerNavigation = useCallback(async () => {
    prepareForInternalPlayerNavigation();
    setShowControls(true);
    setShowEpisodes(false);
    await flushPlaybackBeforeNavigation();
  }, [flushPlaybackBeforeNavigation, prepareForInternalPlayerNavigation]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    saveProgressRef.current?.();
    if (nextPlaybackPlan) {
      setShowControls(true);
      startUpNextCountdown();
    }
  }, [nextPlaybackPlan, startUpNextCountdown]);

  useEffect(() => {
    handleEndedRef.current = handleEnded;
  }, [handleEnded]);

  const clearOptimisticSeek = useCallback(() => {
    pendingSeekTargetRef.current = null;
    pendingSeekDeadlineRef.current = 0;
  }, []);

  const primeOptimisticSeek = useCallback(
    (targetTime: number) => {
      const effectiveDuration = durationRef.current > 0 ? durationRef.current : duration;
      const boundedTarget = Math.max(
        0,
        effectiveDuration > 0 ? Math.min(effectiveDuration, targetTime) : targetTime,
      );

      pendingSeekTargetRef.current = boundedTarget;
      pendingSeekDeadlineRef.current = performance.now() + OPTIMISTIC_SEEK_HOLD_MS;
      currentTimeRef.current = boundedTarget;
      lastTimeUpdateRef.current = performance.now();
      setCurrentTime(boundedTarget);

      return boundedTarget;
    },
    [duration],
  );

  const togglePlay = useCallback(async () => {
    await command('cycle', ['pause']);
  }, []);

  const seek = useCallback(
    async (seconds: number) => {
      const boundedTarget = primeOptimisticSeek(seconds);

      try {
        await command('seek', [boundedTarget.toString(), 'absolute']);
      } catch (error) {
        clearOptimisticSeek();
        throw error;
      }
    },
    [clearOptimisticSeek, primeOptimisticSeek],
  );

  const seekRelative = useCallback(
    async (seconds: number) => {
      const baseTime = pendingSeekTargetRef.current ?? currentTimeRef.current;
      const boundedTarget = primeOptimisticSeek(baseTime + seconds);

      try {
        await command('seek', [(boundedTarget - baseTime).toString(), 'relative']);
      } catch (error) {
        clearOptimisticSeek();
        throw error;
      }

      triggerOsd({
        kind: 'seek',
        direction: seconds > 0 ? 'forward' : 'backward',
        seconds: Math.abs(seconds),
      });
    },
    [clearOptimisticSeek, primeOptimisticSeek, triggerOsd],
  );

  const applySubtitleDelay = useCallback(async (value: number) => {
    const next = Math.max(-5, Math.min(5, Math.round(value * 10) / 10));
    setSubtitleDelay(next);
    try {
      await command('set', ['sub-delay', String(next)]);
    } catch {
      await setProperty('sub-delay', next);
    }
  }, []);

  const applySubtitlePos = useCallback(async (value: number) => {
    const next = Math.max(0, Math.min(100, value));
    setSubtitlePos(next);
    try {
      await command('set', ['sub-pos', String(next)]);
    } catch {
      await setProperty('sub-pos', next);
    }
  }, []);

  const applySubtitleScale = useCallback(async (value: number) => {
    const next = Math.round(Math.max(0.25, Math.min(3.0, value)) * 20) / 20; // round to 0.05
    setSubtitleScale(next);
    try {
      await command('set', ['sub-scale', String(next)]);
    } catch {
      await setProperty('sub-scale', next);
    }
  }, []);

  useEffect(() => {
    lastAutoResolveLookupIdRef.current = null;
  }, [id, season, episode]);

  const playNext = useCallback(async () => {
    if (!nextPlaybackPlan || !id) return;

    const targetRoute = buildPlayerRoute(
      effectiveResolveMediaType,
      id,
      nextPlaybackPlan.canonical.season,
      nextPlaybackPlan.canonical.episode,
    );

    const prefetchedPlan = getFreshPrefetchedPlan(nextPlaybackPlan.lookupKey);
    const hasPrefetched =
      prefetchedPlan &&
      prefetchedPlan.canonical.season === nextPlaybackPlan.canonical.season &&
      prefetchedPlan.canonical.episode === nextPlaybackPlan.canonical.episode;

    const baseState = {
      title,
      poster,
      backdrop,
      logo,
      startTime: 0,
      absoluteSeason: nextPlaybackPlan.canonical.season,
      absoluteEpisode: nextPlaybackPlan.canonical.episode,
      streamSeason: nextPlaybackPlan.source.season,
      streamEpisode: nextPlaybackPlan.source.episode,
      aniskipEpisode: nextPlaybackPlan.source.aniskipEpisode,
      streamLookupId: nextPlaybackPlan.source.lookupId,
      from, // Propagate origin so back nav stays consistent
    };

    if (hasPrefetched) {
      await prepareForPlayerNavigation();
      navigate(targetRoute, {
        state: {
          ...baseState,
          streamUrl: prefetchedPlan.primaryStream?.url,
          streamSourceName: prefetchedPlan.primaryStream?.sourceName,
          streamFamily: prefetchedPlan.primaryStream?.streamFamily,
          format: prefetchedPlan.primaryStream?.format,
          preparedBackupStream: prefetchedPlan.backupStream
            ? {
                url: prefetchedPlan.backupStream.url,
                format: prefetchedPlan.backupStream.format,
                sourceName: prefetchedPlan.backupStream.sourceName,
                streamFamily: prefetchedPlan.backupStream.streamFamily,
              }
            : undefined,
        },
      });
      return;
    }

    try {
      const resolved = await resolveRankedBestStream({
        mediaType: effectiveResolveMediaType,
        mediaId: id,
        streamLookupId: nextPlaybackPlan.source.lookupId,
        streamSeason: nextPlaybackPlan.source.season,
        streamEpisode: nextPlaybackPlan.source.episode,
        absoluteEpisode: nextPlaybackPlan.canonical.episode,
        rankingTarget: {
          mediaId: id,
          mediaType: effectiveResolveMediaType,
          season: nextPlaybackPlan.canonical.season,
          episode: nextPlaybackPlan.canonical.episode,
        },
      });

      await prepareForPlayerNavigation();
      navigate(targetRoute, {
        state: {
          ...baseState,
          streamUrl: resolved.url,
          streamSourceName: resolved.source_name,
          streamFamily: resolved.stream_family,
          format: resolved.format,
        },
      });
      return;
    } catch {
      // Fallback to route transition and let page auto-resolve.
    }

    await prepareForPlayerNavigation();
    navigate(targetRoute, {
      state: {
        ...baseState,
      },
    });
  }, [
    getFreshPrefetchedPlan,
    navigate,
    effectiveResolveMediaType,
    id,
    nextPlaybackPlan,
    title,
    poster,
    logo,
    from,
    backdrop,
    prepareForPlayerNavigation,
  ]);

  // Auto-navigate when the up-next countdown expires
  useEffect(() => {
    if (showUpNext && upNextCountdown === 0) {
      dismissUpNext();
      void playNext();
    }
  }, [dismissUpNext, showUpNext, upNextCountdown, playNext]);

  const playEpisode = useCallback(
    async (ep: Episode) => {
      if (!id) return;

      // Instead of auto-playing, open the stream selector
      // We pause current playback just in case, but keep player visible until new selection
      try {
        await setProperty('pause', true);
      } catch {
        /* ignore */
      }
      setIsPlaying(false);
      dismissUpNext();
      const requestId = ++selectorOpenRequestIdRef.current;

      const target = await resolveEpisodeStreamTarget(
        effectiveResolveMediaType,
        id,
        streamLookupId || id,
        ep,
      );

      if (requestId !== selectorOpenRequestIdRef.current) {
        return;
      }

      setSelectedEpisodeForStream(ep);
      setSelectedEpisodeStreamTarget({
        streamLookupId: target.streamId,
        streamSeason: target.season,
        streamEpisode: target.episode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        aniskipEpisode: target.aniskipEpisode,
        lookupKey: buildEpisodeStreamTargetLookupKey(effectiveResolveMediaType, target),
      });
      setShowStreamSelector(true);
      setShowEpisodes(false);
    },
    [dismissUpNext, effectiveResolveMediaType, id, streamLookupId],
  );

  const openInlineStreamSelector = useCallback(async () => {
    if (!isSeriesLike || !id || !sidebarCurrentEpisode) return;
    dismissUpNext();
    const requestId = ++selectorOpenRequestIdRef.current;

    const target = await resolveEpisodeStreamTarget(
      effectiveResolveMediaType,
      id,
      streamLookupId || id,
      sidebarCurrentEpisode,
    );

    if (requestId !== selectorOpenRequestIdRef.current) {
      return;
    }

    setSelectedEpisodeForStream(sidebarCurrentEpisode);
    setSelectedEpisodeStreamTarget({
      streamLookupId: target.streamId,
      streamSeason: target.season,
      streamEpisode: target.episode,
      absoluteSeason: target.absoluteSeason,
      absoluteEpisode: target.absoluteEpisode,
      aniskipEpisode: target.aniskipEpisode,
      lookupKey: buildEpisodeStreamTargetLookupKey(effectiveResolveMediaType, target),
    });
    setShowStreamSelector(true);
    setShowEpisodes(false);
  }, [
    dismissUpNext,
    effectiveResolveMediaType,
    id,
    isSeriesLike,
    sidebarCurrentEpisode,
    streamLookupId,
  ]);

  const handleVolumeChange = useCallback(
    async (newVol: number) => {
      setVolume(newVol);
      volumeRef.current = newVol;
      localStorage.setItem('player:volume', newVol.toString());
      await setProperty('volume', newVol);
      if (newVol > 0 && isMuted) {
        setIsMuted(false);
        await setProperty('mute', false);
      }
      triggerOsd({ kind: 'volume', level: newVol });
    },
    [isMuted, triggerOsd],
  );

  const toggleMute = useCallback(async () => {
    const newMute = !isMuted;
    setIsMuted(newMute);
    await setProperty('mute', newMute);
    if (newMute) {
      setVolume(0);
      triggerOsd({ kind: 'volume', level: 0 });
    } else {
      const restored = volumeRef.current > 0 ? volumeRef.current : 50;
      setVolume(restored);
      await setProperty('volume', restored);
      triggerOsd({ kind: 'volume', level: restored });
    }
  }, [isMuted, triggerOsd]);

  const setTrackSwitchingFlag = useCallback((type: 'audio' | 'sub', value: boolean) => {
    trackSwitchingRef.current = {
      ...trackSwitchingRef.current,
      [type]: value,
    };
    setTrackSwitching((prev) => {
      if (prev[type] === value) return prev;
      return {
        ...prev,
        [type]: value,
      };
    });
  }, []);

  const requestTrackChange = useCallback(
    (
      type: 'audio' | 'sub',
      id: number | 'no',
      options?: { silent?: boolean; persistPreference?: boolean },
    ) => setTrackRef.current(type, id, options),
    [],
  );

  const { persistSelectedTrackPreference } = usePlayerTrackPreferences({
    mediaId: id,
    mediaType: effectiveResolveMediaType,
    activeStreamUrl,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    resetKey: `${activeStreamUrl ?? 'stream'}:${id ?? 'id'}:${season ?? 'season'}:${episode ?? 'episode'}`,
    audioTracks,
    subTracks,
    activeAudioTrack,
    activeSubTrack,
    subtitlesOff,
    trackSwitching,
    setTrack: requestTrackChange,
  });

  const setTrack = useCallback(
    async (
      type: 'audio' | 'sub',
      id: number | 'no',
      options?: { silent?: boolean; persistPreference?: boolean },
    ) => {
      if (type === 'audio' && id === 'no') return;

      if (trackSwitchingRef.current.audio || trackSwitchingRef.current.sub) return;

      const alreadySelected =
        type === 'audio'
          ? activeAudioTrack?.id === id
          : id === 'no'
            ? subtitlesOff
            : activeSubTrack?.id === id;

      const prop = type === 'audio' ? 'aid' : 'sid';
      const value = id === 'no' ? 'no' : id;
      const silent = options?.silent ?? false;
      const persistPreference = options?.persistPreference ?? false;

      const persistSelection = () => {
        if (!persistPreference) return;
        persistSelectedTrackPreference(type, id);
      };

      if (alreadySelected) {
        persistSelection();
        return;
      }

      setTrackSwitchingFlag(type, true);

      try {
        try {
          await setProperty(prop, value);
        } catch {
          await command('set', [prop, String(value)]);
        }

        const switched = await confirmTrackSwitch(type, id);
        if (!switched) {
          throw new Error('track-switch-not-confirmed');
        }

        persistSelection();
        if (!silent) toast.success(`${type === 'audio' ? 'Audio' : 'Subtitle'} track changed`);
      } catch {
        if (!silent) toast.error('Failed to switch track');
      } finally {
        setTrackSwitchingFlag(type, false);
      }
    },
    [
      activeAudioTrack?.id,
      activeSubTrack?.id,
      confirmTrackSwitch,
      persistSelectedTrackPreference,
      setTrackSwitchingFlag,
      subtitlesOff,
    ],
  );

  useEffect(() => {
    setTrackRef.current = setTrack;
  }, [setTrack]);

  useEffect(() => {
    trackSwitchingRef.current = { audio: false, sub: false };

    const timer = window.setTimeout(() => {
      setTrackSwitching({ audio: false, sub: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeStreamUrl, id, season, episode]);

  // -- Hotkeys --
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!mountedRef.current) return;
      // Guard: let the event pass normally when the user is typing in any input field
      // (subtitle delay, search boxes, text areas, or contentEditable nodes) so that
      // Space / Arrow keys don't simultaneously trigger player actions AND type text.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          triggerOsd({ kind: isPlayingRef.current ? 'pause' : 'play' });
          togglePlay();
          break;
        case 'arrowright':
        case 'l':
          e.preventDefault();
          seekRelative(10);
          break;
        case 'arrowleft':
        case 'j':
          e.preventDefault();
          seekRelative(-10);
          break;
        case 'arrowup':
          e.preventDefault();
          handleVolumeChange(Math.min(100, volumeRef.current + 5));
          break;
        case 'arrowdown':
          e.preventDefault();
          handleVolumeChange(Math.max(0, volumeRef.current - 5));
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'n':
          e.preventDefault();
          if (nextEpisode) void playNext();
          break;
        case 'd':
          e.preventDefault();
          if (activeStreamUrl) setShowDownloadModal(true);
          break;
        case 'escape':
          if (showUpNext) {
            dismissUpNext();
            return;
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    togglePlay,
    seekRelative,
    toggleFullscreen,
    toggleMute,
    handleVolumeChange,
    triggerOsd,
    dismissUpNext,
    nextEpisode,
    playNext,
    activeStreamUrl,
    showUpNext,
  ]);

  // -- Effects --

  useEffect(() => {
    if (!error) return;
    if (activeStreamUrl || isResolving || !type || !id || !mountedRef.current) return;

    const nextLookupId = streamLookupId || id;
    const lastAttemptedLookupId = lastAutoResolveLookupIdRef.current;
    if (!lastAttemptedLookupId || nextLookupId === lastAttemptedLookupId) return;

    setError(null);
  }, [error, activeStreamUrl, isResolving, type, id, streamLookupId]);

  // 0. Auto-Resolve Stream if missing
  useEffect(() => {
    // If we have a URL, we don't need to resolve.
    // If we are already resolving, don't start again.
    // If we have an error, stop (unless retry is manual).
    if (activeStreamUrl || isResolving || error || !type || !id || !mountedRef.current) return;
    if (shouldWaitForResolvedLookupId) return;

    let timedOut = false;

    const resolve = async () => {
      setIsResolving(true);
      setError(null);
      setResolveStatus('Fetching streams...');

      try {
        const s = resolvedStreamSeason;
        const e = resolvedStreamEpisode;
        const abs = resolvedAbsoluteEpisode;
        const lookupId = streamLookupId || id;
        lastAutoResolveLookupIdRef.current = lookupId;

        if (isDev) console.warn('Resolving stream...');

        setResolveStatus('Selecting best stream...');
        const result = await Promise.race([
          resolveRankedBestStream({
            mediaType: effectiveResolveMediaType,
            mediaId: id,
            streamLookupId: lookupId,
            streamSeason: s,
            streamEpisode: e,
            absoluteEpisode: abs,
            bypassCache: shouldBypassResolveCache,
            rankingTarget: {
              mediaId: id,
              mediaType: effectiveResolveMediaType,
              season: resolvedAbsoluteSeason,
              episode: resolvedAbsoluteEpisode,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              timedOut = true;
              reject(new Error('Stream resolution timed out. The addon may be unreachable.'));
            }, 15_000),
          ),
        ]);

        if (timedOut) return;
        if (isDev) console.warn('Stream resolved.');
        activeStreamFormatRef.current = result.format;
        activeStreamSourceNameRef.current = result.source_name?.trim() || undefined;
        activeStreamFamilyRef.current = result.stream_family?.trim() || undefined;
        setActiveStreamUrl(result.url);
        setIsResolving(false);
        setResolveStatus('');
      } catch (err: unknown) {
        if (isDev) console.warn('Auto-resolve failed.');
        let msg = 'Failed to resolve stream automatically.';
        if (err instanceof Error) msg = err.message;
        setError(msg);
        setIsResolving(false);
        stopLoading();
      }
    };

    resolve();
  }, [
    activeStreamUrl,
    type,
    effectiveResolveMediaType,
    id,
    resolvedStreamSeason,
    resolvedStreamEpisode,
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    isResolving,
    error,
    isDev,
    shouldBypassResolveCache,
    shouldWaitForResolvedLookupId,
    streamLookupId,
    preferredStreamLookupId,
    activeStreamFormatRef,
    activeStreamFamilyRef,
    activeStreamSourceNameRef,
    setActiveStreamUrl,
    stopLoading,
  ]);

  // 2. Initialize MPV
  useEffect(() => {
    if (!activeStreamUrl) return;

    // For local files (offline), we skip the resolve phase
    if (isOffline) {
      setIsResolving(false);
      setResolveStatus('');
    }

    if (lastStreamUrlRef.current !== activeStreamUrl) {
      lastStreamUrlRef.current = activeStreamUrl;
    }

    isDestroyedRef.current = false;
  mpvInitializedRef.current = false;

    // Local cancelled flag prevents stale async continuations (fixes StrictMode double-fire race)
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let loadfileSent = false;

    const initPlayer = async () => {
      setIsLoading(true);
      isLoadingRef.current = true;
      setError(null);
      setCurrentTime(0);
      setDuration(0);

      setTransparent(false); // Start with black background

      try {
        try {
          await destroy();
        } catch {
          /* ignore */
        }

        await new Promise((r) => setTimeout(r, 150));
        if (cancelled) return;

        const shouldStartPaused = prepareForStreamLoad();

        const mpvConfig: MpvConfig = {
          initialOptions: {
            vo: 'gpu-next',
            hwdec: 'auto',
            'gpu-context': 'd3d11',
            'keep-open': 'yes',
            cache: 'yes',
            volume: volumeRef.current.toString(),
            pause: shouldStartPaused ? 'yes' : 'no',
            osc: 'no', // Disable MPV's on-screen controller
            'osd-level': '0', // Disable MPV's OSD text
            'input-default-bindings': 'yes',
            'msg-level': 'all=warn', // Suppress verbose FFmpeg/codec debug spam
          },
          observedProperties: OBSERVED_PROPERTIES,
        };

        await init(mpvConfig);
        if (cancelled) return;

        await setProperty('sub-delay', subtitleDelay);
        await setProperty('sub-pos', subtitlePos);
        if (subtitleScale !== 1.0) await setProperty('sub-scale', subtitleScale);
        // Restore persisted speed
        const savedSpeed = localStorage.getItem('player:speed');
        if (savedSpeed) {
          const parsed = parseFloat(savedSpeed);
          if (!isNaN(parsed) && parsed !== 1.0) await setProperty('speed', parsed);
        }
        mpvInitializedRef.current = true;

        unlisten = await observeProperties(OBSERVED_PROPERTIES, (event) => {
          if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
          const { name, data } = event;

          switch (name) {
            case 'time-pos':
              if (typeof data === 'number') {
                const now = performance.now();
                const pendingSeekTarget = pendingSeekTargetRef.current;
                if (pendingSeekTarget !== null) {
                  const seekSettled =
                    Math.abs(data - pendingSeekTarget) <= OPTIMISTIC_SEEK_SETTLED_DELTA_SECS;

                  if (!seekSettled && now < pendingSeekDeadlineRef.current) {
                    break;
                  }

                  clearOptimisticSeek();
                }

                const prevTime = currentTimeRef.current;
                currentTimeRef.current = data;
                if (
                  now - lastTimeUpdateRef.current > TIME_UPDATE_THROTTLE_MS ||
                  Math.abs(prevTime - data) > 2
                ) {
                  lastTimeUpdateRef.current = now;
                  setCurrentTime(data);
                }
                // Mark playback as started once we have a valid time position
                if (
                  isLoadingRef.current &&
                  (data > 0.1 || (data >= 0 && durationRef.current > 0))
                ) {
                  markPlaybackReady();
                }
                void applyResumeIfReady();
              }
              break;
            case 'duration':
              if (typeof data === 'number') {
                setDuration(data);
                durationRef.current = data;
                if (data > 0 && isLoadingRef.current) {
                  markPlaybackReady();
                }
                void applyResumeIfReady();
              }
              break;
            case 'pause':
              if (typeof data === 'boolean') {
                isPlayingRef.current = !data;
                setIsPlaying(!data);
              }
              break;
            case 'volume':
              if (typeof data === 'number') {
                setVolume(data);
                volumeRef.current = data;
              }
              break;
            case 'mute':
              if (typeof data === 'boolean') setIsMuted(data);
              break;
            case 'speed':
              if (typeof data === 'number') setPlaybackSpeed(data);
              break;
            case 'eof-reached':
              if (data === true) handleEndedRef.current?.();
              break;
            case 'track-list':
              if (Array.isArray(data)) updateTracks(data);
              break;
            case 'idle-active':
              if (data === true) {
                if (isOffline || errorRef.current) break;
                // Before loadfile completes, idle-active is just MPV's initial state — ignore it
                if (isLoadingRef.current && !loadfileSent) break;

                const nearEnd =
                  durationRef.current > 0 &&
                  currentTimeRef.current >= Math.max(0, durationRef.current - 1);
                if (nearEnd) break;

                const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
                if (!currentUrl) break;

                if (isHistoryResume && recoverFromStaleSavedStream()) break;

                const duringInitialLoad = isLoadingRef.current;
                reportStreamFailure(duringInitialLoad ? 'load-failed' : 'disconnected', currentUrl);
                void recoverFromSlowStartup(currentUrl).then((didRecover) => {
                  if (didRecover || !mountedRef.current || errorRef.current) return;

                  const stillNearEnd =
                    durationRef.current > 0 &&
                    currentTimeRef.current >= Math.max(0, durationRef.current - 1);
                  if (stillNearEnd) return;

                  setError(
                    duringInitialLoad
                      ? 'Stream failed to load. Try another stream.'
                      : 'This stream disconnected. Try another stream.',
                  );
                  if (duringInitialLoad) stopLoading();
                });
              }
              break;
            case 'core-idle':
              if (data === false && isLoadingRef.current && durationRef.current > 0) {
                markPlaybackReady();
                void applyResumeIfReady();
              }
              break;
          }
        });

        if (cancelled) {
          if (unlisten) unlisten();
          return;
        }

        if (isDev) console.warn('Loading stream...');
        await command('loadfile', [activeStreamUrl, 'replace']);
        loadfileSent = true;
        if (cancelled) return;
        isPlayingRef.current = !shouldStartPaused;
        setIsPlaying(!shouldStartPaused);
        void applyResumeIfReady();

        clearUiTimers();
        forceShowTimeoutRef.current = setTimeout(() => {
          if (!cancelled && mountedRef.current && isLoadingRef.current && !errorRef.current) {
            if (recoverFromStaleSavedStream()) {
              return;
            }
            if (isDev) console.warn('Force showing player after timeout.');
            // Show transparent player so the user can see controls and try another stream
            stopLoading(true);
            // If nothing has started after another 5 s, show a definitive error
            forceShowTimeoutRef.current = setTimeout(() => {
              if (cancelled || !mountedRef.current || errorRef.current) return;
              if (durationRef.current > 0 && currentTimeRef.current > 0.1) return;
              reportStreamFailure('load-failed');
              setError('Stream failed to load. Try another stream.');
              stopLoading();
            }, 5000);
          }
        }, 6500);
      } catch (err) {
        if (cancelled) return; // Don't set error for cancelled inits
        if (recoverFromStaleSavedStream()) return;
        if (isDev) console.error('MPV Init Error:', err);
        reportStreamFailure('load-failed');
        if (mountedRef.current) {
          setError('Failed to initialize player. Please try a different stream.');
          stopLoading();
        }
      }
    };

    initPlayer();

    return () => {
      cancelled = true;
      isDestroyedRef.current = true;
      mpvInitializedRef.current = false;
      if (unlisten) unlisten();
      clearUiTimers();
      clearResumeRetryTimer();
      clearRecoveryTimers();
      destroy().catch(() => {});
      restorePlayerSurface();
      saveProgressRef.current?.();
    };
    // Intentionally scoped dependencies: this effect owns MPV init/teardown and should
    // not restart on transient UI state changes (e.g. `error`) that are handled via refs.
    // `handleEnded` and `saveProgress` are read from stable refs to avoid reinit when
    // async data (details/nextEpisode) changes their callback identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeStreamUrl,
    updateTracks,
    clearRecoveryTimers,
    clearResumeRetryTimer,
    clearUiTimers,
    isDev,
    markPlaybackReady,
    restorePlayerSurface,
    prepareForStreamLoad,
    stopLoading,
    clearOptimisticSeek,
    recoverFromStaleSavedStream,
    isAnime,
  ]);

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  };

  // Hide cursor when controls are hidden during playback
  useEffect(() => {
    const container = document.getElementById('mpv-container');
    if (!container) return;
    if (!showControls && isPlaying) {
      container.style.cursor = 'none';
      document.body.style.cursor = 'none';
    } else {
      container.style.cursor = '';
      document.body.style.cursor = '';
    }
    return () => {
      container.style.cursor = '';
      document.body.style.cursor = '';
      document.documentElement.style.cursor = '';
    };
  }, [showControls, isPlaying]);

  useEffect(() => {
    return () => {
      clearUiTimers();
      clearRecoveryTimers();
      clearResumeRetryTimer();
    };
  }, [clearRecoveryTimers, clearResumeRetryTimer, clearUiTimers]);

  // Restore or preserve viewport mode on unmount depending on the navigation path.
  useEffect(() => {
    return () => {
      cleanupViewportOnUnmount();
      // Ensure Continue Watching is always fresh after leaving the player,
      // regardless of which navigation path was taken.
      invalidateWatchHistoryOnce();
    };
  }, [cleanupViewportOnUnmount, invalidateWatchHistoryOnce]);

  const handlePlayerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;

      // Ignore clicks from portal content and interactive controls
      if (!event.currentTarget.contains(target)) return;
      if (
        target.closest(
          'button, a, input, textarea, select, [role="button"], [role="menu"], [role="menuitem"], [data-radix-popper-content-wrapper]',
        )
      ) {
        return;
      }

      // Close episode panel when clicking outside it
      if (showEpisodes) {
        setShowEpisodes(false);
        return;
      }

      if (isLoading || isResolving || error) return;

      setShowControls(true);
      triggerOsd({ kind: isPlayingRef.current ? 'pause' : 'play' });
      void togglePlay();
    },
    [showEpisodes, isLoading, isResolving, error, togglePlay, triggerOsd],
  );

  // -- Render Logic --
  // Don't show error overlay in the brief window before auto-resolve starts
  const showErrorOverlay = error && !isResolving && !isLoading;

  const selectorEpisodeStream = selectedEpisodeStreamTarget;

  const selectorAbsoluteSeason = selectorEpisodeStream?.absoluteSeason ?? resolvedAbsoluteSeason;
  const selectorAbsoluteEpisode = selectorEpisodeStream?.absoluteEpisode ?? resolvedAbsoluteEpisode;
  const selectorStreamLookupId = selectorEpisodeStream?.streamLookupId ?? streamLookupId;
  const selectorStreamSeason = selectorEpisodeStream?.streamSeason ?? resolvedStreamSeason;
  const selectorStreamEpisode = selectorEpisodeStream?.streamEpisode ?? resolvedStreamEpisode;
  const selectorAniSkipEpisode = selectorEpisodeStream?.aniskipEpisode ?? resolvedAniSkipEpisode;
  const isSelectorForCurrentEpisode =
    selectorAbsoluteSeason === resolvedAbsoluteSeason &&
    selectorAbsoluteEpisode === resolvedAbsoluteEpisode;
  const selectorStartTime = isSelectorForCurrentEpisode ? currentTimeRef.current : 0;
  const currentSelectorStreamKey =
    routeSelectedStreamKey && routeStreamUrl && activeStreamUrl === routeStreamUrl
      ? routeSelectedStreamKey
      : undefined;
  const selectorEpisodeOverview = details?.episodes?.find(
    (e) => e.season === selectorAbsoluteSeason && e.episode === selectorAbsoluteEpisode,
  )?.overview;

  // Simplified Render: Always render the container, manage overlays.

  return (
    <div
      ref={playerContainerRef}
      className={cn(
        'relative w-full h-screen overflow-hidden bg-transparent text-white group',
        !isFullscreen && 'pl-[60px]',
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onClick={handlePlayerClick}
      id='mpv-container'
    >
      {!isFullscreen && (
        <div
          className='fixed left-0 top-0 z-[70] pointer-events-auto'
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Sidebar className='flex' playerMode />
        </div>
      )}
      {/* Background / Poster (Visible when loading or audio) */}
      <div
        className={cn(
          'absolute inset-0 z-0 transition-opacity duration-1000',
          isLoading ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        {backdrop && (
          <>
            <img src={backdrop} className='w-full h-full object-cover opacity-50' alt='' />
            <div className='absolute inset-0 bg-black/50 backdrop-blur-sm' />
          </>
        )}
      </div>

      {/* Error State */}
      {showErrorOverlay && (
        <div className='absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90'>
          <X className='w-16 h-16 text-red-500 mb-4' />
          <h2 className='text-2xl font-bold mb-2'>Playback Error</h2>
          <p className='text-gray-400 mb-6'>{error}</p>
          <div className='flex items-center gap-3'>
            <Button
              variant='outline'
              onClick={() => {
                void openInlineStreamSelector();
              }}
            >
              Choose Stream
            </Button>
            <Button onClick={navigateBack} variant='outline'>
              Go Back
            </Button>
          </div>
        </div>
      )}

      {/* Loading / Resolving State */}
      {(isLoading || isResolving) && !error && (
        <div className='pointer-events-none absolute inset-0 z-50 flex items-center justify-center'>
          <div className='animate-in fade-in zoom-in-95 duration-200 mx-4 w-full max-w-xs rounded-2xl border border-white/10 bg-black/70 px-4 py-3.5 shadow-2xl backdrop-blur-xl'>
            <div className='flex items-center gap-3'>
              <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/5'>
                <Loader2 className='h-4 w-4 animate-spin text-white/70' />
              </div>

              <div className='min-w-0 flex-1'>
                <p className='mb-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/35'>
                  {isResolving ? 'Resolving' : 'Starting'}
                </p>
                <p className='text-sm font-semibold leading-snug text-white'>
                  {playerLoadingCopy.headline}
                </p>
              </div>
            </div>

            {playerLoadingCopy.detail && (
              <p className='mt-2 text-xs leading-relaxed text-white/45'>
                {playerLoadingCopy.detail}
              </p>
            )}

            <div className='relative mt-3 h-[2px] overflow-hidden rounded-full bg-white/10'>
              <div className='absolute inset-y-0 w-1/3 rounded-full bg-white/50 animate-[progress-slide_1.6s_linear_infinite]' />
            </div>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div
        className={cn(
          'absolute inset-0 z-40 pointer-events-none flex flex-col pr-6 transition-opacity duration-300 bg-gradient-to-b from-black/80 via-transparent to-black/90',
          'justify-between pt-6 pb-6',
          isFullscreen ? 'pl-6' : 'pl-[84px]',
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        <div
          className='pointer-events-auto flex items-center justify-between'
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant='ghost'
            size='icon'
            onClick={navigateBack}
            className='text-white hover:bg-white/20'
          >
            <ArrowLeft className='w-6 h-6' />
          </Button>
          <div className='text-center'>
            <h1 className='text-lg font-bold line-clamp-1'>{title}</h1>
            {season && episode && (
              <p className='text-sm text-gray-300'>
                S{season}:E{episode}
              </p>
            )}
          </div>
          <div className='w-10' />
        </div>

        {/* Center Play — shown when paused and no OSD is active (osdAction null = fully faded) */}
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          {!isPlaying && !isLoading && !isResolving && !error && !osdAction && (
            <button
              type='button'
              className='pointer-events-auto cursor-pointer outline-none transition-all duration-150 hover:scale-110 active:scale-95 animate-in fade-in zoom-in-95 duration-150'
              onClick={(e) => {
                e.stopPropagation();
                triggerOsd({ kind: 'play' });
                togglePlay();
              }}
            >
              <Play className='w-10 h-10 fill-white text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.7)]' />
            </button>
          )}
        </div>

        {/* Bottom Bar */}
        <div
          className='pointer-events-auto space-y-0'
          onClick={(e) => e.stopPropagation()}
        >
          {/* Progress info row — title/episode left · time right */}
          <div className='flex items-center justify-between px-0.5 pb-2'>
            <div className='min-w-0 flex-1'>
              <p className='text-sm font-semibold text-white leading-none truncate'>{title}</p>
              {season && episode && (
                <p className='text-[11px] text-white/45 mt-0.5 leading-none'>
                  S{season} · E{episode}
                  {episodeCountInSeason ? ` / ${episodeCountInSeason}` : ''}
                </p>
              )}
            </div>
            <div className='text-right shrink-0 ml-4'>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRemainingTime((v) => !v);
                }}
                className='text-[13px] font-mono text-white/75 tabular-nums leading-none hover:text-white transition-colors duration-150 cursor-pointer select-none'
                title='Toggle remaining time'
              >
                {showRemainingTime && duration > 0 ? (
                  <>
                    <span className='text-white/40'>-</span>
                    {formatTime(Math.max(0, duration - (seekPreviewTime ?? currentTime)))}
                    <span className='text-white/30'> / </span>
                    {formatTime(duration)}
                  </>
                ) : (
                  <>
                    {formatTime(seekPreviewTime ?? currentTime)}
                    <span className='text-white/30'> / </span>
                    {formatTime(duration)}
                  </>
                )}
              </button>
            </div>
          </div>
          {/* Progress Bar — thumbless custom track */}
          <PlayerProgressBar
            duration={duration}
            currentTime={currentTime}
            seekPreviewTime={seekPreviewTime}
            skipSegments={skipSegments}
            onSeekPreviewTimeChange={setSeekPreviewTime}
            onSeek={seek}
            formatTime={formatTime}
          />

          {/* Controls Row */}
          <div className='flex items-center justify-between pt-1'>
            <div className='flex items-center gap-1'>
              {/* Rewind 10s */}
              <button
                type='button'
                onClick={() => {
                  triggerOsd({ kind: 'seek', direction: 'backward', seconds: 10 });
                  void seekRelative(-10);
                }}
                className='flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
                title='Rewind 10s (←)'
              >
                <Rewind className='w-6 h-6' strokeWidth={2.5} />
              </button>

              {/* Play / Pause */}
              <button
                type='button'
                onClick={() => {
                  triggerOsd({ kind: isPlayingRef.current ? 'pause' : 'play' });
                  void togglePlay();
                }}
                className='flex h-11 w-11 items-center justify-center rounded-xl text-white hover:bg-white/10 transition-colors'
              >
                {isPlaying ? (
                  <Pause className='w-[26px] h-[26px] fill-white' />
                ) : (
                  <Play className='w-[26px] h-[26px] fill-white' />
                )}
              </button>

              {/* Forward 10s */}
              <button
                type='button'
                onClick={() => {
                  triggerOsd({ kind: 'seek', direction: 'forward', seconds: 10 });
                  void seekRelative(10);
                }}
                className='flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
                title='Forward 10s (→)'
              >
                <FastForward className='w-6 h-6' strokeWidth={2.5} />
              </button>

              {/* Volume Control (Horizontal & Sleek) */}
              <div
                className='flex items-center group/vol'
                onMouseEnter={() => setIsHoveringVolume(true)}
                onMouseLeave={() => setIsHoveringVolume(false)}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Prevent arrow keys on the volume slider from triggering global hotkeys
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation();
                }}
              >
                <Button
                  variant='ghost'
                  size='icon'
                  onClick={toggleMute}
                  className='text-white hover:bg-white/20 z-10 h-10 w-10'
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className='w-6 h-6' strokeWidth={2.5} />
                  ) : volume < 50 ? (
                    <Volume1 className='w-6 h-6' strokeWidth={2.5} />
                  ) : (
                    <Volume2 className='w-6 h-6' strokeWidth={2.5} />
                  )}
                </Button>

                <div
                  className={cn(
                    'transition-all duration-300 ease-in-out flex items-center gap-2',
                    isHoveringVolume
                      ? 'w-36 opacity-100 ml-1'
                      : 'w-0 opacity-0 ml-0 pointer-events-none',
                  )}
                >
                  <PlayerSlider
                    value={[volume]}
                    max={100}
                    step={1}
                    onValueChange={(val) => handleVolumeChange(val[0])}
                    className='w-24'
                  />
                  <span className='text-[11px] font-mono text-white/50 tabular-nums w-8 leading-none flex-shrink-0'>
                    {isMuted ? '0' : volume}%
                  </span>
                </div>
              </div>

              {/* Speed */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='text-white font-mono hover:bg-white/20'
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {playbackSpeed}x
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side='top'
                  className='w-20 p-1 bg-black/90 border-white/10'
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <div className='flex flex-col gap-1'>
                    {SPEED_OPTIONS.map((s) => (
                      <Button
                        key={s}
                        variant='ghost'
                        size='sm'
                        onClick={() => {
                          setPlaybackSpeed(s);
                          localStorage.setItem('player:speed', s.toString());
                          void setProperty('speed', s);
                        }}
                        className={cn(
                          'h-6 justify-start',
                          s === playbackSpeed && 'bg-primary/20 text-primary',
                        )}
                      >
                        {s}x
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className='flex items-center gap-2'>
              {/* Next Episode */}
              {nextEpisode && (
                <Button
                  variant='ghost'
                  size='icon'
                  onClick={playNext}
                  className='text-white hover:bg-white/20 h-10 w-10'
                  title='Next Episode'
                >
                  <StepForward className='w-6 h-6' strokeWidth={2.5} />
                </Button>
              )}

              {/* Episodes List Toggle */}
              {details?.episodes && (
                <PlayerEpisodesToggleButton
                  open={showEpisodes}
                  onToggle={() => setShowEpisodes((prev) => !prev)}
                />
              )}

              {/* Stream / Quality Hot-Swap */}
              {isSeriesLike && !!id && (
                <Button
                  variant='ghost'
                  size='icon'
                  className='text-white hover:bg-white/20 h-10 w-10'
                  title='Choose Stream / Quality'
                  onClick={(e) => {
                    e.stopPropagation();
                    void openInlineStreamSelector();
                  }}
                >
                  <ArrowLeftRight className='w-5 h-5' strokeWidth={2.5} />
                </Button>
              )}

              {/* Playback Settings */}
              <PlayerPlaybackSettings
                audioTracks={audioTracks}
                subTracks={subTracks}
                showActiveIndicator={Boolean(activeAudioTrack || activeSubTrack)}
                subtitlesOff={subtitlesOff}
                trackSwitching={trackSwitching}
                subtitleDelay={subtitleDelay}
                subtitlePos={subtitlePos}
                subtitleScale={subtitleScale}
                onResetSubtitleSettings={() => {
                  void applySubtitleDelay(0);
                  void applySubtitlePos(100);
                  void applySubtitleScale(1.0);
                }}
                onApplySubtitleDelay={(value) => {
                  void applySubtitleDelay(value);
                }}
                onApplySubtitlePos={(value) => {
                  void applySubtitlePos(value);
                }}
                onApplySubtitleScale={(value) => {
                  void applySubtitleScale(value);
                }}
                onSelectTrack={(trackType, trackId, options) => {
                  void setTrack(trackType, trackId, options);
                }}
              />

              {/* Fullscreen */}
              <Button
                variant='ghost'
                size='icon'
                onClick={() => setShowDownloadModal(true)}
                className='text-white hover:bg-white/20 h-10 w-10'
                disabled={!activeStreamUrl}
              >
                <Download className='w-6 h-6' strokeWidth={2.5} />
              </Button>
              <Button
                variant='ghost'
                size='icon'
                onClick={toggleFullscreen}
                className='text-white hover:bg-white/20 h-10 w-10'
              >
                {isFullscreen ? (
                  <Minimize className='w-6 h-6' strokeWidth={2.5} />
                ) : (
                  <Maximize className='w-6 h-6' strokeWidth={2.5} />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <PlayerOsdOverlay
        action={osdAction}
        visible={osdVisible}
        isLoading={isLoading}
        isResolving={isResolving}
      />

      <PlayerActionOverlays
        hidden={isLoading || isResolving || !!error}
        skipAction={
          activeSkipSegment
            ? {
                label: getSkipLabel(activeSkipSegment.type),
                onSkip: () => {
                  void seek(activeSkipSegment.end_time);
                },
              }
            : null
        }
        upNextAction={
          showUpNext && nextEpisode
            ? {
                countdown: upNextCountdown,
                title: nextEpisodeLabel,
                onDismiss: dismissUpNext,
                onPlayNext: () => {
                  dismissUpNext();
                  void playNext();
                },
              }
            : null
        }
      />

      <PlayerEpisodesPanel
        open={showEpisodes}
        seasons={seasons}
        selectedSeason={selectedSeason}
        onSeasonChange={setSelectedSeason}
        episodes={details?.episodes ?? []}
        currentSeason={sidebarCurrentEpisode?.season ?? resolvedAbsoluteSeason}
        currentEpisode={sidebarCurrentEpisode?.episode ?? resolvedAbsoluteEpisode}
        backdrop={backdrop}
        onEpisodeSelect={(ep) => {
          void playEpisode(ep);
        }}
        onClose={() => setShowEpisodes(false)}
      />

      {/* Stream Selector Modal */}
      {showStreamSelector && type && id && (
        <div
          className='fixed inset-0 z-[100]'
          onClick={(e) => e.stopPropagation()} // Stop click propagation to Player
        >
          <StreamSelector
            open={showStreamSelector}
            onClose={() => {
              selectorOpenRequestIdRef.current += 1;
              setShowStreamSelector(false);
              setSelectedEpisodeForStream(null);
              setSelectedEpisodeStreamTarget(null);
            }}
            onBeforePlayerNavigation={prepareForPlayerNavigation}
            type={effectiveResolveMediaType}
            id={id}
            streamId={selectorStreamLookupId}
            season={selectorStreamSeason}
            episode={selectorStreamEpisode}
            absoluteSeason={selectorAbsoluteSeason}
            absoluteEpisode={selectorAbsoluteEpisode}
            aniskipEpisode={selectorAniSkipEpisode}
            startTime={selectorStartTime}
            title={details?.title || title}
            overview={selectorEpisodeOverview || details?.description}
            poster={poster}
            backdrop={backdrop}
            logo={logo}
            from={from}
            currentStreamKey={currentSelectorStreamKey}
            currentStreamUrl={activeStreamUrl}
          />
        </div>
      )}

      <div onClick={(e) => e.stopPropagation()}>
        <DownloadModal
          open={showDownloadModal}
          onOpenChange={setShowDownloadModal}
          title={title}
          url={activeStreamUrl || ''}
          fileName={`${title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`}
          poster={poster}
          mediaType={effectiveResolveMediaType}
          mediaId={id}
          season={season ? parseInt(season, 10) : undefined}
          episode={episode ? parseInt(episode, 10) : undefined}
          backdrop={backdrop}
        />
      </div>
    </div>
  );
}
