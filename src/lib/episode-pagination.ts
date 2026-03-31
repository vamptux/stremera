import { type Episode, type MediaEpisodesPage } from '@/lib/api';

function buildEpisodeIdentity(episode: Episode): string {
  return `${episode.season}:${episode.episode}:${episode.id}`;
}

export function buildEpisodeApiPageNumbersForDisplayRange(
  displayPageIndex: number,
  displayPageSize: number,
  apiPageSize: number,
): number[] {
  if (displayPageSize <= 0 || apiPageSize <= 0) {
    return [0];
  }

  const startIndex = Math.max(0, displayPageIndex) * displayPageSize;
  const endIndex = startIndex + displayPageSize - 1;
  const firstApiPage = Math.floor(startIndex / apiPageSize);
  const lastApiPage = Math.floor(endIndex / apiPageSize);

  return Array.from(
    { length: lastApiPage - firstApiPage + 1 },
    (_, offset) => firstApiPage + offset,
  );
}

export function mergeEpisodePages(
  pages: readonly MediaEpisodesPage[],
  season?: number | null,
): Episode[] {
  const episodesByKey = new Map<string, Episode>();

  for (const page of pages) {
    for (const episode of page.episodes) {
      if (season !== undefined && season !== null && episode.season !== season) {
        continue;
      }

      episodesByKey.set(buildEpisodeIdentity(episode), episode);
    }
  }

  return Array.from(episodesByKey.values()).sort((left, right) => left.episode - right.episode);
}

export function sliceVisibleEpisodesFromPages(
  pages: readonly MediaEpisodesPage[],
  displayPageIndex: number,
  displayPageSize: number,
  apiPageSize: number,
  season?: number | null,
): Episode[] {
  if (displayPageSize <= 0 || apiPageSize <= 0) {
    return [];
  }

  const pageMap = new Map(pages.map((page) => [page.page, page]));
  const startIndex = Math.max(0, displayPageIndex) * displayPageSize;
  const endIndexExclusive = startIndex + displayPageSize;
  const firstApiPage = Math.floor(startIndex / apiPageSize);
  const lastApiPage = Math.floor((endIndexExclusive - 1) / apiPageSize);
  const visibleEpisodes: Episode[] = [];

  for (let apiPage = firstApiPage; apiPage <= lastApiPage; apiPage += 1) {
    const page = pageMap.get(apiPage);
    if (!page) {
      continue;
    }

    const pageEpisodes =
      season === undefined || season === null
        ? page.episodes
        : page.episodes.filter((episode) => episode.season === season);
    const pageStartIndex = apiPage * apiPageSize;
    const sliceStart = Math.max(0, startIndex - pageStartIndex);
    const sliceEnd = Math.min(pageEpisodes.length, endIndexExclusive - pageStartIndex);

    if (sliceEnd > sliceStart) {
      visibleEpisodes.push(...pageEpisodes.slice(sliceStart, sliceEnd));
    }
  }

  return visibleEpisodes.sort((left, right) => left.episode - right.episode);
}