import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { api, type PlaybackLanguagePreferences, type TrackLanguageCandidate } from '@/lib/api';
import { invalidatePlaybackLanguageQueries } from '@/lib/query-invalidation';

const PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = ['playbackLanguagePreferences'] as const;
const PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME = 1000 * 60 * 5;

function applyPlaybackLanguagePatch(
  current: PlaybackLanguagePreferences,
  patch: Partial<PlaybackLanguagePreferences>,
): PlaybackLanguagePreferences {
  const nextPreferences: PlaybackLanguagePreferences = {
    ...current,
  };

  if ('preferredAudioLanguage' in patch) {
    nextPreferences.preferredAudioLanguage = patch.preferredAudioLanguage;
  }

  if ('preferredSubtitleLanguage' in patch) {
    nextPreferences.preferredSubtitleLanguage = patch.preferredSubtitleLanguage;
  }

  return nextPreferences;
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
  });

  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaId, mediaType),
    enabled: !!mediaId && mediaId !== 'local',
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
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
      const saveTask = async () => {
        if (!globalPlaybackPreferencesHydratedRef.current) {
          const cached = queryClient.getQueryData<PlaybackLanguagePreferences>(
            PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
          );
          const fresh = cached ?? (await api.getPlaybackLanguagePreferences());

          globalPlaybackPreferencesRef.current = fresh;
          globalPlaybackPreferencesHydratedRef.current = true;
        }

        const nextPreferences = applyPlaybackLanguagePatch(
          globalPlaybackPreferencesRef.current,
          patch,
        );

        const savedPreferences = await api.savePlaybackLanguagePreferences(
          nextPreferences.preferredAudioLanguage,
          nextPreferences.preferredSubtitleLanguage,
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

  const saveGlobalPlaybackLanguagePreferenceSelection = useCallback(
    (
      preferenceKind: 'audio' | 'sub',
      track?: TrackLanguageCandidate,
      options?: { subtitlesOff?: boolean },
    ) => {
      const saveTask = async () => {
        const savedPreferences = await api.saveSelectedPlaybackLanguagePreference(
          preferenceKind,
          track,
          options?.subtitlesOff,
        );

        globalPlaybackPreferencesRef.current = savedPreferences;
        globalPlaybackPreferencesHydratedRef.current = true;
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
    saveGlobalPlaybackLanguagePreferenceSelection,
  };
}
