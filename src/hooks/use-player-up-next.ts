import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NextPlaybackPlan } from '@/lib/api';

const UP_NEXT_COUNTDOWN_SECONDS = 10;
const NEXT_EPISODE_PREFETCH_MIN_PROGRESS_RATIO = 0.8;
const NEXT_EPISODE_PREFETCH_REMAINING_SECS = 60 * 5;
const NEXT_EPISODE_PREFETCH_MIN_WATCHED_SECS = 90;
const NEXT_EPISODE_PREFETCH_MAX_AGE_MS = 1000 * 60 * 12;

export interface NextEpisodeStreamCoordinates {
  streamLookupId: string;
  streamSeason: number;
  streamEpisode: number;
  absoluteSeason: number;
  absoluteEpisode: number;
  aniskipEpisode: number;
  lookupKey: string;
}

interface CachedNextPlaybackPlan extends NextPlaybackPlan {
  requestKey: string;
  resolvedAt: number;
}

export interface PreparedNextEpisodeStream {
  url: string;
  format: string;
  sourceName?: string;
  streamFamily?: string;
}

interface UsePlayerUpNextArgs {
  mediaType?: string;
  mediaId?: string;
  currentSeason?: number;
  currentEpisode?: number;
  currentStreamLookupId?: string;
  currentTime: number;
  duration: number;
  hasPlaybackStarted: boolean;
}

function shouldPrefetchNextEpisode(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return false;
  if (currentTime < Math.min(NEXT_EPISODE_PREFETCH_MIN_WATCHED_SECS, duration * 0.25)) {
    return false;
  }

  const remaining = Math.max(0, duration - currentTime);
  const progressRatio = currentTime / duration;

  return (
    remaining <= NEXT_EPISODE_PREFETCH_REMAINING_SECS ||
    progressRatio >= NEXT_EPISODE_PREFETCH_MIN_PROGRESS_RATIO
  );
}

export function usePlayerUpNext({
  mediaType,
  mediaId,
  currentSeason,
  currentEpisode,
  currentStreamLookupId,
  currentTime,
  duration,
  hasPlaybackStarted,
}: UsePlayerUpNextArgs) {
  const [showUpNext, setShowUpNext] = useState(false);
  const [upNextCountdown, setUpNextCountdown] = useState(UP_NEXT_COUNTDOWN_SECONDS);
  const [prefetchedPlan, setPrefetchedPlan] = useState<CachedNextPlaybackPlan | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const prefetchInFlightKeyRef = useRef<string | null>(null);
  const activePlanningKey =
    mediaType && mediaId && currentSeason !== undefined && currentEpisode !== undefined
      ? `${mediaType}:${mediaId}:${currentSeason}:${currentEpisode}:${currentStreamLookupId ?? ''}`
      : null;

  const clearCountdown = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const dismissUpNext = useCallback(() => {
    setShowUpNext(false);
    clearCountdown();
  }, [clearCountdown]);

  const startUpNextCountdown = useCallback(() => {
    clearCountdown();
    setShowUpNext(true);
    setUpNextCountdown(UP_NEXT_COUNTDOWN_SECONDS);

    countdownTimerRef.current = window.setInterval(() => {
      setUpNextCountdown((previous) => {
        if (previous <= 1) {
          clearCountdown();
          return 0;
        }

        return previous - 1;
      });
    }, 1000);
  }, [clearCountdown]);

  const getFreshPrefetchedPlan = useCallback(
    (lookupKey?: string) => {
      if (!prefetchedPlan) return null;
      if (lookupKey && prefetchedPlan.lookupKey !== lookupKey) return null;
      if (Date.now() - prefetchedPlan.resolvedAt > NEXT_EPISODE_PREFETCH_MAX_AGE_MS) {
        return null;
      }

      return prefetchedPlan;
    },
    [prefetchedPlan],
  );

  useEffect(() => {
    return () => {
      clearCountdown();
    };
  }, [clearCountdown]);

  useEffect(() => {
    if (!activePlanningKey || !mediaType || !mediaId) {
      prefetchInFlightKeyRef.current = null;
      return;
    }

    const planningSeason = currentSeason;
    const planningEpisode = currentEpisode;
    if (planningSeason === undefined || planningEpisode === undefined) {
      prefetchInFlightKeyRef.current = null;
      return;
    }

    if (!hasPlaybackStarted || !shouldPrefetchNextEpisode(currentTime, duration)) {
      return;
    }

    const freshPlan = getFreshPrefetchedPlan();
    if (freshPlan?.requestKey === activePlanningKey) {
      return;
    }

    if (prefetchInFlightKeyRef.current === activePlanningKey) {
      return;
    }

    let cancelled = false;
    prefetchInFlightKeyRef.current = activePlanningKey;

    api
      .prepareNextPlaybackPlan(
        mediaType,
        mediaId,
        planningSeason,
        planningEpisode,
        currentStreamLookupId,
      )
      .then((plan) => {
        if (cancelled || prefetchInFlightKeyRef.current !== activePlanningKey) {
          return;
        }

        if (!plan) {
          setPrefetchedPlan(null);
          return;
        }

        setPrefetchedPlan({
          ...plan,
          requestKey: activePlanningKey,
          resolvedAt: Date.now(),
        });
      })
      .catch(() => {
        if (!cancelled && prefetchInFlightKeyRef.current === activePlanningKey) {
          setPrefetchedPlan(null);
        }
      })
      .finally(() => {
        if (!cancelled && prefetchInFlightKeyRef.current === activePlanningKey) {
          prefetchInFlightKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      if (prefetchInFlightKeyRef.current === activePlanningKey) {
        prefetchInFlightKeyRef.current = null;
      }
    };
  }, [
    activePlanningKey,
    currentEpisode,
    currentSeason,
    currentTime,
    duration,
    currentStreamLookupId,
    getFreshPrefetchedPlan,
    hasPlaybackStarted,
    mediaId,
    mediaType,
  ]);

  return {
    dismissUpNext,
    getFreshPrefetchedPlan,
    nextPlaybackPlan: activePlanningKey ? getFreshPrefetchedPlan(activePlanningKey) : null,
    showUpNext,
    startUpNextCountdown,
    upNextCountdown,
  };
}
