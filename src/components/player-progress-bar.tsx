import { useCallback, useEffect, useRef, useState } from 'react';
import { type SkipSegment } from '@/lib/api';
import { cn } from '@/lib/utils';

function getSkipLabel(type: string): string {
  switch (type) {
    case 'op':
    case 'mixed-op':
    case 'intro':
      return 'Skip Intro';
    case 'ed':
    case 'mixed-ed':
    case 'outro':
      return 'Skip Outro';
    case 'recap':
      return 'Skip Recap';
    default:
      return 'Skip';
  }
}

function getSegmentColorClass(type: string): string {
  if (type === 'op' || type === 'mixed-op' || type === 'intro') return 'bg-amber-400/90';
  if (type === 'ed' || type === 'mixed-ed' || type === 'outro') return 'bg-sky-400/90';
  return 'bg-orange-400/90';
}

interface PlayerProgressBarProps {
  duration: number;
  currentTime: number;
  seekPreviewTime: number | null;
  skipSegments: SkipSegment[];
  onSeekPreviewTimeChange: (value: number | null) => void;
  onSeek: (seconds: number) => void | Promise<void>;
  formatTime: (seconds: number) => string;
}

export function PlayerProgressBar({
  duration,
  currentTime,
  seekPreviewTime,
  skipSegments,
  onSeekPreviewTimeChange,
  onSeek,
  formatTime,
}: PlayerProgressBarProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragRectRef = useRef<DOMRect | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverXRef = useRef<number | null>(null);

  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [hoverSegment, setHoverSegment] = useState<SkipSegment | null>(null);

  const updateHoverAtClientX = useCallback(
    (clientX: number, rectOverride?: DOMRect | null) => {
      const rect = rectOverride || progressBarRef.current?.getBoundingClientRect();
      if (!rect || !duration) return;

      const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      const hoverTime = (pct / 100) * duration;
      const segment =
        skipSegments.find((seg) => hoverTime >= seg.start_time && hoverTime <= seg.end_time) ||
        null;

      setHoverPct(pct);
      setHoverSegment(segment);
    },
    [duration, skipSegments],
  );

  const scheduleHoverUpdate = useCallback(
    (clientX: number) => {
      pendingHoverXRef.current = clientX;
      if (hoverRafRef.current !== null) return;

      hoverRafRef.current = window.requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const pendingClientX = pendingHoverXRef.current;
        if (pendingClientX === null) return;
        updateHoverAtClientX(pendingClientX);
      });
    },
    [updateHoverAtClientX],
  );

  const getSeekFraction = useCallback(
    (clientX: number, rectOverride?: DOMRect | null): number | null => {
      const rect = rectOverride || progressBarRef.current?.getBoundingClientRect();
      if (!rect || !duration) return null;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    },
    [duration],
  );

  const clearHoverState = useCallback(() => {
    setHoverPct(null);
    setHoverSegment(null);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (draggingRef.current) return;
      scheduleHoverUpdate(e.clientX);
    },
    [scheduleHoverUpdate],
  );

  const handleMouseLeave = useCallback(() => {
    if (draggingRef.current) return;
    clearHoverState();
  }, [clearHoverState]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;

      const rect = progressBarRef.current?.getBoundingClientRect() || null;
      dragRectRef.current = rect;

      const frac = getSeekFraction(e.clientX, rect);
      if (frac === null) return;

      onSeekPreviewTimeChange(frac * duration);
      updateHoverAtClientX(e.clientX, rect);
    },
    [duration, getSeekFraction, onSeekPreviewTimeChange, updateHoverAtClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;

      const frac = getSeekFraction(e.clientX, dragRectRef.current);
      if (frac === null) return;

      onSeekPreviewTimeChange(frac * duration);
      updateHoverAtClientX(e.clientX, dragRectRef.current);
    },
    [duration, getSeekFraction, onSeekPreviewTimeChange, updateHoverAtClientX],
  );

  const finalizeDrag = useCallback(
    (clientX: number) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;

      const frac = getSeekFraction(clientX, dragRectRef.current);
      if (frac !== null && duration > 0) {
        void onSeek(frac * duration);
      }

      dragRectRef.current = null;
      onSeekPreviewTimeChange(null);
      clearHoverState();
    },
    [clearHoverState, duration, getSeekFraction, onSeek, onSeekPreviewTimeChange],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      finalizeDrag(e.clientX);
    },
    [finalizeDrag],
  );

  const handlePointerCancel = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    dragRectRef.current = null;
    onSeekPreviewTimeChange(null);
    clearHoverState();
  }, [clearHoverState, onSeekPreviewTimeChange]);

  useEffect(() => {
    return () => {
      if (hoverRafRef.current !== null) {
        window.cancelAnimationFrame(hoverRafRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={progressBarRef}
      className='relative group/bar cursor-pointer select-none h-8 -my-2 flex items-center'
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={(e) => e.stopPropagation()}
    >
      {hoverPct !== null && duration > 0 && (
        <div
          className='absolute bottom-full mb-2 -translate-x-1/2 pointer-events-none z-10 flex flex-col items-center gap-1'
          style={{ left: `${Math.max(5, Math.min(95, hoverPct))}%` }}
        >
          {hoverSegment && (
            <span
              className={cn(
                'text-[9px] font-bold uppercase tracking-widest px-2 py-[3px] rounded-sm leading-none shadow-lg',
                hoverSegment.type === 'op' ||
                  hoverSegment.type === 'mixed-op' ||
                  hoverSegment.type === 'intro'
                  ? 'bg-amber-500 text-black'
                  : hoverSegment.type === 'ed' ||
                      hoverSegment.type === 'mixed-ed' ||
                      hoverSegment.type === 'outro'
                    ? 'bg-sky-500 text-black'
                    : 'bg-orange-500 text-black',
              )}
            >
              {getSkipLabel(hoverSegment.type)}
            </span>
          )}
          <div className='bg-zinc-900/95 text-white text-[11px] font-mono tabular-nums whitespace-nowrap px-2.5 py-[5px] rounded-md shadow-xl leading-none border border-white/10'>
            {formatTime((hoverPct / 100) * duration)}
          </div>
        </div>
      )}

      <div className='relative w-full h-[5px] group-hover/bar:h-[7px] transition-[height] duration-150 rounded-full overflow-hidden bg-white/[0.18]'>
        {hoverPct !== null && duration > 0 && (
          <div
            className='absolute inset-y-0 left-0 bg-white/25 pointer-events-none'
            style={{ width: `${hoverPct}%` }}
          />
        )}

        <div
          className='absolute inset-y-0 left-0 bg-white pointer-events-none z-10'
          style={{
            width:
              duration > 0
                ? `${Math.min(100, (((seekPreviewTime ?? currentTime) / duration) * 100))}%`
                : '0%',
          }}
        />

        {duration > 0 &&
          skipSegments.map((seg, i) => {
            const leftPct = Math.max(0, Math.min(100, (seg.start_time / duration) * 100));
            const widthPct = Math.max(
              0,
              Math.min(100 - leftPct, ((seg.end_time - seg.start_time) / duration) * 100),
            );
            const isHovered = hoverSegment?.start_time === seg.start_time;

            return (
              <div
                key={`seg-${i}`}
                className={cn(
                  'absolute inset-y-0 pointer-events-none transition-opacity duration-100 z-0',
                  isHovered ? 'opacity-100' : 'opacity-70',
                  getSegmentColorClass(seg.type),
                )}
                style={{ left: `${leftPct}%`, width: `max(4px, ${widthPct}%)` }}
              />
            );
          })}

        {duration > 0 &&
          skipSegments.map((seg, i) => {
            const startPct = Math.max(0, Math.min(100, (seg.start_time / duration) * 100));
            const endPct = Math.max(0, Math.min(100, (seg.end_time / duration) * 100));

            return (
              <div key={`cut-group-${i}`}>
                {startPct > 0 && (
                  <div
                    className='absolute inset-y-0 w-[3px] bg-black z-20'
                    style={{ left: `calc(${startPct}% - 1.5px)` }}
                  />
                )}
                {endPct < 100 && (
                  <div
                    className='absolute inset-y-0 w-[3px] bg-black z-20'
                    style={{ left: `calc(${endPct}% - 1.5px)` }}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
