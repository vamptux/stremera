import { useMemo } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlayerSlider } from '@/components/player-slider';
import { buildTrackLabelMap, type Track } from '@/lib/player-track-utils';
import { cn } from '@/lib/utils';

interface PlayerPlaybackSettingsProps {
  audioTracks: Track[];
  subTracks: Track[];
  showActiveIndicator: boolean;
  subtitlesOff: boolean;
  trackSwitching: { audio: boolean; sub: boolean };
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  onResetSubtitleSettings: () => void;
  onApplySubtitleDelay: (value: number) => void;
  onApplySubtitlePos: (value: number) => void;
  onApplySubtitleScale: (value: number) => void;
  onSelectTrack: (
    type: 'audio' | 'sub',
    id: number | 'no',
    options?: { persistPreference?: boolean },
  ) => void;
}

export function PlayerPlaybackSettings({
  audioTracks,
  subTracks,
  showActiveIndicator,
  subtitlesOff,
  trackSwitching,
  subtitleDelay,
  subtitlePos,
  subtitleScale,
  onResetSubtitleSettings,
  onApplySubtitleDelay,
  onApplySubtitlePos,
  onApplySubtitleScale,
  onSelectTrack,
}: PlayerPlaybackSettingsProps) {
  const audioTrackLabels = useMemo(() => buildTrackLabelMap(audioTracks), [audioTracks]);
  const subtitleTrackLabels = useMemo(() => buildTrackLabelMap(subTracks), [subTracks]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className={cn(
            'relative text-white hover:bg-white/20',
            showActiveIndicator && 'bg-white/10 text-primary',
          )}
          title='Playback Settings'
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Settings2 className='h-5 w-5' strokeWidth={2.5} />
          {showActiveIndicator && (
            <span className='absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary' />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        className='w-[292px] rounded-xl border-white/10 bg-black/90 p-2'
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <ScrollArea className='max-h-[50vh] pr-1 [&>[data-radix-scroll-area-viewport]>div]:!block'>
          <div className='space-y-2.5'>
            <div>
              <h4 className='mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400'>
                Audio
              </h4>
              {audioTracks.length > 0 ? (
                <div className='space-y-1'>
                  {audioTracks.map((track) => {
                    const label = audioTrackLabels.get(track.id) ?? `Track ${track.id}`;

                    return (
                      <Button
                        key={track.id}
                        variant='ghost'
                        size='sm'
                        className={cn(
                          'h-8 w-full justify-between overflow-hidden rounded-lg border border-transparent px-2.5 text-xs',
                          track.selected && 'border-white/10 bg-white/[0.06] text-primary',
                          trackSwitching.audio && 'opacity-70',
                        )}
                        title={label}
                        disabled={trackSwitching.audio}
                        onClick={() =>
                          onSelectTrack('audio', track.id, { persistPreference: true })
                        }
                      >
                        <span className='truncate'>{label}</span>
                        {trackSwitching.audio && track.selected ? (
                          <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                        ) : track.selected ? (
                          <Check className='h-3.5 w-3.5 shrink-0' />
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              ) : (
                <p className='px-1 text-xs text-zinc-500'>No alternate audio tracks</p>
              )}
            </div>

            <div className='h-px bg-white/10' />

            <div>
              <div className='mb-1.5 flex items-center justify-between px-1'>
                <h4 className='text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400'>
                  Subtitles
                </h4>
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-6 rounded-lg px-2 text-[10px] text-gray-300 hover:text-white'
                  onClick={onResetSubtitleSettings}
                >
                  Reset
                </Button>
              </div>

              <div className='space-y-2.5'>
                <div className='space-y-1.5 px-1'>
                  <div className='flex items-center justify-between text-[11px] text-gray-400'>
                    <span>Sync</span>
                    <span className='font-mono text-gray-300'>{subtitleDelay.toFixed(1)}s</span>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 rounded-lg px-2 text-xs'
                      onClick={() => onApplySubtitleDelay(subtitleDelay - 0.5)}
                    >
                      -0.5s
                    </Button>
                    <PlayerSlider
                      value={[subtitleDelay]}
                      min={-5}
                      max={5}
                      step={0.1}
                      onValueChange={(values) => onApplySubtitleDelay(values[0])}
                      className='flex-1'
                    />
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 rounded-lg px-2 text-xs'
                      onClick={() => onApplySubtitleDelay(subtitleDelay + 0.5)}
                    >
                      +0.5s
                    </Button>
                  </div>
                </div>

                <div className='space-y-1.5 px-1'>
                  <div className='flex items-center justify-between text-[11px] text-gray-400'>
                    <span>Position</span>
                    <span className='font-mono text-gray-300'>{Math.round(subtitlePos)}%</span>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='h-7 w-7 rounded-lg'
                      onClick={() => onApplySubtitlePos(subtitlePos - 2)}
                    >
                      <ChevronUp className='h-4 w-4' />
                    </Button>
                    <PlayerSlider
                      value={[subtitlePos]}
                      min={65}
                      max={100}
                      step={1}
                      onValueChange={(values) => onApplySubtitlePos(values[0])}
                      className='flex-1'
                    />
                    <Button
                      variant='ghost'
                      size='icon'
                      className='h-7 w-7 rounded-lg'
                      onClick={() => onApplySubtitlePos(subtitlePos + 2)}
                    >
                      <ChevronDown className='h-4 w-4' />
                    </Button>
                  </div>
                </div>

                <div className='space-y-1.5 px-1'>
                  <div className='flex items-center justify-between text-[11px] text-gray-400'>
                    <span>Size</span>
                    <span className='font-mono text-gray-300'>x{subtitleScale.toFixed(2)}</span>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 rounded-lg px-2 text-xs'
                      onClick={() => onApplySubtitleScale(subtitleScale - 0.1)}
                    >
                      A-
                    </Button>
                    <PlayerSlider
                      value={[subtitleScale]}
                      min={0.25}
                      max={3.0}
                      step={0.05}
                      onValueChange={(values) => onApplySubtitleScale(values[0])}
                      className='flex-1'
                    />
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 rounded-lg px-2 text-xs'
                      onClick={() => onApplySubtitleScale(subtitleScale + 0.1)}
                    >
                      A+
                    </Button>
                  </div>
                </div>
              </div>

              <div className='mt-3'>
                <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500'>
                  Tracks
                </p>
                <div className='space-y-1'>
                  <Button
                    variant='ghost'
                    size='sm'
                    className={cn(
                      'h-8 w-full justify-between overflow-hidden rounded-lg border border-transparent px-2.5 text-xs',
                      subtitlesOff ? 'border-white/10 bg-white/[0.06] text-primary' : 'text-red-400',
                      trackSwitching.sub && 'opacity-70',
                    )}
                    disabled={trackSwitching.sub}
                    onClick={() => onSelectTrack('sub', 'no', { persistPreference: true })}
                  >
                    <span className='truncate'>Off</span>
                    {trackSwitching.sub && subtitlesOff ? (
                      <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                    ) : subtitlesOff ? (
                      <Check className='h-3.5 w-3.5 shrink-0' />
                    ) : null}
                  </Button>
                  {subTracks.map((track) => {
                    const label = subtitleTrackLabels.get(track.id) ?? `Track ${track.id}`;

                    return (
                      <Button
                        key={track.id}
                        variant='ghost'
                        size='sm'
                        className={cn(
                          'h-8 w-full justify-between overflow-hidden rounded-lg border border-transparent px-2.5 text-xs',
                          track.selected && 'border-white/10 bg-white/[0.06] text-primary',
                          trackSwitching.sub && 'opacity-70',
                        )}
                        title={label}
                        disabled={trackSwitching.sub}
                        onClick={() => onSelectTrack('sub', track.id, { persistPreference: true })}
                      >
                        <span className='truncate'>{label}</span>
                        {trackSwitching.sub && track.selected ? (
                          <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                        ) : track.selected ? (
                          <Check className='h-3.5 w-3.5 shrink-0' />
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
