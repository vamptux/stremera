import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

type RawUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export interface AppUpdateHandle {
  raw: RawUpdate;
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
}

let activeInstallPromise: Promise<void> | null = null;

export function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getCurrentAppVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateHandle | null> {
  if (!isTauriDesktopRuntime()) return null;

  const update = await check();
  if (!update) return null;
  if ('available' in update && update.available === false) return null;

  return {
    raw: update,
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body,
    date: update.date,
  };
}

export async function installAppUpdate(
  update: AppUpdateHandle,
  onStatus?: (status: string) => void,
): Promise<void> {
  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  activeInstallPromise = (async () => {
    await update.raw.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started': {
          const total = event.data.contentLength;
          onStatus?.(
            typeof total === 'number'
              ? `Downloading update (${Math.round(total / 1024 / 1024)} MB)…`
              : 'Downloading update…',
          );
          break;
        }
        case 'Progress':
          onStatus?.('Downloading update…');
          break;
        case 'Finished':
          onStatus?.('Installing update…');
          break;
      }
    });

    onStatus?.('Restarting app…');
    await relaunch();
  })().finally(() => {
    activeInstallPromise = null;
  });

  return activeInstallPromise;
}