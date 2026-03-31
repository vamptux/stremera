import { Button } from "@/components/ui/button";
import { Play, Plus, Check, Star } from "lucide-react";
import { MediaItem, api } from "@/lib/api";
import { Link, useLocation } from "react-router-dom";
import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface HeroProps {
  items: MediaItem[];
  /** Called once when the first backdrop image finishes loading (used to
   * trigger deferred secondary rows earlier than the fallback timeout). */
  onFirstImageLoaded?: () => void;
}

export function Hero({ items, onFirstImageLoaded }: HeroProps) {
  const location = useLocation();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [scrollOpacity, setScrollOpacity] = useState(0);
  const [isPausedByHover, setIsPausedByHover] = useState(false);
  const queryClient = useQueryClient();
  const from = `${location.pathname}${location.search}`;
  const firstImageFiredRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const transitionTimeoutRef = useRef<number | null>(null);

  const clearTransitionTimeout = useCallback(() => {
    if (transitionTimeoutRef.current === null) return;
    window.clearTimeout(transitionTimeoutRef.current);
    transitionTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        const scrollY = window.scrollY;
        const newOpacity = Math.min(scrollY / 600, 0.9); // Slower dimming, higher max opacity
        setScrollOpacity((prev) => (Math.abs(prev - newOpacity) < 0.01 ? prev : newOpacity));
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
    return () => {
      clearTransitionTimeout();
    };
  }, [clearTransitionTimeout]);

  const activeIndex = items.length > 0 ? currentIndex % items.length : 0;

  const queueSlideTransition = useCallback((nextIndex: number) => {
    clearTransitionTimeout();
    setIsTransitioning(true);
    transitionTimeoutRef.current = window.setTimeout(() => {
      setCurrentIndex(nextIndex);
      setIsTransitioning(false);
      transitionTimeoutRef.current = null;
    }, 300);
  }, [clearTransitionTimeout]);

  const handleNext = useCallback(() => {
    if (isTransitioning || items.length <= 1) return;
    queueSlideTransition((activeIndex + 1) % items.length);
  }, [activeIndex, isTransitioning, items.length, queueSlideTransition]);

  const handleSelect = useCallback((index: number) => {
    if (isTransitioning || index === activeIndex) return;
    queueSlideTransition(index);
  }, [activeIndex, isTransitioning, queueSlideTransition]);

  // Auto-rotate every 10 seconds
  useEffect(() => {
    if (items.length <= 1 || isPausedByHover) return;
    
    const interval = setInterval(() => {
      handleNext();
    }, 10000);
    
    return () => clearInterval(interval);
  }, [items.length, handleNext, isPausedByHover]);

  const item = items[activeIndex];

  const { data: heroDetails } = useQuery({
    queryKey: ['details', item?.type, item?.id],
    queryFn: () => api.getMediaDetails(item!.type, item!.id),
    enabled: !!item,
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (!items.length) return;
    // Prefetch adjacent slides for smooth transitions
    const next = items[(activeIndex + 1) % items.length];
    const prev = items[(activeIndex - 1 + items.length) % items.length];
    [next, prev].forEach((prefetchItem) => {
      if (prefetchItem) {
        const queryKey = ['details', prefetchItem.type, prefetchItem.id];
        if (queryClient.getQueryData(queryKey)) {
          return;
        }

        void queryClient.prefetchQuery({
          queryKey,
          queryFn: () => api.getMediaDetails(prefetchItem.type, prefetchItem.id),
          staleTime: 1000 * 60 * 30,
        });
      }
    });
  }, [activeIndex, items, queryClient]);


  const heroRating = heroDetails?.rating ?? null;

  const { data: library } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
    staleTime: 1000 * 60 * 5,
  });

  const isInLibrary = item && library?.some((libraryItem) => libraryItem.id === item.id);

  const toggleLibrary = useMutation({
    mutationFn: async () => {
      if (!item) return;
      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return 'removed';
      }

      await api.addToLibrary(item);
      return 'added';
    },
    onSuccess: (action) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      if (item) {
        toast.success(action === 'added' ? 'Added to Library' : 'Removed from Library', {
          description: item.title,
        });
      }
    },
    onError: () => {
      toast.error('Failed to update library');
    },
  });

  if (!item) {
    return (
      <div className="w-full h-[60vh] min-h-[420px] max-h-[680px] -mt-8 bg-zinc-950 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
      </div>
    );
  }

  const backdropUrl = item.backdrop || item.poster;

  return (
    <div
      className="relative w-full h-[60vh] min-h-[420px] max-h-[680px] -mt-8 overflow-hidden group"
      onMouseEnter={() => setIsPausedByHover(true)}
      onMouseLeave={() => setIsPausedByHover(false)}
    >
      
      {/* Scroll Dimming & Blur Overlay */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] pointer-events-none transition-opacity duration-300 ease-out z-[5]"
        style={{ opacity: scrollOpacity }}
      />

      {/* Background Image - with smooth transition and mask for seamless blending */}
      <div 
        className={cn("absolute inset-0 transition-opacity duration-500 ease-in-out", isTransitioning ? "opacity-0" : "opacity-100")}
      >
          {backdropUrl && (
             <>
                <img
                    src={backdropUrl}
                    alt={item.title}
                    className="w-full h-full object-cover object-top"
                    onLoad={() => {
                      if (!firstImageFiredRef.current) {
                        firstImageFiredRef.current = true;
                        onFirstImageLoaded?.();
                      }
                    }}
                />
                <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/25 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/35 to-transparent" />
             </>
          )}
      </div>

      {/* Visible area wrapper — content offset past sidebar, image bleeds behind it */}
      <div className="absolute inset-0">
        <div className="relative w-full h-full">
          {/* Content */}
          <div className={cn("absolute inset-0 flex items-end justify-start transition-all duration-500 ease-in-out pb-16 pl-6 md:pl-[84px] lg:pl-28", isTransitioning ? "opacity-0 translate-y-3" : "opacity-100 translate-y-0")}>
            <div
              className="max-w-5xl w-full flex items-end gap-6 text-left"
              style={{ opacity: 1 - scrollOpacity }}
            >
          {/* Poster */}
          {item.poster && (
            <div className="hidden md:block flex-none w-[88px] rounded-lg overflow-hidden shadow-2xl animate-in fade-in duration-700 shrink-0 self-end">
              <img src={item.poster} alt={item.title} className="w-full aspect-[2/3] object-cover" />
            </div>
          )}

          <div className="flex flex-col items-start gap-2.5 min-w-0 pb-1">
            {/* Logo or title */}
            {item.logo ? (
              <img
                src={item.logo}
                alt={item.title}
                className="max-h-[180px] max-w-[420px] object-contain object-left-bottom drop-shadow-2xl animate-in fade-in duration-700"
              />
            ) : (
              <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight drop-shadow-lg animate-in fade-in duration-700 leading-tight">
                {item.title}
              </h1>
            )}

            {/* Compact metadata + gradient badges */}
            <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-zinc-400 animate-in fade-in duration-700 delay-100">
              {heroRating && (
                <>
                  <span className="flex items-center gap-1 text-white/80 font-medium">
                    <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                    {heroRating}
                  </span>
                  <span className="text-zinc-700">·</span>
                </>
              )}
              {item.year && (
                <>
                  <span>{item.year.split('-')[0]}</span>
                  <span className="text-zinc-700">·</span>
                </>
              )}
              <span className="inline-flex items-center rounded-md border border-white/[0.12] bg-white/[0.08] px-2 py-[3px] text-[11px] font-medium text-zinc-300">
                {item.type === 'series' ? 'Series' : 'Movie'}
              </span>
              {heroDetails?.genres && heroDetails.genres.length > 0 && (
                heroDetails.genres.slice(0, 3).map((genre) => (
                  <span
                    key={genre}
                    className="inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-[3px] text-[11px] font-medium text-zinc-400"
                  >
                    {genre}
                  </span>
                ))
              )}
            </div>

            {/* Description — one line */}
            {item.description && (
              <p className="text-[12.5px] text-zinc-500 line-clamp-1 max-w-md leading-relaxed animate-in fade-in duration-700 delay-150">
                {item.description}
              </p>
            )}

            {/* Actions — compact */}
            <div className="flex items-center gap-2 animate-in fade-in duration-700 delay-200 pt-0.5">
              <Link to={`/details/${item.type}/${item.id}`} state={{ from }}>
                <Button
                  size="sm"
                  className="h-8 px-4 text-[12.5px] font-semibold text-white transition-colors rounded-md gap-1.5 border border-white/[0.14] bg-white/[0.12] hover:bg-white/[0.18] hover:border-white/[0.22]"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Watch
                </Button>
              </Link>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-8 px-3.5 text-[12.5px] font-medium rounded-md transition-all duration-200 gap-1.5 border",
                  isInLibrary
                    ? 'text-green-400 border-green-500/25 bg-green-500/[0.08] hover:bg-green-500/[0.14]'
                    : 'text-zinc-300 border-white/[0.1] bg-white/[0.05] hover:bg-white/[0.09] hover:text-white',
                )}
                onClick={() => toggleLibrary.mutate()}
                disabled={toggleLibrary.isPending}
              >
                {isInLibrary ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {isInLibrary ? 'Saved' : 'Watchlist'}
              </Button>
            </div>
          </div>
        </div>
      </div>

          {/* Carousel Indicators - centered in visible area */}
          <div
            className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-20 rounded-full bg-white/[0.06] backdrop-blur-md px-2.5 py-1.5 border border-white/[0.06] transition-opacity duration-300"
            style={{ opacity: Math.max(0, 1 - scrollOpacity * 2) }}
          >
            {items.map((_, idx) => (
              <button
                key={idx}
                type="button"
                aria-label={`Go to slide ${idx + 1}`}
                onClick={() => handleSelect(idx)}
                className={cn(
                  "rounded-full transition-all duration-500 ease-out",
                  idx === activeIndex
                    ? "w-5 h-[5px] bg-white shadow-[0_0_6px_rgba(255,255,255,0.4)]"
                    : "w-[5px] h-[5px] bg-white/25 hover:bg-white/50"
                )}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
