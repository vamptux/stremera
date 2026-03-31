import { useCallback, useEffect, useRef } from 'react';

interface UsePlayerNavigationGuardArgs {
  enabled: boolean;
  flushBeforeNavigation: () => Promise<void>;
}

export function usePlayerNavigationGuard({
  enabled,
  flushBeforeNavigation,
}: UsePlayerNavigationGuardArgs) {
  const allowNavigationRef = useRef(false);

  const allowNextNavigation = useCallback(() => {
    allowNavigationRef.current = true;
    window.setTimeout(() => {
      allowNavigationRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    if (!enabled) {
      allowNavigationRef.current = false;
      return;
    }

    return () => {
      if (allowNavigationRef.current) {
        allowNavigationRef.current = false;
        return;
      }

      void flushBeforeNavigation().catch(() => {
        // Unmount-triggered flush is best effort only.
      });
    };
  }, [enabled, flushBeforeNavigation]);

  return {
    allowNextNavigation,
  } satisfies {
    allowNextNavigation: () => void;
  };
}