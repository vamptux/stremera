import { ArrowUp, Download, FileVideo, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { DownloadModal } from '@/components/download-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useStreamSelectorController } from '@/hooks/use-stream-selector-controller';
import { getErrorMessage, type TorrentioStream } from '@/lib/api';
import {
  type BatchFilter,
  getAddonSourceName,
  getStreamPresentation,
  type QualityFilter,
  type SortMode,
  type SourceFilter,
} from '@/lib/stream-selector-utils';
import { cn } from '@/lib/utils';

interface StreamItemProps {
  disabled: boolean;
  isActive: boolean;
  isResolving: boolean;
  onDownload: () => void;
  onSelect: () => void;
  stream: TorrentioStream;
}

function StreamItem({
  stream,
  onSelect,
  onDownload,
  isActive,
  isResolving,
  disabled,
}: StreamItemProps) {
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
      className={cn(
        'group relative px-3 py-2.5 rounded-lg',
        'bg-white/[0.015] hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06]',
        'transition-all duration-150 cursor-pointer w-full',
        isActive &&
          'border-emerald-500/25 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.10] hover:border-emerald-500/35',
        disabled && 'opacity-70',
        isResolving && 'opacity-50 pointer-events-none',
      )}
    >
      <button
        type='button'
        onClick={onSelect}
        disabled={disabled}
        aria-label={`Select ${sourceName} stream`}
        className='absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-0'
      />

      {isResolving && (
        <div className='absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 overflow-hidden rounded-b-lg'>
          <div className='h-full bg-white/50 animate-progress' />
        </div>
      )}

      <div className='relative z-10 flex items-start gap-2.5 pointer-events-none'>
        <div
          className={cn(
            'mt-0.5 w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
            isCached ? 'text-emerald-400' : isHttp ? 'text-sky-400' : 'text-zinc-500',
          )}
        >
          <SourceIcon className='w-3 h-3' />
        </div>

        <div className='flex-1 min-w-0'>
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
              {techBadges.slice(0, 7).map((badge) => (
                <span
                  key={`${badge.label}:${badge.cls}`}
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
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
                className='pointer-events-auto h-5 w-5 hover:bg-white/10 rounded text-zinc-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-0.5'
                title='Download'
              >
                <Download className='h-2.5 w-2.5' />
              </Button>
            </div>
          </div>

          <p
            className='text-[10px] text-zinc-500 truncate mt-0.5 leading-snug font-medium'
            title={streamTitle}
          >
            {streamTitle}
          </p>

          <div className='flex items-center gap-1.5 mt-1 flex-wrap'>
            {stream.source_name && (
              <>
                <span className='text-[8px] font-bold uppercase tracking-wide px-1 py-[1px] rounded-[3px] border bg-indigo-500/10 border-indigo-500/20 text-indigo-400 leading-none'>
                  {addonSourceName}
                </span>
                <span className='text-zinc-700/60 text-[9px]'>·</span>
              </>
            )}
            <span className={cn('text-[9px] font-semibold', sourceClassName)}>{sourceLabel}</span>
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

interface StreamSelectorProps {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  type: 'movie' | 'series' | 'anime';
  id: string;
  imdbId?: string;
  streamId?: string;
  currentStreamKey?: string;
  currentStreamUrl?: string;
  season?: number;
  episode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  aniskipEpisode?: number;
  startTime?: number;
  title: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  from?: string;
  inlineMode?: boolean;
  onStreamResolved?: (data: {
    url: string;
    format: string;
    is_web_friendly: boolean;
    selectedStreamKey: string;
    sourceName?: string;
    streamFamily?: string;
  }) => void | Promise<void>;
}

export function StreamSelector({
  open,
  onClose,
  onBeforePlayerNavigation,
  type,
  id,
  imdbId,
  streamId,
  currentStreamKey,
  currentStreamUrl,
  season,
  episode,
  absoluteSeason,
  absoluteEpisode,
  aniskipEpisode,
  startTime,
  title,
  overview,
  poster,
  backdrop,
  logo,
  from,
  inlineMode = false,
  onStreamResolved,
}: StreamSelectorProps) {
  const {
    activeResolveFeedback,
    activeResolveKey,
    addonHealthMetrics,
    batchFilter,
    compactOverview,
    defaultFilters,
    downloadData,
    downloadModalOpen,
    effectiveAddonFilter,
    enabledAddons,
    fatalAddonError,
    handleDialogOpenChange,
    handleDownloadStream,
    handleRequestClose,
    handleSelectStream,
    hasActiveFilter,
    healthSummary,
    isAnyResolving,
    isLoading,
    isLoadingAddonConfigs,
    isOnline,
    normalizedCurrentStreamUrl,
    qualityFilter,
    refetchStreams,
    setDownloadModalOpen,
    setFilters,
    showBatchFilter,
    sortMode,
    sortedStreams,
    sourceFilter,
    streamStats,
    streams,
  } = useStreamSelectorController({
    open,
    onClose,
    onBeforePlayerNavigation,
    type,
    id,
    imdbId,
    streamId,
    currentStreamUrl,
    season,
    episode,
    absoluteSeason,
    absoluteEpisode,
    aniskipEpisode,
    startTime,
    title,
    overview,
    poster,
    backdrop,
    logo,
    from,
    inlineMode,
    onStreamResolved,
  });

  if (inlineMode && !open) return null;

  const streamPanel = (
    <div
      className={cn(
        'relative flex flex-col p-0 bg-zinc-950 border-zinc-800/60 gap-0 overflow-hidden shadow-2xl rounded-md',
        inlineMode ? 'w-[430px] h-[70vh] max-h-[560px] border' : 'sm:max-w-4xl h-[82vh]',
      )}
    >
      {/* Header */}
      <div className={cn('relative flex-shrink-0 overflow-hidden', inlineMode ? 'h-40' : 'h-56')}>
        {backdrop ? (
          <div className='absolute inset-0 z-0'>
            <img src={backdrop} className='w-full h-full object-cover opacity-30' alt='' />
            <div className='absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent' />
            <div className='absolute inset-0 bg-gradient-to-r from-zinc-950/80 via-transparent to-transparent' />
          </div>
        ) : (
          <div className='absolute inset-0 bg-zinc-900/60 z-0' />
        )}

        <DialogHeader className='relative z-10 p-6 h-full flex flex-col justify-end text-left'>
          <div className='flex items-end gap-4'>
            {poster && !inlineMode && (
              <img
                src={poster}
                className='w-20 h-[120px] rounded-md shadow-2xl border border-white/10 object-cover hidden sm:block mb-0.5 flex-shrink-0'
                alt=''
              />
            )}
            <div className='flex flex-col gap-2 min-w-0'>
              <DialogTitle
                className={cn(
                  'font-black text-white leading-tight drop-shadow-xl tracking-tight truncate',
                  inlineMode ? 'text-lg' : 'text-2xl',
                )}
              >
                {title}
              </DialogTitle>
              <div className='flex items-center gap-2 flex-wrap min-w-0'>
                {season !== undefined && episode !== undefined && (
                  <>
                    <Badge
                      variant='outline'
                      className='h-5 border-white/15 text-white/80 bg-white/5 px-2 text-[10px] font-semibold'
                    >
                      S{season}
                    </Badge>
                    <Badge
                      variant='outline'
                      className='h-5 border-white/15 text-white/80 bg-white/5 px-2 text-[10px] font-semibold'
                    >
                      E{episode}
                    </Badge>
                  </>
                )}
                {compactOverview && (
                  <p className='text-xs text-zinc-400 leading-relaxed hidden sm:block min-w-0 max-w-full basis-full overflow-hidden text-ellipsis whitespace-nowrap'>
                    {compactOverview}
                  </p>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <button
          type='button'
          onClick={handleRequestClose}
          className='absolute top-3 right-3 z-20 p-1.5 rounded bg-black/30 hover:bg-white/10 text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
          aria-label='Close'
          disabled={isAnyResolving}
        >
          <X className='w-3.5 h-3.5' />
        </button>
      </div>

      {/* Divider */}
      <div className='h-px bg-white/5 flex-shrink-0' />

      {/* Stream list */}
      <div className='flex-1 min-h-0 bg-zinc-950'>
        {isLoading ? (
          <div className='h-full flex flex-col items-center justify-center gap-3 text-muted-foreground'>
            <Loader2 className='w-6 h-6 animate-spin text-white/20' />
            <p className='text-[11px] font-semibold uppercase tracking-widest text-white/30 animate-pulse'>
              {enabledAddons.length > 0
                ? `Searching ${enabledAddons.length} sources…`
                : 'Preparing sources…'}
            </p>
          </div>
        ) : fatalAddonError ? (
          <div className='h-full flex flex-col items-center justify-center gap-3 text-red-400'>
            <p className='text-sm'>Failed to load streams.</p>
            <p className='text-xs text-zinc-500 max-w-sm text-center'>
              {getErrorMessage(fatalAddonError)}
            </p>
            <Button variant='outline' size='sm' onClick={refetchStreams}>
              Retry
            </Button>
          </div>
        ) : !isOnline ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>You&apos;re offline.</p>
            <p className='text-xs text-zinc-500'>Reconnect to load stream sources.</p>
          </div>
        ) : !isLoadingAddonConfigs && enabledAddons.length === 0 ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No enabled stream sources.</p>
            <p className='text-xs text-zinc-500 leading-relaxed max-w-sm'>
              Enable at least one addon in Settings → Streaming, then try again.
            </p>
          </div>
        ) : streamStats.playableCount > 0 ? (
          <ScrollArea className='h-full [&>[data-radix-scroll-area-viewport]]:h-full'>
            <div className={cn('p-3 space-y-1 pb-6', isAnyResolving && 'pointer-events-none')}>
              {/* Addon telemetry */}
              {addonHealthMetrics.length > 0 && (
                <div className='bg-zinc-900/80 border border-white/[0.10] rounded-md px-3 py-2.5 mb-3'>
                  <div className='flex items-center gap-2 flex-wrap'>
                    {addonHealthMetrics.map((metric) => {
                      const isSelected = effectiveAddonFilter === metric.name;
                      const statusDot =
                        metric.status === 'healthy'
                          ? 'bg-emerald-400'
                          : metric.status === 'degraded'
                            ? 'bg-amber-400'
                            : metric.status === 'offline'
                              ? 'bg-red-400'
                              : 'bg-zinc-500 animate-pulse';

                      return (
                        <button
                          key={metric.id}
                          type='button'
                          title={metric.errorMessage || undefined}
                          onClick={() =>
                            setFilters((prev) => ({
                              ...prev,
                              addon: prev.addon === metric.name ? 'all' : metric.name,
                            }))
                          }
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all border',
                            isSelected
                              ? 'bg-indigo-500/20 text-indigo-200 border-indigo-400/30'
                              : 'bg-black/40 text-zinc-300 border-white/10 hover:border-white/20 hover:text-white',
                          )}
                        >
                          <span className={cn('h-1.5 w-1.5 rounded-full', statusDot)} />
                          <span className='truncate max-w-[90px]'>{metric.name}</span>
                          <span className='text-zinc-500'>{metric.streamCount}</span>
                          {typeof metric.latencyMs === 'number' && (
                            <span className='text-zinc-500 tabular-nums'>{metric.latencyMs}ms</span>
                          )}
                        </button>
                      );
                    })}

                    <span className='ml-auto text-[10px] text-zinc-500 font-semibold whitespace-nowrap'>
                      {healthSummary.healthy} healthy • {healthSummary.degraded} degraded •{' '}
                      {healthSummary.offline} offline
                    </span>
                  </div>
                </div>
              )}

              {/* Filter + sort bar */}
              <div className='bg-zinc-900/80 border border-white/[0.10] rounded-md px-3 py-2.5 mb-3'>
                {/* Row 2: Quality + Cached + Sort filters */}
                <div className='flex items-center gap-2 flex-wrap'>
                  {/* Quality filter segment */}
                  <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                    {(
                      [
                        ['all', 'All'],
                        ['4k', '4K'],
                        ['1080p', '1080p'],
                        ['720p', '720p'],
                        ['sd', 'SD'],
                      ] as [QualityFilter, string][]
                    ).map(([val, label]) => {
                      const count =
                        val === 'all' ? streamStats.playableCount : streamStats.resCounts[val];
                      if (val !== 'all' && count === 0) return null;
                      return (
                        <button
                          key={val}
                          type='button'
                          onClick={() => setFilters((f) => ({ ...f, quality: val }))}
                          className={cn(
                            'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                            qualityFilter === val
                              ? 'bg-white/20 text-white shadow-sm'
                              : 'text-zinc-400 hover:text-zinc-200',
                          )}
                        >
                          {label}
                          {val !== 'all' && (
                            <span className='ml-1 opacity-50 font-normal text-[9px]'>{count}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Cached filter — only shown when cached streams exist */}
                  {streamStats.cachedCount > 0 && (
                    <>
                      <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />
                      <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                        {(['all', 'cached'] as SourceFilter[]).map((val) => (
                          <button
                            key={val}
                            type='button'
                            onClick={() => setFilters((f) => ({ ...f, source: val }))}
                            className={cn(
                              'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                              sourceFilter === val
                                ? val === 'cached'
                                  ? 'bg-emerald-500/25 text-emerald-300 shadow-sm'
                                  : 'bg-white/20 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-zinc-200',
                            )}
                          >
                            {val === 'cached' ? `Cached ${streamStats.cachedCount}` : 'All'}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {showBatchFilter &&
                    (streamStats.batchCount > 0 || streamStats.episodeLikeCount > 0) && (
                      <>
                        <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />
                        <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                          {(
                            [
                              ['episodes', 'Episodes', streamStats.episodeLikeCount],
                              ['packs', 'Packs', streamStats.batchCount],
                              ['all', 'All', streamStats.playableCount],
                            ] as [BatchFilter, string, number][]
                          )
                            .filter((entry) => (entry[0] === 'all' ? true : entry[2] > 0))
                            .map(([value, label, count]) => (
                              <button
                                key={value}
                                type='button'
                                onClick={() => setFilters((f) => ({ ...f, batch: value }))}
                                className={cn(
                                  'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                                  batchFilter === value
                                    ? value === 'packs'
                                      ? 'bg-amber-500/25 text-amber-300 shadow-sm'
                                      : value === 'episodes'
                                        ? 'bg-sky-500/25 text-sky-300 shadow-sm'
                                        : 'bg-white/20 text-white shadow-sm'
                                    : 'text-zinc-400 hover:text-zinc-200',
                                )}
                              >
                                {label}
                                {value !== 'all' && (
                                  <span className='ml-1 opacity-60 font-normal text-[9px]'>
                                    {count}
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                      </>
                    )}

                  <div className='w-px h-4 bg-white/[0.12] flex-shrink-0' />

                  {/* Sort mode segment */}
                  <div className='flex items-center gap-px bg-black/50 rounded-lg p-0.5'>
                    <SlidersHorizontal className='w-3 h-3 text-zinc-500 ml-1.5 mr-0.5 flex-shrink-0' />
                    {(
                      [
                        ['smart', 'Smart'],
                        ['quality', 'Quality'],
                        ['size', 'Size'],
                        ['seeds', 'Seeds'],
                      ] as [SortMode, string][]
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type='button'
                        onClick={() => setFilters((f) => ({ ...f, sort: val }))}
                        className={cn(
                          'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all leading-none whitespace-nowrap',
                          sortMode === val
                            ? 'bg-white/20 text-white shadow-sm'
                            : 'text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className='ml-auto flex items-center gap-2 flex-shrink-0'>
                    <span className='text-[10px] font-semibold text-zinc-500 tabular-nums'>
                      {sortedStreams.length === streamStats.playableCount
                        ? `${sortedStreams.length} streams`
                        : `${sortedStreams.length} / ${streamStats.playableCount}`}
                    </span>
                    {hasActiveFilter && (
                      <button
                        type='button'
                        onClick={() => setFilters(defaultFilters)}
                        className='text-[9px] text-zinc-600 hover:text-red-400 transition-colors font-semibold uppercase tracking-wider'
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {sortedStreams.length > 0 ? (
                sortedStreams.map((stream) => {
                  const streamKey = stream.streamKey;
                  const streamUrl = stream.url?.trim();
                  const isUrlMatch =
                    !!normalizedCurrentStreamUrl &&
                    !!streamUrl &&
                    streamUrl === normalizedCurrentStreamUrl;

                  return (
                    <StreamItem
                      key={streamKey}
                      stream={stream}
                      onSelect={() => handleSelectStream(stream)}
                      onDownload={() => handleDownloadStream(stream)}
                      isActive={currentStreamKey === streamKey || isUrlMatch}
                      isResolving={isAnyResolving && activeResolveKey === streamKey}
                      disabled={isAnyResolving}
                    />
                  );
                })
              ) : (
                <div className='flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground'>
                  <FileVideo className='w-8 h-8 opacity-15' />
                  <p className='text-xs text-zinc-500'>No streams match the current filters.</p>
                  <button
                    type='button'
                    onClick={() => setFilters(defaultFilters)}
                    className='text-xs text-zinc-500 hover:text-white transition-colors mt-1 underline underline-offset-2'
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : streams.length > 0 ? (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No instantly playable streams.</p>
            <p className='text-xs text-zinc-500 leading-relaxed max-w-sm'>
              Found {streams.length} candidates, but none include a cached or direct URL yet. Try
              another source/addon, or retry in a moment while debrid finishes caching.
            </p>
          </div>
        ) : (
          <div className='h-full flex flex-col items-center justify-center gap-2 text-muted-foreground'>
            <FileVideo className='w-10 h-10 opacity-15' />
            <p className='text-sm'>No streams found.</p>
          </div>
        )}
      </div>

      {activeResolveFeedback && (
        <div className='pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center'>
          <div className='animate-in fade-in slide-in-from-bottom-2 duration-200 w-full max-w-sm rounded-2xl border border-white/10 bg-black/75 px-3.5 py-2.5 shadow-xl backdrop-blur-xl'>
            <div className='flex items-center gap-2.5'>
              <div className='flex items-center gap-[3px]'>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className='h-1.5 w-1.5 rounded-full bg-white/50 animate-bounce'
                    style={{ animationDelay: `${i * 130}ms`, animationDuration: '0.9s' }}
                  />
                ))}
              </div>

              <div className='min-w-0 flex-1'>
                <p className='mb-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/35'>
                  {activeResolveFeedback.mode === 'download'
                    ? 'Preparing Download'
                    : 'Opening Stream'}
                </p>
                <p className='truncate text-sm font-medium leading-tight text-white/90'>
                  {activeResolveFeedback.title}
                </p>
                {activeResolveFeedback.subtitle && (
                  <p className='truncate text-[11px] leading-snug text-white/40'>
                    {activeResolveFeedback.subtitle}
                  </p>
                )}
              </div>

              <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-white/40' />
            </div>

            <div className='relative mt-2 h-[2px] overflow-hidden rounded-full bg-white/10'>
              <div className='absolute inset-y-0 w-1/3 rounded-full bg-white/45 animate-[progress-slide_1.6s_linear_infinite]' />
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {inlineMode ? (
        streamPanel
      ) : (
        <Dialog open={open} onOpenChange={handleDialogOpenChange}>
          <DialogContent className='sm:max-w-4xl h-[82vh] flex flex-col p-0 bg-transparent border-none shadow-none rounded-md [&>button]:hidden'>
            {streamPanel}
          </DialogContent>
        </Dialog>
      )}

      {downloadData && (
        <DownloadModal
          open={downloadModalOpen}
          onOpenChange={setDownloadModalOpen}
          title={downloadData.title}
          url={downloadData.url}
          fileName={`${downloadData.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`}
          poster={poster}
          mediaType={type}
          mediaId={id}
          season={season}
          episode={episode}
          backdrop={backdrop}
        />
      )}
    </>
  );
}
