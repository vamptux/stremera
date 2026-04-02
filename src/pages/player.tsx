import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

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
  ArrowLeftRight,
} from 'lucide-react';
import { api, type Episode, type PlaybackLanguagePreferences, type SkipSegment } from '@/lib/api';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StreamSelector } from '@/components/stream-selector';
import {
  command,
  setProperty,
} from 'tauri-plugin-libmpv-api';
import { cn } from '@/lib/utils';
import { Sidebar } from '@/components/sidebar';
import { DownloadModal } from '@/components/download-modal';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
import {
  PlayerEpisodesPanel,
  PlayerEpisodesToggleButton,
} from '@/components/player-episodes-panel';
import { PlayerProgressBar } from '@/components/player-progress-bar';
import { useStreamRecovery } from '@/hooks/use-stream-recovery';
import { usePlayerViewportMode } from '@/hooks/use-player-viewport-mode';
import { AudioTrackSelector, SubtitleTrackSelector } from '@/components/player-track-selectors';
import { PlayerOsdOverlay, type PlayerOsdAction } from '@/components/player-osd-overlay';
import { PlayerSlider } from '@/components/player-slider';
import { PlayerActionOverlays } from '@/components/player-action-overlays';
import { usePlaybackProgressPersistence } from '@/hooks/use-playback-progress-persistence';
import { usePlaybackStreamHealth } from '@/hooks/use-playback-stream-health';
import { usePlayerMpvLifecycle } from '@/hooks/use-player-mpv-lifecycle';
import { usePlayerTrackController } from '@/hooks/use-player-track-controller';
import { usePlayerResumeController } from '@/hooks/use-player-resume-controller';
import { usePlayerStreamSession } from '@/hooks/use-player-stream-session';
import { usePlayerRouteState } from '@/hooks/use-player-route-state';
import { usePlayerNavigationGuard } from '@/hooks/use-player-navigation-guard';
import { usePlayerSurfaceLayout } from '@/hooks/use-player-surface-layout';
import { type NextEpisodeStreamCoordinates } from '@/hooks/use-player-up-next';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import {
  buildEpisodeStreamTargetLookupKey,
  buildEpisodeStreamTarget,
  resolveEpisodeStreamTarget,
} from '@/lib/episode-stream-target';
import {
  buildDetailsReopenSelectorState,
  getLatestEpisodeResumeStartTime,
} from '@/lib/history-playback';
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

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const OPTIMISTIC_SEEK_HOLD_MS = 450;
const CONTROLS_AUTO_HIDE_DELAY_MS = 3000;
const PLAYBACK_READY_AUTO_HIDE_DELAY_MS = 2600;
const PLAYER_INTERACTIVE_TARGET_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="menu"], [role="menuitem"], [data-radix-popper-content-wrapper]';
type TimerHandle = ReturnType<typeof setTimeout>;
type SelectedEpisodeStreamTarget = NextEpisodeStreamCoordinates & { startTime?: number };

function shouldIgnorePlayerSurfaceInteraction(event: React.MouseEvent<HTMLDivElement>): boolean {
  const target = event.target as HTMLElement;
  return !event.currentTarget.contains(target) || !!target.closest(PLAYER_INTERACTIVE_TARGET_SELECTOR);
}

function clearTimer(timerRef: React.MutableRefObject<TimerHandle | null>) {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

// --- Component ---

export function Player() {
  const { type, id, season, episode } = useParams();
  // Force full remount on episode change to ensure clean state
  return <InnerPlayer key={`${type ?? 'type'}:${id ?? 'id'}:${season ?? 'season'}:${episode ?? 'episode'}`} />;
}

function InnerPlayer() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const episodesPanelFrameRef = useRef<HTMLDivElement | null>(null);
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
  const { preferences: appUiPreferences, updatePreferences: updateAppUiPreferences } =
    useAppUiPreferences();

  useEffect(() => {
    setHasPlaybackStarted(false);
    setSeekPreviewTime(null);
  }, [activeStreamUrl]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => appUiPreferences.playerVolume);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasPlaybackStarted, setHasPlaybackStarted] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveStatus, setResolveStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => appUiPreferences.playerSpeed);
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [subtitlePos, setSubtitlePos] = useState(100);
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
    useState<SelectedEpisodeStreamTarget | null>(null);

  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [mpvSurfaceReady, setMpvSurfaceReady] = useState(false);
  const [surfaceLayoutRefreshToken, setSurfaceLayoutRefreshToken] = useState(0);
  const showErrorOverlay = !!error && !isResolving && !isLoading;

  // OSD (on-screen display) for keyboard/mouse action feedback
  const [osdAction, setOsdAction] = useState<PlayerOsdAction | null>(null);
  const [osdVisible, setOsdVisible] = useState(false);

  // Remaining time mode: click the clock to toggle between elapsed and remaining
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const watchHistoryInvalidatedRef = useRef(false);
  const playbackLanguagePreferencesRef = useRef<PlaybackLanguagePreferences>({});

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

  const invalidatePlaybackQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
    void queryClient.invalidateQueries({ queryKey: ['watch-history'] });
  }, [queryClient]);

  const invalidateWatchHistoryOnce = useCallback(() => {
    if (watchHistoryInvalidatedRef.current) return;
    watchHistoryInvalidatedRef.current = true;
    invalidatePlaybackQueries();
  }, [invalidatePlaybackQueries]);

  const flushPlaybackBeforeNavigation = useCallback(async () => {
    try {
      await saveProgressRef.current?.();
    } finally {
      if (!watchHistoryInvalidatedRef.current) {
        watchHistoryInvalidatedRef.current = true;
        invalidatePlaybackQueries();
      }
    }
  }, [invalidatePlaybackQueries]);

  const { allowNextNavigation } = usePlayerNavigationGuard({
    enabled: !!type && !!id && !!(activeStreamUrl || routeStreamUrl),
    flushBeforeNavigation: flushPlaybackBeforeNavigation,
  });

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
    allowNextNavigation();

    const backSeason = selectedEpisodeForStream?.season ?? routeAbsoluteSeason;
    const backEpisode = selectedEpisodeForStream?.episode ?? routeAbsoluteEpisode;
    const reopenSelectorState = buildDetailsReopenSelectorState({
      from: from && !from.startsWith('/player') ? from : `/details/${effectiveResolveMediaType}/${id}`,
      season: backSeason,
      episode: backEpisode,
      startTime:
        currentTimeRef.current > 5
          ? currentTimeRef.current
          : startTime && startTime > 5
            ? startTime
            : undefined,
    });

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
    startTime,
    allowNextNavigation,
  ]);

  // -- Refs --
  const controlsTimeoutRef = useRef<TimerHandle | null>(null);
  const forceShowTimeoutRef = useRef<TimerHandle | null>(null);
  const singleClickTimerRef = useRef<TimerHandle | null>(null);
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
  const osdTimerRef = useRef<TimerHandle | null>(null);
  const osdClearTimerRef = useRef<TimerHandle | null>(null);
  const osdAnimationFrameRef = useRef<number | null>(null);
  const selectorOpenRequestIdRef = useRef(0);
  /** Always-current playing state — used in closures to avoid stale captures. */
  const isPlayingRef = useRef(false);
  /** Timestamp (ms) when playback was first verified — used to suppress transient idle events. */
  const playbackVerifiedAtRef = useRef(0);
  const isDev = import.meta.env.DEV;

  useEffect(() => {
    setVolume((current) =>
      current === appUiPreferences.playerVolume ? current : appUiPreferences.playerVolume,
    );
    volumeRef.current = appUiPreferences.playerVolume;

    if (mpvInitializedRef.current) {
      void setProperty('volume', appUiPreferences.playerVolume).catch(() => undefined);
    }
  }, [appUiPreferences.playerVolume]);

  useEffect(() => {
    setPlaybackSpeed((current) =>
      current === appUiPreferences.playerSpeed ? current : appUiPreferences.playerSpeed,
    );

    if (mpvInitializedRef.current) {
      void setProperty('speed', appUiPreferences.playerSpeed).catch(() => undefined);
    }
  }, [appUiPreferences.playerSpeed]);

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
    playbackVerifiedAtRef.current = 0;
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
    const target = buildEpisodeStreamTarget(
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

  const skipDurationHint = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  const canFetchSkipTimes =
    skipTimesEnabled && !!skipTimesEpisode && (!isAnime || duration > 0 || hasPlaybackStarted);

  const { data: rawSkipSegments = [] } = useQuery<SkipSegment[]>({
    queryKey: [
      'skip-times',
      effectiveResolveMediaType,
      id,
      details?.imdbId,
      resolvedAbsoluteSeason,
      resolvedAbsoluteEpisode,
      skipTimesEpisode,
      skipDurationHint,
    ],
    queryFn: () =>
      api.getSkipTimes(
        effectiveResolveMediaType,
        id!,
        details?.imdbId ?? undefined,
        resolvedAbsoluteSeason,
        skipTimesEpisode,
        duration > 0 ? duration : undefined,
      ),
    enabled: canFetchSkipTimes,
    staleTime: 1000 * 60 * 60 * 12, // 12 h - crowdsourced data changes rarely
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  const skipSegments = rawSkipSegments;

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

  const {
    audioTracks,
    subTracks,
    trackSwitching,
    subtitlesOff,
    playbackLanguagePreferences,
    refreshTracks,
    setTrack,
  } = usePlayerTrackController({
    mediaId: id,
    mediaType: effectiveResolveMediaType,
    activeStreamUrl,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    resetKey: `${activeStreamUrl ?? 'stream'}:${id ?? 'id'}:${season ?? 'season'}:${episode ?? 'episode'}`,
  });

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

  const displaySeason = resolvedAbsoluteSeason;
  const displayEpisode = resolvedAbsoluteEpisode;

  // -- Helpers --

  const setTransparent = useCallback((transparent: boolean) => {
    const val = transparent ? 'transparent' : 'black';
    document.body.style.backgroundColor = val;
    document.documentElement.style.backgroundColor = val;
    const root = document.getElementById('root');
    if (root) root.style.backgroundColor = val;
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

  usePlayerSurfaceLayout({
    playerContainerRef,
    topChromeRef,
    bottomChromeRef,
    episodesPanelFrameRef,
    refreshToken: surfaceLayoutRefreshToken,
    activeStreamUrl,
    mpvSurfaceReady,
    isFullscreen,
    isLoading,
    isResolving,
    hasError: !!error,
    showErrorOverlay,
    showEpisodes,
    showStreamSelector,
    showDownloadModal,
  });

  const reopenSelectorForSavedStreamFailure = useCallback(() => {
    setError(null);
    setIsResolving(false);
    setResolveStatus('');
    setShowControls(true);
    setShowEpisodes(false);
    setSelectedEpisodeStreamTarget(null);
    setSelectedEpisodeForStream(currentEpisodeFromAbsoluteRoute ?? currentEpisodeFromRoute);
    setShowStreamSelector(true);
  }, [currentEpisodeFromAbsoluteRoute, currentEpisodeFromRoute]);

  const {
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
  } = useStreamRecovery({
    activeStreamUrl,
    preparedBackupStream,
    isHistoryResume,
    isOffline,
    mediaType: effectiveResolveMediaType,
    mediaId: id,
    title,
    resolveSeason: resolvedStreamSeason,
    resolveEpisode: resolvedStreamEpisode,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamLookupId,
    currentTimeRef,
    durationRef,
    mountedRef,
    lastStreamUrlRef,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    selectedStreamKeyRef,
    errorRef,
    stopLoading,
    setError,
    setIsResolving,
    setResolveStatus,
    setActiveStreamUrl,
    onSavedStreamUnavailable: reopenSelectorForSavedStreamFailure,
    reportStreamFailure,
  });

  const markPlaybackReady = useCallback(() => {
    markPlaybackStarted();
    stopLoading(true);
    setHasPlaybackStarted(true);
    playbackVerifiedAtRef.current = performance.now();
    setError(null);
    // Cancel any pending force-show error timers — playback is confirmed good
    clearTimer(forceShowTimeoutRef);
    setShowControls(true);
    clearTimer(controlsTimeoutRef);
    if (isPlayingRef.current) {
      controlsTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current && isPlayingRef.current) {
          setShowControls(false);
        }
        controlsTimeoutRef.current = null;
      }, PLAYBACK_READY_AUTO_HIDE_DELAY_MS);
    }
    reportStreamVerified();
  }, [markPlaybackStarted, reportStreamVerified, stopLoading]);

  const scheduleControlsAutoHide = useCallback((delayMs = CONTROLS_AUTO_HIDE_DELAY_MS) => {
    clearTimer(controlsTimeoutRef);
    controlsTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && isPlayingRef.current) {
        setShowControls(false);
      }
      controlsTimeoutRef.current = null;
    }, delayMs);
  }, []);

  const cancelPendingSingleClick = useCallback(() => {
    clearTimer(singleClickTimerRef);
  }, []);

  const clearUiTimers = useCallback(() => {
    clearTimer(controlsTimeoutRef);
    clearTimer(forceShowTimeoutRef);
    clearTimer(osdTimerRef);
    clearTimer(osdClearTimerRef);
    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }
    cancelPendingSingleClick();
  }, [cancelPendingSingleClick]);

  /**
   * Briefly show a centred on-screen indicator for keyboard/pointer actions.
   * The indicator fades out after ~1.1 s and is fully removed after the transition.
   */
  const triggerOsd = useCallback((action: PlayerOsdAction) => {
    clearTimer(osdTimerRef);
    clearTimer(osdClearTimerRef);
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
          ? 2800
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

  // Keep refs in sync so MPV init effect reads latest versions without dep changes.
  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  const prepareForPlayerNavigation = useCallback(async () => {
    prepareForInternalPlayerNavigation();
    setShowControls(true);
    setShowEpisodes(false);
    await flushPlaybackBeforeNavigation();
    allowNextNavigation();
  }, [allowNextNavigation, flushPlaybackBeforeNavigation, prepareForInternalPlayerNavigation]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    saveProgressRef.current?.();
  }, []);

  useEffect(() => {
    handleEndedRef.current = handleEnded;
  }, [handleEnded]);

  const clearOptimisticSeek = useCallback(() => {
    pendingSeekTargetRef.current = null;
    pendingSeekDeadlineRef.current = 0;
  }, []);

  usePlayerMpvLifecycle({
    activeStreamUrl,
    isOffline,
    isHistoryResume,
    isDev,
    playbackSpeed,
    subtitleDelay,
    subtitlePos,
    subtitleScale,
    playbackLanguagePreferencesRef,
    volumeRef,
    mountedRef,
    isDestroyedRef,
    mpvInitializedRef,
    isLoadingRef,
    isPlayingRef,
    currentTimeRef,
    durationRef,
    pendingSeekTargetRef,
    pendingSeekDeadlineRef,
    lastTimeUpdateRef,
    playbackVerifiedAtRef,
    errorRef,
    forceShowTimeoutRef,
    handleEndedRef,
    saveProgressRef,
    lastStreamUrlRef,
    setIsResolving,
    setResolveStatus,
    setIsLoading,
    setError,
    setCurrentTime,
    setDuration,
    setIsPlaying,
    setVolume,
    setIsMuted,
    setPlaybackSpeed,
    setMpvSurfaceReady,
    setSurfaceLayoutRefreshToken,
    clearUiTimers,
    clearResumeRetryTimer,
    clearRecoveryTimers,
    prepareForStreamLoad,
    markPlaybackReady,
    applyResumeIfReady,
    clearOptimisticSeek,
    refreshTracks,
    reportStreamFailure,
    recoverFromSlowStartup,
    reopenSelectorForSavedStreamFailure,
    stopLoading,
    setTransparent,
    restorePlayerSurface,
  });

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

      const startTime = await getLatestEpisodeResumeStartTime(
        id,
        effectiveResolveMediaType,
        target.absoluteSeason,
        target.absoluteEpisode,
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
        startTime,
        lookupKey: buildEpisodeStreamTargetLookupKey(effectiveResolveMediaType, target),
      });
      setShowStreamSelector(true);
      setShowEpisodes(false);
    },
    [effectiveResolveMediaType, id, streamLookupId],
  );

  const openInlineStreamSelector = useCallback(async () => {
    if (!isSeriesLike || !id || !sidebarCurrentEpisode) return;
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

    const startTime = await getLatestEpisodeResumeStartTime(
      id,
      effectiveResolveMediaType,
      target.absoluteSeason,
      target.absoluteEpisode,
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
      startTime,
      lookupKey: buildEpisodeStreamTargetLookupKey(effectiveResolveMediaType, target),
    });
    setShowStreamSelector(true);
    setShowEpisodes(false);
  }, [
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
      void updateAppUiPreferences({ playerVolume: newVol });
      await setProperty('volume', newVol);
      if (newVol > 0 && isMuted) {
        setIsMuted(false);
        await setProperty('mute', false);
      }
      triggerOsd({ kind: 'volume', level: newVol });
    },
    [isMuted, triggerOsd, updateAppUiPreferences],
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

  useEffect(() => {
    playbackLanguagePreferencesRef.current = {
      preferredAudioLanguage: playbackLanguagePreferences.preferredAudioLanguage,
      preferredSubtitleLanguage: playbackLanguagePreferences.preferredSubtitleLanguage,
    };
  }, [
    playbackLanguagePreferences.preferredAudioLanguage,
    playbackLanguagePreferences.preferredSubtitleLanguage,
  ]);

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
        case 'd':
          e.preventDefault();
          if (activeStreamUrl) setShowDownloadModal(true);
          break;
        case 'escape':
          if (showEpisodes) {
            setShowEpisodes(false);
            return;
          }
          if (isFullscreen) {
            e.preventDefault();
            void toggleFullscreen();
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
    activeStreamUrl,
    isFullscreen,
    showEpisodes,
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
              title,
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
    title,
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

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    scheduleControlsAutoHide();
  }, [scheduleControlsAutoHide]);

  const handleMouseLeave = useCallback(() => {
    if (!isPlaying) return;
    clearTimer(controlsTimeoutRef);
    setShowControls(false);
  }, [isPlaying]);

  // Hide cursor when controls are hidden during playback
  useEffect(() => {
    const container = playerContainerRef.current;
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
  }, [isPlaying, playerContainerRef, showControls]);

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
      if (shouldIgnorePlayerSurfaceInteraction(event)) return;

      // Close episode panel when clicking outside it
      if (showEpisodes) {
        setShowEpisodes(false);
        return;
      }

      if (isLoading || isResolving || error) return;

      // Delay single-click action so a double-click can cancel it.
      cancelPendingSingleClick();
      singleClickTimerRef.current = setTimeout(() => {
        singleClickTimerRef.current = null;
        setShowControls(true);
        triggerOsd({ kind: isPlayingRef.current ? 'pause' : 'play' });
        void togglePlay();
      }, 200);
    },
    [cancelPendingSingleClick, showEpisodes, isLoading, isResolving, error, togglePlay, triggerOsd],
  );

  const handlePlayerDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnorePlayerSurfaceInteraction(event)) return;

      // Cancel the pending single-click play/pause
      cancelPendingSingleClick();

      void toggleFullscreen();
    },
    [cancelPendingSingleClick, toggleFullscreen],
  );

  // -- Render Logic --
  // Don't show error overlay in the brief window before auto-resolve starts
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
  const selectorStartTime = isSelectorForCurrentEpisode
    ? currentTimeRef.current > 5
      ? currentTimeRef.current
      : startTime && startTime > 5
        ? startTime
        : 0
    : selectedEpisodeStreamTarget?.startTime ?? 0;
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
      onMouseLeave={handleMouseLeave}
      onClick={handlePlayerClick}
      onDoubleClick={handlePlayerDoubleClick}
      id='mpv-container'
    >
      {!isFullscreen && (
        <DesktopTitlebar className='z-[85] bg-gradient-to-b from-black/70 via-black/35 to-transparent backdrop-blur-[2px]' />
      )}
      {!isFullscreen && (
        <div
          className='fixed left-0 top-0 z-[70] h-screen pointer-events-auto'
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
            <button
              type='button'
              onClick={() => {
                void openInlineStreamSelector();
              }}
              className='rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors'
            >
              Choose Stream
            </button>
            <button
              type='button'
              onClick={navigateBack}
              className='rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors'
            >
              Go Back
            </button>
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
          'absolute inset-0 z-40 pointer-events-none flex flex-col transition-opacity duration-300 bg-gradient-to-b from-black/80 via-transparent to-black/90',
          'justify-between pb-6',
          !isFullscreen && 'pt-12',
          isFullscreen && 'pt-6',
          isFullscreen ? 'px-8' : 'pl-[84px] pr-6',
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        <div
          ref={topChromeRef}
          className='pointer-events-auto flex items-center justify-between'
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type='button'
            onClick={navigateBack}
            className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
          >
            <ArrowLeft className='w-5 h-5' />
          </button>
          <div className='text-center min-w-0 flex-1 mx-4'>
            <h1 className='text-[15px] font-semibold line-clamp-1 leading-snug'>{title}</h1>
            {displaySeason !== undefined && displayEpisode !== undefined && (
              <p className='text-xs text-white/50 mt-0.5'>
                S{displaySeason}:E{displayEpisode}
                {episodeCountInSeason ? ` / ${episodeCountInSeason}` : ''}
              </p>
            )}
          </div>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
            title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
          >
            {isFullscreen ? (
              <Minimize className='w-5 h-5' strokeWidth={2.5} />
            ) : (
              <Maximize className='w-5 h-5' strokeWidth={2.5} />
            )}
          </button>
        </div>

        {/* Center Play — shown when paused and OSD has fully cleared */}
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          {!isPlaying && !isLoading && !isResolving && !error && !osdVisible && (
            <button
              type='button'
              className='pointer-events-auto cursor-pointer outline-none transition-all duration-150 hover:scale-105 active:scale-95 animate-in fade-in duration-200'
              onClick={(e) => {
                e.stopPropagation();
                triggerOsd({ kind: 'play' });
                togglePlay();
              }}
            >
              <div className='flex h-14 w-14 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm'>
                <Play className='w-6 h-6 fill-white text-white ml-0.5' />
              </div>
            </button>
          )}
        </div>

        {/* Bottom Bar */}
        <div
          ref={bottomChromeRef}
          className='pointer-events-auto space-y-0'
          onClick={(e) => e.stopPropagation()}
        >
          {/* Time display — right-aligned above the progress bar */}
          <div className='flex items-center justify-end px-0.5 pb-2'>
            <div className='shrink-0'>
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
                className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
                title='Rewind 10s (←)'
              >
                <Rewind className='w-[18px] h-[18px]' strokeWidth={2.5} />
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
                className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
                title='Forward 10s (→)'
              >
                <FastForward className='w-[18px] h-[18px]' strokeWidth={2.5} />
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
                <button
                  type='button'
                  onClick={toggleMute}
                  className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 z-10 transition-colors'
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className='w-[18px] h-[18px]' strokeWidth={2.5} />
                  ) : volume < 50 ? (
                    <Volume1 className='w-[18px] h-[18px]' strokeWidth={2.5} />
                  ) : (
                    <Volume2 className='w-[18px] h-[18px]' strokeWidth={2.5} />
                  )}
                </button>

                <div
                  className={cn(
                    'transition-[width,opacity] duration-300 ease-in-out flex items-center gap-1.5',
                    isHoveringVolume
                      ? 'w-32 opacity-100 ml-0.5'
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
                  <span className='text-[10px] font-mono text-white/40 tabular-nums w-7 leading-none flex-shrink-0'>
                    {isMuted ? '0' : volume}%
                  </span>
                </div>
              </div>

              {/* Speed */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className={cn(
                      'flex h-9 items-center justify-center rounded-lg px-2 text-[11px] font-semibold tabular-nums transition-colors',
                      playbackSpeed === 1
                        ? 'text-white/50 hover:text-white hover:bg-white/10'
                        : 'text-primary hover:bg-white/10',
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {playbackSpeed}x
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side='top'
                  className='w-16 p-1 bg-black/90 border-white/10 backdrop-blur-xl'
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <div className='flex flex-col'>
                    {SPEED_OPTIONS.map((s) => (
                      <button
                        key={s}
                        type='button'
                        onClick={() => {
                          setPlaybackSpeed(s);
                          void updateAppUiPreferences({ playerSpeed: s });
                          void setProperty('speed', s);
                        }}
                        className={cn(
                          'h-6 rounded px-2 text-left text-[11px] tabular-nums transition-colors hover:bg-white/10',
                          s === playbackSpeed
                            ? 'text-primary font-semibold'
                            : 'text-white/70',
                        )}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className='flex items-center gap-1'>
              {/* Episodes List Toggle */}
              {details?.episodes && (
                <PlayerEpisodesToggleButton
                  open={showEpisodes}
                  onToggle={() => setShowEpisodes((prev) => !prev)}
                />
              )}

              {/* Stream / Quality Hot-Swap */}
              {isSeriesLike && !!id && (
                <button
                  type='button'
                  className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors'
                  title='Choose Stream / Quality'
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    void openInlineStreamSelector();
                  }}
                >
                  <ArrowLeftRight className='w-[18px] h-[18px]' strokeWidth={2.5} />
                </button>
              )}

              {/* Audio Track Selector */}
              <AudioTrackSelector
                audioTracks={audioTracks}
                trackSwitching={trackSwitching}
                onSelectTrack={(trackType, trackId, options) => {
                  void setTrack(trackType, trackId, options);
                }}
              />

              {/* Subtitle Track Selector */}
              <SubtitleTrackSelector
                subTracks={subTracks}
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

              {/* Download */}
              <button
                type='button'
                onClick={() => setShowDownloadModal(true)}
                className='flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:pointer-events-none'
                disabled={!activeStreamUrl}
              >
                <Download className='w-[18px] h-[18px]' strokeWidth={2.5} />
              </button>
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
      />

      <PlayerEpisodesPanel
        panelRef={episodesPanelFrameRef}
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
