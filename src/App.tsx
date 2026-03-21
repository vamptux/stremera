import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout';
import { Home } from './pages/home';
import { Search } from './pages/search';
import { Details } from './pages/details';
import { Settings } from './pages/settings';
import { Profile } from './pages/profile';
import { Calendar } from './pages/calendar';
import { Downloads } from './pages/downloads';
import { Toaster } from '@/components/ui/sonner';
import { useEffect, Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { DownloadProvider } from '@/contexts/download-context';
import { AppUpdateManager } from '@/components/app-update-manager';

// Lazy load Player to prevent libmpv from loading at startup
const Player = lazy(() => import('./pages/player').then((m) => ({ default: m.Player })));

function PlayerLoader() {
  return (
    <div className='h-screen w-screen bg-black flex items-center justify-center'>
      <Loader2 className='h-8 w-8 animate-spin text-white/50' />
    </div>
  );
}

function App() {
  useEffect(() => {
    // Only suppress context menu in production; keep it available for dev tools
    if (import.meta.env.DEV) return;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return (
    <>
      <DownloadProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path='/' element={<Home />} />
            <Route path='/search' element={<Search />} />
            <Route path='/details/:type/:id' element={<Details />} />
            <Route path='/settings' element={<Settings />} />
            <Route path='/profile' element={<Profile />} />
            <Route path='/library' element={<Profile />} />
            <Route path='/downloads' element={<Downloads />} />
            <Route path='/calendar' element={<Calendar />} />
          </Route>
          <Route
            path='/player/:type/:id'
            element={
              <Suspense fallback={<PlayerLoader />}>
                <Player />
              </Suspense>
            }
          />
          <Route
            path='/player/:type/:id/:season/:episode'
            element={
              <Suspense fallback={<PlayerLoader />}>
                <Player />
              </Suspense>
            }
          />
        </Routes>
      </DownloadProvider>
      <AppUpdateManager />
      <Toaster />
    </>
  );
}

export default App;
