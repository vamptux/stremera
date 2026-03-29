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
  const heroGenres = heroDetails?.genres?.length
    ? heroDetails.genres.slice(0, 3).join(' • ')
    : null;

  const { data: library } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
    staleTime: 1000 * 60 * 5,
  });

  const isInLibrary = item && library?.some((l) => l.id === item.id);

  const toggleLibrary = useMutation({
    mutationFn: async () => {
      if (!item) return;
      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return "removed";
      } else {
        await api.addToLibrary(item);
        return "added";
      }
    },
    onSuccess: (action) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      if (item) {
        toast.success(action === "added" ? "Added to Library" : "Removed from Library", {
            description: item.title,
        });
      }
    },
    onError: () => {
      toast.error("Failed to update library");
    }
  });

  if (!item) {
    return (
      <div className="w-full h-[55vh] bg-zinc-900/20 animate-pulse relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent" />
      </div>
    );
  }

  const backdropUrl = item.backdrop || item.poster;

  return (
    <div
      className="relative w-full h-[60vh] min-h-[400px] max-h-[700px] overflow-hidden group"
      onMouseEnter={() => setIsPausedByHover(true)}
      onMouseLeave={() => setIsPausedByHover(false)}
    >
      
      {/* Scroll Dimming & Blur Overlay */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm pointer-events-none transition-opacity duration-300 ease-out z-[5]"
        style={{ opacity: scrollOpacity }}
      />

      {/* Background Image - with smooth transition and mask for seamless blending */}
      <div 
        className={cn("absolute inset-0 transition-opacity duration-500 ease-in-out", isTransitioning ? "opacity-0" : "opacity-100")}
        style={{ maskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)' }}
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
                <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-l from-transparent via-transparent to-black/10" />
             </>
          )}
      </div>

      {/* Content */}
      <div className={cn("absolute inset-0 flex items-end justify-start transition-all duration-500 ease-in-out pb-16 pl-6 md:pl-24 lg:pl-28", isTransitioning ? "opacity-0 translate-y-4" : "opacity-100 translate-y-0")}>
        <div 
          className="max-w-4xl w-full flex flex-col items-start text-left space-y-4"
          style={{ opacity: 1 - scrollOpacity }}
        >
            
            {/* Logo or Title */}
            <div className="mb-2">
                {item.logo ? (
                    <img 
                        src={item.logo} 
                        alt={item.title} 
                        className="max-h-[140px] object-contain object-left-bottom drop-shadow-2xl animate-in fade-in slide-in-from-left-4 duration-700"
                    />
                ) : (
                    <h1 className="text-5xl md:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-white/60 tracking-tighter drop-shadow-2xl leading-[0.9] animate-in fade-in slide-in-from-bottom-6 duration-700">
                        {item.title}
                    </h1>
                )}
            </div>

            {/* Metadata Badge Row */}
            <div className="flex items-center justify-start gap-4 text-[14px] font-medium text-white/80 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
                {heroRating && (
                    <span className="flex items-center gap-1.5 font-semibold text-white/90">
                        <Star className="w-4 h-4 fill-primary text-primary" />
                        {heroRating}
                    </span>
                )}
                {heroRating && <span className="w-1 h-1 rounded-full bg-white/20" />}
                <span className="text-white/80">{item.year?.split('-')[0] || "2024"}</span>
                <span className="w-1 h-1 rounded-full bg-white/20" />
                <span className={cn(
                    "inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded border",
                    item.type === 'series'
                      ? "bg-sky-500/[0.08] text-sky-300/80 border-sky-500/[0.15]"
                      : "bg-amber-500/[0.08] text-amber-300/80 border-amber-500/[0.15]"
                )}>
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", item.type === 'series' ? 'bg-sky-400' : 'bg-amber-400')} />
                    {item.type === 'series' ? 'TV Series' : 'Movie'}
                </span>
                {heroGenres && (
                   <>
                    <span className="w-1 h-1 rounded-full bg-white/20 hidden md:block" />
                    <span className="hidden md:block text-white/70">{heroGenres}</span> 
                   </>
                )}
            </div>

            {/* Description (Short) */}
            <p className="text-white/70 text-[14px] md:text-base line-clamp-2 max-w-xl font-normal leading-relaxed animate-in fade-in slide-in-from-bottom-8 duration-700 delay-200 text-left">
                {item.description || "Experience this title in stunning quality. Stream instantly with no waiting."}
            </p>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-6 animate-in fade-in slide-in-from-bottom-10 duration-700 delay-300">
                <Link to={`/details/${item.type}/${item.id}`} state={{ from }}>
                    <Button size="lg" className="h-12 px-8 text-[15px] font-semibold bg-white hover:bg-zinc-200 text-black transition-colors rounded-md shadow border border-transparent hover:border-zinc-800 transition-colors">
                        <Play className="w-5 h-5 mr-2 fill-current" />
                        Watch Now
                    </Button>
                </Link>
                <Button
                    size="lg"
                    variant="secondary"
                    className={cn(
                        "h-12 px-8 backdrop-blur-md border border-white/[0.08] transition-all duration-300 rounded-md shadow-sm text-[15px] font-semibold",
                        isInLibrary 
                            ? "bg-green-500/10 text-green-400 hover:bg-green-500/15 border-green-500/20" 
                            : "bg-zinc-950/50 hover:bg-white/5 hover:border-white/10 text-white/90 hover:text-white"
                    )}
                    onClick={() => toggleLibrary.mutate()}
                    disabled={toggleLibrary.isPending}
                >
                    {isInLibrary ? (
                        <>
                            <Check className="w-4 h-4 mr-2" />
                            In Library
                        </>
                    ) : (
                        <>
                            <Plus className="w-4 h-4 mr-2" />
                            Add to Library
                        </>
                    )}
                </Button>
            </div>
        </div>
      </div>

      {/* Carousel Indicators */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2 z-20">
        {items.map((_, idx) => (
            <button 
                key={idx}
                type="button"
                aria-label={`Go to slide ${idx + 1}`}
                onClick={() => handleSelect(idx)}
                className={cn(
                    "h-1 rounded-full transition-all duration-300",
              idx === activeIndex ? "w-6 bg-white" : "w-1.5 bg-white/25 hover:bg-white/60"
                )}
            />
        ))}
      </div>
    </div>
  );
}
