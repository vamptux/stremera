import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useLegacyStorageImport } from '@/hooks/use-legacy-storage-import';
import {
  api,
  type AppUiPreferences,
  type AppUiPreferencesPatch,
} from '@/lib/api';
import {
  clearLegacyStorageFeatureKeys,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';

const LEGACY_PLAYER_VOLUME_STORAGE_KEY = 'player:volume';
const LEGACY_PLAYER_SPEED_STORAGE_KEY = 'player:speed';
const LEGACY_SPOILER_PROTECTION_STORAGE_KEY = 'streamy_spoiler_protection';
const APP_UI_LEGACY_STORAGE_FEATURE = 'app-ui-preferences';
const APP_UI_PREFERENCES_QUERY_KEY = ['appUiPreferences'] as const;

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

  const preferencesQuery = useQuery({
    queryKey: APP_UI_PREFERENCES_QUERY_KEY,
    queryFn: api.getAppUiPreferences,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: legacyPreferences ?? DEFAULT_APP_UI_PREFERENCES,
  });

  useLegacyStorageImport({
    clearLegacy: clearLegacyAppUiPreferences,
    enabled: preferencesQuery.isSuccess,
    feature: APP_UI_LEGACY_STORAGE_FEATURE,
    importLegacy: api.importLegacyAppUiPreferences,
    onImported: (savedPreferences) => {
      queryClient.setQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY, savedPreferences);
    },
    readResult: legacyPreferencesRead,
  });

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

      await runOptimisticQueryMutation({
        mutate: savePreferencesMutation.mutateAsync,
        optimisticData: optimisticPreferences,
        queryClient,
        queryKey: APP_UI_PREFERENCES_QUERY_KEY,
        variables: patch,
      });
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