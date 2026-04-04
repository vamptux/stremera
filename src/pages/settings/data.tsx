import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Loader2,
  Trash2,
  Download,
  Upload,
  AlertTriangle,
  Check,
  Database,
  History as HistoryIcon,
  Library,
  LayoutList,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  invalidateDataStatsQuery,
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueries,
  invalidateStoredDataQueries,
  invalidateWatchStatusQueries,
} from '@/lib/query-invalidation';

// ── Types ────────────────────────────────────────────────────────────────────

interface DataCategory {
  key: 'history' | 'library' | 'lists' | 'statuses';
  label: string;
  description: string;
  icon: ReactNode;
  count: number;
  unit: string;
  clearFn: () => Promise<void>;
  invalidateCaches: () => Promise<void>;
}

// ── Backup & Restore ─────────────────────────────────────────────────────────

function BackupRestore() {
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const selected = await saveDialog({
        title: 'Export Stremera Backup',
        defaultPath: `stremera-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const pickedPath = Array.isArray(selected) ? selected[0] : selected;
      const path = pickedPath?.toLowerCase().endsWith('.json') ? pickedPath : `${pickedPath}.json`;
      if (!path) return;

      await api.exportAppDataToFile(path);
      toast.success('Backup exported successfully');
    } catch (err) {
      toast.error(`Export failed: ${getErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const selected = await openDialog({
        title: 'Import Stremera Backup',
        multiple: false,
        directory: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      const result = await api.importAppDataFromFile(path);
      await invalidateStoredDataQueries(queryClient);
      toast.success('Backup imported', {
        description: `${result?.history_imported ?? 0} history · ${result?.library_imported ?? 0} library · ${result?.lists_imported ?? 0} lists · ${result?.statuses_imported ?? 0} statuses`,
      });
    } catch (err) {
      toast.error(`Import failed: ${getErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <h3 className="text-[13px] font-semibold text-white flex items-center gap-2">
          <Database className="w-3.5 h-3.5 text-zinc-500" />
          Backup & Restore
        </h3>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          Export all data to a <span className="text-zinc-400">.json</span> file or restore from a backup. Imports are non-destructive.
        </p>
      </div>
      <div className="px-4 py-3 flex items-center gap-2.5 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={handleExport}
          disabled={exporting || importing}
          className="h-7 px-3.5 text-[12px] font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white rounded"
        >
          {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Export
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleImport}
          disabled={importing || exporting}
          className="h-7 px-3.5 text-[12px] font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white rounded"
        >
          {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          Import
        </Button>
      </div>
    </div>
  );
}

// ── Data manager ─────────────────────────────────────────────────────────────

function DataManager() {
  const queryClient = useQueryClient();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['dataStats'],
    queryFn: api.getDataStats,
    staleTime: 1000 * 30,
  });

  const clearMutation = useMutation({
    mutationFn: async (cat: DataCategory) => {
      await cat.clearFn();
      return cat;
    },
    onSuccess: async (cat) => {
      setConfirmKey(null);
      await Promise.all([cat.invalidateCaches(), invalidateDataStatsQuery(queryClient)]);
      await refetchStats();
      toast.success(`${cat.label} cleared`);
    },
    onError: (err: unknown, cat) => {
      setConfirmKey(null);
      toast.error(`Failed to clear ${cat.label}: ${getErrorMessage(err)}`);
    },
  });

  const categories: DataCategory[] = [
    {
      key: 'history',
      label: 'Watch History',
      description: 'Viewed episodes, movies and progress data.',
      icon: <HistoryIcon className="w-3.5 h-3.5" />,
      count: stats?.history_count ?? 0,
      unit: 'entries',
      clearFn: api.clearWatchHistory,
      invalidateCaches: () => invalidatePlaybackHistoryQueries(queryClient),
    },
    {
      key: 'library',
      label: 'Library',
      description: 'Saved movies and shows.',
      icon: <Library className="w-3.5 h-3.5" />,
      count: stats?.library_count ?? 0,
      unit: 'items',
      clearFn: api.clearLibrary,
      invalidateCaches: () => invalidateLibraryQueries(queryClient),
    },
    {
      key: 'lists',
      label: 'Custom Lists',
      description: 'All custom lists and their contents.',
      icon: <LayoutList className="w-3.5 h-3.5" />,
      count: stats?.lists_count ?? 0,
      unit: 'lists',
      clearFn: api.clearAllLists,
      invalidateCaches: () => invalidateListQueries(queryClient),
    },
    {
      key: 'statuses',
      label: 'Watch Statuses',
      description: 'Watching / Watched / Plan to Watch / Dropped labels.',
      icon: <Check className="w-3.5 h-3.5" />,
      count: stats?.watch_statuses_count ?? 0,
      unit: 'labels',
      clearFn: api.clearAllWatchStatuses,
      invalidateCaches: () => invalidateWatchStatusQueries(queryClient),
    },
  ];

  return (
    <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <h3 className="text-[13px] font-semibold text-white">Storage</h3>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          View and clear locally stored data. These actions are permanent.
        </p>
      </div>

      <div className="px-4 py-3 space-y-2">
        {categories.map((cat) => {
          const isPending = clearMutation.isPending && clearMutation.variables?.key === cat.key;
          const isConfirming = confirmKey === cat.key;
          const isEmpty = cat.count === 0;

          return (
            <div
              key={cat.key}
              className="flex items-center justify-between gap-3 rounded border border-white/[0.05] bg-transparent px-3.5 py-2.5"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded bg-white/[0.04] flex items-center justify-center text-zinc-500 shrink-0">
                  {cat.icon}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-white">{cat.label}</span>
                    {statsLoading ? (
                      <span className="text-[10px] text-zinc-600 animate-pulse">loading…</span>
                    ) : (
                      <span className={cn(
                        'text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums',
                        isEmpty ? 'text-zinc-600 bg-white/[0.03]' : 'text-zinc-400 bg-white/[0.06]',
                      )}>
                        {cat.count} {cat.unit}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate leading-none mt-0.5">{cat.description}</p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {isConfirming ? (
                  <>
                    <span className="text-[11px] text-zinc-400 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                      Confirm?
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setConfirmKey(null)} className="h-6 px-2.5 text-[11px] rounded">
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => clearMutation.mutate(cat)}
                      disabled={isPending}
                      className="h-6 px-2.5 text-[11px] bg-red-500/90 hover:bg-red-500 text-white border-0 rounded"
                    >
                      {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Clear'}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { if (!isEmpty) setConfirmKey(cat.key); }}
                    disabled={isEmpty || clearMutation.isPending}
                    className={cn(
                      'h-6 px-2.5 text-[11px] font-semibold rounded',
                      isEmpty
                        ? 'opacity-30 cursor-not-allowed'
                        : 'border-red-500/20 text-red-400 hover:bg-red-500/10 hover:text-red-300',
                    )}
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Clear
                  </Button>
                )}
              </div>
            </div>
          );
        })}

      </div>
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function DataSection() {
  return (
    <div className="space-y-4">
      <BackupRestore />
      <DataManager />
    </div>
  );
}
