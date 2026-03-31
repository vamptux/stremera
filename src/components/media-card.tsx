import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  MediaItem,
  UserList,
  WatchStatus,
  WATCH_STATUS_LABELS,
  WATCH_STATUS_COLORS,
  api,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Play,
  Plus,
  Check,
  Volume2,
  VolumeX,
  Bookmark,
  BookmarkCheck,
  ListPlus,
  ChevronLeft,
  Trash2,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CreateListDialog } from '@/components/list/create-list-dialog';
import { ListIcon } from '@/components/list/list-icons';
import { buildYouTubeEmbedUrl, extractYouTubeVideoId } from '@/lib/trailer-utils';

// ── Rating helpers ─────────────────────────────────────────────────────────────
// Normalise a rating string (IMDb "8.3" or percentage "83") to a 0-100 score.
function normalizeRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const val = parseFloat(raw);
  if (isNaN(val)) return null;
  return val <= 10 ? Math.round(val * 10) : Math.round(val);
}
function getRatingStyle(score: number | null) {
  if (score === null) return null;
  if (score >= 70)
    return { text: 'text-green-400', bg: 'bg-green-500/15', border: 'border-green-500/30' };
  if (score >= 50)
    return { text: 'text-yellow-400', bg: 'bg-yellow-500/15', border: 'border-yellow-500/30' };
  return { text: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30' };
}

// Module-level counter: when any card popup is open, subsequent hovers skip the delay
let _openPopups = 0;

const WATCH_STATUS_ORDER: WatchStatus[] = ['plan_to_watch', 'watching', 'watched', 'dropped'];
const POPUP_W = 288;
const POPUP_H_EST = 320; // conservative height estimate for viewport-edge clamping
// How long the cursor must dwell before we show the popup.
const HOVER_OPEN_DELAY_MS = 80;
// Delay between sequential opens (cursor moving rapidly card-to-card)
const HOVER_CHAIN_DELAY_MS = 30;
// Search has dense grids; use slower hover-intent timing to avoid accidental opens.
const SEARCH_HOVER_OPEN_DELAY_MS = 80;
const SEARCH_HOVER_CHAIN_DELAY_MS = 30;
const HOVER_LEAVE_DELAY_MS = 120;
const HOVER_SCROLL_COOLDOWN_MS = 200;
const DETAILS_FETCH_DELAY_MS = 200;
const POPUP_SCROLL_DISMISS_PX = 140;
const MIN_PROGRESS_BAR_PERCENT = 2;

interface MediaCardProps {
  item: MediaItem;
  className?: string;
  progress?: number;
  onPlay?: (e: React.MouseEvent) => void;
  onRemoveFromContinue?: (e: React.MouseEvent) => void;
  showLibraryContext?: boolean;
  subtitle?: string;
}

export function MediaCard({
  item,
  className,
  progress,
  onPlay,
  onRemoveFromContinue,
  showLibraryContext = false,
  subtitle,
}: MediaCardProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  const isSearchPage = location.pathname.startsWith('/search');

  // ── Hover popup state ──────────────────────────────────────────────────
  const [showPopup, setShowPopup] = useState(false);
  const [playingTrailer, setPlayingTrailer] = useState(false);
  const [trailerMuted, setTrailerMuted] = useState(true);
  const [detailsFetchReady, setDetailsFetchReady] = useState(false);
  const [showListPicker, setShowListPicker] = useState(false);
  const [createListOpen, setCreateListOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupOpenRef = useRef(false);
  const showListPickerRef = useRef(false);
  const createListOpenRef = useRef(false);
  // F2: store scroll RAF id in a ref so it can be safely cancelled on unmount
  const scrollRafRef = useRef<number | null>(null);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const hoverCooldownUntilRef = useRef(0);
  const detailsFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupContainerRef = useRef<HTMLDivElement>(null);
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const popupOpenScrollTopRef = useRef<number | null>(null);

  const releasePopupOpenCounter = useCallback(() => {
    if (popupOpenRef.current) {
      _openPopups = Math.max(0, _openPopups - 1);
      popupOpenRef.current = false;
    }
  }, []);

  const closePopup = useCallback(() => {
      releasePopupOpenCounter();
      setShowPopup(false);
      setPlayingTrailer(false);
      setTrailerMuted(true);
      setPopupPos(null);
      setShowListPicker(false);
      showListPickerRef.current = false;
      createListOpenRef.current = false;
    },
    [releasePopupOpenCounter],
  );

  const computePopupPos = useCallback((): { top: number; left: number } | null => {
    if (!cardRef.current || !cardRef.current.isConnected) return null;
    const rect = cardRef.current.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return null;
    }
    const margin = 8;
    let left = rect.left + rect.width / 2 - POPUP_W / 2;
    let top = rect.top;
    left = Math.max(margin, Math.min(left, window.innerWidth - POPUP_W - margin));
    if (top + POPUP_H_EST > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - POPUP_H_EST - margin);
    }
    return { top, left };
  }, []);

  const getScrollTopSnapshot = useCallback(() => {
    const container = document.querySelector(
      '[data-media-scroll-container="true"]',
    ) as HTMLElement | null;
    if (container) return container.scrollTop;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (Date.now() < hoverCooldownUntilRef.current) return;
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    // Delay both the query fetch and the popup open by the same timer so we
    // don't fire API requests for every card the cursor merely sweeps over.
    const openDelay = isSearchPage ? SEARCH_HOVER_OPEN_DELAY_MS : HOVER_OPEN_DELAY_MS;
    const chainDelay = isSearchPage ? SEARCH_HOVER_CHAIN_DELAY_MS : HOVER_CHAIN_DELAY_MS;
    const delay = _openPopups > 0 ? chainDelay : openDelay;
    hoverTimer.current = setTimeout(() => {
      const nextPos = computePopupPos();
      if (!nextPos) return;
      setPopupPos(nextPos);
      popupOpenScrollTopRef.current = getScrollTopSnapshot();
      if (!popupOpenRef.current) {
        _openPopups++;
        popupOpenRef.current = true;
      }
      setShowPopup(true);
    }, delay);
  }, [computePopupPos, isSearchPage, getScrollTopSnapshot]);

  const handleMouseLeave = useCallback(() => {
    // Keep popup open while list picker or create list dialog is in use
    if (showListPickerRef.current || createListOpenRef.current) return;
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    leaveTimer.current = setTimeout(() => {
      if (showListPickerRef.current || createListOpenRef.current) return;
      closePopup();
    }, HOVER_LEAVE_DELAY_MS);
  }, [closePopup]);

  const toggleListPicker = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowListPicker((v) => {
      showListPickerRef.current = !v;
      return !v;
    });
  }, []);

  // ── Compute fixed popup position ─────────────────────────────────────
  const computePos = useCallback(() => {
    const nextPos = computePopupPos();
    if (!nextPos) {
      closePopup();
      return;
    }
    setPopupPos(nextPos);
  }, [closePopup, computePopupPos]);

  const isPointInsideRect = useCallback((x: number, y: number, rect: DOMRect) => {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);

  const forwardWheelToScrollContainer = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!isSearchPage) return;
      const container = document.querySelector(
        '[data-media-scroll-container="true"]',
      ) as HTMLElement | null;
      if (container) {
        e.preventDefault();
        container.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
      } else {
        e.preventDefault();
        window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
      }
    },
    [isSearchPage],
  );

  useEffect(() => {
    if (!showPopup) return;
    computePos();

    const onPointerMove = (e: MouseEvent) => {
      pointerPosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onPointerMove, { passive: true });

    // Keep popup visually fixed while scrolling, and close only when the
    // source card leaves the viewport/valid bounds.
    // F2: use the component-level `scrollRafRef` so any pending RAF is cancelled
    // on unmount even if the effect cleanup runs before the RAF fires.
    const onScroll = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const nextPos = computePopupPos();
        if (!nextPos) {
          hoverCooldownUntilRef.current = Date.now() + HOVER_SCROLL_COOLDOWN_MS;
          closePopup();
          return;
        }

        const openedAt = popupOpenScrollTopRef.current;
        if (openedAt !== null) {
          const scrollDelta = Math.abs(getScrollTopSnapshot() - openedAt);
          if (scrollDelta >= POPUP_SCROLL_DISMISS_PX) {
            hoverCooldownUntilRef.current = Date.now() + HOVER_SCROLL_COOLDOWN_MS;
            closePopup();
            return;
          }
        }

        const pointer = pointerPosRef.current;
        if (!pointer) return;

        const cardRect = cardRef.current?.getBoundingClientRect();
        const popupRect = popupContainerRef.current?.getBoundingClientRect();
        const overCard = !!cardRect && isPointInsideRect(pointer.x, pointer.y, cardRect);
        const overPopup = !!popupRect && isPointInsideRect(pointer.x, pointer.y, popupRect);

        if (!overCard && !overPopup) {
          hoverCooldownUntilRef.current = Date.now() + HOVER_SCROLL_COOLDOWN_MS;
          closePopup();
        }
      });
    };

    // F1: recompute popup position on window resize so it never clips off-screen
    const onResize = () => {
      computePos();
    };

    // capture:true catches scroll events on any scrollable child element
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
    };
  }, [showPopup, computePos, computePopupPos, closePopup, isPointInsideRect, getScrollTopSnapshot]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      if (detailsFetchTimerRef.current) {
        clearTimeout(detailsFetchTimerRef.current);
        detailsFetchTimerRef.current = null;
      }
      releasePopupOpenCounter();
    };
  }, [releasePopupOpenCounter]);

  useEffect(() => {
    if (detailsFetchTimerRef.current) {
      clearTimeout(detailsFetchTimerRef.current);
      detailsFetchTimerRef.current = null;
    }

    if (!showPopup) {
      setDetailsFetchReady(false);
      return;
    }

    const delay = isSearchPage ? DETAILS_FETCH_DELAY_MS + 70 : DETAILS_FETCH_DELAY_MS;
    detailsFetchTimerRef.current = setTimeout(() => {
      setDetailsFetchReady(true);
      detailsFetchTimerRef.current = null;
    }, delay);

    return () => {
      if (detailsFetchTimerRef.current) {
        clearTimeout(detailsFetchTimerRef.current);
        detailsFetchTimerRef.current = null;
      }
    };
  }, [showPopup, isSearchPage]);

  // Lazy-fetch details on hover. Resolves instantly if already in React Query cache.
  const { data: details } = useQuery({
    queryKey: ['details', item.type, item.id],
    queryFn: () => api.getMediaDetails(item.type, item.id),
    enabled: showPopup && detailsFetchReady,
    staleTime: 1000 * 60 * 60 * 2,
    gcTime: 1000 * 60 * 60 * 6,
  });

  // Lists (shared cached, gated on hover)
  const { data: lists } = useQuery({
    queryKey: ['lists'],
    queryFn: api.getLists,
    enabled: showPopup,
    staleTime: 1000 * 15,
  });

  const { data: itemListIds } = useQuery({
    queryKey: ['item-lists', item.id],
    queryFn: () => api.checkItemInLists(item.id),
    enabled: showPopup,
    staleTime: 1000 * 15,
  });

  // Watch status (shared global cache — present regardless of hover so badges show on posters)
  const { data: allWatchStatuses } = useQuery({
    queryKey: ['watch-statuses'],
    queryFn: api.getAllWatchStatuses,
    staleTime: 1000 * 60 * 5,
  });
  const currentStatus = (allWatchStatuses?.[item.id] ?? null) as WatchStatus | null;

  // Derived popup data
  const ratingRaw = details?.rating ?? null;
  const ratingScore = normalizeRating(ratingRaw);
  const ratingStyle = getRatingStyle(ratingScore);

  const episodeLabel = details?.episodes
    ? (() => {
        const total = details.episodes.length;
        return `${total} Episode${total === 1 ? '' : 's'}`;
      })()
    : null;

  const trailerVideoId = extractYouTubeVideoId(details?.trailers?.[0]?.url);
  const trailerPreviewUrl = trailerVideoId
    ? buildYouTubeEmbedUrl(trailerVideoId, {
        autoplay: true,
        controls: false,
        loop: true,
        mute: trailerMuted,
      })
    : null;

  const backdropSrc = details?.backdrop || item.backdrop || item.poster;

  // Auto-start trailer shortly after popup+data are both ready
  const trailerStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (trailerStartTimer.current) {
      clearTimeout(trailerStartTimer.current);
      trailerStartTimer.current = null;
    }
    if (showPopup && trailerVideoId) {
      trailerStartTimer.current = setTimeout(() => setPlayingTrailer(true), 250);
    }
    if (!showPopup) {
      setPlayingTrailer(false);
      setTrailerMuted(true);
    }
    return () => {
      if (trailerStartTimer.current) clearTimeout(trailerStartTimer.current);
    };
  }, [showPopup, trailerVideoId]);

  // ── Library ────────────────────────────────────────────────────────────
  const { data: library } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
    staleTime: 1000 * 60 * 5,
  });
  const isInLibrary = library?.some((l) => l.id === item.id) ?? false;

  const toggleLibrary = useMutation({
    mutationFn: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return 'removed' as const;
      }
      await api.addToLibrary(item);
      return 'added' as const;
    },
    // Optimistic update — button state flips instantly, no flicker
    onMutate: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await queryClient.cancelQueries({ queryKey: ['library'] });
      const previous = queryClient.getQueryData<MediaItem[]>(['library']);
      if (isInLibrary) {
        queryClient.setQueryData<MediaItem[]>(
          ['library'],
          (old) => old?.filter((l) => l.id !== item.id) ?? [],
        );
      } else {
        queryClient.setQueryData<MediaItem[]>(['library'], (old) => [...(old ?? []), item]);
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData<MediaItem[]>(['library'], context.previous);
      toast.error('Failed to update library');
    },
    onSuccess: (action) => {
      toast.success(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        description: item.title,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['library'] }),
  });

  // ── Add to list ────────────────────────────────────────────────────────
  const addToList = useMutation({
    mutationFn: async (list: UserList) => {
      if (itemListIds?.includes(list.id)) {
        await api.removeFromList(list.id, item.id);
        return { action: 'removed' as const, listName: list.name, listId: list.id };
      }
      await api.addToList(list.id, item);
      return { action: 'added' as const, listName: list.name, listId: list.id };
    },
    onSuccess: ({ action, listName, listId }) => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
      queryClient.invalidateQueries({ queryKey: ['item-lists', item.id] });
      if (action === 'added') {
        // Duplicate detection: warn if the item is already in other lists
        const alreadyIn =
          lists?.filter((l) => l.id !== listId && itemListIds?.includes(l.id)) ?? [];
        if (alreadyIn.length > 0) {
          const names = alreadyIn.map((l) => `"${l.name}"`).join(', ');
          toast.success(`Added to "${listName}"`, { description: `⚠ Also in ${names}` });
        } else {
          toast.success(`Added to "${listName}"`, { description: item.title });
        }
      } else {
        toast.success(`Removed from "${listName}"`, { description: item.title });
      }
    },
    onError: () => toast.error('Failed to update list'),
  });

  // ── Watch status ───────────────────────────────────────────────────────
  const watchStatusMutation = useMutation({
    mutationFn: async (status: WatchStatus | null) => {
      await api.setWatchStatus(item.id, status);
      return status;
    },
    onMutate: async (status) => {
      await queryClient.cancelQueries({ queryKey: ['watch-statuses'] });
      const previous = queryClient.getQueryData<Record<string, WatchStatus>>(['watch-statuses']);
      queryClient.setQueryData<Record<string, WatchStatus>>(['watch-statuses'], (old) => {
        const next = { ...old };
        if (status === null) delete next[item.id];
        else next[item.id] = status;
        return next;
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous)
        queryClient.setQueryData<Record<string, WatchStatus>>(['watch-statuses'], context.previous);
      toast.error('Failed to update status');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['watch-statuses'] }),
  });

  const safeProgress =
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.min(100, Math.max(0, progress))
      : undefined;
  const showProgress = safeProgress !== undefined && safeProgress >= MIN_PROGRESS_BAR_PERCENT;

  const isInAnyList = (itemListIds?.length ?? 0) > 0;

  return (
    <div
      ref={cardRef}
      className={cn('relative', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* ── Base poster card ─────────────────────────────────────── */}
      <Link
        to={`/details/${item.type}/${item.id}`}
        state={{ from }}
        className={cn('block relative transition-opacity duration-150 opacity-100')}
        onClick={onPlay ? (e) => onPlay(e) : undefined}
      >
        <div
          className={cn(
            'relative rounded-xl bg-zinc-900',
            // No pre-popup scale — the popup IS the hover effect. A faint ring is
            // enough micro-feedback without creating a "double" visual event.
            'transition-[box-shadow] duration-150',
          )}
        >
          <div className='relative aspect-[2/3] rounded-xl overflow-hidden bg-zinc-900'>
            {item.poster ? (
              <img
                src={item.poster}
                alt={item.title}
                className='object-cover w-full h-full'
                loading='lazy'
              />
            ) : (
              <div className='flex items-center justify-center w-full h-full text-zinc-600 text-xs p-2 text-center'>
                <span className='line-clamp-2'>{item.title}</span>
              </div>
            )}
            {/* Watch status badge overlay on poster */}
            {currentStatus && (
              <div
                className={cn(
                  'absolute top-1.5 left-1.5 z-10 px-1.5 py-[3px] rounded text-[9px] font-bold border backdrop-blur-sm',
                  WATCH_STATUS_COLORS[currentStatus].bg,
                  WATCH_STATUS_COLORS[currentStatus].border,
                  WATCH_STATUS_COLORS[currentStatus].text,
                )}
              >
                {WATCH_STATUS_LABELS[currentStatus]}
              </div>
            )}
            {(subtitle || (showLibraryContext && isInLibrary)) && (
              <div className='absolute bottom-1.5 left-1.5 z-10 flex max-w-[calc(100%-12px)] flex-col items-start gap-1'>
                {showLibraryContext && isInLibrary && (
                  <div className='rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-[3px] text-[9px] font-semibold text-emerald-300 backdrop-blur-sm'>
                    In Library
                  </div>
                )}
                {subtitle && (
                  <div className='rounded bg-black/70 px-1.5 py-[3px] text-[9px] font-semibold text-white/80 backdrop-blur-sm'>
                    {subtitle}
                  </div>
                )}
              </div>
            )}
            {showProgress && (
              <div className='absolute bottom-0 left-0 right-0 h-1 bg-zinc-800/50 z-20'>
                <div className='h-full bg-white' style={{ width: `${safeProgress}%` }} />
              </div>
            )}
          </div>
        </div>
      </Link>

      {/* Title + year below poster */}
      <div className='mt-2 px-0.5 space-y-0.5'>
        <p className='text-[12.5px] font-medium text-white/90 leading-tight line-clamp-2 tracking-[-0.01em]'>
          {item.title}
        </p>
        {item.year && (
          <p className='text-[11px] text-zinc-500 leading-none'>{item.year.split('-')[0]}</p>
        )}
      </div>

      {/* ── Hover popup card — rendered via portal so it never affects page scroll ── */}
      {showPopup &&
        popupPos &&
        createPortal(
          // Outer shell anchors the popup; interactions are handled by inner content.
          <div
            style={{
              position: 'fixed',
              top: popupPos.top,
              left: popupPos.left,
              width: POPUP_W,
              zIndex: 99999,
            }}
          >
            {/* Inner content remains interactive so status/list buttons are clickable. */}
            <div
              ref={popupContainerRef}
              className='rounded-md overflow-hidden bg-[#111114] border border-white/[0.07] shadow-[0_20px_48px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.04)]'
              style={{
                willChange: 'transform, opacity',
                transform: 'translateZ(0)',
                animation: 'mediaCardPopupIn 160ms cubic-bezier(0.16, 1, 0.3, 1) both',
                pointerEvents: 'auto',
              }}
              onMouseEnter={() => {
                if (leaveTimer.current) {
                  clearTimeout(leaveTimer.current);
                  leaveTimer.current = null;
                }
              }}
              onMouseLeave={handleMouseLeave}
              onWheel={forwardWheelToScrollContainer}
            >
              {/* Backdrop / trailer area */}
              <div className='relative overflow-hidden bg-zinc-900 aspect-video max-h-[160px]'>
                {playingTrailer && trailerPreviewUrl ? (
                  <>
                    <iframe
                      src={trailerPreviewUrl}
                      className='absolute inset-0 w-full h-full border-0 pointer-events-none'
                      allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
                      referrerPolicy='strict-origin-when-cross-origin'
                      title='Trailer preview'
                    />
                    <button
                      type='button'
                      className='absolute bottom-2 right-2 z-10 h-6 w-6 rounded-full bg-black/50 flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors backdrop-blur-sm'
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTrailerMuted((m) => !m);
                      }}
                    >
                      {trailerMuted ? (
                        <VolumeX className='h-3.5 w-3.5' />
                      ) : (
                        <Volume2 className='h-3.5 w-3.5' />
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    {backdropSrc && (
                      <img
                        src={backdropSrc}
                        alt={item.title}
                        className='object-cover w-full h-full'
                      />
                    )}
                    <div className='absolute inset-0 bg-gradient-to-t from-[#111114] via-[#111114]/40 to-transparent' />
                    {trailerVideoId && (
                      <button
                        type='button'
                        className='absolute bottom-2 right-2 z-10 h-6 w-6 rounded-full bg-black/50 flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors backdrop-blur-sm'
                        title='Play trailer'
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setPlayingTrailer(true);
                        }}
                      >
                        <Play className='h-3 w-3 fill-current ml-0.5' />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* ── List picker panel ── (replaces info panel when open) */}
              {showListPicker ? (
                <div className='relative z-10 p-3 space-y-1.5'>
                  <div className='flex items-center gap-1.5 mb-2'>
                    <button
                      type='button'
                      className='h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0'
                      onClick={toggleListPicker}
                    >
                      <ChevronLeft className='h-3.5 w-3.5' />
                    </button>
                    <span className='text-[12px] font-semibold text-white'>Add to List</span>
                  </div>

                  <div className='space-y-0.5 max-h-36 overflow-y-auto'>
                    {lists && lists.length > 0 ? (
                      lists.map((list) => {
                        const isInThisList = itemListIds?.includes(list.id) ?? false;
                        return (
                          <button
                            key={list.id}
                            type='button'
                            className='w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/8 transition-colors text-left'
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              addToList.mutate(list);
                            }}
                            disabled={addToList.isPending}
                          >
                            <span className='text-zinc-400 shrink-0'>
                              <ListIcon iconId={list.icon} size={13} />
                            </span>
                            <span className='flex-1 truncate text-[11px] text-zinc-200'>
                              {list.name}
                            </span>
                            <span className='text-zinc-600 text-[10px] shrink-0'>
                              {list.item_ids.length}
                            </span>
                            {isInThisList && (
                              <Check className='w-3 h-3 text-emerald-400 shrink-0' />
                            )}
                          </button>
                        );
                      })
                    ) : (
                      <p className='text-[11px] text-zinc-600 px-2 py-1'>No lists yet</p>
                    )}
                  </div>

                  <div className='pt-1 border-t border-white/[0.06]'>
                    <button
                      type='button'
                      className='w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/8 transition-colors text-zinc-400 hover:text-white'
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCreateListOpen(true);
                      }}
                    >
                      <ListPlus className='h-3.5 w-3.5 shrink-0' />
                      <span className='text-[11px]'>Create New List…</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* ── Normal info panel ── */
                <div className='relative z-10 p-3 space-y-2'>
                  {/* Title + year on same row */}
                  <div className='flex items-start justify-between gap-2'>
                    <h3 className='font-semibold text-[13px] text-white leading-snug line-clamp-2 flex-1 tracking-[-0.01em]'>
                      {item.title}
                    </h3>
                    {ratingStyle && ratingScore !== null && (
                      <span
                        className={cn(
                          'shrink-0 px-1.5 py-[3px] rounded text-[10px] font-bold border mt-0.5',
                          ratingStyle.bg,
                          ratingStyle.border,
                          ratingStyle.text,
                        )}
                      >
                        ★ {ratingRaw}
                      </span>
                    )}
                  </div>

                  {/* Metadata row */}
                  <div className='flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 leading-none'>
                    <span className='text-zinc-400 font-medium'>
                      {item.type === 'series' ? 'TV Series' : 'Movie'}
                    </span>
                    {episodeLabel && (
                      <>
                        <span className='text-zinc-700'>·</span>
                        <span>{episodeLabel}</span>
                      </>
                    )}
                    {item.year && (
                      <>
                        <span className='text-zinc-700'>·</span>
                        <span>{item.year.split('-')[0]}</span>
                      </>
                    )}
                  </div>

                  {/* Short description */}
                  {(details?.description || item.description) && (
                    <p className='text-[11px] text-zinc-500 line-clamp-2 leading-[1.5]'>
                      {details?.description ?? item.description}
                    </p>
                  )}

                  {/* Action buttons */}
                  <div className='flex items-center gap-2 pt-0.5'>
                    <button
                      type='button'
                      className='flex-1 h-8 flex items-center justify-center gap-1.5 rounded-lg bg-white text-black text-[11.5px] font-semibold hover:bg-white/90 active:scale-[0.98] transition-all duration-100'
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (onPlay) onPlay(e);
                        else navigate(`/details/${item.type}/${item.id}`, { state: { from } });
                      }}
                    >
                      <Play className='h-3 w-3 fill-current' />
                      Watch
                    </button>

                    {/* Library toggle */}
                    <button
                      type='button'
                      className={cn(
                        'h-8 w-8 rounded-lg flex items-center justify-center border transition-all duration-100 active:scale-95 shrink-0',
                        isInLibrary
                          ? 'bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30'
                          : 'bg-white/[0.06] text-zinc-400 border-white/[0.08] hover:bg-white/[0.12] hover:text-white hover:border-white/15',
                      )}
                      title={isInLibrary ? 'Remove from Library' : 'Add to Library'}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleLibrary.mutate(e);
                      }}
                    >
                      {isInLibrary ? (
                        <Check className='h-3.5 w-3.5' />
                      ) : (
                        <Plus className='h-3.5 w-3.5' />
                      )}
                    </button>

                    {/* Lists button */}
                    <button
                      type='button'
                      className={cn(
                        'h-8 w-8 rounded-lg flex items-center justify-center border transition-all duration-100 active:scale-95 shrink-0',
                        isInAnyList
                          ? 'bg-violet-500/20 text-violet-400 border-violet-500/30 hover:bg-violet-500/30'
                          : 'bg-white/[0.06] text-zinc-400 border-white/[0.08] hover:bg-white/[0.12] hover:text-white hover:border-white/15',
                      )}
                      title='Add to List'
                      onClick={toggleListPicker}
                    >
                      {isInAnyList ? (
                        <BookmarkCheck className='h-3.5 w-3.5' />
                      ) : (
                        <Bookmark className='h-3.5 w-3.5' />
                      )}
                    </button>

                    {/* Continue-watching remove button (used by Resume section) */}
                    {onRemoveFromContinue && (
                      <button
                        type='button'
                        className='h-8 w-8 rounded-lg flex items-center justify-center border transition-all duration-100 active:scale-95 shrink-0 bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25 hover:text-red-300'
                        title='Remove from Continue Watching'
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onRemoveFromContinue(e);
                          closePopup();
                        }}
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                    )}
                  </div>

                  {/* ── Watch status pills ── */}
                  <div className='flex gap-1'>
                    {WATCH_STATUS_ORDER.map((status) => {
                      const isActive = currentStatus === status;
                      const colors = WATCH_STATUS_COLORS[status];
                      return (
                        <button
                          key={status}
                          type='button'
                          className={cn(
                            'flex-1 h-7 rounded-lg text-[11px] font-semibold border transition-all duration-100',
                            isActive
                              ? cn(colors.bg, colors.border, colors.text)
                              : 'bg-white/[0.06] border-white/[0.1] text-zinc-400 hover:bg-white/12 hover:text-zinc-100 hover:border-white/20',
                          )}
                          title={WATCH_STATUS_LABELS[status]}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            watchStatusMutation.mutate(isActive ? null : status);
                          }}
                        >
                          {status === 'plan_to_watch'
                            ? 'PTW'
                            : WATCH_STATUS_LABELS[status].split(' ')[0]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Backdrop-level click → navigate to details (below info panel in z-order) */}
              {!showListPicker && (
                <Link
                  to={`/details/${item.type}/${item.id}`}
                  state={{ from }}
                  className='absolute inset-0 z-0'
                  onClick={
                    onPlay
                      ? (e) => {
                          e.preventDefault();
                          onPlay(e);
                        }
                      : undefined
                  }
                  tabIndex={-1}
                  aria-hidden
                />
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Create list dialog — portalled outside popup to not trigger mouse-leave */}
      <CreateListDialog
        open={createListOpen}
        onOpenChange={(open) => {
          setCreateListOpen(open);
          createListOpenRef.current = open;
          if (!open) {
            // Dialog closed — restore list picker lock so popup stays open for further actions
            showListPickerRef.current = true;
          }
        }}
        onCreated={(newList) => {
          addToList.mutate(newList);
        }}
      />
    </div>
  );
}

export function MediaCardSkeleton() {
  return (
    <div className='space-y-2'>
      <div className='aspect-[2/3] rounded-xl bg-zinc-900/50 animate-pulse border border-white/5' />
      <div className='h-3.5 rounded-md bg-zinc-900/40 animate-pulse w-3/4' />
      <div className='h-3 rounded-md bg-zinc-900/30 animate-pulse w-1/3' />
    </div>
  );
}
