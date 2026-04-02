import { useCallback } from 'react';

import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';

/**
 * Global spoiler protection toggle.
 * When enabled, episode thumbnails and descriptions are blurred/hidden for
 * episodes the user hasn't watched yet (beyond their furthest progress point).
 *
 * State is persisted through backend-managed desktop settings.
 */
export function useSpoilerProtection() {
  const { preferences, updatePreferences, isLoading, isSaving } = useAppUiPreferences();

  const setSpoilerProtection = useCallback((enabled: boolean) => {
    void updatePreferences({ spoilerProtection: enabled });
  }, [updatePreferences]);

  return {
    spoilerProtection: preferences.spoilerProtection,
    setSpoilerProtection,
    isLoading,
    isSaving,
  };
}
