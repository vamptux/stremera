import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MediaCard, MediaCardSkeleton } from './media-card';
import { MediaItem } from '@/lib/api';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface MediaRowProps {
  title: string;
  queryKey: string[];
  queryFn: () => Promise<MediaItem[]>;
  className?: string;
  style?: React.CSSProperties;
}

export function MediaRow({ title, queryKey, queryFn, className, style }: MediaRowProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
  });

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const { current } = scrollContainerRef;
      const scrollAmount =
        direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
      current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (error) {
    return null;
  }

  return (
    <section className={cn('space-y-4 py-6 relative group/section', className)} style={style}>
      <div className='relative flex items-center justify-between pl-[72px] pr-6 md:pl-24 md:pr-12 lg:pl-28 mb-2'>
        <h2 className='text-xl font-bold tracking-wide text-white drop-shadow-md'>
          {title}
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
        {/* Scroll Container */}
        <div
          ref={scrollContainerRef}
          className='flex overflow-x-auto gap-4 pl-[72px] pr-6 md:pl-24 md:pr-12 lg:pl-28 pt-6 pb-12 scrollbar-hide snap-x snap-mandatory scroll-pl-[72px] md:scroll-pl-24 lg:scroll-pl-28 relative'
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
