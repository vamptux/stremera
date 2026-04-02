import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  command,
  destroy,
  init,
  listenEvents,
  observeProperties,
  setProperty,
  setVideoMarginRatio,
} from 'tauri-plugin-libmpv-api';

import { type PlaybackLanguagePreferences } from '@/lib/api';
import {
  buildPlayerMpvConfig,
  isPlayerTrackRefreshProperty,
  PLAYER_MPV_OBSERVED_PROPERTIES,
} from '@/lib/player-mpv';

const TIME_UPDATE_THROTTLE_MS = 350;
const OPTIMISTIC_SEEK_SETTLED_DELTA_SECS = 1.1;

type TimerHandle = ReturnType<typeof setTimeout>;
type StreamFailureOutcome = 'load-failed' | 'disconnected';

interface UsePlayerMpvLifecycleArgs {
  activeStreamUrl?: string;
  isOffline: boolean;
  isHistoryResume: boolean;
  isDev: boolean;
  playbackSpeed: number;
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  playbackLanguagePreferencesRef: MutableRefObject<PlaybackLanguagePreferences>;
  volumeRef: MutableRefObject<number>;
  mountedRef: MutableRefObject<boolean>;
  isDestroyedRef: MutableRefObject<boolean>;
  mpvInitializedRef: MutableRefObject<boolean>;
  isLoadingRef: MutableRefObject<boolean>;
  isPlayingRef: MutableRefObject<boolean>;
  currentTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  pendingSeekTargetRef: MutableRefObject<number | null>;
  pendingSeekDeadlineRef: MutableRefObject<number>;
  lastTimeUpdateRef: MutableRefObject<number>;
  playbackVerifiedAtRef: MutableRefObject<number>;
  errorRef: MutableRefObject<string | null>;
  forceShowTimeoutRef: MutableRefObject<TimerHandle | null>;
  handleEndedRef: MutableRefObject<(() => void) | undefined>;
  saveProgressRef: MutableRefObject<(() => Promise<void>) | undefined>;
  lastStreamUrlRef: MutableRefObject<string | undefined>;
  setIsResolving: Dispatch<SetStateAction<boolean>>;
  setResolveStatus: Dispatch<SetStateAction<string>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setCurrentTime: Dispatch<SetStateAction<number>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setVolume: Dispatch<SetStateAction<number>>;
  setIsMuted: Dispatch<SetStateAction<boolean>>;
  setPlaybackSpeed: Dispatch<SetStateAction<number>>;
  setMpvSurfaceReady: Dispatch<SetStateAction<boolean>>;
  setSurfaceLayoutRefreshToken: Dispatch<SetStateAction<number>>;
  clearUiTimers: () => void;
  clearResumeRetryTimer: () => void;
  clearRecoveryTimers: () => void;
  prepareForStreamLoad: () => boolean;
  markPlaybackReady: () => void;
  applyResumeIfReady: () => Promise<void>;
  clearOptimisticSeek: () => void;
  refreshTracks: () => Promise<unknown>;
  reportStreamFailure: (outcome: StreamFailureOutcome, sourceUrl?: string) => void;
  recoverFromSlowStartup: (sourceUrl: string) => Promise<boolean>;
  reopenSelectorForSavedStreamFailure: () => void;
  stopLoading: (makeTransparent?: boolean) => void;
  setTransparent: (transparent: boolean) => void;
  restorePlayerSurface: () => void;
}

export function usePlayerMpvLifecycle({
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
}: UsePlayerMpvLifecycleArgs) {
  useEffect(() => {
    if (!activeStreamUrl) return;

    if (isOffline) {
      setIsResolving(false);
      setResolveStatus('');
    }

    if (lastStreamUrlRef.current !== activeStreamUrl) {
      lastStreamUrlRef.current = activeStreamUrl;
    }

    isDestroyedRef.current = false;
    mpvInitializedRef.current = false;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenEvents: (() => void) | undefined;
    let loadfileSent = false;

    const initPlayer = async () => {
      setIsLoading(true);
      isLoadingRef.current = true;
      setError(null);
      setCurrentTime(0);
      setDuration(0);

      setTransparent(false);

      try {
        try {
          await destroy();
        } catch {
          // Ignore cleanup failures from a prior instance.
        }

        setMpvSurfaceReady(false);

        await new Promise((resolve) => setTimeout(resolve, 150));
        if (cancelled) return;

        const shouldStartPaused = prepareForStreamLoad();
        const currentPlaybackLanguagePreferences = playbackLanguagePreferencesRef.current;
        const mpvConfig = buildPlayerMpvConfig({
          initialVolume: volumeRef.current,
          startPaused: shouldStartPaused,
          isOffline,
          preferredAudioLanguage: currentPlaybackLanguagePreferences.preferredAudioLanguage,
          preferredSubtitleLanguage: currentPlaybackLanguagePreferences.preferredSubtitleLanguage,
        });
        const observedProperties =
          mpvConfig.observedProperties ?? PLAYER_MPV_OBSERVED_PROPERTIES;

        await init(mpvConfig);
        if (cancelled) return;

        await setProperty('sub-delay', subtitleDelay);
        await setProperty('sub-pos', subtitlePos);
        if (subtitleScale !== 1.0) await setProperty('sub-scale', subtitleScale);
        if (playbackSpeed !== 1.0) {
          await setProperty('speed', playbackSpeed);
        }
        mpvInitializedRef.current = true;
        setMpvSurfaceReady(true);

        unlisten = await observeProperties(observedProperties, (event) => {
          if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
          const { name, data } = event;

          if (isPlayerTrackRefreshProperty(name)) {
            void refreshTracks();
            return;
          }

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

                const previousTime = currentTimeRef.current;
                currentTimeRef.current = data;
                if (
                  now - lastTimeUpdateRef.current > TIME_UPDATE_THROTTLE_MS ||
                  Math.abs(previousTime - data) > 2
                ) {
                  lastTimeUpdateRef.current = now;
                  setCurrentTime(data);
                }
                if (isLoadingRef.current && data > 0.1) {
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
            case 'idle-active':
              if (data === true) {
                if (isOffline || errorRef.current) break;
                if (isLoadingRef.current && !loadfileSent) break;

                const IDLE_GRACE_MS = 4000;
                const verifiedAt = playbackVerifiedAtRef.current;
                if (verifiedAt > 0 && performance.now() - verifiedAt < IDLE_GRACE_MS) break;

                const hasProgressedMeaningfully =
                  currentTimeRef.current > 2 && durationRef.current > 0;

                const nearEnd =
                  durationRef.current > 0 &&
                  currentTimeRef.current >= Math.max(0, durationRef.current - 1);
                if (nearEnd) break;

                const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
                if (!currentUrl) break;

                const duringInitialLoad = isLoadingRef.current;

                if (isHistoryResume && hasProgressedMeaningfully) break;

                reportStreamFailure(
                  duringInitialLoad ? 'load-failed' : 'disconnected',
                  currentUrl,
                );
                if (isHistoryResume) {
                  if (duringInitialLoad) stopLoading();
                  reopenSelectorForSavedStreamFailure();
                  break;
                }

                if (hasProgressedMeaningfully) break;

                void recoverFromSlowStartup(currentUrl).then((didRecover) => {
                  if (didRecover || !mountedRef.current || errorRef.current) return;

                  const stillNearEnd =
                    durationRef.current > 0 &&
                    currentTimeRef.current >= Math.max(0, durationRef.current - 1);
                  if (stillNearEnd) return;

                  if (playbackVerifiedAtRef.current > 0 && currentTimeRef.current > 0.5) return;

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
              if (data === false) {
                if (isLoadingRef.current && (durationRef.current > 0 || loadfileSent)) {
                  markPlaybackReady();
                }
                void applyResumeIfReady();
              }
              break;
          }
        });

        unlistenEvents = await listenEvents((event) => {
          if (cancelled || !mountedRef.current || isDestroyedRef.current) return;

          if (
            event.event === 'file-loaded' ||
            event.event === 'audio-reconfig' ||
            event.event === 'video-reconfig' ||
            event.event === 'playback-restart'
          ) {
            void refreshTracks();
            window.requestAnimationFrame(() => {
              if (!cancelled && mountedRef.current && !isDestroyedRef.current) {
                setSurfaceLayoutRefreshToken((version) => version + 1);
              }
            });
          }
        });

        if (cancelled) {
          if (unlisten) unlisten();
          if (unlistenEvents) unlistenEvents();
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
            if (isDev) console.warn('Force showing player after timeout.');
            stopLoading(true);
            forceShowTimeoutRef.current = setTimeout(() => {
              if (cancelled || !mountedRef.current || errorRef.current) return;
              if (playbackVerifiedAtRef.current > 0) return;
              if (durationRef.current > 0 && currentTimeRef.current > 0.1) return;
              reportStreamFailure('load-failed');
              setError('Stream failed to load. Try another stream.');
              stopLoading();
            }, 5000);
          }
        }, 6500);
      } catch (error) {
        if (cancelled) return;
        if (isDev) console.error('MPV Init Error:', error);
        reportStreamFailure('load-failed');
        if (mountedRef.current) {
          setError('Failed to initialize player. Please try a different stream.');
          stopLoading();
        }
      }
    };

    void initPlayer();

    const saveProgress = saveProgressRef.current;

    return () => {
      cancelled = true;
      isDestroyedRef.current = true;
      mpvInitializedRef.current = false;
      setMpvSurfaceReady(false);
      if (unlisten) unlisten();
      if (unlistenEvents) unlistenEvents();
      clearUiTimers();
      clearResumeRetryTimer();
      clearRecoveryTimers();
      void destroy().catch(() => undefined);
      void setVideoMarginRatio({ left: 0, right: 0, top: 0, bottom: 0 }).catch(() => undefined);
      restorePlayerSurface();
      void saveProgress?.();
    };
    // Intentionally scoped dependencies: this hook owns MPV init/teardown and should
    // not restart on transient UI state changes that are already bridged through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeStreamUrl,
    clearRecoveryTimers,
    clearResumeRetryTimer,
    clearUiTimers,
    isDev,
    markPlaybackReady,
    reopenSelectorForSavedStreamFailure,
    restorePlayerSurface,
    prepareForStreamLoad,
    stopLoading,
    clearOptimisticSeek,
    refreshTracks,
  ]);
}