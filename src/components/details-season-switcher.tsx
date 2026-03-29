import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface LocalSeasonEntry {
  number: number;
  label: string;
}

export interface RelatedSeasonEntry {
  /** Stable dedup key: "S{seasonNumber}-P{part ?? 0}" */
  itemKey: string;
  label: string;
  routeType: string;
  id: string;
  seasonNumber: number;
}

interface SeasonSwitcherProps {
  /** Base/local seasons to display (may be base-item snapshot when in inline mode). */
  localSeasons: LocalSeasonEntry[];
  /** Cross-entry related season candidates (different Kitsu IDs). */
  relatedSeasons: RelatedSeasonEntry[];
  /** Currently active local season number (null when a related entry is active). */
  activeSeason: number | null;
  /** itemKey of the currently active related season candidate. */
  activeCandidateKey: string | null;
  /** Stable label for the inline candidate when it is no longer part of the current list. */
  activeInlineLabel?: string;
  /** Whether a related (inline) entry is currently loaded. */
  isInlineMode: boolean;
  /** Title of the base item — shown as group label in dropdown when inline. */
  inlineModeOriginTitle?: string;
  onLocalSeason: (season: number) => void;
  onRelatedSeason: (entry: RelatedSeasonEntry) => void;
  onPrefetch: (routeType: string, id: string, season: number) => void;
}

/** Use pill row when total options <= this, dropdown otherwise. */
const PILL_THRESHOLD = 8;

export function SeasonSwitcher(props: SeasonSwitcherProps) {
  const total = props.localSeasons.length + props.relatedSeasons.length;
  if (total <= 1) return null;

  if (props.isInlineMode) {
    return <DropdownSwitcher {...props} />;
  }

  if (total <= PILL_THRESHOLD) {
    return <PillSwitcher {...props} />;
  }
  return <DropdownSwitcher {...props} />;
}

function PillSwitcher({
  localSeasons,
  relatedSeasons,
  activeSeason,
  activeCandidateKey,
  isInlineMode,
  onLocalSeason,
  onRelatedSeason,
  onPrefetch,
}: SeasonSwitcherProps) {
  return (
    <div className='flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5'>
      {localSeasons.map((ls) => {
        const isActive = !isInlineMode && activeSeason === ls.number;
        return (
          <button
            key={ls.number}
            type='button'
            className={cn(
              'shrink-0 h-8 px-3.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-all duration-150',
              isActive
                ? 'bg-white text-black shadow-sm'
                : 'bg-white/[0.04] text-zinc-400 border border-white/[0.06] hover:bg-white/[0.08] hover:text-zinc-200 hover:border-white/[0.12]',
            )}
            onClick={() => onLocalSeason(ls.number)}
          >
            {ls.label}
          </button>
        );
      })}

      {relatedSeasons.length > 0 && localSeasons.length > 0 && (
        <div className='mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]' />
      )}

      {relatedSeasons.map((rs) => {
        const isActive = isInlineMode && activeCandidateKey === rs.itemKey;
        return (
          <button
            key={rs.itemKey}
            type='button'
            className={cn(
              'shrink-0 h-8 px-3.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-all duration-150',
              isActive
                ? 'bg-white text-black shadow-sm'
                : 'bg-white/[0.04] text-zinc-400 border border-white/[0.06] hover:bg-white/[0.08] hover:text-zinc-200 hover:border-white/[0.12]',
            )}
            onMouseEnter={() => onPrefetch(rs.routeType, rs.id, rs.seasonNumber)}
            onFocus={() => onPrefetch(rs.routeType, rs.id, rs.seasonNumber)}
            onClick={() => onRelatedSeason(rs)}
          >
            {rs.label}
          </button>
        );
      })}
    </div>
  );
}

function DropdownSwitcher({
  localSeasons,
  relatedSeasons,
  activeSeason,
  activeCandidateKey,
  activeInlineLabel,
  isInlineMode,
  inlineModeOriginTitle,
  onLocalSeason,
  onRelatedSeason,
  onPrefetch,
}: SeasonSwitcherProps) {
  const activeLabel = (() => {
    if (isInlineMode && activeInlineLabel?.trim()) {
      return activeInlineLabel;
    }

    if (isInlineMode && activeCandidateKey) {
      return relatedSeasons.find((r) => r.itemKey === activeCandidateKey)?.label ?? 'Season';
    }
    return localSeasons.find((ls) => ls.number === activeSeason)?.label ?? 'Season';
  })();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-9 px-4 gap-2 rounded-xl bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.15] text-white font-medium transition-all max-w-[220px]'
        >
          <span className='truncate text-[13px]'>{activeLabel}</span>
          <ChevronDown className='h-3.5 w-3.5 opacity-50 shrink-0' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='w-56 max-h-[360px] overflow-y-auto bg-zinc-950/98 border-white/[0.08] backdrop-blur-xl rounded-xl shadow-2xl p-1.5 scrollbar-thin scrollbar-thumb-white/10'
      >
        {isInlineMode && localSeasons.length > 0 && (
          <DropdownMenuLabel className='px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600 select-none truncate'>
            {inlineModeOriginTitle || 'Original'}
          </DropdownMenuLabel>
        )}

        {localSeasons.map((ls) => {
          const isActive = !isInlineMode && activeSeason === ls.number;
          return (
            <DropdownMenuItem
              key={`season-${ls.number}`}
              onClick={() => onLocalSeason(ls.number)}
              className={cn(
                'cursor-pointer rounded-lg px-3 py-2.5 text-[13px] transition-colors flex items-center justify-between gap-2',
                isActive
                  ? 'bg-white/[0.08] text-white font-semibold'
                  : 'text-zinc-400 hover:text-white hover:bg-white/[0.05] focus:bg-white/[0.05] focus:text-white',
              )}
            >
              <span>{ls.label}</span>
              {isActive && <Check className='h-3.5 w-3.5 shrink-0 opacity-70' />}
            </DropdownMenuItem>
          );
        })}

        {relatedSeasons.length > 0 && (
          <>
            <DropdownMenuSeparator className='my-1 bg-white/[0.07]' />
            {relatedSeasons.map((rs) => {
              const isActive = isInlineMode && activeCandidateKey === rs.itemKey;
              return (
                <DropdownMenuItem
                  key={`related-${rs.itemKey}`}
                  onMouseEnter={() => onPrefetch(rs.routeType, rs.id, rs.seasonNumber)}
                  onFocus={() => onPrefetch(rs.routeType, rs.id, rs.seasonNumber)}
                  onClick={() => onRelatedSeason(rs)}
                  className={cn(
                    'cursor-pointer rounded-lg px-3 py-2.5 text-[13px] transition-colors flex items-center justify-between gap-2',
                    isActive
                      ? 'bg-white/[0.08] text-white font-semibold'
                      : 'text-zinc-300 hover:text-white hover:bg-white/[0.05] focus:bg-white/[0.05] focus:text-white',
                  )}
                >
                  <span>{rs.label}</span>
                  {isActive && <Check className='h-3.5 w-3.5 shrink-0 opacity-70' />}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}