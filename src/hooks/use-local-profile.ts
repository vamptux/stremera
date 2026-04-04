import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useLegacyStorageImport } from '@/hooks/use-legacy-storage-import';
import {
  api,
  type LocalProfile,
  type ProfilePreferences,
  type ProfileViewMode,
} from '@/lib/api';
import {
  clearLegacyStorageFeatureKeys,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';

export type { LocalProfile, ProfileViewMode };

const LEGACY_PROFILE_STORAGE_KEY = 'streamy_profile';
const LEGACY_PROFILE_VIEW_STORAGE_KEY = 'streamy_profile_view';
const PROFILE_LEGACY_STORAGE_FEATURE = 'profile-preferences';
const PROFILE_PREFERENCES_QUERY_KEY = ['profilePreferences'] as const;
const PROFILE_NAME_MAX_LENGTH = 32;
const PROFILE_BIO_MAX_LENGTH = 80;
const PROFILE_ACCENT_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_PROFILE: LocalProfile = {
  username: 'Guest User',
  accentColor: '#ffffff',
  bio: '',
};

const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  profile: DEFAULT_PROFILE,
  viewMode: 'grid',
};

function sanitizeProfile(value: unknown): LocalProfile {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof LocalProfile, unknown>>)
      : {};

  const username =
    typeof raw.username === 'string' && raw.username.trim().length > 0
      ? raw.username.trim().slice(0, PROFILE_NAME_MAX_LENGTH)
      : DEFAULT_PROFILE.username;
  const bio =
    typeof raw.bio === 'string'
      ? raw.bio.trim().slice(0, PROFILE_BIO_MAX_LENGTH)
      : DEFAULT_PROFILE.bio;
  const accentColor =
    typeof raw.accentColor === 'string' && PROFILE_ACCENT_COLOR_REGEX.test(raw.accentColor.trim())
      ? raw.accentColor.trim().toLowerCase()
      : DEFAULT_PROFILE.accentColor;

  return {
    username,
    accentColor,
    bio,
  };
}

function sanitizeViewMode(value: unknown): ProfileViewMode {
  return value === 'list' ? 'list' : 'grid';
}

function sanitizeProfilePreferences(value: unknown): ProfilePreferences {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof ProfilePreferences, unknown>>)
      : {};

  return {
    profile: sanitizeProfile(raw.profile),
    viewMode: sanitizeViewMode(raw.viewMode),
  };
}

function readLegacyProfilePreferences(): LegacyStorageReadResult<ProfilePreferences> {
  return readLegacyStorageFeature(PROFILE_LEGACY_STORAGE_FEATURE, (storage) => {
    let storedProfile: unknown = undefined;
    let storedViewMode: unknown = undefined;
    let hasLegacyData = false;

    try {
      const rawProfile = storage.getItem(LEGACY_PROFILE_STORAGE_KEY);
      if (rawProfile) {
        storedProfile = JSON.parse(rawProfile);
        hasLegacyData = true;
      }
    } catch {
      hasLegacyData = true;
    }

    try {
      const rawViewMode = storage.getItem(LEGACY_PROFILE_VIEW_STORAGE_KEY);
      if (rawViewMode !== null) {
        storedViewMode = rawViewMode;
        hasLegacyData = true;
      }
    } catch {
      hasLegacyData = true;
    }

    return {
      hasLegacyData,
      value: hasLegacyData
        ? sanitizeProfilePreferences({
            profile: storedProfile,
            viewMode: storedViewMode,
          })
        : null,
    };
  });
}

function clearLegacyProfilePreferences() {
  clearLegacyStorageFeatureKeys(PROFILE_LEGACY_STORAGE_FEATURE, [
    LEGACY_PROFILE_STORAGE_KEY,
    LEGACY_PROFILE_VIEW_STORAGE_KEY,
  ]);
}

export function useLocalProfile() {
  const queryClient = useQueryClient();
  const legacyProfilePreferencesRead = useMemo(() => readLegacyProfilePreferences(), []);
  const legacyProfilePreferences = legacyProfilePreferencesRead.value;

  const profilePreferencesQuery = useQuery({
    queryKey: PROFILE_PREFERENCES_QUERY_KEY,
    queryFn: api.getProfilePreferences,
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: legacyProfilePreferences ?? DEFAULT_PROFILE_PREFERENCES,
  });

  useLegacyStorageImport({
    clearLegacy: clearLegacyProfilePreferences,
    enabled: profilePreferencesQuery.isSuccess,
    feature: PROFILE_LEGACY_STORAGE_FEATURE,
    importLegacy: (preferences) =>
      api.importLegacyProfilePreferences(preferences.profile, preferences.viewMode),
    onImported: (savedPreferences) => {
      queryClient.setQueryData<ProfilePreferences>(
        PROFILE_PREFERENCES_QUERY_KEY,
        savedPreferences,
      );
    },
    readResult: legacyProfilePreferencesRead,
  });

  const savePreferencesMutation = useMutation({
    mutationFn: (preferences: ProfilePreferences) =>
      api.saveProfilePreferences(preferences.profile, preferences.viewMode),
  });

  const currentPreferences = sanitizeProfilePreferences(
    profilePreferencesQuery.isSuccess
      ? profilePreferencesQuery.data
      : legacyProfilePreferences ?? DEFAULT_PROFILE_PREFERENCES,
  );

  const persistPreferences = useCallback(
    async (nextPreferences: ProfilePreferences) => {
      const sanitized = sanitizeProfilePreferences(nextPreferences);
      await runOptimisticQueryMutation({
        mutate: savePreferencesMutation.mutateAsync,
        optimisticData: sanitized,
        queryClient,
        queryKey: PROFILE_PREFERENCES_QUERY_KEY,
        variables: sanitized,
      });
    },
    [queryClient, savePreferencesMutation],
  );

  const updateProfile = useCallback(
    (updates: Partial<LocalProfile>) =>
      persistPreferences({
        ...currentPreferences,
        profile: sanitizeProfile({
          ...currentPreferences.profile,
          ...updates,
        }),
      }),
    [currentPreferences, persistPreferences],
  );

  const updateViewMode = useCallback(
    (viewMode: ProfileViewMode) =>
      persistPreferences({
        ...currentPreferences,
        viewMode: sanitizeViewMode(viewMode),
      }),
    [currentPreferences, persistPreferences],
  );

  return {
    profile: currentPreferences.profile,
    viewMode: currentPreferences.viewMode,
    updateProfile,
    updateViewMode,
    isLoading: profilePreferencesQuery.isLoading && !profilePreferencesQuery.data,
    isSaving: savePreferencesMutation.isPending,
  };
}
