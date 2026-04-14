import { useQuery } from '@tanstack/react-query';
import { Download, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hero } from '@/components/hero';
import { MediaRow } from '@/components/media-row';
import { ResumeSection } from '@/components/resume-section';
import { Button } from '@/components/ui/button';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api } from '@/lib/api';

const HERO_DELAY_MS = 600;
const ROW_STALE_TIME_MS = 1000 * 60 * 10;

const GENRES = [
  'All',
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Thriller',
] as const;

type Genre = (typeof GENRES)[number];

export function Home() {
  const isOnline = useOnlineStatus();
  const navigate = useNavigate();
  const [heroReady, setHeroReady] = useState(false);
  const [genre, setGenre] = useState<Genre>('All');
  const heroFiredRef = useRef(false);

  const triggerHeroReady = useCallback(() => {
    if (heroFiredRef.current) return;
    heroFiredRef.current = true;
    setHeroReady(true);
  }, []);

  const { data: heroItems } = useQuery({
    queryKey: ['trending', 'movies'],
    queryFn: () => api.getTrendingMovies(),
    staleTime: ROW_STALE_TIME_MS,
    enabled: isOnline,
  });

  useEffect(() => {
    const t = setTimeout(triggerHeroReady, HERO_DELAY_MS);
    return () => clearTimeout(t);
  }, [triggerHeroReady]);

  if (!isOnline) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[80vh] space-y-6 text-center animate-in fade-in duration-500'>
        <div className='rounded-full bg-zinc-800/50 p-6'>
          <WifiOff className='h-12 w-12 text-zinc-500' />
        </div>
        <div className='space-y-2'>
          <h1 className='text-2xl font-bold text-white'>You are offline</h1>
          <p className='text-muted-foreground max-w-sm mx-auto'>
            Connect to the internet to browse content. Your downloaded titles are still available.
          </p>
        </div>
        <Button onClick={() => navigate('/downloads')} size='lg' className='gap-2'>
          <Download className='h-5 w-5' /> Go to Downloads
        </Button>
      </div>
    );
  }

  const activeGenre = genre === 'All' ? undefined : genre;

  return (
    <div className='flex flex-col min-h-screen pb-20 relative'>
      <Hero items={(heroItems ?? []).slice(0, 5)} onFirstImageLoaded={triggerHeroReady} />

      <div className='relative z-10 space-y-1'>
        <ResumeSection />

        {heroReady && (
          <MediaRow
            title='Trending'
            queryKey={['trending', 'movies', genre]}
            queryFn={() => api.getTrendingMovies(activeGenre)}
            genreFilter={{
              options: GENRES,
              active: genre,
              onChange: (g) => setGenre(g as Genre),
            }}
            className='animate-in fade-in slide-in-from-bottom-4 duration-500'
            style={{ animationFillMode: 'both' }}
          />
        )}
      </div>
    </div>
  );
}
