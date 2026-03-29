import {
  api,
  type BestResolvedStream,
  type ResolvedStream,
  type TorrentioStream,
} from '@/lib/api';
import {
  buildStreamRankingOptions,
  type StreamRankingTarget,
} from '@/lib/stream-ranking';
import { isHttpStreamUrl } from '@/lib/stream-selector-utils';

type StreamMediaType = 'movie' | 'series' | 'anime';

interface ResolveRankedBestStreamOptions {
  mediaType: StreamMediaType;
  mediaId: string;
  streamLookupId: string;
  streamSeason?: number;
  streamEpisode?: number;
  absoluteEpisode?: number;
  rankingTarget?: StreamRankingTarget;
  bypassCache?: boolean;
}

export async function resolveRankedBestStream({
  mediaType,
  mediaId,
  streamLookupId,
  streamSeason,
  streamEpisode,
  absoluteEpisode,
  rankingTarget,
  bypassCache,
}: ResolveRankedBestStreamOptions): Promise<BestResolvedStream> {
  const rankingOptions = buildStreamRankingOptions(
    rankingTarget ?? {
      mediaId,
      mediaType,
    },
  );

  return api.resolveBestStream(mediaType, streamLookupId, streamSeason, streamEpisode, absoluteEpisode, {
    bypassCache,
    ...rankingOptions,
  });
}

export async function resolveStreamCandidate(
  stream: TorrentioStream,
  options?: {
    season?: number;
    episode?: number;
  },
): Promise<ResolvedStream> {
  const normalizedUrl = stream.url?.trim();
  const url = isHttpStreamUrl(normalizedUrl) ? normalizedUrl : undefined;
  const magnet = normalizedUrl?.startsWith('magnet')
    ? normalizedUrl
    : stream.infoHash
      ? `magnet:?xt=urn:btih:${stream.infoHash}`
      : '';

  if (!magnet && !url) {
    throw new Error('Stream has no URL or InfoHash');
  }

  return api.resolveStream(
    magnet || '',
    stream.infoHash,
    stream.fileIdx,
    options?.season,
    options?.episode,
    url,
  );
}