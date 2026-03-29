import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { api } from '@/lib/api';
import { type PlaybackStreamOutcome } from '@/lib/playback-stream-health';

interface UsePlaybackStreamHealthArgs {
  mediaId?: string;
  mediaType?: string;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  activeStreamUrl?: string;
  activeStreamFormatRef: MutableRefObject<string | undefined>;
  activeStreamSourceNameRef: MutableRefObject<string | undefined>;
  activeStreamFamilyRef: MutableRefObject<string | undefined>;
  streamLookupIdRef: MutableRefObject<string | undefined>;
  selectedStreamKeyRef: MutableRefObject<string | undefined>;
}

export function usePlaybackStreamHealth({
  mediaId,
  mediaType,
  absoluteSeason,
  absoluteEpisode,
  activeStreamUrl,
  activeStreamFormatRef,
  activeStreamSourceNameRef,
  activeStreamFamilyRef,
  streamLookupIdRef,
  selectedStreamKeyRef,
}: UsePlaybackStreamHealthArgs) {
  const lastVerifiedUrlRef = useRef<string | null>(null);
  const reportedFailureKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    lastVerifiedUrlRef.current = null;
    reportedFailureKeysRef.current.clear();
  }, [mediaId, mediaType, absoluteSeason, absoluteEpisode, activeStreamUrl]);

  const reportOutcome = useCallback(
    async (outcome: PlaybackStreamOutcome, streamUrl?: string) => {
      const normalizedMediaId = mediaId?.trim();
      const normalizedMediaType = mediaType?.trim();
      const normalizedStreamUrl = streamUrl?.trim() || activeStreamUrl?.trim();

      if (!normalizedMediaId || !normalizedMediaType || normalizedMediaId === 'local') {
        return;
      }
      if (!normalizedStreamUrl) {
        return;
      }

      await api.reportPlaybackStreamOutcome({
        id: normalizedMediaId,
        type_: normalizedMediaType,
        season: absoluteSeason,
        episode: absoluteEpisode,
        source_name: activeStreamSourceNameRef.current,
        stream_family: activeStreamFamilyRef.current,
        stream_url: normalizedStreamUrl,
        stream_format: activeStreamFormatRef.current,
        stream_lookup_id: streamLookupIdRef.current,
        stream_key: selectedStreamKeyRef.current,
        outcome,
      });
    },
    [
      activeStreamFormatRef,
      activeStreamFamilyRef,
      activeStreamSourceNameRef,
      absoluteEpisode,
      absoluteSeason,
      activeStreamUrl,
      mediaId,
      mediaType,
      selectedStreamKeyRef,
      streamLookupIdRef,
    ],
  );

  const reportVerified = useCallback(() => {
    const normalizedStreamUrl = activeStreamUrl?.trim();
    if (!normalizedStreamUrl || lastVerifiedUrlRef.current === normalizedStreamUrl) {
      return;
    }

    lastVerifiedUrlRef.current = normalizedStreamUrl;
    reportedFailureKeysRef.current.clear();
    void reportOutcome('verified', normalizedStreamUrl).catch(() => {
      // Best-effort telemetry only.
    });
  }, [activeStreamUrl, reportOutcome]);

  const reportFailure = useCallback(
    (outcome: Exclude<PlaybackStreamOutcome, 'verified'>, streamUrl?: string) => {
      const normalizedStreamUrl = streamUrl?.trim() || activeStreamUrl?.trim();
      if (!normalizedStreamUrl) {
        return;
      }

      const failureKey = `${normalizedStreamUrl}|${outcome}`;
      if (reportedFailureKeysRef.current.has(failureKey)) {
        return;
      }

      reportedFailureKeysRef.current.add(failureKey);
      void reportOutcome(outcome, normalizedStreamUrl).catch(() => {
        // Best-effort telemetry only.
      });
    },
    [activeStreamUrl, reportOutcome],
  );

  return {
    reportFailure,
    reportVerified,
  };
}