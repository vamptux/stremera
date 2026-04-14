import { listen } from '@tauri-apps/api/event';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  api,
  type DownloadItem,
  type DownloadProgressEvent,
  getErrorMessage,
  type StartDownloadParams,
} from '@/lib/api';

export interface DownloadContextType {
  downloads: DownloadItem[];
  activeCount: number;
  startDownload: (params: StartDownloadParams) => Promise<string>;
  pauseDownload: (id: string) => Promise<void>;
  pauseActiveDownloads: () => Promise<number>;
  resumeDownload: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  removeDownload: (id: string, deleteFile: boolean) => Promise<void>;
  clearCompletedDownloads: (deleteFile?: boolean) => Promise<number>;
  setBandwidthLimit: (limit?: number) => Promise<void>;
  refetchDownloads: () => Promise<void>;
}

export const DownloadContext = createContext<DownloadContextType | undefined>(undefined);

export function useDownloads() {
  const context = useContext(DownloadContext);
  if (context === undefined) {
    throw new Error('useDownloads must be used within a DownloadProvider');
  }

  return context;
}

const isDev = import.meta.env.DEV;

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const downloadsRef = useRef<DownloadItem[]>([]);
  const refetchPromiseRef = useRef<Promise<DownloadItem[]> | null>(null);

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  const refetchDownloads = useCallback(async () => {
    if (refetchPromiseRef.current) {
      return refetchPromiseRef.current;
    }

    const refreshPromise = api
      .getDownloads()
      .then((items) => {
        downloadsRef.current = items;
        setDownloads(items);
        return items;
      })
      .finally(() => {
        refetchPromiseRef.current = null;
      });

    refetchPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, []);

  // Initial fetch
  useEffect(() => {
    let active = true;

    refetchDownloads()
      .then((items) => {
        if (active) {
          downloadsRef.current = items;
        }
      })
      .catch((error) => {
        if (!active) return;
        if (isDev) console.error('Failed to load downloads:', error);
        toast.error('Failed to load downloads', { description: getErrorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, [refetchDownloads]);

  // Event listener
  useEffect(() => {
    let disposed = false;
    let cleanup: null | (() => void) = null;

    void listen<DownloadProgressEvent>('download://progress', (event) => {
      const payload = event.payload;
      const hasKnownDownload = downloadsRef.current.some((download) => download.id === payload.id);

      if (!hasKnownDownload) {
        void refetchDownloads().catch((error) => {
          if (isDev) console.error('Failed to refresh downloads after progress event:', error);
        });
        return;
      }

      setDownloads((prev) => {
        const index = prev.findIndex((d) => d.id === payload.id);
        if (index === -1) return prev;

        const newDownloads = [...prev];
        newDownloads[index] = { ...newDownloads[index], ...payload };
        downloadsRef.current = newDownloads;
        return newDownloads;
      });
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        cleanup = unlisten;
      })
      .catch((error) => {
        if (disposed) return;
        if (isDev) console.error('Failed to subscribe to download progress:', error);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [refetchDownloads]);

  const startDownload = useCallback(
    async (params: StartDownloadParams) => {
      try {
        const id = await api.startDownload(params);
        await refetchDownloads();
        toast.success('Download started', { description: params.title });
        return id;
      } catch (e) {
        toast.error('Failed to start download', { description: getErrorMessage(e) });
        throw e;
      }
    },
    [refetchDownloads],
  );

  const pauseDownload = useCallback(
    async (id: string) => {
      try {
        await api.pauseDownload(id);
        await refetchDownloads();
      } catch (e) {
        toast.error('Failed to pause download', { description: getErrorMessage(e) });
      }
    },
    [refetchDownloads],
  );

  const resumeDownload = useCallback(
    async (id: string) => {
      try {
        await api.resumeDownload(id);
        await refetchDownloads();
      } catch (e) {
        toast.error('Failed to resume download', { description: getErrorMessage(e) });
      }
    },
    [refetchDownloads],
  );

  const cancelDownload = useCallback(
    async (id: string) => {
      try {
        await api.cancelDownload(id);
        await refetchDownloads();
      } catch (e) {
        toast.error('Failed to cancel download', { description: getErrorMessage(e) });
      }
    },
    [refetchDownloads],
  );

  const removeDownload = useCallback(
    async (id: string, deleteFile: boolean) => {
      try {
        await api.removeDownload(id, deleteFile);
        await refetchDownloads();
        toast.success('Download removed');
      } catch (e) {
        toast.error('Failed to remove download', { description: getErrorMessage(e) });
      }
    },
    [refetchDownloads],
  );

  const refreshDownloads = useCallback(async () => {
    try {
      await refetchDownloads();
    } catch (e) {
      if (isDev) console.error('Failed to refetch downloads:', e);
      toast.error('Failed to refresh downloads', { description: getErrorMessage(e) });
    }
  }, [refetchDownloads]);

  const pauseActiveDownloads = useCallback(async () => {
    try {
      const pausedCount = await api.pauseActiveDownloads();
      if (pausedCount === 0) return 0;

      await refetchDownloads();
      toast.success(pausedCount === 1 ? 'Paused 1 download' : `Paused ${pausedCount} downloads`);
      return pausedCount;
    } catch (e) {
      toast.error('Failed to pause active downloads', { description: getErrorMessage(e) });
      throw e;
    }
  }, [refetchDownloads]);

  const clearCompletedDownloads = useCallback(
    async (deleteFile = false) => {
      try {
        const clearedCount = await api.clearCompletedDownloads(deleteFile);
        if (clearedCount === 0) return 0;

        await refetchDownloads();
        toast.success(
          clearedCount === 1
            ? 'Cleared 1 completed download'
            : `Cleared ${clearedCount} completed downloads`,
        );
        return clearedCount;
      } catch (e) {
        toast.error('Failed to clear completed downloads', {
          description: getErrorMessage(e),
        });
        throw e;
      }
    },
    [refetchDownloads],
  );

  const setBandwidthLimit = useCallback(
    async (limit?: number) => {
      await api.setDownloadBandwidth(limit);
      await refetchDownloads();
      toast.success(
        limit
          ? `Bandwidth limited to ${(limit / 1024 / 1024).toFixed(1)} MB/s`
          : 'Bandwidth limit removed',
      );
    },
    [refetchDownloads],
  );

  const activeCount = downloads.filter((d) => d.status === 'downloading').length;

  const contextValue = useMemo(
    () => ({
      downloads,
      activeCount,
      startDownload,
      pauseDownload,
      pauseActiveDownloads,
      resumeDownload,
      cancelDownload,
      removeDownload,
      clearCompletedDownloads,
      setBandwidthLimit,
      refetchDownloads: refreshDownloads,
    }),
    [
      downloads,
      activeCount,
      startDownload,
      pauseDownload,
      pauseActiveDownloads,
      resumeDownload,
      cancelDownload,
      removeDownload,
      clearCompletedDownloads,
      setBandwidthLimit,
      refreshDownloads,
    ],
  );

  return <DownloadContext.Provider value={contextValue}>{children}</DownloadContext.Provider>;
}
