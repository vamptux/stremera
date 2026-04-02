























import { api, type HistoryPlaybackPlan, type WatchProgress } from '@/lib/api';

export interface DetailsHistoryRouteState {
  from: string;
  season?: number;
  reopenStreamSelector?: boolean;
  reopenStreamSeason?: number;
  reopenStreamEpisode?: number;
  reopenStartTime?: number;
}

interface BuildDetailsReopenSelectorStateArgs {
  from: string;
  season?: number;
  episode?: number;
  startTime?: number;
}

export type HistoryPlaybackFallbackNoticeMode = 'open-details' | 'select-episode';

export function getHistoryPlaybackFallbackNotice(
  reason: HistoryPlaybackPlan['reason'],
  mode: HistoryPlaybackFallbackNoticeMode = 'open-details',
): { title: string; description: string } {
  const normalizedReason = reason ?? 'missing-episode-context';

  if (normalizedReason === 'missing-saved-stream') {
    return mode === 'select-episode'
      ? {
          title: 'Saved stream unavailable',
          description: 'Select the episode below to continue with a fresh stream.',
        }
      : {
          title: 'Saved stream unavailable',
          description: 'Opening details so you can choose a fresh stream to continue.',
        };
  }

  return mode === 'select-episode'
    ? {
        title: 'Episode context missing',
        description: 'Select the episode below to continue watching.',
      }
    : {
        title: 'Episode context missing',
        description: 'Opening details so you can select the episode to continue.',
      };
}

export function getPlayableResumeStartTime(
  item?: Pick<WatchProgress, 'resume_start_time'> | null,
): number | undefined {
  if (!item) return undefined;
  if (typeof item.resume_start_time !== 'number' || !Number.isFinite(item.resume_start_time)) {
    return undefined;
  }

  return item.resume_start_time > 0 ? item.resume_start_time : undefined;
}

export async function getLatestEpisodeResumeStartTime(
  mediaId: string,
  mediaType: string,
  season?: number,
  episode?: number,
): Promise<number | undefined> {
  try {
    const progress = await api.getWatchProgress(mediaId, mediaType, season, episode);
    return getPlayableResumeStartTime(progress);
  } catch {
    return undefined;
  }
}

export function buildDetailsReopenSelectorState({
  from,
  season,
  episode,
  startTime,
}: BuildDetailsReopenSelectorStateArgs): DetailsHistoryRouteState {
  const state: DetailsHistoryRouteState = {
    from,
    reopenStreamSelector: true,
  };

  if (typeof season === 'number' && Number.isFinite(season)) {
    state.season = season;
    state.reopenStreamSeason = season;
  }

  if (
    typeof episode === 'number' &&
    Number.isFinite(episode) &&
    state.reopenStreamSeason !== undefined
  ) {
    state.reopenStreamEpisode = episode;
  }

  if (typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0) {
    state.reopenStartTime = startTime;
  }

  return state;
}

export async function buildHistoryPlaybackPlan(
  item: WatchProgress,
  from: string,
): Promise<HistoryPlaybackPlan> {
  return api.buildHistoryPlaybackPlan(item, from);
}
