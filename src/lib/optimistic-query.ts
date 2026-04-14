import type { QueryClient, QueryKey } from '@tanstack/react-query';

interface RunOptimisticQueryMutationOptions<TData, TVariables, TSaved extends TData = TData> {
  mutate: (variables: TVariables) => Promise<TSaved>;
  optimisticData: TData;
  queryClient: QueryClient;
  queryKey: QueryKey;
  variables: TVariables;
}

export async function runOptimisticQueryMutation<TData, TVariables, TSaved extends TData = TData>({
  mutate,
  optimisticData,
  queryClient,
  queryKey,
  variables,
}: RunOptimisticQueryMutationOptions<TData, TVariables, TSaved>): Promise<TSaved> {
  queryClient.setQueryData<TData>(queryKey, optimisticData);

  try {
    const savedValue = await mutate(variables);
    queryClient.setQueryData<TData>(queryKey, savedValue);
    return savedValue;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey });
    throw error;
  }
}
