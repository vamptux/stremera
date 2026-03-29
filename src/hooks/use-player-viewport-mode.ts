import { useCallback, useEffect, useRef, useState } from 'react';

interface UsePlayerViewportModeOptions {
  onBeforeEnterFullscreen?: () => Promise<void> | void;
}

interface UsePlayerViewportModeResult {
  beginPlayerExit: () => Promise<void>;
  cleanupViewportOnUnmount: () => void;
  isFullscreen: boolean;
  prepareForInternalPlayerNavigation: () => void;
  toggleFullscreen: () => Promise<void>;
}

export function usePlayerViewportMode(
  options: UsePlayerViewportModeOptions = {},
): UsePlayerViewportModeResult {
  const { onBeforeEnterFullscreen } = options;
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);
  const preserveViewportOnUnmountRef = useRef(false);
  const viewportCleanupHandledRef = useRef(false);

  const exitFullscreenIfNeeded = useCallback(async () => {
    if (!document.fullscreenElement) {
      setIsFullscreen(false);
      return;
    }

    await document.exitFullscreen().catch(() => undefined);
    setIsFullscreen(false);
  }, []);

  const beginPlayerExit = useCallback(async () => {
    preserveViewportOnUnmountRef.current = false;
    viewportCleanupHandledRef.current = true;
    await exitFullscreenIfNeeded();
  }, [exitFullscreenIfNeeded]);

  const cleanupViewportOnUnmount = useCallback(() => {
    if (viewportCleanupHandledRef.current) return;

    viewportCleanupHandledRef.current = true;
    const shouldPreserveViewport = preserveViewportOnUnmountRef.current;
    preserveViewportOnUnmountRef.current = false;

    if (shouldPreserveViewport) {
      return;
    }

    void exitFullscreenIfNeeded();
  }, [exitFullscreenIfNeeded]);

  const prepareForInternalPlayerNavigation = useCallback(() => {
    preserveViewportOnUnmountRef.current = true;
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await exitFullscreenIfNeeded();
        return;
      }

      preserveViewportOnUnmountRef.current = false;
      if (onBeforeEnterFullscreen) {
        await onBeforeEnterFullscreen();
      }
      await document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } catch {
      setIsFullscreen(!!document.fullscreenElement);
    }
  }, [exitFullscreenIfNeeded, onBeforeEnterFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return {
    beginPlayerExit,
    cleanupViewportOnUnmount,
    isFullscreen,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  };
}