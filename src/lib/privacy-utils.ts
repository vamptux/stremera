import type { QueryClient } from '@tanstack/react-query';

const INCognito_SENSITIVE_QUERY_KEYS = [
  ['watch-history'],
  ['watch-history-full'],
  ['watch-history-for-id'],
] as const;

export function clearIncognitoClientState(queryClient: QueryClient) {
  try {
    localStorage.removeItem('recent_searches');
  } catch {
    // localStorage can be unavailable in sandboxed/private contexts.
  }

  for (const queryKey of INCognito_SENSITIVE_QUERY_KEYS) {
    queryClient.removeQueries({ queryKey: [...queryKey] });
  }
}