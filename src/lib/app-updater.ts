import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  clearLegacyStorageFeatureKeys,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';

export const APP_UPDATE_STATE_QUERY_KEY = ['app-update-state'] as const;
export const APP_VERSION_QUERY_KEY = ['appVersion'] as const;
export const APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY = [
  'app-update-last-notified-version',
] as const;
const APP_UPDATE_STATUS_EVENT = 'app-update-status';
const LAST_NOTIFIED_VERSION_KEY = 'stremera:last-notified-app-update-version';
export const APP_UPDATE_LAST_NOTIFIED_VERSION_LEGACY_FEATURE =
  'app-update-last-notified-version';

export interface AppUpdateHandle {
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
}

export type AppUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'error';

export interface AppUpdateState {
  isSupported: boolean;
  status: AppUpdateStatus;
  update: AppUpdateHandle | null;
  lastCheckedAt: number | null;
  installStatus: string | null;
  errorMessage: string | null;
}

let activeInstallPromise: Promise<void> | null = null;
let activeCheckPromise: Promise<AppUpdateHandle | null> | null = null;

export function readLegacyLastNotifiedAppUpdateVersion(): LegacyStorageReadResult<string> {
  return readLegacyStorageFeature(APP_UPDATE_LAST_NOTIFIED_VERSION_LEGACY_FEATURE, (storage) => {
    try {
      const version = storage.getItem(LAST_NOTIFIED_VERSION_KEY);
      return {
        hasLegacyData: version !== null,
        value: version?.trim() || null,
      };
    } catch {
      return {
        hasLegacyData: true,
        value: null,
      };
    }
  });
}

export function clearLegacyLastNotifiedAppUpdateVersion() {
  clearLegacyStorageFeatureKeys(APP_UPDATE_LAST_NOTIFIED_VERSION_LEGACY_FEATURE, [
    LAST_NOTIFIED_VERSION_KEY,
  ]);
}

function createInitialAppUpdateState(): AppUpdateState {
  const isSupported = isTauriDesktopRuntime();

  return {
    isSupported,
    status: isSupported ? 'idle' : 'unsupported',
    update: null,
    lastCheckedAt: null,
    installStatus: null,
    errorMessage: null,
  };
}

function readAppUpdateState(queryClient?: QueryClient): AppUpdateState {
  return queryClient?.getQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY) ?? createInitialAppUpdateState();
}

function writeAppUpdateState(
  queryClient: QueryClient,
  updater: (current: AppUpdateState) => AppUpdateState,
) {
  queryClient.setQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY, (current) =>
    updater(current ?? createInitialAppUpdateState()),
  );
}

export function getInitialAppUpdateState(): AppUpdateState {
  return createInitialAppUpdateState();
}

export function isUpdateReady(state?: Pick<AppUpdateState, 'status'> | null): boolean {
  return state?.status === 'available' || state?.status === 'installing';
}

export function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function importLegacyLastNotifiedAppUpdateVersion(
  version: string,
): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;

  try {
    return await invoke<string | null>('import_legacy_last_notified_app_update_version', {
      version,
    });
  } catch {
    return null;
  }
}

export async function getStoredLastNotifiedAppUpdateVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;

  try {
    return await invoke<string | null>('get_last_notified_app_update_version');
  } catch {
    return null;
  }
}

export async function saveLastNotifiedAppUpdateVersion(
  version: string | null,
): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;

  try {
    const savedVersion = await invoke<string | null>('save_last_notified_app_update_version', {
      version,
    });
    clearLegacyLastNotifiedAppUpdateVersion();
    return savedVersion;
  } catch {
    return null;
  }
}

export async function getCurrentAppVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;
  try {
    return await invoke<string>('get_current_app_version');
  } catch {
    return null;
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateHandle | null> {
  if (!isTauriDesktopRuntime()) return null;

  const update = await invoke<AppUpdateHandle | null>('check_for_app_update');
  if (!update) {
    await saveLastNotifiedAppUpdateVersion(null);
  }
  if (!update) return null;

  return update;
}

export async function runAppUpdateCheck(
  queryClient: QueryClient,
): Promise<AppUpdateHandle | null> {
  if (!isTauriDesktopRuntime()) {
    writeAppUpdateState(queryClient, () => createInitialAppUpdateState());
    return null;
  }

  if (activeCheckPromise) {
    return activeCheckPromise;
  }

  writeAppUpdateState(queryClient, (current) => ({
    ...current,
    isSupported: true,
    status: 'checking',
    installStatus: null,
    errorMessage: null,
  }));

  activeCheckPromise = (async () => {
    try {
      const update = await checkForAppUpdate();
      const checkedAt = Date.now();

      if (!update) {
        queryClient.setQueryData<string | null>(
          APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
          null,
        );
      }

      writeAppUpdateState(queryClient, (current) => ({
        ...current,
        isSupported: true,
        status: update ? 'available' : 'up-to-date',
        update,
        lastCheckedAt: checkedAt,
        installStatus: null,
        errorMessage: null,
      }));

      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      writeAppUpdateState(queryClient, (current) => ({
        ...current,
        isSupported: true,
        status: current.update ? 'available' : 'error',
        lastCheckedAt: Date.now(),
        installStatus: null,
        errorMessage: message,
      }));

      throw error;
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

export async function installAppUpdate(
  _update: AppUpdateHandle,
  onStatus?: (status: string) => void,
): Promise<void> {
  if (!isTauriDesktopRuntime()) {
    throw new Error('Application updates are only available inside the packaged desktop app.');
  }

  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  activeInstallPromise = (async () => {
    onStatus?.('Preparing update…');

    const unlisten = await listen<{ status?: string }>(APP_UPDATE_STATUS_EVENT, (event) => {
      if (typeof event.payload?.status === 'string' && event.payload.status) {
        onStatus?.(event.payload.status);
      }
    });

    try {
      await invoke('install_app_update');
    } finally {
      unlisten();
    }
  })().finally(() => {
    activeInstallPromise = null;
  });

  return activeInstallPromise;
}

export async function runAppUpdateInstall(
  queryClient: QueryClient,
  update?: AppUpdateHandle | null,
  onStatus?: (status: string) => void,
): Promise<void> {
  if (!isTauriDesktopRuntime()) {
    writeAppUpdateState(queryClient, () => createInitialAppUpdateState());
    throw new Error('Application updates are only available inside the packaged desktop app.');
  }

  const targetUpdate = update ?? readAppUpdateState(queryClient).update;

  if (!targetUpdate) {
    throw new Error('No pending update is available to install.');
  }

  writeAppUpdateState(queryClient, (current) => ({
    ...current,
    isSupported: true,
    status: 'installing',
    update: targetUpdate,
    installStatus: 'Preparing update…',
    errorMessage: null,
  }));

  try {
    await installAppUpdate(targetUpdate, (status) => {
      writeAppUpdateState(queryClient, (current) => ({
        ...current,
        isSupported: true,
        status: 'installing',
        update: targetUpdate,
        installStatus: status,
        errorMessage: null,
      }));
      onStatus?.(status);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let recoveredUpdate: AppUpdateHandle | null = null;
    let recoveredCheckSucceeded = false;

    try {
      recoveredUpdate = await checkForAppUpdate();
      recoveredCheckSucceeded = true;
    } catch {
      recoveredUpdate = null;
    }

    if (recoveredCheckSucceeded && !recoveredUpdate) {
      queryClient.setQueryData<string | null>(
        APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
        null,
      );
    }

    writeAppUpdateState(queryClient, (current) => ({
      ...current,
      isSupported: true,
      status: recoveredUpdate ?? current.update ?? targetUpdate ? 'available' : 'error',
      update: recoveredUpdate ?? current.update ?? targetUpdate,
      lastCheckedAt: recoveredUpdate ? Date.now() : current.lastCheckedAt,
      installStatus: null,
      errorMessage:
        recoveredUpdate || current.update
          ? message
          : `${message} Run another update check before retrying installation.`,
    }));

    throw error;
  }
}