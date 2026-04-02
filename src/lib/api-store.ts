import {
  clearProviderDataCaches,
  clearStreamingCaches,
  type ApiCacheGroups,
} from '@/lib/api-cache';
import type {
  AddonConfig,
  AddonManifest,
  AppUiPreferences,
  AppUiPreferencesPatch,
  DataStats,
  DownloadItem,
  ImportResult,
  LocalProfile,
  MediaItem,
  ProfilePreferences,
  ProfileViewMode,
  StartDownloadParams,
  StreamSelectorPreferences,
  StreamSelectorPreferencesState,
  UserList,
  WatchStatus,
} from '@/lib/api';

type InvokeApi = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface StoreApiContext {
  safeInvoke: InvokeApi;
  caches: ApiCacheGroups;
}

export function createStoreApi({ safeInvoke, caches }: StoreApiContext) {
  const getAddonConfigs = () => safeInvoke<AddonConfig[]>('get_addon_configs');

  return {
    getAddonConfigs,
    saveAddonConfigs: async (configs: AddonConfig[]) => {
      const saved = await safeInvoke<AddonConfig[]>('save_addon_configs', { configs });
      clearProviderDataCaches(caches);
      return saved;
    },
    fetchAddonManifest: (url: string) =>
      safeInvoke<AddonManifest>('fetch_addon_manifest', { url }),
    getAppUiPreferences: () => safeInvoke<AppUiPreferences>('get_app_ui_preferences'),
    saveAppUiPreferences: (patch: AppUiPreferencesPatch) =>
      safeInvoke<AppUiPreferences>('save_app_ui_preferences', {
        patch,
      }),
    importLegacyAppUiPreferences: (preferences: AppUiPreferences) =>
      safeInvoke<AppUiPreferences>('import_legacy_app_ui_preferences', {
        preferences,
      }),
    getProfilePreferences: () => safeInvoke<ProfilePreferences>('get_profile_preferences'),
    saveProfilePreferences: (profile: LocalProfile, viewMode: ProfileViewMode) =>
      safeInvoke<ProfilePreferences>('save_profile_preferences', {
        profile,
        viewMode,
      }),
    importLegacyProfilePreferences: (profile: LocalProfile, viewMode: ProfileViewMode) =>
      safeInvoke<ProfilePreferences>('import_legacy_profile_preferences', {
        profile,
        viewMode,
      }),
    getStreamSelectorPreferences: () =>
      safeInvoke<StreamSelectorPreferencesState>('get_stream_selector_preferences'),
    saveStreamSelectorPreferences: (preferences: StreamSelectorPreferences) =>
      safeInvoke<StreamSelectorPreferences>('save_stream_selector_preferences', {
        preferences,
      }).then((savedPreferences) => {
        clearStreamingCaches(caches);
        return savedPreferences;
      }),
    importLegacyStreamSelectorPreferences: (preferences: StreamSelectorPreferences) =>
      safeInvoke<StreamSelectorPreferences>('import_legacy_stream_selector_preferences', {
        preferences,
      }).then((savedPreferences) => {
        clearStreamingCaches(caches);
        return savedPreferences;
      }),
    addToLibrary: (item: MediaItem) => safeInvoke<void>('add_to_library', { item }),
    removeFromLibrary: (id: string) => safeInvoke<void>('remove_from_library', { id }),
    getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
    checkLibrary: (id: string) => safeInvoke<boolean>('check_library', { id }),
    createList: (name: string, icon?: string) =>
      safeInvoke<UserList>('create_list', { name, icon }),
    deleteList: (listId: string) => safeInvoke<void>('delete_list', { listId }),
    renameList: (listId: string, name: string, icon?: string) =>
      safeInvoke<void>('rename_list', { listId, name, icon }),
    addToList: (listId: string, item: MediaItem) =>
      safeInvoke<void>('add_to_list', { listId, item }),
    removeFromList: (listId: string, itemId: string) =>
      safeInvoke<void>('remove_from_list', { listId, itemId }),
    getLists: () => safeInvoke<UserList[]>('get_lists'),
    reorderListItems: (listId: string, itemIds: string[]) =>
      safeInvoke<void>('reorder_list_items', { listId, itemIds }),
    reorderLists: (listIds: string[]) => safeInvoke<void>('reorder_lists', { listIds }),
    checkItemInLists: (itemId: string) =>
      safeInvoke<string[]>('check_item_in_lists', { itemId }),
    setWatchStatus: (itemId: string, status: WatchStatus | null) =>
      safeInvoke<void>('set_watch_status', { itemId, status }),
    getWatchStatus: (itemId: string) =>
      safeInvoke<WatchStatus | null>('get_watch_status', { itemId }),
    getAllWatchStatuses: () =>
      safeInvoke<Record<string, WatchStatus>>('get_all_watch_statuses'),
    startDownload: (params: StartDownloadParams) =>
      safeInvoke<string>('start_download', params as unknown as Record<string, unknown>),
    pauseDownload: (id: string) => safeInvoke<void>('pause_download', { id }),
    pauseActiveDownloads: () => safeInvoke<number>('pause_active_downloads'),
    resumeDownload: (id: string) => safeInvoke<void>('resume_download', { id }),
    cancelDownload: (id: string) => safeInvoke<void>('cancel_download', { id }),
    checkDownloadFileExists: (id: string) =>
      safeInvoke<boolean>('check_download_file_exists', { id }),
    removeDownload: (id: string, deleteFile: boolean) =>
      safeInvoke<void>('remove_download', { id, deleteFile }),
    clearCompletedDownloads: (deleteFile = false) =>
      safeInvoke<number>('clear_completed_downloads', { deleteFile }),
    getDownloads: () => safeInvoke<DownloadItem[]>('get_downloads'),
    setDownloadBandwidth: (limit?: number) =>
      safeInvoke<void>('set_download_bandwidth', { limit }),
    getDefaultDownloadPath: () => safeInvoke<string>('get_default_download_path'),
    openFolder: (path: string) => safeInvoke<void>('open_folder', { path }),
    getDataStats: () => safeInvoke<DataStats>('get_data_stats'),
    clearWatchHistory: () => safeInvoke<void>('clear_watch_history'),
    clearLibrary: () => safeInvoke<void>('clear_library'),
    clearAllLists: () => safeInvoke<void>('clear_all_lists'),
    clearAllWatchStatuses: () => safeInvoke<void>('clear_all_watch_statuses'),
    exportAppData: () => safeInvoke<string>('export_app_data'),
    exportAppDataToFile: (path: string) => safeInvoke<void>('export_app_data_to_file', { path }),
    importAppData: (data: string) => safeInvoke<ImportResult>('import_app_data', { data }),
    importAppDataFromFile: (path: string) =>
      safeInvoke<ImportResult>('import_app_data_from_file', { path }),
    checkApiKeys: async () => {
      try {
        const addons = await getAddonConfigs();
        return addons.some((addon) => addon.enabled && addon.url.trim().length > 0);
      } catch {
        return false;
      }
    },
  };
}