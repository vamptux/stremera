type PreviewInvokeArgs = Record<string, unknown> | undefined;

const EMPTY_MEDIA_EPISODES_PAGE = {
  episodes: [],
  seasons: [],
  total: 0,
  totalInSeason: 0,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

const EMPTY_ANIME_METADATA = {
  characters: [],
  staff: [],
  productions: [],
  platforms: [],
};

const EMPTY_MULTI_GENRE_CATALOG_PAGE = {
  items: [],
  hasMore: false,
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
    case 'get_trending_movies':
    case 'get_trending_series':
    case 'get_trending_anime':
    case 'get_streams':
    case 'get_streams_for_addon':
    case 'get_skip_times':
    case 'search_media':
    case 'get_watch_history':
    case 'get_continue_watching':
    case 'get_watch_history_full':
    case 'get_watch_history_for_id':
    case 'get_library':
    case 'get_lists':
    case 'get_netflix_catalog':
    case 'get_kitsu_catalog':
    case 'search_kitsu':
    case 'get_downloads':
      return [] as T;
    case 'get_multi_genre_catalog':
      return EMPTY_MULTI_GENRE_CATALOG_PAGE as T;
    case 'get_media_details':
      return {
        id: readStringArg(args, 'id', 'mock-id'),
        title: 'Browser Preview',
        type: readMediaType(args),
        description: 'Desktop-backed metadata is unavailable in browser preview mode.',
        year: '2026',
        episodes: [],
      } as T;
    case 'get_media_episodes':
      return {
        ...EMPTY_MEDIA_EPISODES_PAGE,
        page: typeof args?.page === 'number' ? args.page : EMPTY_MEDIA_EPISODES_PAGE.page,
        pageSize:
          typeof args?.page_size === 'number'
            ? args.page_size
            : EMPTY_MEDIA_EPISODES_PAGE.pageSize,
      } as T;
    case 'get_playback_language_preferences':
    case 'get_effective_playback_language_preferences':
      return {} as T;
    case 'get_addon_configs':
      return [] as T;
    case 'get_all_watch_statuses':
      return {} as T;
    case 'get_watch_status':
    case 'get_watch_progress':
    case 'prepare_next_playback_plan':
    case 'get_episode_stream_mapping':
      return null as T;
    case 'get_kitsu_anime_metadata':
      return EMPTY_ANIME_METADATA as T;
    case 'check_library':
      return false as T;
    case 'check_item_in_lists':
      return [] as T;
    case 'get_data_stats':
      return EMPTY_DATA_STATS as T;
    case 'save_playback_language_preference_outcome':
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