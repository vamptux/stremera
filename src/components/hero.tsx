import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Play, Plus, Star } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useIsItemInLibrary, useToggleLibraryItem } from '@/hooks/use-media-library';
import { api, type MediaItem } from '@/lib/api';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { cn } from '@/lib/utils';

interface HeroCarouselStateOptions {
  isPaused?: boolean;
  itemCount: number;
  rotationIntervalMs?: number;
  transitionDurationMs?: number;
}

interface HeroCarouselIndicatorsProps {
  activeIndex: number;
  itemKeys: readonly string[];
  itemCount: number;
  onSelect: (index: number) => void;
  scrollOpacity: number;
}

function HeroCarouselIndicators({
  activeIndex,
  itemKeys,
  itemCount,
  onSelect,
  scrollOpacity,
}: HeroCarouselIndicatorsProps) {
  if (itemCount <= 1) {
    return null;
  }

  return (
    <div
      className='absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.06] px-2.5 py-1.5 backdrop-blur-md transition-opacity duration-300'
      style={{ opacity: Math.max(0, 1 - scrollOpacity * 2) }}
    >
      {itemKeys.map((itemKey, index) => (
        <button
          key={itemKey}
          type='button'
          aria-label={`Go to slide ${index + 1}`}
          onClick={() => onSelect(index)}
          className={cn(
            'rounded-full transition-all duration-500 ease-out',
            index === activeIndex
              ? 'h-[5px] w-5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.4)]'
              : 'h-[5px] w-[5px] bg-white/25 hover:bg-white/50',
          )}
        />
      ))}
    </div>
  );
}

function useHeroCarouselState({
  isPaused = false,
  itemCount,
  rotationIntervalMs = 10_000,
  transitionDurationMs = 300,
}: HeroCarouselStateOptions) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<number | null>(null);
  const activeIndex = itemCount > 0 ? currentIndex % itemCount : 0;

  const clearTransitionTimeout = useCallback(() => {
    if (transitionTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(transitionTimeoutRef.current);
    transitionTimeoutRef.current = null;
  }, []);

  const queueTransition = useCallback(
    (nextIndex: number) => {
      if (itemCount <= 0) {
        return;
      }

      clearTransitionTimeout();
      setIsTransitioning(true);
      transitionTimeoutRef.current = window.setTimeout(() => {
        setCurrentIndex(nextIndex);
        setIsTransitioning(false);
        transitionTimeoutRef.current = null;
      }, transitionDurationMs);
    },
    [clearTransitionTimeout, itemCount, transitionDurationMs],
  );

  const syncIndexBounds = useEffectEvent((nextItemCount: number) => {
    if (nextItemCount === 0) {
      clearTransitionTimeout();
      setCurrentIndex(0);
      setIsTransitioning(false);
      return;
    }

    if (currentIndex >= nextItemCount) {
      setCurrentIndex((previousIndex) => previousIndex % nextItemCount);
    }
  });

  const advanceSlide = useEffectEvent(() => {
    if (isTransitioning || itemCount <= 1) {
      return;
    }

    queueTransition((activeIndex + 1) % itemCount);
  });

  const handleSelect = useCallback(
    (index: number) => {
      if (isTransitioning || index === activeIndex || index < 0 || index >= itemCount) {
        return;
      }

      queueTransition(index);
    },
    [activeIndex, isTransitioning, itemCount, queueTransition],
  );

  useEffect(() => {
    return () => {
      clearTransitionTimeout();
    };
  }, [clearTransitionTimeout]);

  useEffect(() => {
    syncIndexBounds(itemCount);
  }, [itemCount]);

  useEffect(() => {
    if (itemCount <= 1 || isPaused) {
      return;
    }

    const interval = window.setInterval(() => {
      advanceSlide();
    }, rotationIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [isPaused, itemCount, rotationIntervalMs]);

  return {
    activeIndex,
    handleSelect,
    isTransitioning,
  };
}

interface HeroProps {
  items: MediaItem[];
  /** Called once when the first backdrop image finishes loading (used to
   * trigger deferred secondary rows earlier than the fallback timeout). */
  onFirstImageLoaded?: () => void;
}

export function Hero({ items, onFirstImageLoaded }: HeroProps) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [isPausedByHover, setIsPausedByHover] = useState(false);
  const [scrollOpacity, setScrollOpacity] = useState(0);
  const from = `${location.pathname}${location.search}`;
  const firstImageFiredRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const { activeIndex, handleSelect, isTransitioning } = useHeroCarouselState({
    itemCount: items.length,
    isPaused: isPausedByHover,
  });

  const item = items[activeIndex];
  const activeHeroItemId = item?.id;
  const activeHeroDetailsType = resolvePlayerRouteMediaType(item?.type, item?.id);
  const shouldIncludeHeroEpisodes = !(
    item?.id?.startsWith('kitsu:') && activeHeroDetailsType === 'anime'
  );

  const { data: heroDetails } = useQuery({
    queryKey: ['details', activeHeroDetailsType, activeHeroItemId],
    queryFn: () =>
      activeHeroItemId
        ? api.getMediaDetails(activeHeroDetailsType, activeHeroItemId, {
            includeEpisodes: shouldIncludeHeroEpisodes,
          })
        : Promise.reject(new Error('Media ID is required for hero details lookup.')),
    enabled: !!activeHeroItemId,
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        const nextOpacity = Math.min(window.scrollY / 600, 0.9);
        setScrollOpacity((previousOpacity) =>
          Math.abs(previousOpacity - nextOpacity) < 0.01 ? previousOpacity : nextOpacity,
        );
        scrollFrameRef.current = null;
      });
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);

      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (items.length <= 1) {
      return;
    }

    const nextItem = items[(activeIndex + 1) % items.length];
    const previousItem = items[(activeIndex - 1 + items.length) % items.length];
    const candidateItems = [nextItem, previousItem].filter(
      (candidate, index, array): candidate is MediaItem =>
        Boolean(candidate) && array.findIndex((entry) => entry?.id === candidate?.id) === index,
    );

    for (const candidate of candidateItems) {
      prefetchDetailsRouteData(queryClient, {
        mediaId: candidate.id,
        mediaType: candidate.type,
      });
    }
  }, [activeIndex, items, queryClient]);

  const heroRating = heroDetails?.rating ?? null;
  const { data: isInLibrary = false } = useIsItemInLibrary(item?.id);
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });

  if (!item) {
    return (
      <div className='w-full h-[60vh] min-h-[420px] max-h-[680px] -mt-8 bg-zinc-950 relative overflow-hidden'>
        <div className='absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent' />
      </div>
    );
  }

  const backdropUrl = item.backdrop || item.poster;
  const detailsRouteType = resolvePlayerRouteMediaType(item.type, item.id);

  return (
    <section
      className='relative w-full h-[60vh] min-h-[420px] max-h-[680px] -mt-8 overflow-hidden group'
      aria-label='Featured titles'
      onPointerEnter={() => setIsPausedByHover(true)}
      onPointerLeave={() => setIsPausedByHover(false)}
    >
      {/* Scroll Dimming & Blur Overlay */}
      <div
        className='absolute inset-0 bg-black/60 backdrop-blur-[2px] pointer-events-none transition-opacity duration-300 ease-out z-[5]'
        style={{ opacity: scrollOpacity }}
      />

      {/* Background Image - with smooth transition and mask for seamless blending */}
      <div
        className={cn(
          'absolute inset-0 transition-opacity duration-500 ease-in-out',
          isTransitioning ? 'opacity-0' : 'opacity-100',
        )}
      >
        {backdropUrl && (
          <>
            <img
              src={backdropUrl}
              alt={item.title}
              className='w-full h-full object-cover object-top'
              onLoad={() => {
                if (!firstImageFiredRef.current) {
                  firstImageFiredRef.current = true;
                  onFirstImageLoaded?.();
                }
              }}
            />
            <div className='absolute inset-0 bg-gradient-to-r from-black/70 via-black/25 to-transparent' />
            <div className='absolute inset-0 bg-gradient-to-t from-black via-black/35 to-transparent' />
          </>
        )}
      </div>

      {/* Visible area wrapper — content offset past sidebar, image bleeds behind it */}
      <div className='absolute inset-0'>
        <div className='relative w-full h-full'>
          {/* Content */}
          <div
            className={cn(
              'absolute inset-0 flex items-end justify-start transition-all duration-500 ease-in-out pb-16 pl-6 md:pl-[84px] lg:pl-28',
              isTransitioning ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0',
            )}
          >
            <div
              className='max-w-5xl w-full flex items-end gap-6 text-left'
              style={{ opacity: 1 - scrollOpacity }}
            >
              {/* Poster */}
              {item.poster && (
                <div className='hidden md:block flex-none w-[88px] rounded-lg overflow-hidden shadow-2xl animate-in fade-in duration-700 shrink-0 self-end'>
                  <img
                    src={item.poster}
                    alt={item.title}
                    className='w-full aspect-[2/3] object-cover'
                  />
                </div>
              )}

              <div className='flex flex-col items-start gap-2.5 min-w-0 pb-1'>
                {/* Logo or title */}
                {item.logo ? (
                  <img
                    src={item.logo}
                    alt={item.title}
                    className='max-h-[180px] max-w-[420px] object-contain object-left-bottom drop-shadow-2xl animate-in fade-in duration-700'
                  />
                ) : (
                  <h1 className='text-4xl md:text-5xl font-bold text-white tracking-tight drop-shadow-lg animate-in fade-in duration-700 leading-tight'>
                    {item.title}
                  </h1>
                )}

                {/* Compact metadata + gradient badges */}
                <div className='flex items-center flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-zinc-400 animate-in fade-in duration-700 delay-100'>
                  {heroRating && (
                    <>
                      <span className='flex items-center gap-1 text-white/80 font-medium'>
                        <Star className='w-3 h-3 fill-yellow-400 text-yellow-400' />
                        {heroRating}
                      </span>
                      <span className='text-zinc-700'>·</span>
                    </>
                  )}
                  {item.displayYear && (
                    <>
                      <span>{item.displayYear}</span>
                      <span className='text-zinc-700'>·</span>
                    </>
                  )}
                  <span className='inline-flex items-center rounded-md border border-white/[0.12] bg-white/[0.08] px-2 py-[3px] text-[11px] font-medium text-zinc-300'>
                    {item.type === 'series' ? 'Series' : 'Movie'}
                  </span>
                  {heroDetails?.genres &&
                    heroDetails.genres.length > 0 &&
                    heroDetails.genres.slice(0, 3).map((genre) => (
                      <span
                        key={genre}
                        className='inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-[3px] text-[11px] font-medium text-zinc-400'
                      >
                        {genre}
                      </span>
                    ))}
                </div>

                {/* Description — one line */}
                {item.description && (
                  <p className='text-[12.5px] text-zinc-500 line-clamp-1 max-w-md leading-relaxed animate-in fade-in duration-700 delay-150'>
                    {item.description}
                  </p>
                )}

                {/* Actions — compact */}
                <div className='flex items-center gap-2 animate-in fade-in duration-700 delay-200 pt-0.5'>
                  <Link to={`/details/${detailsRouteType}/${item.id}`} state={{ from }}>
                    <Button
                      size='sm'
                      className='h-8 px-4 text-[12.5px] font-semibold text-white transition-colors rounded-md gap-1.5 border border-white/[0.14] bg-white/[0.12] hover:bg-white/[0.18] hover:border-white/[0.22]'
                    >
                      <Play className='w-3.5 h-3.5 fill-current' />
                      Watch
                    </Button>
                  </Link>
                  <Button
                    size='sm'
                    variant='ghost'
                    className={cn(
                      'h-8 px-3.5 text-[12.5px] font-medium rounded-md transition-all duration-200 gap-1.5 border',
                      isInLibrary
                        ? 'text-green-400 border-green-500/25 bg-green-500/[0.08] hover:bg-green-500/[0.14]'
                        : 'text-zinc-300 border-white/[0.1] bg-white/[0.05] hover:bg-white/[0.09] hover:text-white',
                    )}
                    onClick={() => toggleLibrary.mutate()}
                    disabled={toggleLibrary.isPending}
                  >
                    {isInLibrary ? (
                      <Check className='w-3.5 h-3.5' />
                    ) : (
                      <Plus className='w-3.5 h-3.5' />
                    )}
                    {isInLibrary ? 'Saved' : 'Watchlist'}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <HeroCarouselIndicators
            activeIndex={activeIndex}
            itemKeys={items.map((heroItem) => heroItem.id)}
            itemCount={items.length}
            onSelect={handleSelect}
            scrollOpacity={scrollOpacity}
          />
        </div>
      </div>
    </section>
  );
}
