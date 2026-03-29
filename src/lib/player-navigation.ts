import type { PreparedPlaybackStream } from '@/lib/api';

export type PlayerRouteMediaType = 'movie' | 'series' | 'anime';

export interface PlayerRouteState {
  streamUrl?: string;
  title?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  format?: string;
  streamSourceName?: string;
  streamFamily?: string;
  preparedBackupStream?: PreparedPlaybackStream;
  selectedStreamKey?: string;
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  aniskipEpisode?: number;
  resumeFromHistory?: boolean;
  streamLookupId?: string;
  bypassResolveCache?: boolean;
  from?: string;
  isOffline?: boolean;
  openingStreamName?: string;
  openingStreamSource?: string;
}

export function buildPlayerRoute(
  mediaType: PlayerRouteMediaType,
  mediaId: string,
  absoluteSeason?: number,
  absoluteEpisode?: number,
): string {
  return absoluteSeason !== undefined && absoluteEpisode !== undefined
    ? `/player/${mediaType}/${mediaId}/${absoluteSeason}/${absoluteEpisode}`
    : `/player/${mediaType}/${mediaId}`;
}

export function buildPlayerNavigationTarget(
  mediaType: PlayerRouteMediaType,
  mediaId: string,
  state: PlayerRouteState,
): {
  target: string;
  state: PlayerRouteState;
} {
  return {
    target: buildPlayerRoute(mediaType, mediaId, state.absoluteSeason, state.absoluteEpisode),
    state,
  };
}