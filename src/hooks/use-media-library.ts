import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import {
  api,
  type MediaItem,
  type UserList,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import {
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueries,
} from '@/lib/query-invalidation';

const LIBRARY_QUERY_KEY = ['library'] as const;
const CONTINUE_WATCHING_QUERY_KEY = ['continue-watching'] as const;
const WATCH_HISTORY_QUERY_KEY = ['watch-history'] as const;
const WATCH_STATUSES_QUERY_KEY = ['watch-statuses'] as const;
const LISTS_QUERY_KEY = ['lists'] as const;
const LIBRARY_STALE_TIME = 1000 * 60 * 5;
const CONTINUE_WATCHING_STALE_TIME = 1000 * 30;
const WATCH_HISTORY_STALE_TIME = 1000 * 30;
const WATCH_STATUSES_STALE_TIME = 1000 * 60 * 5;
const LISTS_STALE_TIME = 1000 * 15;

interface SharedCollectionQueryOptions {
  enabled?: boolean;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  staleTime?: number;
}

interface UseLatestWatchHistoryEntryOptions {
  enabled?: boolean;
}

interface UseMediaCollectionActionsOptions {
  item: MediaItem;
  isInLibrary: boolean;
  itemListIds?: string[];
  lists?: UserList[];
  optimisticLibrary?: boolean;
}

interface ToggleLibraryMutationContext {
  previousLibrary?: MediaItem[];
}

interface UseToggleLibraryItemOptions {
  item?: MediaItem | null;
  isInLibrary: boolean;
  optimistic?: boolean;
}

interface UseRemoveLibraryItemOptions {
  clearContinueWatching?: boolean;
  continueWatchingMediaType?: string | null;
  itemId: string;
  itemTitle?: string;
}

interface UseRemoveFromContinueWatchingOptions {
  itemId: string;
  itemTitle?: string;
  mediaType?: string | null;
}

function findLatestWatchHistoryEntry(
  entries: WatchProgress[],
  itemId: string,
): WatchProgress | undefined {
  let latestEntry: WatchProgress | undefined;

  for (const entry of entries) {
    if (entry.id !== itemId) {
      continue;
    }

    if (!latestEntry || entry.last_watched > latestEntry.last_watched) {
      latestEntry = entry;
    }
  }

  return latestEntry;
}

function buildOtherListsDescription(
  lists: UserList[] | undefined,
  itemListIds: string[] | undefined,
  addedListId: string,
) {
  const alreadyIn = lists?.filter(
    (list) => list.id !== addedListId && itemListIds?.includes(list.id),
  );

  if (!alreadyIn || alreadyIn.length === 0) {
    return null;
  }

  const names = alreadyIn.map((list) => `"${list.name}"`).join(', ');
  return `Also in ${names}`;
}

function resolveSharedCollectionQueryOptions(
  options: SharedCollectionQueryOptions | undefined,
  defaultStaleTime: number,
) {
  return {
    enabled: options?.enabled,
    gcTime: options?.gcTime,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    staleTime: options?.staleTime ?? defaultStaleTime,
  };
}

function itemListsQueryKey(itemId: string) {
  return ['item-lists', itemId] as const;
}

export function useLibraryItems(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: api.getLibrary,
    ...resolveSharedCollectionQueryOptions(options, LIBRARY_STALE_TIME),
  });
}

export function useWatchStatuses(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: WATCH_STATUSES_QUERY_KEY,
    queryFn: api.getAllWatchStatuses,
    ...resolveSharedCollectionQueryOptions(options, WATCH_STATUSES_STALE_TIME),
  });
}

export function useWatchHistory(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: WATCH_HISTORY_QUERY_KEY,
    queryFn: api.getWatchHistory,
    ...resolveSharedCollectionQueryOptions(options, WATCH_HISTORY_STALE_TIME),
  });
}

export function useContinueWatching(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: CONTINUE_WATCHING_QUERY_KEY,
    queryFn: api.getContinueWatching,
    ...resolveSharedCollectionQueryOptions(options, CONTINUE_WATCHING_STALE_TIME),
  });
}

export function useLists(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: LISTS_QUERY_KEY,
    queryFn: api.getLists,
    ...resolveSharedCollectionQueryOptions(options, LISTS_STALE_TIME),
  });
}

export function useItemListIds(itemId?: string, options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: itemId ? itemListsQueryKey(itemId) : ['item-lists', 'unknown'],
    queryFn: () =>
      itemId
        ? api.checkItemInLists(itemId)
        : Promise.reject(new Error('Item ID is required to read list membership.')),
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    gcTime: options?.gcTime,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    staleTime: options?.staleTime ?? LISTS_STALE_TIME,
  });
}

export function useIsItemInLibrary(itemId?: string, options?: SharedCollectionQueryOptions) {
  const selectMembership = useCallback(
    (library: MediaItem[]) => Boolean(itemId && library.some((item) => item.id === itemId)),
    [itemId],
  );

  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: api.getLibrary,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    gcTime: options?.gcTime,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    staleTime: options?.staleTime ?? LIBRARY_STALE_TIME,
    select: selectMembership,
  });
}

export function useItemWatchStatus(itemId?: string, options?: SharedCollectionQueryOptions) {
  const selectWatchStatus = useCallback(
    (statuses: Record<string, WatchStatus>) => (itemId ? (statuses[itemId] ?? null) : null),
    [itemId],
  );

  return useQuery({
    queryKey: WATCH_STATUSES_QUERY_KEY,
    queryFn: api.getAllWatchStatuses,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    gcTime: options?.gcTime,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    staleTime: options?.staleTime ?? WATCH_STATUSES_STALE_TIME,
    select: selectWatchStatus,
  });
}

export function useLatestWatchHistoryEntry(
  itemId?: string,
  options?: UseLatestWatchHistoryEntryOptions,
) {
  const selectLatestEntry = useCallback(
    (entries: WatchProgress[]) =>
      itemId ? findLatestWatchHistoryEntry(entries, itemId) : undefined,
    [itemId],
  );

  return useQuery({
    queryKey: WATCH_HISTORY_QUERY_KEY,
    queryFn: api.getWatchHistory,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    staleTime: WATCH_HISTORY_STALE_TIME,
    select: selectLatestEntry,
  });
}

export function useToggleLibraryItem({
  item,
  isInLibrary,
  optimistic = false,
}: UseToggleLibraryItemOptions) {
  const queryClient = useQueryClient();

  return useMutation<'added' | 'removed', unknown, void, ToggleLibraryMutationContext>({
    mutationFn: async () => {
      if (!item) {
        throw new Error('Media item unavailable');
      }

      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return 'removed' as const;
      }

      await api.addToLibrary(item);
      return 'added' as const;
    },
    onMutate: optimistic
      ? async () => {
          if (!item) {
            return { previousLibrary: undefined };
          }

          await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
          const previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY);

          queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => {
            if (isInLibrary) {
              return old?.filter((libraryItem) => libraryItem.id !== item.id) ?? [];
            }

            return [...(old ?? []), item];
          });

          return { previousLibrary };
        }
      : undefined,
    onError: (_error, _variables, context) => {
      if (context?.previousLibrary !== undefined) {
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, context.previousLibrary);
      }

      toast.error('Failed to update library');
    },
    onSuccess: (action) => {
      if (!item) {
        return;
      }

      toast.success(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        description: item.title,
      });
    },
    onSettled: () => {
      void invalidateLibraryQueries(queryClient);
    },
  });
}

export function useRemoveLibraryItem({
  clearContinueWatching = false,
  continueWatchingMediaType,
  itemId,
  itemTitle,
}: UseRemoveLibraryItemOptions) {
  const queryClient = useQueryClient();
  const normalizedContinueWatchingMediaType = continueWatchingMediaType?.trim();
  const shouldClearContinueWatching =
    clearContinueWatching && Boolean(normalizedContinueWatchingMediaType);

  return useMutation({
    mutationFn: async () => {
      await api.removeFromLibrary(itemId);

      if (shouldClearContinueWatching && normalizedContinueWatchingMediaType) {
        await api.removeAllFromWatchHistory(itemId, normalizedContinueWatchingMediaType);
      }
    },
    onSuccess: () => {
      void Promise.all([
        invalidateLibraryQueries(queryClient),
        ...(shouldClearContinueWatching ? [invalidatePlaybackHistoryQueries(queryClient)] : []),
      ]);

      const message = shouldClearContinueWatching
        ? 'Removed from Library & Continue Watching'
        : 'Removed from Library';

      if (itemTitle) {
        toast.success(message, { description: itemTitle });
        return;
      }

      toast.success(message);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove from library');
    },
  });
}

export function useRemoveFromContinueWatching({
  itemId,
  itemTitle,
  mediaType,
}: UseRemoveFromContinueWatchingOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const normalizedMediaType = mediaType?.trim();
      if (!normalizedMediaType) {
        throw new Error('Playback history metadata unavailable');
      }

      await api.removeAllFromWatchHistory(itemId, normalizedMediaType);
    },
    onSuccess: () => {
      void invalidatePlaybackHistoryQueries(queryClient);

      if (itemTitle) {
        toast.success('Removed from Continue Watching', { description: itemTitle });
        return;
      }

      toast.success('Removed from Continue Watching');
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Failed to remove from Continue Watching',
      );
    },
  });
}

export function useMediaCollectionActions({
  item,
  isInLibrary,
  itemListIds,
  lists,
  optimisticLibrary = false,
}: UseMediaCollectionActionsOptions) {
  const queryClient = useQueryClient();
  const toggleLibrary = useToggleLibraryItem({
    item,
    isInLibrary,
    optimistic: optimisticLibrary,
  });

  const toggleListMembership = useMutation({
    mutationFn: async (list: UserList) => {
      if (itemListIds?.includes(list.id)) {
        await api.removeFromList(list.id, item.id);
        return { action: 'removed' as const, list };
      }

      await api.addToList(list.id, item);
      return { action: 'added' as const, list };
    },
    onSuccess: ({ action, list }) => {
      void invalidateListQueries(queryClient, item.id);

      if (action === 'added') {
        toast.success(`Added to "${list.name}"`, {
          description: buildOtherListsDescription(lists, itemListIds, list.id) ?? item.title,
        });
        return;
      }

      toast.success(`Removed from "${list.name}"`, { description: item.title });
    },
    onError: () => {
      toast.error('Failed to update list');
    },
  });

  const addItemToNewList = useCallback(
    async (list: UserList) => {
      try {
        await api.addToList(list.id, item);
        await invalidateListQueries(queryClient, item.id);
        toast.success(`Added to "${list.name}"`, {
          description: buildOtherListsDescription(lists, itemListIds, list.id) ?? item.title,
        });
      } catch {
        // The list was created successfully; membership can still be retried manually.
      }
    },
    [item, itemListIds, lists, queryClient],
  );

  return {
    addItemToNewList,
    toggleLibrary,
    toggleListMembership,
  };
}
