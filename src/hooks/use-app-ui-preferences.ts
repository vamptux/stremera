import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';

import {
  api,
  type AppUiPreferences,
  type AppUiPreferencesPatch,
} from '@/lib/api';
import {
  clearLegacyStorageFeatureKeys,
  markLegacyStorageFeatureComplete,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';

const LEGACY_PLAYER_VOLUME_STORAGE_KEY = 'player:volume';
const LEGACY_PLAYER_SPEED_STORAGE_KEY = 'player:speed';
const LEGACY_SPOILER_PROTECTION_STORAGE_KEY = 'streamy_spoiler_protection';
const APP_UI_LEGACY_STORAGE_FEATURE = 'app-ui-preferences';

const DEFAULT_APP_UI_PREFERENCES: AppUiPreferences = {
  playerVolume: 75,
  playerSpeed: 1,
  spoilerProtection: false,
};

function sanitizePlayerVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_APP_UI_PREFERENCES.playerVolume;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function sanitizePlayerSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_APP_UI_PREFERENCES.playerSpeed;
  }

  return Math.max(0.25, Math.min(4, value));
}

function sanitizeAppUiPreferences(value: unknown): AppUiPreferences {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof AppUiPreferences, unknown>>)
      : {};

  return {
    playerVolume: sanitizePlayerVolume(raw.playerVolume),
    playerSpeed: sanitizePlayerSpeed(raw.playerSpeed),
    spoilerProtection: raw.spoilerProtection === true,
  };
}

function readLegacyAppUiPreferences(): LegacyStorageReadResult<AppUiPreferences> {
  return readLegacyStorageFeature(APP_UI_LEGACY_STORAGE_FEATURE, (storage) => {
    let hasLegacyData = false;
    let playerVolume: number | undefined;
    let playerSpeed: number | undefined;
    let spoilerProtection: boolean | undefined;

    try {
      const savedVolume = storage.getItem(LEGACY_PLAYER_VOLUME_STORAGE_KEY);
      if (savedVolume !== null) {
        playerVolume = Number.parseInt(savedVolume, 10);
        hasLegacyData = true;
      }
    } catch {
      hasLegacyData = true;
    }

    try {
      const savedSpeed = storage.getItem(LEGACY_PLAYER_SPEED_STORAGE_KEY);
      if (savedSpeed !== null) {
        playerSpeed = Number.parseFloat(savedSpeed);
        hasLegacyData = true;
      }
    } catch {
      hasLegacyData = true;
    }

    try {
      const savedSpoilerProtection = storage.getItem(
        LEGACY_SPOILER_PROTECTION_STORAGE_KEY,
      );
      if (savedSpoilerProtection !== null) {
        spoilerProtection = savedSpoilerProtection === 'true';
        hasLegacyData = true;
      }
    } catch {
      hasLegacyData = true;
    }

    return {
      hasLegacyData,
      value: hasLegacyData
        ? sanitizeAppUiPreferences({
            playerVolume,
            playerSpeed,
            spoilerProtection,
          })
        : null,
    };
  });
}

function clearLegacyAppUiPreferences() {
  clearLegacyStorageFeatureKeys(APP_UI_LEGACY_STORAGE_FEATURE, [
    LEGACY_PLAYER_VOLUME_STORAGE_KEY,
    LEGACY_PLAYER_SPEED_STORAGE_KEY,
    LEGACY_SPOILER_PROTECTION_STORAGE_KEY,
  ]);
}

export function useAppUiPreferences() {
  const queryClient = useQueryClient();
  const legacyPreferencesRead = useMemo(() => readLegacyAppUiPreferences(), []);
  const legacyPreferences = legacyPreferencesRead.value;
  const [hasAttemptedLegacyImport, setHasAttemptedLegacyImport] = useState(
    () => !legacyPreferencesRead.hasLegacyData,
  );
  const markLegacyImportHandled = useEffectEvent(() => {
    setHasAttemptedLegacyImport(true);
  });

  const preferencesQuery = useQuery({
    queryKey: ['appUiPreferences'],
    queryFn: api.getAppUiPreferences,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: legacyPreferences ?? DEFAULT_APP_UI_PREFERENCES,
  });

  useEffect(() => {
    if (!legacyPreferencesRead.hasLegacyData) {
      markLegacyStorageFeatureComplete(APP_UI_LEGACY_STORAGE_FEATURE);
    }
  }, [legacyPreferencesRead.hasLegacyData]);

  useEffect(() => {
    if (hasAttemptedLegacyImport || !preferencesQuery.isSuccess) {
      return;
    }

    if (!legacyPreferencesRead.hasLegacyData) {
      markLegacyImportHandled();
      return;
    }

    if (!legacyPreferences) {
      clearLegacyAppUiPreferences();
      markLegacyImportHandled();
      return;
    }

    let cancelled = false;

    void api
      .importLegacyAppUiPreferences(legacyPreferences)
      .then((savedPreferences) => {
        if (cancelled) {
          return;
        }

        queryClient.setQueryData<AppUiPreferences>(['appUiPreferences'], savedPreferences);
        clearLegacyAppUiPreferences();
        markLegacyImportHandled();
      })
      .catch(() => {
        if (!cancelled) {
          markLegacyImportHandled();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasAttemptedLegacyImport,
    legacyPreferences,
    legacyPreferencesRead.hasLegacyData,
    preferencesQuery.isSuccess,
    queryClient,
  ]);

  const savePreferencesMutation = useMutation({
    mutationFn: (patch: AppUiPreferencesPatch) => api.saveAppUiPreferences(patch),
  });

  const currentPreferences = sanitizeAppUiPreferences(
    preferencesQuery.isSuccess
      ? preferencesQuery.data
      : legacyPreferences ?? DEFAULT_APP_UI_PREFERENCES,
  );

  const updatePreferences = useCallback(
    async (patch: AppUiPreferencesPatch) => {
      const optimisticPreferences = sanitizeAppUiPreferences({
        ...currentPreferences,
        ...patch,
      });

      queryClient.setQueryData<AppUiPreferences>(['appUiPreferences'], optimisticPreferences);

      try {
        const savedPreferences = await savePreferencesMutation.mutateAsync(patch);
        queryClient.setQueryData<AppUiPreferences>(['appUiPreferences'], savedPreferences);
      } catch (error) {
        await queryClient.invalidateQueries({ queryKey: ['appUiPreferences'] });
        throw error;
      }
    },
    [currentPreferences, queryClient, savePreferencesMutation],
  );

  return {
    preferences: currentPreferences,
    updatePreferences,
    isLoading: preferencesQuery.isLoading && !preferencesQuery.data,
    isSaving: savePreferencesMutation.isPending,
  };
}