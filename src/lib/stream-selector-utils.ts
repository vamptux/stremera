import type { TorrentioStream } from '@/lib/api';

export type StreamResolution = '4k' | '1080p' | '720p' | 'sd';
export type QualityFilter = 'all' | StreamResolution;
export type SourceFilter = 'all' | 'cached';
export type BatchFilter = 'all' | 'episodes' | 'packs';
export type SortMode = 'smart' | 'quality' | 'size' | 'seeds';

export interface FilterState {
  quality: QualityFilter;
  source: SourceFilter;
  addon: string;
  sort: SortMode;
  batch: BatchFilter;
}

export const DEFAULT_FILTERS: FilterState = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

const RES_RANK: Record<StreamResolution, number> = {
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  sd: 1,
};

const BATCH_HINT_REGEX = /\bbatch\b|\bcomplete\s+(?:series|season|pack|collection)\b|\bseason\s*pack\b|\bfull\s+(?:season|series)\b|\bs\d{1,2}\s*[-~]\s*s\d{1,2}\b|\b(?:e|ep)\d{1,4}\s*[-~]\s*(?:e|ep)\d{1,4}\b|\bseason\s*\d+\s*[-~&]\s*(?:season\s*)?\d+\b|\bepisode\s*\d+\s*[-~]\s*(?:episode\s*)?\d+\b/i;

export function isHttpStreamUrl(url?: string | null): boolean {
  const normalized = url?.trim().toLowerCase() ?? '';
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

export function getStreamKey(stream: TorrentioStream): string {
  const normalizedInfoHash = stream.infoHash?.trim().toLowerCase();
  const normalizedUrl = stream.url?.trim();
  return `${normalizedInfoHash ?? normalizedUrl ?? stream.name ?? stream.title ?? 'unknown'}|${stream.fileIdx ?? 'na'}`;
}

export function getAddonSourceName(stream: TorrentioStream): string {
  return stream.source_name?.trim() || 'Unknown';
}

export function isDebridCapable(stream: TorrentioStream): boolean {
  return stream.cached === true || isHttpStreamUrl(stream.url);
}

export function getStreamRes(stream: TorrentioStream): StreamResolution {
  const text = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  if (text.includes('2160p') || text.includes('4k')) return '4k';
  if (text.includes('1080p')) return '1080p';
  if (text.includes('720p')) return '720p';
  return 'sd';
}

export function isBatchStream(stream: TorrentioStream): boolean {
  const haystack = `${stream.name ?? ''}\n${stream.title ?? ''}`;
  return BATCH_HINT_REGEX.test(haystack);
}

export interface StreamStats {
  resCounts: Record<StreamResolution, number>;
  cachedCount: number;
  addonNames: string[];
  batchCount: number;
  episodeLikeCount: number;
}

export function buildStreamStats(streams: TorrentioStream[]): StreamStats {
  const resCounts: Record<StreamResolution, number> = { '4k': 0, '1080p': 0, '720p': 0, sd: 0 };
  let cachedCount = 0;
  let batchCount = 0;
  const addonNames = new Set<string>();

  for (const stream of streams) {
    resCounts[getStreamRes(stream)] += 1;
    if (stream.cached === true) cachedCount += 1;
    if (isBatchStream(stream)) batchCount += 1;
    addonNames.add(getAddonSourceName(stream));
  }

  return {
    resCounts,
    cachedCount,
    addonNames: Array.from(addonNames).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    ),
    batchCount,
    episodeLikeCount: Math.max(0, streams.length - batchCount),
  };
}

export function filterAndSortStreams(
  streams: TorrentioStream[],
  filters: FilterState,
): TorrentioStream[] {
  const { quality, source, addon, sort, batch } = filters;

  let result = [...streams];

  if (quality !== 'all') {
    result = result.filter((stream) => getStreamRes(stream) === quality);
  }

  if (source === 'cached') {
    result = result.filter((stream) => stream.cached === true);
  }

  if (addon !== 'all') {
    result = result.filter((stream) => getAddonSourceName(stream) === addon);
  }

  if (batch === 'episodes') {
    result = result.filter((stream) => !isBatchStream(stream));
  } else if (batch === 'packs') {
    result = result.filter((stream) => isBatchStream(stream));
  }

  result.sort((a, b) => {
    if (sort === 'smart') {
      const aCached = a.cached === true ? 1 : 0;
      const bCached = b.cached === true ? 1 : 0;
      if (aCached !== bCached) return bCached - aCached;

      const aDirect = isHttpStreamUrl(a.url) ? 1 : 0;
      const bDirect = isHttpStreamUrl(b.url) ? 1 : 0;
      if (aDirect !== bDirect) return bDirect - aDirect;

      const resDiff = (RES_RANK[getStreamRes(b)] ?? 0) - (RES_RANK[getStreamRes(a)] ?? 0);
      if (resDiff !== 0) return resDiff;

      return (b.seeders ?? -1) - (a.seeders ?? -1);
    }

    if (sort === 'quality') {
      const resDiff = (RES_RANK[getStreamRes(b)] ?? 0) - (RES_RANK[getStreamRes(a)] ?? 0);
      if (resDiff !== 0) return resDiff;
      return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
    }

    if (sort === 'size') {
      return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
    }

    return (b.seeders ?? -1) - (a.seeders ?? -1);
  });

  return result;
}
