import {
  api,
  shouldBypassSavedStream,
  type BestResolvedStream,
  type WatchProgress,
} from '@/lib/api';

const QUICK_RESUME_RESOLVE_BUDGET_MS = 325;

const historyLookupIdCache = new Map<string, string>();

export interface HistoryPlaybackPlan {
  kind: 'details' | 'player';
  reason?: 'missing-episode-context';
  target: string;
  state: Record<string, unknown>;
}

function buildHistoryLookupCacheKey(item: WatchProgress): string {
  return `${normalizeHistoryMediaType(item.type_, item.id)}|${item.id.trim()}`;
}

function normalizeHistoryType(type: string): string {
  return type.trim().toLowerCase();
}

function isKitsuId(id: string): boolean {
  return id.trim().toLowerCase().startsWith('kitsu:');
}

function normalizeHistoryMediaType(type: string, id: string): 'movie' | 'series' | 'anime' {
  const normalized = normalizeHistoryType(type);
  if (normalized === 'movie') return 'movie';
  if (normalized === 'anime') return 'anime';
  if (normalized === 'series' && isKitsuId(id)) return 'anime';
  return 'series';
}

function isSeriesLikeType(type: string): boolean {
  const normalized = normalizeHistoryType(type);
  return normalized === 'series' || normalized === 'anime';
}

function isRemoteStreamUrl(url?: string): boolean {
  const trimmed = url?.trim().toLowerCase();
  return !!trimmed && (trimmed.startsWith('http://') || trimmed.startsWith('https://'));
}

function isUsableResumeLookupId(type: string, lookupId?: string | null): boolean {
  const trimmed = lookupId?.trim();
  if (!trimmed) return false;
  return isSeriesLikeType(type) ? trimmed.startsWith('tt') : true;
}

function getImmediateHistoryStreamLookupId(item: WatchProgress): string {
  const savedLookupId = item.last_stream_lookup_id?.trim();
  if (isUsableResumeLookupId(item.type_, savedLookupId)) {
    return savedLookupId!;
  }

  const cachedLookupId = historyLookupIdCache.get(buildHistoryLookupCacheKey(item));
  if (isUsableResumeLookupId(item.type_, cachedLookupId)) {
    return cachedLookupId!;
  }

  const fallbackId = item.id.trim();
  if (isUsableResumeLookupId(item.type_, fallbackId)) {
    return fallbackId;
  }

  return savedLookupId || fallbackId;
}

interface HistoryEpisodeContext {
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  aniskipEpisode?: number;
}

function hasExplicitStreamEpisodeContext(item: WatchProgress): boolean {
  return typeof item.stream_season === 'number' && typeof item.stream_episode === 'number';
}

function isMappedAnimeHistoryItem(item: WatchProgress, lookupId?: string): boolean {
  return (
    normalizeHistoryMediaType(item.type_, item.id) === 'anime' &&
    !!lookupId?.startsWith('tt') &&
    !item.id.trim().startsWith('tt')
  );
}

function getEpisodeContext(item: WatchProgress): HistoryEpisodeContext {
  const absoluteSeason =
    typeof item.absolute_season === 'number' ? item.absolute_season : item.season;
  const absoluteEpisode =
    typeof item.absolute_episode === 'number' ? item.absolute_episode : item.episode;
  const explicitLookupId = item.last_stream_lookup_id?.trim();
  const shouldDeferMappedAnimeCoords =
    !hasExplicitStreamEpisodeContext(item) && isMappedAnimeHistoryItem(item, explicitLookupId);
  const streamSeason =
    typeof item.stream_season === 'number'
      ? item.stream_season
      : shouldDeferMappedAnimeCoords
        ? undefined
        : absoluteSeason;
  const streamEpisode =
    typeof item.stream_episode === 'number'
      ? item.stream_episode
      : shouldDeferMappedAnimeCoords
        ? undefined
        : absoluteEpisode;

  return {
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    aniskipEpisode:
      typeof item.aniskip_episode === 'number'
        ? item.aniskip_episode
        : shouldDeferMappedAnimeCoords
          ? absoluteEpisode
          : streamEpisode,
  };
}

function hasEpisodeContext(item: WatchProgress): boolean {
  if (!isSeriesLikeType(item.type_)) return true;
  const { absoluteSeason, absoluteEpisode } = getEpisodeContext(item);
  return absoluteSeason !== undefined && absoluteEpisode !== undefined;
}

function getMediaDetailsType(item: WatchProgress): string {
  return normalizeHistoryMediaType(item.type_, item.id);
}

async function resolveHistoryStreamLookupId(
  item: WatchProgress,
  options?: { allowMediaDetailsLookup?: boolean },
): Promise<string> {
  const immediateLookupId = getImmediateHistoryStreamLookupId(item);
  if (isUsableResumeLookupId(item.type_, immediateLookupId)) {
    return immediateLookupId;
  }

  const allowMediaDetailsLookup = options?.allowMediaDetailsLookup ?? true;
  const fallbackId = item.id.trim();

  if (!allowMediaDetailsLookup) {
    return immediateLookupId;
  }

  if (isSeriesLikeType(item.type_)) {
    try {
      const details = await api.getMediaDetails(getMediaDetailsType(item), item.id, {
        includeEpisodes: false,
      });
      const imdbId = details.imdbId?.trim();
      if (isUsableResumeLookupId(item.type_, imdbId)) {
        historyLookupIdCache.set(buildHistoryLookupCacheKey(item), imdbId!);
        return imdbId!;
      }
    } catch {
      // Fall back to the best local identifier we already have.
    }
  }

  return immediateLookupId || fallbackId;
}

async function recoverPreciseResumeStartTime(
  item: WatchProgress,
  season?: number,
  episode?: number,
): Promise<number> {
  if (Number.isFinite(item.position) && item.position > 0) {
    return item.position;
  }

  if (!isSeriesLikeType(item.type_) || season === undefined || episode === undefined) {
    return 0;
  }

  try {
    const precise = await api.getWatchProgress(item.id, item.type_, season, episode);
    if (precise?.position && precise.position > 0) {
      return precise.position;
    }
  } catch {
    // Best-effort recovery only.
  }

  try {
    const historyEntries = await api.getWatchHistoryForId(item.id);
    const exactEpisode = historyEntries.find(
      (entry) =>
        normalizeHistoryType(entry.type_) === normalizeHistoryType(item.type_) &&
        entry.season === season &&
        entry.episode === episode &&
        entry.position > 0,
    );
    if (exactEpisode?.position && exactEpisode.position > 0) {
      return exactEpisode.position;
    }
    // Don't fall back to a different episode's position — that would resume at the
    // wrong timestamp.  Return 0 so the player starts from the beginning.
  } catch {
    // Best-effort recovery only.
  }

  return 0;
}

async function tryQuickBestStreamResolve(
  item: WatchProgress,
  streamLookupId: string,
  streamSeason?: number,
  streamEpisode?: number,
  absoluteEpisode?: number,
  bypassCache = false,
): Promise<BestResolvedStream | null> {
  const resolvePromise = api
    .resolveBestStream(
      getMediaDetailsType(item),
      streamLookupId,
      streamSeason,
      streamEpisode,
      absoluteEpisode,
      bypassCache ? { bypassCache: true } : undefined,
    )
    .catch(() => null);

  return Promise.race<BestResolvedStream | null>([
    resolvePromise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(null), QUICK_RESUME_RESOLVE_BUDGET_MS);
    }),
  ]);
}

export async function warmHistoryPlaybackCandidate(item: WatchProgress): Promise<void> {
  if (!hasEpisodeContext(item)) return;

  const {
    streamSeason,
    streamEpisode,
    absoluteEpisode,
  } = getEpisodeContext(item);
  const lastUrl = item.last_stream_url?.trim() || '';
  const shouldBypassSaved = shouldBypassSavedStream(lastUrl, item.last_watched);
  const hasUsableSavedUrl = !!lastUrl && !shouldBypassSaved;
  const hasRemoteSavedUrl = hasUsableSavedUrl && isRemoteStreamUrl(lastUrl);
  const isLocalFile = hasUsableSavedUrl && !hasRemoteSavedUrl;

  if (isLocalFile) return;
  if (streamSeason === undefined || streamEpisode === undefined) return;

  const streamLookupId = await resolveHistoryStreamLookupId(item, {
    allowMediaDetailsLookup: true,
  });

  await tryQuickBestStreamResolve(
    item,
    streamLookupId,
    streamSeason,
    streamEpisode,
    absoluteEpisode,
    shouldBypassSaved || hasRemoteSavedUrl,
  );
}

export async function buildHistoryPlaybackPlan(
  item: WatchProgress,
  from: string,
): Promise<HistoryPlaybackPlan> {
  const playbackType = getMediaDetailsType(item);

  if (!hasEpisodeContext(item)) {
    return {
      kind: 'details',
      reason: 'missing-episode-context',
      target: `/details/${playbackType}/${item.id}`,
      state: { from },
    };
  }

  const {
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    aniskipEpisode,
  } = getEpisodeContext(item);
  const lastUrl = item.last_stream_url?.trim() || '';
  const shouldBypassSaved = shouldBypassSavedStream(lastUrl, item.last_watched);
  const usableSavedUrl = shouldBypassSaved ? undefined : lastUrl || undefined;
  const isLocalFile = !!usableSavedUrl && !usableSavedUrl.startsWith('http');
  const immediateStreamLookupId = getImmediateHistoryStreamLookupId(item);
  const shouldResolveBeforeNavigate =
    !usableSavedUrl && !isLocalFile && streamSeason !== undefined && streamEpisode !== undefined;

  const streamLookupIdPromise = shouldResolveBeforeNavigate
    ? resolveHistoryStreamLookupId(item)
    : Promise.resolve(immediateStreamLookupId);
  const resumeStartTimePromise = recoverPreciseResumeStartTime(item, absoluteSeason, absoluteEpisode);
  const quickResolvedStreamPromise = shouldResolveBeforeNavigate
    ? streamLookupIdPromise.then((streamLookupId) =>
        tryQuickBestStreamResolve(
          item,
          streamLookupId,
          streamSeason,
          streamEpisode,
          absoluteEpisode,
          shouldBypassSaved,
        ),
      )
    : Promise.resolve<BestResolvedStream | null>(null);

  const [streamLookupId, resumeStartTime, resolvedStream] = await Promise.all([
    streamLookupIdPromise,
    resumeStartTimePromise,
    quickResolvedStreamPromise,
  ]);

  const target =
    playbackType === 'movie'
      ? `/player/${playbackType}/${item.id}`
      : `/player/${playbackType}/${item.id}/${absoluteSeason}/${absoluteEpisode}`;

  return {
    kind: 'player',
    target,
    state: {
      streamUrl: resolvedStream?.url || usableSavedUrl,
      title: item.title,
      poster: item.poster,
      backdrop: item.backdrop,
      format: resolvedStream?.format || item.last_stream_format,
      selectedStreamKey: item.last_stream_key,
      streamLookupId,
      streamSeason,
      streamEpisode,
      absoluteSeason,
      absoluteEpisode,
      aniskipEpisode,
      startTime: resumeStartTime > 0 ? resumeStartTime : 0,
      resumeFromHistory: true,
      isOffline: isLocalFile,
      bypassResolveCache: !resolvedStream && shouldBypassSaved,
      from,
    },
  };
}
