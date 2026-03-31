import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PlaybackLanguagePreferences } from '@/lib/api';
import {
  inferTrackPreferredLanguage,
  normalizeLanguageToken,
  type Track,
} from '@/lib/player-track-utils';
import { useAutoApplyTrackPreferences } from '@/hooks/use-auto-apply-track-preferences';

interface UsePlayerTrackPreferencesArgs {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  activeStreamUrl?: string;
  hasPlaybackStarted: boolean;
  isLoading: boolean;
  isResolving: boolean;
  resetKey: string;
  audioTracks: Track[];
  subTracks: Track[];
  activeAudioTrack: Track | null;
  activeSubTrack: Track | null;
  subtitlesOff: boolean;
  trackSwitching: { audio: boolean; sub: boolean };
  setTrack: (
    type: 'audio' | 'sub',
    id: number | 'no',
    options?: { silent?: boolean; persistPreference?: boolean },
  ) => Promise<void> | void;
}

interface UsePlayerTrackPreferencesResult {
  persistSelectedTrackPreference: (type: 'audio' | 'sub', id: number | 'no') => void;
}

export function usePlayerTrackPreferences({
  mediaId,
  mediaType,
  activeStreamUrl,
  hasPlaybackStarted,
  isLoading,
  isResolving,
  resetKey,
  audioTracks,
  subTracks,
  activeAudioTrack,
  activeSubTrack,
  subtitlesOff,
  trackSwitching,
  setTrack,
}: UsePlayerTrackPreferencesArgs): UsePlayerTrackPreferencesResult {
  const queryClient = useQueryClient();
  const { data: globalPlaybackLanguagePreferences } = useQuery({
    queryKey: ['playbackLanguagePreferences'],
    queryFn: api.getPlaybackLanguagePreferences,
    staleTime: 1000 * 60 * 5,
  });
  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: ['effectivePlaybackLanguagePreferences', mediaType, mediaId],
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaId, mediaType),
    enabled: !!mediaId && mediaId !== 'local',
    staleTime: 1000 * 60 * 5,
  });
  const globalPlaybackPrefsRef = useRef<PlaybackLanguagePreferences>({});
  const globalPlaybackPrefsHydratedRef = useRef(false);
  const savePlaybackPrefsQueueRef = useRef(Promise.resolve());
  const lastRecordedTrackOutcomeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!globalPlaybackLanguagePreferences) {
      return;
    }

    globalPlaybackPrefsRef.current = {
      preferredAudioLanguage:
        normalizeLanguageToken(globalPlaybackLanguagePreferences.preferredAudioLanguage) ||
        undefined,
      preferredSubtitleLanguage:
        normalizeLanguageToken(globalPlaybackLanguagePreferences.preferredSubtitleLanguage) ||
        undefined,
    };
    globalPlaybackPrefsHydratedRef.current = true;
  }, [
    globalPlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences?.preferredAudioLanguage,
    globalPlaybackLanguagePreferences?.preferredSubtitleLanguage,
  ]);

  const savePlaybackPreferencesPatch = useCallback(
    (patch: Partial<PlaybackLanguagePreferences>) => {
      const normalizedPatch: Partial<PlaybackLanguagePreferences> = {
        preferredAudioLanguage:
          patch.preferredAudioLanguage === undefined
            ? undefined
            : normalizeLanguageToken(patch.preferredAudioLanguage) || undefined,
        preferredSubtitleLanguage:
          patch.preferredSubtitleLanguage === undefined
            ? undefined
            : normalizeLanguageToken(patch.preferredSubtitleLanguage) || undefined,
      };

      const saveTask = async () => {
        if (!globalPlaybackPrefsHydratedRef.current) {
          const cached = queryClient.getQueryData<PlaybackLanguagePreferences>([
            'playbackLanguagePreferences',
          ]);
          const fresh = cached ?? (await api.getPlaybackLanguagePreferences());
          globalPlaybackPrefsRef.current = {
            preferredAudioLanguage:
              normalizeLanguageToken(fresh?.preferredAudioLanguage) || undefined,
            preferredSubtitleLanguage:
              normalizeLanguageToken(fresh?.preferredSubtitleLanguage) || undefined,
          };
          globalPlaybackPrefsHydratedRef.current = true;
        }

        const next: PlaybackLanguagePreferences = {
          ...globalPlaybackPrefsRef.current,
          ...normalizedPatch,
        };

        const savedPreferences = await api.savePlaybackLanguagePreferences(
          next.preferredAudioLanguage,
          next.preferredSubtitleLanguage,
        );

        globalPlaybackPrefsRef.current = {
          preferredAudioLanguage:
            normalizeLanguageToken(savedPreferences?.preferredAudioLanguage) || undefined,
          preferredSubtitleLanguage:
            normalizeLanguageToken(savedPreferences?.preferredSubtitleLanguage) || undefined,
        };

        queryClient.setQueryData(
          ['playbackLanguagePreferences'],
          globalPlaybackPrefsRef.current,
        );
        void queryClient.invalidateQueries({ queryKey: ['effectivePlaybackLanguagePreferences'] });
        void queryClient.invalidateQueries({ queryKey: ['streams'] });
      };

      const queued = savePlaybackPrefsQueueRef.current.then(saveTask);
      savePlaybackPrefsQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    [queryClient],
  );

  const persistSelectedTrackPreference = useCallback(
    (type: 'audio' | 'sub', id: number | 'no') => {
      if (type === 'audio') {
        const selectedAudio = audioTracks.find((track) => track.id === id);
        const pref = inferTrackPreferredLanguage(selectedAudio ?? { id: -1, type: 'audio' });
        if (!pref) return;
        void savePlaybackPreferencesPatch({ preferredAudioLanguage: pref });
        return;
      }

      if (id === 'no') {
        void savePlaybackPreferencesPatch({ preferredSubtitleLanguage: 'off' });
        return;
      }

      const selectedSubtitle = subTracks.find((track) => track.id === id);
      const pref = inferTrackPreferredLanguage(selectedSubtitle ?? { id: -1, type: 'sub' });
      if (!pref) return;
      void savePlaybackPreferencesPatch({ preferredSubtitleLanguage: pref });
    },
    [audioTracks, savePlaybackPreferencesPatch, subTracks],
  );

  useAutoApplyTrackPreferences({
    isLoading,
    resetKey,
    playbackLanguagePreferences: effectivePlaybackLanguagePreferences,
    audioTracks,
    subTracks,
    trackSwitching,
    setTrack,
  });

  useEffect(() => {
    lastRecordedTrackOutcomeRef.current = null;
  }, [activeStreamUrl, mediaId, mediaType]);

  useEffect(() => {
    if (!hasPlaybackStarted || isLoading || isResolving || !mediaId || mediaId === 'local') {
      return;
    }

    const preferredAudioLanguage = activeAudioTrack
      ? inferTrackPreferredLanguage(activeAudioTrack)
      : undefined;
    const preferredSubtitleLanguage = subtitlesOff
      ? 'off'
      : activeSubTrack
        ? inferTrackPreferredLanguage(activeSubTrack)
        : undefined;

    if (!preferredAudioLanguage && preferredSubtitleLanguage === undefined) {
      return;
    }

    const fingerprint = [
      activeStreamUrl ?? '',
      preferredAudioLanguage ?? '',
      preferredSubtitleLanguage ?? '',
    ].join('|');

    if (lastRecordedTrackOutcomeRef.current === fingerprint) {
      return;
    }

    lastRecordedTrackOutcomeRef.current = fingerprint;
    void api
      .savePlaybackLanguagePreferenceOutcome(
        mediaId,
        mediaType ?? 'series',
        preferredAudioLanguage,
        preferredSubtitleLanguage,
      )
      .catch(() => {
        // Title-scoped playback preference memory is best-effort only.
      });
  }, [
    activeAudioTrack,
    activeStreamUrl,
    activeSubTrack,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    mediaId,
    mediaType,
    subtitlesOff,
  ]);

  return {
    persistSelectedTrackPreference,
  };
}