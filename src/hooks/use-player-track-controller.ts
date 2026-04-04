import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { command, setProperty } from 'tauri-plugin-libmpv-api';
import { toast } from 'sonner';

import {
  api,
  type PlaybackLanguagePreferences,
  type TrackLanguageCandidate,
} from '@/lib/api';
import { readPlayerTrackList } from '@/lib/player-mpv';
import { usePlaybackLanguagePreferences } from '@/hooks/use-playback-language-preferences';
import {
  areTrackListsEqual,
  doesTrackSelectionMatch,
  normalizeLanguageToken,
  type Track,
} from '@/lib/player-track-utils';

const TRACK_SWITCH_VERIFY_ATTEMPTS = 8;
const TRACK_SWITCH_VERIFY_DELAY_MS = 150;
const MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT = 2;

type TrackSwitchingState = { audio: boolean; sub: boolean };
type TrackType = 'audio' | 'sub';
type TrackPreferenceKind = 'audio' | 'sub';
type TrackChangeOptions = { silent?: boolean; persistPreference?: boolean };
type TrackChangeHandler = (
  type: TrackType,
  id: number | 'no',
  options?: TrackChangeOptions,
) => Promise<boolean> | boolean;

interface TrackAutoApplyAttemptState {
  fingerprint: string | null;
  count: number;
}

interface UsePlayerTrackControllerArgs {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  activeStreamUrl?: string;
  hasPlaybackStarted: boolean;
  isLoading: boolean;
  isResolving: boolean;
  resetKey: string;
}

function asPromise<T>(result: Promise<T> | T): Promise<T> {
  return Promise.resolve(result);
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

function buildTrackAutoApplyFingerprint(preferredLanguage: string, tracks: Track[]): string {
  const trackFingerprint = tracks
    .map((track) => {
      const normalizedLanguage = normalizeLanguageToken(track.lang);
      const normalizedTitle = track.title?.trim().toLowerCase() ?? '';

      return [
        track.id,
        normalizedLanguage,
        normalizedTitle,
        track.selected ? '1' : '0',
        track.defaultTrack ? '1' : '0',
        track.forced ? '1' : '0',
        track.hearingImpaired ? '1' : '0',
      ].join(':');
    })
    .join('|');

  return `${preferredLanguage}::${trackFingerprint}`;
}

function resetTrackAutoApplyAttempts(): Record<TrackPreferenceKind, TrackAutoApplyAttemptState> {
  return {
    audio: { fingerprint: null, count: 0 },
    sub: { fingerprint: null, count: 0 },
  };
}

export function usePlayerTrackController({
  mediaId,
  mediaType,
  activeStreamUrl,
  hasPlaybackStarted,
  isLoading,
  isResolving,
  resetKey,
}: UsePlayerTrackControllerArgs) {
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [subTracks, setSubTracks] = useState<Track[]>([]);
  const [trackSwitching, setTrackSwitching] = useState<TrackSwitchingState>({
    audio: false,
    sub: false,
  });
  const trackSwitchingRef = useRef<TrackSwitchingState>({
    audio: false,
    sub: false,
  });
  const trackListRef = useRef<Track[]>([]);
  const autoAppliedTrackPrefsRef = useRef<Record<TrackPreferenceKind, string | null>>({
    audio: null,
    sub: null,
  });
  const autoApplyingTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const autoApplyAttemptStateRef = useRef<
    Record<TrackPreferenceKind, TrackAutoApplyAttemptState>
  >(resetTrackAutoApplyAttempts());
  const preferenceFingerprintRef = useRef<string | null>(null);
  const lastRecordedTrackOutcomeRef = useRef<string | null>(null);

  useEffect(() => {
    trackListRef.current = [];
    setAudioTracks([]);
    setSubTracks([]);
  }, [activeStreamUrl]);

  const activeAudioTrack = useMemo(
    () => audioTracks.find((track) => !!track.selected) ?? null,
    [audioTracks],
  );
  const activeSubTrack = useMemo(
    () => subTracks.find((track) => !!track.selected) ?? null,
    [subTracks],
  );
  const subtitlesOff = subTracks.length > 0 && !activeSubTrack;

  const applyTrackList = useCallback((nextTracks: Track[]) => {
    if (areTrackListsEqual(trackListRef.current, nextTracks)) {
      return trackListRef.current;
    }

    trackListRef.current = nextTracks;
    const nextAudioTracks = nextTracks.filter((track) => track.type === 'audio');
    const nextSubTracks = nextTracks.filter((track) => track.type === 'sub');

    setAudioTracks((previousTracks) =>
      areTrackListsEqual(previousTracks, nextAudioTracks) ? previousTracks : nextAudioTracks,
    );
    setSubTracks((previousTracks) =>
      areTrackListsEqual(previousTracks, nextSubTracks) ? previousTracks : nextSubTracks,
    );

    return nextTracks;
  }, []);

  const refreshTracks = useCallback(async () => {
    try {
      const nextTracks = await readPlayerTrackList();
      return applyTrackList(nextTracks);
    } catch {
      return trackListRef.current;
    }
  }, [applyTrackList]);

  const confirmTrackSwitch = useCallback(
    async (type: TrackType, id: number | 'no') => {
      if (doesTrackSelectionMatch(trackListRef.current, type, id)) {
        return true;
      }

      for (let attempt = 0; attempt < TRACK_SWITCH_VERIFY_ATTEMPTS; attempt += 1) {
        const latestTracks = await refreshTracks();
        if (doesTrackSelectionMatch(latestTracks, type, id)) {
          return true;
        }

        if (attempt < TRACK_SWITCH_VERIFY_ATTEMPTS - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, TRACK_SWITCH_VERIFY_DELAY_MS));
        }
      }

      return false;
    },
    [refreshTracks],
  );

  const setTrackSwitchingFlag = useCallback((type: TrackType, value: boolean) => {
    trackSwitchingRef.current = {
      ...trackSwitchingRef.current,
      [type]: value,
    };

    setTrackSwitching((previousState) => {
      if (previousState[type] === value) {
        return previousState;
      }

      return {
        ...previousState,
        [type]: value,
      };
    });
  }, []);

  const {
    globalPlaybackLanguagePreferences,
    effectivePlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferences,
  } = usePlaybackLanguagePreferences({ mediaId, mediaType });

  const playbackLanguagePreferences = useMemo<PlaybackLanguagePreferences>(
    () => ({
      preferredAudioLanguage:
        normalizeStoredPreference(effectivePlaybackLanguagePreferences?.preferredAudioLanguage) ??
        normalizeStoredPreference(globalPlaybackLanguagePreferences?.preferredAudioLanguage),
      preferredSubtitleLanguage:
        normalizeStoredPreference(
          effectivePlaybackLanguagePreferences?.preferredSubtitleLanguage,
        ) ??
        normalizeStoredPreference(globalPlaybackLanguagePreferences?.preferredSubtitleLanguage),
    }),
    [
      effectivePlaybackLanguagePreferences?.preferredAudioLanguage,
      effectivePlaybackLanguagePreferences?.preferredSubtitleLanguage,
      globalPlaybackLanguagePreferences?.preferredAudioLanguage,
      globalPlaybackLanguagePreferences?.preferredSubtitleLanguage,
    ],
  );

  const persistSelectedTrackPreference = useCallback(
    (type: TrackType, id: number | 'no') => {
      if (type === 'audio') {
        const selectedAudioTrack = audioTracks.find((track) => track.id === id);
        void inferTrackLanguagePreference(selectedAudioTrack ?? null).then((preferredAudioLanguage) => {
          if (!preferredAudioLanguage) {
            return;
          }

          void saveGlobalPlaybackLanguagePreferences({ preferredAudioLanguage });
        });
        return;
      }

      if (id === 'no') {
        void saveGlobalPlaybackLanguagePreferences({ preferredSubtitleLanguage: 'off' });
        return;
      }

      const selectedSubtitleTrack = subTracks.find((track) => track.id === id);
      void inferTrackLanguagePreference(selectedSubtitleTrack ?? null).then(
        (preferredSubtitleLanguage) => {
          if (!preferredSubtitleLanguage) {
            return;
          }

          void saveGlobalPlaybackLanguagePreferences({ preferredSubtitleLanguage });
        },
      );
    },
    [audioTracks, saveGlobalPlaybackLanguagePreferences, subTracks],
  );

  const setTrack = useCallback<TrackChangeHandler>(
    async (type, id, options) => {
      if (type === 'audio' && id === 'no') {
        return false;
      }

      if (trackSwitchingRef.current.audio || trackSwitchingRef.current.sub) {
        return false;
      }

      const alreadySelected =
        type === 'audio'
          ? activeAudioTrack?.id === id
          : id === 'no'
            ? subtitlesOff
            : activeSubTrack?.id === id;
      const propertyName = type === 'audio' ? 'aid' : 'sid';
      const value = id === 'no' ? 'no' : id;
      const silent = options?.silent ?? false;
      const persistPreference = options?.persistPreference ?? false;

      const persistSelection = () => {
        if (!persistPreference) {
          return;
        }

        persistSelectedTrackPreference(type, id);
      };

      if (alreadySelected) {
        persistSelection();
        return true;
      }

      setTrackSwitchingFlag(type, true);

      try {
        try {
          await setProperty(propertyName, value);
        } catch {
          await command('set', [propertyName, String(value)]);
        }

        const switched = await confirmTrackSwitch(type, id);
        if (!switched) {
          throw new Error('track-switch-not-confirmed');
        }

        persistSelection();

        if (!silent) {
          toast.success(`${type === 'audio' ? 'Audio' : 'Subtitle'} track changed`);
        }

        return true;
      } catch {
        if (!silent) {
          toast.error('Failed to switch track');
        }

        return false;
      } finally {
        setTrackSwitchingFlag(type, false);
      }
    },
    [
      activeAudioTrack?.id,
      activeSubTrack?.id,
      confirmTrackSwitch,
      persistSelectedTrackPreference,
      setTrackSwitchingFlag,
      subtitlesOff,
    ],
  );

  const resetAutoApplyState = useCallback(() => {
    autoAppliedTrackPrefsRef.current = { audio: null, sub: null };
    autoApplyingTrackPrefsRef.current = { audio: false, sub: false };
    autoApplyAttemptStateRef.current = resetTrackAutoApplyAttempts();
  }, []);

  const hasReachedAttemptLimit = useCallback(
    (type: TrackPreferenceKind, fingerprint: string) => {
      const state = autoApplyAttemptStateRef.current[type];
      return (
        state.fingerprint === fingerprint &&
        state.count >= MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT
      );
    },
    [],
  );

  const recordAttempt = useCallback((type: TrackPreferenceKind, fingerprint: string) => {
    const state = autoApplyAttemptStateRef.current[type];
    autoApplyAttemptStateRef.current[type] =
      state.fingerprint === fingerprint
        ? { fingerprint, count: state.count + 1 }
        : { fingerprint, count: 1 };
  }, []);

  const markApplied = useCallback((type: TrackPreferenceKind, fingerprint: string) => {
    autoAppliedTrackPrefsRef.current[type] = fingerprint;
  }, []);

  useEffect(() => {
    resetAutoApplyState();
  }, [resetAutoApplyState, resetKey]);

  useEffect(() => {
    const nextPreferenceFingerprint = [
      normalizeLanguageToken(playbackLanguagePreferences.preferredAudioLanguage),
      normalizeLanguageToken(playbackLanguagePreferences.preferredSubtitleLanguage),
    ].join('|');

    if (preferenceFingerprintRef.current === null) {
      preferenceFingerprintRef.current = nextPreferenceFingerprint;
      return;
    }

    if (preferenceFingerprintRef.current === nextPreferenceFingerprint) {
      return;
    }

    preferenceFingerprintRef.current = nextPreferenceFingerprint;
    resetAutoApplyState();
  }, [
    playbackLanguagePreferences.preferredAudioLanguage,
    playbackLanguagePreferences.preferredSubtitleLanguage,
    resetAutoApplyState,
  ]);

  useEffect(() => {
    const preferredAudioLanguage = normalizeLanguageToken(
      playbackLanguagePreferences.preferredAudioLanguage,
    );
    if (isLoading || !hasPlaybackStarted) {
      return;
    }
    if (!preferredAudioLanguage) {
      return;
    }
    if (trackSwitching.audio || trackSwitching.sub) {
      return;
    }
    if (audioTracks.length === 0) {
      return;
    }

    const fingerprint = buildTrackAutoApplyFingerprint(preferredAudioLanguage, audioTracks);
    if (autoAppliedTrackPrefsRef.current.audio === fingerprint) {
      return;
    }
    if (autoApplyingTrackPrefsRef.current.audio) {
      return;
    }
    if (hasReachedAttemptLimit('audio', fingerprint)) {
      return;
    }

    let cancelled = false;
    autoApplyingTrackPrefsRef.current.audio = true;
    recordAttempt('audio', fingerprint);

    void api
      .resolvePreferredTrackSelection(
        audioTracks.map(toTrackLanguageCandidate),
        preferredAudioLanguage,
        activeAudioTrack?.id,
      )
      .then(async (resolution) => {
        if (cancelled) {
          return;
        }

        if (resolution.selectedMatches) {
          markApplied('audio', fingerprint);
          return;
        }

        if (typeof resolution.matchedTrackId !== 'number') {
          return;
        }

        const switched = await asPromise(
          setTrack('audio', resolution.matchedTrackId, { silent: true }),
        );

        if (cancelled) {
          return;
        }

        if (switched) {
          markApplied('audio', fingerprint);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) {
          return;
        }

        autoApplyingTrackPrefsRef.current.audio = false;
      });

    return () => {
      cancelled = true;
      autoApplyingTrackPrefsRef.current.audio = false;
    };
  }, [
    activeAudioTrack?.id,
    audioTracks,
    hasPlaybackStarted,
    hasReachedAttemptLimit,
    isLoading,
    markApplied,
    playbackLanguagePreferences.preferredAudioLanguage,
    recordAttempt,
    setTrack,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);

  useEffect(() => {
    const preferredSubtitleLanguage = normalizeLanguageToken(
      playbackLanguagePreferences.preferredSubtitleLanguage,
    );
    if (isLoading || !hasPlaybackStarted) {
      return;
    }
    if (!preferredSubtitleLanguage) {
      return;
    }
    if (autoApplyingTrackPrefsRef.current.audio) {
      return;
    }
    if (trackSwitching.audio || trackSwitching.sub) {
      return;
    }

    const fingerprint = buildTrackAutoApplyFingerprint(preferredSubtitleLanguage, subTracks);
    if (autoAppliedTrackPrefsRef.current.sub === fingerprint) {
      return;
    }
    if (autoApplyingTrackPrefsRef.current.sub) {
      return;
    }
    if (hasReachedAttemptLimit('sub', fingerprint)) {
      return;
    }

    if (preferredSubtitleLanguage === 'off') {
      const hasSelectedSubtitle = subTracks.some((track) => !!track.selected);
      if (!hasSelectedSubtitle) {
        markApplied('sub', fingerprint);
        return;
      }

      autoApplyingTrackPrefsRef.current.sub = true;
      recordAttempt('sub', fingerprint);
      void asPromise(setTrack('sub', 'no', { silent: true }))
        .then((switched) => {
          if (switched) {
            markApplied('sub', fingerprint);
          }
        })
        .finally(() => {
          autoApplyingTrackPrefsRef.current.sub = false;
        });
      return;
    }

    if (subTracks.length === 0) {
      return;
    }

    let cancelled = false;
    autoApplyingTrackPrefsRef.current.sub = true;
    recordAttempt('sub', fingerprint);

    void api
      .resolvePreferredTrackSelection(
        subTracks.map(toTrackLanguageCandidate),
        preferredSubtitleLanguage,
        activeSubTrack?.id,
      )
      .then(async (resolution) => {
        if (cancelled) {
          return;
        }

        if (resolution.selectedMatches) {
          markApplied('sub', fingerprint);
          return;
        }

        if (typeof resolution.matchedTrackId !== 'number') {
          return;
        }

        const switched = await asPromise(
          setTrack('sub', resolution.matchedTrackId, { silent: true }),
        );

        if (cancelled) {
          return;
        }

        if (switched) {
          markApplied('sub', fingerprint);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) {
          return;
        }

        autoApplyingTrackPrefsRef.current.sub = false;
      });

    return () => {
      cancelled = true;
      autoApplyingTrackPrefsRef.current.sub = false;
    };
  }, [
    activeSubTrack?.id,
    hasPlaybackStarted,
    hasReachedAttemptLimit,
    isLoading,
    markApplied,
    playbackLanguagePreferences.preferredSubtitleLanguage,
    recordAttempt,
    setTrack,
    subTracks,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);

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
      subtitlesOff ? Promise.resolve('off') : inferTrackLanguagePreference(activeSubTrack ?? null),
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

  useEffect(() => {
    trackSwitchingRef.current = { audio: false, sub: false };

    const timer = window.setTimeout(() => {
      setTrackSwitching({ audio: false, sub: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeStreamUrl, resetKey]);

  return {
    audioTracks,
    playbackLanguagePreferences,
    refreshTracks,
    setTrack,
    subTracks,
    subtitlesOff,
    trackSwitching,
  };
}