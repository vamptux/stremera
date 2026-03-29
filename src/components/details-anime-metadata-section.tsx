import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AnimeMetadataPanel } from '@/components/anime-metadata-panel';

interface DetailsAnimeMetadataSectionProps {
  enabled: boolean;
  mediaId: string;
}

export function DetailsAnimeMetadataSection({
  enabled,
  mediaId,
}: DetailsAnimeMetadataSectionProps) {
  const {
    data: animeMetadata,
    error: animeMetadataError,
    isLoading: isLoadingAnimeMetadata,
    refetch: refetchAnimeMetadata,
  } = useQuery({
    queryKey: ['kitsu-anime-metadata', mediaId],
    queryFn: () => api.getKitsuAnimeMetadata(mediaId),
    enabled,
    staleTime: 1000 * 60 * 30,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return (
    <AnimeMetadataPanel
      errorMessage={animeMetadataError instanceof Error ? animeMetadataError.message : undefined}
      isLoading={isLoadingAnimeMetadata}
      metadata={animeMetadata}
      onRetry={() => {
        void refetchAnimeMetadata();
      }}
    />
  );
}
