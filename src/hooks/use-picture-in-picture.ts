import { useCallback, useRef, useState } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

interface UsePictureInPictureOptions {
  onBeforeEnter?: () => Promise<void> | void;
}

interface UsePictureInPictureResult {
  exitPiPAndRestore: () => Promise<void>;
  isPiP: boolean;
  togglePiP: () => Promise<void>;
}

export function usePictureInPicture(
  options: UsePictureInPictureOptions = {},
): UsePictureInPictureResult {
  const { onBeforeEnter } = options;
  const [isPiP, setIsPiP] = useState(false);
  const isPiPRef = useRef(false);
  const pipWindowSizeRef = useRef<{ width: number; height: number } | null>(null);

  const exitPiPAndRestore = useCallback(async () => {
    if (!isPiPRef.current) return;

    isPiPRef.current = false;
    setIsPiP(false);

    const win = getCurrentWindow();
    const saved = pipWindowSizeRef.current;

    await win.setAlwaysOnTop(false).catch(() => undefined);
    await win.setDecorations(true).catch(() => undefined);
    await win
      .setSize(new LogicalSize(saved?.width ?? 1280, saved?.height ?? 800))
      .catch(() => undefined);
  }, []);

  const togglePiP = useCallback(async () => {
    try {
      if (isPiPRef.current) {
        await exitPiPAndRestore();
        return;
      }

      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const outer = await win.outerSize();
      pipWindowSizeRef.current = {
        width: Math.round(outer.width / factor),
        height: Math.round(outer.height / factor),
      };

      if (onBeforeEnter) {
        await onBeforeEnter();
      }

      await win.setDecorations(false);
      await win.setAlwaysOnTop(true);
      await win.setSize(new LogicalSize(480, 270));
      isPiPRef.current = true;
      setIsPiP(true);
    } catch {
      // PiP is a convenience feature; playback should continue even if window control fails.
    }
  }, [exitPiPAndRestore, onBeforeEnter]);

  return {
    exitPiPAndRestore,
    isPiP,
    togglePiP,
  };
}
