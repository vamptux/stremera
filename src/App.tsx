import { Loader2 } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef } from 'react';
import { Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { DownloadProvider } from '@/contexts/download-context';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { getErrorMessage } from '@/lib/api';
import { Layout } from './components/layout';
import { Home } from './pages/home';

const Search = lazy(() => import('./pages/search').then((module) => ({ default: module.Search })));
const Details = lazy(() =>
  import('./pages/details').then((module) => ({ default: module.Details })),
);
const Settings = lazy(() =>
  import('./pages/settings/index').then((module) => ({ default: module.Settings })),
);
const Profile = lazy(() =>
  import('./pages/profile').then((module) => ({ default: module.Profile })),
);
const Calendar = lazy(() =>
  import('./pages/calendar').then((module) => ({ default: module.Calendar })),
);
const Downloads = lazy(() =>
  import('./pages/downloads').then((module) => ({ default: module.Downloads })),
);
const Player = lazy(() => import('./pages/player').then((m) => ({ default: m.Player })));
const UPDATE_TOAST_ID = 'app-update-toast';

function FullScreenRouteLoader() {
  return (
    <div className='h-screen w-screen bg-black flex items-center justify-center'>
      <Loader2 className='h-8 w-8 animate-spin text-white/50' />
    </div>
  );
}

function ContentRouteLoader() {
  return (
    <div className='flex min-h-[60vh] w-full items-center justify-center'>
      <Loader2 className='h-7 w-7 animate-spin text-white/35' />
    </div>
  );
}

function RouteSuspense({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>;
}

function AppUpdateManager() {
  const didCheckRef = useRef(false);
  const {
    checkForUpdates,
    installUpdate,
    isLastNotifiedVersionReady,
    isSupported,
    lastNotifiedVersion,
    markUpdateNotified,
  } = useAppUpdater();

  useEffect(() => {
    if (import.meta.env.DEV || didCheckRef.current || !isSupported || !isLastNotifiedVersionReady) {
      return;
    }

    didCheckRef.current = true;

    void (async () => {
      try {
        const update = await checkForUpdates();
        if (!update) return;

        if (lastNotifiedVersion === update.version) {
          return;
        }

        await markUpdateNotified(update.version).catch(() => undefined);

        toast.info(`Update ${update.version} is ready`, {
          description:
            update.body?.trim() ||
            'A signed desktop update is available. Install to restart into the latest version.',
          duration: 15000,
          action: {
            label: 'Install',
            onClick: () => {
              toast.loading('Downloading update…', { id: UPDATE_TOAST_ID });
              void installUpdate(update, (status) => {
                toast.loading(status, { id: UPDATE_TOAST_ID });
              }).catch((error) => {
                toast.error('Failed to install update', {
                  id: UPDATE_TOAST_ID,
                  description: getErrorMessage(error),
                });
              });
            },
          },
        });
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Automatic update check failed:', error);
        }
      }
    })();
  }, [
    checkForUpdates,
    installUpdate,
    isLastNotifiedVersionReady,
    isSupported,
    lastNotifiedVersion,
    markUpdateNotified,
  ]);

  return null;
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
            <Route
              path='/search'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Search />
                </RouteSuspense>
              }
            />
            <Route
              path='/details/:type/:id'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Details />
                </RouteSuspense>
              }
            />
            <Route
              path='/settings'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Settings />
                </RouteSuspense>
              }
            />
            <Route
              path='/profile'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Profile />
                </RouteSuspense>
              }
            />
            <Route
              path='/library'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Profile />
                </RouteSuspense>
              }
            />
            <Route
              path='/downloads'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Downloads />
                </RouteSuspense>
              }
            />
            <Route
              path='/calendar'
              element={
                <RouteSuspense fallback={<ContentRouteLoader />}>
                  <Calendar />
                </RouteSuspense>
              }
            />
          </Route>
          <Route
            path='/player/:type/:id'
            element={
              <RouteSuspense fallback={<FullScreenRouteLoader />}>
                <Player />
              </RouteSuspense>
            }
          />
          <Route
            path='/player/:type/:id/:season/:episode'
            element={
              <RouteSuspense fallback={<FullScreenRouteLoader />}>
                <Player />
              </RouteSuspense>
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
