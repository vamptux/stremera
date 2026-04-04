import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import { type PlaybackLanguagePreferences } from '@/lib/api';
import { invalidatePlaybackHistoryQueries } from '@/lib/query-invalidation';
import { usePlaybackProgressPersistence } from '@/hooks/use-playback-progress-persistence';
import { usePlaybackStreamHealth } from '@/hooks/use-playback-stream-health';
import { usePlayerNavigationGuard } from '@/hooks/use-player-navigation-guard';
import { usePlayerResumeController } from '@/hooks/use-player-resume-controller';
import { usePlayerTrackController } from '@/hooks/use-player-track-controller';

interface UsePlayerSessionBoundaryArgs {
  absoluteEpisode?: number;
  absoluteSeason?: number;
  activeStreamFamilyRef: MutableRefObject<string | undefined>;
  activeStreamFormatRef: MutableRefObject<string | undefined>;
  activeStreamResetKey: string;
  activeStreamSourceNameRef: MutableRefObject<string | undefined>;
  activeStreamUrl?: string;
  aniskipEpisode?: number;
  backdrop?: string;
  currentTime: number;
  currentTimeRef: MutableRefObject<number>;
  duration: number;
  durationRef: MutableRefObject<number>;
  hasPlaybackStarted: boolean;
  isDestroyedRef: MutableRefObject<boolean>;
  isHistoryResume: boolean;
  isLoading: boolean;
  isPlaying: boolean;
  isResolving: boolean;
  lastStreamUrlRef: MutableRefObject<string | undefined>;
  mediaId?: string;
  mediaType?: string;
  mountedRef: MutableRefObject<boolean>;
  onResumeMessage: (text: string) => void;
  playbackLanguageMediaType?: 'movie' | 'series' | 'anime';
  poster?: string;
  routeStreamUrl?: string;
  selectedStreamKeyRef: MutableRefObject<string | undefined>;
  startTime?: number;
  streamEpisode?: number;
  streamLookupIdRef: MutableRefObject<string | undefined>;
  streamSeason?: number;
  title: string;
}

export function usePlayerSessionBoundary({
  absoluteEpisode,
  absoluteSeason,
  activeStreamFamilyRef,
  activeStreamFormatRef,
  activeStreamResetKey,
  activeStreamSourceNameRef,
  activeStreamUrl,
  aniskipEpisode,
  backdrop,
  currentTime,
  currentTimeRef,
  duration,
  durationRef,
  hasPlaybackStarted,
  isDestroyedRef,
  isHistoryResume,
  isLoading,
  isPlaying,
  isResolving,
  lastStreamUrlRef,
  mediaId,
  mediaType,
  mountedRef,
  onResumeMessage,
  playbackLanguageMediaType,
  poster,
  routeStreamUrl,
  selectedStreamKeyRef,
  startTime,
  streamEpisode,
  streamLookupIdRef,
  streamSeason,
  title,
}: UsePlayerSessionBoundaryArgs) {
  const queryClient = useQueryClient();
  const watchHistoryInvalidatedRef = useRef(false);
  const playbackLanguagePreferencesRef = useRef<PlaybackLanguagePreferences>({});
  const saveProgressRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const {
    audioTracks,
    subTracks,
    trackSwitching,
    subtitlesOff,
    playbackLanguagePreferences,
    refreshTracks,
    setTrack,
  } = usePlayerTrackController({
    mediaId,
    mediaType: playbackLanguageMediaType,
    activeStreamUrl,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    resetKey: activeStreamResetKey,
  });

  const { saveProgress } = usePlaybackProgressPersistence({
    mediaId,
    mediaType,
    title: title || 'Unknown',
    poster,
    backdrop,
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    aniskipEpisode,
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
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      activeStreamUrl,
      activeStreamFormatRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
    });

  const { applyResumeIfReady, clearResumeRetryTimer, prepareForStreamLoad } =
    usePlayerResumeController({
      mediaId,
      mediaType,
      activeStreamUrl,
      startTime,
      absoluteSeason,
      absoluteEpisode,
      isHistoryResume,
      mountedRef,
      isDestroyedRef,
      currentTimeRef,
      durationRef,
      onResumeMessage,
    });

  useEffect(() => {
    playbackLanguagePreferencesRef.current = {
      preferredAudioLanguage: playbackLanguagePreferences.preferredAudioLanguage,
      preferredSubtitleLanguage: playbackLanguagePreferences.preferredSubtitleLanguage,
    };
  }, [
    playbackLanguagePreferences.preferredAudioLanguage,
    playbackLanguagePreferences.preferredSubtitleLanguage,
  ]);

  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  const invalidatePlaybackQueries = useCallback(() => {
    void invalidatePlaybackHistoryQueries(queryClient);
  }, [queryClient]);

  const invalidateWatchHistoryOnce = useCallback(() => {
    if (watchHistoryInvalidatedRef.current) {
      return;
    }

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
    enabled: !!mediaType && !!mediaId && !!(activeStreamUrl || routeStreamUrl),
    flushBeforeNavigation: flushPlaybackBeforeNavigation,
  });

  return {
    allowNextNavigation,
    applyResumeIfReady,
    audioTracks,
    clearResumeRetryTimer,
    flushPlaybackBeforeNavigation,
    invalidateWatchHistoryOnce,
    playbackLanguagePreferencesRef,
    prepareForStreamLoad,
    refreshTracks,
    reportStreamFailure,
    reportStreamVerified,
    saveProgressRef,
    setTrack,
    subTracks,
    subtitlesOff,
    trackSwitching,
  };
}