import { createContext } from 'react';
import { DownloadItem, StartDownloadParams } from '@/lib/api';

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
