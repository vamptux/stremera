import type { QueryClient } from '@tanstack/react-query';

const LIBRARY_QUERY_KEY = ['library'] as const;
const CONTINUE_WATCHING_QUERY_KEY = ['continue-watching'] as const;
const WATCH_HISTORY_QUERY_KEY = ['watch-history'] as const;
const LISTS_QUERY_KEY = ['lists'] as const;
const WATCH_STATUSES_QUERY_KEY = ['watch-statuses'] as const;
const DATA_STATS_QUERY_KEY = ['dataStats'] as const;
const STREAMS_QUERY_KEY = ['streams'] as const;
const STREAMS_BY_ADDON_QUERY_KEY = ['streamsByAddon'] as const;
const EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = [
  'effectivePlaybackLanguagePreferences',
] as const;

async function invalidateQuery(queryClient: QueryClient, queryKey: readonly unknown[]) {
  await queryClient.invalidateQueries({ queryKey });
}

export async function invalidateLibraryQueries(queryClient: QueryClient) {
  await invalidateQuery(queryClient, LIBRARY_QUERY_KEY);
}

export async function invalidatePlaybackHistoryQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, CONTINUE_WATCHING_QUERY_KEY),
    invalidateQuery(queryClient, WATCH_HISTORY_QUERY_KEY),
  ]);
}

export async function invalidateListQueries(queryClient: QueryClient, itemId?: string) {
  await Promise.all([
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    ...(itemId ? [invalidateQuery(queryClient, ['item-lists', itemId] as const)] : []),
  ]);
}

export async function invalidateWatchStatusQueries(queryClient: QueryClient) {
  await invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY);
}

export async function invalidateStreamQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, STREAMS_QUERY_KEY),
    invalidateQuery(queryClient, STREAMS_BY_ADDON_QUERY_KEY),
  ]);
}

export async function invalidatePlaybackLanguageQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, STREAMS_QUERY_KEY),
  ]);
}

export async function invalidateDataStatsQuery(queryClient: QueryClient) {
  await invalidateQuery(queryClient, DATA_STATS_QUERY_KEY);
}

export async function invalidateStoredDataQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidatePlaybackHistoryQueries(queryClient),
    invalidateLibraryQueries(queryClient),
    invalidateListQueries(queryClient),
    invalidateWatchStatusQueries(queryClient),
    invalidateDataStatsQuery(queryClient),
  ]);
}
