import { useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, WatchProgress, MediaItem } from '@/lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { MediaCardSkeleton, MediaCard } from './media-card';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  buildHistoryPlaybackPlan,
  getHistoryPlaybackFallbackNotice,
} from '@/lib/history-playback';

export function ResumeSection() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['continue-watching'],
    queryFn: api.getContinueWatching,
    // staleTime: 0 means the cache is immediately stale so it will refetch
    // whenever the query is re-used (e.g. after returning from the player).
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const items = useMemo(() => data || [], [data]);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const { current } = scrollContainerRef;
      const scrollAmount =
        direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
      current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const contentInsets = 'px-6 pl-[72px] md:px-12 md:pl-24 lg:px-14 lg:pl-28';

  if (!isLoading && items.length === 0) {
    return (
      <div className={cn(contentInsets, 'pt-5 pb-3')}>
        <div className='rounded-lg border border-white/[0.05] bg-white/[0.015] px-6 py-7 text-center'>
          <p className='text-[13px] font-medium text-white/40'>No activity yet</p>
          <p className='mt-1 text-[12px] text-zinc-700'>Start watching something to see it here</p>
        </div>
      </div>
    );
  }

  return (
    <section className='py-4 relative group/section'>
      <div className={cn(contentInsets, 'relative flex items-center justify-between mb-2')}>
        <h2 className='text-base font-semibold text-white tracking-tight'>Continue Watching</h2>

        <div className='flex items-center gap-1.5 opacity-0 group-hover/section:opacity-100 transition-opacity duration-300'>
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 rounded-lg bg-white/[0.06] border border-white/[0.1] text-zinc-400 hover:bg-white/[0.12] hover:text-white transition-all duration-200 backdrop-blur-sm'
            onClick={() => scroll('left')}
          >
            <ChevronLeft className='h-4 w-4' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 rounded-lg bg-white/[0.06] border border-white/[0.1] text-zinc-400 hover:bg-white/[0.12] hover:text-white transition-all duration-200 backdrop-blur-sm'
            onClick={() => scroll('right')}
          >
            <ChevronRight className='h-4 w-4' />
          </Button>
        </div>
      </div>

      <div className={cn(contentInsets, 'relative overflow-hidden')}>
        <div
          ref={scrollContainerRef}
          className='flex overflow-x-auto gap-4 pt-4 pb-8 scrollbar-hide snap-x snap-mandatory relative z-0'
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
        const notice = getHistoryPlaybackFallbackNotice(plan.reason, 'open-details');
        toast.info(notice.title, { description: notice.description });
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
    </div>
  );
}
