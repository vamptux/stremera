import type { Episode } from '@/lib/api';

type EpisodeCoordinates = Pick<
  Episode,
  'season' | 'episode' | 'streamLookupId' | 'streamSeason' | 'streamEpisode' | 'aniskipEpisode'
>;

export interface EpisodeStreamTarget {
  streamId: string;
  season: number;
  episode: number;
  absoluteSeason: number;
  absoluteEpisode: number;
  aniskipEpisode: number;
}

export function buildEpisodeStreamTarget(
  fallbackStreamId: string,
  episode: EpisodeCoordinates,
): EpisodeStreamTarget {
  return {
    streamId: episode.streamLookupId || fallbackStreamId,
    season: episode.streamSeason || episode.season,
    episode: episode.streamEpisode || episode.episode,
    absoluteSeason: episode.season,
    absoluteEpisode: episode.episode,
    aniskipEpisode: episode.aniskipEpisode || episode.streamEpisode || episode.episode,
  };
}

export function buildEpisodeStreamTargetLookupKey(
  mediaType: string,
  target: EpisodeStreamTarget,
): string {
  return [
    mediaType,
    target.streamId,
    target.season,
    target.episode,
    target.absoluteEpisode,
  ].join(':');
}

export async function resolveEpisodeStreamTarget(
  mediaType: 'movie' | 'series' | 'anime',
  mediaId: string,
  fallbackStreamId: string,
  episode: EpisodeCoordinates,
): Promise<EpisodeStreamTarget> {
  void mediaType;
  void mediaId;
  return buildEpisodeStreamTarget(fallbackStreamId, episode);
}