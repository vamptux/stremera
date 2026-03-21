import { ChevronDown, List, X } from 'lucide-react';
import { useMemo } from 'react';
import { type Episode } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface PlayerEpisodesToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function PlayerEpisodesToggleButton({
  open,
  onToggle,
}: PlayerEpisodesToggleButtonProps) {
  return (
    <Button
      variant='ghost'
      size='icon'
      className={cn(
        'text-white hover:bg-white/20 transition-all duration-300 h-10 w-10',
        open && 'bg-white/20 text-primary scale-105',
      )}
      title='Episodes'
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <List className='w-6 h-6' strokeWidth={2.5} />
    </Button>
  );
}

interface PlayerEpisodesPanelProps {
  open: boolean;
  seasons: number[];
  selectedSeason: number;
  onSeasonChange: (season: number) => void;
  episodes: Episode[];
  currentSeason?: number;
  currentEpisode?: number;
  backdrop?: string;
  onEpisodeSelect: (episode: Episode) => void;
  onClose: () => void;
}

export function PlayerEpisodesPanel({
  open,
  seasons,
  selectedSeason,
  onSeasonChange,
  episodes,
  currentSeason,
  currentEpisode,
  backdrop,
  onEpisodeSelect,
  onClose,
}: PlayerEpisodesPanelProps) {
  const seasonEpisodes = useMemo(
    () => episodes.filter((ep) => ep.season === selectedSeason),
    [episodes, selectedSeason],
  );

  return (
    <div
      className={cn(
        'absolute top-0 right-0 bottom-0 w-[400px] bg-zinc-950 border-l border-white/[0.07] z-[60] flex flex-col',
        'shadow-[-20px_0_60px_rgba(0,0,0,0.85)]',
        'transition-transform [transition-duration:380ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className='flex items-center justify-between p-5 border-b border-white/10 flex-shrink-0 bg-gradient-to-b from-black/60 to-transparent'>
        <div className='flex flex-col gap-1.5'>
          <h2 className='font-bold text-lg text-white tracking-tight'>Episodes</h2>

          {seasons.length > 1 ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-8 text-xs font-medium border-white/10 bg-white/5 hover:bg-white/15 text-gray-200 transition-colors'
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Season {selectedSeason}{' '}
                  <ChevronDown className='w-3.5 h-3.5 ml-2 opacity-70' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                side='bottom'
                className='z-[80] bg-zinc-950/95 backdrop-blur-xl border-white/10 text-white max-h-[300px] overflow-y-auto shadow-xl'
                onClick={(e) => e.stopPropagation()}
              >
                {seasons.map((seasonNumber) => (
                  <DropdownMenuItem
                    key={seasonNumber}
                    onSelect={() => onSeasonChange(seasonNumber)}
                    className={cn(
                      'cursor-pointer py-2 px-3 text-sm transition-colors',
                      selectedSeason === seasonNumber
                        ? 'bg-primary/20 text-primary font-medium'
                        : 'hover:bg-white/10',
                    )}
                  >
                    Season {seasonNumber}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <p className='text-sm text-gray-400 font-medium'>Season {selectedSeason}</p>
          )}
        </div>
        <Button
          variant='ghost'
          size='icon'
          onClick={onClose}
          className='text-gray-400 hover:text-white hover:bg-white/10 h-9 w-9 rounded-full transition-colors'
        >
          <X className='w-5 h-5' />
        </Button>
      </div>

      <ScrollArea className='flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block'>
        <div className='p-3 space-y-2'>
          {seasonEpisodes.length === 0 && (
            <p className='px-3 py-4 text-xs text-gray-500'>No episodes found for this season.</p>
          )}

          {seasonEpisodes.map((ep) => {
            const isCurrent =
              ep.season === currentSeason &&
              ep.episode === currentEpisode;

            return (
              <button
                type='button'
                key={`${ep.season}-${ep.episode}`}
                className={cn(
                  'w-full text-left group relative flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  isCurrent ? 'bg-white/5' : 'hover:bg-white/5',
                )}
                onClick={() => onEpisodeSelect(ep)}
              >
                {isCurrent && (
                  <div className='absolute left-0 inset-y-2 w-[2px] bg-primary rounded-full' />
                )}

                <div className='relative w-28 h-[68px] bg-zinc-900 rounded-md overflow-hidden flex-shrink-0'>
                  {ep.thumbnail || backdrop ? (
                    <>
                      <img
                        src={ep.thumbnail || backdrop}
                        className={cn(
                          'w-full h-full object-cover transition-opacity duration-300',
                          isCurrent ? 'opacity-90' : 'opacity-55 group-hover:opacity-80',
                        )}
                        alt=''
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          const placeholder =
                            e.currentTarget.nextElementSibling as HTMLElement | null;
                          if (placeholder) placeholder.style.display = 'flex';
                        }}
                      />
                      <div
                        className='absolute inset-0 items-center justify-center text-white/10 font-bold text-base tracking-wide bg-zinc-800/50'
                        style={{ display: 'none' }}
                      >
                        EP {ep.episode}
                      </div>
                    </>
                  ) : (
                    <div className='absolute inset-0 flex items-center justify-center text-white/10 font-bold text-base tracking-wide bg-zinc-800/50'>
                      EP {ep.episode}
                    </div>
                  )}
                  <div className='absolute bottom-1 right-1 px-1 py-px rounded bg-black/60 text-[10px] font-semibold text-white/70 backdrop-blur-sm'>
                    {ep.episode}
                  </div>
                </div>

                <div className='flex flex-col min-w-0 flex-1'>
                  <div className='flex items-center gap-1.5 mb-0.5'>
                    {isCurrent && (
                      <span className='flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary animate-pulse' />
                    )}
                    <h3
                      className={cn(
                        'text-sm font-medium truncate transition-colors',
                        isCurrent
                          ? 'text-white'
                          : 'text-gray-300 group-hover:text-white',
                      )}
                    >
                      {ep.title || `Episode ${ep.episode}`}
                    </h3>
                  </div>
                  {isCurrent && (
                    <span className='text-[10px] font-semibold text-primary uppercase tracking-wider mb-1'>
                      Now Playing
                    </span>
                  )}
                  <p
                    className='text-[11px] text-gray-500 line-clamp-2 leading-relaxed'
                    title={ep.overview || undefined}
                  >
                    {ep.overview || 'No description available.'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
