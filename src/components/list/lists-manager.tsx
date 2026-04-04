import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, UserList, MediaItem } from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { invalidateListQueries } from '@/lib/query-invalidation';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import {
  GripVertical,
  ChevronDown,
  ChevronRight,
  ListPlus,
  Pencil,
  Trash2,
  Search,
  X,
  Film,
  Tv,
  LayoutGrid,
  LayoutList,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CreateListDialog, RenameListDialog } from '@/components/list/list-editor-dialog';
import { ListIcon } from '@/components/list/list-icons';

// ─── Sortable List Card ────────────────────────────────────────────────────────

interface SortableListCardProps {
  list: UserList;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onRename: (list: UserList) => void;
  onDelete: (list: UserList) => void;
}

function SortableListCard({
  list,
  isExpanded,
  onToggleExpand,
  onRename,
  onDelete,
}: SortableListCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-xl border transition-all duration-200',
        isDragging
          ? 'opacity-40 border-white/20 bg-zinc-900/80 scale-[0.98]'
          : 'border-white/8 bg-zinc-900/40 hover:border-white/15 hover:bg-zinc-900/60',
      )}
    >
      {/* List Header */}
      <div className='flex items-center gap-3 px-4 py-3'>
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className='text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0'
          aria-label='Drag to reorder'
        >
          <GripVertical className='w-4 h-4' />
        </button>

        {/* Expand toggle */}
        <button
          onClick={() => onToggleExpand(list.id)}
          className='flex items-center gap-3 flex-1 min-w-0 group'
        >
          <span className='shrink-0 text-zinc-300'>
            <ListIcon iconId={list.icon} size={16} />
          </span>
          <div className='flex-1 min-w-0 text-left'>
            <div className='flex items-center gap-2'>
              <span className='font-semibold text-sm text-zinc-200 group-hover:text-white transition-colors truncate'>
                {list.name}
              </span>
              <span className='text-[10px] font-bold text-zinc-600 bg-zinc-800/80 px-1.5 py-0.5 rounded-full shrink-0'>
                {list.item_ids.length}
              </span>
            </div>
          </div>
          <div className='text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0 ml-2'>
            {isExpanded ? (
              <ChevronDown className='w-4 h-4' />
            ) : (
              <ChevronRight className='w-4 h-4' />
            )}
          </div>
        </button>

        {/* Actions */}
        <div className='flex items-center gap-1 shrink-0'>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onRename(list)}
            className='h-7 w-7 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/8'
          >
            <Pencil className='w-3.5 h-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onDelete(list)}
            className='h-7 w-7 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
          >
            <Trash2 className='w-3.5 h-3.5' />
          </Button>
        </div>
      </div>

      {/* Expanded items */}
      {isExpanded && (
        <div className='border-t border-white/5'>
          <ListItemsView list={list} />
        </div>
      )}
    </div>
  );
}

// ─── Sortable Item Row ─────────────────────────────────────────────────────────

interface SortableItemRowProps {
  item: MediaItem;
  listId: string;
  viewMode: 'grid' | 'list';
}

function SortableItemRow({ item, listId, viewMode }: SortableItemRowProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailsRouteType = resolvePlayerRouteMediaType(item.type, item.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${listId}::${item.id}`,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const removeItem = useMutation({
    mutationFn: () => api.removeFromList(listId, item.id),
    onSuccess: () => {
      void invalidateListQueries(queryClient, item.id);
      toast.success(`Removed from list`, { description: item.title });
    },
    onError: () => toast.error('Failed to remove item'),
  });

  if (viewMode === 'grid') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative group rounded-lg overflow-hidden bg-zinc-900/60 transition-all duration-200',
          isDragging ? 'opacity-40 scale-95' : 'hover:ring-1 hover:ring-white/20',
        )}
      >
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className='absolute top-2 left-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing bg-black/60 rounded-md p-1 touch-none'
        >
          <GripVertical className='w-3 h-3 text-white' />
        </div>

        {/* Remove button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeItem.mutate();
          }}
          className='absolute top-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 rounded-md p-1 hover:bg-red-500/80 text-white'
        >
          <X className='w-3 h-3' />
        </button>

        <div
          className='aspect-[2/3] cursor-pointer'
          onClick={() => navigate(`/details/${detailsRouteType}/${item.id}`)}
        >
          {item.poster ? (
            <img
              src={item.poster}
              alt={item.title}
              className='w-full h-full object-cover group-hover:opacity-80 transition-opacity'
              loading='lazy'
            />
          ) : (
            <div className='w-full h-full flex items-center justify-center bg-zinc-800 p-2'>
              {item.type === 'movie' ? (
                <Film className='w-6 h-6 text-zinc-600' />
              ) : (
                <Tv className='w-6 h-6 text-zinc-600' />
              )}
            </div>
          )}
        </div>
        <div className='p-2'>
          <p className='text-[11px] font-medium text-zinc-300 truncate leading-tight'>
            {item.title}
          </p>
          {item.displayYear && (
            <p className='text-[10px] text-zinc-600 capitalize mt-0.5'>
              {item.displayYear}
            </p>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg group transition-all duration-150',
        isDragging ? 'opacity-40 bg-zinc-800/80' : 'hover:bg-white/5',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className='text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0'
      >
        <GripVertical className='w-3.5 h-3.5' />
      </div>

      {/* Poster thumb */}
      <div
        className='h-10 w-7 rounded overflow-hidden bg-zinc-800 shrink-0 cursor-pointer'
        onClick={() => navigate(`/details/${detailsRouteType}/${item.id}`)}
      >
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.title}
            className='w-full h-full object-cover'
            loading='lazy'
          />
        ) : (
          <div className='w-full h-full flex items-center justify-center'>
            {item.type === 'movie' ? (
              <Film className='w-3 h-3 text-zinc-600' />
            ) : (
              <Tv className='w-3 h-3 text-zinc-600' />
            )}
          </div>
        )}
      </div>

      {/* Title info */}
      <div
        className='flex-1 min-w-0 cursor-pointer'
        onClick={() => navigate(`/details/${detailsRouteType}/${item.id}`)}
      >
        <p className='text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate'>
          {item.title}
        </p>
        <div className='flex items-center gap-1.5 mt-0.5'>
          <span className='text-[10px] text-zinc-500 capitalize'>{item.type}</span>
          {item.displayYear && (
            <>
              <span className='text-zinc-700 text-[10px]'>·</span>
              <span className='text-[10px] text-zinc-500'>
                {item.displayYear}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Remove */}
      <Button
        size='icon'
        variant='ghost'
        onClick={() => removeItem.mutate()}
        disabled={removeItem.isPending}
        className='h-7 w-7 rounded-lg text-zinc-700 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all shrink-0'
      >
        <X className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
}

// ─── List Items View (inner DnD for items) ────────────────────────────────────

// Keyed externally by list.id so state resets when the active list changes
function ListItemsView({ list }: { list: UserList }) {
  const queryClient = useQueryClient();

  // Store only the ordered IDs — lightweight and easy to reset.
  // Initialised lazily so it only runs once per mount.
  const [orderedIds, setOrderedIds] = useState<string[]>(() => list.item_ids);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [search, setSearch] = useState('');

  // Derive the full item objects from the user's preferred ordering.
  // • Items removed externally disappear automatically (filter step).
  // • Items added externally via context-menu appear at the end.
  // TanStack Query uses structural sharing, so list.items only gets a new
  // reference when actual data changes — memo recomputes are infrequent.
  const orderedItems = useMemo(() => {
    const itemMap = new Map(list.items.map((i) => [i.id, i]));
    const ordered = orderedIds.filter((id) => itemMap.has(id)).map((id) => itemMap.get(id)!);
    const orderedSet = new Set(orderedIds);
    const added = list.items.filter((i) => !orderedSet.has(i.id));
    return [...ordered, ...added];
  }, [orderedIds, list.items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorderItems = useMutation({
    mutationFn: (newIds: string[]) => api.reorderListItems(list.id, newIds),
    onError: () => {
      // Revert display order to whatever the server currently has
      setOrderedIds(list.item_ids);
      void invalidateListQueries(queryClient);
      toast.error('Failed to save order');
    },
  });

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      // Composite drag IDs are `${listId}::${itemId}` — strip the prefix.
      const prefix = `${list.id}::`;
      const activeItemId = String(active.id).startsWith(prefix)
        ? String(active.id).slice(prefix.length)
        : String(active.id);
      const overItemId = String(over.id).startsWith(prefix)
        ? String(over.id).slice(prefix.length)
        : String(over.id);

      setOrderedIds((prev) => {
        // Ensure both IDs are in the list (handles items added after mount)
        let current = prev.includes(activeItemId) ? prev : [...prev, activeItemId];
        current = current.includes(overItemId) ? current : [...current, overItemId];

        const oldIndex = current.indexOf(activeItemId);
        const newIndex = current.indexOf(overItemId);
        if (oldIndex === -1 || newIndex === -1) return prev;

        const next = arrayMove(current, oldIndex, newIndex);
        reorderItems.mutate(next);
        return next;
      });
    },
    [list.id, reorderItems],
  );

  const filtered = search.trim()
    ? orderedItems.filter((i) => i.title.toLowerCase().includes(search.toLowerCase()))
    : orderedItems;

  const activeItem = activeId ? orderedItems.find((i) => `${list.id}::${i.id}` === activeId) : null;

  if (orderedItems.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-zinc-600 gap-2'>
        <Search className='w-6 h-6' />
        <p className='text-sm'>This list is empty</p>
        <p className='text-xs text-zinc-700'>Right-click any movie or show to add it here.</p>
      </div>
    );
  }

  return (
    <div className='p-3 space-y-3'>
      {/* Toolbar */}
      <div className='flex items-center gap-2'>
        <div className='relative flex-1'>
          <Search className='absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600' />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search in list...'
            className='w-full h-8 pl-8 pr-3 rounded-lg bg-zinc-800/60 border border-white/8 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-white/20 transition-colors'
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className='absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400'
            >
              <X className='w-3 h-3' />
            </button>
          )}
        </div>
        <div className='flex items-center bg-zinc-800/60 rounded-lg border border-white/8 p-0.5'>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'h-6 w-6 rounded-md flex items-center justify-center transition-all',
              viewMode === 'list' ? 'bg-white/15 text-white' : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            <LayoutList className='w-3.5 h-3.5' />
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              'h-6 w-6 rounded-md flex items-center justify-center transition-all',
              viewMode === 'grid' ? 'bg-white/15 text-white' : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            <LayoutGrid className='w-3.5 h-3.5' />
          </button>
        </div>
      </div>

      {/* Items */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={filtered.map((i) => `${list.id}::${i.id}`)}
          strategy={viewMode === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
        >
          {viewMode === 'grid' ? (
            <div className='grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2'>
              {filtered.map((item) => (
                <SortableItemRow key={item.id} item={item} listId={list.id} viewMode='grid' />
              ))}
            </div>
          ) : (
            <div className='space-y-0.5'>
              {filtered.map((item) => (
                <SortableItemRow key={item.id} item={item} listId={list.id} viewMode='list' />
              ))}
            </div>
          )}
        </SortableContext>

        <DragOverlay>
          {activeItem ? (
            <div
              className={cn(
                'rounded-lg bg-zinc-800/90 border border-white/20 shadow-2xl shadow-black/60',
                viewMode === 'grid' ? 'w-20 opacity-90' : 'w-64 opacity-90',
              )}
            >
              {viewMode === 'grid' ? (
                <div className='aspect-[2/3] overflow-hidden rounded-lg'>
                  {activeItem.poster && (
                    <img
                      src={activeItem.poster}
                      alt={activeItem.title}
                      className='w-full h-full object-cover'
                    />
                  )}
                </div>
              ) : (
                <div className='flex items-center gap-3 px-3 py-2.5'>
                  <GripVertical className='w-3.5 h-3.5 text-zinc-400' />
                  {activeItem.poster && (
                    <div className='h-10 w-7 rounded overflow-hidden shrink-0'>
                      <img
                        src={activeItem.poster}
                        alt={activeItem.title}
                        className='w-full h-full object-cover'
                      />
                    </div>
                  )}
                  <span className='text-sm font-medium text-white truncate'>
                    {activeItem.title}
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {search && filtered.length === 0 && (
        <p className='text-xs text-zinc-600 text-center py-4'>
          No items match &ldquo;{search}&rdquo;
        </p>
      )}
    </div>
  );
}

// ─── Ghost Overlay Card (list drag) ──────────────────────────────────────────

function ListGhostCard({ list }: { list: UserList }) {
  return (
    <div className='rounded-xl border border-white/20 bg-zinc-900/90 shadow-2xl shadow-black/60 px-4 py-3 flex items-center gap-3 opacity-90'>
      <GripVertical className='w-4 h-4 text-zinc-500' />
      <span className='text-zinc-300'>
        <ListIcon iconId={list.icon} size={16} />
      </span>
      <span className='font-semibold text-sm text-zinc-200'>{list.name}</span>
      <span className='text-[10px] font-bold text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded-full ml-1'>
        {list.item_ids.length}
      </span>
    </div>
  );
}

// ─── Main ListsManager ────────────────────────────────────────────────────────

export function ListsManager() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UserList | null>(null);
  const [activeListId, setActiveListId] = useState<UniqueIdentifier | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { data: lists = [], isLoading } = useQuery({
    queryKey: ['lists'],
    queryFn: api.getLists,
    staleTime: 1000 * 30,
  });

  const [localLists, setLocalLists] = useState<UserList[]>([]);

  // Sync local state when remote data updates
  const displayLists =
    localLists.length > 0 && localLists.length === lists.length ? localLists : lists;

  const reorderLists = useMutation({
    mutationFn: (ids: string[]) => api.reorderLists(ids),
    onError: () => {
      setLocalLists([]);
      toast.error('Failed to save list order');
    },
  });

  const deleteList = useMutation({
    mutationFn: (id: string) => api.deleteList(id),
    onSuccess: (_, id) => {
      void invalidateListQueries(queryClient);
      setLocalLists([]);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success('List deleted');
    },
    onError: () => toast.error('Failed to delete list'),
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveListId(event.active.id);
    if (localLists.length === 0) setLocalLists(lists);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveListId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      setLocalLists((prev) => {
        const src = prev.length > 0 ? prev : lists;
        const oldIdx = src.findIndex((l) => l.id === active.id);
        const newIdx = src.findIndex((l) => l.id === over.id);
        if (oldIdx === -1 || newIdx === -1) return src;
        const next = arrayMove(src, oldIdx, newIdx);
        reorderLists.mutate(next.map((l) => l.id));
        queryClient.setQueryData(['lists'], next);
        return next;
      });
    },
    [lists, reorderLists, queryClient],
  );

  const activeList = activeListId ? displayLists.find((l) => l.id === activeListId) : null;

  const handleDeleteConfirm = (list: UserList) => {
    if (list.item_ids.length > 0) {
      const confirmed = window.confirm(
        `Delete "${list.name}"? This will remove ${list.item_ids.length} item${list.item_ids.length !== 1 ? 's' : ''} from the list.`,
      );
      if (!confirmed) return;
    }
    deleteList.mutate(list.id);
  };

  return (
    <div className='space-y-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold text-white'>My Lists</h2>
          <p className='text-sm text-zinc-500 mt-0.5'>
            {lists.length > 0
              ? `${lists.length} list${lists.length !== 1 ? 's' : ''} · right-click any title to add`
              : 'Create lists to organise your media'}
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className='bg-white text-black hover:bg-zinc-200 font-semibold gap-2 h-9 px-4 text-sm'
        >
          <ListPlus className='w-4 h-4' />
          New List
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className='space-y-3'>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className='h-14 rounded-xl bg-zinc-900/40 border border-white/5 animate-pulse'
            />
          ))}
        </div>
      ) : displayLists.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-20 gap-5 border border-dashed border-white/10 rounded-3xl bg-zinc-900/20'>
          <div className='w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400'>
            <ListIcon iconId='Film' size={28} />
          </div>
          <div className='text-center'>
            <p className='text-lg font-medium text-zinc-300'>No lists yet</p>
            <p className='text-sm text-zinc-600 mt-1'>
              Create a list, then right-click any movie or show to add it.
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className='bg-white text-black hover:bg-zinc-200 font-semibold gap-2'
          >
            <ListPlus className='w-4 h-4' />
            Create your first list
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={displayLists.map((l) => l.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className='space-y-2'>
              {displayLists.map((list) => (
                <SortableListCard
                  key={list.id}
                  list={list}
                  isExpanded={expanded.has(list.id)}
                  onToggleExpand={toggleExpand}
                  onRename={setRenameTarget}
                  onDelete={handleDeleteConfirm}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay>{activeList ? <ListGhostCard list={activeList} /> : null}</DragOverlay>
        </DndContext>
      )}

      <CreateListDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setLocalLists([]);
        }}
      />

      {renameTarget && (
        <RenameListDialog
          list={renameTarget}
          open={!!renameTarget}
          onOpenChange={(open: boolean) => {
            if (!open) setRenameTarget(null);
          }}
          onRenamed={() => {
            setLocalLists([]);
            setRenameTarget(null);
          }}
        />
      )}
    </div>
  );
}
