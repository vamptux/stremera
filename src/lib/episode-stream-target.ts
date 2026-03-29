import { api, type Episode, type EpisodeStreamMapping } from '@/lib/api';

type EpisodeCoordinates = Pick<Episode, 'season' | 'episode' | 'imdbId' | 'imdbSeason' | 'imdbEpisode'>;

export interface EpisodeStreamTarget {
  streamId: string;
  season: number;
  episode: number;
  absoluteSeason: number;
  absoluteEpisode: number;
  aniskipEpisode: number;
}

function fromMapping(mapping: EpisodeStreamMapping): EpisodeStreamTarget {
  return {
    streamId: mapping.lookupId,
    season: mapping.sourceSeason,
    episode: mapping.sourceEpisode,
    absoluteSeason: mapping.canonicalSeason,
    absoluteEpisode: mapping.canonicalEpisode,
    aniskipEpisode: mapping.aniskipEpisode,
  };
}

export function buildFallbackEpisodeStreamTarget(
  fallbackStreamId: string,
  episode: EpisodeCoordinates,
): EpisodeStreamTarget {
  return {
    streamId: episode.imdbId || fallbackStreamId,
    season: episode.imdbSeason || episode.season,
    episode: episode.imdbEpisode || episode.episode,
    absoluteSeason: episode.season,
    absoluteEpisode: episode.episode,
    aniskipEpisode: episode.imdbEpisode || episode.episode,
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
  if (mediaType !== 'movie') {
    try {
      const mapping = await api.getEpisodeStreamMapping(
        mediaType,
        mediaId,
        episode.season,
        episode.episode,
      );

      if (mapping) {
        return fromMapping(mapping);
      }
    } catch {
      // Use the embedded episode metadata as a bounded fallback.
    }
  }

  return buildFallbackEpisodeStreamTarget(fallbackStreamId, episode);
}