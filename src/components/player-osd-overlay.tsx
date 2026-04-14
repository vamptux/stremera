import { FastForward, Pause, Play, Rewind, Volume1, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PlayerOsdAction =
  | { kind: 'play' | 'pause' }
  | { kind: 'seek'; direction: 'forward' | 'backward'; seconds: number }
  | { kind: 'volume'; level: number }
  | { kind: 'message'; text: string };

interface PlayerOsdOverlayProps {
  action: PlayerOsdAction | null;
  visible: boolean;
  isLoading: boolean;
  isResolving: boolean;
}

export function PlayerOsdOverlay({
  action,
  visible,
  isLoading,
  isResolving,
}: PlayerOsdOverlayProps) {
  if (!action || isLoading || isResolving) {
    return null;
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-100',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      aria-live='polite'
      aria-atomic='true'
    >
      {/* Play/Pause: tiny icon that fades quickly — no bg to avoid clashing with center play btn */}
      {(action.kind === 'play' || action.kind === 'pause') && (
        <div
          className={cn(
            'transition-all duration-100',
            visible ? 'scale-100 opacity-60' : 'scale-75 opacity-0',
          )}
        >
          {action.kind === 'play' ? (
            <Play className='h-7 w-7 fill-white text-white drop-shadow-lg' />
          ) : (
            <Pause className='h-7 w-7 fill-white text-white drop-shadow-lg' />
          )}
        </div>
      )}

      {action.kind === 'seek' && (
        <div className='flex items-center gap-3 rounded-2xl border border-white/15 bg-black/50 px-6 py-3.5 shadow-xl backdrop-blur-2xl'>
          {action.direction === 'forward' ? (
            <FastForward className='h-5 w-5 text-white/90' strokeWidth={2.5} />
          ) : (
            <Rewind className='h-5 w-5 text-white/90' strokeWidth={2.5} />
          )}
          <span className='text-xl font-semibold tracking-tight text-white tabular-nums'>
            {action.direction === 'forward' ? '+' : '−'}
            {action.seconds}s
          </span>
        </div>
      )}

      {action.kind === 'volume' && (
        <div className='flex min-w-[130px] flex-col items-center gap-2.5 rounded-2xl border border-white/15 bg-black/50 px-5 py-3.5 shadow-xl backdrop-blur-2xl'>
          <div className='flex items-center gap-2'>
            {action.level === 0 ? (
              <VolumeX className='h-5 w-5 text-white/90' strokeWidth={2.5} />
            ) : action.level < 50 ? (
              <Volume1 className='h-5 w-5 text-white/90' strokeWidth={2.5} />
            ) : (
              <Volume2 className='h-5 w-5 text-white/90' strokeWidth={2.5} />
            )}
            <span className='text-base font-semibold text-white tabular-nums'>
              {Math.round(action.level)}%
            </span>
          </div>
          <div className='h-[3px] w-28 overflow-hidden rounded-full bg-white/20'>
            <div
              className='h-full rounded-full bg-white'
              style={{ width: `${Math.min(100, Math.round(action.level))}%` }}
            />
          </div>
        </div>
      )}

      {action.kind === 'message' && (
        <div className='rounded-2xl border border-white/15 bg-black/55 px-5 py-3 shadow-xl backdrop-blur-2xl'>
          <span className='text-sm font-semibold tracking-wide text-white'>{action.text}</span>
        </div>
      )}
    </div>
  );
}
