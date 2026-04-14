import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useLegacyStorageImport } from '@/hooks/use-legacy-storage-import';
import {
  APP_UPDATE_LAST_NOTIFIED_VERSION_LEGACY_FEATURE,
  APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
  APP_UPDATE_STATE_QUERY_KEY,
  APP_VERSION_QUERY_KEY,
  type AppUpdateHandle,
  clearLegacyLastNotifiedAppUpdateVersion,
  getCurrentAppVersion,
  getInitialAppUpdateState,
  getStoredLastNotifiedAppUpdateVersion,
  importLegacyLastNotifiedAppUpdateVersion,
  isUpdateReady,
  readLegacyLastNotifiedAppUpdateVersion,
  runAppUpdateCheck,
  runAppUpdateInstall,
  saveLastNotifiedAppUpdateVersion,
} from '@/lib/app-updater';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';

export function useAppUpdater() {
  const queryClient = useQueryClient();
  const legacyLastNotifiedVersionRead = useMemo(() => readLegacyLastNotifiedAppUpdateVersion(), []);

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

  const lastNotifiedVersionQuery = useQuery({
    queryKey: APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
    queryFn: getStoredLastNotifiedAppUpdateVersion,
    enabled: updateState.isSupported,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const saveLastNotifiedVersionMutation = useMutation({
    mutationFn: async (version: string | null) => {
      const savedVersion = await saveLastNotifiedAppUpdateVersion(version);

      if (version !== null && !savedVersion) {
        throw new Error('Failed to persist the notified update version.');
      }

      return savedVersion;
    },
  });

  useLegacyStorageImport({
    clearLegacy: clearLegacyLastNotifiedAppUpdateVersion,
    enabled: updateState.isSupported && lastNotifiedVersionQuery.isSuccess,
    feature: APP_UPDATE_LAST_NOTIFIED_VERSION_LEGACY_FEATURE,
    importLegacy: async (version) => {
      const importedVersion = await importLegacyLastNotifiedAppUpdateVersion(version);

      if (!importedVersion) {
        throw new Error('Failed to import the legacy update notification version.');
      }

      return importedVersion;
    },
    onImported: (savedVersion) => {
      queryClient.setQueryData<string | null>(
        APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
        savedVersion,
      );
    },
    readResult: legacyLastNotifiedVersionRead,
  });

  const checkForUpdates = useCallback(() => runAppUpdateCheck(queryClient), [queryClient]);
  const installUpdate = useCallback(
    (update?: AppUpdateHandle | null, onStatus?: (status: string) => void) =>
      runAppUpdateInstall(queryClient, update, onStatus),
    [queryClient],
  );
  const markUpdateNotified = useCallback(
    async (version: string | null) => {
      await runOptimisticQueryMutation({
        mutate: saveLastNotifiedVersionMutation.mutateAsync,
        optimisticData: version,
        queryClient,
        queryKey: APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
        variables: version,
      });
    },
    [queryClient, saveLastNotifiedVersionMutation],
  );

  const lastNotifiedVersion = updateState.isSupported
    ? (lastNotifiedVersionQuery.data ?? legacyLastNotifiedVersionRead.value ?? null)
    : null;

  return {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isChecking: updateState.status === 'checking',
    isInstalling: updateState.status === 'installing',
    isLastNotifiedVersionReady: !updateState.isSupported || lastNotifiedVersionQuery.isSuccess,
    isSupported: updateState.isSupported,
    isUpdateAvailable: isUpdateReady(updateState),
    lastNotifiedVersion,
    markUpdateNotified,
    pendingUpdate: updateState.update,
    updateState,
  };
}
