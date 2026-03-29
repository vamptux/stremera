import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APP_UPDATE_STATE_QUERY_KEY,
  APP_VERSION_QUERY_KEY,
  getCurrentAppVersion,
  getInitialAppUpdateState,
  isUpdateReady,
  runAppUpdateCheck,
  runAppUpdateInstall,
  type AppUpdateHandle,
} from '@/lib/app-updater';

export function useAppUpdater() {
  const queryClient = useQueryClient();

  const { data: updateState = getInitialAppUpdateState() } = useQuery({
    queryKey: APP_UPDATE_STATE_QUERY_KEY,
    queryFn: async () => getInitialAppUpdateState(),
    initialData: getInitialAppUpdateState,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const { data: currentVersion = null } = useQuery({
    queryKey: APP_VERSION_QUERY_KEY,
    queryFn: getCurrentAppVersion,
    enabled: updateState.isSupported,
    staleTime: 1000 * 60 * 60,
  });

  const checkForUpdates = useCallback(() => runAppUpdateCheck(queryClient), [queryClient]);
  const installUpdate = useCallback(
    (update?: AppUpdateHandle | null, onStatus?: (status: string) => void) =>
      runAppUpdateInstall(queryClient, update, onStatus),
    [queryClient],
  );

  return {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isChecking: updateState.status === 'checking',
    isInstalling: updateState.status === 'installing',
    isSupported: updateState.isSupported,
    isUpdateAvailable: isUpdateReady(updateState),
    pendingUpdate: updateState.update,
    updateState,
  };
}