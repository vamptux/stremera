import { useState, useEffect, useCallback, useRef } from 'react';
import { MediaRow } from '@/components/media-row';
import { Hero } from '@/components/hero';
import { ResumeSection } from '@/components/resume-section';
import { api } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePrivacy } from '@/contexts/privacy-context';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { Button } from '@/components/ui/button';
import { WifiOff, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// Secondary rows are deferred to avoid blocking hero + primary content
const SECONDARY_ROW_DELAY_MS = 600;
const ROW_STALE_TIME_MS = 1000 * 60 * 10;

const SECONDARY_ROW_PREFETCHES = [
  { key: ['trending', 'series'], fn: () => api.getTrendingSeries() },
  { key: ['netflix', 'movies'], fn: () => api.getNetflixCatalog('nfx', 'movie') },
  { key: ['disney', 'movies'], fn: () => api.getNetflixCatalog('dnp', 'movie') },
  { key: ['kitsu', 'trending'], fn: () => api.getKitsuCatalog('kitsu-anime-trending') },
] as const;

export function Home() {
  const isOnline = useOnlineStatus();
  const navigate = useNavigate();
  const { isIncognito } = usePrivacy();
  const queryClient = useQueryClient();
  const [showSecondaryRows, setShowSecondaryRows] = useState(false);
  const secondaryRowsFiredRef = useRef(false);

  // Show secondary rows once — race between hero's first-image onLoad and
  // the 600ms hard fallback so fast cache hits unlock rows immediately.
  const triggerSecondaryRows = useCallback(() => {
    if (secondaryRowsFiredRef.current) return;
    secondaryRowsFiredRef.current = true;
    setShowSecondaryRows(true);
  }, []);

  // Primary: trending movies (shared with Hero — no duplicate fetch)
  const { data: trendingMovies } = useQuery({
    queryKey: ['trending', 'movies'],
    queryFn: () => api.getTrendingMovies(),
    staleTime: ROW_STALE_TIME_MS,
    enabled: isOnline,
  });

  // Fallback: show secondary rows after 600ms if hero image hasn't loaded yet.
  // The hero's onFirstImageLoaded prop can fire this earlier on fast connections.
  useEffect(() => {
    const timer = setTimeout(triggerSecondaryRows, SECONDARY_ROW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [triggerSecondaryRows]);

  // Prefetch secondary rows during the deferred window so data is ready
  useEffect(() => {
    if (!showSecondaryRows || !isOnline) return;
    SECONDARY_ROW_PREFETCHES.forEach(({ key, fn }) => {
      queryClient.prefetchQuery({ queryKey: [...key], queryFn: fn, staleTime: ROW_STALE_TIME_MS });
    });
  }, [showSecondaryRows, queryClient, isOnline]);

  if (!isOnline) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[80vh] space-y-6 text-center animate-in fade-in duration-500'>
        <div className='rounded-full bg-zinc-800/50 p-6'>
            <WifiOff className='h-12 w-12 text-zinc-500' />
        </div>
        <div className='space-y-2'>
            <h1 className='text-2xl font-bold text-white'>You are offline</h1>
            <p className='text-muted-foreground max-w-sm mx-auto'>
                Connect to the internet to browse movies and series. 
                You can still watch your downloaded content.
            </p>
        </div>
        <Button onClick={() => navigate('/downloads')} size='lg' className='gap-2'>
            <Download className='h-5 w-5' /> Go to Downloads
        </Button>
      </div>
    );
  }

  return (
    <div className='flex flex-col min-h-screen pb-20 relative'>
      {/* Background Ambience */}
      <div className='fixed inset-0 pointer-events-none z-0 overflow-hidden'>
        <div className='absolute top-[-15%] left-[-15%] w-[60%] h-[55%] bg-zinc-800/[0.07] blur-[120px] rounded-full' />
        <div className='absolute bottom-[-15%] right-[-15%] w-[60%] h-[55%] bg-zinc-800/[0.07] blur-[120px] rounded-full' />
      </div>

      <Hero items={(trendingMovies || []).slice(0, 5)} onFirstImageLoaded={triggerSecondaryRows} />

      <div className='mt-0 relative z-10 space-y-8'>
        {!isIncognito && <ResumeSection />}

        {/* Primary row — loads immediately */}
        <MediaRow
          title='Trending Movies'
          queryKey={['trending', 'movies']}
          queryFn={() => api.getTrendingMovies()}
          className='animate-in fade-in slide-in-from-bottom-6 duration-500'
          style={{ animationDelay: '100ms', animationFillMode: 'both' }}
        />

        {/* Secondary rows — deferred for faster first paint */}
        {showSecondaryRows && (
          <>
            <MediaRow
              title='Trending Series'
              queryKey={['trending', 'series']}
              queryFn={() => api.getTrendingSeries()}
              className='animate-in fade-in slide-in-from-bottom-6 duration-500'
              style={{ animationDelay: '0ms', animationFillMode: 'both' }}
            />
            <MediaRow
              title='Netflix Movies'
              queryKey={['netflix', 'movies']}
              queryFn={() => api.getNetflixCatalog('nfx', 'movie')}
              className='animate-in fade-in slide-in-from-bottom-6 duration-500'
              style={{ animationDelay: '80ms', animationFillMode: 'both' }}
            />
            <MediaRow
              title='Disney+ Movies'
              queryKey={['disney', 'movies']}
              queryFn={() => api.getNetflixCatalog('dnp', 'movie')}
              className='animate-in fade-in slide-in-from-bottom-6 duration-500'
              style={{ animationDelay: '160ms', animationFillMode: 'both' }}
            />
            <MediaRow
              title='Trending Anime'
              queryKey={['kitsu', 'trending']}
              queryFn={() => api.getKitsuCatalog('kitsu-anime-trending')}
              className='animate-in fade-in slide-in-from-bottom-6 duration-500'
              style={{ animationDelay: '240ms', animationFillMode: 'both' }}
            />
          </>
        )}
      </div>
    </div>
  );
}
