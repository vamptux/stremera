import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { command, setProperty } from 'tauri-plugin-libmpv-api';
import { toast } from 'sonner';

import { type PlaybackLanguagePreferences } from '@/lib/api';
import {
  areTrackListsEqual,
  doesTrackSelectionMatch,
  type Track,
} from '@/lib/player-track-utils';
import { readPlayerTrackList } from '@/lib/player-mpv';
import { usePlayerTrackPreferences } from '@/hooks/use-player-track-preferences';

const TRACK_SWITCH_VERIFY_ATTEMPTS = 8;
const TRACK_SWITCH_VERIFY_DELAY_MS = 150;

type TrackSwitchingState = { audio: boolean; sub: boolean };
type TrackType = 'audio' | 'sub';
type TrackChangeOptions = { silent?: boolean; persistPreference?: boolean };
type TrackChangeHandler = (
  type: TrackType,
  id: number | 'no',
  options?: TrackChangeOptions,
) => Promise<boolean> | boolean;

interface UsePlayerTrackControllerArgs {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  activeStreamUrl?: string;
  hasPlaybackStarted: boolean;
  isLoading: boolean;
  isResolving: boolean;
  resetKey: string;
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
  const setTrackRef = useRef<TrackChangeHandler>(async () => false);

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
      if (previousState[type] === value) return previousState;
      return {
        ...previousState,
        [type]: value,
      };
    });
  }, []);

  const requestTrackChange = useCallback<TrackChangeHandler>(
    (type, id, options) => setTrackRef.current(type, id, options),
    [],
  );

  const { persistSelectedTrackPreference, playbackLanguagePreferences } = usePlayerTrackPreferences({
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
    setTrack: requestTrackChange,
  });

  const setTrack = useCallback<TrackChangeHandler>(
    async (type, id, options) => {
      if (type === 'audio' && id === 'no') return false;

      if (trackSwitchingRef.current.audio || trackSwitchingRef.current.sub) return false;

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
        if (!persistPreference) return;
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

  useEffect(() => {
    setTrackRef.current = setTrack;
  }, [setTrack]);

  useEffect(() => {
    trackSwitchingRef.current = { audio: false, sub: false };

    const timer = window.setTimeout(() => {
      setTrackSwitching({ audio: false, sub: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeStreamUrl, resetKey]);

  return {
    audioTracks,
    subTracks,
    trackSwitching,
    subtitlesOff,
    playbackLanguagePreferences: playbackLanguagePreferences as PlaybackLanguagePreferences,
    refreshTracks,
    setTrack,
  };
}