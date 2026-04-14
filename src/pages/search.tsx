import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Filter,
  History,
  Loader2,
  Search as SearchIcon,
  Sparkles,
  TrendingUp,
  WifiOff,
  X,
} from 'lucide-react';
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import { MediaCard, MediaCardSkeleton } from '@/components/media-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLibraryItems, useWatchStatuses } from '@/hooks/use-media-library';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useSearchPageState } from '@/hooks/use-search-page-state';
import { useSearchResults } from '@/hooks/use-search-results';
import { getErrorMessage, type MediaItem, type WatchStatus } from '@/lib/api';
import { buildSearchHistoryKey } from '@/lib/search-history';
import {
  formatRecentSearchContext,
  SEARCH_CINEMETA_FEEDS,
  SEARCH_KITSU_FEEDS,
  SEARCH_PROVIDERS,
  SEARCH_SORT_OPTIONS,
  SEARCH_YEAR_OPTIONS,
} from '@/lib/search-page-state';
import { cn } from '@/lib/utils';

const SEARCH_RESULT_GRID_CLASS_NAME =
  'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5';
const SEARCH_RESULT_GRID_GAP_PX = 10;
const SEARCH_RESULT_CARD_TEXT_HEIGHT_PX = 56;
const SEARCH_RESULT_CARD_FALLBACK_WIDTH_PX = 160;
const EMPTY_WATCH_STATUSES: Partial<Record<string, WatchStatus>> = {};
const SEARCH_SKELETON_KEYS = [
  'search-skeleton-1',
  'search-skeleton-2',
  'search-skeleton-3',
  'search-skeleton-4',
  'search-skeleton-5',
  'search-skeleton-6',
  'search-skeleton-7',
  'search-skeleton-8',
  'search-skeleton-9',
  'search-skeleton-10',
  'search-skeleton-11',
  'search-skeleton-12',
  'search-skeleton-13',
  'search-skeleton-14',
  'search-skeleton-15',
  'search-skeleton-16',
  'search-skeleton-17',
  'search-skeleton-18',
  'search-skeleton-19',
  'search-skeleton-20',
  'search-skeleton-21',
  'search-skeleton-22',
  'search-skeleton-23',
  'search-skeleton-24',
] as const;

function getSearchGridColumnCount(viewportWidth: number) {
  if (viewportWidth >= 1536) {
    return 8;
  }
  if (viewportWidth >= 1280) {
    return 7;
  }
  if (viewportWidth >= 1024) {
    return 6;
  }
  if (viewportWidth >= 768) {
    return 5;
  }
  if (viewportWidth >= 640) {
    return 4;
  }

  return 3;
}

function useSearchGridMetrics(scrollContainerRef: MutableRefObject<HTMLDivElement | null>) {
  const [metrics, setMetrics] = useState(() => ({
    columnCount: getSearchGridColumnCount(typeof window === 'undefined' ? 1536 : window.innerWidth),
    containerWidth: 0,
  }));

  useEffect(() => {
    const updateMetrics = () => {
      const nextColumnCount = getSearchGridColumnCount(window.innerWidth);
      const nextContainerWidth = scrollContainerRef.current?.clientWidth ?? 0;

      setMetrics((currentMetrics) =>
        currentMetrics.columnCount === nextColumnCount &&
        currentMetrics.containerWidth === nextContainerWidth
          ? currentMetrics
          : {
              columnCount: nextColumnCount,
              containerWidth: nextContainerWidth,
            },
      );
    };

    updateMetrics();

    const scrollContainer = scrollContainerRef.current;
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            updateMetrics();
          });

    if (scrollContainer) {
      resizeObserver?.observe(scrollContainer);
    }

    window.addEventListener('resize', updateMetrics, { passive: true });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateMetrics);
    };
  }, [scrollContainerRef]);

  return metrics;
}

interface SearchResultsGridProps {
  libraryItemIds: ReadonlySet<string>;
  results: MediaItem[];
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
  showSentinel: boolean;
  watchStatuses: Partial<Record<string, WatchStatus>>;
}

function SearchResultsGrid({
  libraryItemIds,
  results,
  scrollContainerRef,
  sentinelRef,
  showSentinel,
  watchStatuses,
}: SearchResultsGridProps) {
  const { columnCount, containerWidth } = useSearchGridMetrics(scrollContainerRef);
  const rowCount = Math.ceil(results.length / columnCount);
  const estimatedCardWidth =
    containerWidth > 0
      ? (containerWidth - SEARCH_RESULT_GRID_GAP_PX * (columnCount - 1)) / columnCount
      : SEARCH_RESULT_CARD_FALLBACK_WIDTH_PX;
  const estimatedRowHeight =
    estimatedCardWidth * 1.5 + SEARCH_RESULT_CARD_TEXT_HEIGHT_PX + SEARCH_RESULT_GRID_GAP_PX;
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 4,
  });

  return (
    <div className='relative w-full' style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const rowStartIndex = virtualRow.index * columnCount;
        const rowItems = results.slice(rowStartIndex, rowStartIndex + columnCount);

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className={SEARCH_RESULT_GRID_CLASS_NAME}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              paddingBottom: `${SEARCH_RESULT_GRID_GAP_PX}px`,
            }}
          >
            {rowItems.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                currentStatusOverride={watchStatuses[item.id] ?? null}
                isInLibraryOverride={libraryItemIds.has(item.id)}
              />
            ))}
          </div>
        );
      })}

      {showSentinel && <div ref={sentinelRef} className='absolute bottom-0 left-0 h-px w-full' />}
    </div>
  );
}

export function Search() {
  const suggestContainerRef = useRef<HTMLDivElement>(null);
  const suggestionInputRef = useRef<HTMLInputElement>(null);
  const isOnline = useOnlineStatus();
  const { data: libraryItems = [] } = useLibraryItems();
  const { data: watchStatuses = EMPTY_WATCH_STATUSES } = useWatchStatuses({
    staleTime: 1000 * 60,
  });
  const {
    activeFeed,
    activeFeedLabel,
    activeGenres,
    activeProvider,
    activeSort,
    activeSortLabel,
    activeType,
    applyRecentSearch,
    clearAllFilters,
    clearRecent,
    debouncedQuery,
    filteredGenreOptions,
    genrePopoverOpen,
    genreSearch,
    handleProviderChange,
    handleSuggestionSelect,
    handleTypeChange,
    hasActiveFilters,
    kitsuBrowseNotice,
    query,
    recentSearches,
    removeRecent,
    restoredScrollTopRef,
    scrollContainerRef,
    setActiveFeed,
    setActiveGenres,
    setActiveSort,
    setGenrePopoverOpen,
    setGenreSearch,
    setQuery,
    setSuggestFocused,
    suggestFocused,
    suggestionDebounce,
    supportsBrowseControls,
    supportsFeed,
    supportsGenreFilters,
    toggleGenre,
    trimmedDebouncedQuery,
    updateYearRange,
    yearFrom,
    yearTo,
  } = useSearchPageState();

  // ── Click-outside: close suggestions when user clicks elsewhere ──────
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (suggestContainerRef.current && !suggestContainerRef.current.contains(e.target as Node)) {
        setSuggestFocused(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [setSuggestFocused]);

  const {
    results,
    suggestions,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isError,
    errorObj,
    sentinelRef,
    supportsInfiniteScroll,
    showEndMsg,
  } = useSearchResults({
    query: debouncedQuery,
    suggestionQuery: suggestionDebounce,
    activeType,
    activeProvider,
    activeFeed,
    activeGenres,
    yearFrom,
    yearTo,
    activeSort,
    isOnline,
    suggestFocused,
    restoredScrollTopRef,
    scrollContainerRef,
  });
  const libraryItemIdSet = useMemo(
    () => new Set(libraryItems.map((item) => item.id)),
    [libraryItems],
  );

  const showSuggestions = suggestFocused && query.trim().length >= 2 && suggestions.length > 0;
  const showSkeleton =
    !isError && (isLoading || (isFetching && !isFetchingNextPage && results.length === 0));

  return (
    <div className='h-screen flex flex-col pt-5 container max-w-[1800px] mx-auto px-4 sm:px-6 md:pl-24 lg:px-8 lg:pl-28'>
      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <div
        ref={suggestContainerRef}
        className='max-w-2xl mx-auto w-full relative mb-4 flex-shrink-0 z-20 flex flex-col gap-3'
      >
        <div className='relative group'>
          <Input
            ref={suggestionInputRef}
            type='text'
            placeholder='Search movies, shows, anime...'
            className='w-full h-11 pl-10 pr-9 text-sm bg-white/[0.04] border-white/[0.08] group-hover:border-white/[0.12] focus:border-white/[0.18] focus:bg-white/[0.06] rounded-xl shadow-none transition-all duration-200 placeholder:text-zinc-600 text-zinc-100'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSuggestFocused(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSuggestFocused(false);
            }}
          />
          <SearchIcon className='absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none' />
          {query && (
            <button
              type='button'
              className='absolute right-2.5 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors'
              onClick={() => setQuery('')}
            >
              <X className='h-3.5 w-3.5' />
            </button>
          )}

          {/* ── Unified focus dropdown: recent searches OR autocomplete ── */}
          {suggestFocused && (
            <>
              {/* Recent searches — shown when input is empty */}
              {!query.trim() && recentSearches.length > 0 && (
                <div className='absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-white/[0.09] rounded-lg shadow-lg z-50 overflow-hidden'>
                  <div className='flex items-center justify-between px-3 pt-2 pb-1.5'>
                    <span className='text-[10px] font-semibold uppercase tracking-widest text-zinc-500 flex items-center gap-1.5'>
                      <History className='h-3 w-3' /> Recent
                    </span>
                    <button
                      type='button'
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={clearRecent}
                      className='text-[10px] text-zinc-500 hover:text-red-400 transition-colors'
                    >
                      Clear
                    </button>
                  </div>
                  {recentSearches.map((entry) => {
                    const contextLabel = formatRecentSearchContext(entry);
                    const itemKey = buildSearchHistoryKey(entry);

                    return (
                      <button
                        key={itemKey}
                        type='button'
                        className='w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.05] transition-colors text-left group'
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyRecentSearch(entry)}
                      >
                        <History className='h-3.5 w-3.5 text-zinc-500 shrink-0' />
                        <div className='min-w-0 flex-1'>
                          <span className='block truncate text-[13px] text-zinc-300 transition-colors group-hover:text-white'>
                            {entry.query}
                          </span>
                          {contextLabel && (
                            <span className='block truncate text-[11px] text-zinc-500'>
                              {contextLabel}
                            </span>
                          )}
                        </div>
                        <X
                          className='h-3 w-3 text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all shrink-0'
                          onClick={(e) => removeRecent(entry, e)}
                        />
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Autocomplete — shown when typing */}
              {showSuggestions && (
                <div className='absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-white/[0.09] rounded-lg shadow-lg z-50 overflow-hidden'>
                  {suggestions.map((item) => (
                    <button
                      key={item.id}
                      type='button'
                      className='w-full flex items-center gap-3 px-3 py-2 hover:bg-white/[0.05] transition-colors text-left group'
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSuggestionSelect(item)}
                    >
                      {item.poster ? (
                        <img
                          src={item.poster}
                          alt=''
                          className='w-7 h-[38px] object-cover rounded-md flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity'
                        />
                      ) : (
                        <div className='w-7 h-[38px] bg-white/5 rounded-md flex-shrink-0' />
                      )}
                      <div className='min-w-0 flex-1'>
                        <p className='text-[13px] font-medium text-zinc-300 group-hover:text-white truncate leading-tight'>
                          {item.title}
                        </p>
                        <p className='text-[11px] text-zinc-500 mt-0.5'>
                          {[
                            item.displayYear,
                            item.type === 'series'
                              ? 'Series'
                              : item.type === 'movie'
                                ? 'Movie'
                                : 'Anime',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </button>
                  ))}
                  <button
                    type='button'
                    className='w-full flex items-center gap-2.5 px-3 py-2 border-t border-white/[0.07] hover:bg-white/[0.05] transition-colors text-left'
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSuggestFocused(false)}
                  >
                    <SearchIcon className='w-3.5 h-3.5 text-zinc-500 flex-shrink-0' />
                    <span className='text-[12px] text-zinc-400'>
                      Show all results for{' '}
                      <span className='text-zinc-300'>&ldquo;{query}&rdquo;</span>
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Compact filter bar — all controls in one non-shifting row ── */}
        <div className='flex flex-wrap items-center gap-2 w-full'>
          {/* Type toggles */}
          <div className='flex gap-0.5 bg-white/[0.03] border border-white/[0.07] rounded-xl p-0.5'>
            {(['movie', 'series', 'anime'] as const).map((t) => (
              <button
                key={t}
                type='button'
                className={cn(
                  'px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-all leading-none',
                  activeType === t
                    ? 'bg-white text-black shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]',
                )}
                onClick={() => handleTypeChange(t)}
              >
                {t === 'movie' ? 'Movies' : t === 'series' ? 'Series' : 'Anime'}
              </button>
            ))}
          </div>

          {/* Feed */}
          {supportsFeed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='ghost'
                  className='h-8 px-3 gap-1.5 text-[12px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/[0.14] rounded-lg font-medium transition-colors'
                >
                  {activeFeed === 'trending' ? (
                    <TrendingUp className='h-3.5 w-3.5 text-orange-400 shrink-0' />
                  ) : (
                    <Sparkles className='h-3.5 w-3.5 text-yellow-400 shrink-0' />
                  )}
                  {activeFeedLabel}
                  <ChevronDown className='h-3.5 w-3.5 opacity-40 ml-0.5' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                className='bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-md min-w-[140px] p-1.5'
              >
                {(activeType === 'anime' ? SEARCH_KITSU_FEEDS : SEARCH_CINEMETA_FEEDS).map(
                  (feed) => (
                    <DropdownMenuItem
                      key={feed.id}
                      onClick={() => setActiveFeed(feed.id)}
                      className={cn(
                        'gap-2.5 rounded-md cursor-pointer text-[13px] py-2',
                        activeFeed === feed.id && 'bg-white/10 font-medium',
                      )}
                    >
                      {activeFeed === feed.id ? (
                        <Check className='h-4 w-4 opacity-60 shrink-0' />
                      ) : (
                        <div className='w-4 shrink-0' />
                      )}
                      {feed.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Genre */}
          {supportsGenreFilters && (
            <Popover
              open={genrePopoverOpen}
              onOpenChange={(open) => {
                setGenrePopoverOpen(open);
                if (!open) setGenreSearch('');
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  className={cn(
                    'h-8 px-3 gap-1.5 text-[12px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/[0.14] rounded-lg font-medium transition-colors',
                    activeGenres.length > 0 && 'text-white border-white/[0.18] bg-white/[0.08]',
                  )}
                >
                  Genre
                  {activeGenres.length > 0 && (
                    <span className='h-4 min-w-[16px] px-0.5 rounded bg-white/20 text-[10px] font-bold flex items-center justify-center ml-0.5'>
                      {activeGenres.length}
                    </span>
                  )}
                  <ChevronDown className='h-3.5 w-3.5 opacity-40 ml-0.5' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                sideOffset={8}
                className='w-[320px] p-0 bg-zinc-950/95 border-white/10 backdrop-blur-xl shadow-2xl rounded-md'
              >
                <div className='p-2.5 border-b border-white/[0.08]'>
                  <div className='relative'>
                    <SearchIcon className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none' />
                    <Input
                      type='text'
                      placeholder='Search genres...'
                      className='h-9 pl-9 pr-3 text-[13px] bg-white/5 border-white/[0.08] focus:border-white/20 rounded-md'
                      value={genreSearch}
                      onChange={(e) => setGenreSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
                <ScrollArea className='max-h-[280px]'>
                  <div className='p-2 flex flex-wrap gap-1.5'>
                    {filteredGenreOptions.map((genre) => {
                      const active = activeGenres.includes(genre);
                      return (
                        <button
                          key={genre}
                          type='button'
                          onClick={() => toggleGenre(genre)}
                          className={cn(
                            'px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-all border inline-flex items-center gap-1.5',
                            active
                              ? 'bg-white/15 text-white border-white/30'
                              : 'bg-white/[0.03] text-zinc-400 border-white/[0.08] hover:border-white/20 hover:text-zinc-200 hover:bg-white/5',
                          )}
                        >
                          {active && <Check className='h-3 w-3 shrink-0' />}
                          {genre}
                        </button>
                      );
                    })}
                    {filteredGenreOptions.length === 0 && (
                      <p className='text-[13px] text-zinc-500 px-3 py-4 w-full text-center'>
                        No matching genres
                      </p>
                    )}
                  </div>
                </ScrollArea>
                {activeGenres.length > 0 && (
                  <div className='p-2.5 border-t border-white/[0.08] flex justify-between items-center bg-white/[0.02]'>
                    <span className='text-[12px] text-zinc-500'>
                      {activeGenres.length} selected
                    </span>
                    <button
                      type='button'
                      onClick={() => setActiveGenres([])}
                      className='text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors'
                    >
                      Clear all
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Source (non-anime only, discover mode) */}
          {supportsBrowseControls && activeType !== 'anime' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='ghost'
                  className={cn(
                    'h-8 px-3 gap-1.5 text-[12px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/[0.14] rounded-lg font-medium transition-colors',
                    activeProvider !== 'cinemeta' &&
                      'text-white border-white/[0.18] bg-white/[0.08]',
                  )}
                >
                  {SEARCH_PROVIDERS.find((provider) => provider.id === activeProvider)?.short ??
                    'All'}
                  <ChevronDown className='h-3.5 w-3.5 opacity-40 ml-0.5' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                className='bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-md min-w-[140px] p-1.5'
              >
                {SEARCH_PROVIDERS.filter((p) => p.types.includes(activeType)).map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => handleProviderChange(p.id)}
                    className={cn(
                      'gap-2.5 rounded-md cursor-pointer text-[13px] py-2',
                      activeProvider === p.id && 'bg-white/10 font-medium',
                    )}
                  >
                    {activeProvider === p.id ? (
                      <Check className='h-4 w-4 opacity-60 shrink-0' />
                    ) : (
                      <div className='w-4 shrink-0' />
                    )}
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Year — compact popover with From/To */}
          {supportsBrowseControls && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant='ghost'
                  className={cn(
                    'h-9 px-3.5 gap-1.5 text-[13px] text-zinc-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.05] border border-white/[0.07] hover:border-white/15 rounded-md font-medium transition-colors',
                    (yearFrom !== null || yearTo !== null) &&
                      'text-white border-white/20 bg-white/[0.08]',
                  )}
                >
                  {yearFrom !== null || yearTo !== null
                    ? `${yearFrom ?? '…'}\u2013${yearTo ?? '…'}`
                    : 'Year'}
                  <ChevronDown className='h-4 w-4 opacity-40 ml-1' />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                sideOffset={8}
                className='w-[220px] p-4 bg-zinc-950/95 border-white/10 backdrop-blur-xl shadow-2xl rounded-md space-y-4'
              >
                <div className='flex flex-col gap-2'>
                  <span className='text-[11px] font-semibold text-zinc-500 uppercase tracking-widest'>
                    From
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant='outline'
                        className='w-full justify-between bg-white/[0.03] border-white/[0.08] hover:border-white/20 h-10 text-[13px] rounded-md'
                      >
                        {yearFrom ?? 'Any'} <ChevronDown className='h-4 w-4 opacity-50' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className='max-h-[240px] overflow-y-auto min-w-[120px] rounded-md bg-zinc-950/95 border-white/10 p-1.5'>
                      <DropdownMenuItem
                        className='py-2 text-[13px] rounded-md'
                        onClick={() => updateYearRange(null, yearTo)}
                      >
                        Any
                      </DropdownMenuItem>
                      {SEARCH_YEAR_OPTIONS.map((y) => (
                        <DropdownMenuItem
                          key={y}
                          onClick={() => updateYearRange(y, yearTo)}
                          className={cn(
                            'py-2 text-[13px] rounded-md',
                            yearFrom === y && 'bg-white/10 font-medium',
                          )}
                        >
                          {y}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className='flex flex-col gap-2'>
                  <span className='text-[11px] font-semibold text-zinc-500 uppercase tracking-widest'>
                    To
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant='outline'
                        className='w-full justify-between bg-white/[0.03] border-white/[0.08] hover:border-white/20 h-10 text-[13px] rounded-md'
                      >
                        {yearTo ?? 'Any'} <ChevronDown className='h-4 w-4 opacity-50' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className='max-h-[240px] overflow-y-auto min-w-[120px] rounded-md bg-zinc-950/95 border-white/10 p-1.5'>
                      <DropdownMenuItem
                        className='py-2 text-[13px] rounded-md'
                        onClick={() => updateYearRange(yearFrom, null)}
                      >
                        Any
                      </DropdownMenuItem>
                      {SEARCH_YEAR_OPTIONS.map((y) => (
                        <DropdownMenuItem
                          key={y}
                          onClick={() => updateYearRange(yearFrom, y)}
                          className={cn(
                            'py-2 text-[13px] rounded-md',
                            yearTo === y && 'bg-white/10 font-medium',
                          )}
                        >
                          {y}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {(yearFrom !== null || yearTo !== null) && (
                  <button
                    type='button'
                    onClick={() => {
                      updateYearRange(null, null);
                    }}
                    className='text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors w-full text-right pt-2 border-t border-white/[0.08]'
                  >
                    Clear
                  </button>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant='ghost'
                className={cn(
                  'h-8 px-3 gap-1.5 text-[12px] text-zinc-400 hover:text-white bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.12] rounded-lg font-medium transition-colors',
                  activeSort !== 'default' && 'text-white border-white/[0.15] bg-white/[0.06]',
                )}
              >
                {activeSortLabel}
                <ChevronDown className='h-3.5 w-3.5 opacity-40 ml-0.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align='end'
              className='bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-md min-w-[160px] p-1.5'
            >
              {SEARCH_SORT_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.id}
                  onClick={() => setActiveSort(opt.id)}
                  className={cn(
                    'gap-2.5 rounded-md cursor-pointer text-[13px] py-2',
                    activeSort === opt.id && 'bg-white/10 font-medium',
                  )}
                >
                  {activeSort === opt.id ? (
                    <Check className='h-4 w-4 opacity-60 shrink-0' />
                  ) : (
                    <div className='w-4 shrink-0' />
                  )}
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Clear all active filters */}
          {hasActiveFilters && (
            <button
              type='button'
              onClick={clearAllFilters}
              className='h-8 px-2.5 rounded-lg text-[11px] font-medium text-zinc-500 hover:text-red-400 flex items-center gap-1 transition-colors ml-auto'
            >
              <X className='h-3 w-3' /> Clear
            </button>
          )}
        </div>

        {/* Active genre chips — no layout shift */}
        {activeGenres.length > 0 && (
          <div className='flex items-center gap-2 flex-wrap mt-1'>
            {activeGenres.map((g) => (
              <Badge
                key={g}
                variant='secondary'
                className='h-6 bg-white/[0.05] text-white/80 border border-white/[0.08] hover:bg-white/[0.08] text-[11px] pl-2.5 pr-1.5 flex items-center gap-1 cursor-default rounded-md transition-colors'
              >
                {g}
                <X
                  className='h-3 w-3 cursor-pointer opacity-50 hover:opacity-100 hover:text-red-400 transition-all'
                  onClick={() => toggleGenre(g)}
                />
              </Badge>
            ))}
            {activeGenres.length > 1 && (
              <button
                type='button'
                onClick={() => setActiveGenres([])}
                className='text-[12px] font-medium text-zinc-400 hover:text-red-400 transition-colors ml-1'
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Scrollable content ──────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        data-media-scroll-container='true'
        className='flex-1 overflow-y-auto scroll-smooth min-h-0 -mr-4 pr-4 -ml-4 pl-4 pb-10 pt-2'
      >
        <div className='w-full'>
          {/* Recent searches are now shown in the focus dropdown above */}

          {/* ── Main results area ─────────────────────────────────────── */}
          {!isOnline ? (
            <div className='flex flex-col items-center justify-center h-64 text-muted-foreground'>
              <WifiOff className='h-10 w-10 mb-4 opacity-40' />
              <p className='font-medium'>You&apos;re offline</p>
              <p className='text-sm opacity-50 mt-1'>
                Connect to the internet to browse and search
              </p>
            </div>
          ) : showSkeleton ? (
            <div className={cn(SEARCH_RESULT_GRID_CLASS_NAME, 'pb-20')}>
              {SEARCH_SKELETON_KEYS.map((key) => (
                <MediaCardSkeleton key={key} />
              ))}
            </div>
          ) : isError ? (
            <div className='flex flex-col items-center justify-center h-64 text-muted-foreground gap-2'>
              <AlertCircle className='h-10 w-10 mb-2 text-red-400/60' />
              <p className='font-medium text-red-400/80'>Failed to load content</p>
              <p className='text-sm opacity-50'>{getErrorMessage(errorObj)}</p>
            </div>
          ) : results.length > 0 ? (
            <>
              {kitsuBrowseNotice && (
                <div className='mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-100/80'>
                  {kitsuBrowseNotice}
                </div>
              )}

              {/* Result count bar */}
              <div className='flex items-center justify-between mb-3 px-1'>
                <span className='flex items-center gap-1.5 flex-wrap text-[12px] text-zinc-400'>
                  {trimmedDebouncedQuery ? (
                    <>
                      {results.length} results for &ldquo;{trimmedDebouncedQuery}&rdquo;
                      {activeType === 'anime' && ' in Anime'}
                    </>
                  ) : (
                    <>
                      {results.length} titles
                      {supportsFeed && (
                        <span className='inline-flex items-center gap-1 text-zinc-400'>
                          <span className='opacity-30 text-xs'>·</span>
                          {activeFeed === 'trending' ? (
                            <TrendingUp className='h-3 w-3' />
                          ) : (
                            <Sparkles className='h-3 w-3' />
                          )}
                          {activeFeedLabel}
                        </span>
                      )}
                    </>
                  )}
                </span>
                {hasActiveFilters && (
                  <button
                    type='button'
                    onClick={clearAllFilters}
                    className='text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 shrink-0'
                  >
                    <Filter className='h-3 w-3' /> Clear all
                  </button>
                )}
              </div>

              <SearchResultsGrid
                libraryItemIds={libraryItemIdSet}
                results={results}
                scrollContainerRef={scrollContainerRef}
                sentinelRef={sentinelRef}
                showSentinel={supportsInfiniteScroll}
                watchStatuses={watchStatuses}
              />

              {isFetchingNextPage && (
                <div className='flex justify-center py-8'>
                  <Loader2 className='h-5 w-5 animate-spin text-white/30' />
                </div>
              )}
              {showEndMsg && (
                <p className='text-center text-xs text-zinc-600 py-6'>All titles loaded</p>
              )}
            </>
          ) : (
            <div className='flex flex-col items-center justify-center h-64 text-muted-foreground gap-1'>
              <Filter className='h-10 w-10 mb-3 opacity-20' />
              <p className='font-medium'>
                {trimmedDebouncedQuery
                  ? `No results for \u201c${trimmedDebouncedQuery}\u201d`
                  : 'No content available'}
              </p>
              <p className='text-sm opacity-50 mt-0.5'>
                {hasActiveFilters && !trimmedDebouncedQuery
                  ? 'Try removing some filters'
                  : trimmedDebouncedQuery
                    ? activeType === 'anime'
                      ? 'Try a different term or check the spelling'
                      : 'Try a different term or switch category'
                    : activeGenres.length > 0
                      ? 'No titles found for the selected genres'
                      : 'Try changing the category or feed'}
              </p>
              {hasActiveFilters && (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={clearAllFilters}
                  className='mt-2 h-8 text-xs text-zinc-500 hover:text-white rounded-md'
                >
                  Clear all filters
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
