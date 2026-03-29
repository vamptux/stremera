import { useCallback, useEffect, useRef, useState } from 'react';

interface UsePlayerStreamSessionArgs {
  routeStreamUrl?: string;
  routeFormat?: string;
  routeSourceName?: string;
  routeStreamFamily?: string;
  routeSelectedStreamKey?: string;
  streamLookupId?: string;
  mediaId?: string;
  routeMarkedOffline?: boolean;
}

export function usePlayerStreamSession({
  routeStreamUrl,
  routeFormat,
  routeSourceName,
  routeStreamFamily,
  routeSelectedStreamKey,
  streamLookupId,
  mediaId,
  routeMarkedOffline = false,
}: UsePlayerStreamSessionArgs) {
  const routeSeed = routeStreamUrl ?? '__route:none__';
  const routeSeedRef = useRef(routeSeed);
  const [sessionStreamOverride, setSessionStreamOverride] = useState<{
    url?: string;
    routeSeed: string;
  } | null>(null);
  const activeStreamUrl =
    sessionStreamOverride && sessionStreamOverride.routeSeed === routeSeed
      ? sessionStreamOverride.url
      : routeStreamUrl;
  const lastStreamUrlRef = useRef(activeStreamUrl);
  const activeStreamFormatRef = useRef<string | undefined>(routeFormat);
  const activeStreamSourceNameRef = useRef<string | undefined>(routeSourceName);
  const activeStreamFamilyRef = useRef<string | undefined>(routeStreamFamily);
  const streamLookupIdRef = useRef<string | undefined>(streamLookupId || mediaId || undefined);
  const selectedStreamKeyRef = useRef<string | undefined>(routeSelectedStreamKey);

  useEffect(() => {
    routeSeedRef.current = routeSeed;
  }, [routeSeed]);

  const setActiveStreamUrl = useCallback((nextUrl?: string) => {
    setSessionStreamOverride({
      url: nextUrl,
      routeSeed: routeSeedRef.current,
    });
  }, []);

  useEffect(() => {
    lastStreamUrlRef.current = activeStreamUrl;
  }, [activeStreamUrl]);

  useEffect(() => {
    if (!routeStreamUrl) {
      activeStreamSourceNameRef.current = undefined;
      activeStreamFamilyRef.current = undefined;
      return;
    }

    if (routeStreamUrl && activeStreamUrl === routeStreamUrl) {
      activeStreamFormatRef.current = routeFormat;
      activeStreamSourceNameRef.current = routeSourceName?.trim() || undefined;
      activeStreamFamilyRef.current = routeStreamFamily?.trim() || undefined;
    }
  }, [activeStreamUrl, routeFormat, routeSourceName, routeStreamFamily, routeStreamUrl]);

  useEffect(() => {
    if (!routeStreamUrl) {
      selectedStreamKeyRef.current = undefined;
      return;
    }

    if (activeStreamUrl === routeStreamUrl) {
      selectedStreamKeyRef.current = routeSelectedStreamKey?.trim() || undefined;
      return;
    }

    selectedStreamKeyRef.current = undefined;
  }, [activeStreamUrl, routeSelectedStreamKey, routeStreamUrl]);

  useEffect(() => {
    streamLookupIdRef.current = streamLookupId || mediaId || undefined;
  }, [streamLookupId, mediaId]);

  return {
    activeStreamUrl,
    setActiveStreamUrl,
    activeStreamFormatRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
    lastStreamUrlRef,
    isOffline:
      routeMarkedOffline || (!!activeStreamUrl && !activeStreamUrl.startsWith('http')),
  };
}