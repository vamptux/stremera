import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { type PlaybackStreamOutcome } from '@/lib/playback-stream-health';
import { resolveRankedBestStream } from '@/lib/stream-resolution';

interface StreamFallback {
  url: string;
  format: string;
  sourceName?: string;
  streamFamily?: string;
}

interface UseStreamRecoveryOptions {
  activeStreamUrl?: string;
  initialStreamUrl?: string;
  preparedBackupStream?: StreamFallback;
  isHistoryResume: boolean;
  isOffline: boolean;
  mediaType?: string;
  mediaId?: string;
  resolveSeason?: number;
  resolveEpisode?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  currentTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  mountedRef: MutableRefObject<boolean>;
  lastStreamUrlRef: MutableRefObject<string | undefined>;
  activeStreamFormatRef: MutableRefObject<string | undefined>;
  activeStreamSourceNameRef: MutableRefObject<string | undefined>;
  activeStreamFamilyRef: MutableRefObject<string | undefined>;
  errorRef: MutableRefObject<string | null>;
  beginLoading: () => void;
  stopLoading: (makeTransparent?: boolean) => void;
  setError: (value: string | null) => void;
  setIsResolving: (value: boolean) => void;
  setResolveStatus: (value: string) => void;
  setActiveStreamUrl: (value: string | undefined) => void;
  reportStreamFailure: (
    outcome: Exclude<PlaybackStreamOutcome, 'verified'>,
    streamUrl?: string,
  ) => void;
}

interface UseStreamRecoveryResult {
  clearRecoveryTimers: () => void;
  markPlaybackStarted: () => void;
  recoverFromSlowStartup: (sourceUrl: string) => Promise<boolean>;
  recoverFromStaleSavedStream: () => boolean;
}

function normalizeStreamResolveMediaType(
  mediaType?: string,
  mediaId?: string,
): 'movie' | 'series' | 'anime' | null {
  const normalizedType = mediaType?.trim().toLowerCase();
  if (!normalizedType) return null;
  if (normalizedType === 'movie') return 'movie';
  if (normalizedType === 'anime') return 'anime';
  if (normalizedType === 'series') {
    if (mediaId?.trim().toLowerCase().startsWith('kitsu:')) return 'anime';
    return 'series';
  }
  return null;
}

export function useStreamRecovery({
  activeStreamUrl,
  initialStreamUrl,
  preparedBackupStream,
  isHistoryResume,
  isOffline,
  mediaType,
  mediaId,
  resolveSeason,
  resolveEpisode,
  absoluteEpisode,
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
}: UseStreamRecoveryOptions): UseStreamRecoveryResult {
  const playbackStartedRef = useRef(false);
  const staleLinkRecoveryTriedRef = useRef(false);
  const staleFallbackUrlRef = useRef<StreamFallback | null>(null);
  const staleFallbackInFlightRef = useRef(false);
  const staleFallbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startupWatchdogTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startupWatchdogCancelledRef = useRef(false);
  const startupRecoveryAttemptedForRef = useRef<Set<string>>(new Set());
  const preparedBackupConsumedRef = useRef(false);

  const clearRecoveryTimers = useCallback(() => {
    if (staleFallbackTimerRef.current) {
      clearTimeout(staleFallbackTimerRef.current);
      staleFallbackTimerRef.current = null;
    }
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
    staleLinkRecoveryTriedRef.current = false;
    staleFallbackUrlRef.current = null;
    startupWatchdogCancelledRef.current = false;
  }, [activeStreamUrl]);

  useEffect(() => {
    startupRecoveryAttemptedForRef.current.clear();
    preparedBackupConsumedRef.current = false;
  }, [mediaId, resolveSeason, resolveEpisode, initialStreamUrl]);

  const recoverFromStaleSavedStream = useCallback(() => {
    if (!isHistoryResume) return false;
    if (staleLinkRecoveryTriedRef.current) return false;
    if (!initialStreamUrl || activeStreamUrl !== initialStreamUrl) return false;

    staleLinkRecoveryTriedRef.current = true;
    clearRecoveryTimers();
    setError(null);
    beginLoading();
    reportStreamFailure('expired-saved-stream', activeStreamUrl);

    const fallback = staleFallbackUrlRef.current;
    if (fallback?.url && fallback.url !== activeStreamUrl) {
      setResolveStatus('Saved stream expired, switching to best available stream...');
      activeStreamFormatRef.current = fallback.format;
      activeStreamSourceNameRef.current = fallback.sourceName;
      activeStreamFamilyRef.current = fallback.streamFamily;
      setActiveStreamUrl(fallback.url);
    } else {
      setResolveStatus('Saved stream expired, resolving fresh stream...');
      activeStreamFormatRef.current = undefined;
      activeStreamSourceNameRef.current = undefined;
      activeStreamFamilyRef.current = undefined;
      setActiveStreamUrl(undefined);
    }

    return true;
  }, [
    activeStreamUrl,
    activeStreamFormatRef,
    activeStreamFamilyRef,
    activeStreamSourceNameRef,
    beginLoading,
    clearRecoveryTimers,
    initialStreamUrl,
    isHistoryResume,
    reportStreamFailure,
    setActiveStreamUrl,
    setError,
    setResolveStatus,
  ]);

  const recoverFromSlowStartup = useCallback(
    async (sourceUrl: string) => {
      const effectiveMediaType = normalizeStreamResolveMediaType(mediaType, mediaId);
      if (startupWatchdogCancelledRef.current) return false;
      if (playbackStartedRef.current) return false;
      if (isOffline || !effectiveMediaType || !mediaId || !sourceUrl) return false;
      if (startupRecoveryAttemptedForRef.current.has(sourceUrl)) return false;

      startupRecoveryAttemptedForRef.current.add(sourceUrl);
      setError(null);
      setIsResolving(true);
      setResolveStatus('Playback is taking too long, trying a faster stream...');

      try {
        if (startupWatchdogCancelledRef.current || playbackStartedRef.current) return false;
        reportStreamFailure('startup-timeout', sourceUrl);

        const backupStream = preparedBackupStream;
        const backupStreamUrl = backupStream?.url?.trim();
        if (
          backupStream &&
          !preparedBackupConsumedRef.current &&
          backupStreamUrl &&
          backupStreamUrl !== sourceUrl &&
          lastStreamUrlRef.current === sourceUrl
        ) {
          preparedBackupConsumedRef.current = true;
          activeStreamFormatRef.current = backupStream.format;
          activeStreamSourceNameRef.current = backupStream.sourceName;
          activeStreamFamilyRef.current = backupStream.streamFamily;
          setResolveStatus('Prepared stream stalled, switching to backup candidate...');
          setActiveStreamUrl(backupStreamUrl);
          return true;
        }

        const resolved = await resolveRankedBestStream({
          mediaType: effectiveMediaType,
          mediaId,
          streamLookupId: streamLookupId || mediaId,
          streamSeason: resolveSeason,
          streamEpisode: resolveEpisode,
          absoluteEpisode: absoluteEpisode ?? resolveEpisode,
          bypassCache: true,
          rankingTarget: {
            mediaId,
            mediaType: effectiveMediaType,
            season: resolveSeason,
            episode: resolveEpisode,
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
      isOffline,
      lastStreamUrlRef,
      mediaId,
      mediaType,
      mountedRef,
      preparedBackupStream,
      absoluteEpisode,
      resolveEpisode,
      resolveSeason,
      setActiveStreamUrl,
      setError,
      setIsResolving,
      setResolveStatus,
      streamLookupId,
      reportStreamFailure,
    ],
  );

  useEffect(() => {
    staleFallbackUrlRef.current = null;

    const effectiveMediaType = normalizeStreamResolveMediaType(mediaType, mediaId);

    if (!isHistoryResume) return;
    if (isOffline) return;
    if (!effectiveMediaType || !mediaId || !initialStreamUrl || !activeStreamUrl) return;
    if (activeStreamUrl !== initialStreamUrl) return;
    if (staleFallbackInFlightRef.current) return;

    staleFallbackInFlightRef.current = true;
    let cancelled = false;

    resolveRankedBestStream({
      mediaType: effectiveMediaType,
      mediaId,
      streamLookupId: streamLookupId || mediaId,
      streamSeason: resolveSeason,
      streamEpisode: resolveEpisode,
      absoluteEpisode: absoluteEpisode ?? resolveEpisode,
      bypassCache: true,
      rankingTarget: {
        mediaId,
        mediaType: effectiveMediaType,
        season: resolveSeason,
        episode: resolveEpisode,
      },
    })
      .then((result) => {
        if (cancelled || playbackStartedRef.current || !result?.url) return;
        if (result.url === initialStreamUrl) return;
        staleFallbackUrlRef.current = {
          url: result.url,
          format: result.format,
          sourceName: result.source_name?.trim() || undefined,
          streamFamily: result.stream_family?.trim() || undefined,
        };
      })
      .catch(() => {
        // Best-effort prefetch only.
      })
      .finally(() => {
        if (!cancelled) {
          staleFallbackInFlightRef.current = false;
        }
      });

    staleFallbackTimerRef.current = setTimeout(() => {
      if (cancelled || !mountedRef.current) return;
      if (playbackStartedRef.current) return;
      void recoverFromStaleSavedStream();
    }, 1800);

    return () => {
      cancelled = true;
      staleFallbackInFlightRef.current = false;
      if (staleFallbackTimerRef.current) {
        clearTimeout(staleFallbackTimerRef.current);
        staleFallbackTimerRef.current = null;
      }
    };
  }, [
    activeStreamUrl,
    initialStreamUrl,
    isHistoryResume,
    isOffline,
    mediaId,
    mediaType,
    mountedRef,
    recoverFromStaleSavedStream,
    absoluteEpisode,
    resolveEpisode,
    resolveSeason,
    streamLookupId,
  ]);

  useEffect(() => {
    if (!activeStreamUrl || isOffline) return;

    startupWatchdogCancelledRef.current = false;
    if (startupWatchdogTimerRef.current) {
      clearTimeout(startupWatchdogTimerRef.current);
    }

    const startupWatchdogDelayMs = isHistoryResume ? 7000 : 12000;

    startupWatchdogTimerRef.current = setTimeout(() => {
      if (startupWatchdogCancelledRef.current || !mountedRef.current || errorRef.current) return;

      const stalledAtStart =
        durationRef.current > 0 &&
        currentTimeRef.current >= 0 &&
        currentTimeRef.current <= 0.15;

      if (playbackStartedRef.current && !stalledAtStart) return;

      const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
      if (!currentUrl) return;

      if (isHistoryResume && recoverFromStaleSavedStream()) return;
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
    recoverFromStaleSavedStream,
    setError,
    stopLoading,
  ]);

  return {
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
    recoverFromStaleSavedStream,
  };
}
