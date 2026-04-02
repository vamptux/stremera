import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { type PlaybackStreamOutcome } from '@/lib/playback-stream-health';
import { recoverPlaybackStream } from '@/lib/stream-resolution';

interface StreamFallback {
  url: string;
  format: string;
  sourceName?: string;
  streamFamily?: string;
}

interface UseStreamRecoveryOptions {
  activeStreamUrl?: string;
  preparedBackupStream?: StreamFallback;
  isHistoryResume: boolean;
  isOffline: boolean;
  mediaType?: string;
  mediaId?: string;
  title?: string;
  resolveSeason?: number;
  resolveEpisode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  currentTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  mountedRef: MutableRefObject<boolean>;
  lastStreamUrlRef: MutableRefObject<string | undefined>;
  activeStreamFormatRef: MutableRefObject<string | undefined>;
  activeStreamSourceNameRef: MutableRefObject<string | undefined>;
  activeStreamFamilyRef: MutableRefObject<string | undefined>;
  selectedStreamKeyRef: MutableRefObject<string | undefined>;
  errorRef: MutableRefObject<string | null>;
  stopLoading: (makeTransparent?: boolean) => void;
  setError: (value: string | null) => void;
  setIsResolving: (value: boolean) => void;
  setResolveStatus: (value: string) => void;
  setActiveStreamUrl: (value: string | undefined) => void;
  onSavedStreamUnavailable?: () => void;
  reportStreamFailure: (
    outcome: Exclude<PlaybackStreamOutcome, 'verified'>,
    streamUrl?: string,
  ) => void;
}

interface UseStreamRecoveryResult {
  clearRecoveryTimers: () => void;
  markPlaybackStarted: () => void;
  recoverFromSlowStartup: (sourceUrl: string) => Promise<boolean>;
}

export function useStreamRecovery({
  activeStreamUrl,
  preparedBackupStream,
  isHistoryResume,
  isOffline,
  mediaType,
  mediaId,
  title,
  resolveSeason,
  resolveEpisode,
  absoluteSeason,
  absoluteEpisode,
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
  onSavedStreamUnavailable,
  reportStreamFailure,
}: UseStreamRecoveryOptions): UseStreamRecoveryResult {
  const playbackStartedRef = useRef(false);
  const startupWatchdogTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startupWatchdogCancelledRef = useRef(false);
  const startupRecoveryAttemptedForRef = useRef<Set<string>>(new Set());

  const clearRecoveryTimers = useCallback(() => {
    if (startupWatchdogTimerRef.current) {
      clearTimeout(startupWatchdogTimerRef.current);
      startupWatchdogTimerRef.current = null;
    }
  }, []);

  const markPlaybackStarted = useCallback(() => {
    playbackStartedRef.current = true;
    startupWatchdogCancelledRef.current = true;
    clearRecoveryTimers();
  }, [clearRecoveryTimers]);

  useEffect(() => {
    playbackStartedRef.current = false;
    startupWatchdogCancelledRef.current = false;
  }, [activeStreamUrl]);

  useEffect(() => {
    startupRecoveryAttemptedForRef.current.clear();
  }, [absoluteEpisode, absoluteSeason, mediaId, resolveSeason, resolveEpisode]);

  const recoverFromSlowStartup = useCallback(
    async (sourceUrl: string) => {
      const effectiveMediaType = mediaType?.trim().toLowerCase();
      if (startupWatchdogCancelledRef.current) return false;
      if (playbackStartedRef.current) return false;
      if (isHistoryResume) return false;
      if (
        isOffline ||
        !mediaId ||
        !sourceUrl ||
        (effectiveMediaType !== 'movie' &&
          effectiveMediaType !== 'series' &&
          effectiveMediaType !== 'anime')
      ) {
        return false;
      }
      if (startupRecoveryAttemptedForRef.current.has(sourceUrl)) return false;

      startupRecoveryAttemptedForRef.current.add(sourceUrl);
      setError(null);
      setIsResolving(true);
      setResolveStatus('Playback is taking too long, trying a faster stream...');

      try {
        if (startupWatchdogCancelledRef.current || playbackStartedRef.current) return false;
        const resolved = await recoverPlaybackStream({
          mediaType: effectiveMediaType,
          mediaId,
          streamLookupId: streamLookupId || mediaId,
          streamSeason: resolveSeason,
          streamEpisode: resolveEpisode,
          absoluteSeason,
          absoluteEpisode: absoluteEpisode ?? resolveEpisode,
          failedStreamUrl: sourceUrl,
          failedStreamFormat: activeStreamFormatRef.current,
          failedSourceName: activeStreamSourceNameRef.current,
          failedStreamFamily: activeStreamFamilyRef.current,
          failedStreamKey: selectedStreamKeyRef.current,
          preparedBackupStream,
          outcome: 'startup-timeout',
          rankingTarget: {
            mediaId,
            mediaType: effectiveMediaType,
            season: resolveSeason,
            episode: resolveEpisode,
            title,
          },
        });

        if (startupWatchdogCancelledRef.current || playbackStartedRef.current) return false;
        if (!mountedRef.current) return false;
        if (lastStreamUrlRef.current !== sourceUrl) return false;

        if (resolved?.url && resolved.url !== sourceUrl) {
          activeStreamFormatRef.current = resolved.format;
          activeStreamSourceNameRef.current = resolved.source_name?.trim() || undefined;
          activeStreamFamilyRef.current = resolved.stream_family?.trim() || undefined;
          setActiveStreamUrl(resolved.url);
          return true;
        }
      } catch {
        // Best-effort recovery only.
      } finally {
        if (!startupWatchdogCancelledRef.current && mountedRef.current) {
          setIsResolving(false);
          setResolveStatus('');
        }
      }

      return false;
    },
    [
      activeStreamFormatRef,
      activeStreamFamilyRef,
      activeStreamSourceNameRef,
      absoluteSeason,
      isHistoryResume,
      isOffline,
      lastStreamUrlRef,
      mediaId,
      mediaType,
      title,
      mountedRef,
      preparedBackupStream,
      absoluteEpisode,
      resolveEpisode,
      resolveSeason,
      selectedStreamKeyRef,
      setActiveStreamUrl,
      setError,
      setIsResolving,
      setResolveStatus,
      streamLookupId,
    ],
  );

  useEffect(() => {
    if (!activeStreamUrl || isOffline) return;

    startupWatchdogCancelledRef.current = false;
    if (startupWatchdogTimerRef.current) {
      clearTimeout(startupWatchdogTimerRef.current);
    }

    const startupWatchdogDelayMs = isHistoryResume ? 10000 : 12000;

    startupWatchdogTimerRef.current = setTimeout(() => {
      if (startupWatchdogCancelledRef.current || !mountedRef.current || errorRef.current) return;

      const hasAnyProgress = durationRef.current > 0 || currentTimeRef.current > 0.1;
      const stalledAtStart =
        durationRef.current > 0 && currentTimeRef.current >= 0 && currentTimeRef.current <= 0.15;

      if (playbackStartedRef.current && !stalledAtStart) return;
      // If we have duration or time progress, the stream is working — give it more time
      if (hasAnyProgress && !stalledAtStart) return;

      const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
      if (!currentUrl) return;

      if (isHistoryResume) {
        reportStreamFailure('load-failed', currentUrl);
        stopLoading();
        onSavedStreamUnavailable?.();
        return;
      }
      if (startupWatchdogCancelledRef.current) return;

      void recoverFromSlowStartup(currentUrl).then((didRecover) => {
        if (
          startupWatchdogCancelledRef.current ||
          didRecover ||
          !mountedRef.current ||
          playbackStartedRef.current
        ) {
          return;
        }
        setError('This stream is taking too long to start. Try another stream.');
        stopLoading();
      });
    }, startupWatchdogDelayMs);

    return () => {
      startupWatchdogCancelledRef.current = true;
      if (startupWatchdogTimerRef.current) {
        clearTimeout(startupWatchdogTimerRef.current);
        startupWatchdogTimerRef.current = null;
      }
    };
  }, [
    activeStreamUrl,
    currentTimeRef,
    durationRef,
    errorRef,
    isHistoryResume,
    isOffline,
    lastStreamUrlRef,
    mountedRef,
    recoverFromSlowStartup,
    setError,
    stopLoading,
    reportStreamFailure,
    onSavedStreamUnavailable,
  ]);

  return {
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
  };
}
