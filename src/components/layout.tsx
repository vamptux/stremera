import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { AnimatePresence, motion } from 'framer-motion';
import { usePrivacy } from '@/contexts/privacy-context';
import { VenetianMask } from 'lucide-react';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { clearIncognitoClientState } from '@/lib/privacy-utils';

export function Layout() {
  const location = useLocation();
  const { isIncognito, toggleIncognito } = usePrivacy();
  const queryClient = useQueryClient();

  // Global keyboard shortcut: Ctrl/Cmd + Shift + N  →  toggle incognito
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const nextEnabled = !isIncognito;
        toggleIncognito();
        if (nextEnabled) {
          clearIncognitoClientState(queryClient);
        }
        toast.success(nextEnabled ? 'Private mode on' : 'Private mode off');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isIncognito, toggleIncognito, queryClient]);

  return (
    <>
      <div className='fixed inset-0 bg-black -z-10' />
      <div className='relative min-h-screen bg-black text-foreground font-sans antialiased selection:bg-white/20 selection:text-white'>
        <Sidebar className='hidden md:flex fixed left-0 top-0 z-50' />
        <div className='flex min-h-screen flex-col min-w-0 relative'>
          <header className='fixed top-0 z-40 w-full transition-all duration-200 bg-transparent pointer-events-none'>
            <div className='absolute inset-0 bg-gradient-to-b from-black/80 to-transparent pointer-events-none' />

            {isIncognito && (
              <div className='absolute top-4 right-4 md:right-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/80 text-zinc-100 border border-white/10 backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-300 shadow-[0_2px_20px_rgba(0,0,0,0.6)]'>
                {/* Pulsing activity dot */}
                <span className='relative flex h-1.5 w-1.5 flex-shrink-0'>
                  <span className='animate-ping absolute inline-flex h-full w-full rounded-full bg-white/50 opacity-75' />
                  <span className='relative inline-flex rounded-full h-1.5 w-1.5 bg-white/70' />
                </span>
                <VenetianMask className='w-3.5 h-3.5 opacity-80' />
                <span className='text-xs font-medium tracking-wide'>Private</span>
              </div>
            )}
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
