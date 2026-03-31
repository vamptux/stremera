import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/lib/utils';
import {
  type LucideIcon,
  Calendar,
  Download,
  Home,
  Search,
  Settings,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDownloads } from '@/hooks/use-downloads';
import { useAppUpdater } from '@/hooks/use-app-updater';

interface SidebarProps {
  className?: string;
  playerMode?: boolean;
}

interface SidebarNavItem {
  href: string;
  icon: LucideIcon;
  label: string;
  matches: (pathname: string) => boolean;
}

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  {
    icon: Home,
    label: 'Home',
    href: '/',
    matches: (pathname) => pathname === '/',
  },
  {
    icon: Search,
    label: 'Search',
    href: '/search',
    matches: (pathname) => pathname === '/search',
  },
  {
    icon: Calendar,
    label: 'Calendar',
    href: '/calendar',
    matches: (pathname) => pathname === '/calendar',
  },
  {
    icon: Download,
    label: 'Downloads',
    href: '/downloads',
    matches: (pathname) => pathname === '/downloads',
  },
];

const SECONDARY_NAV_ITEMS: SidebarNavItem[] = [
  {
    icon: Settings,
    label: 'Settings',
    href: '/settings',
    matches: (pathname) => pathname === '/settings',
  },
  {
    icon: User,
    label: 'Profile',
    href: '/profile',
    matches: (pathname) => pathname === '/profile' || pathname === '/library',
  },
];

export function Sidebar({ className, playerMode }: SidebarProps) {
  const location = useLocation();
  const { downloads } = useDownloads();
  const { isUpdateAvailable } = useAppUpdater();

  const activeDownloadsCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'pending' || d.status === 'paused',
  ).length;

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'w-[60px] h-screen shrink-0 flex flex-col items-center pt-8 pb-4 z-50 pointer-events-none transition-colors duration-300',
          playerMode && 'backdrop-blur-[2px]',
          className,
        )}
      >
        {!playerMode && (
          <div className='w-full px-2 pb-5 pointer-events-auto'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to='/'
                  aria-label='Open Stremera home'
                  className={cn(
                    'group flex h-10 w-full items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] transition-all duration-200',
                    'hover:border-white/[0.12] hover:bg-white/[0.06]',
                  )}
                >
                  <img
                    src='/logo.ico'
                    alt=''
                    aria-hidden='true'
                    loading='eager'
                    decoding='async'
                    className='h-6 w-6'
                  />
                </Link>
              </TooltipTrigger>
              <TooltipContent side='right'>Stremera</TooltipContent>
            </Tooltip>
          </div>
        )}

        {playerMode && (
          <div className='w-full px-2 pb-5 pointer-events-auto'>
            <div className='flex h-10 w-full items-center justify-center'>
              <img
                src='/logo.ico'
                alt=''
                aria-hidden='true'
                loading='eager'
                decoding='async'
                className='h-5 w-5 opacity-50'
              />
            </div>
          </div>
        )}

        <nav className='flex-1 flex flex-col gap-3 w-full px-2 pointer-events-auto'>
          {PRIMARY_NAV_ITEMS.map((item) => (
            <SidebarNavButton
              key={item.label}
              item={item}
              isActive={item.matches(location.pathname)}
              playerMode={playerMode}
              indicator={
                item.label === 'Downloads' && activeDownloadsCount > 0 ? (
                  <div className='absolute top-2.5 right-2.5 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)] animate-pulse' />
                ) : undefined
              }
            />
          ))}
        </nav>

        <div className='flex flex-col gap-3 mt-auto w-full px-2 pb-4 pointer-events-auto'>
          {SECONDARY_NAV_ITEMS.map((item) => (
            <SidebarNavButton
              key={item.label}
              item={item}
              isActive={item.matches(location.pathname)}
              playerMode={playerMode}
              hasUpdateAccent={item.label === 'Settings' && isUpdateAvailable}
              indicator={
                item.label === 'Settings' && isUpdateAvailable ? (
                  <span className='absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.9)]' />
                ) : undefined
              }
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

interface SidebarNavButtonProps {
  hasUpdateAccent?: boolean;
  indicator?: React.ReactNode;
  isActive: boolean;
  item: SidebarNavItem;
  playerMode?: boolean;
}

function SidebarNavButton({
  hasUpdateAccent,
  indicator,
  isActive,
  item,
  playerMode,
}: SidebarNavButtonProps) {
  return (
    <div className='relative flex w-full justify-center'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant='ghost'
            size='icon'
            className={cn(
              'relative h-10 w-full overflow-hidden rounded-lg transition-colors duration-150 group',
              isActive
                ? 'bg-white text-black shadow-sm'
                : hasUpdateAccent
                  ? 'bg-[linear-gradient(180deg,rgba(16,185,129,0.12),rgba(255,255,255,0.02))] text-emerald-200/80 hover:bg-[linear-gradient(180deg,rgba(16,185,129,0.18),rgba(255,255,255,0.05))]'
                  : playerMode
                    ? 'text-white/60 hover:bg-white/[0.08] hover:text-white/90'
                    : 'text-white/50 hover:bg-white/[0.08] hover:text-white/90',
            )}
          >
            <Link to={item.href} aria-label={item.label}>
              <item.icon className='h-5 w-5' />
              {indicator}
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side='right'>{item.label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
