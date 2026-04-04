import { MediaItem, WatchProgress } from '@/lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { MediaCard } from './media-card';
import {
  HorizontalMediaRail,
  HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
} from './horizontal-media-rail';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  buildHistoryPlaybackPlan,
  getHistoryPlaybackFallbackNotice,
} from '@/lib/history-playback';
import {
  useContinueWatching,
  useRemoveFromContinueWatching,
} from '@/hooks/use-media-library';

export function ResumeSection() {
  const { data = [], isLoading } = useContinueWatching({
    // staleTime: 0 means the cache is immediately stale so it will refetch
    // whenever the query is re-used (e.g. after returning from the player).
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  return (
    <HorizontalMediaRail
      title='Continue Watching'
      items={data}
      isLoading={isLoading}
      emptyState={
        <div className={cn(HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS, 'pt-5 pb-3')}>
          <div className='rounded-lg border border-white/[0.05] bg-white/[0.015] px-6 py-7 text-center'>
            <p className='text-[13px] font-medium text-white/40'>No activity yet</p>
            <p className='mt-1 text-[12px] text-zinc-700'>Start watching something to see it here</p>
          </div>
        </div>
      }
      getItemKey={(item) => `${item.id}-${item.season}-${item.episode}`}
      renderItem={(item) => <ResumeCard item={item} />}
      skeletonCount={5}
      scrollerClassName='gap-4 pt-4 relative z-0'
      viewportClassName='relative'
    />
  );
}

function ResumeCard({ item }: { item: WatchProgress }) {
  const location = useLocation();
  const navigate = useNavigate();
  const from = `${location.pathname}${location.search}`;
  const progressRaw = item.duration > 0 ? (item.position / item.duration) * 100 : 0;
  const progressPercent = Math.min(100, Math.max(0, progressRaw));
  const progressValue = progressPercent > 0 ? progressPercent : undefined;
  const removeFromContinueWatching = useRemoveFromContinueWatching({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
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
        onRemoveFromContinue={(e) => {
          e.preventDefault();
          e.stopPropagation();
          removeFromContinueWatching.mutate();
        }}
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
