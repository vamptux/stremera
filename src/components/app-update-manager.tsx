import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/lib/api';
import { checkForAppUpdate, installAppUpdate } from '@/lib/app-updater';

async function installFromToast(update: NonNullable<Awaited<ReturnType<typeof checkForAppUpdate>>>) {
  toast.loading('Downloading update…', { id: 'app-update-toast' });

  try {
    await installAppUpdate(update, (status) => {
      toast.loading(status, { id: 'app-update-toast' });
    });
  } catch (error) {
    toast.error('Failed to install update', {
      id: 'app-update-toast',
      description: getErrorMessage(error),
    });
  }
}

export function AppUpdateManager() {
  const didCheckRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.DEV || didCheckRef.current) return;
    didCheckRef.current = true;

    void (async () => {
      try {
        const update = await checkForAppUpdate();
        if (!update) return;

        toast.info(`Update ${update.version} is ready`, {
          description:
            update.body?.trim() || 'A signed desktop update is available. Install to restart into the latest version.',
          duration: 15000,
          action: {
            label: 'Install',
            onClick: () => {
              void installFromToast(update);
            },
          },
        });
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Automatic update check failed:', error);
        }
      }
    })();
  }, []);

  return null;
}