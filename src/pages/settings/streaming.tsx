import { useCallback, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AddonConfig } from '@/lib/api';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Loader2,
  Globe,
  Trash2,
  Plus,
  GripVertical,
  Power,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { invalidateStreamQueries } from '@/lib/query-invalidation';
import { toast } from 'sonner';

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `addon-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function deriveAddonNameFromUrl(url: string): string {
  try {
    return new URL(url).host || 'Custom Addon';
  } catch {
    return 'Custom Addon';
  }
}

function normalizeAddonUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = trimmed.startsWith('stremio://')
    ? `https://${trimmed.slice('stremio://'.length)}`
    : trimmed.includes('://')
      ? trimmed
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  parsed.hash = '';
  const normalizedPath = parsed.pathname.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  parsed.pathname = normalizedPath || '/';

  return parsed.toString().replace(/\/$/, '');
}

function isConfigureUrl(url: string): boolean {
  try {
    return /\/configure\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const POPULAR_SOURCES = [
  { name: 'Torrentio', url: 'https://torrentio.strem.fun' },
  { name: 'Jackettio', url: 'https://jackettio.elfhosted.com' },
  { name: 'Comet', url: 'https://comet.elfhosted.com' },
  { name: 'StremThru', url: 'https://stremthru.13377001.xyz' },
  { name: 'AutoStream', url: 'https://autostreamtest.onrender.com/configure' },
  { name: 'Orion', url: 'https://5a0d1888fa64-orion.baby-beamup.club/configure' },
] as const;

// ── Sortable addon row ───────────────────────────────────────────────────────

interface SortableAddonRowProps {
  addon: AddonConfig;
  isWorking: boolean;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

function SortableAddonRow({ addon, isWorking, onToggle, onRemove }: SortableAddonRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: addon.id,
    disabled: isWorking,
  });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'px-4 py-2.5 flex items-center gap-3 transition-colors group/row',
        !addon.enabled && 'opacity-40',
        isDragging && 'bg-white/[0.04] ring-1 ring-white/10 rounded',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={isWorking}
        className="text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing disabled:opacity-30 disabled:cursor-not-allowed touch-none p-1 -m-1"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-3.5 h-3.5 shrink-0" />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-white truncate">{addon.name}</span>
          <span
            className={cn(
              'text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0',
              addon.enabled
                ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                : 'text-zinc-600 bg-zinc-800/60 border border-white/[0.04]',
            )}
          >
            {addon.enabled ? 'Active' : 'Off'}
          </span>
        </div>
        <p className="text-[11px] text-zinc-500 truncate mt-0.5 font-mono leading-none">
          {addon.url.replace(/\/manifest\.json$/i, '')}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity duration-100">
        <button
          type="button"
          title={addon.enabled ? 'Disable' : 'Enable'}
          onClick={() => onToggle(addon.id)}
          disabled={isWorking}
          className={cn(
            'w-7 h-7 rounded flex items-center justify-center transition-colors disabled:opacity-40',
            addon.enabled
              ? 'text-emerald-400 hover:bg-emerald-500/10'
              : 'text-zinc-600 hover:bg-white/5 hover:text-zinc-400',
          )}
        >
          <Power className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Remove"
          onClick={() => onRemove(addon.id)}
          disabled={isWorking}
          className="w-7 h-7 rounded flex items-center justify-center text-zinc-600 hover:bg-red-500/10 hover:text-red-400 transition-colors disabled:opacity-40"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function StreamingSources() {
  const queryClient = useQueryClient();
  const [newUrl, setNewUrl] = useState('');
  const [fetchingManifest, setFetchingManifest] = useState(false);
  const newUrlInputRef = useRef<HTMLInputElement | null>(null);

  const { data: addons = [], isLoading } = useQuery({
    queryKey: ['addonConfigs'],
    queryFn: api.getAddonConfigs,
    staleTime: 1000 * 60 * 5,
  });

  const saveMutation = useMutation({
    mutationFn: api.saveAddonConfigs,
    onSuccess: (savedConfigs) => {
      queryClient.setQueryData(['addonConfigs'], savedConfigs);
      void invalidateStreamQueries(queryClient);
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const normalizedNewUrl = normalizeAddonUrl(newUrl);
  const isConfigureCandidate = normalizedNewUrl ? isConfigureUrl(normalizedNewUrl) : false;
  const duplicateAddon = normalizedNewUrl
    ? addons.find((addon) => normalizeAddonUrl(addon.url) === normalizedNewUrl)
    : undefined;
  const isWorking = isLoading || saveMutation.isPending || fetchingManifest;
  const canSubmitNewAddon =
    !!newUrl.trim() && !!normalizedNewUrl && !isConfigureCandidate && !duplicateAddon && !isWorking;

  const handleToggle = (id: string) => {
    const updated = addons.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a));
    saveMutation.mutate(updated);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = addons.findIndex((addon) => addon.id === String(active.id));
      const newIndex = addons.findIndex((addon) => addon.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

      saveMutation.mutate(arrayMove(addons, oldIndex, newIndex));
    },
    [addons, saveMutation],
  );

  const handleRemove = (id: string) => {
    saveMutation.mutate(
      addons.filter((a) => a.id !== id),
      { onSuccess: () => toast.success('Addon removed') },
    );
  };

  const handleAddUrl = async () => {
    const inputUrl = newUrl.trim();
    if (!inputUrl) return;

    const normalized = normalizeAddonUrl(inputUrl);
    if (!normalized) {
      toast.error('Invalid addon URL. Please use a valid http(s) URL.');
      return;
    }
    if (isConfigureUrl(normalized)) {
      toast.error('This is a configure page — open it, finish setup, then paste the generated manifest URL.');
      return;
    }
    if (addons.some((addon) => normalizeAddonUrl(addon.url) === normalized)) {
      toast.error('This addon URL is already configured.');
      return;
    }

    setFetchingManifest(true);
    try {
      let name = deriveAddonNameFromUrl(normalized);
      try {
        const manifest = await api.fetchAddonManifest(normalized);
        if (manifest.name?.trim()) name = manifest.name.trim();
      } catch {
        toast.info('Could not fetch addon manifest — using the addon host as its label.', { duration: 3000 });
      }

      const newAddon: AddonConfig = { id: generateId(), url: normalized, name, enabled: true };
      saveMutation.mutate([...addons, newAddon], {
        onSuccess: () => {
          setNewUrl('');
          newUrlInputRef.current?.focus();
          toast.success(`Added ${name}`);
        },
      });
    } finally {
      setFetchingManifest(false);
    }
  };

  const activeCount = addons.filter((a) => a.enabled).length;

  return (
    <div className="space-y-4">
      {/* Configured addons */}
      <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.05] flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-semibold text-white">Configured Sources</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Drag to reorder priority. Higher sources are queried first.
            </p>
          </div>
          {addons.length > 0 && (
            <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">
              {activeCount}/{addons.length} active
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="px-4 py-5 flex items-center gap-2 text-zinc-500 text-[13px]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        ) : addons.length === 0 ? (
          <div className="px-4 py-6 text-center text-zinc-600 text-[13px]">
            No addons configured yet. Add one below.
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={addons.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-white/[0.04]">
                {addons.map((addon) => (
                  <SortableAddonRow
                    key={addon.id}
                    addon={addon}
                    isWorking={isWorking}
                    onToggle={handleToggle}
                    onRemove={handleRemove}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add new */}
      <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.05]">
          <h3 className="text-[13px] font-semibold text-white flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5 text-zinc-500" />
            Add Source
          </h3>
        </div>

        <div className="px-4 py-3.5 space-y-3">
          <div className="flex gap-2">
            <Input
              ref={newUrlInputRef}
              placeholder="https://addon.host/.../manifest.json"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAddUrl()}
              disabled={isWorking}
              className="flex-1 h-8 bg-white/[0.03] border-white/[0.07] text-[13px] font-mono focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded"
            />
            <Button
              size="sm"
              onClick={handleAddUrl}
              disabled={!canSubmitNewAddon}
              className="h-8 px-4 bg-white text-black hover:bg-zinc-200 rounded text-[13px] font-semibold gap-1.5 shrink-0"
            >
              {fetchingManifest ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Add
            </Button>
          </div>

          {newUrl.trim() && (
            <p className={cn(
              'text-[11px]',
              !normalizedNewUrl ? 'text-red-400'
                : isConfigureCandidate ? 'text-amber-400'
                : duplicateAddon ? 'text-amber-400'
                : 'text-emerald-400',
            )}>
              {!normalizedNewUrl
                ? 'Enter a valid http(s) addon URL.'
                : isConfigureCandidate
                  ? 'This is a configure page — open it, finish setup, then paste the generated manifest URL.'
                  : duplicateAddon
                    ? `Already configured as ${duplicateAddon.name}.`
                    : `Ready: ${normalizedNewUrl}`}
            </p>
          )}
        </div>
      </div>

      {/* Popular sources */}
      <div className="rounded border border-white/[0.05] bg-white/[0.015] px-4 py-3 space-y-2">
        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
          <Globe className="w-3 h-3" /> Popular Sources
        </p>
        <div className="flex flex-wrap gap-1.5">
          {POPULAR_SOURCES.map((s) => (
            <a
              key={s.name}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200 bg-white/[0.03] border border-white/[0.04] hover:border-white/10 px-2 py-1 rounded transition-colors"
            >
              {s.name}
              <ExternalLink className="w-2.5 h-2.5 opacity-50" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
