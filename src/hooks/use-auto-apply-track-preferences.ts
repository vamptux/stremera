import { useEffect, useRef } from 'react';
import { type PlaybackLanguagePreferences } from '@/lib/api';
import {
  findTrackByLanguage,
  normalizeLanguageToken,
  trackMatchesPreferredLanguage,
  type Track,
} from '@/lib/player-track-utils';

interface UseAutoApplyTrackPreferencesArgs {
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
  ) => Promise<void> | void;
}

function asPromise(result: Promise<void> | void): Promise<void> {
  return Promise.resolve(result);
}

export function useAutoApplyTrackPreferences({
  isLoading,
  resetKey,
  playbackLanguagePreferences,
  audioTracks,
  subTracks,
  trackSwitching,
  setTrack,
}: UseAutoApplyTrackPreferencesArgs) {
  const autoAppliedTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const autoApplyingTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const preferenceFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    autoAppliedTrackPrefsRef.current = { audio: false, sub: false };
    autoApplyingTrackPrefsRef.current = { audio: false, sub: false };
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
    autoAppliedTrackPrefsRef.current = { audio: false, sub: false };
    autoApplyingTrackPrefsRef.current = { audio: false, sub: false };
  }, [
    playbackLanguagePreferences?.preferredAudioLanguage,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
  ]);

  useEffect(() => {
    const audioPref = normalizeLanguageToken(playbackLanguagePreferences?.preferredAudioLanguage);
    if (isLoading) return;
    if (!audioPref) return;
    if (autoAppliedTrackPrefsRef.current.audio || autoApplyingTrackPrefsRef.current.audio) return;
    if (trackSwitching.audio || trackSwitching.sub) return;
    if (audioTracks.length === 0) return;

    const selectedAudio = audioTracks.find((track) => !!track.selected) ?? null;
    if (trackMatchesPreferredLanguage(selectedAudio, audioPref)) {
      autoAppliedTrackPrefsRef.current.audio = true;
      return;
    }

    const match = findTrackByLanguage(audioTracks, audioPref);
    if (!match) {
      autoAppliedTrackPrefsRef.current.audio = true;
      return;
    }

    autoApplyingTrackPrefsRef.current.audio = true;
    void asPromise(setTrack('audio', match.id, { silent: true })).finally(() => {
      autoApplyingTrackPrefsRef.current.audio = false;
      autoAppliedTrackPrefsRef.current.audio = true;
    });
  }, [
    audioTracks,
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
    if (isLoading) return;
    if (!subtitlePref) return;
    if (autoApplyingTrackPrefsRef.current.audio) return;
    if (autoAppliedTrackPrefsRef.current.sub || autoApplyingTrackPrefsRef.current.sub) return;
    if (trackSwitching.audio || trackSwitching.sub) return;

    if (subtitlePref === 'off') {
      const hasSelectedSubtitle = subTracks.some((track) => !!track.selected);
      if (!hasSelectedSubtitle) {
        autoAppliedTrackPrefsRef.current.sub = true;
        return;
      }

      autoApplyingTrackPrefsRef.current.sub = true;
      void asPromise(setTrack('sub', 'no', { silent: true })).finally(() => {
        autoApplyingTrackPrefsRef.current.sub = false;
        autoAppliedTrackPrefsRef.current.sub = true;
      });
      return;
    }

    if (subTracks.length === 0) return;

    const selectedSubtitle = subTracks.find((track) => !!track.selected) ?? null;
    if (trackMatchesPreferredLanguage(selectedSubtitle, subtitlePref)) {
      autoAppliedTrackPrefsRef.current.sub = true;
      return;
    }

    const match = findTrackByLanguage(subTracks, subtitlePref);
    if (!match) {
      autoAppliedTrackPrefsRef.current.sub = true;
      return;
    }

    autoApplyingTrackPrefsRef.current.sub = true;
    void asPromise(setTrack('sub', match.id, { silent: true })).finally(() => {
      autoApplyingTrackPrefsRef.current.sub = false;
      autoAppliedTrackPrefsRef.current.sub = true;
    });
  }, [
    isLoading,
    playbackLanguagePreferences?.preferredSubtitleLanguage,
    setTrack,
    subTracks,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);
}