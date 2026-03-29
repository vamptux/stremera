import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/lib/utils';
import {
  Home,
  Search,
  Calendar,
  User,
  MonitorPlay,
  Download,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDownloads } from '@/hooks/use-downloads';
import { useAppUpdater } from '@/hooks/use-app-updater';

interface SidebarProps {
  className?: string;
  playerMode?: boolean;
}

export function Sidebar({ className, playerMode }: SidebarProps) {
  const location = useLocation();
  const { downloads } = useDownloads();
  const { isUpdateAvailable } = useAppUpdater();

  const activeDownloadsCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'pending' || d.status === 'paused',
  ).length;

  // Primary navigation items
  const navItems = [
    { icon: Home, label: 'Home', href: '/' },
    { icon: Search, label: 'Search', href: '/search' },
    { icon: Calendar, label: 'Calendar', href: '/calendar' },
    { icon: Download, label: 'Downloads', href: '/downloads' },
  ];

  // Bottom action link items
  const bottomNavItems = [
    {
      icon: Settings,
      label: 'Settings',
      href: '/settings',
      isActive: location.pathname === '/settings',
      hasUpdateAccent: isUpdateAvailable,
    },
    {
      icon: User,
      label: 'Profile',
      href: '/profile',
      isActive:
        location.pathname === '/profile' || location.pathname === '/library',
      hasUpdateAccent: false,
    },
  ];

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'w-[60px] h-screen sticky top-0 left-0 flex flex-col items-center py-6 z-50 pointer-events-none transition-all duration-300',
          playerMode && 'bg-gradient-to-r from-black/30 to-transparent backdrop-blur-[2px]',
          className,
        )}
      >
        {/* Logo */}
        <Link to='/' className='mb-8 pointer-events-auto group'>
          <div className='w-10 h-10 rounded-xl bg-white/5 text-white flex items-center justify-center transition-all duration-200 group-hover:bg-white/10'>
            <MonitorPlay className='w-5 h-5' />
          </div>
        </Link>

        {/* Nav Items */}
        <nav className='flex-1 flex flex-col gap-3 w-full px-2 pointer-events-auto'>
          {navItems.map((item) => {
            const isActive =
              item.href === '/'
                ? location.pathname === '/'
                : location.pathname === item.href;
            return (
              <div key={item.label} className='relative w-full flex justify-center'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      variant='ghost'
                      size='icon'
                      className={cn(
                        'w-full h-11 rounded-xl transition-all duration-200 group',
                        isActive
                          ? 'text-white bg-white/12 shadow-[0_0_8px_rgba(255,255,255,0.04)]'
                          : playerMode
                            ? 'text-white/60 hover:text-white hover:bg-white/8'
                            : 'text-white/40 hover:text-white hover:bg-white/8',
                      )}
                    >
                      <Link to={item.href}>
                        <item.icon className={cn(
                          'w-5 h-5 transition-all duration-200',
                          isActive ? 'scale-105 drop-shadow-sm' : ''
                        )} />
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side='right'>{item.label}</TooltipContent>
                </Tooltip>

                {item.label === 'Downloads' && activeDownloadsCount > 0 && (
                  <div className='absolute top-2.5 right-2.5 w-2 h-2 bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.9)] animate-pulse' />
                )}
              </div>
            );
          })}
        </nav>

        {/* Bottom Actions */}
        <div className='flex flex-col gap-3 mt-auto w-full px-2 pb-4 pointer-events-auto'>
          {/* Settings & Profile links */}
          {bottomNavItems.map((item) => (
            <Tooltip key={item.label}>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant='ghost'
                  size='icon'
                  className={cn(
                    'relative w-full h-11 rounded-xl transition-all duration-200 group overflow-hidden',
                    item.isActive
                      ? item.hasUpdateAccent
                        ? 'text-white bg-[linear-gradient(180deg,rgba(16,185,129,0.22),rgba(255,255,255,0.1))] shadow-[0_0_14px_rgba(16,185,129,0.12)]'
                        : 'text-white bg-white/12 shadow-[0_0_8px_rgba(255,255,255,0.04)]'
                      : item.hasUpdateAccent
                        ? 'text-emerald-100 bg-[linear-gradient(180deg,rgba(16,185,129,0.16),rgba(255,255,255,0.04))] shadow-[0_0_12px_rgba(16,185,129,0.12)] hover:bg-[linear-gradient(180deg,rgba(16,185,129,0.22),rgba(255,255,255,0.08))]'
                      : playerMode
                        ? 'text-white/60 hover:text-white hover:bg-white/8'
                        : 'text-white/40 hover:text-white hover:bg-white/8',
                  )}
                >
                  <Link to={item.href}>
                    <item.icon className={cn(
                      'w-5 h-5 transition-all duration-200',
                      item.isActive ? 'scale-105 drop-shadow-sm' : ''
                    )} />
                    {item.hasUpdateAccent && (
                      <span className='absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.9)]' />
                    )}
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side='right'>{item.label}</TooltipContent>
            </Tooltip>
          ))}

        </div>
      </div>
    </TooltipProvider>
  );
}
