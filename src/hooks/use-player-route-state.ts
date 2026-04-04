import { useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import {
  resolvePlayerRouteMediaType,
  sanitizePlayerRouteState,
  type PlayerRouteMediaType,
  type PlayerRouteState,
} from '@/lib/player-navigation';

function parseRouteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function usePlayerRouteState() {
  const location = useLocation();
  const { type, id, season, episode } = useParams();

  return useMemo(() => {
    const state = sanitizePlayerRouteState(location.state as PlayerRouteState | null);
    const routeSeason = parseRouteNumber(season);
    const routeEpisode = parseRouteNumber(episode);
    const routeAbsoluteSeason = parseFiniteNumber(state.absoluteSeason) ?? routeSeason;
    const routeAbsoluteEpisode = parseFiniteNumber(state.absoluteEpisode) ?? routeEpisode;
    const routeStreamSeason = parseFiniteNumber(state.streamSeason);
    const routeStreamEpisode = parseFiniteNumber(state.streamEpisode);
    const effectiveResolveMediaType: PlayerRouteMediaType = resolvePlayerRouteMediaType(type, id);

    return {
      id,
      type,
      seasonParam: season,
      episodeParam: episode,
      routeSeason,
      routeEpisode,
      routeAbsoluteSeason,
      routeAbsoluteEpisode,
      routeStreamSeason,
      routeStreamEpisode,
      routeAniSkipEpisode: parseFiniteNumber(state.aniskipEpisode),
      routeStreamLookupId: state.streamLookupId,
      routeStreamUrl: state.streamUrl,
      routeFormat: state.format,
      routeSourceName: state.streamSourceName,
      routeStreamFamily: state.streamFamily,
      routeSelectedStreamKey: state.selectedStreamKey,
      routeMarkedOffline: state.isOffline === true,
      preparedBackupStream:
        state.preparedBackupStream?.url && state.preparedBackupStream?.format
          ? state.preparedBackupStream
          : undefined,
      openingStreamName: state.openingStreamName,
      openingStreamSource: state.openingStreamSource,
      title: state.title || 'Unknown Title',
      poster: state.poster,
      backdrop: state.backdrop,
      logo: state.logo,
      from: state.from,
      startTime: state.startTime,
      isHistoryResume: state.resumeFromHistory === true,
      shouldBypassResolveCache: state.bypassResolveCache === true,
      effectiveResolveMediaType,
    };
  }, [location.state, type, id, season, episode]);
}
