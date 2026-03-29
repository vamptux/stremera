import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { api } from '@/lib/api';

const NEAR_COMPLETION_MIN_DURATION_SECS = 60;
const NEAR_COMPLETION_REMAINING_SECS = 30;
const NEAR_COMPLETION_PROGRESS_RATIO = 0.97;

function shouldFlushNearCompletion(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) return false;
  if (duration < NEAR_COMPLETION_MIN_DURATION_SECS || currentTime <= 0) return false;

  const remaining = Math.max(0, duration - currentTime);
  const progressRatio = duration > 0 ? currentTime / duration : 0;

  return (
    remaining <= NEAR_COMPLETION_REMAINING_SECS || progressRatio >= NEAR_COMPLETION_PROGRESS_RATIO
  );
}

interface UsePlaybackProgressPersistenceArgs {
  mediaId?: string;
  mediaType?: string;
  title: string;
  poster?: string;
  backdrop?: string;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  aniskipEpisode?: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  activeStreamUrl?: string;
  currentTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  lastStreamUrlRef: MutableRefObject<string | undefined>;
  activeStreamFormatRef: MutableRefObject<string | undefined>;
  activeStreamSourceNameRef: MutableRefObject<string | undefined>;
  activeStreamFamilyRef: MutableRefObject<string | undefined>;
  streamLookupIdRef: MutableRefObject<string | undefined>;
  selectedStreamKeyRef: MutableRefObject<string | undefined>;
}

export function usePlaybackProgressPersistence({
  mediaId,
  mediaType,
  title,
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
}: UsePlaybackProgressPersistenceArgs) {
  const lastPlayingStateRef = useRef(isPlaying);
  const nearCompletionSavedRef = useRef(false);
  const sessionTouchKeyRef = useRef<string | null>(null);

  const saveProgress = useCallback(async () => {
    if (!mediaType || !mediaId || mediaId === 'local' || currentTimeRef.current < 5) return;

    await api.saveWatchProgress({
      id: mediaId,
      type_: mediaType,
      season: absoluteSeason,
      episode: absoluteEpisode,
      absolute_season: absoluteSeason,
      absolute_episode: absoluteEpisode,
      stream_season: streamSeason,
      stream_episode: streamEpisode,
      aniskip_episode: aniskipEpisode,
      position: currentTimeRef.current,
      duration: durationRef.current,
      last_watched: Date.now(),
      title: title || 'Unknown',
      poster,
      backdrop,
      last_stream_url: lastStreamUrlRef.current,
      last_stream_format: activeStreamFormatRef.current,
      last_stream_lookup_id: streamLookupIdRef.current,
      last_stream_key: selectedStreamKeyRef.current,
      source_name: activeStreamSourceNameRef.current,
      stream_family: activeStreamFamilyRef.current,
    });
  }, [
    mediaType,
    mediaId,
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    aniskipEpisode,
    currentTimeRef,
    durationRef,
    title,
    poster,
    backdrop,
    lastStreamUrlRef,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isPlaying && currentTimeRef.current > 5) {
        void saveProgress();
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [currentTimeRef, isPlaying, saveProgress]);

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

  useEffect(() => {
    const wasPlaying = lastPlayingStateRef.current;
    lastPlayingStateRef.current = isPlaying;

    if (wasPlaying && !isPlaying) {
      void saveProgress();
    }
  }, [isPlaying, saveProgress]);

  useEffect(() => {
    nearCompletionSavedRef.current = false;
  }, [activeStreamUrl, mediaId, absoluteSeason, absoluteEpisode]);

  useEffect(() => {
    const normalizedMediaId = mediaId?.trim();
    const normalizedMediaType = mediaType?.trim();
    const normalizedStreamUrl = activeStreamUrl?.trim();

    if (!normalizedMediaId || !normalizedMediaType || normalizedMediaId === 'local') {
      sessionTouchKeyRef.current = null;
      return;
    }
    if (!normalizedStreamUrl) {
      sessionTouchKeyRef.current = null;
      return;
    }

    const nextSessionKey = [
      normalizedMediaType,
      normalizedMediaId,
      absoluteSeason ?? 'na',
      absoluteEpisode ?? 'na',
      normalizedStreamUrl,
    ].join('|');

    if (sessionTouchKeyRef.current === nextSessionKey) {
      return;
    }

    sessionTouchKeyRef.current = nextSessionKey;
    void api.touchPlaybackSession({
      id: normalizedMediaId,
      type_: normalizedMediaType,
      season: absoluteSeason,
      episode: absoluteEpisode,
      absolute_season: absoluteSeason,
      absolute_episode: absoluteEpisode,
      stream_season: streamSeason,
      stream_episode: streamEpisode,
      aniskip_episode: aniskipEpisode,
      title,
      stream_url: normalizedStreamUrl,
      stream_format: activeStreamFormatRef.current,
      stream_lookup_id: streamLookupIdRef.current,
      stream_key: selectedStreamKeyRef.current,
      source_name: activeStreamSourceNameRef.current,
      stream_family: activeStreamFamilyRef.current,
      position: currentTimeRef.current,
      duration: durationRef.current,
    }).catch(() => {
      // Session tracking should never block playback.
    });
  }, [
    activeStreamFamilyRef,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamUrl,
    absoluteEpisode,
    absoluteSeason,
    aniskipEpisode,
    currentTimeRef,
    durationRef,
    mediaId,
    mediaType,
    selectedStreamKeyRef,
    streamEpisode,
    streamLookupIdRef,
    streamSeason,
    title,
  ]);

  useEffect(() => {
    if (!isPlaying || nearCompletionSavedRef.current) return;
    if (!shouldFlushNearCompletion(currentTime, duration)) return;

    nearCompletionSavedRef.current = true;
    void saveProgress();
  }, [currentTime, duration, isPlaying, saveProgress]);

  return {
    saveProgress,
  };
}