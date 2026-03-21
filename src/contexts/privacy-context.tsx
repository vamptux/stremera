import { createContext, useContext, useEffect, useMemo, useState, ReactNode, useCallback } from 'react';

export interface PrivacyContextType {
  isIncognito: boolean;
  /** Unix ms timestamp when incognito was last activated, null when off. */
  activatedAt: number | null;
  setIncognito: (enabled: boolean) => void;
  toggleIncognito: () => void;
}

const PrivacyContext = createContext<PrivacyContextType | undefined>(undefined);
const PRIVACY_STORAGE_KEY = 'streamy-incognito';

function readIncognitoFlag(): boolean {
  try {
    return sessionStorage.getItem(PRIVACY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistIncognitoFlag(enabled: boolean) {
  try {
    sessionStorage.setItem(PRIVACY_STORAGE_KEY, String(enabled));
  } catch {
    // sessionStorage can be unavailable in sandboxed/private contexts.
  }
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [isIncognito, setIsIncognito] = useState(readIncognitoFlag);

  // Track when incognito was activated (session-scoped; resets on page reload)
  const [activatedAt, setActivatedAt] = useState<number | null>(() =>
    readIncognitoFlag() ? Date.now() : null,
  );

  const applyIncognitoState = useCallback((enabled: boolean) => {
    setIsIncognito(enabled);
    setActivatedAt(enabled ? Date.now() : null);
    persistIncognitoFlag(enabled);
  }, []);

  const setIncognito = useCallback((enabled: boolean) => {
    applyIncognitoState(enabled);
  }, [applyIncognitoState]);

  const toggleIncognito = useCallback(() => {
    applyIncognitoState(!isIncognito);
  }, [applyIncognitoState, isIncognito]);

  useEffect(() => {
    document.body.dataset.incognito = isIncognito ? 'on' : 'off';
    return () => {
      delete document.body.dataset.incognito;
    };
  }, [isIncognito]);

  const value = useMemo(
    () => ({ isIncognito, activatedAt, setIncognito, toggleIncognito }),
    [isIncognito, activatedAt, setIncognito, toggleIncognito]
  );

  return (
    <PrivacyContext.Provider value={value}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  const context = useContext(PrivacyContext);
  if (context === undefined) {
    throw new Error('usePrivacy must be used within a PrivacyProvider');
  }
  return context;
}
