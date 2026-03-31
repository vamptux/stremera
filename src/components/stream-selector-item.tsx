import { type TorrentioStream } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Download, ArrowUp } from 'lucide-react';
import { getAddonSourceName, getStreamPresentation } from '@/lib/stream-selector-utils';

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
  const {
    isCached,
    isHttp,
    sourceName,
    streamTitle,
    sourceLabel,
    sourceClassName,
    sourceIcon: SourceIcon,
    sizeLabel,
    techBadges,
  } = getStreamPresentation(stream);

  const addonSourceName = getAddonSourceName(stream);
  const recommendationReasons = stream.recommendation_reasons?.filter(Boolean).slice(0, 2) ?? [];

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
            : isHttp
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
            <span className={cn('text-[9px] font-semibold', sourceClassName)}>
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
                <span className='text-[9px] text-emerald-400/80 font-medium inline-flex items-center gap-[3px]'>
                  <ArrowUp className='w-[8px] h-[8px]' strokeWidth={3} />
                  {stream.seeders}
                </span>
              </>
            )}
          </div>

          {recommendationReasons.length > 0 && (
            <div className='mt-1.5 flex flex-wrap gap-1'>
              {recommendationReasons.map((reason) => (
                <span
                  key={reason}
                  className='rounded-[4px] border border-sky-400/25 bg-sky-400/15 px-1.5 py-[2px] text-[9px] font-semibold leading-none text-sky-100'
                >
                  {reason}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
