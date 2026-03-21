import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/lib/utils';
import {
  Home,
  Search,
  Calendar,
  User,
  MonitorPlay,
  VenetianMask,
  Download,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { usePrivacy } from '@/contexts/privacy-context';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useDownloads } from '@/hooks/use-downloads';
import { clearIncognitoClientState } from '@/lib/privacy-utils';

interface SidebarProps {
  className?: string;
  playerMode?: boolean;
}

export function Sidebar({ className, playerMode }: SidebarProps) {
  const location = useLocation();
  const { isIncognito, toggleIncognito } = usePrivacy();
  const queryClient = useQueryClient();
  const { downloads } = useDownloads();

  const activeDownloadsCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'pending' || d.status === 'paused',
  ).length;

  const handleIncognitoToggle = () => {
    const nextEnabled = !isIncognito;
    toggleIncognito();

    if (nextEnabled) {
      clearIncognitoClientState(queryClient);
    }

    toast.success(nextEnabled ? 'Private mode enabled' : 'Private mode disabled');
  };

  // Primary navigation items
  const navItems = [
    { icon: Home, label: 'Home', href: '/' },
    { icon: Search, label: 'Search', href: '/search' },
    { icon: Calendar, label: 'Calendar', href: '/calendar' },
    { icon: Download, label: 'Downloads', href: '/downloads' },
  ];

  // Bottom action link items — rendered top-to-bottom: Privacy → Settings → Profile
  const bottomNavItems = [
    {
      icon: Settings,
      label: 'Settings',
      href: '/settings',
      isActive: location.pathname === '/settings',
    },
    {
      icon: User,
      label: 'Profile',
      href: '/profile',
      isActive:
        location.pathname === '/profile' || location.pathname === '/library',
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
          <div className='w-10 h-10 rounded-xl bg-white/5 text-white flex items-center justify-center transition-all duration-300 group-hover:bg-white/15 group-hover:shadow-[0_0_15px_rgba(255,255,255,0.1)] group-hover:scale-105'>
            <MonitorPlay className='w-5 h-5 transition-transform duration-300 group-hover:scale-110' />
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
                        'w-full h-11 rounded-xl transition-all duration-300 group',
                        isActive
                          ? 'text-white bg-white/15 shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                          : playerMode
                            ? 'text-white/60 hover:text-white hover:bg-white/10'
                            : 'text-white/40 hover:text-white hover:bg-white/10',
                      )}
                    >
                      <Link to={item.href}>
                        <item.icon className={cn(
                          'w-5 h-5 transition-all duration-300',
                          isActive ? 'scale-110 drop-shadow-md' : 'group-hover:scale-110 group-hover:drop-shadow-sm'
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
          {/* Privacy Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                onClick={handleIncognitoToggle}
                className={cn(
                  'w-full h-11 rounded-xl transition-all duration-300 group',
                  isIncognito
                    ? 'text-white bg-white/15 shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                    : playerMode
                      ? 'text-white/60 hover:text-white hover:bg-white/10'
                      : 'text-white/40 hover:text-white hover:bg-white/10',
                )}
                aria-pressed={isIncognito}
                aria-label={isIncognito ? 'Disable private mode' : 'Enable private mode'}
              >
                <VenetianMask className={cn(
                  'w-5 h-5 transition-all duration-300',
                  isIncognito ? 'scale-110 drop-shadow-md' : 'group-hover:scale-110 group-hover:drop-shadow-sm'
                )} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='right'>
              {isIncognito ? 'Disable Incognito' : 'Enable Incognito'}
            </TooltipContent>
          </Tooltip>

          {/* Settings & Profile links */}
          {bottomNavItems.map((item) => (
            <Tooltip key={item.label}>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant='ghost'
                  size='icon'
                  className={cn(
                    'w-full h-11 rounded-xl transition-all duration-300 group',
                    item.isActive
                      ? 'text-white bg-white/15 shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                      : playerMode
                        ? 'text-white/60 hover:text-white hover:bg-white/10'
                        : 'text-white/40 hover:text-white hover:bg-white/10',
                  )}
                >
                  <Link to={item.href}>
                    <item.icon className={cn(
                      'w-5 h-5 transition-all duration-300',
                      item.isActive ? 'scale-110 drop-shadow-md' : 'group-hover:scale-110 group-hover:drop-shadow-sm'
                    )} />
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
