import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import {
  api,
  type HistoryPlaybackPlan,
  type HistoryPlaybackPlanReason,
  type MediaItem,
  type WatchProgress,
} from '@/lib/api';
import { buildHistoryPlaybackPlan, getHistoryPlaybackFallbackNotice } from '@/lib/history-playback';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import {
  buildPlayerNavigationTarget,
  resolvePlayerRouteMediaType,
  type PlayerRouteMediaType,
} from '@/lib/player-navigation';

type PrimaryPlaybackSurface = 'card' | 'details' | 'menu';
type EpisodeSelectionReason = 'no-history' | HistoryPlaybackPlanReason;

interface UseMediaPrimaryPlaybackOptions {
  from: string;
  historyEntry?: WatchProgress | null;
  item?: MediaItem | null;
  onDirectPlay?: (() => void | Promise<void>) | null;
  onHandleHistoryDetailsPlan?: ((plan: HistoryPlaybackPlan) => boolean | Promise<boolean>) | null;
  onPlayMovieWithoutHistory?: (() => void | Promise<void>) | null;
  onSelectEpisode?: ((reason: EpisodeSelectionReason) => void | Promise<void>) | null;
  surface?: PrimaryPlaybackSurface;
}

function getPrimaryPlaybackLabel(
  surface: PrimaryPlaybackSurface,
  isResolving: boolean,
  item?: MediaItem | null,
  hasResumePath?: boolean,
  hasDirectPlay?: boolean,
): string {
  if (isResolving) {
    return 'Resolving…';
  }

  if (!item) {
    return 'Play';
  }

  if (surface === 'details') {
    if (item.type === 'movie') {
      return hasResumePath ? 'Continue' : 'Play';
    }

    return hasResumePath ? 'Continue' : 'Start Watching';
  }

  if (hasResumePath || hasDirectPlay) {
    return 'Resume';
  }

  return item.type === 'movie' ? 'Play' : 'View & Play';
}

function getHistoryPlaybackErrorTitle(
  surface: PrimaryPlaybackSurface,
  item?: MediaItem | null,
): string {
  if (surface !== 'details' || !item) {
    return 'Failed to resume playback';
  }

  return item.type === 'movie' ? 'Failed to continue movie' : 'Failed to continue series';
}

export function useMediaPrimaryPlayback({
  from,
  historyEntry,
  item,
  onDirectPlay,
  onHandleHistoryDetailsPlan,
  onPlayMovieWithoutHistory,
  onSelectEpisode,
  surface = 'menu',
}: UseMediaPrimaryPlaybackOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isResolvingPrimaryAction, setIsResolvingPrimaryAction] = useState(false);
  const isMountedRef = useRef(true);
  const playbackType: PlayerRouteMediaType = useMemo(
    () => resolvePlayerRouteMediaType(item?.type, item?.id),
    [item?.id, item?.type],
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const navigateToDetails = useCallback(() => {
    if (!item) {
      return;
    }

    prefetchDetailsRouteData(queryClient, {
      mediaId: item.id,
      mediaType: item.type,
    });
    navigate(`/details/${playbackType}/${item.id}`, { state: { from } });
  }, [from, item, navigate, playbackType, queryClient]);

  const runActionWithFeedback = useCallback(
    async (action: () => void | Promise<void>, errorTitle: string) => {
      setIsResolvingPrimaryAction(true);

      try {
        await action();
        return true;
      } catch (error) {
        toast.error(errorTitle, {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return false;
      } finally {
        if (isMountedRef.current) {
          setIsResolvingPrimaryAction(false);
        }
      }
    },
    [],
  );

  const handleHistoryPlaybackPlan = useCallback(
    async (plan: HistoryPlaybackPlan) => {
      if (plan.kind === 'player') {
        navigate(plan.target, { state: plan.state });
        return;
      }

      if (onHandleHistoryDetailsPlan) {
        const handled = await onHandleHistoryDetailsPlan(plan);
        if (handled) {
          return;
        }
      }

      const noticeMode = onSelectEpisode ? 'select-episode' : 'open-details';
      const notice = getHistoryPlaybackFallbackNotice(
        plan.reason ?? 'missing-episode-context',
        noticeMode,
      );
      toast.info(notice.title, { description: notice.description });

      if (onSelectEpisode) {
        await onSelectEpisode(plan.reason ?? 'missing-episode-context');
        return;
      }

      navigate(plan.target, { state: plan.state });
    },
    [navigate, onHandleHistoryDetailsPlan, onSelectEpisode],
  );

  const handlePrimaryAction = useCallback(async () => {
    if (!item) {
      return;
    }

    if (onDirectPlay) {
      await runActionWithFeedback(onDirectPlay, 'Failed to resume playback');
      return;
    }

    if (historyEntry) {
      try {
        const plan = await buildHistoryPlaybackPlan(historyEntry, from);
        await handleHistoryPlaybackPlan(plan);
      } catch (error) {
        toast.error(getHistoryPlaybackErrorTitle(surface, item), {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
      return;
    }

    if (item.type !== 'movie') {
      if (onSelectEpisode) {
        await onSelectEpisode('no-history');
        return;
      }

      navigateToDetails();
      return;
    }

    if (onPlayMovieWithoutHistory) {
      await runActionWithFeedback(onPlayMovieWithoutHistory, 'Failed to start playback');
      return;
    }

    setIsResolvingPrimaryAction(true);
    const toastId = toast.loading('Finding best stream…', { description: item.title });

    try {
      const resolved = await api.resolveBestStream(playbackType, item.id);

      toast.dismiss(toastId);

      if (!resolved?.url) {
        toast.error('No streams found', { description: item.title });
        navigateToDetails();
        return;
      }

      const playerNavigation = buildPlayerNavigationTarget(playbackType, item.id, {
        streamUrl: resolved.url,
        title: item.title,
        poster: item.poster,
        backdrop: item.backdrop,
        streamSourceName: resolved.source_name,
        streamFamily: resolved.stream_family,
        format: resolved.format,
        from,
      });

      navigate(playerNavigation.target, { state: playerNavigation.state });
    } catch {
      toast.dismiss(toastId);
      toast.error('Could not resolve stream', {
        description: 'Opening details page instead…',
      });
      navigateToDetails();
    } finally {
      if (isMountedRef.current) {
        setIsResolvingPrimaryAction(false);
      }
    }
  }, [
    from,
    handleHistoryPlaybackPlan,
    historyEntry,
    item,
    navigate,
    navigateToDetails,
    onDirectPlay,
    onPlayMovieWithoutHistory,
    onSelectEpisode,
    playbackType,
    runActionWithFeedback,
    surface,
  ]);

  const primaryActionLabel = useMemo(
    () =>
      getPrimaryPlaybackLabel(
        surface,
        isResolvingPrimaryAction,
        item,
        Boolean(historyEntry),
        Boolean(onDirectPlay),
      ),
    [historyEntry, isResolvingPrimaryAction, item, onDirectPlay, surface],
  );

  return {
    handlePrimaryAction,
    isResolvingPrimaryAction,
    playbackType,
    primaryActionLabel,
  };
}
