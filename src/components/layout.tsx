import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { DesktopTitlebar } from './desktop-titlebar';

export function Layout() {
  const location = useLocation();

  return (
    <>
      <DesktopTitlebar />
      <div className='fixed inset-0 bg-black -z-10' />
      <div className='relative min-h-screen text-foreground font-sans antialiased selection:bg-white/20 selection:text-white'>
        <Sidebar className='fixed left-0 top-0 z-50 hidden md:flex' />
        <div className='relative flex min-h-[calc(100vh-2rem)] min-w-0 flex-col pt-8 overflow-x-clip'>
          <main className='flex-1'>
            <div key={location.pathname} className='min-h-full animate-in fade-in duration-150 ease-out'>
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
