import {
  api,
  type BestResolvedStream,
  type EpisodeStreamMapping,
  type WatchProgress,
} from '@/lib/api';
import {
  buildPlayerNavigationTarget,
  type PlayerRouteState,
} from '@/lib/player-navigation';
import { resolveRankedBestStream } from '@/lib/stream-resolution';

const QUICK_RESUME_RESOLVE_BUDGET_MS = 325;
const CONTINUE_WATCHING_WARMUP_LIMIT = 3;
const CONTINUE_WATCHING_WARMUP_CONCURRENCY = 2;

export interface HistoryPlaybackPlan {
  kind: 'details' | 'player';
  reason?: 'missing-episode-context';
  target: string;
  state: { from: string } | PlayerRouteState;
}

type HistoryPlaybackMediaType = 'movie' | 'series' | 'anime';

function normalizeHistoryType(type: string): string {
  return type.trim().toLowerCase();
}

function isKitsuId(id: string): boolean {
  return id.trim().toLowerCase().startsWith('kitsu:');
}

function normalizeHistoryMediaType(type: string, id: string): HistoryPlaybackMediaType {
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

interface ResolvedHistoryEpisodeContext extends HistoryEpisodeContext {
  streamLookupId: string;
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

function getMediaDetailsType(item: WatchProgress): HistoryPlaybackMediaType {
  return normalizeHistoryMediaType(item.type_, item.id);
}

function applyEpisodeStreamMapping(mapping: EpisodeStreamMapping): HistoryEpisodeContext {
  return {
    absoluteSeason: mapping.canonicalSeason,
    absoluteEpisode: mapping.canonicalEpisode,
    streamSeason: mapping.sourceSeason,
    streamEpisode: mapping.sourceEpisode,
    aniskipEpisode: mapping.aniskipEpisode,
  };
}

async function resolveHistoryEpisodeContext(
  item: WatchProgress,
): Promise<ResolvedHistoryEpisodeContext> {
  const baseContext = getEpisodeContext(item);
  let streamLookupId = getImmediateHistoryStreamLookupId(item);
  const hasCanonicalEpisodeContext =
    baseContext.absoluteSeason !== undefined && baseContext.absoluteEpisode !== undefined;
  const needsMappedCoordinates =
    hasCanonicalEpisodeContext &&
    (baseContext.streamSeason === undefined ||
      baseContext.streamEpisode === undefined ||
      !isUsableResumeLookupId(item.type_, streamLookupId));

  if (needsMappedCoordinates) {
    try {
      const mapping = await api.getEpisodeStreamMapping(
        getMediaDetailsType(item),
        item.id,
        baseContext.absoluteSeason!,
        baseContext.absoluteEpisode!,
      );

      if (mapping) {
        return {
          ...applyEpisodeStreamMapping(mapping),
          streamLookupId: mapping.lookupId,
        };
      }
    } catch {
      // Fall back to the stored or media-details-derived identifiers below.
    }
  }

  if (!isUsableResumeLookupId(item.type_, streamLookupId)) {
    streamLookupId = item.last_stream_lookup_id?.trim() || item.id.trim();
  }

  return {
    ...baseContext,
    streamLookupId,
  };
}

async function recoverPreciseResumeStartTime(
  item: WatchProgress,
  season?: number,
  episode?: number,
): Promise<number> {
  if (!isSeriesLikeType(item.type_) || season === undefined || episode === undefined) {
    return Number.isFinite(item.position) && item.position > 0 ? item.position : 0;
  }

  try {
    const precise = await api.getWatchProgress(item.id, item.type_, season, episode);
    if (precise?.position && precise.position > 0) {
      return precise.position;
    }
  } catch {
    // Best-effort recovery only.
  }

  if (Number.isFinite(item.position) && item.position > 0) {
    return item.position;
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
  const mediaType = getMediaDetailsType(item);
  const resolvePromise = resolveRankedBestStream({
    mediaType,
    mediaId: item.id,
    streamLookupId,
    streamSeason,
    streamEpisode,
    absoluteEpisode,
    bypassCache,
    rankingTarget: {
      mediaId: item.id,
      mediaType,
      season: item.season,
      episode: item.episode,
    },
  })
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
    streamLookupId,
    streamSeason,
    streamEpisode,
    absoluteEpisode,
    absoluteSeason,
  } = await resolveHistoryEpisodeContext(item);
  const savedStreamPolicy = await api.getPlaybackStreamReusePolicy(
    item.id,
    item.type_,
    absoluteSeason,
    absoluteEpisode,
  );
  const lastUrl = item.last_stream_url?.trim() || '';
  const shouldBypassSaved = savedStreamPolicy.shouldBypass;
  const hasUsableSavedUrl = !!lastUrl && savedStreamPolicy.canReuseDirectly;
  const hasRemoteSavedUrl = hasUsableSavedUrl && savedStreamPolicy.isRemote;
  const isLocalFile = savedStreamPolicy.kind === 'local-file';

  if (isLocalFile) return;
  if (streamSeason === undefined || streamEpisode === undefined) return;

  await tryQuickBestStreamResolve(
    item,
    streamLookupId,
    streamSeason,
    streamEpisode,
    absoluteEpisode,
    shouldBypassSaved || hasRemoteSavedUrl,
  );
}

function buildHistoryWarmupKey(item: WatchProgress): string {
  return [
    item.type_,
    item.id,
    item.season ?? 'na',
    item.episode ?? 'na',
    item.last_stream_lookup_id ?? 'na',
    item.last_stream_url ?? 'na',
    item.last_stream_key ?? 'na',
  ].join('|');
}

export async function warmContinueWatchingCandidates(
  items: WatchProgress[],
  options?: {
    warmedKeys?: Set<string>;
    maxCandidates?: number;
    concurrency?: number;
  },
): Promise<void> {
  const warmedKeys = options?.warmedKeys;
  const maxCandidates = Math.max(1, options?.maxCandidates ?? CONTINUE_WATCHING_WARMUP_LIMIT);
  const concurrency = Math.max(1, options?.concurrency ?? CONTINUE_WATCHING_WARMUP_CONCURRENCY);
  const candidates: WatchProgress[] = [];

  for (const item of items) {
    const warmKey = buildHistoryWarmupKey(item);
    if (warmedKeys?.has(warmKey)) continue;
    warmedKeys?.add(warmKey);
    candidates.push(item);
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, candidates.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const current = candidates[nextIndex];
        nextIndex += 1;
        await warmHistoryPlaybackCandidate(current).catch(() => {
          // Continue-watching warmup stays best-effort and should never block Home rendering.
        });
      }
    }),
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
    streamLookupId: mappedStreamLookupId,
  } = await resolveHistoryEpisodeContext(item);
  const lastUrl = item.last_stream_url?.trim() || '';
  const savedStreamPolicy = await api.getPlaybackStreamReusePolicy(
    item.id,
    item.type_,
    absoluteSeason,
    absoluteEpisode,
  );
  const shouldBypassSaved = savedStreamPolicy.shouldBypass;
  const usableSavedUrl = savedStreamPolicy.canReuseDirectly ? lastUrl || undefined : undefined;
  const isLocalFile = savedStreamPolicy.kind === 'local-file';
  const shouldResolveBeforeNavigate =
    !usableSavedUrl && !isLocalFile && streamSeason !== undefined && streamEpisode !== undefined;

  const resumeStartTimePromise = recoverPreciseResumeStartTime(item, absoluteSeason, absoluteEpisode);
  const quickResolvedStreamPromise = shouldResolveBeforeNavigate
    ? Promise.resolve(mappedStreamLookupId).then((streamLookupId) =>
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

  const [resumeStartTime, resolvedStream] = await Promise.all([
    resumeStartTimePromise,
    quickResolvedStreamPromise,
  ]);

  const savedSourceName = item.source_name?.trim() || undefined;
  const savedStreamFamily = item.stream_family?.trim() || undefined;

  const playerNavigation = buildPlayerNavigationTarget(playbackType, item.id, {
    streamUrl: resolvedStream?.url || usableSavedUrl,
    streamSourceName: resolvedStream?.source_name || savedSourceName,
    streamFamily: resolvedStream?.stream_family || savedStreamFamily,
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
    format: resolvedStream?.format || item.last_stream_format,
    selectedStreamKey: item.last_stream_key,
    streamLookupId: mappedStreamLookupId,
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
  });

  return {
    kind: 'player',
    target: playerNavigation.target,
    state: playerNavigation.state,
  };
}
