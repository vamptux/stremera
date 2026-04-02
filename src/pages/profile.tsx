import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MediaCard, MediaCardSkeleton } from '@/components/media-card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Library,
  History,
  Play,
  X,
  LayoutList,
  Check,
  Settings2,
  Search,
  ArrowUpAZ,
  ArrowDownAZ,
  CalendarArrowDown,
  CalendarArrowUp,
  LayoutGrid,
  List,
  ChevronDown,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  WatchProgress,
  MediaItem,
  WatchStatus,
  WATCH_STATUS_LABELS,
  WATCH_STATUS_COLORS,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { ListsManager } from '@/components/list/lists-manager';
import { useLocalProfile, LocalProfile } from '@/hooks/use-local-profile';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  buildHistoryPlaybackPlan,
  getHistoryPlaybackFallbackNotice,
} from '@/lib/history-playback';

const ACCENT_PRESETS = [
  { color: '#ffffff', label: 'White' },
  { color: '#6366f1', label: 'Indigo' },
  { color: '#ec4899', label: 'Pink' },
  { color: '#f59e0b', label: 'Amber' },
  { color: '#10b981', label: 'Emerald' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#ef4444', label: 'Red' },
  { color: '#a855f7', label: 'Purple' },
];

function isWatchStatusValue(value: string): value is WatchStatus {
  return (
    value === 'watching' || value === 'watched' || value === 'plan_to_watch' || value === 'dropped'
  );
}

export function Profile() {
  const location = useLocation();
  const {
    profile,
    viewMode,
    updateProfile,
    updateViewMode,
    isSaving: isSavingProfilePreferences,
  } = useLocalProfile();

  const defaultTab = location.pathname === '/library' ? 'library' : 'history';
  const [activeTab, setActiveTab] = useState<string>(defaultTab);

  const { data: library, isLoading: libraryLoading } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['watch-history'],
    queryFn: api.getWatchHistory,
  });

  const { data: continueWatching, isLoading: continueWatchingLoading } = useQuery({
    queryKey: ['continue-watching'],
    queryFn: api.getContinueWatching,
  });

  const { data: lists } = useQuery({
    queryKey: ['lists'],
    queryFn: api.getLists,
    staleTime: 1000 * 30,
  });

  const { data: allWatchStatuses } = useQuery({
    queryKey: ['watch-statuses'],
    queryFn: api.getAllWatchStatuses,
    staleTime: 1000 * 60 * 5,
  });

  const [libraryStatusFilter, setLibraryStatusFilter] = useState<WatchStatus | 'all'>('all');
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [librarySort, setLibrarySort] = useState<
    'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc'
  >('default');
  const [librarySearch, setLibrarySearch] = useState('');

  const handleViewModeChange = useCallback((mode: 'grid' | 'list') => {
    void updateViewMode(mode);
  }, [updateViewMode]);

  const filteredLibrary = useMemo(() => {
    let items = !library
      ? []
      : libraryStatusFilter === 'all'
        ? library
        : library.filter((item) => allWatchStatuses?.[item.id] === libraryStatusFilter);
    if (libraryTypeFilter !== 'all') {
      items = items.filter((item) => item.type === libraryTypeFilter);
    }
    if (librarySearch.trim()) {
      const q = librarySearch.trim().toLowerCase();
      items = items.filter((item) => item.title.toLowerCase().includes(q));
    }
    switch (librarySort) {
      case 'title-asc':
        items = [...items].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'title-desc':
        items = [...items].sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'year-desc':
        items = [...items].sort((a, b) => (b.year ?? '').localeCompare(a.year ?? ''));
        break;
      case 'year-asc':
        items = [...items].sort((a, b) => (a.year ?? '').localeCompare(b.year ?? ''));
        break;
    }
    return items;
  }, [
    library,
    libraryStatusFilter,
    libraryTypeFilter,
    librarySearch,
    librarySort,
    allWatchStatuses,
  ]);

  const statusCounts = useMemo(() => {
    if (!library || !allWatchStatuses) return {} as Record<WatchStatus, number>;
    const counts: Partial<Record<WatchStatus, number>> = {};
    for (const item of library) {
      const s = allWatchStatuses[item.id] as WatchStatus | undefined;
      if (s) counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts as Record<WatchStatus, number>;
  }, [library, allWatchStatuses]);

  const totalWatched = history?.length ?? 0;
  const libraryCount = library?.length ?? 0;
  const listsCount = lists?.length ?? 0;

  const [historySearch, setHistorySearch] = useState('');
  const filteredHistory = useMemo(() => {
    if (!history) return [];
    if (!historySearch.trim()) return history;
    const q = historySearch.trim().toLowerCase();
    return history.filter((item) => item.title.toLowerCase().includes(q));
  }, [history, historySearch]);

  const continueWatchingItems = useMemo(() => continueWatching ?? [], [continueWatching]);

  const initial = profile.username.charAt(0).toUpperCase();
  const accentColor = profile.accentColor;

  return (
    <div className='relative min-h-screen'>
      {/* Ambient background */}
      <div className='fixed inset-0 pointer-events-none z-0 overflow-hidden'>
        <div
          className='absolute top-[-15%] left-[-10%] w-[60%] h-[50%] blur-[120px] rounded-full opacity-20 transition-colors duration-700'
          style={{ background: `radial-gradient(ellipse, ${accentColor}18, transparent 70%)` }}
        />
      </div>

        <div className='container max-w-7xl mx-auto pt-20 pb-12 px-4 sm:px-6 md:pl-24 lg:px-8 lg:pl-28 space-y-8 relative z-10'>
        {/* Header */}
        <div className='animate-in fade-in slide-in-from-bottom-2 duration-300'>
          {/* Glass header card */}
          <div className='relative rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm overflow-hidden px-6 py-6'>
            {/* Subtle top accent line */}
            <div
              className='absolute inset-x-0 top-0 h-px pointer-events-none transition-colors duration-700'
              style={{
                background: `linear-gradient(to right, transparent, ${accentColor}40, transparent)`,
              }}
            />

            <div className='flex flex-col sm:flex-row gap-6 items-start sm:items-center justify-between'>
              {/* Avatar + Identity */}
              <div className='flex items-center gap-5'>
                <div className='relative flex-shrink-0'>
                  <Avatar className='h-20 w-20 rounded-full border border-white/[0.08] ring-1 ring-white/[0.06] shadow-xl relative'>
                    <AvatarFallback
                      className='text-2xl font-black transition-colors duration-300'
                      style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
                    >
                      {initial}
                    </AvatarFallback>
                  </Avatar>
                </div>

                <div className='space-y-1 min-w-0'>
                  <div className='flex items-center gap-3 flex-wrap'>
                    <h1 className='text-3xl font-black tracking-tight text-white truncate'>
                      {profile.username}
                    </h1>
                    <ProfileSettingsPopover
                      profile={profile}
                      onUpdate={updateProfile}
                      isSaving={isSavingProfilePreferences}
                    />
                  </div>
                {profile.bio && (
                  <p className='text-sm text-zinc-500 max-w-[32ch] leading-relaxed'>
                    {profile.bio}
                  </p>
                )}
                {!profile.bio && (
                  <p className='text-xs text-zinc-700 italic'>No tagline set</p>
                )}
                </div>
              </div>

              {/* Stats — right side */}
              <div className='flex items-center gap-1 flex-wrap rounded-xl bg-black/30 border border-white/[0.05] px-3 py-2 flex-shrink-0'>
                <StatChip value={libraryCount} label='Library' accentColor={accentColor} />
                <StatDivider />
                <StatChip value={listsCount} label='Lists' />
                <StatDivider />
                <StatChip value={totalWatched} label='Watched' />
                {(['watching', 'watched', 'plan_to_watch', 'dropped'] as WatchStatus[]).map((s) => {
                  const count = statusCounts[s] ?? 0;
                  if (count === 0) return null;
                  const colors = WATCH_STATUS_COLORS[s];
                  return (
                    <span key={s} className='flex items-center gap-1'>
                      <StatDivider />
                      <StatusChip count={count} colors={colors} label={WATCH_STATUS_LABELS[s]} />
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-6'>
          <div className='flex items-center gap-3 flex-wrap'>
            <TabsList className='bg-white/[0.03] border border-white/[0.06] p-1 rounded-xl h-auto inline-flex gap-0.5'>
              {['library', 'lists', 'history', 'continue-watching'].map((tab) => {
                const icons: Record<string, React.ReactNode> = {
                  library: <Library className='w-3 h-3' />,
                  lists: <LayoutList className='w-3 h-3' />,
                  history: <History className='w-3 h-3' />,
                  'continue-watching': <Play className='w-3 h-3' />,
                };
                const labels: Record<string, string> = {
                  library: 'Library',
                  lists: 'Lists',
                  history: 'History',
                  'continue-watching': 'Continue Watching',
                };

                return (
                  <TabsTrigger
                    key={tab}
                    value={tab}
                    className='px-3.5 py-1.5 rounded-lg text-xs font-semibold data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm text-zinc-500 transition-all data-[state=active]:shadow-none flex items-center gap-1.5 hover:text-zinc-300'
                  >
                    {icons[tab]}
                    <span>{labels[tab]}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {activeTab === 'library' && (
              <div className='flex items-center gap-2 flex-1 min-w-0 flex-wrap'>
                {/* Type filter */}
                <div className='flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.03] border border-white/[0.06] flex-shrink-0'>
                  {(['all', 'movie', 'series'] as const).map((t) => (
                    <button
                      key={t}
                      type='button'
                      onClick={() => setLibraryTypeFilter(t)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-150',
                        libraryTypeFilter === t
                          ? 'bg-white/15 text-white'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]',
                      )}
                    >
                      {t === 'all' ? 'All' : t === 'movie' ? 'Movies' : 'Shows'}
                    </button>
                  ))}
                </div>

                <div className='w-px h-4 bg-white/[0.08] flex-shrink-0' />

                {/* Status filter pills */}
                <div className='flex items-center gap-1 flex-wrap flex-1'>
                  <FilterPill
                    active={libraryStatusFilter === 'all'}
                    onClick={() => setLibraryStatusFilter('all')}
                  >
                    All
                    <span className='ml-1 opacity-40 text-[10px]'>{libraryCount}</span>
                  </FilterPill>
                  {(['watching', 'watched', 'plan_to_watch', 'dropped'] as WatchStatus[]).map(
                    (s) => {
                      const count = statusCounts[s] ?? 0;
                      const colors = WATCH_STATUS_COLORS[s];
                      const isActive = libraryStatusFilter === s;
                      return (
                        <FilterPill
                          key={s}
                          active={isActive}
                          activeClassName={cn(colors.bg, colors.border, colors.text)}
                          onClick={() => setLibraryStatusFilter(s)}
                        >
                          {WATCH_STATUS_LABELS[s]}
                          {count > 0 && (
                            <span className='ml-1 opacity-50 text-[10px]'>{count}</span>
                          )}
                        </FilterPill>
                      );
                    },
                  )}
                </div>

                {/* Sort dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant='outline'
                      size='sm'
                      className='h-7 px-3 gap-1.5 text-[11px] font-semibold rounded-lg bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.07] text-zinc-400 hover:text-white flex-shrink-0 inline-flex items-center'
                    >
                      {librarySort === 'default' && 'Default'}
                      {librarySort === 'title-asc' && (
                        <>
                          <ArrowUpAZ className='w-3 h-3' />
                          <span>A–Z</span>
                        </>
                      )}
                      {librarySort === 'title-desc' && (
                        <>
                          <ArrowDownAZ className='w-3 h-3' />
                          <span>Z–A</span>
                        </>
                      )}
                      {librarySort === 'year-desc' && (
                        <>
                          <CalendarArrowDown className='w-3 h-3' />
                          <span>Newest</span>
                        </>
                      )}
                      {librarySort === 'year-asc' && (
                        <>
                          <CalendarArrowUp className='w-3 h-3' />
                          <span>Oldest</span>
                        </>
                      )}
                      <ChevronDown className='w-3 h-3 opacity-50' />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align='end'
                    className='w-36 bg-zinc-950/98 border-white/10 backdrop-blur-xl rounded-xl p-1'
                  >
                    {(
                      [
                        { key: 'default', label: 'Default', icon: null },
                        {
                          key: 'title-asc',
                          label: 'A → Z',
                          icon: <ArrowUpAZ className='w-3.5 h-3.5' />,
                        },
                        {
                          key: 'title-desc',
                          label: 'Z → A',
                          icon: <ArrowDownAZ className='w-3.5 h-3.5' />,
                        },
                        {
                          key: 'year-desc',
                          label: 'Newest',
                          icon: <CalendarArrowDown className='w-3.5 h-3.5' />,
                        },
                        {
                          key: 'year-asc',
                          label: 'Oldest',
                          icon: <CalendarArrowUp className='w-3.5 h-3.5' />,
                        },
                      ] as const
                    ).map(({ key, label, icon }) => (
                      <DropdownMenuItem
                        key={key}
                        onClick={() => setLibrarySort(key)}
                        className='gap-2 text-[12px] rounded-lg cursor-pointer py-1.5'
                      >
                        {librarySort === key ? (
                          <Check className='w-3.5 h-3.5 opacity-70 flex-shrink-0' />
                        ) : (
                          <div className='w-3.5 flex-shrink-0' />
                        )}
                        {icon}
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          {/* Library */}
          <TabsContent
            value='library'
            className='space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-200'
          >
            {libraryLoading ? (
              <MediaGrid>
                {Array.from({ length: 12 }).map((_, i) => (
                  <MediaCardSkeleton key={i} />
                ))}
              </MediaGrid>
            ) : filteredLibrary.length > 0 ? (
              viewMode === 'grid' ? (
                <MediaGrid>
                  {filteredLibrary.map((item) => (
                    <MediaCard key={item.id} item={item} />
                  ))}
                </MediaGrid>
              ) : (
                <LibraryList items={filteredLibrary} watchStatuses={allWatchStatuses} />
              )
            ) : library && library.length > 0 ? (
              <EmptyState
                icon={<Library className='w-6 h-6 text-zinc-600' />}
                title={librarySearch.trim() ? 'No matching items' : 'No items with this filter'}
                action={
                  <button
                    type='button'
                    className='text-xs text-zinc-500 hover:text-zinc-300 transition-colors'
                    onClick={() => {
                      setLibraryStatusFilter('all');
                      setLibraryTypeFilter('all');
                      setLibrarySearch('');
                    }}
                  >
                    Clear filters →
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon={<Library className='w-6 h-6 text-zinc-600' />}
                title='Your library is empty'
                subtitle='Add movies and shows to track them here.'
              />
            )}
          </TabsContent>

          {/* Lists */}
          <TabsContent
            value='lists'
            className='animate-in fade-in slide-in-from-bottom-1 duration-200'
          >
            <ListsManager />
          </TabsContent>

          {/* History */}
          <TabsContent
            value='history'
            className='space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-200'
          >
            {history && history.length > 0 && (
              <div className='flex items-center gap-2'>
                <div className='relative flex-1'>
                  <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600 pointer-events-none' />
                  <Input
                    placeholder='Search history…'
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    className='pl-8 pr-8 h-9 text-sm bg-white/[0.03] border-white/[0.07] text-white placeholder:text-zinc-600 focus-visible:ring-white/10 rounded-xl'
                  />
                  {historySearch && (
                    <button
                      type='button'
                      onClick={() => setHistorySearch('')}
                      className='absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-white transition-colors'
                    >
                      <X className='w-3.5 h-3.5' />
                    </button>
                  )}
                </div>
                <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
              </div>
            )}
            {historyLoading ? (
              <MediaGrid>
                {Array.from({ length: 12 }).map((_, i) => (
                  <MediaCardSkeleton key={i} />
                ))}
              </MediaGrid>
            ) : filteredHistory.length > 0 ? (
              viewMode === 'grid' ? (
                <MediaGrid>
                  {filteredHistory.map((item) => (
                    <HistoryItem key={`${item.id}-${item.season}-${item.episode}`} item={item} />
                  ))}
                </MediaGrid>
              ) : (
                <HistoryListView items={filteredHistory} />
              )
            ) : historySearch ? (
              <EmptyState
                icon={<Search className='w-6 h-6 text-zinc-600' />}
                title='No results'
                subtitle={`Nothing in your history matches "${historySearch}".`}
                action={
                  <button
                    type='button'
                    className='text-xs text-zinc-500 hover:text-zinc-300 transition-colors'
                    onClick={() => setHistorySearch('')}
                  >
                    Clear search →
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon={<History className='w-6 h-6 text-zinc-600' />}
                title='No watch history yet'
                subtitle='Start watching to see it here.'
              />
            )}
          </TabsContent>

          {/* Continue Watching */}
          <TabsContent
            value='continue-watching'
            className='space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-200'
          >
            {continueWatchingItems.length > 0 && !continueWatchingLoading && (
              <div className='flex items-center justify-end'>
                <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
              </div>
            )}
            {continueWatchingLoading ? (
              <MediaGrid>
                {Array.from({ length: 6 }).map((_, i) => (
                  <MediaCardSkeleton key={i} />
                ))}
              </MediaGrid>
            ) : continueWatchingItems.length > 0 ? (
              viewMode === 'grid' ? (
                <MediaGrid>
                  {continueWatchingItems.map((item) => (
                    <HistoryItem
                      key={`${item.id}-${item.season}-${item.episode}`}
                      item={item}
                      showLibraryContext
                    />
                  ))}
                </MediaGrid>
              ) : (
                <HistoryListView items={continueWatchingItems} />
              )
            ) : (
              <EmptyState
                icon={<Play className='w-6 h-6 text-zinc-600 ml-0.5' />}
                title='Nothing to continue'
                subtitle='You have no unfinished items.'
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// Shared layout helpers

function MediaGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'>
      {children}
    </div>
  );
}

// ─── View Toggle ─────────────────────────────────────────────────────────────

function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: 'grid' | 'list';
  onChange: (v: 'grid' | 'list') => void;
}) {
  return (
    <div className='flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.07] flex-shrink-0'>
      <button
        type='button'
        title='Grid view'
        onClick={() => onChange('grid')}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          viewMode === 'grid' ? 'bg-white/20 text-white' : 'text-zinc-600 hover:text-zinc-300',
        )}
      >
        <LayoutGrid className='w-3.5 h-3.5' />
      </button>
      <button
        type='button'
        title='List view'
        onClick={() => onChange('list')}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          viewMode === 'list' ? 'bg-white/20 text-white' : 'text-zinc-600 hover:text-zinc-300',
        )}
      >
        <List className='w-3.5 h-3.5' />
      </button>
    </div>
  );
}

// ─── Library List View ───────────────────────────────────────────────────────

function LibraryList({
  items,
  watchStatuses,
}: {
  items: MediaItem[];
  watchStatuses?: Record<string, string>;
}) {
  return (
    <div className='space-y-1.5'>
      {items.map((item) => (
        <LibraryListRow key={item.id} item={item} status={watchStatuses?.[item.id]} />
      ))}
    </div>
  );
}

function LibraryListRow({ item, status }: { item: MediaItem; status?: string }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <button
      type='button'
      className='w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.10] transition-colors text-left group'
      onClick={() =>
        navigate(`/details/${item.type}/${item.id}`, {
          state: { from: `${location.pathname}${location.search}` },
        })
      }
    >
      {/* Poster */}
      <div className='w-8 h-12 flex-shrink-0 rounded-md overflow-hidden bg-zinc-900/80 ring-1 ring-white/[0.06]'>
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.title}
            className='w-full h-full object-cover'
            loading='lazy'
            decoding='async'
          />
        ) : (
          <div className='w-full h-full flex items-center justify-center text-white/10 text-[8px] font-bold'>
            N/A
          </div>
        )}
      </div>

      {/* Info */}
      <div className='flex-1 min-w-0'>
        <p className='text-sm font-semibold text-zinc-100 truncate group-hover:text-white transition-colors'>
          {item.title}
        </p>
        <div className='flex items-center gap-1.5 mt-0.5 flex-wrap'>
          {item.displayYear && (
            <span className='text-[10px] text-zinc-600'>
              {item.displayYear}
            </span>
          )}
          <span
            className={cn(
              'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm',
              item.type === 'movie'
                ? 'text-sky-400 bg-sky-500/10'
                : 'text-violet-400 bg-violet-500/10',
            )}
          >
            {item.type === 'movie' ? 'Movie' : 'Show'}
          </span>
          {status && isWatchStatusValue(status) && (
            <span
              className={cn(
                'text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-sm',
                WATCH_STATUS_COLORS[status].text,
                WATCH_STATUS_COLORS[status].bg,
              )}
            >
              {WATCH_STATUS_LABELS[status]}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── History List View ───────────────────────────────────────────────────────

function HistoryListView({ items }: { items: WatchProgress[] }) {
  return (
    <div className='space-y-1.5'>
      {items.map((item) => (
        <HistoryListRow key={`${item.id}-${item.season ?? ''}-${item.episode ?? ''}`} item={item} />
      ))}
    </div>
  );
}

function HistoryListRow({ item }: { item: WatchProgress }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const from = `${location.pathname}${location.search}`;
  const progressPct = item.duration > 0 ? Math.min(100, (item.position / item.duration) * 100) : 0;

  const removeItem = useMutation({
    mutationFn: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await api.removeFromWatchHistory(item.id, item.type_, item.season, item.episode);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      toast.success('Removed from history');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove item');
    },
  });

  const handlePlay = async (e: React.MouseEvent) => {
    e.preventDefault();

    try {
      const plan = await buildHistoryPlaybackPlan(item, from);
      if (plan.kind === 'details') {
        const notice = getHistoryPlaybackFallbackNotice(plan.reason, 'open-details');
        toast.info(notice.title, { description: notice.description });
        navigate(plan.target, { state: plan.state });
        return;
      }

      navigate(plan.target, { state: plan.state });
    } catch (err) {
      toast.error('Failed to open watch history item', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  return (
    <div className='group/hrow flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.10] transition-colors'>
      {/* Poster with progress overlay */}
      <div className='relative w-8 h-12 flex-shrink-0 rounded-md overflow-hidden bg-zinc-900/80 ring-1 ring-white/[0.06]'>
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.title}
            className='w-full h-full object-cover'
            loading='lazy'
            decoding='async'
          />
        ) : (
          <div className='w-full h-full flex items-center justify-center text-white/10 text-[8px] font-bold'>
            N/A
          </div>
        )}
        {progressPct > 0 && (
          <div className='absolute bottom-0 inset-x-0 h-0.5 bg-black/50'>
            <div className='h-full bg-white/80' style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>

      {/* Info */}
      <div className='flex-1 min-w-0'>
        <p className='text-sm font-semibold text-zinc-100 truncate'>{item.title}</p>
        <div className='flex items-center gap-2 mt-0.5'>
          {item.season !== undefined && item.episode !== undefined && (
            <span className='text-[10px] text-zinc-500 font-medium'>
              S{item.season} · E{item.episode}
            </span>
          )}
          {progressPct > 0 && (
            <span className='text-[10px] text-zinc-700 tabular-nums'>
              {Math.round(progressPct)}%
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className='flex items-center gap-0.5 flex-shrink-0'>
        <Button
          size='icon'
          variant='ghost'
          className='h-7 w-7 rounded-lg text-zinc-600 hover:text-white hover:bg-white/[0.08] transition-colors'
          onClick={handlePlay}
          title='Play'
        >
          <Play className='w-3 h-3 fill-current' />
        </Button>
        <Button
          size='icon'
          variant='ghost'
          className='h-7 w-7 rounded-lg text-zinc-700 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover/hrow:opacity-100'
          onClick={(e) => removeItem.mutate(e)}
          title='Remove from history'
          disabled={removeItem.isPending}
        >
          <X className='w-3 h-3' />
        </Button>
      </div>
    </div>
  );
}

function StatChip({
  value,
  label,
  accentColor,
}: {
  value: number;
  label: string;
  accentColor?: string;
}) {
  return (
    <div className='flex flex-col items-center px-3 py-2 min-w-[52px]'>
      <span
        className='text-2xl font-black tracking-tight leading-none'
        style={accentColor ? { color: accentColor } : { color: '#fff' }}
      >
        {value}
      </span>
      <span className='text-[9px] font-bold text-zinc-600 uppercase tracking-widest mt-1'>
        {label}
      </span>
    </div>
  );
}

function StatusChip({
  count,
  colors,
  label,
}: {
  count: number;
  colors: { text: string; bg: string; border: string };
  label: string;
}) {
  return (
    <div className='flex flex-col items-center px-3 py-2 min-w-[52px]'>
      <span className={cn('text-2xl font-black tracking-tight leading-none', colors.text)}>
        {count}
      </span>
      <span className='text-[9px] font-bold text-zinc-600 uppercase tracking-widest mt-1'>
        {label}
      </span>
    </div>
  );
}

function StatDivider() {
  return <div className='w-px h-8 bg-white/[0.07]' />;
}

function FilterPill({
  active,
  activeClassName,
  onClick,
  children,
}: {
  active: boolean;
  activeClassName?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all duration-150',
        active
          ? (activeClassName ?? 'bg-white/15 border-white/20 text-white')
          : 'bg-white/[0.03] border-white/[0.06] text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-300',
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className='flex flex-col items-center justify-center py-16 gap-3 border border-dashed border-white/[0.07] rounded-2xl bg-white/[0.015] text-center'>
      <div className='w-14 h-14 rounded-full bg-white/[0.04] border border-white/[0.06] flex items-center justify-center'>
        {icon}
      </div>
      <p className='text-sm font-semibold text-zinc-400'>{title}</p>
      {subtitle && <p className='text-xs text-zinc-600 max-w-xs'>{subtitle}</p>}
      {action}
    </div>
  );
}

// Profile settings popover

function ProfileSettingsPopover({
  profile,
  onUpdate,
  isSaving,
}: {
  profile: LocalProfile;
  onUpdate: (updates: Partial<LocalProfile>) => Promise<void>;
  isSaving: boolean;
}) {
  const accentDraftRegex = /^#[0-9a-fA-F]{0,6}$/;
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(profile.username);
  const [draftBio, setDraftBio] = useState(profile.bio ?? '');
  const [draftAccentColor, setDraftAccentColor] = useState(profile.accentColor);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftName(profile.username);
      setDraftBio(profile.bio ?? '');
      setDraftAccentColor(profile.accentColor);
    }
    setOpen(next);
  };

  const previewAccentColor = /^#[0-9a-fA-F]{6}$/.test(draftAccentColor)
    ? draftAccentColor
    : profile.accentColor;

  const handleSave = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName || isSaving) return;

    try {
      await onUpdate({
        username: trimmedName,
        bio: draftBio.trim(),
        accentColor: previewAccentColor,
      });
      toast.success('Profile saved');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save profile');
    }
  };

  const active = previewAccentColor;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='Customize profile'
          className='p-1.5 rounded-lg text-zinc-600 hover:text-white hover:bg-white/8 transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20'
        >
          <Settings2 className='w-3.5 h-3.5' />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align='start'
        sideOffset={10}
        className='w-72 p-0 bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden'
      >
        <div
          className='h-px w-full'
          style={{ background: `linear-gradient(to right, transparent, ${active}66, transparent)` }}
        />

        <div className='px-4 pt-4 pb-3 border-b border-white/[0.06]'>
          <h2 className='text-sm font-semibold text-white'>Customize Profile</h2>
          <p className='text-[11px] text-zinc-600 mt-0.5'>Stored in the desktop app settings.</p>
        </div>

        <div className='px-4 py-4 space-y-4'>
          <div className='space-y-1.5'>
            <label className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>
              Display Name
            </label>
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              maxLength={32}
              placeholder='Enter your name…'
              className='h-8 bg-zinc-900/80 border-white/8 text-sm text-white placeholder:text-zinc-700 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded-lg'
            />
          </div>

          <div className='space-y-1.5'>
            <label className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>
              Tagline
            </label>
            <textarea
              value={draftBio}
              onChange={(e) => setDraftBio(e.target.value)}
              maxLength={80}
              rows={2}
              placeholder='A short tagline…'
              className='w-full bg-zinc-900/80 border border-white/8 text-sm text-white placeholder:text-zinc-700 rounded-lg px-3 py-2 resize-none outline-none focus:ring-1 focus:ring-white/20 transition-all'
            />
            <p className='text-right text-[10px] text-zinc-700'>{draftBio.length}/80</p>
          </div>

          <div className='space-y-2'>
            <label className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>
              Accent
            </label>
            <div className='flex items-center gap-1.5 flex-wrap'>
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.color}
                  type='button'
                  title={p.label}
                  onClick={() => setDraftAccentColor(p.color)}
                  className={cn(
                    'w-6 h-6 rounded-md transition-all duration-150 hover:scale-110 focus-visible:outline-none border-2',
                    active === p.color
                      ? 'border-white scale-110 shadow-md'
                      : 'border-transparent opacity-50 hover:opacity-100',
                  )}
                  style={{ backgroundColor: p.color }}
                />
              ))}
            </div>
            <div className='flex items-center gap-2'>
              <div
                className='w-6 h-6 rounded-md border border-white/10 flex-shrink-0'
                style={{ backgroundColor: active }}
              />
              <Input
                value={draftAccentColor}
                onChange={(e) => {
                  const val = e.target.value;
                  if (accentDraftRegex.test(val)) setDraftAccentColor(val);
                }}
                maxLength={7}
                placeholder='#ffffff'
                className='h-7 bg-zinc-900/80 border-white/8 text-xs font-mono text-white uppercase placeholder:text-zinc-700 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded-lg'
              />
            </div>
          </div>
        </div>

        <div className='px-4 pb-4'>
          <Button
            size='sm'
            onClick={handleSave}
            disabled={!draftName.trim() || isSaving}
            className='w-full text-xs font-semibold rounded-lg h-8 flex items-center gap-1.5'
            style={{
              backgroundColor: active,
              color: active === '#ffffff' ? '#000' : '#fff',
            }}
          >
            <Check className='w-3 h-3' />
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// History item

function HistoryItem({
  item,
  showLibraryContext = false,
}: {
  item: WatchProgress;
  showLibraryContext?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;

  const progress = item.duration > 0 ? (item.position / item.duration) * 100 : 0;

  const mediaItem: MediaItem = {
    id: item.id,
    title: item.title,
    type: item.type_ as 'movie' | 'series',
    poster: item.poster,
    year: '',
  };

  const removeItem = useMutation({
    mutationFn: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await api.removeFromWatchHistory(item.id, item.type_, item.season, item.episode);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      toast.success('Removed from history');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove item');
    },
  });

  const handlePlayHistory = async (e: React.MouseEvent) => {
    e.preventDefault();

    try {
      const plan = await buildHistoryPlaybackPlan(item, from);
      if (plan.kind === 'details') {
        const notice = getHistoryPlaybackFallbackNotice(plan.reason, 'open-details');
        toast.info(notice.title, { description: notice.description });
        navigate(plan.target, { state: plan.state });
        return;
      }

      navigate(plan.target, { state: plan.state });
    } catch (err) {
      toast.error('Failed to resume playback', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  return (
    <div className='relative group/history-item'>
      <MediaCard
        item={mediaItem}
        progress={progress}
        onPlay={handlePlayHistory}
        showLibraryContext={showLibraryContext}
        subtitle={
          typeof item.season === 'number' && typeof item.episode === 'number'
            ? `S${item.season}:E${item.episode}`
            : undefined
        }
      />
      <Button
        size='icon'
        variant='ghost'
        className='absolute top-2 right-2 h-7 w-7 rounded-full bg-black/60 text-white/60 hover:bg-red-500/90 hover:text-white transition-all opacity-0 group-hover/history-item:opacity-100 z-[60] backdrop-blur-sm'
        onClick={(e) => removeItem.mutate(e)}
        title='Remove from history'
      >
        <X className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
}
