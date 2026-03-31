import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MediaCard, MediaCardSkeleton } from './media-card';
import { MediaItem } from '@/lib/api';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface GenreFilterConfig {
  options: readonly string[];
  active: string;
  onChange: (genre: string) => void;
}

interface MediaRowProps {
  title: string;
  queryKey: string[];
  queryFn: () => Promise<MediaItem[]>;
  className?: string;
  style?: React.CSSProperties;
  genreFilter?: GenreFilterConfig;
}

export function MediaRow({ title, queryKey, queryFn, className, style, genreFilter }: MediaRowProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
  });

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) return;
    const { current } = scrollContainerRef;
    const delta = direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
    current.scrollBy({ left: delta, behavior: 'smooth' });
  };

  if (error) return null;

  const contentInsets = 'px-6 pl-[72px] md:px-12 md:pl-24 lg:px-14 lg:pl-28';

  return (
    <section className={cn('py-4 relative group/section', className)} style={style}>
      <div className={cn(contentInsets, 'mb-2')}>
        <div className='flex items-center justify-between mb-2'>
          <h2 className='text-base font-semibold text-white tracking-tight'>{title}</h2>
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

        {genreFilter && (
          <div
            className='flex gap-1 overflow-x-auto pr-2'
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {genreFilter.options.map((g) => (
              <button
                key={g}
                type='button'
                onClick={() => genreFilter.onChange(g)}
                className={cn(
                  'flex-none px-3.5 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all duration-200 border',
                  genreFilter.active === g
                    ? 'bg-white/[0.14] text-white border-white/[0.12]'
                    : 'text-zinc-400 border-white/[0.06] bg-white/[0.03] hover:text-zinc-200 hover:bg-white/[0.07] hover:border-white/[0.1]',
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={cn(contentInsets, 'overflow-hidden')}>
        <div
          ref={scrollContainerRef}
          className='flex overflow-x-auto gap-3 pb-8 scrollbar-hide snap-x snap-mandatory'
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className='flex-none w-[140px] md:w-[170px] snap-start'>
                  <MediaCardSkeleton />
                </div>
              ))
            : data?.map((item) => (
                <div key={item.id} className='flex-none w-[140px] md:w-[170px] snap-start'>
                  <MediaCard item={item} />
                </div>
              ))}
        </div>
      </div>
    </section>
  );
}
