import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { AnimatePresence, motion } from 'framer-motion';

export function Layout() {
  const location = useLocation();

  return (
    <>
      <div className='fixed inset-0 bg-black -z-10' />
      <div className='relative min-h-screen bg-black text-foreground font-sans antialiased selection:bg-white/20 selection:text-white'>
        <Sidebar className='hidden md:flex fixed left-0 top-0 z-50' />
        <div className='flex min-h-screen flex-col min-w-0 relative'>
          <header className='fixed top-0 z-40 w-full transition-all duration-200 bg-transparent pointer-events-none'>
            <div className='absolute inset-0 bg-gradient-to-b from-black/80 to-transparent pointer-events-none' />
          </header>

          <main className='flex-1 overflow-x-hidden'>
            <AnimatePresence mode='wait' initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className='min-h-full'
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </>
  );
}
