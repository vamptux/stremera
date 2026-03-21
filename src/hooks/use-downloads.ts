import { useContext } from 'react';
import { DownloadContext } from '@/contexts/download-context-core';

export function useDownloads() {
  const context = useContext(DownloadContext);
  if (context === undefined) {
    throw new Error('useDownloads must be used within a DownloadProvider');
  }
  return context;
}
