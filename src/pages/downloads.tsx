import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  Pause,
  Play,
  X,
  CheckCircle2,
  AlertCircle,
  HardDriveDownload,
  Trash2,
  MoreVertical,
  Folder,
  FolderOpen,
  ChevronRight,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDownloads } from '@/hooks/use-downloads';
import { api, DownloadItem } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function calculateEta(total: number, downloaded: number, speed: number) {
  if (speed === 0 || total === 0) return '-';
  const remaining = total - downloaded;
  const seconds = remaining / speed;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function Downloads() {
  const { downloads, pauseDownload, removeDownload, refetchDownloads } = useDownloads();
  const [activeTab, setActiveTab] = useState('all');
  const [expandedSeries, setExpandedSeries] = useState<string | null>(null);

  // Sync with backend every time the Downloads page is opened so stale
  // in-memory state from a previous session is replaced with the persisted data.
  useEffect(() => {
    refetchDownloads();
  }, [refetchDownloads]);

  const filteredDownloads = useMemo(() => {
    return downloads.filter((item) => {
      if (activeTab === 'all') return true;
      if (activeTab === 'active')
        return (
          item.status === 'downloading' || item.status === 'paused' || item.status === 'pending'
        );
      return item.status === activeTab;
    });
  }, [downloads, activeTab]);

  // Group by series
  const groupedItems = useMemo(() => {
    const groups: Record<string, DownloadItem[]> = {};
    const singles: DownloadItem[] = [];

    filteredDownloads.forEach((item) => {
      if ((item.mediaType === 'series' || item.mediaType === 'anime') && item.mediaId) {
        // Group by mediaId if available, or title prefix (simple heuristic)
        const key = item.mediaId;
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      } else {
        singles.push(item);
      }
    });

    // Flatten groups with only 1 item back to singles
    const finalGroups: { id: string; items: DownloadItem[]; title: string; poster?: string; createdAt: number }[] = [];
    Object.entries(groups).forEach(([key, items]) => {
      if (items.length > 1) {
        // Find common title prefix or use first item's title (cleaned)
        // Assume first item title is representative enough or use stored series title if we had it
        // For now, use the title of the first item but maybe strip "S01E01" etc if possible
        // Better: We stored the title in startDownload.
        // Let's just use the first item's title for now.
        finalGroups.push({
          id: key,
          items: items.sort(
            (a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0),
          ),
          title: items[0].title.split(/s\d+e\d+/i)[0].replace(/ - $/, '') || items[0].title,
          poster: items[0].poster,
          createdAt: Math.max(...items.map(i => i.createdAt)),
        });
      } else {
        singles.push(...items);
      }
    });

    // Sort by date added
    return { 
      groups: finalGroups.sort((a, b) => b.createdAt - a.createdAt), 
      singles: singles.sort((a, b) => b.createdAt - a.createdAt) 
    };
  }, [filteredDownloads]);

  const totalUsed = downloads.reduce((acc, item) => acc + item.downloadedSize, 0);
  const activeCount = downloads.filter((d) => d.status === 'downloading').length;
  const completedCount = downloads.filter((d) => d.status === 'completed').length;

  return (
    <div className='min-h-screen pt-16 pb-12 px-4 md:pl-24 md:pr-12 lg:pl-28 space-y-6 animate-in fade-in duration-500'>
      {/* Header */}
      <div className='flex items-end justify-between border-b border-white/5 pb-4'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight text-white'>Downloads</h1>
          <p className='text-sm text-muted-foreground/80'>
            Manage your local content and active downloads.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            className='h-8 text-xs border-white/10 bg-zinc-900/50 hover:bg-zinc-800 hover:text-white'
            onClick={() =>
              downloads
                .filter((d) => d.status === 'downloading')
                .forEach((d) => pauseDownload(d.id))
            }
          >
            <Pause className='mr-2 h-3.5 w-3.5' /> Pause All
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='h-8 text-xs border-red-500/20 bg-red-500/5 text-red-500 hover:bg-red-500/10 hover:text-red-400'
            onClick={() =>
              downloads
                .filter((d) => d.status === 'completed')
                .forEach((d) => removeDownload(d.id, false))
            }
          >
            <X className='mr-2 h-3.5 w-3.5' /> Clear Completed
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className='grid gap-6 md:grid-cols-3'>
        <Card className='relative overflow-hidden border-white/5 bg-zinc-900/40 p-6 backdrop-blur-sm transition-colors hover:bg-zinc-900/60'>
          <div className='absolute right-0 top-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-primary/10 blur-2xl' />
          <div className='flex items-center gap-4 relative'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner shadow-white/5'>
              <HardDriveDownload className='h-6 w-6' />
            </div>
            <div>
              <p className='text-sm font-medium text-muted-foreground/80'>Total Storage Used</p>
              <h2 className='text-2xl font-bold tracking-tight text-white'>
                {formatBytes(totalUsed)}
              </h2>
            </div>
          </div>
        </Card>
        <Card className='relative overflow-hidden border-white/5 bg-zinc-900/40 p-6 backdrop-blur-sm transition-colors hover:bg-zinc-900/60'>
          <div className='absolute right-0 top-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-blue-500/10 blur-2xl' />
          <div className='flex items-center gap-4 relative'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500 shadow-inner shadow-white/5'>
              <Download className='h-6 w-6' />
            </div>
            <div>
              <p className='text-sm font-medium text-muted-foreground/80'>Active Downloads</p>
              <h2 className='text-2xl font-bold tracking-tight text-white'>{activeCount}</h2>
            </div>
          </div>
        </Card>
        <Card className='relative overflow-hidden border-white/5 bg-zinc-900/40 p-6 backdrop-blur-sm transition-colors hover:bg-zinc-900/60'>
          <div className='absolute right-0 top-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-emerald-500/10 blur-2xl' />
          <div className='flex items-center gap-4 relative'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 shadow-inner shadow-white/5'>
              <CheckCircle2 className='h-6 w-6' />
            </div>
            <div>
              <p className='text-sm font-medium text-muted-foreground/80'>Completed</p>
              <h2 className='text-2xl font-bold tracking-tight text-white'>{completedCount}</h2>
            </div>
          </div>
        </Card>
      </div>

      {/* Tabs & List */}
      <Tabs defaultValue='all' value={activeTab} onValueChange={setActiveTab} className='space-y-6'>
        <TabsList className='bg-zinc-900/50 border border-white/5 p-1'>
          <TabsTrigger
            value='all'
            className='data-[state=active]:bg-zinc-800 data-[state=active]:text-white'
          >
            All
          </TabsTrigger>
          <TabsTrigger
            value='active'
            className='data-[state=active]:bg-zinc-800 data-[state=active]:text-white'
          >
            Active
          </TabsTrigger>
          <TabsTrigger
            value='completed'
            className='data-[state=active]:bg-zinc-800 data-[state=active]:text-white'
          >
            Completed
          </TabsTrigger>
          <TabsTrigger
            value='error'
            className='data-[state=active]:bg-zinc-800 data-[state=active]:text-white'
          >
            Failed
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className='space-y-4'>
          <AnimatePresence mode='popLayout'>
            {/* Groups */}
            {groupedItems.groups.map((group) => (
              <div key={group.id} className='space-y-2'>
                <div
                  className='flex items-center gap-2 p-2 rounded-lg bg-zinc-900/40 border border-white/5 cursor-pointer hover:bg-zinc-900/60 transition-colors'
                  onClick={() => setExpandedSeries(expandedSeries === group.id ? null : group.id)}
                >
                  <Folder className='w-5 h-5 text-blue-400' />
                  <span className='font-medium text-zinc-200 flex-1'>{group.title}</span>
                  <Badge variant='secondary' className='bg-white/10'>
                    {group.items.length} episodes
                  </Badge>
                  <ChevronRight
                    className={cn(
                      'w-4 h-4 text-zinc-500 transition-transform',
                      expandedSeries === group.id && 'rotate-90',
                    )}
                  />
                </div>
                <AnimatePresence>
                  {expandedSeries === group.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className='pl-4 space-y-2 border-l-2 border-white/5 ml-3 overflow-hidden'
                    >
                      {group.items.map((item) => (
                        <DownloadCard key={item.id} item={item} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
                ))}

            {/* Singles */}
            {groupedItems.singles.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <DownloadCard item={item} />
              </motion.div>
            ))}
          </AnimatePresence>
          {filteredDownloads.length === 0 && (
            <div className='text-center py-12 text-muted-foreground'>
              <p>No downloads found in this category.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Build the full file path from the directory + file name. */
function buildFullPath(filePath: string, fileName: string) {
  const separator = filePath.includes('\\') ? '\\' : '/';
  return filePath.endsWith(separator) ? filePath + fileName : filePath + separator + fileName;
}

function DownloadCard({ item }: { item: DownloadItem }) {
  const { pauseDownload, resumeDownload, cancelDownload, removeDownload, refetchDownloads } = useDownloads();
  const navigate = useNavigate();

  const handlePlay = async () => {
    // DR3: For completed downloads, verify the file still exists on disk
    // before we try to play it.  If it has been deleted externally the backend
    // will transition the item to Error so the card updates automatically.
    if (item.status === 'completed') {
      try {
        const exists = await api.checkDownloadFileExists(item.id);
        if (!exists) {
          toast.error('File was deleted from disk', {
            description: item.title,
            duration: 6000,
          });
          void refetchDownloads();
          return;
        }
      } catch {
        // If the check itself fails (e.g. app offline), fall through optimistically
      }
    }

    const streamUrl = buildFullPath(item.filePath, item.fileName);
    const type = item.mediaType || 'movie';
    const id = item.mediaId || 'local';

    // Fast resume: look up the last saved position so the player starts exactly
    // where the user left off without waiting for an extra async round-trip.
    let startTime = 0;
    if (id !== 'local') {
      try {
        const prog = await api.getWatchProgress(id, type, item.season, item.episode);
        if (prog && prog.position > 0) startTime = prog.position;
      } catch { /* ignore — player will self-recover */ }
    }

    navigate(
      item.season
        ? `/player/${type}/${id}/${item.season}/${item.episode}`
        : `/player/${type}/${id}`,
      {
        state: {
          streamUrl,
          title: item.title,
          poster: item.poster,
          startTime,
          isOffline: true,
        },
      },
    );
  };

  const handleOpenFolder = () => {
    void api.openFolder(buildFullPath(item.filePath, item.fileName));
  };

  return (
    <Card className={cn(
      'group overflow-hidden transition-all duration-300 hover:shadow-2xl hover:shadow-black/20',
      item.status === 'error'
        // DR1: Visually distinct error state with red ring so failed downloads are
        // immediately apparent without requiring the user to find the Failed tab.
        ? 'border-red-500/20 bg-red-950/10 hover:bg-red-950/20 hover:border-red-500/30'
        : 'border-white/5 bg-zinc-900/40 hover:bg-zinc-900/60 hover:border-white/10',
    )}>
      <div className='flex gap-4 p-3'>
        {/* Poster */}
        <div className='relative h-20 w-14 flex-shrink-0 overflow-hidden rounded-md bg-zinc-800 shadow-lg ring-1 ring-white/5 group-hover:ring-white/10 transition-all'>
          {item.poster ? (
            <img
              src={item.poster}
              alt={item.title}
              className='h-full w-full object-cover opacity-90 group-hover:opacity-100 transition-opacity'
            />
          ) : (
            <div className='h-full w-full flex items-center justify-center bg-zinc-800 text-zinc-600'>
              <Download className='h-6 w-6' />
            </div>
          )}
          <div className='absolute inset-0 bg-gradient-to-t from-black/60 to-transparent' />
        </div>

        {/* Content */}
        <div className='flex flex-1 flex-col justify-center py-0.5'>
          <div className='flex items-center justify-between gap-4'>
            <div className='space-y-1'>
              <h3 className='text-sm font-medium leading-none truncate max-w-[200px] md:max-w-[400px] lg:max-w-[600px] text-zinc-100 group-hover:text-white transition-colors'>
                {item.title}
              </h3>
              <div className='flex items-center gap-3 text-[10px] text-muted-foreground/80 font-medium'>
                <Badge
                  variant='secondary'
                  className={cn(
                    'rounded-sm px-1.5 py-0 text-[9px] uppercase tracking-widest font-bold border-0 h-4',
                    item.status === 'completed' &&
                      'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                    item.status === 'downloading' &&
                      'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20',
                    item.status === 'error' && 'bg-red-500/10 text-red-500 hover:bg-red-500/20',
                    item.status === 'paused' &&
                      'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20',
                    item.status === 'pending' && 'bg-zinc-500/10 text-zinc-500',
                  )}
                >
                  {item.status}
                </Badge>
                <div className='h-0.5 w-0.5 rounded-full bg-white/20' />
                <span className='font-mono tracking-tight'>
                  {formatBytes(item.downloadedSize)} / {formatBytes(item.totalSize)}
                </span>
                {item.status === 'downloading' && (
                  <>
                    <div className='h-0.5 w-0.5 rounded-full bg-white/20' />
                    <span className='text-blue-400'>{formatSpeed(item.speed)}</span>
                    <div className='h-0.5 w-0.5 rounded-full bg-white/20' />
                    <span>
                      ETA: {calculateEta(item.totalSize, item.downloadedSize, item.speed)}
                    </span>
                  </>
                )}
                {item.status === 'error' && item.error && (
                  <span className='text-red-400 ml-2'>Error: {item.error}</span>
                )}
              </div>
            </div>

            {/* Actions — always visible for error state, hover-reveal for others (DR1) */}
            <div className={cn(
              'flex items-center gap-1 transition-opacity duration-200',
              item.status === 'error' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}>
              {/* Folder open — always available */}
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7 hover:bg-white/10 rounded-full'
                title='Open file location'
                onClick={handleOpenFolder}
              >
                <FolderOpen className='h-3.5 w-3.5' />
              </Button>

              {/* Play while downloading — promoted out of the 3-dots menu */}
              {(item.status === 'downloading' || item.status === 'paused') &&
                item.progress > 0 && (
                  <Button
                    size='icon'
                    variant='ghost'
                    className='h-7 w-7 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-full'
                    title='Play partially downloaded file'
                    onClick={handlePlay}
                  >
                    <Play className='h-3.5 w-3.5 fill-current' />
                  </Button>
                )}

              {/* Primary status action */}
              {item.status === 'completed' ? (
                <Button
                  size='icon'
                  variant='ghost'
                  className='h-7 w-7 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-full'
                  onClick={handlePlay}
                >
                  <Play className='h-3.5 w-3.5 fill-current' />
                </Button>
              ) : item.status === 'downloading' ? (
                <Button
                  size='icon'
                  variant='ghost'
                  className='h-7 w-7 hover:bg-white/10 rounded-full'
                  onClick={() => pauseDownload(item.id)}
                >
                  <Pause className='h-3.5 w-3.5' />
                </Button>
              ) : item.status === 'error' ? (
                // DR1: Prominent, always-visible Retry button with distinct icon
                <Button
                  size='icon'
                  variant='ghost'
                  className='h-7 w-7 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-full'
                  title='Retry download'
                  onClick={() => resumeDownload(item.id)}
                >
                  <RotateCcw className='h-3.5 w-3.5' />
                </Button>
              ) : item.status === 'paused' || item.status === 'pending' ? (
                <Button
                  size='icon'
                  variant='ghost'
                  className='h-7 w-7 hover:bg-white/10 rounded-full'
                  title='Resume download'
                  onClick={() => resumeDownload(item.id)}
                >
                  <Play className='h-3.5 w-3.5' />
                </Button>
              ) : (
                <Button
                  size='icon'
                  variant='ghost'
                  className='h-7 w-7 text-red-500 hover:bg-red-500/10 rounded-full'
                  title={item.error || 'Error'}
                >
                  <AlertCircle className='h-3.5 w-3.5' />
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size='icon'
                    variant='ghost'
                    className='h-7 w-7 hover:bg-white/10 rounded-full'
                  >
                    <MoreVertical className='h-3.5 w-3.5' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-44'>
                  <DropdownMenuItem onClick={handleOpenFolder}>
                    <FolderOpen className='mr-2 h-3.5 w-3.5' /> Open Location
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className='text-destructive focus:text-destructive'
                    onClick={() => removeDownload(item.id, true)}
                  >
                    <Trash2 className='mr-2 h-3.5 w-3.5' /> Delete File
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => removeDownload(item.id, false)}>
                    <X className='mr-2 h-3.5 w-3.5' /> Remove from List
                  </DropdownMenuItem>
                  {(item.status === 'downloading' || item.status === 'pending') && (
                    <DropdownMenuItem onClick={() => cancelDownload(item.id)}>
                      <X className='mr-2 h-3.5 w-3.5' /> Cancel
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Progress Bar */}
          <div className='space-y-2 mt-2.5'>
            <Progress
              value={item.progress}
              className={cn(
                'h-0.5 bg-white/5',
                item.status === 'completed' && 'bg-emerald-500/10',
                item.status === 'error' && 'bg-red-500/10',
              )}
              indicatorClassName={cn(
                'transition-all duration-500',
                item.status === 'completed' && 'bg-emerald-500',
                item.status === 'downloading' && 'bg-blue-500',
                item.status === 'error' && 'bg-red-500',
                item.status === 'paused' && 'bg-amber-500',
              )}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
