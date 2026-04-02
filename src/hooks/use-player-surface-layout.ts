import { useEffect, useRef, useState, type RefObject } from 'react';
import { setVideoMarginRatio, type VideoMarginRatio } from 'tauri-plugin-libmpv-api';

const PLAYER_SIDEBAR_WIDTH_PX = 60;
const PLAYER_TITLEBAR_HEIGHT_PX = 32;

function clampMarginRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function normalizeMarginRatioPart(value?: number): number {
  return Math.round((value ?? 0) * 10000) / 10000;
}

function serializeVideoMarginRatio(ratio: VideoMarginRatio): string {
  return [
    normalizeMarginRatioPart(ratio.left),
    normalizeMarginRatioPart(ratio.right),
    normalizeMarginRatioPart(ratio.top),
    normalizeMarginRatioPart(ratio.bottom),
  ].join('|');
}

function buildVideoMarginRatio(
  viewportWidth: number,
  viewportHeight: number,
  insets: {
    leftPx: number;
    rightPx: number;
    topPx: number;
    bottomPx: number;
  },
): VideoMarginRatio {
  const ratio: VideoMarginRatio = {
    left: clampMarginRatio(insets.leftPx / viewportWidth),
    right: clampMarginRatio(insets.rightPx / viewportWidth),
    top: clampMarginRatio(insets.topPx / viewportHeight),
    bottom: clampMarginRatio(insets.bottomPx / viewportHeight),
  };

  const horizontalTotal = (ratio.left ?? 0) + (ratio.right ?? 0);
  if (horizontalTotal >= 0.98) {
    const scale = 0.98 / horizontalTotal;
    ratio.left = (ratio.left ?? 0) * scale;
    ratio.right = (ratio.right ?? 0) * scale;
  }

  const verticalTotal = (ratio.top ?? 0) + (ratio.bottom ?? 0);
  if (verticalTotal >= 0.98) {
    const scale = 0.98 / verticalTotal;
    ratio.top = (ratio.top ?? 0) * scale;
    ratio.bottom = (ratio.bottom ?? 0) * scale;
  }

  return ratio;
}

interface UsePlayerSurfaceLayoutArgs {
  playerContainerRef: RefObject<HTMLDivElement | null>;
  topChromeRef: RefObject<HTMLDivElement | null>;
  bottomChromeRef: RefObject<HTMLDivElement | null>;
  episodesPanelFrameRef: RefObject<HTMLDivElement | null>;
  refreshToken: number;
  activeStreamUrl?: string;
  mpvSurfaceReady: boolean;
  isFullscreen: boolean;
  isLoading: boolean;
  isResolving: boolean;
  hasError: boolean;
  showErrorOverlay: boolean;
  showEpisodes: boolean;
  showStreamSelector: boolean;
  showDownloadModal: boolean;
}

export function usePlayerSurfaceLayout({
  playerContainerRef,
  topChromeRef,
  bottomChromeRef,
  episodesPanelFrameRef,
  refreshToken,
  activeStreamUrl,
  mpvSurfaceReady,
  isFullscreen,
  isLoading,
  isResolving,
  hasError,
  showErrorOverlay,
  showEpisodes,
  showStreamSelector,
  showDownloadModal,
}: UsePlayerSurfaceLayoutArgs) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const lastAppliedMarginFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    lastAppliedMarginFingerprintRef.current = null;
  }, [activeStreamUrl, mpvSurfaceReady]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;

    const observedElements = [
      playerContainerRef.current,
      topChromeRef.current,
      bottomChromeRef.current,
      episodesPanelFrameRef.current,
    ].filter(Boolean) as HTMLDivElement[];

    if (observedElements.length === 0) return;

    let animationFrameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        setLayoutVersion((version) => version + 1);
      });
    });

    observedElements.forEach((element) => observer.observe(element));

    return () => {
      observer.disconnect();
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [bottomChromeRef, episodesPanelFrameRef, playerContainerRef, showEpisodes, topChromeRef]);

  useEffect(() => {
    if (!mpvSurfaceReady || !activeStreamUrl) return;

    let cancelled = false;

    const applyMarginRatio = async (ratio: VideoMarginRatio) => {
      const fingerprint = serializeVideoMarginRatio(ratio);
      if (lastAppliedMarginFingerprintRef.current === fingerprint) {
        return;
      }

      lastAppliedMarginFingerprintRef.current = fingerprint;

      try {
        await setVideoMarginRatio(ratio);
      } catch (error) {
        if (lastAppliedMarginFingerprintRef.current === fingerprint) {
          lastAppliedMarginFingerprintRef.current = null;
        }
        throw error;
      }
    };

    const applyVideoMargins = async () => {
      const containerRect = playerContainerRef.current?.getBoundingClientRect();
      if (!containerRect || containerRect.width <= 0 || containerRect.height <= 0) {
        return;
      }

      const shouldReserveOverlayChrome =
        isLoading || isResolving || hasError;
      const shouldCollapseVideoSurface =
        showStreamSelector || showDownloadModal || showErrorOverlay;
      const topChromeRect = topChromeRef.current?.getBoundingClientRect();
      const bottomChromeRect = bottomChromeRef.current?.getBoundingClientRect();
      const episodesPanelRect = showEpisodes
        ? episodesPanelFrameRef.current?.getBoundingClientRect()
        : null;

      if (shouldCollapseVideoSurface) {
        if (cancelled) return;
        await applyMarginRatio(
          buildVideoMarginRatio(containerRect.width, containerRect.height, {
            leftPx: 0,
            rightPx: Math.max(0, containerRect.width - 16),
            topPx: 0,
            bottomPx: Math.max(0, containerRect.height - 16),
          }),
        );
        return;
      }

      const baseTopInsetPx = !isFullscreen ? PLAYER_TITLEBAR_HEIGHT_PX : 0;
      const topInsetPx =
        shouldReserveOverlayChrome && topChromeRect
          ? Math.max(baseTopInsetPx, topChromeRect.bottom - containerRect.top)
          : baseTopInsetPx;
      const bottomInsetPx =
        shouldReserveOverlayChrome && bottomChromeRect
          ? Math.max(0, containerRect.bottom - bottomChromeRect.top)
          : 0;
      const leftInsetPx = !isFullscreen ? PLAYER_SIDEBAR_WIDTH_PX : 0;
      const rightInsetPx = episodesPanelRect
        ? Math.max(0, containerRect.right - episodesPanelRect.left)
        : 0;

      const nextMargins = buildVideoMarginRatio(containerRect.width, containerRect.height, {
        leftPx: leftInsetPx,
        rightPx: rightInsetPx,
        topPx: topInsetPx,
        bottomPx: bottomInsetPx,
      });

      if (cancelled) return;
      await applyMarginRatio(nextMargins);
    };

    void applyVideoMargins().catch(() => {
      // Margin updates are best-effort and should never break playback.
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeStreamUrl,
    bottomChromeRef,
    episodesPanelFrameRef,
    hasError,
    isFullscreen,
    isLoading,
    isResolving,
    layoutVersion,
    mpvSurfaceReady,
    playerContainerRef,
    refreshToken,
    showDownloadModal,
    showEpisodes,
    showErrorOverlay,
    showStreamSelector,
    topChromeRef,
  ]);
}