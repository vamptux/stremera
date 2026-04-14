import { useEffect, useEffectEvent, useState } from 'react';

import {
  type LegacyStorageFeature,
  type LegacyStorageReadResult,
  markLegacyStorageFeatureComplete,
} from '@/lib/legacy-storage';

interface UseLegacyStorageImportOptions<TLegacy, TSaved> {
  clearLegacy: () => void;
  enabled?: boolean;
  feature: LegacyStorageFeature;
  importLegacy: (value: TLegacy) => Promise<TSaved>;
  onSkipped?: () => void;
  onImported: (value: TSaved) => void;
  readResult: LegacyStorageReadResult<TLegacy>;
  skipImport?: boolean;
}

export function useLegacyStorageImport<TLegacy, TSaved>({
  clearLegacy,
  enabled = true,
  feature,
  importLegacy,
  onSkipped,
  onImported,
  readResult,
  skipImport = false,
}: UseLegacyStorageImportOptions<TLegacy, TSaved>) {
  const [hasAttemptedImport, setHasAttemptedImport] = useState(() => !readResult.hasLegacyData);

  const markImportHandled = useEffectEvent(() => {
    setHasAttemptedImport(true);
  });

  const applyImportedValue = useEffectEvent((value: TSaved) => {
    onImported(value);
  });

  const handleSkippedImport = useEffectEvent(() => {
    onSkipped?.();
  });

  const clearLegacyValue = useEffectEvent(() => {
    clearLegacy();
  });

  const runLegacyImport = useEffectEvent((legacyValue: TLegacy) => importLegacy(legacyValue));

  useEffect(() => {
    if (!readResult.hasLegacyData) {
      markLegacyStorageFeatureComplete(feature);

      if (!hasAttemptedImport) {
        markImportHandled();
      }
    }
  }, [feature, hasAttemptedImport, readResult.hasLegacyData]);

  useEffect(() => {
    if (!enabled || hasAttemptedImport) {
      return;
    }

    if (!readResult.hasLegacyData) {
      markImportHandled();
      return;
    }

    if (skipImport) {
      handleSkippedImport();
      markImportHandled();
      return;
    }

    const legacyValue = readResult.value;
    if (legacyValue == null) {
      clearLegacyValue();
      markImportHandled();
      return;
    }

    let cancelled = false;

    void runLegacyImport(legacyValue)
      .then((savedValue) => {
        if (cancelled) {
          return;
        }

        applyImportedValue(savedValue);
        clearLegacyValue();
        markImportHandled();
      })
      .catch(() => {
        if (!cancelled) {
          markImportHandled();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, hasAttemptedImport, readResult.hasLegacyData, readResult.value, skipImport]);

  return {
    hasLegacyData: readResult.hasLegacyData,
    legacyValue: readResult.value,
  };
}
