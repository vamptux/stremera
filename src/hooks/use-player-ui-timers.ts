import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { type PlayerOsdAction } from '@/components/player-osd-overlay';

const CONTROLS_AUTO_HIDE_DELAY_MS = 3000;
const OSD_CLEAR_DELAY_MS = 120;

type TimerHandle = number;

interface UsePlayerUiTimersArgs {
  isPlayingRef: MutableRefObject<boolean>;
  mountedRef: MutableRefObject<boolean>;
  setOsdAction: Dispatch<SetStateAction<PlayerOsdAction | null>>;
  setOsdVisible: Dispatch<SetStateAction<boolean>>;
  setShowControls: Dispatch<SetStateAction<boolean>>;
}

function clearTimer(timerRef: MutableRefObject<TimerHandle | null>) {
  if (timerRef.current === null) {
    return;
  }

  clearTimeout(timerRef.current);
  timerRef.current = null;
}

export function usePlayerUiTimers({
  isPlayingRef,
  mountedRef,
  setOsdAction,
  setOsdVisible,
  setShowControls,
}: UsePlayerUiTimersArgs) {
  const controlsTimeoutRef = useRef<TimerHandle | null>(null);
  const singleClickTimerRef = useRef<TimerHandle | null>(null);
  const osdTimerRef = useRef<TimerHandle | null>(null);
  const osdClearTimerRef = useRef<TimerHandle | null>(null);
  const osdAnimationFrameRef = useRef<number | null>(null);

  const clearControlsAutoHide = useCallback(() => {
    clearTimer(controlsTimeoutRef);
  }, []);

  const clearOsdTimers = useCallback(() => {
    clearTimer(osdTimerRef);
    clearTimer(osdClearTimerRef);

    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }
  }, []);

  const cancelPendingSingleClick = useCallback(() => {
    clearTimer(singleClickTimerRef);
  }, []);

  const scheduleControlsAutoHide = useCallback(
    (delayMs = CONTROLS_AUTO_HIDE_DELAY_MS) => {
      clearControlsAutoHide();

      if (!isPlayingRef.current) {
        return;
      }

      controlsTimeoutRef.current = window.setTimeout(() => {
        if (mountedRef.current && isPlayingRef.current) {
          setShowControls(false);
        }

        controlsTimeoutRef.current = null;
      }, delayMs);
    },
    [clearControlsAutoHide, isPlayingRef, mountedRef, setShowControls],
  );

  const showControlsWithAutoHide = useCallback(
    (delayMs = CONTROLS_AUTO_HIDE_DELAY_MS) => {
      setShowControls(true);

      if (!isPlayingRef.current) {
        clearControlsAutoHide();
        return;
      }

      scheduleControlsAutoHide(delayMs);
    },
    [clearControlsAutoHide, isPlayingRef, scheduleControlsAutoHide, setShowControls],
  );

  const queueSingleClick = useCallback(
    (callback: () => void, delayMs = 200) => {
      cancelPendingSingleClick();

      singleClickTimerRef.current = window.setTimeout(() => {
        singleClickTimerRef.current = null;
        callback();
      }, delayMs);
    },
    [cancelPendingSingleClick],
  );

  const triggerOsd = useCallback(
    (action: PlayerOsdAction) => {
      clearOsdTimers();

      setOsdVisible(false);
      setOsdAction(action);
      osdAnimationFrameRef.current = window.requestAnimationFrame(() => {
        osdAnimationFrameRef.current = null;
        setOsdVisible(true);
      });

      const visibleMs =
        action.kind === 'play' || action.kind === 'pause'
          ? 340
          : action.kind === 'message'
            ? 2800
            : 900;

      osdTimerRef.current = window.setTimeout(() => {
        setOsdVisible(false);
        osdTimerRef.current = null;
        osdClearTimerRef.current = window.setTimeout(() => {
          osdClearTimerRef.current = null;
          setOsdAction(null);
        }, OSD_CLEAR_DELAY_MS);
      }, visibleMs);
    },
    [clearOsdTimers, setOsdAction, setOsdVisible],
  );

  const clearUiTimers = useCallback(() => {
    clearControlsAutoHide();
    cancelPendingSingleClick();
    clearOsdTimers();
  }, [cancelPendingSingleClick, clearControlsAutoHide, clearOsdTimers]);

  return {
    cancelPendingSingleClick,
    clearControlsAutoHide,
    clearUiTimers,
    queueSingleClick,
    showControlsWithAutoHide,
    triggerOsd,
  };
}