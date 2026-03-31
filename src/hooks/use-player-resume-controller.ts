import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { command, setProperty } from 'tauri-plugin-libmpv-api';
import { api } from '@/lib/api';

const RESUME_SEEK_MAX_ATTEMPTS = 6;
const RESUME_SEEK_RETRY_DELAY_MS = 220;
const RESUME_SEEK_SETTLE_TOLERANCE_SECS = 2;
const RESUME_FETCH_UPGRADE_MIN_DELTA_SECS = 8;

function normalizeResumeTime(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasResumeReadinessSignal(currentTime: number, duration: number): boolean {
  return (
    (Number.isFinite(duration) && duration > 0) ||
    (Number.isFinite(currentTime) && currentTime > 0)
  );
}

function formatResumeTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainingSeconds = Math.floor(whole % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

interface UsePlayerResumeControllerArgs {
  mediaId?: string;
  mediaType?: string;
  activeStreamUrl?: string;
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  isHistoryResume: boolean;
  mountedRef: MutableRefObject<boolean>;
  isDestroyedRef: MutableRefObject<boolean>;
  currentTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  onResumeMessage: (text: string) => void;
}

export function usePlayerResumeController({
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
}: UsePlayerResumeControllerArgs) {
  const initialTimeRef = useRef(0);
  const resumeTimeRef = useRef(0);
  const resumeAppliedRef = useRef(false);
  const resumeSeekAttemptsRef = useRef(0);
  const resumeSeekInFlightRef = useRef(false);
  const resumeSeekRetryTimerRef = useRef<number | null>(null);
  const resumePausePendingRef = useRef(false);
  const resumeOsdShownRef = useRef(false);
  const applyResumeIfReadyRef = useRef<() => Promise<void>>(async () => undefined);

  const clearResumeRetryTimer = useCallback(() => {
    if (resumeSeekRetryTimerRef.current !== null) {
      window.clearTimeout(resumeSeekRetryTimerRef.current);
      resumeSeekRetryTimerRef.current = null;
    }
  }, []);

  const releaseResumePause = useCallback(async () => {
    if (!resumePausePendingRef.current || !mountedRef.current || isDestroyedRef.current) {
      return;
    }

    resumePausePendingRef.current = false;

    try {
      await setProperty('pause', false);
    } catch {
      try {
        await command('set', ['pause', 'no']);
      } catch {
        // Resume release is best-effort only.
      }
    }
  }, [isDestroyedRef, mountedRef]);

  const finalizeResume = useCallback(
    async (resumeTime: number, didSeek: boolean) => {
      resumeAppliedRef.current = true;
      resumeSeekInFlightRef.current = false;
      resumeSeekAttemptsRef.current = 0;
      clearResumeRetryTimer();

      if (didSeek && isHistoryResume && resumeTime > 60 && !resumeOsdShownRef.current) {
        resumeOsdShownRef.current = true;
        onResumeMessage(`Resuming from ${formatResumeTime(resumeTime)}`);
      }

      await releaseResumePause();
    },
    [clearResumeRetryTimer, isHistoryResume, onResumeMessage, releaseResumePause],
  );

  const scheduleResumeRetry = useCallback((delayMs = RESUME_SEEK_RETRY_DELAY_MS) => {
    if (resumeAppliedRef.current || resumeSeekRetryTimerRef.current !== null) {
      return;
    }

    resumeSeekRetryTimerRef.current = window.setTimeout(() => {
      resumeSeekRetryTimerRef.current = null;
      void applyResumeIfReadyRef.current();
    }, delayMs);
  }, []);

  const applyResumeIfReady = useCallback(async () => {
    const resumeTime = resumeTimeRef.current || initialTimeRef.current;
    const currentTime = currentTimeRef.current;
    const durationValue = durationRef.current;

    if (resumeAppliedRef.current) {
      await releaseResumePause();
      return;
    }

    if (resumeTime <= 5) {
      clearResumeRetryTimer();
      await releaseResumePause();
      return;
    }

    if (durationValue > 0 && resumeTime >= Math.max(5, durationValue - 5)) {
      await finalizeResume(resumeTime, false);
      return;
    }

    if (!hasResumeReadinessSignal(currentTime, durationValue)) {
      scheduleResumeRetry();
      return;
    }

    const satisfiedResumeTime = Math.max(0, resumeTime - RESUME_SEEK_SETTLE_TOLERANCE_SECS);
    if (currentTime >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    if (resumeSeekInFlightRef.current) {
      return;
    }

    if (resumeSeekAttemptsRef.current >= RESUME_SEEK_MAX_ATTEMPTS) {
      await finalizeResume(resumeTime, false);
      return;
    }

    resumeSeekInFlightRef.current = true;
    resumeSeekAttemptsRef.current += 1;

    try {
      await command('seek', [resumeTime.toString(), 'absolute']);
    } catch {
      // MPV may reject early seeks before metadata is ready.
    } finally {
      resumeSeekInFlightRef.current = false;
    }

    if (currentTimeRef.current >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    scheduleResumeRetry(durationValue > 0 ? 140 : RESUME_SEEK_RETRY_DELAY_MS);
  }, [clearResumeRetryTimer, currentTimeRef, durationRef, finalizeResume, releaseResumePause, scheduleResumeRetry]);

  const prepareForStreamLoad = useCallback(() => {
    resumeAppliedRef.current = false;
    const initialResumeTime = Math.max(resumeTimeRef.current || 0, initialTimeRef.current || 0);
    const shouldStartPaused = initialResumeTime > 5;
    resumePausePendingRef.current = shouldStartPaused;
    return shouldStartPaused;
  }, []);

  useEffect(() => {
    applyResumeIfReadyRef.current = applyResumeIfReady;
  }, [applyResumeIfReady]);

  useEffect(() => {
    const normalizedStartTime = normalizeResumeTime(startTime);

    resumeTimeRef.current = normalizedStartTime;
    initialTimeRef.current = normalizedStartTime;
    resumeAppliedRef.current = false;
    resumeSeekAttemptsRef.current = 0;
    resumeSeekInFlightRef.current = false;
    resumePausePendingRef.current = false;
    resumeOsdShownRef.current = false;
    clearResumeRetryTimer();

    if (
      normalizedStartTime > 5 &&
      activeStreamUrl &&
      hasResumeReadinessSignal(currentTimeRef.current, durationRef.current)
    ) {
      void applyResumeIfReadyRef.current();
    }
  }, [activeStreamUrl, clearResumeRetryTimer, currentTimeRef, durationRef, startTime]);

  useEffect(() => {
    if (!mediaType || !mediaId || mediaId === 'local') {
      return;
    }

    let cancelled = false;

    void api
      .getWatchProgress(mediaId, mediaType, absoluteSeason, absoluteEpisode)
      .then((progress) => {
        if (cancelled || !progress?.position || progress.position <= 0) {
          return;
        }

        const candidate = progress.position;
        const currentResume = resumeTimeRef.current || 0;
        const shouldUpgradeResume =
          currentResume <= 0 || candidate >= currentResume + RESUME_FETCH_UPGRADE_MIN_DELTA_SECS;

        if (shouldUpgradeResume) {
          resumeTimeRef.current = candidate;
          resumeAppliedRef.current = false;
          resumeOsdShownRef.current = false;

          if (activeStreamUrl && (durationRef.current > 0 || currentTimeRef.current > 0)) {
            void applyResumeIfReadyRef.current();
          }
        }

        initialTimeRef.current = Math.max(initialTimeRef.current, resumeTimeRef.current);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeStreamUrl,
    absoluteEpisode,
    absoluteSeason,
    currentTimeRef,
    durationRef,
    mediaId,
    mediaType,
    startTime,
  ]);

  return {
    applyResumeIfReady,
    clearResumeRetryTimer,
    prepareForStreamLoad,
  };
}