import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type PlaybackLanguagePreferences } from '@/lib/api';
import { normalizeLanguageToken } from '@/lib/player-track-utils';
import { invalidatePlaybackLanguageQueries } from '@/lib/query-invalidation';

const PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = ['playbackLanguagePreferences'] as const;
const PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME = 1000 * 60 * 5;

function normalizePlaybackLanguagePreference(value?: string | null): string | undefined {
  return normalizeLanguageToken(value) || undefined;
}

function normalizePlaybackLanguagePreferences(
  preferences?: PlaybackLanguagePreferences | null,
): PlaybackLanguagePreferences {
  return {
    preferredAudioLanguage: normalizePlaybackLanguagePreference(
      preferences?.preferredAudioLanguage,
    ),
    preferredSubtitleLanguage: normalizePlaybackLanguagePreference(
      preferences?.preferredSubtitleLanguage,
    ),
  };
}

function normalizePlaybackLanguagePatch(
  patch: Partial<PlaybackLanguagePreferences>,
): Partial<PlaybackLanguagePreferences> {
  const normalizedPatch: Partial<PlaybackLanguagePreferences> = {};

  if (Object.prototype.hasOwnProperty.call(patch, 'preferredAudioLanguage')) {
    normalizedPatch.preferredAudioLanguage = normalizePlaybackLanguagePreference(
      patch.preferredAudioLanguage,
    );
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'preferredSubtitleLanguage')) {
    normalizedPatch.preferredSubtitleLanguage = normalizePlaybackLanguagePreference(
      patch.preferredSubtitleLanguage,
    );
  }

  return normalizedPatch;
}

function effectivePlaybackLanguagePreferencesQueryKey(mediaType?: string, mediaId?: string) {
  return ['effectivePlaybackLanguagePreferences', mediaType, mediaId] as const;
}

interface UsePlaybackLanguagePreferencesOptions {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
}

export function usePlaybackLanguagePreferences({
  mediaId,
  mediaType,
}: UsePlaybackLanguagePreferencesOptions = {}) {
  const queryClient = useQueryClient();
  const globalPlaybackPreferencesRef = useRef<PlaybackLanguagePreferences>({});
  const globalPlaybackPreferencesHydratedRef = useRef(false);
  const saveQueueRef = useRef(Promise.resolve<PlaybackLanguagePreferences | undefined>(undefined));

  const {
    data: globalPlaybackLanguagePreferences,
    isLoading: isLoadingGlobalPlaybackLanguagePreferences,
  } = useQuery({
    queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
    queryFn: api.getPlaybackLanguagePreferences,
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
    select: normalizePlaybackLanguagePreferences,
  });

  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaId, mediaType),
    enabled: !!mediaId && mediaId !== 'local',
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
    select: normalizePlaybackLanguagePreferences,
  });

  useEffect(() => {
    if (!globalPlaybackLanguagePreferences) {
      return;
    }

    globalPlaybackPreferencesRef.current = globalPlaybackLanguagePreferences;
    globalPlaybackPreferencesHydratedRef.current = true;
  }, [
    globalPlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences?.preferredAudioLanguage,
    globalPlaybackLanguagePreferences?.preferredSubtitleLanguage,
  ]);

  const saveGlobalPlaybackLanguagePreferences = useCallback(
    (patch: Partial<PlaybackLanguagePreferences>) => {
      const normalizedPatch = normalizePlaybackLanguagePatch(patch);

      const saveTask = async () => {
        if (!globalPlaybackPreferencesHydratedRef.current) {
          const cached = queryClient.getQueryData<PlaybackLanguagePreferences>(
            PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
          );
          const fresh = cached ?? (await api.getPlaybackLanguagePreferences());

          globalPlaybackPreferencesRef.current = normalizePlaybackLanguagePreferences(fresh);
          globalPlaybackPreferencesHydratedRef.current = true;
        }

        const nextPreferences: PlaybackLanguagePreferences = {
          ...globalPlaybackPreferencesRef.current,
          ...normalizedPatch,
        };

        const savedPreferences = normalizePlaybackLanguagePreferences(
          await api.savePlaybackLanguagePreferences(
            nextPreferences.preferredAudioLanguage,
            nextPreferences.preferredSubtitleLanguage,
          ),
        );

        globalPlaybackPreferencesRef.current = savedPreferences;
        queryClient.setQueryData(PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, savedPreferences);

        await invalidatePlaybackLanguageQueries(queryClient);

        return savedPreferences;
      };

      const queuedSave = saveQueueRef.current.then(saveTask);
      saveQueueRef.current = queuedSave.catch(() => undefined);
      return queuedSave;
    },
    [queryClient],
  );

  return {
    effectivePlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferences,
  };
}