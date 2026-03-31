import type { TorrentioStream } from '@/lib/api';
import type { LucideIcon } from 'lucide-react';
import { Cpu, FileVideo, HardDrive, Headphones, Monitor, Sun, Volume2, Zap } from 'lucide-react';

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

const LANGUAGE_TAG_REGEX = /\[([A-Z]{2,3})\]/g;
const EMOJI_META_REGEX = /[\u26A1\u2B07\uD83D\uDCBE\uD83D\uDC64\uD83C\uDF31\s[\]|]/gu;

const BATCH_HINT_REGEX = /\bbatch\b|\bcomplete\s+(?:series|season|pack|collection)\b|\bseason\s*pack\b|\bfull\s+(?:season|series)\b|\bs\d{1,2}\s*[-~]\s*s\d{1,2}\b|\bs\d{1,2}e\d{1,4}\s*[-~]\s*e?\d{1,4}\b|\b\d{1,2}x\d{1,4}\s*[-~]\s*(?:\d{1,2}x)?\d{1,4}\b|\b(?:e|ep)\d{1,4}\s*[-~]\s*(?:e|ep)\d{1,4}\b|\bseason\s*\d+\s*[-~&]\s*(?:season\s*)?\d+\b|\bepisode\s*\d+\s*[-~]\s*(?:episode\s*)?\d+\b/i;

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

function getDisplayLines(stream: TorrentioStream) {
  const rawName = stream.name ?? '';
  const rawTitle = stream.title ?? '';
  const nameFirstLine = rawName.split('\n')[0]?.trim() || '';
  const titleFirstLine = rawTitle.split('\n')[0]?.trim() || '';

  const isMetaOnly = (value: string) =>
    value.length < 6 || value.replace(EMOJI_META_REGEX, '').trim().length === 0;
  const looksLikeFilename = (value: string) =>
    /[\w].*\d{3,4}p/i.test(value) || /S\d{1,2}E\d{1,4}/i.test(value) || value.length > 30;

  if (isMetaOnly(nameFirstLine) && looksLikeFilename(titleFirstLine)) {
    return {
      sourceName: titleFirstLine,
      streamTitle: rawName.split('\n').slice(1).join(' ').trim() || titleFirstLine,
    };
  }

  return {
    sourceName: nameFirstLine || titleFirstLine || 'Unknown',
    streamTitle: titleFirstLine || nameFirstLine || 'Unknown',
  };
}

function getStreamTechFlags(stream: TorrentioStream) {
  const fullText = `${stream.name ?? ''}\n${stream.title ?? ''}`.toLowerCase();
  const rawText = `${stream.name ?? ''} ${stream.title ?? ''}`;
  const langMatches = [...rawText.matchAll(LANGUAGE_TAG_REGEX)].map((match) => match[1]);

  const isDV =
    fullText.includes('dolby vision') || fullText.includes('dovi') || /\bdv\b/.test(fullText);
  const isHDR10p = fullText.includes('hdr10+');
  const isHDR = fullText.includes('hdr');
  const isAtmos = fullText.includes('atmos') || fullText.includes('truehd');
  const isDTSHD =
    fullText.includes('dts-hd') || fullText.includes('dtsx') || fullText.includes('dts-x');
  const isDTS = !isDTSHD && fullText.includes('dts');
  const isEAC3 =
    fullText.includes('eac3') ||
    fullText.includes('dd+') ||
    fullText.includes('ddp') ||
    fullText.includes('dd5.1');
  const isAAC = !isAtmos && !isDTSHD && !isDTS && !isEAC3 && fullText.includes('aac');
  const isHEVC =
    fullText.includes('x265') ||
    fullText.includes('hevc') ||
    fullText.includes('h265') ||
    fullText.includes('h.265');
  const isAV1 = /\bav1\b/.test(fullText);
  const isDualAudio =
    langMatches.length === 2 ||
    /dual[.\-\s]?audio/i.test(rawText) ||
    (/\beng(?:lish)?\b/i.test(rawText) && /\bjap(?:anese)?\b/i.test(rawText)) ||
    (/dubbed/i.test(rawText) && /sub/i.test(rawText));
  const isMultiAudio =
    langMatches.length > 2 ||
    /multi[.\-\s]?audio/i.test(rawText) ||
    /multi[.\-\s]?lang/i.test(rawText) ||
    /multi[.\-\s]?sub/i.test(rawText);

  return {
    resolution: getStreamRes(stream),
    isDV,
    hdrLabel: isDV ? 'DV' : isHDR10p ? 'HDR10+' : isHDR ? 'HDR' : null,
    audioLabel: isAtmos ? 'Atmos' : isDTSHD ? 'DTS-HD' : isDTS ? 'DTS' : isEAC3 ? 'DD+' : isAAC ? 'AAC' : null,
    codecLabel: isAV1 ? 'AV1' : isHEVC ? 'HEVC' : null,
    multiAudioLabel: isMultiAudio ? 'MULTI' : isDualAudio ? 'DUAL' : null,
  };
}

function getSizeLabel(stream: TorrentioStream): string | null {
  const rawText = `${stream.name ?? ''} ${stream.title ?? ''}`;
  const sizeMatch = rawText.match(/([\d.]+)\s*(GB|MB|GiB|MiB)/i);
  if (sizeMatch) {
    return `${sizeMatch[1]}${sizeMatch[2].toUpperCase().replace('GIB', 'GB').replace('MIB', 'MB')}`;
  }

  if (!stream.size_bytes) {
    return null;
  }

  const gb = stream.size_bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(stream.size_bytes / 1048576)}MB`;
}

export function getStreamPresentation(stream: TorrentioStream): StreamPresentation {
  const { sourceName: rawSourceName, streamTitle } = getDisplayLines(stream);
  const sourceName = rawSourceName.replace(/^[\u26A1\u2B07\uD83D\uDCBE\uD83D\uDC64\uD83C\uDF31\s]+/u, '').trim() || 'Unknown';
  const isCached = stream.cached === true;
  const isHttp = isHttpStreamUrl(stream.url);
  const { resolution, isDV, hdrLabel, audioLabel, codecLabel, multiAudioLabel } =
    getStreamTechFlags(stream);

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
      cls: isDV
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
    sourceLabel: isCached ? 'RD+' : isHttp ? 'HTTP' : 'Direct',
    sourceClassName: isCached ? 'text-emerald-400' : isHttp ? 'text-sky-400' : 'text-zinc-500',
    sourceIcon: isCached ? Zap : HardDrive,
    sizeLabel: getSizeLabel(stream),
    techBadges,
  };
}

export function isBatchStream(stream: TorrentioStream): boolean {
  const haystack = `${stream.name ?? ''}\n${stream.title ?? ''}\n${stream.behaviorHints?.filename ?? ''}`;
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
