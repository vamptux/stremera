import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, DownloadItem, StartDownloadParams, DownloadProgressEvent, getErrorMessage } from '@/lib/api';
import { DownloadContext } from '@/contexts/download-context-core';
import { toast } from 'sonner';

const isDev = import.meta.env.DEV;

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);

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

  const startDownload = useCallback(async (params: StartDownloadParams) => {
    try {
      const id = await api.startDownload(params);
      const newDownload: DownloadItem = {
        id,
        title: params.title,
        url: params.url,
        filePath: params.filePath,
        fileName: params.fileName,
        totalSize: 0,
        downloadedSize: 0,
        speed: 0,
        progress: 0,
        status: 'pending',
        createdAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000,
        poster: params.poster,
        mediaType: params.mediaType,
        bandwidthLimit: params.bandwidthLimit,
        mediaId: params.mediaId,
        season: params.season,
        episode: params.episode,
      };
      setDownloads((prev) => [newDownload, ...prev]);
      toast.success('Download started', { description: params.title });
      return id;
    } catch (e) {
      toast.error('Failed to start download', { description: getErrorMessage(e) });
      throw e;
    }
  }, []);

  const pauseDownload = useCallback(async (id: string) => {
    try {
      await api.pauseDownload(id);
      setDownloads((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: 'paused', speed: 0 } : d))
      );
    } catch (e) {
      toast.error('Failed to pause download', { description: getErrorMessage(e) });
    }
  }, []);

  const resumeDownload = useCallback(async (id: string) => {
    try {
      await api.resumeDownload(id);
      // Optimistic update — set to downloading so the UI reacts immediately.
      // The backend will emit download://progress events that reconcile the real state.
      setDownloads((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: 'downloading' } : d))
      );
    } catch (e) {
      toast.error('Failed to resume download', { description: getErrorMessage(e) });
    }
  }, []);

  const cancelDownload = useCallback(async (id: string) => {
    try {
      await api.cancelDownload(id);
      // Backend emits download://progress with status=error, so we don't need
      // an optimistic update here. The event listener will reconcile the state.
    } catch (e) {
      toast.error('Failed to cancel download', { description: getErrorMessage(e) });
    }
  }, []);

  const removeDownload = useCallback(async (id: string, deleteFile: boolean) => {
    try {
      await api.removeDownload(id, deleteFile);
      setDownloads((prev) => prev.filter((d) => d.id !== id));
      toast.success('Download removed');
    } catch (e) {
      toast.error('Failed to remove download', { description: getErrorMessage(e) });
    }
  }, []);

  const setBandwidthLimit = useCallback(async (limit?: number) => {
    await api.setDownloadBandwidth(limit);
    toast.success(limit ? `Bandwidth limited to ${(limit / 1024 / 1024).toFixed(1)} MB/s` : 'Bandwidth limit removed');
  }, []);

  const refetchDownloads = useCallback(async () => {
    try {
      const items = await api.getDownloads();
      setDownloads(items);
    } catch (e) {
      if (isDev) console.error('Failed to refetch downloads:', e);
      toast.error('Failed to refresh downloads', { description: getErrorMessage(e) });
    }
  }, []);

  const activeCount = downloads.filter((d) => d.status === 'downloading').length;

  const contextValue = useMemo(
    () => ({
      downloads,
      activeCount,
      startDownload,
      pauseDownload,
      resumeDownload,
      cancelDownload,
      removeDownload,
      setBandwidthLimit,
      refetchDownloads,
    }),
    [
      downloads,
      activeCount,
      startDownload,
      pauseDownload,
      resumeDownload,
      cancelDownload,
      removeDownload,
      setBandwidthLimit,
      refetchDownloads,
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
