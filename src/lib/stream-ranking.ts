export interface StreamRankingOptions {
  rankingMediaId?: string;
  rankingMediaType?: string;
  rankingSeason?: number;
  rankingEpisode?: number;
  rankingTitle?: string;
}

export interface StreamRankingTarget {
  mediaId: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  title?: string;
}

export function buildStreamRankingOptions(
  target?: StreamRankingTarget,
): StreamRankingOptions | undefined {
  if (!target?.mediaId?.trim()) return undefined;

  return {
    rankingMediaId: target.mediaId,
    rankingMediaType: target.mediaType?.trim() || undefined,
    rankingSeason: target.season,
    rankingEpisode: target.episode,
    rankingTitle: target.title?.trim() || undefined,
  };
}

export function buildStreamRankingCacheKey(options?: StreamRankingOptions): string {
  return [
    options?.rankingMediaType ?? 'na',
    options?.rankingMediaId ?? 'na',
    options?.rankingSeason ?? 'na',
    options?.rankingEpisode ?? 'na',
    options?.rankingTitle?.trim().toLowerCase() ?? 'na',
  ].join('|');
}

export function buildStreamRankingInvokePayload(
  options?: StreamRankingOptions,
): Record<string, unknown> {
  return {
    ranking_media_id: options?.rankingMediaId,
    ranking_media_type: options?.rankingMediaType,
    ranking_season: options?.rankingSeason,
    ranking_episode: options?.rankingEpisode,
    ranking_title: options?.rankingTitle,
  };
}