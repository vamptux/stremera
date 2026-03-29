import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, WatchProgress, MediaItem } from '@/lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { MediaCardSkeleton, MediaCard } from './media-card';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  buildHistoryPlaybackPlan,
  warmContinueWatchingCandidates,
} from '@/lib/history-playback';

export function ResumeSection() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const warmedResolveKeysRef = useRef<Set<string>>(new Set());
  const isOnline = useOnlineStatus();
  const { data, isLoading } = useQuery({
    queryKey: ['continue-watching'],
    queryFn: api.getContinueWatching,
    // staleTime: 0 means the cache is immediately stale so it will refetch
    // whenever the query is re-used (e.g. after returning from the player).
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const items = useMemo(() => data || [], [data]);

  useEffect(() => {
    if (!isOnline) return;

    void warmContinueWatchingCandidates(items, {
      warmedKeys: warmedResolveKeysRef.current,
    });
  }, [items, isOnline]);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const { current } = scrollContainerRef;
      const scrollAmount =
        direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
      current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (!isLoading && items.length === 0) return null;

  return (
    <section className='space-y-4 py-6 relative group/section'>
      <div className='relative flex items-center justify-between pl-[72px] pr-6 md:pl-24 md:pr-12 lg:pl-28 mb-2'>
        <h2 className='text-xl font-bold tracking-wide text-white drop-shadow-md'>
          Resume Watching
        </h2>

        <div className='flex items-center gap-2 opacity-0 group-hover/section:opacity-100 transition-opacity duration-300'>
          <Button
            size='icon'
            variant='ghost'
            className='h-9 w-9 rounded-full bg-white/10 border border-white/20 text-white hover:bg-white hover:text-black transition-all duration-300 backdrop-blur-md'
            onClick={() => scroll('left')}
          >
            <ChevronLeft className='h-5 w-5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='h-9 w-9 rounded-full bg-white/10 border border-white/20 text-white hover:bg-white hover:text-black transition-all duration-300 backdrop-blur-md'
            onClick={() => scroll('right')}
          >
            <ChevronRight className='h-5 w-5' />
          </Button>
        </div>
      </div>

      <div className='relative group'>
        <div
          ref={scrollContainerRef}
          className='flex overflow-x-auto gap-4 pl-[72px] pr-6 md:pl-24 md:pr-12 lg:pl-28 pt-4 pb-8 scrollbar-hide snap-x snap-mandatory scroll-pl-[72px] md:scroll-pl-24 lg:scroll-pl-28 relative z-0'
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {isLoading
            ? Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className='flex-none w-[140px] md:w-[170px] snap-start'>
                  <MediaCardSkeleton />
                </div>
              ))
            : items.map((item) => (
                <div
                  key={`${item.id}-${item.season}-${item.episode}`}
                  className='flex-none w-[140px] md:w-[170px] snap-start'
                >
                  <ResumeCard item={item} />
                </div>
              ))}
        </div>
      </div>
    </section>
  );
}

function ResumeCard({ item }: { item: WatchProgress }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const from = `${location.pathname}${location.search}`;
  const progressRaw = item.duration > 0 ? (item.position / item.duration) * 100 : 0;
  const progressPercent = Math.min(100, Math.max(0, progressRaw));
  const progressValue = progressPercent > 0 ? progressPercent : undefined;

  const removeItem = useMutation({
    mutationFn: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Remove ALL episodes for this title so the show disappears entirely
      // from Continue Watching rather than rolling back to the previous episode.
      await api.removeAllFromWatchHistory(item.id, item.type_);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      toast.success('Removed from Continue Watching');
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
        toast.info('Episode context missing', {
          description: 'Opening details so you can select the episode to continue.',
        });
        navigate(plan.target, { state: plan.state });
        return;
      }

      navigate(plan.target, { state: plan.state });
    } catch (err) {
      toast.error('Failed to open continue watching item', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  const mediaItem: MediaItem = {
    id: item.id,
    title: item.title,
    type: item.type_ as 'movie' | 'series',
    poster: item.poster,
    year: '', // Optional
  };

  return (
    <div className='relative group/resume-item'>
      <MediaCard
        item={mediaItem}
        progress={progressValue}
        onPlay={handlePlay}
        onRemoveFromContinue={(e) => removeItem.mutate(e)}
        showLibraryContext
        subtitle={
          typeof item.season === 'number' && typeof item.episode === 'number'
            ? `S${item.season}:E${item.episode}`
            : undefined
        }
      />
      <Button
        size='icon'
        variant='ghost'
        className='absolute top-1 right-1 h-7 w-7 rounded-full bg-black/80 text-zinc-400 hover:bg-red-600 hover:text-white transition-all duration-200 opacity-100 z-[60] backdrop-blur-md shadow-sm border border-white/10'
        onClick={(e) => removeItem.mutate(e)}
        title='Remove from Continue Watching'
      >
        <Trash2 className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
}
