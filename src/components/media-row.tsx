import { useQuery } from '@tanstack/react-query';
import { MediaCard } from './media-card';
import { HorizontalMediaRail } from './horizontal-media-rail';
import { type MediaItem } from '@/lib/api';
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
  const { data = [], isLoading, error } = useQuery({
    queryKey,
    queryFn,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
  });

  if (error) return null;

  return (
    <HorizontalMediaRail
      title={title}
      items={data}
      isLoading={isLoading}
      getItemKey={(item) => item.id}
      renderItem={(item) => <MediaCard item={item} />}
      sectionClassName={className}
      style={style}
      headerContent={
        genreFilter ? (
          <div
            className='flex gap-1 overflow-x-auto pr-2'
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {genreFilter.options.map((genre) => (
              <button
                key={genre}
                type='button'
                onClick={() => genreFilter.onChange(genre)}
                className={cn(
                  'flex-none px-3.5 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all duration-200 border',
                  genreFilter.active === genre
                    ? 'bg-white/[0.14] text-white border-white/[0.12]'
                    : 'text-zinc-400 border-white/[0.06] bg-white/[0.03] hover:text-zinc-200 hover:bg-white/[0.07] hover:border-white/[0.1]',
                )}
              >
                {genre}
              </button>
            ))}
          </div>
        ) : null
      }
    />
  );
}
