import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
  ChevronDown,
  ChevronUp,
  Check,
  Download,
  PictureInPicture2,
  Rewind,
  FastForward,
  StepForward,
  ArrowLeftRight,
  Settings2,
} from 'lucide-react';
import { api, type Episode, type SkipSegment, type PlaybackLanguagePreferences } from '@/lib/api';
import { toast } from 'sonner';
import { usePrivacy } from '@/contexts/privacy-context';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as SliderPrimitive from '@radix-ui/react-slider';
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
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  normalizeLanguageToken,
  inferTrackPreferredLanguage,
  findTrackByLanguage,
  trackMatchesPreferredLanguage,
  normalizeTrackList,
  doesTrackSelectionMatch,
  formatTrackLabel,
} from '@/lib/player-track-utils';
import { useStreamRecovery } from '@/hooks/use-stream-recovery';
import { usePictureInPicture } from '@/hooks/use-picture-in-picture';

/** Trigger native window drag for PiP mode. Only fires on primary button. */
function startWindowDrag(e: React.MouseEvent | React.PointerEvent) {
  if (e.button !== 0) return;
  // Don't drag if the user clicked an interactive element
  const target = e.target as HTMLElement;
  if (target.closest('button, a, input, [role="button"]')) return;
  e.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch(() => {
      /* PiP drag not critical */
    });
}

// --- Types & Constants ---

const formatTime = (seconds: number) => {
  if (!seconds || isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const formatOsdResumeTime = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = Math.floor(whole % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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

interface EpisodeStreamCoordinates {
  streamLookupId: string;
  streamSeason: number;
  streamEpisode: number;
  absoluteSeason: number;
  absoluteEpisode: number;
  aniskipEpisode: number;
  lookupKey: string;
}

interface PlayerLoadingCopy {
  headline: string;
  detail: string;
}

function buildEpisodeStreamCoordinates(
  mediaType: string,
  fallbackLookupId: string,
  ep: Pick<Episode, 'season' | 'episode' | 'imdbId' | 'imdbSeason' | 'imdbEpisode'>,
): EpisodeStreamCoordinates {
  const streamLookupId = ep.imdbId || fallbackLookupId;
  const streamSeason = ep.imdbSeason || ep.season;
  const streamEpisode = ep.imdbEpisode || ep.episode;
  const absoluteSeason = ep.season;
  const absoluteEpisode = ep.episode;
  const aniskipEpisode = ep.imdbEpisode || ep.episode;
  const lookupKey = `${mediaType}:${streamLookupId}:${streamSeason}:${streamEpisode}:${absoluteEpisode}`;

  return {
    streamLookupId,
    streamSeason,
    streamEpisode,
    absoluteSeason,
    absoluteEpisode,
    aniskipEpisode,
    lookupKey,
  };
}

function findNextEpisodeCandidate(
  episodes: Episode[],
  currentSeason: number,
  currentEpisode: number,
): Episode | null {
  const ordered = [...episodes].sort((left, right) => {
    if (left.season !== right.season) return left.season - right.season;
    return left.episode - right.episode;
  });

  const exactIndex = ordered.findIndex(
    (ep) => ep.season === currentSeason && ep.episode === currentEpisode,
  );
  if (exactIndex >= 0) {
    return ordered[exactIndex + 1] ?? null;
  }

  const nextInSeason = ordered.find(
    (ep) => ep.season === currentSeason && ep.episode > currentEpisode,
  );
  if (nextInSeason) return nextInSeason;

  return ordered.find((ep) => ep.season > currentSeason) ?? null;
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
const TRACK_SWITCH_VERIFY_ATTEMPTS = 8;
const TRACK_SWITCH_VERIFY_DELAY_MS = 150;
const RESUME_SEEK_MAX_ATTEMPTS = 6;
const RESUME_SEEK_RETRY_DELAY_MS = 220;
const RESUME_SEEK_SETTLE_TOLERANCE_SECS = 2;

const PlayerSlider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex w-full touch-none select-none items-center group/slider h-5 cursor-pointer',
      className,
    )}
    onClick={(e) => e.stopPropagation()}
    onPointerDown={(e) => e.stopPropagation()}
    {...props}
  >
    {/* Larger invisible hit target behind the track */}
    <SliderPrimitive.Track className='relative h-[4px] w-full grow overflow-hidden rounded-full bg-white/20 group-hover/slider:h-[6px] transition-[height] duration-150'>
      <SliderPrimitive.Range className='absolute h-full bg-white' />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className='block w-4 h-4 opacity-0 cursor-pointer' />
  </SliderPrimitive.Root>
));
PlayerSlider.displayName = SliderPrimitive.Root.displayName;

// --- OSD Action type ---

type OsdAction =
  | { kind: 'play' | 'pause' }
  | { kind: 'seek'; direction: 'forward' | 'backward'; seconds: number }
  | { kind: 'volume'; level: number }
  | { kind: 'message'; text: string };

// --- Component ---

export function Player() {
  const { season, episode } = useParams();
  // Force full remount on episode change to ensure clean state
  return <InnerPlayer key={`${season}:${episode}`} />;
}

function InnerPlayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { type, id, season, episode } = useParams();
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const isNavigatingAwayRef = useRef(false);

  // -- Params --
  const state = location.state as {
    streamUrl?: string;
    title?: string;
    poster?: string;
    backdrop?: string;
    logo?: string;
    format?: string;
    selectedStreamKey?: string;
    startTime?: number;
    absoluteSeason?: number;
    absoluteEpisode?: number;
    streamSeason?: number;
    streamEpisode?: number;
    aniskipEpisode?: number;
    resumeFromHistory?: boolean;
    streamLookupId?: string;
    bypassResolveCache?: boolean;
    from?: string;
    isOffline?: boolean;
    openingStreamName?: string;
    openingStreamSource?: string;
  } | null;

  // -- State --
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | undefined>(
    state?.streamUrl || undefined,
  );
  // Track the last route-provided streamUrl so the sync effect only fires on
  // genuine navigation changes, not on recovery-driven URL swaps.
  const lastRouteStreamUrlRef = useRef(state?.streamUrl);

  // Update stream URL if location state changes (e.g. manual stream selection for same episode)
  useEffect(() => {
    if (state?.streamUrl && state.streamUrl !== lastRouteStreamUrlRef.current) {
      lastRouteStreamUrlRef.current = state.streamUrl;
      setActiveStreamUrl(state.streamUrl);
    }
  }, [state?.streamUrl]);

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
  const [isFullscreen, setIsFullscreen] = useState(false);
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
    if (typeof state?.absoluteSeason === 'number' && Number.isFinite(state.absoluteSeason)) {
      return state.absoluteSeason;
    }
    return season ? parseInt(season, 10) : 1;
  });
  const [isHoveringVolume, setIsHoveringVolume] = useState(false);
  const [subtitleScale, setSubtitleScale] = useState(1.0);

  // Stream Selector State
  const [showStreamSelector, setShowStreamSelector] = useState(false);
  const [selectedEpisodeForStream, setSelectedEpisodeForStream] = useState<Episode | null>(null);

  const [showDownloadModal, setShowDownloadModal] = useState(false);

  // OSD (on-screen display) for keyboard/mouse action feedback
  const [osdAction, setOsdAction] = useState<OsdAction | null>(null);
  const [osdVisible, setOsdVisible] = useState(false);

  // Up-Next / Auto-Next countdown overlay
  const [showUpNext, setShowUpNext] = useState(false);
  const [upNextCountdown, setUpNextCountdown] = useState(10);

  const routeSeason = season ? parseInt(season, 10) : undefined;
  const routeEpisode = episode ? parseInt(episode, 10) : undefined;
  const routeAbsoluteSeason =
    typeof state?.absoluteSeason === 'number' && Number.isFinite(state.absoluteSeason)
      ? state.absoluteSeason
      : routeSeason;
  const routeAniSkipEpisode =
    typeof state?.aniskipEpisode === 'number' && Number.isFinite(state.aniskipEpisode)
      ? state.aniskipEpisode
      : undefined;
  const routeAbsoluteEpisode =
    typeof state?.absoluteEpisode === 'number' && Number.isFinite(state.absoluteEpisode)
      ? state.absoluteEpisode
      : routeEpisode;
  const routeStreamSeason =
    typeof state?.streamSeason === 'number' && Number.isFinite(state.streamSeason)
      ? state.streamSeason
      : undefined;
  const routeStreamEpisode =
    typeof state?.streamEpisode === 'number' && Number.isFinite(state.streamEpisode)
      ? state.streamEpisode
      : undefined;

  // Remaining time mode: click the clock to toggle between elapsed and remaining
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const watchHistoryInvalidatedRef = useRef(false);

  const title = state?.title || 'Unknown Title';
  const backdrop = state?.backdrop;
  const startTime = state?.startTime;
  const isHistoryResume = !!state?.resumeFromHistory;
  const routeStreamLookupId = state?.streamLookupId;
  const shouldBypassResolveCache = !!state?.bypassResolveCache;
  const isOffline =
    !!state?.isOffline || (!!activeStreamUrl && !activeStreamUrl.startsWith('http'));
  const effectiveResolveMediaType: 'movie' | 'series' | 'anime' =
    type === 'anime' || (type === 'series' && (id?.startsWith('kitsu:') ?? false))
      ? 'anime'
      : type === 'movie'
        ? 'movie'
        : 'series';

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

  const exitFullscreenIfNeeded = useCallback(async () => {
    if (!document.fullscreenElement) return;
    await document.exitFullscreen().catch(() => undefined);
    setIsFullscreen(false);
  }, []);

  const { isPiP, togglePiP, exitPiPAndRestore } = usePictureInPicture({
    onBeforeEnter: async () => {
      await exitFullscreenIfNeeded();
      setShowEpisodes(false);
    },
  });

  const invalidateWatchHistoryOnce = useCallback(() => {
    if (watchHistoryInvalidatedRef.current) return;
    watchHistoryInvalidatedRef.current = true;
    void queryClient.invalidateQueries({ queryKey: ['watch-history'] });
  }, [queryClient]);

  // Intelligent back navigation: replace the player in history so pressing back
  // from the destination page never re-launches the player.
  const navigateBack = useCallback(() => {
    if (isNavigatingAwayRef.current) return;
    isNavigatingAwayRef.current = true;

    void exitPiPAndRestore();

    setShowControls(true);
    setShowEpisodes(false);
    restorePlayerSurface();
    void exitFullscreenIfNeeded();

    // Invalidate the watch-history cache so Continue Watching updates immediately
    // on the home page without waiting for the stale-time window to expire.
    invalidateWatchHistoryOnce();

    const backSeason = selectedEpisodeForStream?.season ?? routeAbsoluteSeason;
    const backEpisode = selectedEpisodeForStream?.episode ?? routeAbsoluteEpisode;
    const reopenSelectorState = {
      reopenStreamSelector: true,
      reopenStreamSeason: backSeason,
      reopenStreamEpisode: backEpisode,
      reopenStartTime: currentTimeRef.current > 5 ? currentTimeRef.current : undefined,
    };

    const from = state?.from;
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
    invalidateWatchHistoryOnce,
    selectedEpisodeForStream?.season,
    selectedEpisodeForStream?.episode,
    routeAbsoluteSeason,
    routeAbsoluteEpisode,
    exitFullscreenIfNeeded,
    exitPiPAndRestore,
    state?.from,
    effectiveResolveMediaType,
    id,
    restorePlayerSurface,
  ]);

  // -- Refs --
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const forceShowTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTimeUpdateRef = useRef(0);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const isDestroyedRef = useRef(false);
  const mountedRef = useRef(true);
  const initialTimeRef = useRef(0);
  const resumeTimeRef = useRef(0);
  const resumeAppliedRef = useRef(false);
  const resumeSeekAttemptsRef = useRef(0);
  const resumeSeekInFlightRef = useRef(false);
  const resumeSeekRetryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resumePausePendingRef = useRef(false);
  const resumeOsdShownRef = useRef(false);
  const lastStreamUrlRef = useRef(activeStreamUrl);
  const volumeRef = useRef(volume);
  const isLoadingRef = useRef(true);
  const saveProgressInFlightRef = useRef(false);
  const saveProgressQueuedRef = useRef(false);
  // Stable refs for callbacks used in the MPV init effect — avoids restarting MPV
  // when async data (details, nextEpisode) changes these callback identities.
  const saveProgressRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const handleEndedRef = useRef<(() => void) | undefined>(undefined);
  const lastAutoResolveLookupIdRef = useRef<string | null>(null);
  const upNextIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const errorRef = useRef<string | null>(error);
  const activeStreamFormatRef = useRef<string | undefined>(state?.format);

  const nextEpisodePrefetchRef = useRef<{
    lookupKey: string;
    season: number;
    episode: number;
    url: string;
    format: string;
  } | null>(null);
  const nextEpisodePrefetchInFlightRef = useRef(false);
  const nextEpisodePrefetchLookupKeyRef = useRef<string | null>(null);
  const osdTimerRef = useRef<NodeJS.Timeout | null>(null);
  /** Always-current playing state — used in closures to avoid stale captures. */
  const isPlayingRef = useRef(false);
  const isDev = import.meta.env.DEV;
  const autoAppliedTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const autoApplyingTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const trackSwitchingRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const trackListRef = useRef<Track[]>([]);
  const streamLookupIdRef = useRef<string | undefined>(routeStreamLookupId || id || undefined);
  const selectedStreamKeyRef = useRef<string | undefined>(state?.selectedStreamKey);
  const leftTapTimerRef = useRef<NodeJS.Timeout | null>(null);
  const rightTapTimerRef = useRef<NodeJS.Timeout | null>(null);
  const centerTapTimerRef = useRef<NodeJS.Timeout | null>(null);
  const applyResumeIfReadyRef = useRef<() => Promise<void>>(async () => undefined);

  // Component mount state must survive stream swaps so stale-link recovery can
  // tear down MPV and immediately re-enter auto-resolve on the same screen.
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    lastStreamUrlRef.current = activeStreamUrl;
  }, [activeStreamUrl]);

  useEffect(() => {
    if (state?.streamUrl && activeStreamUrl === state.streamUrl) {
      activeStreamFormatRef.current = state?.format;
    }
  }, [state?.streamUrl, state?.format, activeStreamUrl]);

  useEffect(() => {
    if (!state?.streamUrl) {
      selectedStreamKeyRef.current = undefined;
      return;
    }

    if (activeStreamUrl === state.streamUrl) {
      selectedStreamKeyRef.current = state.selectedStreamKey?.trim() || undefined;
      return;
    }

    selectedStreamKeyRef.current = undefined;
  }, [activeStreamUrl, state?.streamUrl, state?.selectedStreamKey]);

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
    return buildEpisodeStreamCoordinates(
      type,
      routeStreamLookupId || details?.imdbId || id,
      sidebarCurrentEpisode,
    );
  }, [sidebarCurrentEpisode, type, id, routeStreamLookupId, details?.imdbId]);

  const { data: playbackLanguagePreferences } = useQuery({
    queryKey: ['playbackLanguagePreferences'],
    queryFn: api.getPlaybackLanguagePreferences,
    staleTime: 1000 * 60 * 5,
  });

  const playbackPrefsRef = useRef<PlaybackLanguagePreferences>({});
  const playbackPrefsHydratedRef = useRef(false);
  const savePlaybackPrefsQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    const normalized = {
      preferredAudioLanguage:
        normalizeLanguageToken(playbackLanguagePreferences?.preferredAudioLanguage) || undefined,
      preferredSubtitleLanguage:
        normalizeLanguageToken(playbackLanguagePreferences?.preferredSubtitleLanguage) || undefined,
    };
    playbackPrefsRef.current = normalized;
    playbackPrefsHydratedRef.current = true;
    queryClient.setQueryData(['playbackLanguagePreferences'], normalized);
  }, [
    playbackLanguagePreferences?.preferredAudioLanguage,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
    queryClient,
  ]);

  const savePlaybackPreferencesPatch = useCallback(
    (patch: Partial<PlaybackLanguagePreferences>) => {
      const normalizedPatch: Partial<PlaybackLanguagePreferences> = {
        preferredAudioLanguage:
          patch.preferredAudioLanguage === undefined
            ? undefined
            : normalizeLanguageToken(patch.preferredAudioLanguage) || undefined,
        preferredSubtitleLanguage:
          patch.preferredSubtitleLanguage === undefined
            ? undefined
            : normalizeLanguageToken(patch.preferredSubtitleLanguage) || undefined,
      };

      const saveTask = async () => {
        if (!playbackPrefsHydratedRef.current) {
          const fresh = await api.getPlaybackLanguagePreferences();
          playbackPrefsRef.current = {
            preferredAudioLanguage:
              normalizeLanguageToken(fresh?.preferredAudioLanguage) || undefined,
            preferredSubtitleLanguage:
              normalizeLanguageToken(fresh?.preferredSubtitleLanguage) || undefined,
          };
          playbackPrefsHydratedRef.current = true;
        }

        const next: PlaybackLanguagePreferences = {
          ...playbackPrefsRef.current,
          ...normalizedPatch,
        };

        playbackPrefsRef.current = next;

        await api.savePlaybackLanguagePreferences(
          next.preferredAudioLanguage,
          next.preferredSubtitleLanguage,
        );

        queryClient.setQueryData(['playbackLanguagePreferences'], next);
      };

      const queued = savePlaybackPrefsQueueRef.current.then(saveTask);
      savePlaybackPrefsQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    [queryClient],
  );

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

  const nextEpisode = useMemo(() => {
    if (
      details?.episodes &&
      resolvedAbsoluteSeason !== undefined &&
      resolvedAbsoluteEpisode !== undefined
    ) {
      return findNextEpisodeCandidate(
        details.episodes,
        resolvedAbsoluteSeason,
        resolvedAbsoluteEpisode,
      );
    }
    return null;
  }, [details?.episodes, resolvedAbsoluteEpisode, resolvedAbsoluteSeason]);

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

  useEffect(() => {
    streamLookupIdRef.current = streamLookupId || undefined;
  }, [streamLookupId]);

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
      if (isHistoryResume && state?.streamUrl && activeStreamUrl === state.streamUrl) {
        return {
          headline: startTime && startTime > 5 ? 'Restoring saved stream' : 'Opening saved stream',
          detail: 'Using your last working stream first so Continue Watching feels immediate.',
        };
      }

      if (state?.openingStreamName) {
        return {
          headline: 'Opening selected stream',
          detail: state.openingStreamSource?.trim() || state.openingStreamName.trim(),
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
    state?.openingStreamName,
    state?.openingStreamSource,
    state?.streamUrl,
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

  const audioTrackLabels = useMemo(() => {
    const counts = new Map<string, number>();
    audioTracks.forEach((track) => {
      const label = formatTrackLabel(track);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });

    return new Map<number, string>(
      audioTracks.map((track) => {
        const label = formatTrackLabel(track);
        if ((counts.get(label) ?? 0) > 1) return [track.id, `${label} #${track.id}`];
        return [track.id, label];
      }),
    );
  }, [audioTracks]);

  const subTrackLabels = useMemo(() => {
    const counts = new Map<string, number>();
    subTracks.forEach((track) => {
      const label = formatTrackLabel(track);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });

    return new Map<number, string>(
      subTracks.map((track) => {
        const label = formatTrackLabel(track);
        if ((counts.get(label) ?? 0) > 1) return [track.id, `${label} #${track.id}`];
        return [track.id, label];
      }),
    );
  }, [subTracks]);

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
    initialStreamUrl: state?.streamUrl,
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
    errorRef,
    beginLoading,
    stopLoading,
    setError,
    setIsResolving,
    setResolveStatus,
    setActiveStreamUrl,
  });

  const markPlaybackReady = useCallback(() => {
    markPlaybackStarted();
    stopLoading(true);
    setHasPlaybackStarted(true);
    setError(null);
  }, [markPlaybackStarted, stopLoading]);

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
    if (upNextIntervalRef.current) {
      clearInterval(upNextIntervalRef.current);
      upNextIntervalRef.current = null;
    }
  }, []);

  const clearResumeRetryTimer = useCallback(() => {
    if (resumeSeekRetryTimerRef.current) {
      clearTimeout(resumeSeekRetryTimerRef.current);
      resumeSeekRetryTimerRef.current = null;
    }
  }, []);

  const releaseResumePause = useCallback(async () => {
    if (!resumePausePendingRef.current || !mountedRef.current || isDestroyedRef.current) return;

    resumePausePendingRef.current = false;

    try {
      await setProperty('pause', false);
    } catch {
      try {
        await command('set', ['pause', 'no']);
      } catch {
        // Best-effort only.
      }
    }
  }, []);

  /**
   * Briefly show a centred on-screen indicator for keyboard/pointer actions.
   * The indicator fades out after ~1.1 s and is fully removed after the transition.
   */
  const triggerOsd = useCallback((action: OsdAction) => {
    setOsdAction(action);
    setOsdVisible(true);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    // Play/pause feedback is more intrusive — dismiss it faster than seek/volume.
    const visibleMs =
      action.kind === 'play' || action.kind === 'pause'
        ? 550
        : action.kind === 'message'
          ? 1600
          : 1000;
    osdTimerRef.current = setTimeout(() => {
      setOsdVisible(false);
      osdTimerRef.current = setTimeout(() => setOsdAction(null), 200);
    }, visibleMs);
  }, []);

  const { isIncognito } = usePrivacy();

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const saveProgress = useCallback(async () => {
    if (!type || !id || id === 'local' || currentTimeRef.current < 5) return;
    if (isIncognito) return;

    if (saveProgressInFlightRef.current) {
      saveProgressQueuedRef.current = true;
      return;
    }

    saveProgressInFlightRef.current = true;

    try {
      do {
        saveProgressQueuedRef.current = false;

        await api.saveWatchProgress({
          id,
          type_: type,
          season: resolvedAbsoluteSeason,
          episode: resolvedAbsoluteEpisode,
          absolute_season: resolvedAbsoluteSeason,
          absolute_episode: resolvedAbsoluteEpisode,
          stream_season: resolvedStreamSeason,
          stream_episode: resolvedStreamEpisode,
          aniskip_episode: resolvedAniSkipEpisode,
          position: currentTimeRef.current,
          duration: durationRef.current,
          last_watched: Date.now(),
          title: title || 'Unknown',
          poster: state?.poster,
          backdrop: state?.backdrop,
          last_stream_url: lastStreamUrlRef.current,
          last_stream_format: activeStreamFormatRef.current,
          last_stream_lookup_id: streamLookupIdRef.current,
          last_stream_key: selectedStreamKeyRef.current,
        });
      } while (saveProgressQueuedRef.current);
    } finally {
      saveProgressInFlightRef.current = false;
    }
  }, [
    type,
    id,
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    resolvedStreamSeason,
    resolvedStreamEpisode,
    resolvedAniSkipEpisode,
    title,
    state,
    isIncognito,
  ]);

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

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    saveProgressRef.current?.();
    if (nextEpisode) {
      setShowControls(true);
      setShowUpNext(true);
      setUpNextCountdown(10);
      if (upNextIntervalRef.current) clearInterval(upNextIntervalRef.current);
      upNextIntervalRef.current = setInterval(() => {
        setUpNextCountdown((prev) => {
          if (prev <= 1) {
            if (upNextIntervalRef.current) {
              clearInterval(upNextIntervalRef.current);
              upNextIntervalRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
  }, [nextEpisode]);

  useEffect(() => {
    handleEndedRef.current = handleEnded;
  }, [handleEnded]);

  const dismissUpNext = useCallback(() => {
    setShowUpNext(false);
    if (upNextIntervalRef.current) {
      clearInterval(upNextIntervalRef.current);
      upNextIntervalRef.current = null;
    }
  }, []);

  const togglePlay = useCallback(async () => {
    await command('cycle', ['pause']);
  }, []);

  const seek = useCallback(async (seconds: number) => {
    await command('seek', [seconds.toString(), 'absolute']);
    setCurrentTime(seconds);
  }, []);

  const seekRelative = useCallback(
    async (seconds: number) => {
      await command('seek', [seconds.toString(), 'relative']);
      triggerOsd({
        kind: 'seek',
        direction: seconds > 0 ? 'forward' : 'backward',
        seconds: Math.abs(seconds),
      });
    },
    [triggerOsd],
  );

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Fallback: just toggle sidebar visibility if Fullscreen API unavailable
      setIsFullscreen((prev) => !prev);
    }
  }, []);

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

  const finalizeResume = useCallback(
    async (resumeTime: number, didSeek: boolean) => {
      if (!resumeAppliedRef.current) {
        resumeAppliedRef.current = true;
      }

      resumeSeekInFlightRef.current = false;
      resumeSeekAttemptsRef.current = 0;
      clearResumeRetryTimer();

      if (didSeek && isHistoryResume && resumeTime > 60 && !resumeOsdShownRef.current) {
        resumeOsdShownRef.current = true;
        triggerOsd({ kind: 'message', text: `Resuming from ${formatOsdResumeTime(resumeTime)}` });
      }

      await releaseResumePause();
    },
    [clearResumeRetryTimer, isHistoryResume, releaseResumePause, triggerOsd],
  );

  const scheduleResumeRetry = useCallback((delayMs = RESUME_SEEK_RETRY_DELAY_MS) => {
    if (resumeAppliedRef.current || resumeSeekRetryTimerRef.current) return;

    resumeSeekRetryTimerRef.current = setTimeout(() => {
      resumeSeekRetryTimerRef.current = null;
      void applyResumeIfReadyRef.current();
    }, delayMs);
  }, []);

  const applyResumeIfReady = useCallback(async () => {
    const resumeTime = resumeTimeRef.current || initialTimeRef.current;

    if (resumeAppliedRef.current) {
      await releaseResumePause();
      return;
    }

    if (resumeTime <= 5) {
      clearResumeRetryTimer();
      await releaseResumePause();
      return;
    }

    const durationValue = durationRef.current;
    if (durationValue > 0 && resumeTime >= Math.max(5, durationValue - 5)) {
      await finalizeResume(resumeTime, false);
      return;
    }

    const satisfiedResumeTime = Math.max(0, resumeTime - RESUME_SEEK_SETTLE_TOLERANCE_SECS);
    if (currentTimeRef.current >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    if (resumeSeekInFlightRef.current) return;

    if (resumeSeekAttemptsRef.current >= RESUME_SEEK_MAX_ATTEMPTS) {
      await finalizeResume(resumeTime, false);
      return;
    }

    resumeSeekInFlightRef.current = true;
    resumeSeekAttemptsRef.current += 1;

    try {
      await command('seek', [resumeTime.toString(), 'absolute']);
    } catch {
      // MPV may reject early seeks before stream metadata is ready.
    } finally {
      resumeSeekInFlightRef.current = false;
    }

    if (currentTimeRef.current >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    scheduleResumeRetry(durationValue > 0 ? 140 : RESUME_SEEK_RETRY_DELAY_MS);
  }, [clearResumeRetryTimer, finalizeResume, releaseResumePause, scheduleResumeRetry]);

  useEffect(() => {
    applyResumeIfReadyRef.current = applyResumeIfReady;
  }, [applyResumeIfReady]);

  useEffect(() => {
    resumeAppliedRef.current = false;
    resumeSeekAttemptsRef.current = 0;
    resumeSeekInFlightRef.current = false;
    resumePausePendingRef.current = false;
    resumeOsdShownRef.current = false;
    clearResumeRetryTimer();
  }, [activeStreamUrl, clearResumeRetryTimer]);

  const playNext = useCallback(async () => {
    if (!nextEpisode || !type || !id) return;

    const nextEpisodeStream = buildEpisodeStreamCoordinates(
      type,
      streamLookupId || id,
      nextEpisode,
    );

    const targetRoute = `/player/${effectiveResolveMediaType}/${id}/${nextEpisodeStream.absoluteSeason}/${nextEpisodeStream.absoluteEpisode}`;

    const nextEpisodeLookupKey = nextEpisodeStream.lookupKey;

    const prefetched = nextEpisodePrefetchRef.current;
    const hasPrefetched =
      prefetched &&
      prefetched.lookupKey === nextEpisodeLookupKey &&
      prefetched.season === nextEpisodeStream.absoluteSeason &&
      prefetched.episode === nextEpisodeStream.absoluteEpisode;

    const baseState = {
      title,
      poster: state?.poster,
      backdrop,
      logo: state?.logo,
      startTime: 0,
      absoluteSeason: nextEpisodeStream.absoluteSeason,
      absoluteEpisode: nextEpisodeStream.absoluteEpisode,
      streamSeason: nextEpisodeStream.streamSeason,
      streamEpisode: nextEpisodeStream.streamEpisode,
      aniskipEpisode: nextEpisodeStream.aniskipEpisode,
      streamLookupId: nextEpisodeStream.streamLookupId,
      from: state?.from, // Propagate origin so back nav stays consistent
    };

    if (hasPrefetched) {
      navigate(targetRoute, {
        state: {
          ...baseState,
          streamUrl: prefetched.url,
          format: prefetched.format,
        },
      });
      return;
    }

    try {
      const resolved = await api.resolveBestStream(
        effectiveResolveMediaType,
        nextEpisodeStream.streamLookupId,
        nextEpisodeStream.streamSeason,
        nextEpisodeStream.streamEpisode,
        nextEpisodeStream.absoluteEpisode,
      );

      navigate(targetRoute, {
        state: {
          ...baseState,
          streamUrl: resolved.url,
          format: resolved.format,
        },
      });
      return;
    } catch {
      // Fallback to route transition and let page auto-resolve.
    }

    navigate(targetRoute, {
      state: {
        ...baseState,
      },
    });
  }, [
    nextEpisode,
    navigate,
    type,
    effectiveResolveMediaType,
    id,
    title,
    state?.poster,
    state?.logo,
    state?.from,
    backdrop,
    streamLookupId,
  ]);

  // Auto-navigate when the up-next countdown expires
  useEffect(() => {
    if (showUpNext && upNextCountdown === 0) {
      setShowUpNext(false);
      void playNext();
    }
  }, [showUpNext, upNextCountdown, playNext]);

  const playEpisode = useCallback(
    async (ep: Episode) => {
      // Instead of auto-playing, open the stream selector
      // We pause current playback just in case, but keep player visible until new selection
      try {
        await setProperty('pause', true);
      } catch {
        /* ignore */
      }
      setIsPlaying(false);
      dismissUpNext();

      setSelectedEpisodeForStream(ep);
      setShowStreamSelector(true);
      setShowEpisodes(false);
    },
    [dismissUpNext],
  );

  const openInlineStreamSelector = useCallback(() => {
    if (!isSeriesLike || !id) return;
    dismissUpNext();
    setSelectedEpisodeForStream(sidebarCurrentEpisode);
    setShowStreamSelector(true);
    setShowEpisodes(false);
  }, [isSeriesLike, id, sidebarCurrentEpisode, dismissUpNext]);

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

        if (type === 'audio') {
          const selectedAudio = audioTracks.find((track) => track.id === id);
          const pref = inferTrackPreferredLanguage(selectedAudio ?? { id: -1, type: 'audio' });
          if (!pref) return;
          void savePlaybackPreferencesPatch({ preferredAudioLanguage: pref });
          return;
        }

        if (id === 'no') {
          void savePlaybackPreferencesPatch({ preferredSubtitleLanguage: 'off' });
          return;
        }

        const selectedSubtitle = subTracks.find((track) => track.id === id);
        const pref = inferTrackPreferredLanguage(selectedSubtitle ?? { id: -1, type: 'sub' });
        if (!pref) return;
        void savePlaybackPreferencesPatch({ preferredSubtitleLanguage: pref });
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
      audioTracks,
      confirmTrackSwitch,
      savePlaybackPreferencesPatch,
      setTrackSwitchingFlag,
      subTracks,
      subtitlesOff,
    ],
  );

  useEffect(() => {
    autoAppliedTrackPrefsRef.current = { audio: false, sub: false };
    autoApplyingTrackPrefsRef.current = { audio: false, sub: false };
    trackSwitchingRef.current = { audio: false, sub: false };

    const timer = window.setTimeout(() => {
      setTrackSwitching({ audio: false, sub: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeStreamUrl, id, season, episode]);

  useEffect(() => {
    const audioPref = normalizeLanguageToken(playbackLanguagePreferences?.preferredAudioLanguage);
    if (isLoading) return;
    if (!audioPref) return;
    if (autoAppliedTrackPrefsRef.current.audio || autoApplyingTrackPrefsRef.current.audio) return;
    if (trackSwitching.audio || trackSwitching.sub) return;
    if (audioTracks.length === 0) return;

    const selectedAudio = audioTracks.find((track) => !!track.selected) ?? null;
    if (trackMatchesPreferredLanguage(selectedAudio, audioPref)) {
      autoAppliedTrackPrefsRef.current.audio = true;
      return;
    }

    const match = findTrackByLanguage(audioTracks, audioPref);
    if (!match) {
      autoAppliedTrackPrefsRef.current.audio = true;
      return;
    }

    autoApplyingTrackPrefsRef.current.audio = true;
    void setTrack('audio', match.id, { silent: true }).finally(() => {
      autoApplyingTrackPrefsRef.current.audio = false;
      autoAppliedTrackPrefsRef.current.audio = true;
    });
  }, [
    audioTracks,
    playbackLanguagePreferences?.preferredAudioLanguage,
    isLoading,
    setTrack,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);

  useEffect(() => {
    const subtitlePref = normalizeLanguageToken(
      playbackLanguagePreferences?.preferredSubtitleLanguage,
    );
    if (isLoading) return;
    if (!subtitlePref) return;
    if (autoApplyingTrackPrefsRef.current.audio) return;
    if (autoAppliedTrackPrefsRef.current.sub || autoApplyingTrackPrefsRef.current.sub) return;
    if (trackSwitching.audio || trackSwitching.sub) return;

    if (subtitlePref === 'off') {
      const hasSelectedSubtitle = subTracks.some((track) => !!track.selected);
      if (!hasSelectedSubtitle) {
        autoAppliedTrackPrefsRef.current.sub = true;
        return;
      }

      autoApplyingTrackPrefsRef.current.sub = true;
      void setTrack('sub', 'no', { silent: true }).finally(() => {
        autoApplyingTrackPrefsRef.current.sub = false;
        autoAppliedTrackPrefsRef.current.sub = true;
      });
      return;
    }

    if (subTracks.length === 0) return;

    const selectedSubtitle = subTracks.find((track) => !!track.selected) ?? null;
    if (trackMatchesPreferredLanguage(selectedSubtitle, subtitlePref)) {
      autoAppliedTrackPrefsRef.current.sub = true;
      return;
    }

    const match = findTrackByLanguage(subTracks, subtitlePref);
    if (!match) {
      autoAppliedTrackPrefsRef.current.sub = true;
      return;
    }

    autoApplyingTrackPrefsRef.current.sub = true;
    void setTrack('sub', match.id, { silent: true }).finally(() => {
      autoApplyingTrackPrefsRef.current.sub = false;
      autoAppliedTrackPrefsRef.current.sub = true;
    });
  }, [
    isLoading,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
    setTrack,
    subTracks,
    trackSwitching.audio,
    trackSwitching.sub,
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
        case 'p':
          e.preventDefault();
          void togglePiP();
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
    togglePiP,
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
          api.resolveBestStream(
            effectiveResolveMediaType,
            lookupId,
            s,
            e,
            abs,
            shouldBypassResolveCache ? { bypassCache: true } : undefined,
          ),
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
    resolvedAbsoluteEpisode,
    isResolving,
    error,
    isDev,
    shouldBypassResolveCache,
    shouldWaitForResolvedLookupId,
    streamLookupId,
    preferredStreamLookupId,
    stopLoading,
  ]);

  // Prefetch best stream for next episode in the background.
  // Wait until playback has genuinely started so we don't overlap initial resolve
  // retries with prefetch work on stalled starts.
  useEffect(() => {
    if (!hasPlaybackStarted) return;

    if (!nextEpisode || !type || !id) {
      nextEpisodePrefetchRef.current = null;
      nextEpisodePrefetchLookupKeyRef.current = null;
      nextEpisodePrefetchInFlightRef.current = false;
      return;
    }

    const nextEpisodeStream = buildEpisodeStreamCoordinates(
      type,
      streamLookupId || id,
      nextEpisode,
    );
    const currentNextEpisodeLookupKey = nextEpisodeStream.lookupKey;

    const alreadyPrefetched =
      nextEpisodePrefetchRef.current &&
      nextEpisodePrefetchRef.current.lookupKey === currentNextEpisodeLookupKey &&
      nextEpisodePrefetchRef.current.season === nextEpisodeStream.absoluteSeason &&
      nextEpisodePrefetchRef.current.episode === nextEpisodeStream.absoluteEpisode;

    if (
      alreadyPrefetched ||
      (nextEpisodePrefetchInFlightRef.current &&
        nextEpisodePrefetchLookupKeyRef.current === currentNextEpisodeLookupKey)
    ) {
      return;
    }

    let cancelled = false;
    nextEpisodePrefetchLookupKeyRef.current = currentNextEpisodeLookupKey;
    nextEpisodePrefetchInFlightRef.current = true;

    api
      .resolveBestStream(
        effectiveResolveMediaType,
        nextEpisodeStream.streamLookupId,
        nextEpisodeStream.streamSeason,
        nextEpisodeStream.streamEpisode,
        nextEpisodeStream.absoluteEpisode,
      )
      .then((result) => {
        if (cancelled || !result?.url) return;
        if (nextEpisodePrefetchLookupKeyRef.current !== currentNextEpisodeLookupKey) return;
        nextEpisodePrefetchRef.current = {
          lookupKey: currentNextEpisodeLookupKey,
          season: nextEpisodeStream.absoluteSeason,
          episode: nextEpisodeStream.absoluteEpisode,
          url: result.url,
          format: result.format,
        };
      })
      .catch(() => {
        if (!cancelled && nextEpisodePrefetchLookupKeyRef.current === currentNextEpisodeLookupKey) {
          nextEpisodePrefetchRef.current = null;
        }
      })
      .finally(() => {
        if (!cancelled && nextEpisodePrefetchLookupKeyRef.current === currentNextEpisodeLookupKey) {
          nextEpisodePrefetchInFlightRef.current = false;
          nextEpisodePrefetchLookupKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      if (nextEpisodePrefetchLookupKeyRef.current === currentNextEpisodeLookupKey) {
        nextEpisodePrefetchInFlightRef.current = false;
        nextEpisodePrefetchLookupKeyRef.current = null;
      }
    };
  }, [nextEpisode, type, effectiveResolveMediaType, id, streamLookupId, hasPlaybackStarted]);

  // 1. Fetch Watch Progress
  useEffect(() => {
    if (typeof startTime === 'number' && startTime > 0) {
      resumeTimeRef.current = startTime;
      initialTimeRef.current = startTime;
      resumeAppliedRef.current = false;
      resumeOsdShownRef.current = false;

      if (activeStreamUrl && (durationRef.current > 0 || currentTimeRef.current > 0)) {
        void applyResumeIfReadyRef.current();
      }
    }
  }, [activeStreamUrl, startTime]);

  useEffect(() => {
    if (!type || !id || id === 'local') return;
    api
      .getWatchProgress(id, type, resolvedAbsoluteSeason, resolvedAbsoluteEpisode)
      .then((progress) => {
        if (progress?.position && progress.position > 0) {
          const candidate = progress.position;
          if (candidate > (resumeTimeRef.current || 0)) {
            resumeTimeRef.current = candidate;
            resumeAppliedRef.current = false;
            resumeOsdShownRef.current = false;

            if (activeStreamUrl && (durationRef.current > 0 || currentTimeRef.current > 0)) {
              void applyResumeIfReadyRef.current();
            }
          }
          initialTimeRef.current = resumeTimeRef.current;
        }
      });
  }, [activeStreamUrl, type, id, resolvedAbsoluteSeason, resolvedAbsoluteEpisode, isOffline]);

  // Sync fullscreen state with browser API (e.g. user presses Escape)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

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

        const initialResumeTime = Math.max(resumeTimeRef.current || 0, initialTimeRef.current || 0);
        const shouldPauseForResume = initialResumeTime > 5;
        const shouldStartPaused = shouldPauseForResume;
        resumePausePendingRef.current = shouldPauseForResume;

        const mpvConfig: MpvConfig = {
          initialOptions: {
            vo: 'gpu',
            hwdec: 'auto', // Try auto for better performance/compatibility
            'gpu-context': 'd3d11', // Switch to d3d11 for visibility on Windows
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

        unlisten = await observeProperties(OBSERVED_PROPERTIES, (event) => {
          if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
          const { name, data } = event;

          switch (name) {
            case 'time-pos':
              if (typeof data === 'number') {
                const prevTime = currentTimeRef.current;
                currentTimeRef.current = data;
                const now = performance.now();
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
        resumeAppliedRef.current = false;
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
              setError('Stream failed to load. Try another stream.');
              stopLoading();
            }, 5000);
          }
        }, 6500);
      } catch (err) {
        if (cancelled) return; // Don't set error for cancelled inits
        if (recoverFromStaleSavedStream()) return;
        if (isDev) console.error('MPV Init Error:', err);
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
      if (unlisten) unlisten();
      clearUiTimers();
      clearResumeRetryTimer();
      clearRecoveryTimers();
      destroy().catch(() => {});
      restorePlayerSurface();
      void exitFullscreenIfNeeded();
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
    exitFullscreenIfNeeded,
    isDev,
    markPlaybackReady,
    restorePlayerSurface,
    stopLoading,
    recoverFromStaleSavedStream,
  ]);

  // 3. Save Progress Interval
  useEffect(() => {
    const interval = setInterval(() => {
      if (isPlaying && currentTimeRef.current > 5) {
        saveProgress();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isPlaying, saveProgress]);

  useEffect(() => {
    const flushProgress = () => {
      void saveProgress();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushProgress();
      }
    };

    window.addEventListener('beforeunload', flushProgress);
    window.addEventListener('pagehide', flushProgress);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', flushProgress);
      window.removeEventListener('pagehide', flushProgress);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [saveProgress]);

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
      if (leftTapTimerRef.current) clearTimeout(leftTapTimerRef.current);
      if (rightTapTimerRef.current) clearTimeout(rightTapTimerRef.current);
      if (centerTapTimerRef.current) clearTimeout(centerTapTimerRef.current);
    };
  }, [clearRecoveryTimers, clearResumeRetryTimer, clearUiTimers]);

  // Restore window when player unmounts (covers navigation paths that bypass navigateBack)
  useEffect(() => {
    return () => {
      if (!isNavigatingAwayRef.current) {
        void exitPiPAndRestore();
      }
      // Ensure Continue Watching is always fresh after leaving the player,
      // regardless of which navigation path was taken.
      invalidateWatchHistoryOnce();
    };
  }, [exitPiPAndRestore, invalidateWatchHistoryOnce]);

  // Per-zone double-tap timers:
  //   left/right zone: double-tap → seek ±10s; single tap → no-op (just shows controls)
  //   center zone:     double-tap → fullscreen; single tap → toggle play
  const DBL_TAP_MS = 300;

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

      const rect = event.currentTarget.getBoundingClientRect();
      const relX = (event.clientX - rect.left) / rect.width;
      const ZONE = 0.25;

      if (relX < ZONE) {
        // Left zone: double-tap to seek backward
        if (leftTapTimerRef.current) {
          clearTimeout(leftTapTimerRef.current);
          leftTapTimerRef.current = null;
          triggerOsd({ kind: 'seek', direction: 'backward', seconds: 10 });
          void seekRelative(-10);
        } else {
          leftTapTimerRef.current = setTimeout(() => {
            leftTapTimerRef.current = null;
            // single tap on edge zone — show controls but do nothing else
          }, DBL_TAP_MS);
        }
        return;
      }

      if (relX > 1 - ZONE) {
        // Right zone: double-tap to seek forward
        if (rightTapTimerRef.current) {
          clearTimeout(rightTapTimerRef.current);
          rightTapTimerRef.current = null;
          triggerOsd({ kind: 'seek', direction: 'forward', seconds: 10 });
          void seekRelative(10);
        } else {
          rightTapTimerRef.current = setTimeout(() => {
            rightTapTimerRef.current = null;
            // single tap on edge zone — show controls but do nothing else
          }, DBL_TAP_MS);
        }
        return;
      }

      // Center zone: double-tap → fullscreen, single tap → toggle play
      if (centerTapTimerRef.current) {
        clearTimeout(centerTapTimerRef.current);
        centerTapTimerRef.current = null;
        toggleFullscreen();
      } else {
        centerTapTimerRef.current = setTimeout(() => {
          centerTapTimerRef.current = null;
          triggerOsd({ kind: isPlayingRef.current ? 'pause' : 'play' });
          togglePlay();
        }, 250);
      }
    },
    [
      showEpisodes,
      isLoading,
      isResolving,
      error,
      toggleFullscreen,
      togglePlay,
      triggerOsd,
      seekRelative,
    ],
  );

  // -- Render Logic --
  // Don't show error overlay in the brief window before auto-resolve starts
  const showErrorOverlay = error && !isResolving && !isLoading;

  const selectorEpisodeStream =
    selectedEpisodeForStream && type && id
      ? buildEpisodeStreamCoordinates(type, streamLookupId || id, selectedEpisodeForStream)
      : null;

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
    state?.selectedStreamKey && state?.streamUrl && activeStreamUrl === state.streamUrl
      ? state.selectedStreamKey
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
        !isFullscreen && !isPiP && 'pl-[60px]',
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onClick={handlePlayerClick}
      id='mpv-container'
    >
      {!isFullscreen && !isPiP && (
        <div
          className='fixed left-0 top-0 z-[70] pointer-events-auto'
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Sidebar className='flex' playerMode />
        </div>
      )}

      {/* Picture-in-Picture drag bar — covers the top strip of the window.
           Uses imperative startDragging() so it works even though libmpv
           renders a native surface that swallows OS pointer events before
           Tauri's data-tauri-drag-region listener fires.
           The close button stops propagation on its own pointerdown to
           prevent an accidental drag when the user clicks to exit PiP. */}
      {isPiP && (
        <div
          className='absolute top-0 left-0 right-0 h-8 z-[80] flex items-center justify-between px-2 cursor-grab active:cursor-grabbing select-none'
          onPointerDown={startWindowDrag}
          onMouseDown={startWindowDrag}
          onClick={(e) => e.stopPropagation()}
        >
          <span className='text-[9px] font-medium text-white/60 truncate max-w-[calc(100%-32px)] pointer-events-none'>
            {title}
          </span>
          <button
            type='button'
            title='Exit Picture-in-Picture (P)'
            className='p-1 rounded hover:bg-white/20 text-white/60 hover:text-white transition-colors shrink-0 cursor-pointer'
            onClick={(e) => {
              e.stopPropagation();
              void togglePiP();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <PictureInPicture2 className='w-3.5 h-3.5' />
          </button>
        </div>
      )}

      {/* PiP: invisible full-area drag layer (below controls z-40) so the user
           can drag the window by clicking anywhere on the video that isn't a
           control. onClick is stopped so it doesn't bubble to handlePlayerClick. */}
      {isPiP && (
        <div
          className='absolute inset-0 z-[35] cursor-grab active:cursor-grabbing'
          onPointerDown={startWindowDrag}
          onMouseDown={startWindowDrag}
          onClick={(e) => e.stopPropagation()}
        />
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
                setSelectedEpisodeForStream(sidebarCurrentEpisode);
                setShowStreamSelector(true);
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
          'absolute inset-0 z-40 flex flex-col pr-6 transition-opacity duration-300 bg-gradient-to-b from-black/80 via-transparent to-black/90',
          // PiP: justify-end keeps the single bottom-bar child at the bottom
          isPiP ? 'justify-end pt-8 pb-3 pl-3' : 'justify-between pt-6 pb-6',
          !isPiP && (isFullscreen ? 'pl-6' : 'pl-[84px]'),
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        {/* Top Bar — hidden in PiP (the drag bar replaces it) */}
        {!isPiP && (
          <div className='flex items-center justify-between' onClick={(e) => e.stopPropagation()}>
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
            <div className='w-10' /> {/* Spacer */}
          </div>
        )}

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
        <div className='space-y-0' onClick={(e) => e.stopPropagation()}>
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
                  >
                    {playbackSpeed}x
                  </Button>
                </PopoverTrigger>
                <PopoverContent side='top' className='w-20 p-1 bg-black/90 border-white/10'>
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
              {details?.episodes && !isPiP && (
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
                    openInlineStreamSelector();
                  }}
                >
                  <ArrowLeftRight className='w-5 h-5' strokeWidth={2.5} />
                </Button>
              )}

              {/* Playback Settings */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant='ghost'
                    size='icon'
                    className={cn(
                      'text-white hover:bg-white/20 relative',
                      (activeAudioTrack || activeSubTrack) && 'text-primary bg-white/10',
                    )}
                    title='Playback Settings'
                  >
                    <Settings2 className='w-5 h-5' strokeWidth={2.5} />
                    {(activeAudioTrack || activeSubTrack) && (
                      <span className='absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary' />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side='top'
                  align='end'
                  className='w-[300px] p-2.5 bg-black/90 border-white/10'
                >
                  <ScrollArea className='max-h-[50vh] pr-1 [&>[data-radix-scroll-area-viewport]>div]:!block'>
                    <div className='space-y-3'>
                      <div>
                        <h4 className='text-xs font-bold text-gray-400 mb-2 px-1 uppercase tracking-wider'>
                          Audio
                        </h4>
                        {audioTracks.length > 0 ? (
                          <div className='space-y-1'>
                            {audioTracks.map((t) => {
                              const label = audioTrackLabels.get(t.id) || formatTrackLabel(t);
                              return (
                                <Button
                                  key={t.id}
                                  variant='ghost'
                                  size='sm'
                                  className={cn(
                                    'w-full justify-between text-xs overflow-hidden rounded-md',
                                    t.selected && 'text-primary bg-white/5',
                                    trackSwitching.audio && 'opacity-70',
                                  )}
                                  title={label}
                                  disabled={trackSwitching.audio}
                                  onClick={() =>
                                    void setTrack('audio', t.id, { persistPreference: true })
                                  }
                                >
                                  <span className='truncate'>{label}</span>
                                  {trackSwitching.audio && t.selected ? (
                                    <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                                  ) : t.selected ? (
                                    <Check className='h-3.5 w-3.5 shrink-0' />
                                  ) : null}
                                </Button>
                              );
                            })}
                          </div>
                        ) : (
                          <p className='text-xs text-zinc-500 px-1'>No alternate audio tracks</p>
                        )}
                      </div>

                      <div className='h-px bg-white/10' />

                      <div>
                        <div className='flex items-center justify-between px-1 mb-2'>
                          <h4 className='text-xs font-bold text-gray-400 uppercase tracking-wider'>
                            Subtitles
                          </h4>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='h-6 px-2 text-[10px] text-gray-300 hover:text-white'
                            onClick={() => {
                              void applySubtitleDelay(0);
                              void applySubtitlePos(100);
                              void applySubtitleScale(1.0);
                            }}
                          >
                            Reset
                          </Button>
                        </div>

                        <div className='space-y-3'>
                          <div className='space-y-2 px-1'>
                            <div className='flex items-center justify-between text-[11px] text-gray-400'>
                              <span>Sync</span>
                              <span className='font-mono text-gray-300'>
                                {subtitleDelay.toFixed(1)}s
                              </span>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Button
                                variant='ghost'
                                size='sm'
                                className='h-7 px-2 text-xs'
                                onClick={() => void applySubtitleDelay(subtitleDelay - 0.5)}
                              >
                                -0.5s
                              </Button>
                              <PlayerSlider
                                value={[subtitleDelay]}
                                min={-5}
                                max={5}
                                step={0.1}
                                onValueChange={(val) => void applySubtitleDelay(val[0])}
                                className='flex-1'
                              />
                              <Button
                                variant='ghost'
                                size='sm'
                                className='h-7 px-2 text-xs'
                                onClick={() => void applySubtitleDelay(subtitleDelay + 0.5)}
                              >
                                +0.5s
                              </Button>
                            </div>
                          </div>

                          <div className='space-y-2 px-1'>
                            <div className='flex items-center justify-between text-[11px] text-gray-400'>
                              <span>Position</span>
                              <span className='font-mono text-gray-300'>
                                {Math.round(subtitlePos)}%
                              </span>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Button
                                variant='ghost'
                                size='icon'
                                className='h-7 w-7'
                                onClick={() => void applySubtitlePos(subtitlePos - 2)}
                              >
                                <ChevronUp className='h-4 w-4' />
                              </Button>
                              <PlayerSlider
                                value={[subtitlePos]}
                                min={65}
                                max={100}
                                step={1}
                                onValueChange={(val) => void applySubtitlePos(val[0])}
                                className='flex-1'
                              />
                              <Button
                                variant='ghost'
                                size='icon'
                                className='h-7 w-7'
                                onClick={() => void applySubtitlePos(subtitlePos + 2)}
                              >
                                <ChevronDown className='h-4 w-4' />
                              </Button>
                            </div>
                          </div>

                          <div className='space-y-2 px-1'>
                            <div className='flex items-center justify-between text-[11px] text-gray-400'>
                              <span>Size</span>
                              <span className='font-mono text-gray-300'>
                                ×{subtitleScale.toFixed(2)}
                              </span>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Button
                                variant='ghost'
                                size='sm'
                                className='h-7 px-2 text-xs'
                                onClick={() => void applySubtitleScale(subtitleScale - 0.1)}
                              >
                                A−
                              </Button>
                              <PlayerSlider
                                value={[subtitleScale]}
                                min={0.25}
                                max={3.0}
                                step={0.05}
                                onValueChange={(val) => void applySubtitleScale(val[0])}
                                className='flex-1'
                              />
                              <Button
                                variant='ghost'
                                size='sm'
                                className='h-7 px-2 text-xs'
                                onClick={() => void applySubtitleScale(subtitleScale + 0.1)}
                              >
                                A+
                              </Button>
                            </div>
                          </div>
                        </div>

                        <div className='mt-4'>
                          <p className='text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-1 mb-1'>
                            Tracks
                          </p>
                          <div className='space-y-1'>
                            <Button
                              variant='ghost'
                              size='sm'
                              className={cn(
                                'w-full justify-between text-xs overflow-hidden rounded-md',
                                subtitlesOff ? 'text-primary bg-white/5' : 'text-red-400',
                                trackSwitching.sub && 'opacity-70',
                              )}
                              disabled={trackSwitching.sub}
                              onClick={() =>
                                void setTrack('sub', 'no', { persistPreference: true })
                              }
                            >
                              <span className='truncate'>Off</span>
                              {trackSwitching.sub && subtitlesOff ? (
                                <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                              ) : subtitlesOff ? (
                                <Check className='h-3.5 w-3.5 shrink-0' />
                              ) : null}
                            </Button>
                            {subTracks.map((t) => {
                              const label = subTrackLabels.get(t.id) || formatTrackLabel(t);
                              return (
                                <Button
                                  key={t.id}
                                  variant='ghost'
                                  size='sm'
                                  className={cn(
                                    'w-full justify-between text-xs overflow-hidden rounded-md',
                                    t.selected && 'text-primary bg-white/5',
                                    trackSwitching.sub && 'opacity-70',
                                  )}
                                  title={label}
                                  disabled={trackSwitching.sub}
                                  onClick={() =>
                                    void setTrack('sub', t.id, { persistPreference: true })
                                  }
                                >
                                  <span className='truncate'>{label}</span>
                                  {trackSwitching.sub && t.selected ? (
                                    <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                                  ) : t.selected ? (
                                    <Check className='h-3.5 w-3.5 shrink-0' />
                                  ) : null}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>

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
                onClick={() => void togglePiP()}
                className={cn(
                  'text-white hover:bg-white/20 h-10 w-10',
                  isPiP && 'bg-white/20 text-sky-300',
                )}
                title='Picture-in-Picture (P)'
              >
                <PictureInPicture2 className='w-6 h-6' strokeWidth={2.5} />
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
      {/* ── OSD Flash Indicator ────────────────────────────────────────────────
           Independent z-50 layer so it appears over the controls overlay regardless
           of whether controls are currently visible.                              */}
      {osdAction && !isLoading && !isResolving && (
        <div
          className={cn(
            'absolute inset-0 z-50 flex items-center justify-center pointer-events-none transition-opacity duration-150',
            osdVisible ? 'opacity-100' : 'opacity-0',
          )}
          aria-live='polite'
          aria-atomic='true'
        >
          {/* Play / Pause flash — bare icon, no circle, matches playback bar */}
          {(osdAction.kind === 'play' || osdAction.kind === 'pause') && (
            <div
              className={cn(
                'transition-all duration-200',
                osdVisible ? 'scale-100 opacity-100' : 'scale-110 opacity-0',
              )}
            >
              {osdAction.kind === 'play' ? (
                <Play className='w-10 h-10 fill-white text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.8)]' />
              ) : (
                <Pause className='w-10 h-10 fill-white text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.8)]' />
              )}
            </div>
          )}

          {/* Seek indicator */}
          {osdAction.kind === 'seek' && (
            <div className='bg-black/50 backdrop-blur-2xl rounded-2xl px-6 py-3.5 border border-white/15 shadow-xl flex items-center gap-3'>
              {osdAction.direction === 'forward' ? (
                <FastForward className='w-5 h-5 text-white/90' strokeWidth={2.5} />
              ) : (
                <Rewind className='w-5 h-5 text-white/90' strokeWidth={2.5} />
              )}
              <span className='text-white font-semibold text-xl tabular-nums tracking-tight'>
                {osdAction.direction === 'forward' ? '+' : '−'}
                {osdAction.seconds}s
              </span>
            </div>
          )}

          {/* Volume indicator */}
          {osdAction.kind === 'volume' && (
            <div className='bg-black/50 backdrop-blur-2xl rounded-2xl px-5 py-3.5 border border-white/15 shadow-xl flex flex-col items-center gap-2.5 min-w-[130px]'>
              <div className='flex items-center gap-2'>
                {osdAction.level === 0 ? (
                  <VolumeX className='w-5 h-5 text-white/90' strokeWidth={2.5} />
                ) : osdAction.level < 50 ? (
                  <Volume1 className='w-5 h-5 text-white/90' strokeWidth={2.5} />
                ) : (
                  <Volume2 className='w-5 h-5 text-white/90' strokeWidth={2.5} />
                )}
                <span className='text-white font-semibold text-base tabular-nums'>
                  {Math.round(osdAction.level)}%
                </span>
              </div>
              <div className='w-28 h-[3px] bg-white/20 rounded-full overflow-hidden'>
                <div
                  className='h-full bg-white rounded-full'
                  style={{ width: `${Math.min(100, Math.round(osdAction.level))}%` }}
                />
              </div>
            </div>
          )}

          {/* Generic text message */}
          {osdAction.kind === 'message' && (
            <div className='bg-black/55 backdrop-blur-2xl rounded-2xl px-5 py-3 border border-white/15 shadow-xl'>
              <span className='text-white font-semibold text-sm tracking-wide'>
                {osdAction.text}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Skip Segment Button ────────────────────────────────────────────────
           z-[55]: above controls (z-40) & OSD (z-50) but below episode panel backdrop
           (z-50 overlap) — renders on top reliably during normal playback.        */}
      {activeSkipSegment && !isLoading && !isResolving && !error && (
        <div
          className='absolute z-[55] pointer-events-auto bottom-[116px] right-6'
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button
            onClick={() => void seek(activeSkipSegment.end_time)}
            variant='outline'
            className={cn(
              'h-auto px-5 py-2.5 text-sm font-semibold rounded-lg',
              'bg-zinc-900 hover:bg-zinc-800 text-white',
              'border border-white/20 hover:border-white/40',
              'shadow-2xl',
              'flex items-center gap-2 transition-all duration-150',
              'animate-in fade-in slide-in-from-right-4 duration-300',
            )}
          >
            <FastForward className='w-4 h-4 flex-shrink-0' strokeWidth={2.5} />
            <span>{getSkipLabel(activeSkipSegment.type)}</span>
          </Button>
        </div>
      )}

      {/* ── Up-Next / Auto-Next Countdown ────────────────────────────────────────
           Appears at same position as skip button after episode ends.
           Countdown fill animates left→right; user can dismiss or click to navigate. */}
      {showUpNext && nextEpisode && !isLoading && !isResolving && !error && (
        <div
          className='absolute z-[55] pointer-events-auto bottom-[116px] right-6'
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='flex items-center gap-2 animate-in fade-in slide-in-from-right-4 duration-300'>
            {/* Dismiss button */}
            <Button
              size='icon'
              variant='ghost'
              onClick={dismissUpNext}
              className='h-8 w-8 rounded-lg bg-zinc-900/80 border border-white/10 text-zinc-400 hover:text-white hover:bg-zinc-800 shadow-xl'
              title='Dismiss'
            >
              <X className='w-3.5 h-3.5' />
            </Button>

            {/* Countdown play button with fill animation */}
            <button
              onClick={() => {
                dismissUpNext();
                void playNext();
              }}
              className={cn(
                'relative h-auto px-5 py-2.5 text-sm font-semibold rounded-lg overflow-hidden',
                'bg-zinc-900 text-white border border-white/20 hover:border-white/40',
                'shadow-2xl cursor-pointer',
                'flex items-center gap-2 transition-colors duration-150',
              )}
            >
              {/* Countdown fill — animates over 10s total; clamp at 100% visually */}
              <div
                className='absolute inset-0 bg-white/10 origin-left transition-none pointer-events-none'
                style={{
                  transform: `scaleX(${1 - upNextCountdown / 10})`,
                  transformOrigin: 'left',
                  transition: upNextCountdown < 10 ? 'transform 1s linear' : 'none',
                }}
              />
              <FastForward className='w-4 h-4 flex-shrink-0 relative z-10' strokeWidth={2.5} />
              <span className='relative z-10'>
                Next Episode
                <span className='ml-1.5 tabular-nums text-zinc-400'>{upNextCountdown}s</span>
              </span>
            </button>
          </div>
        </div>
      )}

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
              setShowStreamSelector(false);
              setSelectedEpisodeForStream(null);
            }}
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
            poster={state?.poster}
            backdrop={backdrop}
            logo={state?.logo}
            from={state?.from}
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
          poster={state?.poster}
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
