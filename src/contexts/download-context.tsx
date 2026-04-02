import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  api,
  getErrorMessage,
  type DownloadItem,
  type DownloadProgressEvent,
  type StartDownloadParams,
} from '@/lib/api';
import { DownloadContext } from '@/contexts/download-context-core';
import { toast } from 'sonner';

const isDev = import.meta.env.DEV;

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);

  const refetchDownloads = useCallback(async () => {
    const items = await api.getDownloads();
    setDownloads(items);
    return items;
  }, []);

  // Initial fetch
  useEffect(() => {
    let active = true;

    api
      .getDownloads()
      .then((items) => {
        if (active) setDownloads(items);
      })
      .catch((error) => {
        if (!active) return;
        if (isDev) console.error('Failed to load downloads:', error);
        toast.error('Failed to load downloads', { description: getErrorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, []);

  // Event listener
  useEffect(() => {
    let disposed = false;
    let cleanup: null | (() => void) = null;

    void listen<DownloadProgressEvent>('download://progress', (event) => {
      const payload = event.payload;
      setDownloads((prev) => {
        const index = prev.findIndex((d) => d.id === payload.id);
        if (index === -1) return prev;

        const newDownloads = [...prev];
        newDownloads[index] = { ...newDownloads[index], ...payload };
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
  }, []);

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

  const pauseActiveDownloads = useCallback(
    async () => {
      try {
        const pausedCount = await api.pauseActiveDownloads();
        if (pausedCount === 0) return 0;

        await refetchDownloads();
        toast.success(
          pausedCount === 1 ? 'Paused 1 download' : `Paused ${pausedCount} downloads`,
        );
        return pausedCount;
      } catch (e) {
        toast.error('Failed to pause active downloads', { description: getErrorMessage(e) });
        throw e;
      }
    },
    [refetchDownloads],
  );

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

  return (
    <DownloadContext.Provider
      value={contextValue}
    >
      {children}
    </DownloadContext.Provider>
  );
}
