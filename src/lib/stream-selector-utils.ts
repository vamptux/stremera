import type {
  StreamSelectorPreferences,
  StreamSelectorBatch,
  StreamSelectorQuality,
  StreamSelectorSort,
  StreamSelectorSource,
  TorrentioStream,
  TorrentioStreamResolution,
} from '@/lib/api';
import type { LucideIcon } from 'lucide-react';
import { Cpu, FileVideo, HardDrive, Headphones, Monitor, Sun, Volume2, Zap } from 'lucide-react';

export type StreamResolution = TorrentioStreamResolution;
export type QualityFilter = StreamSelectorQuality;
export type SourceFilter = StreamSelectorSource;
export type BatchFilter = StreamSelectorBatch;
export type SortMode = StreamSelectorSort;
export type FilterState = StreamSelectorPreferences;

export const DEFAULT_FILTERS: FilterState = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

export interface TechBadge {
  label: string;
  cls: string;
  Icon?: LucideIcon;
}

export interface StreamPresentation {
  isCached: boolean;
  isHttp: boolean;
  sourceName: string;
  streamTitle: string;
  sourceLabel: string;
  sourceClassName: string;
  sourceIcon: LucideIcon;
  sizeLabel: string | null;
  techBadges: TechBadge[];
}

const RES_RANK: Record<StreamResolution, number> = {
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  sd: 1,
};

export function getAddonSourceName(stream: TorrentioStream): string {
  return stream.source_name?.trim() || 'Unknown';
}

export function getStreamRes(stream: TorrentioStream): StreamResolution {
  return stream.presentation.resolution;
}

export function getStreamPresentation(stream: TorrentioStream): StreamPresentation {
  const deliveryKind = stream.presentation.deliveryKind;
  const isCached = deliveryKind === 'cached';
  const isHttp = deliveryKind === 'http';
  const sourceName = stream.presentation.sourceName.trim() || 'Unknown';
  const streamTitle = stream.presentation.streamTitle.trim() || 'Unknown';
  const resolution = getStreamRes(stream);
  const hdrLabel = stream.presentation.hdrLabel ?? null;
  const audioLabel = stream.presentation.audioLabel ?? null;
  const codecLabel = stream.presentation.codecLabel ?? null;
  const multiAudioLabel = stream.presentation.multiAudioLabel ?? null;

  const techBadges: TechBadge[] = [
    resolution === '4k'
      ? { label: '4K', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/25', Icon: Monitor }
      : resolution === '1080p'
        ? { label: '1080p', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25', Icon: Monitor }
        : resolution === '720p'
          ? { label: '720p', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/20', Icon: Monitor }
          : { label: 'SD', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/30', Icon: Monitor },
  ];

  if (hdrLabel) {
    techBadges.push({
      label: hdrLabel,
      cls: hdrLabel === 'DV'
        ? 'bg-violet-500/15 text-violet-300 border-violet-500/25'
        : 'bg-amber-500/15 text-amber-300 border-amber-500/25',
      Icon: Sun,
    });
  }
  if (multiAudioLabel) {
    techBadges.push({
      label: multiAudioLabel,
      cls:
        multiAudioLabel === 'MULTI'
          ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25'
          : 'bg-pink-500/15 text-pink-300 border-pink-500/25',
      Icon: Headphones,
    });
  }
  if (audioLabel) {
    techBadges.push({
      label: audioLabel,
      cls: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
      Icon: Volume2,
    });
  }
  if (codecLabel) {
    techBadges.push({
      label: codecLabel,
      cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
      Icon: Cpu,
    });
  }
  if (isBatchStream(stream)) {
    techBadges.push({
      label: 'PACK',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
      Icon: FileVideo,
    });
  }

  return {
    isCached,
    isHttp,
    sourceName,
    streamTitle,
    sourceLabel: stream.presentation.deliveryLabel,
    sourceClassName: isCached ? 'text-emerald-400' : isHttp ? 'text-sky-400' : 'text-zinc-500',
    sourceIcon: isCached ? Zap : HardDrive,
    sizeLabel: stream.presentation.sizeLabel ?? null,
    techBadges,
  };
}

export function isBatchStream(stream: TorrentioStream): boolean {
  return stream.presentation.isBatch;
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

  if (sort === 'smart') {
    return result;
  }

  result.sort((a, b) => {
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
