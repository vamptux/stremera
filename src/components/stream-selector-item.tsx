import { type TorrentioStream } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Cpu,
  Download,
  FileVideo,
  HardDrive,
  Headphones,
  Monitor,
  Sun,
  Volume2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { getAddonSourceName, isBatchStream } from '@/lib/stream-selector-utils';

export function StreamItem({
  stream,
  onSelect,
  onDownload,
  isActive,
  isResolving,
  disabled,
}: {
  stream: TorrentioStream;
  onSelect: () => void;
  onDownload: () => void;
  isActive: boolean;
  isResolving: boolean;
  disabled: boolean;
}) {
  const fullText = `${stream.name ?? ''}\n${stream.title ?? ''}`.toLowerCase();
  const isBatchLike = isBatchStream(stream);

  // Resolution
  const is4k = fullText.includes('2160p') || fullText.includes('4k');
  const is1080p = fullText.includes('1080p');
  const is720p = fullText.includes('720p');
  // HDR / DV
  const isDV = fullText.includes('dolby vision') || fullText.includes('dovi') || /\bdv\b/.test(fullText);
  const isHDR10p = fullText.includes('hdr10+');
  const isHDR = fullText.includes('hdr');
  const hdrLabel = isDV ? 'DV' : isHDR10p ? 'HDR10+' : isHDR ? 'HDR' : null;

  // Audio quality
  const isAtmos = fullText.includes('atmos') || fullText.includes('truehd');
  const isDTSHD = fullText.includes('dts-hd') || fullText.includes('dtsx') || fullText.includes('dts-x');
  const isDTS = !isDTSHD && fullText.includes('dts');
  const isEAC3 =
    fullText.includes('eac3') || fullText.includes('dd+') || fullText.includes('ddp') || fullText.includes('dd5.1');
  const isAAC = !isAtmos && !isDTSHD && !isDTS && !isEAC3 && fullText.includes('aac');
  const audioLabel = isAtmos ? 'Atmos' : isDTSHD ? 'DTS-HD' : isDTS ? 'DTS' : isEAC3 ? 'DD+' : isAAC ? 'AAC' : null;

  // Codec
  const isHEVC =
    fullText.includes('x265') || fullText.includes('hevc') || fullText.includes('h265') || fullText.includes('h.265');
  const isAV1 = /\bav1\b/.test(fullText);
  const codecLabel = isAV1 ? 'AV1' : isHEVC ? 'HEVC' : null;

  // Explicit language codes [ENG], [JPN], [ITA] etc.
  const rawText = `${stream.name ?? ''} ${stream.title ?? ''}`;
  const langMatches = [...rawText.matchAll(/\[([A-Z]{2,3})\]/g)].map((m) => m[1]);

  // Multi-audio detection — useful for anime/foreign content with dub + original
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
  const multiAudioLabel = isMultiAudio ? 'MULTI' : isDualAudio ? 'DUAL' : null;

  // Source / cache status — defined early so badge builder can use it
  const isHTTP = !!stream.url?.startsWith('http');
  const isCached = stream.cached === true;

  // Size
  const sizeMatch = rawText.match(/([\d.]+)\s*(GB|MB|GiB|MiB)/i);
  let sizeLabel: string | null = null;
  if (sizeMatch) {
    sizeLabel = `${sizeMatch[1]}${sizeMatch[2].toUpperCase().replace('GIB', 'GB').replace('MIB', 'MB')}`;
  } else if (stream.size_bytes) {
    const gb = stream.size_bytes / 1073741824;
    sizeLabel =
      gb >= 1
        ? `${gb.toFixed(1)}GB`
        : `${Math.round(stream.size_bytes / 1048576)}MB`;
  }

  // Source label / icon
  const sourceLabel = isCached ? 'RD+' : isHTTP ? 'HTTP' : 'Direct';
  const sourceCls = isCached
    ? 'text-emerald-400'
    : isHTTP
      ? 'text-sky-400'
      : 'text-zinc-500';
  const SourceIcon = isCached ? Zap : HardDrive;

  // --- Derive display strings ---
  // Torrentio format: name = "⚡ [Source]\nRelease.Name.1080p..." , title = "💾 1.2 GB\n👤 42"
  // Comet/StremThru may: put release info in title line 1 and metadata in name, or vice-versa.
  // Strategy: use the first newline-split segment of name as the header, and title first line as subtitle.
  // If name looks like pure metadata (emoji-heavy / very short), swap them.
  const rawName = stream.name ?? '';
  const rawTitle = stream.title ?? '';
  const nameFirstLine = rawName.split('\n')[0]?.trim() || '';
  const titleFirstLine = rawTitle.split('\n')[0]?.trim() || '';

  // Heuristic: if the name first line is mostly emoji/metadata markers and title has a real filename, swap
  const EMOJI_META = /[\u26A1\u2B07\uD83D\uDCBE\uD83D\uDC64\uD83C\uDF31\s[\]|]/gu;
  const isMetaOnly = (s: string) =>
    s.length < 6 || s.replace(EMOJI_META, '').trim().length === 0;
  const looksLikeFilename = (s: string) =>
    /[\w].*\d{3,4}p/i.test(s) || /S\d{1,2}E\d{1,4}/i.test(s) || s.length > 30;

  let sourceName: string;
  let streamTitle: string;
  if (isMetaOnly(nameFirstLine) && looksLikeFilename(titleFirstLine)) {
    // Name is pure metadata, title has the actual release info
    sourceName = titleFirstLine;
    streamTitle = rawName.split('\n').slice(1).join(' ').trim() || titleFirstLine;
  } else {
    sourceName = nameFirstLine || titleFirstLine || 'Unknown';
    streamTitle = titleFirstLine || nameFirstLine || 'Unknown';
  }
  // Strip leading emoji/bracket metadata from the source name for display
  sourceName = sourceName.replace(/^[\u26A1\u2B07\uD83D\uDCBE\uD83D\uDC64\uD83C\uDF31\s]+/u, '').trim() || 'Unknown';

  const addonSourceName = getAddonSourceName(stream);

  // Build right-side tech spec badges — only the most useful info
  type TechBadge = { label: string; cls: string; Icon?: LucideIcon };
  const techBadges: TechBadge[] = [];
  techBadges.push(
    is4k
      ? { label: '4K', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/25', Icon: Monitor }
      : is1080p
        ? { label: '1080p', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25', Icon: Monitor }
        : is720p
          ? { label: '720p', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/20', Icon: Monitor }
          : { label: 'SD', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/30', Icon: Monitor },
  );
  if (hdrLabel) techBadges.push({ label: hdrLabel, cls: isDV ? 'bg-violet-500/15 text-violet-300 border-violet-500/25' : 'bg-amber-500/15 text-amber-300 border-amber-500/25', Icon: Sun });
  if (multiAudioLabel) techBadges.push({ label: multiAudioLabel, cls: multiAudioLabel === 'MULTI' ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25' : 'bg-pink-500/15 text-pink-300 border-pink-500/25', Icon: Headphones });
  if (audioLabel) techBadges.push({ label: audioLabel, cls: 'bg-orange-500/15 text-orange-300 border-orange-500/25', Icon: Volume2 });
  if (codecLabel) techBadges.push({ label: codecLabel, cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25', Icon: Cpu });
  if (isBatchLike) techBadges.push({ label: 'PACK', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25', Icon: FileVideo });

  return (
    <div
      onClick={disabled ? undefined : onSelect}
      className={cn(
        'group relative px-3 py-2.5 rounded-lg',
        'bg-white/[0.015] hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06]',
        'transition-all duration-150 cursor-pointer w-full',
        isActive && 'border-emerald-500/25 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.10] hover:border-emerald-500/35',
        disabled && 'opacity-70',
        isResolving && 'opacity-50 pointer-events-none',
      )}
    >
      {/* Resolving progress bar */}
      {isResolving && (
        <div className='absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 overflow-hidden rounded-b-lg'>
          <div className='h-full bg-white/50 animate-progress' />
        </div>
      )}

      <div className='flex items-start gap-2.5'>
        {/* Source icon */}
        <div className={cn(
          'mt-0.5 w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
          isCached
            ? 'text-emerald-400'
            : isHTTP
              ? 'text-sky-400'
              : 'text-zinc-500',
        )}>
          <SourceIcon className='w-3 h-3' />
        </div>

        <div className='flex-1 min-w-0'>
          {/* Primary row: source name + tech badges + download */}
          <div className='flex items-center gap-1.5'>
            <p className='text-[13px] font-bold text-zinc-100 truncate group-hover:text-white transition-colors leading-tight flex-1 min-w-0'>
              {sourceName}
            </p>
            {isActive && (
              <span className='inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-wide px-1.5 py-[2px] rounded-[3px] border bg-emerald-500/15 border-emerald-500/30 text-emerald-300 leading-none flex-shrink-0'>
                <span className='h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse' />
                Current
              </span>
            )}
            <div className='flex items-center gap-0.5 flex-shrink-0 flex-wrap justify-end'>
              {techBadges.slice(0, 7).map((badge, i) => (
                <span
                  key={i}
                  className={cn(
                    'inline-flex items-center gap-[2px] text-[8px] font-bold uppercase tracking-wide px-1 py-[2px] rounded-[3px] border leading-none',
                    badge.cls,
                  )}
                >
                  {badge.Icon && <badge.Icon className='w-[7px] h-[7px] flex-shrink-0' />}
                  {badge.label}
                </span>
              ))}
              <Button
                variant='ghost'
                size='icon'
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload();
                }}
                className='h-5 w-5 hover:bg-white/10 rounded text-zinc-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-0.5'
                title='Download'
              >
                <Download className='h-2.5 w-2.5' />
              </Button>
            </div>
          </div>

          {/* Subtitle: full filename */}
          <p className='text-[10px] text-zinc-500 truncate mt-0.5 leading-snug font-medium' title={streamTitle}>
            {streamTitle}
          </p>

          {/* Meta row */}
          <div className='flex items-center gap-1.5 mt-1 flex-wrap'>
            {stream.source_name && (
              <>
                <span className='text-[8px] font-bold uppercase tracking-wide px-1 py-[1px] rounded-[3px] border bg-indigo-500/10 border-indigo-500/20 text-indigo-400 leading-none'>
                  {addonSourceName}
                </span>
                <span className='text-zinc-700/60 text-[9px]'>·</span>
              </>
            )}
            <span className={cn('text-[9px] font-semibold', sourceCls)}>
              {sourceLabel}
            </span>
            {sizeLabel && (
              <>
                <span className='text-zinc-700/60 text-[9px]'>·</span>
                <span className='text-[9px] text-zinc-500 font-medium'>{sizeLabel}</span>
              </>
            )}
            {typeof stream.seeders === 'number' && stream.seeders > 0 && (
              <>
                <span className='text-zinc-700/60 text-[9px]'>·</span>
                <span className='text-[9px] text-emerald-400/80 font-medium'>🌱 {stream.seeders}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
