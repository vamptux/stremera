import type { PlaybackStreamOutcomeReport } from '@/lib/playback-stream-health';
import { safeInvoke } from '@/lib/api-core';
import {
  BEST_STREAM_CACHE_TTL_MS,
  MEDIA_DETAILS_CACHE_TTL_MS,
  RESOLVE_STREAM_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
  STREAMS_CACHE_TTL_MS,
  createRequestCache,
} from '@/lib/api-cache';
import type { StreamRankingOptions } from '@/lib/stream-ranking';
import { createDiscoveryApi } from '@/lib/api-discovery';
import { createPlaybackApi } from '@/lib/api-playback';
import { createStoreApi } from '@/lib/api-store';
export { getErrorMessage } from '@/lib/api-core';

export interface MediaItem {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  description?: string;
  year?: string;
  primaryYear?: number;
  displayYear?: string;
  type: 'movie' | 'series';
  relationRole?: string;
  relationContextLabel?: string;
  relationPreferredSeason?: number;
}

export interface Episode {
  id: string;
  title?: string;
  season: number;
  episode: number;
  released?: string;
  releaseDate?: string;
  overview?: string;
  thumbnail?: string;
  /** IMDB ID of the parent series (e.g. "tt0388629") — present for Kitsu anime */
  imdbId?: string;
  /** IMDB season number — may differ from source season for long-running anime */
  imdbSeason?: number;
  /** IMDB episode number within the IMDB season */
  imdbEpisode?: number;
  /** Backend-normalized playback lookup ID for this episode. */
  streamLookupId?: string;
  /** Backend-normalized source season for stream resolution. */
  streamSeason?: number;
  /** Backend-normalized source episode for stream resolution. */
  streamEpisode?: number;
  /** Backend-normalized AniSkip episode number for this episode. */
  aniskipEpisode?: number;
}

export interface Trailer {
  id: string;
  source: string;
  url: string;
}

export interface MediaDetails extends MediaItem {
  imdbId?: string;
  description?: string;
  rating?: string;
  cast?: string[];
  genres?: string[];
  trailers?: Trailer[];
  episodes?: Episode[];
  releaseDate?: string;
  seasonYears?: Record<string, string>;
  relations?: MediaItem[];
}

export interface MediaEpisodesPage {
  episodes: Episode[];
  seasons: number[];
  seasonYears?: Record<string, string>;
  total: number;
  totalInSeason: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface UserList {
  id: string;
  name: string;
  icon: string;
  item_ids: string[];
  items: MediaItem[];
}

export type WatchStatus = 'watching' | 'watched' | 'plan_to_watch' | 'dropped';

export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  watching: 'Watching',
  watched: 'Watched',
  plan_to_watch: 'Plan to Watch',
  dropped: 'Dropped',
};

export const WATCH_STATUS_COLORS: Record<
  WatchStatus,
  { text: string; bg: string; border: string }
> = {
  watching: { text: 'text-blue-400', bg: 'bg-blue-500/15', border: 'border-blue-500/30' },
  watched: { text: 'text-green-400', bg: 'bg-green-500/15', border: 'border-green-500/30' },
  plan_to_watch: {
    text: 'text-yellow-400',
    bg: 'bg-yellow-500/15',
    border: 'border-yellow-500/30',
  },
  dropped: { text: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30' },
};

export interface TorrentioStream {
  name?: string;
  title?: string;
  infoHash?: string;
  url?: string;
  fileIdx?: number;
  streamKey: string;
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
  };
  cached?: boolean;
  seeders?: number;
  size_bytes?: number;
  /** Addon/source that returned this stream (set by the backend). */
  source_name?: string;
  /** Stable backend-derived release family used for adjacent-episode ranking. */
  stream_family?: string;
  /** Backend coordinator explanation for why this stream ranks where it does. */
  recommendation_reasons?: string[];
  /** Backend-prepared presentation facts so the UI can render without reparsing stream text. */
  presentation: TorrentioStreamPresentation;
}

export type TorrentioStreamResolution = '4k' | '1080p' | '720p' | 'sd';
export type TorrentioStreamDeliveryKind = 'cached' | 'http' | 'torrent';

export interface TorrentioStreamPresentation {
  sourceName: string;
  streamTitle: string;
  resolution: TorrentioStreamResolution;
  deliveryKind: TorrentioStreamDeliveryKind;
  deliveryLabel: string;
  isInstantlyPlayable: boolean;
  hdrLabel?: string;
  audioLabel?: string;
  codecLabel?: string;
  multiAudioLabel?: string;
  sizeLabel?: string;
  isBatch: boolean;
}

export type StreamSourceHealthStatus = 'healthy' | 'degraded' | 'offline';

export interface StreamSourceSummary {
  id: string;
  name: string;
  status: StreamSourceHealthStatus;
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface StreamSelectorData {
  streams: TorrentioStream[];
  sourceSummaries: StreamSourceSummary[];
  fatalErrorMessage?: string | null;
}

export interface PreparedPlaybackStream {
  url: string;
  format: string;
  sourceName?: string;
  streamFamily?: string;
}

export interface NextPlaybackCanonicalEpisode {
  title?: string;
  season: number;
  episode: number;
}

export interface NextPlaybackSourceCoordinates {
  lookupId: string;
  season: number;
  episode: number;
  aniskipEpisode: number;
}

export interface NextPlaybackPlan {
  canonical: NextPlaybackCanonicalEpisode;
  source: NextPlaybackSourceCoordinates;
  lookupKey: string;
  primaryStream?: PreparedPlaybackStream;
  backupStream?: PreparedPlaybackStream;
}

export interface AnimeCharacterProfile {
  name: string;
  role?: string;
  image?: string;
  description?: string;
}

export interface AnimeStaffProfile {
  name: string;
  roles: string[];
  image?: string;
  description?: string;
}

export interface AnimeProductionCompanyProfile {
  name: string;
  roles: string[];
  logo?: string;
  description?: string;
}

export interface AnimeStreamingPlatformProfile {
  name: string;
  url: string;
  logo?: string;
  subLanguages: string[];
  dubLanguages: string[];
}

export interface AnimeSupplementalMetadata {
  characters: AnimeCharacterProfile[];
  staff: AnimeStaffProfile[];
  productions: AnimeProductionCompanyProfile[];
  platforms: AnimeStreamingPlatformProfile[];
  warnings: string[];
}

export interface ResolvedStream {
  url: string;
  is_web_friendly: boolean;
  format: string;
}

export interface BestResolvedStream extends ResolvedStream {
  used_fallback: boolean;
  source_name?: string;
  stream_family?: string;
}

export interface ResolveBestStreamOptions extends StreamRankingOptions {
  bypassCache?: boolean;
}

export interface RecoverPlaybackStreamOptions extends StreamRankingOptions {
  mediaType: string;
  mediaId: string;
  streamSeason?: number;
  streamEpisode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  failedStreamUrl?: string;
  failedStreamFormat?: string;
  failedSourceName?: string;
  failedStreamFamily?: string;
  failedStreamKey?: string;
  outcome: Exclude<PlaybackStreamOutcomeReport['outcome'], 'verified'>;
  preparedBackupStream?: PreparedPlaybackStream;
}

/** A user-configured addon source compatible with Stremera's addon pipeline. */
export interface AddonConfig {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
}

/** Parsed name/description from an addon manifest.json. */
export interface AddonManifest {
  name: string;
  description?: string;
  version?: string;
}

const apiCaches = {
  bestStream: createRequestCache<BestResolvedStream>(BEST_STREAM_CACHE_TTL_MS),
  resolveStream: createRequestCache<ResolvedStream>(RESOLVE_STREAM_CACHE_TTL_MS),
  streams: createRequestCache<TorrentioStream[]>(STREAMS_CACHE_TTL_MS),
  streamSelector: createRequestCache<StreamSelectorData>(STREAMS_CACHE_TTL_MS),
  mediaDetails: createRequestCache<MediaDetails>(MEDIA_DETAILS_CACHE_TTL_MS),
  searchCatalog: createRequestCache<SearchCatalogPage>(SEARCH_CACHE_TTL_MS),
  searchResults: createRequestCache<MediaItem[]>(SEARCH_CACHE_TTL_MS),
};

function normalizeStreamMediaType(type: string, id: string): string {
  const normalizedType = type.trim().toLowerCase();
  if (normalizedType === 'movie' || normalizedType === 'anime') return normalizedType;
  if (normalizedType === 'series' && id.trim().toLowerCase().startsWith('kitsu:')) {
    return 'anime';
  }
  return normalizedType;
}

export interface PlaybackLanguagePreferences {
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

export interface LocalProfile {
  username: string;
  accentColor: string;
  bio: string;
}

export type ProfileViewMode = 'grid' | 'list';

export interface ProfilePreferences {
  profile: LocalProfile;
  viewMode: ProfileViewMode;
}

export interface AppUiPreferences {
  playerVolume: number;
  playerSpeed: number;
  spoilerProtection: boolean;
}

export interface AppUiPreferencesPatch {
  playerVolume?: number;
  playerSpeed?: number;
  spoilerProtection?: boolean;
}

export type StreamSelectorQuality = 'all' | '4k' | '1080p' | '720p' | 'sd';
export type StreamSelectorSource = 'all' | 'cached';
export type StreamSelectorSort = 'smart' | 'quality' | 'size' | 'seeds';
export type StreamSelectorBatch = 'all' | 'episodes' | 'packs';

export interface StreamSelectorPreferences {
  quality: StreamSelectorQuality;
  source: StreamSelectorSource;
  addon: string;
  sort: StreamSelectorSort;
  batch: StreamSelectorBatch;
}

export interface StreamSelectorPreferencesState {
  preferences: StreamSelectorPreferences;
  initialized: boolean;
}

export interface TrackLanguageCandidate {
  id: number;
  lang?: string;
  title?: string;
  defaultTrack?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
}

export interface TrackLanguageSelectionResolution {
  normalizedPreferredLanguage?: string;
  selectedMatches: boolean;
  matchedTrackId?: number;
}

export interface SearchCatalogQuery {
  query?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  provider?: 'cinemeta' | 'netflix' | 'hbo' | 'disney' | 'prime' | 'apple' | 'kitsu';
  feed?: 'popular' | 'featured' | 'trending' | 'airing' | 'rating';
  sort?: 'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';
  genres?: string[];
  yearFrom?: number;
  yearTo?: number;
  skip?: number;
  limit?: number;
}

export interface SearchCatalogPage {
  items: MediaItem[];
  nextSkip?: number | null;
}

export type HistoryPlaybackPlanReason = 'missing-episode-context' | 'missing-saved-stream';

export interface HistoryPlaybackRouteState {
  from?: string;
  season?: number;
  reopenStreamSelector?: boolean;
  reopenStreamSeason?: number;
  reopenStreamEpisode?: number;
  reopenStartTime?: number;
  streamUrl?: string;
  title?: string;
  poster?: string;
  backdrop?: string;
  format?: string;
  streamSourceName?: string;
  streamFamily?: string;
  selectedStreamKey?: string;
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  aniskipEpisode?: number;
  resumeFromHistory?: boolean;
  streamLookupId?: string;
}

export interface HistoryPlaybackPlan {
  kind: 'details' | 'player';
  reason?: HistoryPlaybackPlanReason;
  target: string;
  state: HistoryPlaybackRouteState;
}

export const api = {
  ...createDiscoveryApi({
    safeInvoke,
    mediaDetailsCache: apiCaches.mediaDetails,
    searchCatalogCache: apiCaches.searchCatalog,
    searchResultsCache: apiCaches.searchResults,
  }),
  ...createPlaybackApi({
    safeInvoke,
    caches: apiCaches,
    normalizeStreamMediaType,
  }),
  ...createStoreApi({
    safeInvoke,
    caches: apiCaches,
  }),
};

export interface DownloadItem {
  id: string;
  title: string;
  url: string;
  filePath: string;
  fileName: string;
  totalSize: number;
  downloadedSize: number;
  speed: number;
  progress: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
  error?: string;
  createdAt: number;
  updatedAt: number;
  poster?: string;
  mediaType?: string;
  bandwidthLimit?: number;
  mediaId?: string;
  season?: number;
  episode?: number;
}

export interface StartDownloadParams {
  title: string;
  url: string;
  filePath: string;
  fileName: string;
  poster?: string;
  mediaType?: string;
  bandwidthLimit?: number;
  mediaId?: string;
  season?: number;
  episode?: number;
}

export interface DataStats {
  history_count: number;
  library_count: number;
  lists_count: number;
  watch_statuses_count: number;
}

export interface ImportResult {
  history_imported: number;
  library_imported: number;
  lists_imported: number;
  statuses_imported: number;
}

export interface DownloadProgressEvent {
  id: string;
  downloadedSize: number;
  totalSize: number;
  speed: number;
  progress: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
}

export interface WatchProgress {
  id: string;
  type_: string;
  season?: number;
  episode?: number;
  absolute_season?: number;
  absolute_episode?: number;
  stream_season?: number;
  stream_episode?: number;
  aniskip_episode?: number;
  position: number;
  duration: number;
  last_watched: number;
  title: string;
  poster?: string;
  backdrop?: string;
  last_stream_url?: string;
  last_stream_format?: string;
  last_stream_lookup_id?: string;
  last_stream_key?: string;
  source_name?: string;
  stream_family?: string;
  resume_start_time?: number;
}

/**
 * A single skippable playback segment returned by either AniSkip (anime)
 * or IntroDB (TV series).
 *
 * Anime skip types:  "op" | "ed" | "mixed-op" | "mixed-ed" | "recap"
 * TV series types:   "intro" | "recap" | "outro"
 */
export interface SkipSegment {
  /** Segment category identifier */
  type: string;
  /** Segment start in seconds */
  start_time: number;
  /** Segment end in seconds */
  end_time: number;
}
