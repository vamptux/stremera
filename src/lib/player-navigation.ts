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

export function resolvePlayerRouteMediaType(
  mediaType: string | null | undefined,
  mediaId: string | null | undefined,
): PlayerRouteMediaType {
  const normalizedType = normalizeRouteText(mediaType)?.toLowerCase();
  const normalizedId = normalizeRouteText(mediaId)?.toLowerCase();

  if (normalizedType === 'anime' || normalizedId?.startsWith('kitsu:')) {
    return 'anime';
  }

  return normalizedType === 'movie' ? 'movie' : 'series';
}

function normalizeRouteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value > 0 ? Math.trunc(value) : undefined;
}

function normalizeRouteText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') {
    return undefined;
  }

  return trimmed;
}

export function sanitizePlayerRouteState(
  state: PlayerRouteState | null | undefined,
): PlayerRouteState {
  if (!state) {
    return {};
  }

  return {
    streamUrl: normalizeRouteText(state.streamUrl),
    title: normalizeRouteText(state.title),
    poster: normalizeRouteText(state.poster),
    backdrop: normalizeRouteText(state.backdrop),
    logo: normalizeRouteText(state.logo),
    format: normalizeRouteText(state.format),
    streamSourceName: normalizeRouteText(state.streamSourceName),
    streamFamily: normalizeRouteText(state.streamFamily),
    preparedBackupStream: state.preparedBackupStream
      ? {
          ...state.preparedBackupStream,
          url: normalizeRouteText(state.preparedBackupStream.url) ?? '',
          format: normalizeRouteText(state.preparedBackupStream.format) ?? '',
          sourceName: normalizeRouteText(state.preparedBackupStream.sourceName),
          streamFamily: normalizeRouteText(state.preparedBackupStream.streamFamily),
        }
      : undefined,
    selectedStreamKey: normalizeRouteText(state.selectedStreamKey),
    startTime:
      typeof state.startTime === 'number' && Number.isFinite(state.startTime) && state.startTime > 0
        ? state.startTime
        : undefined,
    absoluteSeason: normalizeRouteNumber(state.absoluteSeason),
    absoluteEpisode: normalizeRouteNumber(state.absoluteEpisode),
    streamSeason: normalizeRouteNumber(state.streamSeason),
    streamEpisode: normalizeRouteNumber(state.streamEpisode),
    aniskipEpisode: normalizeRouteNumber(state.aniskipEpisode),
    resumeFromHistory: Boolean(state.resumeFromHistory),
    streamLookupId: normalizeRouteText(state.streamLookupId),
    bypassResolveCache: Boolean(state.bypassResolveCache),
    from: normalizeRouteText(state.from),
    isOffline: Boolean(state.isOffline),
    openingStreamName: normalizeRouteText(state.openingStreamName),
    openingStreamSource: normalizeRouteText(state.openingStreamSource),
  };
}

export function buildPlayerRoute(
  mediaType: PlayerRouteMediaType,
  mediaId: string,
  absoluteSeason?: number,
  absoluteEpisode?: number,
): string {
  const normalizedSeason = normalizeRouteNumber(absoluteSeason);
  const normalizedEpisode = normalizeRouteNumber(absoluteEpisode);

  return normalizedSeason !== undefined && normalizedEpisode !== undefined
    ? `/player/${mediaType}/${mediaId}/${normalizedSeason}/${normalizedEpisode}`
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
  const sanitizedState = sanitizePlayerRouteState(state);

  return {
    target: buildPlayerRoute(
      mediaType,
      mediaId,
      sanitizedState.absoluteSeason,
      sanitizedState.absoluteEpisode,
    ),
    state: sanitizedState,
  };
}
