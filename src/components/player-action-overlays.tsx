import { FastForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PlayerSkipAction {
  label: string;
  onSkip: () => void;
}

interface PlayerUpNextAction {
  countdown: number;
  title: string;
  onDismiss: () => void;
  onPlayNext: () => void;
}

interface PlayerActionOverlaysProps {
  hidden?: boolean;
  skipAction?: PlayerSkipAction | null;
  upNextAction?: PlayerUpNextAction | null;
}

export function PlayerActionOverlays({
  hidden = false,
  skipAction,
  upNextAction,
}: PlayerActionOverlaysProps) {
  if (hidden || (!skipAction && !upNextAction)) {
    return null;
  }

  return (
    <div
      className='absolute bottom-[116px] right-6 z-[55] flex flex-col items-end gap-2 pointer-events-auto'
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {skipAction && (
        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <Button
            onClick={skipAction.onSkip}
            variant='outline'
            aria-label={skipAction.label}
            className={cn(
              'h-auto px-5 py-2.5 text-sm font-semibold rounded-lg',
              'bg-zinc-900 hover:bg-zinc-800 text-white',
              'border border-white/20 hover:border-white/40',
              'shadow-2xl',
              'flex items-center gap-2 transition-all duration-150',
              'animate-in fade-in slide-in-from-right-4 duration-300',
            )}
          >
            <FastForward className='h-4 w-4 flex-shrink-0' strokeWidth={2.5} />
            <span>{skipAction.label}</span>
          </Button>
        </div>
      )}

      {upNextAction && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          aria-live='polite'
          aria-atomic='true'
        >
          <div className='flex items-center gap-2 animate-in fade-in slide-in-from-right-4 duration-300'>
            <Button
              size='icon'
              variant='ghost'
              onClick={upNextAction.onDismiss}
              className='h-8 w-8 rounded-lg bg-zinc-900/80 border border-white/10 text-zinc-400 hover:text-white hover:bg-zinc-800 shadow-xl'
              title='Dismiss'
              aria-label='Dismiss next episode prompt'
            >
              <X className='h-3.5 w-3.5' />
            </Button>

            <button
              onClick={upNextAction.onPlayNext}
              aria-label={`Play next episode: ${upNextAction.title}`}
              className={cn(
                'relative overflow-hidden rounded-lg border border-white/20 bg-zinc-900 text-white shadow-2xl',
                'cursor-pointer transition-colors duration-150 hover:border-white/40',
                'px-5 py-2.5',
              )}
            >
              <div
                className='absolute inset-0 origin-left bg-white/10 pointer-events-none transition-none'
                style={{
                  transform: `scaleX(${1 - upNextAction.countdown / 10})`,
                  transformOrigin: 'left',
                  transition: upNextAction.countdown < 10 ? 'transform 1s linear' : 'none',
                }}
              />

              <div className='relative z-10 flex items-center gap-3'>
                <FastForward className='h-4 w-4 flex-shrink-0' strokeWidth={2.5} />
                <span className='flex min-w-0 flex-col items-start text-left'>
                  <span className='text-sm font-semibold'>Next Episode</span>
                  <span className='max-w-[220px] truncate text-[11px] text-zinc-400'>
                    {upNextAction.title}
                  </span>
                </span>
                <span className='text-sm tabular-nums text-zinc-300'>
                  {upNextAction.countdown}s
                </span>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}