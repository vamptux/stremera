import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface LocalSeasonEntry {
  number: number;
  label: string;
}

interface SeasonSwitcherProps {
  localSeasons: LocalSeasonEntry[];
  activeSeason: number | null;
  onLocalSeason: (season: number) => void;
}

export function SeasonSwitcher({
  localSeasons,
  activeSeason,
  onLocalSeason,
}: SeasonSwitcherProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);
  const hasMultipleSeasons = localSeasons.length > 1;

  const syncScrollState = () => {
    if (!scrollRef.current) return;

    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setShowLeft(scrollLeft > 4);
    setShowRight(scrollLeft < scrollWidth - clientWidth - 4);
  };

  useEffect(() => {
    if (!hasMultipleSeasons) return;

    syncScrollState();
    window.addEventListener('resize', syncScrollState);
    return () => window.removeEventListener('resize', syncScrollState);
  }, [hasMultipleSeasons, localSeasons]);

  useEffect(() => {
    if (!hasMultipleSeasons) return;
    if (activeSeason === null) return;

    const timer = window.setTimeout(() => {
      itemRefs.current[`local:${activeSeason}`]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeSeason, hasMultipleSeasons]);

  if (!hasMultipleSeasons) return null;

  const registerItemRef = (key: string) => (node: HTMLButtonElement | null) => {
    itemRefs.current[key] = node;
  };

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;

    scrollRef.current.scrollBy({
      left: direction === 'left' ? -320 : 320,
      behavior: 'smooth',
    });
  };

  return (
    <div className='relative'>
      {showLeft && (
        <div className='pointer-events-none absolute inset-y-0 left-0 z-10 flex w-14 items-center bg-gradient-to-r from-background via-background/85 to-transparent pr-2'>
          <button
            type='button'
            onClick={() => scroll('left')}
            className='pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/35 text-white/80 transition-colors hover:bg-black/55 hover:text-white'
            aria-label='Scroll seasons left'
          >
            <ChevronLeft className='h-4 w-4' />
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={syncScrollState}
        className='flex items-center gap-6 overflow-x-auto border-b border-white/5 pb-0 scrollbar-hide'
      >
        {localSeasons.map((season) => {
          const isActive = activeSeason === season.number;

          return (
            <button
              key={season.number}
              ref={registerItemRef(`local:${season.number}`)}
              type='button'
              className={cn(
                'relative shrink-0 whitespace-nowrap py-3 text-[15px] font-semibold transition-colors duration-200',
                isActive ? 'text-white' : 'text-zinc-500 hover:text-white',
              )}
              onClick={() => onLocalSeason(season.number)}
            >
              {season.label}
              {isActive && <div className='absolute bottom-0 left-0 right-0 h-[2px] rounded-t-sm bg-indigo-500' />}
            </button>
          );
        })}
      </div>

      {showRight && (
        <div className='pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 items-center justify-end bg-gradient-to-l from-background via-background/85 to-transparent pl-2'>
          <button
            type='button'
            onClick={() => scroll('right')}
            className='pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/35 text-white/80 transition-colors hover:bg-black/55 hover:text-white'
            aria-label='Scroll seasons right'
          >
            <ChevronRight className='h-4 w-4' />
          </button>
        </div>
      )}
    </div>
  );
}
