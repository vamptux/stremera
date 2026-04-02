import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/lib/api';
import { useAppUpdater } from '@/hooks/use-app-updater';
import {
  getLastNotifiedAppUpdateVersion,
  setLastNotifiedAppUpdateVersion,
} from '@/lib/app-updater';

const UPDATE_TOAST_ID = 'app-update-toast';

export function AppUpdateManager() {
  const didCheckRef = useRef(false);
  const { checkForUpdates, installUpdate, isSupported } = useAppUpdater();

  useEffect(() => {
    if (import.meta.env.DEV || didCheckRef.current || !isSupported) return;
    didCheckRef.current = true;

    void (async () => {
      try {
        const update = await checkForUpdates();
        if (!update) return;

        const lastNotifiedVersion = await getLastNotifiedAppUpdateVersion();
        if (lastNotifiedVersion === update.version) {
          return;
        }

        await setLastNotifiedAppUpdateVersion(update.version);

        toast.info(`Update ${update.version} is ready`, {
          description:
            update.body?.trim() || 'A signed desktop update is available. Install to restart into the latest version.',
          duration: 15000,
          action: {
            label: 'Install',
            onClick: () => {
              toast.loading('Downloading update…', { id: UPDATE_TOAST_ID });
              void installUpdate(update, (status) => {
                toast.loading(status, { id: UPDATE_TOAST_ID });
              }).catch((error) => {
                toast.error('Failed to install update', {
                  id: UPDATE_TOAST_ID,
                  description: getErrorMessage(error),
                });
              });
            },
          },
        });
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Automatic update check failed:', error);
        }
      }
    })();
  }, [checkForUpdates, installUpdate, isSupported]);

  return null;
}