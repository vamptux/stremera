import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type PlaybackLanguagePreferences,
  type TrackLanguageCandidate,
} from '@/lib/api';
import { normalizeLanguageToken, type Track } from '@/lib/player-track-utils';
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
  ) => Promise<boolean> | boolean;
}

interface UsePlayerTrackPreferencesResult {
  persistSelectedTrackPreference: (type: 'audio' | 'sub', id: number | 'no') => void;
  playbackLanguagePreferences: PlaybackLanguagePreferences;
}

function toTrackLanguageCandidate(track: Track): TrackLanguageCandidate {
  return {
    id: track.id,
    lang: track.lang,
    title: track.title,
    defaultTrack: track.defaultTrack,
    forced: track.forced,
    hearingImpaired: track.hearingImpaired,
  };
}

function normalizeStoredPreference(value?: string | null): string | undefined {
  return normalizeLanguageToken(value) || undefined;
}

async function inferTrackLanguagePreference(track: Track | null): Promise<string | undefined> {
  if (!track) {
    return undefined;
  }

  const inferred = await api.inferTrackLanguagePreference(toTrackLanguageCandidate(track));
  return normalizeStoredPreference(inferred);
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

  const autoApplyPlaybackLanguagePreferences: PlaybackLanguagePreferences = {
    preferredAudioLanguage:
      normalizeStoredPreference(globalPlaybackLanguagePreferences?.preferredAudioLanguage) ??
      normalizeStoredPreference(effectivePlaybackLanguagePreferences?.preferredAudioLanguage),
    preferredSubtitleLanguage:
      normalizeStoredPreference(globalPlaybackLanguagePreferences?.preferredSubtitleLanguage) ??
      normalizeStoredPreference(effectivePlaybackLanguagePreferences?.preferredSubtitleLanguage),
  };

  useEffect(() => {
    if (!globalPlaybackLanguagePreferences) {
      return;
    }

    globalPlaybackPrefsRef.current = {
      preferredAudioLanguage: normalizeStoredPreference(
        globalPlaybackLanguagePreferences.preferredAudioLanguage,
      ),
      preferredSubtitleLanguage: normalizeStoredPreference(
        globalPlaybackLanguagePreferences.preferredSubtitleLanguage,
      ),
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
            : normalizeStoredPreference(patch.preferredAudioLanguage),
        preferredSubtitleLanguage:
          patch.preferredSubtitleLanguage === undefined
            ? undefined
            : normalizeStoredPreference(patch.preferredSubtitleLanguage),
      };

      const saveTask = async () => {
        if (!globalPlaybackPrefsHydratedRef.current) {
          const cached = queryClient.getQueryData<PlaybackLanguagePreferences>([
            'playbackLanguagePreferences',
          ]);
          const fresh = cached ?? (await api.getPlaybackLanguagePreferences());
          globalPlaybackPrefsRef.current = {
            preferredAudioLanguage: normalizeStoredPreference(fresh?.preferredAudioLanguage),
            preferredSubtitleLanguage: normalizeStoredPreference(
              fresh?.preferredSubtitleLanguage,
            ),
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
          preferredAudioLanguage: normalizeStoredPreference(savedPreferences?.preferredAudioLanguage),
          preferredSubtitleLanguage: normalizeStoredPreference(
            savedPreferences?.preferredSubtitleLanguage,
          ),
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
        void inferTrackLanguagePreference(selectedAudio ?? null).then((preferredAudioLanguage) => {
          if (!preferredAudioLanguage) return;
          void savePlaybackPreferencesPatch({ preferredAudioLanguage });
        });
        return;
      }

      if (id === 'no') {
        void savePlaybackPreferencesPatch({ preferredSubtitleLanguage: 'off' });
        return;
      }

      const selectedSubtitle = subTracks.find((track) => track.id === id);
      void inferTrackLanguagePreference(selectedSubtitle ?? null).then((preferredSubtitleLanguage) => {
        if (!preferredSubtitleLanguage) return;
        void savePlaybackPreferencesPatch({ preferredSubtitleLanguage });
      });
    },
    [audioTracks, savePlaybackPreferencesPatch, subTracks],
  );

  useAutoApplyTrackPreferences({
    hasPlaybackStarted,
    isLoading,
    resetKey,
    playbackLanguagePreferences: autoApplyPlaybackLanguagePreferences,
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

    let cancelled = false;

    void Promise.all([
      inferTrackLanguagePreference(activeAudioTrack ?? null),
      subtitlesOff
        ? Promise.resolve('off')
        : inferTrackLanguagePreference(activeSubTrack ?? null),
    ]).then(([preferredAudioLanguage, preferredSubtitleLanguage]) => {
      if (cancelled) {
        return;
      }

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
    });

    return () => {
      cancelled = true;
    };
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
    playbackLanguagePreferences: autoApplyPlaybackLanguagePreferences,
  };
}