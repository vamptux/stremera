import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const APP_UPDATE_STATE_QUERY_KEY = ['app-update-state'] as const;
export const APP_VERSION_QUERY_KEY = ['appVersion'] as const;
const APP_UPDATE_STATUS_EVENT = 'app-update-status';

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
  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  activeInstallPromise = (async () => {
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
  const targetUpdate = update ?? readAppUpdateState(queryClient).update;

  if (!targetUpdate) {
    throw new Error('No pending update is available to install.');
  }

  writeAppUpdateState(queryClient, (current) => ({
    ...current,
    isSupported: true,
    status: 'installing',
    update: targetUpdate,
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

    writeAppUpdateState(queryClient, (current) => ({
      ...current,
      isSupported: true,
      status: current.update ? 'available' : 'error',
      installStatus: null,
      errorMessage: message,
    }));

    throw error;
  }
}