import { useEffect, useRef } from 'react';
import { api, type PlaybackLanguagePreferences, type TrackLanguageCandidate } from '@/lib/api';
import { normalizeLanguageToken, type Track } from '@/lib/player-track-utils';

const MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT = 2;

type TrackPreferenceKind = 'audio' | 'sub';

interface TrackAutoApplyAttemptState {
  fingerprint: string | null;
  count: number;
}

interface UseAutoApplyTrackPreferencesArgs {
  hasPlaybackStarted: boolean;
  isLoading: boolean;
  resetKey: string;
  playbackLanguagePreferences?: PlaybackLanguagePreferences;
  audioTracks: Track[];
  subTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  setTrack: (
    type: 'audio' | 'sub',
    id: number | 'no',
    options?: { silent?: boolean; persistPreference?: boolean },
  ) => Promise<boolean> | boolean;
}

function asPromise<T>(result: Promise<T> | T): Promise<T> {
  return Promise.resolve(result);
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

export function useAutoApplyTrackPreferences({
  hasPlaybackStarted,
  isLoading,
  resetKey,
  playbackLanguagePreferences,
  audioTracks,
  subTracks,
  trackSwitching,
  setTrack,
}: UseAutoApplyTrackPreferencesArgs) {
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

  const resetAutoApplyState = () => {
    autoAppliedTrackPrefsRef.current = { audio: null, sub: null };
    autoApplyingTrackPrefsRef.current = { audio: false, sub: false };
    autoApplyAttemptStateRef.current = resetTrackAutoApplyAttempts();
  };

  const hasReachedAttemptLimit = (type: TrackPreferenceKind, fingerprint: string) => {
    const state = autoApplyAttemptStateRef.current[type];
    return (
      state.fingerprint === fingerprint &&
      state.count >= MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT
    );
  };

  const recordAttempt = (type: TrackPreferenceKind, fingerprint: string) => {
    const state = autoApplyAttemptStateRef.current[type];
    autoApplyAttemptStateRef.current[type] =
      state.fingerprint === fingerprint
        ? { fingerprint, count: state.count + 1 }
        : { fingerprint, count: 1 };
  };

  const markApplied = (type: TrackPreferenceKind, fingerprint: string) => {
    autoAppliedTrackPrefsRef.current[type] = fingerprint;
  };

  useEffect(() => {
    resetAutoApplyState();
  }, [resetKey]);

  useEffect(() => {
    const nextFingerprint = [
      normalizeLanguageToken(playbackLanguagePreferences?.preferredAudioLanguage),
      normalizeLanguageToken(playbackLanguagePreferences?.preferredSubtitleLanguage),
    ].join('|');

    if (preferenceFingerprintRef.current === null) {
      preferenceFingerprintRef.current = nextFingerprint;
      return;
    }

    if (preferenceFingerprintRef.current === nextFingerprint) {
      return;
    }

    preferenceFingerprintRef.current = nextFingerprint;
    resetAutoApplyState();
  }, [
    playbackLanguagePreferences?.preferredAudioLanguage,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
  ]);

  useEffect(() => {
    const audioPref = normalizeLanguageToken(playbackLanguagePreferences?.preferredAudioLanguage);
    if (isLoading || !hasPlaybackStarted) return;
    if (!audioPref) return;
    if (trackSwitching.audio || trackSwitching.sub) return;
    if (audioTracks.length === 0) return;

    const fingerprint = buildTrackAutoApplyFingerprint(audioPref, audioTracks);
    if (autoAppliedTrackPrefsRef.current.audio === fingerprint) return;
    if (autoApplyingTrackPrefsRef.current.audio) return;
    if (hasReachedAttemptLimit('audio', fingerprint)) return;

    let cancelled = false;
    autoApplyingTrackPrefsRef.current.audio = true;
    recordAttempt('audio', fingerprint);

    void api
      .resolvePreferredTrackSelection(
        audioTracks.map(toTrackLanguageCandidate),
        audioPref,
        audioTracks.find((track) => !!track.selected)?.id,
      )
      .then(async (resolution) => {
        if (cancelled) return;

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
        if (cancelled) return;
        if (switched) {
          markApplied('audio', fingerprint);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        autoApplyingTrackPrefsRef.current.audio = false;
      });

    return () => {
      cancelled = true;
      autoApplyingTrackPrefsRef.current.audio = false;
    };
  }, [
    audioTracks,
    hasPlaybackStarted,
    isLoading,
    playbackLanguagePreferences?.preferredAudioLanguage,
    setTrack,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);

  useEffect(() => {
    const subtitlePref = normalizeLanguageToken(
      playbackLanguagePreferences?.preferredSubtitleLanguage,
    );
    if (isLoading || !hasPlaybackStarted) return;
    if (!subtitlePref) return;
    if (autoApplyingTrackPrefsRef.current.audio) return;
    if (trackSwitching.audio || trackSwitching.sub) return;

    const fingerprint = buildTrackAutoApplyFingerprint(subtitlePref, subTracks);
    if (autoAppliedTrackPrefsRef.current.sub === fingerprint) return;
    if (autoApplyingTrackPrefsRef.current.sub) return;
    if (hasReachedAttemptLimit('sub', fingerprint)) return;

    if (subtitlePref === 'off') {
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

    if (subTracks.length === 0) return;

    let cancelled = false;
    autoApplyingTrackPrefsRef.current.sub = true;
    recordAttempt('sub', fingerprint);

    void api
      .resolvePreferredTrackSelection(
        subTracks.map(toTrackLanguageCandidate),
        subtitlePref,
        subTracks.find((track) => !!track.selected)?.id,
      )
      .then(async (resolution) => {
        if (cancelled) return;

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
        if (cancelled) return;
        if (switched) {
          markApplied('sub', fingerprint);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        autoApplyingTrackPrefsRef.current.sub = false;
      });

    return () => {
      cancelled = true;
      autoApplyingTrackPrefsRef.current.sub = false;
    };
  }, [
    hasPlaybackStarted,
    isLoading,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
    setTrack,
    subTracks,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);
}