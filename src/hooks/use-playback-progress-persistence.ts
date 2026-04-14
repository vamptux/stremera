import { type MutableRefObject, useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { api, type WatchProgress } from '@/lib/api';

const MIN_PERSISTABLE_PROGRESS_SECS = 5;
const NEAR_COMPLETION_MIN_DURATION_SECS = 60;
const NEAR_COMPLETION_REMAINING_SECS = 30;
const NEAR_COMPLETION_PROGRESS_RATIO = 0.97;

function roundPersistedTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildWatchProgressFingerprint(progress: WatchProgress): string {
  return [
    progress.id,
    progress.type_,
    progress.absolute_season ?? '',
    progress.absolute_episode ?? '',
    roundPersistedTime(progress.position),
    roundPersistedTime(progress.duration),
    progress.last_stream_url ?? '',
    progress.last_stream_format ?? '',
    progress.last_stream_lookup_id ?? '',
    progress.last_stream_key ?? '',
    progress.source_name ?? '',
    progress.stream_family ?? '',
    progress.title,
    progress.poster ?? '',
    progress.backdrop ?? '',
  ].join('|');
}

function hasPersistableProgress(currentTime: number): boolean {
  return Number.isFinite(currentTime) && currentTime >= MIN_PERSISTABLE_PROGRESS_SECS;
}

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
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPersistedFingerprintRef = useRef<string | null>(null);
  const scheduledFingerprintsRef = useRef<Set<string>>(new Set());

  const buildWatchProgressPayload = useCallback((): WatchProgress | null => {
    if (!mediaType || !mediaId || mediaId === 'local') return null;

    // Ignore startup stubs so Continue Watching does not regress to near-zero resumes.
    if (!hasPersistableProgress(currentTimeRef.current)) return null;

    return {
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
    };
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

  const saveProgress = useCallback(async () => {
    const payload = buildWatchProgressPayload();
    if (!payload) return;

    const fingerprint = buildWatchProgressFingerprint(payload);
    if (lastPersistedFingerprintRef.current === fingerprint) {
      return;
    }

    if (scheduledFingerprintsRef.current.has(fingerprint)) {
      await saveQueueRef.current;
      return;
    }

    scheduledFingerprintsRef.current.add(fingerprint);

    const saveTask = saveQueueRef.current.then(async () => {
      if (lastPersistedFingerprintRef.current === fingerprint) {
        return;
      }

      await api.saveWatchProgress(payload);
      lastPersistedFingerprintRef.current = fingerprint;
    });

    saveQueueRef.current = saveTask.catch(() => undefined);

    try {
      await saveTask;
    } finally {
      scheduledFingerprintsRef.current.delete(fingerprint);
    }
  }, [buildWatchProgressPayload]);

  const flushProgress = useCallback(() => {
    void saveProgress();
  }, [saveProgress]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isPlaying && hasPersistableProgress(currentTimeRef.current)) {
        flushProgress();
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [currentTimeRef, flushProgress, isPlaying]);

  useEffect(() => {
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
  }, [flushProgress]);

  useEffect(() => {
    const wasPlaying = lastPlayingStateRef.current;
    lastPlayingStateRef.current = isPlaying;

    if (wasPlaying && !isPlaying) {
      flushProgress();
    }
  }, [flushProgress, isPlaying]);

  const resetNearCompletionState = useEffectEvent((_streamSessionKey: string) => {
    nearCompletionSavedRef.current = false;
  });

  useEffect(() => {
    resetNearCompletionState(
      [activeStreamUrl ?? '', mediaId ?? '', absoluteSeason ?? '', absoluteEpisode ?? ''].join('|'),
    );
  }, [activeStreamUrl, mediaId, absoluteSeason, absoluteEpisode]);

  useEffect(() => {
    if (!isPlaying || nearCompletionSavedRef.current) return;
    if (!shouldFlushNearCompletion(currentTime, duration)) return;

    nearCompletionSavedRef.current = true;
    flushProgress();
  }, [currentTime, duration, flushProgress, isPlaying]);

  useEffect(() => {
    return () => {
      flushProgress();
    };
  }, [flushProgress]);

  return {
    saveProgress,
  };
}
