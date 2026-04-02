import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';

import {
  api,
  type LocalProfile,
  type ProfilePreferences,
  type ProfileViewMode,
} from '@/lib/api';
import {
  clearLegacyStorageFeatureKeys,
  markLegacyStorageFeatureComplete,
  readLegacyStorageFeature,
  type LegacyStorageReadResult,
} from '@/lib/legacy-storage';

export type { LocalProfile, ProfileViewMode };

const LEGACY_PROFILE_STORAGE_KEY = 'streamy_profile';
const LEGACY_PROFILE_VIEW_STORAGE_KEY = 'streamy_profile_view';
const PROFILE_LEGACY_STORAGE_FEATURE = 'profile-preferences';
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
  const [hasAttemptedLegacyImport, setHasAttemptedLegacyImport] = useState(
    () => !legacyProfilePreferencesRead.hasLegacyData,
  );
  const markLegacyImportHandled = useEffectEvent(() => {
    setHasAttemptedLegacyImport(true);
  });

  const profilePreferencesQuery = useQuery({
    queryKey: ['profilePreferences'],
    queryFn: api.getProfilePreferences,
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: legacyProfilePreferences ?? DEFAULT_PROFILE_PREFERENCES,
  });

  useEffect(() => {
    if (!legacyProfilePreferencesRead.hasLegacyData) {
      markLegacyStorageFeatureComplete(PROFILE_LEGACY_STORAGE_FEATURE);
    }
  }, [legacyProfilePreferencesRead.hasLegacyData]);

  useEffect(() => {
    if (hasAttemptedLegacyImport || !profilePreferencesQuery.isSuccess) {
      return;
    }

    if (!legacyProfilePreferencesRead.hasLegacyData) {
      markLegacyImportHandled();
      return;
    }

    if (!legacyProfilePreferences) {
      clearLegacyProfilePreferences();
      markLegacyImportHandled();
      return;
    }

    let cancelled = false;

    void api
      .importLegacyProfilePreferences(
        legacyProfilePreferences.profile,
        legacyProfilePreferences.viewMode,
      )
      .then((savedPreferences) => {
        if (cancelled) {
          return;
        }

        queryClient.setQueryData<ProfilePreferences>(['profilePreferences'], savedPreferences);
        clearLegacyProfilePreferences();
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
    legacyProfilePreferences,
    legacyProfilePreferencesRead.hasLegacyData,
    profilePreferencesQuery.isSuccess,
    queryClient,
  ]);

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
      queryClient.setQueryData<ProfilePreferences>(['profilePreferences'], sanitized);

      try {
        const savedPreferences = await savePreferencesMutation.mutateAsync(sanitized);
        queryClient.setQueryData<ProfilePreferences>(['profilePreferences'], savedPreferences);
      } catch (error) {
        await queryClient.invalidateQueries({ queryKey: ['profilePreferences'] });
        throw error;
      }
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
