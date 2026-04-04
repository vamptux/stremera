import type { QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';

const DETAILS_ROUTE_STALE_TIME_MS = 1000 * 60 * 30;
const DETAILS_EPISODES_STALE_TIME_MS = 1000 * 60 * 5;
const HISTORY_STATE_STALE_TIME_MS = 1000 * 60 * 3;
const DEFAULT_EPISODE_PAGE_SIZE = 50;

interface PrefetchDetailsRouteDataOptions {
  episodePageSize?: number;
  mediaId: string;
  mediaType?: string | null;
  preferredSeason?: number | null;
}

export function prefetchDetailsRouteData(
  queryClient: QueryClient,
  {
    episodePageSize = DEFAULT_EPISODE_PAGE_SIZE,
    mediaId,
    mediaType,
    preferredSeason,
  }: PrefetchDetailsRouteDataOptions,
) {
  const normalizedId = mediaId.trim();
  if (!normalizedId) {
    return;
  }

  const routeType = resolvePlayerRouteMediaType(mediaType, normalizedId);
  const shouldIncludeEpisodes = !(normalizedId.startsWith('kitsu:') && routeType === 'anime');

  void import('@/pages/details');

  void queryClient.prefetchQuery({
    queryKey: ['details', routeType, normalizedId],
    queryFn: () =>
      api.getMediaDetails(routeType, normalizedId, {
        includeEpisodes: shouldIncludeEpisodes,
      }),
    staleTime: DETAILS_ROUTE_STALE_TIME_MS,
  });

  void queryClient.prefetchQuery({
    queryKey: ['watch-history'],
    queryFn: api.getWatchHistory,
    staleTime: HISTORY_STATE_STALE_TIME_MS,
  });

  if (routeType !== 'movie') {
    void queryClient.prefetchQuery({
      queryKey: ['continue-watching'],
      queryFn: api.getContinueWatching,
      staleTime: HISTORY_STATE_STALE_TIME_MS,
    });
  }

  if (
    shouldIncludeEpisodes ||
    typeof preferredSeason !== 'number' ||
    !Number.isFinite(preferredSeason) ||
    preferredSeason <= 0
  ) {
    return;
  }

  void queryClient.prefetchQuery({
    queryKey: ['media-episodes', routeType, normalizedId, preferredSeason, 0, episodePageSize],
    queryFn: () =>
      api.getMediaEpisodes(routeType, normalizedId, preferredSeason, 0, episodePageSize),
    staleTime: DETAILS_EPISODES_STALE_TIME_MS,
  });
}
