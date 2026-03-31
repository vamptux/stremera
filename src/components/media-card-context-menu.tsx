import { useState, useEffect, useRef } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { MediaItem, UserList, api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Library,
  ListPlus,
  Check,
  Plus,
  Trash2,
  ExternalLink,
  Play,
  BookmarkPlus,
  Loader2,
  X,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CreateListDialog } from '@/components/list/create-list-dialog';
import { ListIcon } from '@/components/list/list-icons';
import {
  buildHistoryPlaybackPlan,
  getHistoryPlaybackFallbackNotice,
} from '@/lib/history-playback';
import { buildPlayerNavigationTarget } from '@/lib/player-navigation';

interface MediaCardContextMenuProps {
  item: MediaItem;
  children: React.ReactNode;
  /** Provided by resume-section — already encodes the exact stream URL + resume position */
  onPlay?: () => void;
}

export function MediaCardContextMenu({ item, children, onPlay }: MediaCardContextMenuProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [createListOpen, setCreateListOpen] = useState(false);
  const [isResolvingPlay, setIsResolvingPlay] = useState(false);

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: library } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
    staleTime: 1000 * 60 * 5,
  });

  const { data: lists } = useQuery({
    queryKey: ['lists'],
    queryFn: api.getLists,
    staleTime: 1000 * 15,
  });

  const { data: itemListIds } = useQuery({
    queryKey: ['item-lists', item.id],
    queryFn: () => api.checkItemInLists(item.id),
    staleTime: 1000 * 15,
  });

  const { data: watchHistory } = useQuery({
    queryKey: ['watch-history'],
    queryFn: api.getWatchHistory,
    staleTime: 1000 * 30,
  });

  // Guard against calling setState after the context-menu has been unmounted
  // (can happen if the user navigates away while a stream is being resolved).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const isInLibrary = library?.some((l) => l.id === item.id) ?? false;

  // For series there may be multiple episodes in history — grab the most recent.
  const historyEntry = watchHistory
    ? [...watchHistory]
        .filter((h) => h.id === item.id)
        .sort((a, b) => b.last_watched - a.last_watched)[0]
    : undefined;

  const isInContinueWatching = !!historyEntry;

  // ── Library toggle ───────────────────────────────────────────────────────────

  const toggleLibrary = useMutation({
    mutationFn: async () => {
      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return 'removed' as const;
      }
      await api.addToLibrary(item);
      return 'added' as const;
    },
    onSuccess: (action) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      toast.success(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        description: item.title,
      });
    },
    onError: () => toast.error('Failed to update library'),
  });

  // ── Remove from Library (+ optionally CW) ───────────────────────────────────

  const removeFromLibrary = useMutation({
    mutationFn: async () => {
      // Remove from library — silently swallow if not present
      try {
        await api.removeFromLibrary(item.id);
      } catch {
        // not in library — nothing to do
      }
      // If the item is also in Continue Watching, clear it too
      if (historyEntry) {
        try {
          await api.removeFromWatchHistory(
            item.id,
            historyEntry.type_,
            historyEntry.season,
            historyEntry.episode,
          );
        } catch {
          // best-effort
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      const extra = historyEntry ? ' & Continue Watching' : '';
      toast.success(`Removed from Library${extra}`, { description: item.title });
    },
    onError: () => toast.error('Failed to remove from library'),
  });

  // ── Remove from Continue Watching ────────────────────────────────────────────

  const removeFromCW = useMutation({
    mutationFn: async () => {
      if (!historyEntry) return;
      await api.removeAllFromWatchHistory(item.id, historyEntry.type_);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      queryClient.invalidateQueries({ queryKey: ['watch-history'] });
      toast.success('Removed from Continue Watching', { description: item.title });
    },
    onError: () => toast.error('Failed to remove from Continue Watching'),
  });

  // ── Add / remove from list ────────────────────────────────────────────────────

  const addToList = useMutation({
    mutationFn: async (list: UserList) => {
      if (itemListIds?.includes(list.id)) {
        await api.removeFromList(list.id, item.id);
        return { action: 'removed' as const, listName: list.name };
      }
      await api.addToList(list.id, item);
      return { action: 'added' as const, listName: list.name };
    },
    onSuccess: ({ action, listName }) => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
      queryClient.invalidateQueries({ queryKey: ['item-lists', item.id] });
      toast.success(action === 'added' ? `Added to "${listName}"` : `Removed from "${listName}"`, {
        description: item.title,
      });
    },
    onError: () => toast.error('Failed to update list'),
  });

  // ── Play ──────────────────────────────────────────────────────────────────────
  //
  // Priority order:
  //   1. onPlay is provided (ResumeCard path) → use it directly; it already has
  //      the correct stream URL, startTime, season/episode, etc.
  //   2. Item has a history entry (was watched) → replay via last stream URL,
  //      exactly mirroring ResumeCard.handlePlay.
  //   3. Movie with no history → resolve best stream then navigate to player.
  //   4. Series with no history → navigate to details page to pick an episode.
  const playbackType: 'movie' | 'series' | 'anime' =
    item.type === 'movie'
      ? 'movie'
      : item.id.trim().toLowerCase().startsWith('kitsu:')
        ? 'anime'
        : 'series';

  const handlePlay = async () => {
    // ── Case 1: parent already knows how to play (e.g. ResumeCard) ──
    if (onPlay) {
      onPlay();
      return;
    }

    const from = `${location.pathname}${location.search}`;

    // ── Case 2: resume from last known position ──
    if (historyEntry) {
      const hasSeriesEpisodeContext =
        historyEntry.type_ !== 'series' ||
        (typeof historyEntry.season === 'number' && typeof historyEntry.episode === 'number');

      if (!hasSeriesEpisodeContext) {
        const notice = getHistoryPlaybackFallbackNotice('missing-episode-context', 'open-details');
        toast.info(notice.title, { description: notice.description });
        navigate(`/details/${playbackType}/${item.id}`, { state: { from } });
        return;
      }

      try {
        const plan = await buildHistoryPlaybackPlan(historyEntry, from);

        if (plan.kind === 'details') {
          const notice = getHistoryPlaybackFallbackNotice(plan.reason, 'open-details');
          toast.info(notice.title, { description: notice.description });
          navigate(plan.target, { state: plan.state });
          return;
        }

        navigate(plan.target, { state: plan.state });
      } catch (err) {
        toast.error('Failed to resume playback', {
          description: err instanceof Error ? err.message : 'Please try again.',
        });
      }
      return;
    }

    // ── Case 3: series with no history → details page ──
    if (item.type === 'series') {
      navigate(`/details/${playbackType}/${item.id}`, { state: { from } });
      return;
    }

    // ── Case 4: movie with no history → resolve best stream ──
    setIsResolvingPlay(true);
    const toastId = toast.loading('Finding best stream…', { description: item.title });

    try {
      const resolved = await api.resolveBestStream(playbackType, item.id);

      toast.dismiss(toastId);

      if (!resolved?.url) {
        toast.error('No streams found', { description: item.title });
        navigate(`/details/${playbackType}/${item.id}`, { state: { from } });
        return;
      }

      const playerNavigation = buildPlayerNavigationTarget(playbackType, item.id, {
        streamUrl: resolved.url,
        title: item.title,
        poster: item.poster,
        backdrop: item.backdrop,
        streamSourceName: resolved.source_name,
        streamFamily: resolved.stream_family,
        format: resolved.format,
        from,
      });

      navigate(playerNavigation.target, { state: playerNavigation.state });
    } catch {
      toast.dismiss(toastId);
      toast.error('Could not resolve stream', { description: 'Opening details page instead…' });
      navigate(`/details/${playbackType}/${item.id}`, { state: { from } });
    } finally {
      if (isMountedRef.current) setIsResolvingPlay(false);
    }
  };

  // ── After-create: auto-add to the newly created list ────────────────────────

  const handleCreateAndAdd = async (newList: UserList) => {
    try {
      await api.addToList(newList.id, item);
      queryClient.invalidateQueries({ queryKey: ['lists'] });
      queryClient.invalidateQueries({ queryKey: ['item-lists', item.id] });
      toast.success(`Added to "${newList.name}"`, { description: item.title });
    } catch {
      // list was created; add failed silently — user can add manually
    }
  };

  // ── Play button label ────────────────────────────────────────────────────────

  const playLabel = (() => {
    if (isResolvingPlay) return 'Resolving…';
    if (onPlay || historyEntry) return 'Resume';
    if (item.type === 'series') return 'View & Play';
    return 'Play';
  })();

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>

        <ContextMenuContent className='w-56 bg-zinc-950 border-zinc-800 text-zinc-200 shadow-2xl shadow-black/60 p-1'>
          {/* Title */}
          <ContextMenuLabel className='text-[11px] font-bold text-zinc-500 uppercase tracking-widest px-2 py-1.5 truncate'>
            {item.title}
          </ContextMenuLabel>
          <ContextMenuSeparator className='bg-zinc-800 my-1' />

          {/* Play / Resume */}
          <ContextMenuItem
            className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white rounded-md'
            onClick={handlePlay}
            disabled={isResolvingPlay}
          >
            {isResolvingPlay ? (
              <Loader2 className='w-3.5 h-3.5 animate-spin' />
            ) : (
              <Play className='w-3.5 h-3.5' />
            )}
            {playLabel}
          </ContextMenuItem>

          <ContextMenuItem
            className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white rounded-md'
            onClick={() =>
              navigate(`/details/${playbackType}/${item.id}`, {
                state: { from: `${location.pathname}${location.search}` },
              })
            }
          >
            <ExternalLink className='w-3.5 h-3.5' />
            Open Details
          </ContextMenuItem>

          <ContextMenuSeparator className='bg-zinc-800 my-1' />

          {/* Library toggle */}
          <ContextMenuItem
            className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white rounded-md'
            onClick={() => toggleLibrary.mutate()}
            disabled={toggleLibrary.isPending}
          >
            {isInLibrary ? (
              <>
                <Check className='w-3.5 h-3.5 text-emerald-400' />
                <span className='text-emerald-400'>In Library</span>
              </>
            ) : (
              <>
                <Library className='w-3.5 h-3.5' />
                Add to Library
              </>
            )}
          </ContextMenuItem>

          {/* Remove from Continue Watching — only visible when applicable */}
          {isInContinueWatching && (
            <ContextMenuItem
              className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white rounded-md'
              onClick={() => removeFromCW.mutate()}
              disabled={removeFromCW.isPending}
            >
              <X className='w-3.5 h-3.5' />
              Remove from Continue Watching
            </ContextMenuItem>
          )}

          <ContextMenuSeparator className='bg-zinc-800 my-1' />

          {/* Add to list sub-menu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white data-[state=open]:bg-white/10 rounded-md'>
              <BookmarkPlus className='w-3.5 h-3.5' />
              Add to List
            </ContextMenuSubTrigger>

            <ContextMenuSubContent className='w-52 bg-zinc-950 border-zinc-800 text-zinc-200 shadow-2xl shadow-black/60 max-h-72 overflow-y-auto p-1'>
              {lists && lists.length > 0 ? (
                <>
                  {lists.map((list) => {
                    const isInThisList = itemListIds?.includes(list.id) ?? false;
                    return (
                      <ContextMenuItem
                        key={list.id}
                        className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white rounded-md'
                        onClick={() => addToList.mutate(list)}
                        disabled={addToList.isPending}
                      >
                        <span className='text-zinc-400 shrink-0'>
                          <ListIcon iconId={list.icon} size={14} />
                        </span>
                        <span className='flex-1 truncate'>{list.name}</span>
                        <span className='text-zinc-600 text-[10px]'>{list.item_ids.length}</span>
                        {isInThisList && <Check className='w-3 h-3 text-emerald-400 shrink-0' />}
                      </ContextMenuItem>
                    );
                  })}
                  <ContextMenuSeparator className='bg-zinc-800 my-1' />
                </>
              ) : (
                <ContextMenuLabel className='text-[11px] text-zinc-600 px-2 py-1.5'>
                  No lists yet
                </ContextMenuLabel>
              )}

              <ContextMenuItem
                className='gap-2.5 cursor-pointer focus:bg-white/10 focus:text-white text-zinc-400 rounded-md'
                onClick={() => setCreateListOpen(true)}
              >
                <ListPlus className='w-3.5 h-3.5' />
                Create New List…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Quick-add shortcuts (first 3 lists) */}
          {lists && lists.length > 0 && (
            <>
              <ContextMenuSeparator className='bg-zinc-800 my-1' />
              <ContextMenuLabel className='text-[10px] font-bold text-zinc-600 uppercase tracking-widest px-2 py-1'>
                Quick Add
              </ContextMenuLabel>
              {lists.slice(0, 3).map((list) => {
                const isInThisList = itemListIds?.includes(list.id) ?? false;
                return (
                  <ContextMenuItem
                    key={`quick-${list.id}`}
                    className='gap-2 cursor-pointer focus:bg-white/10 focus:text-white text-zinc-400 hover:text-white rounded-md'
                    onClick={() => addToList.mutate(list)}
                    disabled={addToList.isPending}
                  >
                    <span className='text-zinc-500 shrink-0'>
                      <ListIcon iconId={list.icon} size={13} />
                    </span>
                    <span className='flex-1 truncate text-[12px]'>{list.name}</span>
                    {isInThisList ? (
                      <Check className='w-3 h-3 text-emerald-400 shrink-0' />
                    ) : (
                      <Plus className='w-3 h-3 shrink-0 opacity-40' />
                    )}
                  </ContextMenuItem>
                );
              })}
            </>
          )}

          <ContextMenuSeparator className='bg-zinc-800 my-1' />

          {/* Destructive: remove from library (+ CW if present) */}
          <ContextMenuItem
            className='gap-2.5 cursor-pointer focus:bg-red-500/20 focus:text-red-400 text-zinc-500 rounded-md'
            onClick={() => removeFromLibrary.mutate()}
            disabled={removeFromLibrary.isPending}
          >
            <Trash2 className='w-3.5 h-3.5' />
            Remove from Library
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <CreateListDialog
        open={createListOpen}
        onOpenChange={setCreateListOpen}
        onCreated={handleCreateAndAdd}
      />
    </>
  );
}
