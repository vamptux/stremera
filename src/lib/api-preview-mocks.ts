import {
  buildSearchHistoryKey,
  canonicalizeSearchHistoryEntries,
  type SearchHistoryEntry,
} from '@/lib/search-history';
import { type FilterState, filterAndSortStreams } from '@/lib/stream-selector-utils';

type PreviewInvokeArgs = Record<string, unknown> | undefined;

let previewSearchHistory: SearchHistoryEntry[] = [];
let previewProfilePreferences = {
  profile: {
    username: 'Guest User',
    accentColor: '#ffffff',
    bio: '',
  },
  viewMode: 'grid',
};
let previewAppUiPreferences = {
  playerVolume: 75,
  playerSpeed: 1,
  spoilerProtection: false,
};
let previewStreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

const EMPTY_MEDIA_EPISODES_PAGE = {
  episodes: [],
  seasons: [],
  total: 0,
  totalInSeason: 0,
  filteredTotal: 0,
  resolvedSeason: undefined,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

const EMPTY_MEDIA_SCHEDULE = {
  id: 'mock-id',
  title: 'Browser Preview',
  type: 'series',
  releaseDate: undefined,
  episodes: [],
};

const EMPTY_ANIME_METADATA = {
  characters: [],
  staff: [],
  productions: [],
  platforms: [],
};

const EMPTY_SEARCH_CATALOG_PAGE = {
  items: [],
  nextSkip: null,
};

const EMPTY_STREAM_SELECTOR_DATA = {
  streams: [],
  stats: {
    resCounts: {
      '4k': 0,
      '1080p': 0,
      '720p': 0,
      sd: 0,
    },
    playableCount: 0,
    cachedCount: 0,
    batchCount: 0,
    episodeLikeCount: 0,
  },
  sourceSummaries: [],
  fatalErrorMessage: null,
};

const EMPTY_DATA_STATS = {
  history_count: 0,
  library_count: 0,
  lists_count: 0,
  watch_statuses_count: 0,
};

function readStringArg(args: PreviewInvokeArgs, key: string, fallback: string): string {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readMediaType(args: PreviewInvokeArgs): 'movie' | 'series' {
  const value = args?.mediaType ?? args?.type_;
  if (typeof value !== 'string') {
    return 'movie';
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'movie' ? 'movie' : 'series';
}

export async function handlePreviewInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case 'get_search_history':
      return previewSearchHistory as T;
    case 'import_search_history_entries': {
      const entries = Array.isArray(args?.entries) ? args.entries : [];
      previewSearchHistory = canonicalizeSearchHistoryEntries(entries);
      return previewSearchHistory as T;
    }
    case 'push_search_history_entry': {
      const entry = args?.entry;
      previewSearchHistory = canonicalizeSearchHistoryEntries([
        {
          ...(typeof entry === 'object' && entry !== null ? entry : {}),
          savedAt: Date.now(),
        },
        ...previewSearchHistory,
      ]);
      return previewSearchHistory as T;
    }
    case 'remove_search_history_entry': {
      const [normalizedEntry] = canonicalizeSearchHistoryEntries(
        args?.entry !== undefined ? [args.entry] : [],
      );
      if (normalizedEntry) {
        const entryKey = buildSearchHistoryKey(normalizedEntry);
        previewSearchHistory = previewSearchHistory.filter(
          (entry) => buildSearchHistoryKey(entry) !== entryKey,
        );
      }
      return previewSearchHistory as T;
    }
    case 'clear_search_history':
      previewSearchHistory = [];
      return undefined as T;
    case 'query_search_catalog':
      return EMPTY_SEARCH_CATALOG_PAGE as T;
    case 'get_app_ui_preferences':
      return previewAppUiPreferences as T;
    case 'save_app_ui_preferences': {
      const patch = typeof args?.patch === 'object' && args.patch !== null ? args.patch : {};
      previewAppUiPreferences = {
        playerVolume:
          typeof (patch as { playerVolume?: unknown }).playerVolume === 'number'
            ? Math.max(
                0,
                Math.min(100, Math.round((patch as { playerVolume: number }).playerVolume)),
              )
            : previewAppUiPreferences.playerVolume,
        playerSpeed:
          typeof (patch as { playerSpeed?: unknown }).playerSpeed === 'number' &&
          Number.isFinite((patch as { playerSpeed: number }).playerSpeed) &&
          (patch as { playerSpeed: number }).playerSpeed > 0
            ? Math.max(0.25, Math.min(4, (patch as { playerSpeed: number }).playerSpeed))
            : previewAppUiPreferences.playerSpeed,
        spoilerProtection:
          typeof (patch as { spoilerProtection?: unknown }).spoilerProtection === 'boolean'
            ? (patch as { spoilerProtection: boolean }).spoilerProtection
            : previewAppUiPreferences.spoilerProtection,
      };
      return previewAppUiPreferences as T;
    }
    case 'import_legacy_app_ui_preferences': {
      const preferences =
        typeof args?.preferences === 'object' && args.preferences !== null ? args.preferences : {};
      previewAppUiPreferences = {
        playerVolume:
          typeof (preferences as { playerVolume?: unknown }).playerVolume === 'number'
            ? Math.max(
                0,
                Math.min(100, Math.round((preferences as { playerVolume: number }).playerVolume)),
              )
            : previewAppUiPreferences.playerVolume,
        playerSpeed:
          typeof (preferences as { playerSpeed?: unknown }).playerSpeed === 'number' &&
          Number.isFinite((preferences as { playerSpeed: number }).playerSpeed) &&
          (preferences as { playerSpeed: number }).playerSpeed > 0
            ? Math.max(0.25, Math.min(4, (preferences as { playerSpeed: number }).playerSpeed))
            : previewAppUiPreferences.playerSpeed,
        spoilerProtection:
          typeof (preferences as { spoilerProtection?: unknown }).spoilerProtection === 'boolean'
            ? (preferences as { spoilerProtection: boolean }).spoilerProtection
            : previewAppUiPreferences.spoilerProtection,
      };
      return previewAppUiPreferences as T;
    }
    case 'get_profile_preferences':
      return previewProfilePreferences as T;
    case 'save_profile_preferences':
    case 'import_legacy_profile_preferences': {
      const profile =
        typeof args?.profile === 'object' && args.profile !== null ? args.profile : undefined;
      previewProfilePreferences = {
        profile: {
          username:
            typeof (profile as { username?: unknown } | undefined)?.username === 'string' &&
            (profile as { username: string }).username.trim()
              ? (profile as { username: string }).username.trim()
              : previewProfilePreferences.profile.username,
          accentColor:
            typeof (profile as { accentColor?: unknown } | undefined)?.accentColor === 'string' &&
            (profile as { accentColor: string }).accentColor.trim()
              ? (profile as { accentColor: string }).accentColor.trim().toLowerCase()
              : previewProfilePreferences.profile.accentColor,
          bio:
            typeof (profile as { bio?: unknown } | undefined)?.bio === 'string'
              ? (profile as { bio: string }).bio.trim()
              : previewProfilePreferences.profile.bio,
        },
        viewMode: args?.viewMode === 'list' ? 'list' : 'grid',
      };
      return previewProfilePreferences as T;
    }
    case 'get_stream_selector_preferences':
      return {
        preferences: previewStreamSelectorPreferences,
        initialized: true,
      } as T;
    case 'save_stream_selector_preferences':
    case 'import_legacy_stream_selector_preferences': {
      const preferences =
        typeof args?.preferences === 'object' && args.preferences !== null ? args.preferences : {};
      previewStreamSelectorPreferences = {
        quality:
          typeof (preferences as { quality?: unknown }).quality === 'string'
            ? ((preferences as { quality: string })
                .quality as typeof previewStreamSelectorPreferences.quality)
            : previewStreamSelectorPreferences.quality,
        source:
          typeof (preferences as { source?: unknown }).source === 'string'
            ? ((preferences as { source: string })
                .source as typeof previewStreamSelectorPreferences.source)
            : previewStreamSelectorPreferences.source,
        addon:
          typeof (preferences as { addon?: unknown }).addon === 'string' &&
          (preferences as { addon: string }).addon.trim()
            ? (preferences as { addon: string }).addon.trim()
            : 'all',
        sort:
          typeof (preferences as { sort?: unknown }).sort === 'string'
            ? ((preferences as { sort: string })
                .sort as typeof previewStreamSelectorPreferences.sort)
            : previewStreamSelectorPreferences.sort,
        batch:
          typeof (preferences as { batch?: unknown }).batch === 'string'
            ? ((preferences as { batch: string })
                .batch as typeof previewStreamSelectorPreferences.batch)
            : previewStreamSelectorPreferences.batch,
      };
      return previewStreamSelectorPreferences as T;
    }
    case 'get_trending_movies':
    case 'get_trending_series':
    case 'get_trending_anime':
    case 'get_streams':
    case 'get_skip_times':
    case 'get_watch_history':
    case 'get_continue_watching':
    case 'get_watch_history_full':
    case 'get_watch_history_for_id':
    case 'get_library':
    case 'get_lists':
    case 'get_downloads':
      return [] as T;
    case 'get_stream_selector_data':
      return EMPTY_STREAM_SELECTOR_DATA as T;
    case 'filter_stream_selector_streams': {
      const streams = Array.isArray(args?.streams) ? args.streams : [];
      const filters =
        typeof args?.filters === 'object' && args.filters !== null
          ? (args.filters as FilterState)
          : (previewStreamSelectorPreferences as FilterState);

      return filterAndSortStreams(streams as never[], filters) as T;
    }
    case 'get_media_details':
      return {
        id: readStringArg(args, 'id', 'mock-id'),
        title: 'Browser Preview',
        type: readMediaType(args),
        description: 'Desktop-backed metadata is unavailable in browser preview mode.',
        year: '2026',
        releaseDate: '2026-01-01',
        episodes: [],
      } as T;
    case 'get_media_schedules': {
      const items = Array.isArray(args?.items) ? args.items : [];

      return items.map((item, index) => {
        const scheduleRequest =
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
        const mediaType =
          typeof scheduleRequest.mediaType === 'string' && scheduleRequest.mediaType.trim()
            ? scheduleRequest.mediaType.trim()
            : EMPTY_MEDIA_SCHEDULE.type;
        const id =
          typeof scheduleRequest.id === 'string' && scheduleRequest.id.trim()
            ? scheduleRequest.id.trim()
            : `${EMPTY_MEDIA_SCHEDULE.id}-${index + 1}`;

        return {
          ...EMPTY_MEDIA_SCHEDULE,
          id,
          title: `Browser Preview ${index + 1}`,
          type: mediaType,
        };
      }) as T;
    }
    case 'get_media_episodes':
      return {
        ...EMPTY_MEDIA_EPISODES_PAGE,
        resolvedSeason:
          typeof args?.season === 'number' && Number.isFinite(args.season) ? args.season : 1,
        page: typeof args?.page === 'number' ? args.page : EMPTY_MEDIA_EPISODES_PAGE.page,
        pageSize:
          typeof args?.page_size === 'number' ? args.page_size : EMPTY_MEDIA_EPISODES_PAGE.pageSize,
      } as T;
    case 'get_playback_language_preferences':
    case 'get_effective_playback_language_preferences':
      return {} as T;
    case 'resolve_preferred_track_selection':
      return {
        normalizedPreferredLanguage: undefined,
        selectedMatches: false,
        matchedTrackId: undefined,
      } as T;
    case 'get_addon_configs':
      return [] as T;
    case 'get_all_watch_statuses':
      return {} as T;
    case 'get_watch_status':
    case 'get_watch_progress':
    case 'prepare_next_playback_plan':
    case 'recover_playback_stream':
      return null as T;
    case 'build_history_playback_plan': {
      const item =
        typeof args?.item === 'object' && args?.item !== null
          ? (args.item as Record<string, unknown>)
          : null;
      const mediaId = typeof item?.id === 'string' && item.id.trim() ? item.id : 'mock-id';
      const itemType = typeof item?.type_ === 'string' ? item.type_.trim().toLowerCase() : 'movie';
      const mediaType = mediaId.startsWith('kitsu:')
        ? 'anime'
        : itemType === 'movie'
          ? 'movie'
          : 'series';
      const absoluteSeason =
        typeof item?.absolute_season === 'number'
          ? item.absolute_season
          : typeof item?.season === 'number'
            ? item.season
            : undefined;
      const absoluteEpisode =
        typeof item?.absolute_episode === 'number'
          ? item.absolute_episode
          : typeof item?.episode === 'number'
            ? item.episode
            : undefined;
      const from = readStringArg(args, 'from', '/');
      const savedStreamUrl =
        typeof item?.last_stream_url === 'string' && item.last_stream_url.trim()
          ? item.last_stream_url
          : undefined;

      if (savedStreamUrl) {
        const target =
          typeof absoluteSeason === 'number' && typeof absoluteEpisode === 'number'
            ? `/player/${mediaType}/${mediaId}/${absoluteSeason}/${absoluteEpisode}`
            : `/player/${mediaType}/${mediaId}`;

        return {
          kind: 'player',
          target,
          state: {
            from,
            streamUrl: savedStreamUrl,
            title: typeof item?.title === 'string' ? item.title : undefined,
            poster: typeof item?.poster === 'string' ? item.poster : undefined,
            backdrop: typeof item?.backdrop === 'string' ? item.backdrop : undefined,
            format:
              typeof item?.last_stream_format === 'string' ? item.last_stream_format : undefined,
            streamSourceName: typeof item?.source_name === 'string' ? item.source_name : undefined,
            streamFamily: typeof item?.stream_family === 'string' ? item.stream_family : undefined,
            selectedStreamKey:
              typeof item?.last_stream_key === 'string' ? item.last_stream_key : undefined,
            startTime:
              typeof item?.resume_start_time === 'number' ? item.resume_start_time : undefined,
            absoluteSeason,
            absoluteEpisode,
            streamSeason:
              typeof item?.stream_season === 'number' ? item.stream_season : absoluteSeason,
            streamEpisode:
              typeof item?.stream_episode === 'number' ? item.stream_episode : absoluteEpisode,
            aniskipEpisode:
              typeof item?.aniskip_episode === 'number' ? item.aniskip_episode : absoluteEpisode,
            resumeFromHistory: true,
            streamLookupId:
              typeof item?.last_stream_lookup_id === 'string' && item.last_stream_lookup_id.trim()
                ? item.last_stream_lookup_id
                : mediaId,
          },
        } as T;
      }

      return {
        kind: 'details',
        reason: 'missing-saved-stream',
        target: `/details/${mediaType}/${mediaId}`,
        state: { from },
      } as T;
    }
    case 'get_kitsu_anime_metadata':
      return EMPTY_ANIME_METADATA as T;
    case 'check_library':
      return false as T;
    case 'check_item_in_lists':
      return [] as T;
    case 'get_data_stats':
      return EMPTY_DATA_STATS as T;
    case 'save_selected_playback_language_preference':
      return {} as T;
    case 'save_playback_language_preference_outcome_from_tracks':
      return undefined as T;
    case 'pause_active_downloads':
    case 'clear_completed_downloads':
      return 0 as T;
    default:
      throw new Error(
        `Command "${command}" is unavailable in browser preview. Run the Tauri desktop app for this path.`,
      );
  }
}
