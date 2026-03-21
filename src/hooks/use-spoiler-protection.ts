import { useCallback, useState } from 'react';

const SPOILER_STORAGE_KEY = 'streamy_spoiler_protection';

/**
 * Global spoiler protection toggle.
 * When enabled, episode thumbnails and descriptions are blurred/hidden for
 * episodes the user hasn't watched yet (beyond their furthest progress point).
 *
 * State is persisted to localStorage so it survives page reloads.
 */
export function useSpoilerProtection() {
  const [spoilerProtection, setSpoilerProtectionState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SPOILER_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const setSpoilerProtection = useCallback((enabled: boolean) => {
    setSpoilerProtectionState(enabled);
    try {
      localStorage.setItem(SPOILER_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // localStorage unavailable (sandboxed / private mode) — state still works in memory
    }
  }, []);

  return { spoilerProtection, setSpoilerProtection };
}
