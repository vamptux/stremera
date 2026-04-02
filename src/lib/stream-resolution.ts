import {
  api,
  type BestResolvedStream,
  type PreparedPlaybackStream,
  type ResolvedStream,
  type TorrentioStream,
} from '@/lib/api';
import {
  buildStreamRankingOptions,
  type StreamRankingTarget,
} from '@/lib/stream-ranking';
import type { PlaybackStreamOutcome } from '@/lib/playback-stream-health';

type StreamMediaType = 'movie' | 'series' | 'anime';

function isHttpStreamUrl(url?: string | null): boolean {
  const normalized = url?.trim().toLowerCase() ?? '';
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

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

interface RecoverPlaybackStreamOptions {
  mediaType: StreamMediaType;
  mediaId: string;
  streamSeason?: number;
  streamEpisode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  failedStreamUrl?: string;
  failedStreamFormat?: string;
  failedSourceName?: string;
  failedStreamFamily?: string;
  failedStreamKey?: string;
  preparedBackupStream?: PreparedPlaybackStream;
  outcome: Exclude<PlaybackStreamOutcome, 'verified'>;
  rankingTarget?: StreamRankingTarget;
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

export async function recoverPlaybackStream({
  mediaType,
  mediaId,
  streamSeason,
  streamEpisode,
  absoluteSeason,
  absoluteEpisode,
  streamLookupId,
  failedStreamUrl,
  failedStreamFormat,
  failedSourceName,
  failedStreamFamily,
  failedStreamKey,
  preparedBackupStream,
  outcome,
  rankingTarget,
}: RecoverPlaybackStreamOptions): Promise<BestResolvedStream | null> {
  const rankingOptions = buildStreamRankingOptions(
    rankingTarget ?? {
      mediaId,
      mediaType,
    },
  );

  return api.recoverPlaybackStream({
    mediaType,
    mediaId,
    streamSeason,
    streamEpisode,
    absoluteSeason,
    absoluteEpisode,
    streamLookupId,
    failedStreamUrl,
    failedStreamFormat,
    failedSourceName,
    failedStreamFamily,
    failedStreamKey,
    preparedBackupStream,
    outcome,
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