import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Building2, Clapperboard, ExternalLink, Tv, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type AnimeSupplementalMetadata, api } from '@/lib/api';

interface AnimeMetadataSectionProps {
  enabled: boolean;
  mediaId: string;
}

interface AnimeMetadataPanelProps {
  errorMessage?: string;
  isLoading: boolean;
  metadata?: AnimeSupplementalMetadata;
  onRetry: () => void;
}

const CHARACTER_SKELETON_KEYS = [
  'anime-character-skeleton-1',
  'anime-character-skeleton-2',
  'anime-character-skeleton-3',
  'anime-character-skeleton-4',
  'anime-character-skeleton-5',
  'anime-character-skeleton-6',
  'anime-character-skeleton-7',
  'anime-character-skeleton-8',
] as const;
const STAFF_SKELETON_KEYS = [
  'anime-staff-skeleton-1',
  'anime-staff-skeleton-2',
  'anime-staff-skeleton-3',
] as const;
const PLATFORM_SKELETON_KEYS = [
  'anime-platform-skeleton-1',
  'anime-platform-skeleton-2',
  'anime-platform-skeleton-3',
  'anime-platform-skeleton-4',
] as const;

function CharactersSkeleton() {
  return (
    <div className='space-y-8'>
      <section className='space-y-4'>
        <Skeleton className='h-6 w-36 bg-white/10' />
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
          {CHARACTER_SKELETON_KEYS.map((skeletonKey) => (
            <div
              key={skeletonKey}
              className='flex gap-3 rounded-lg border border-white/[0.04] bg-white/[0.02] p-2'
            >
              <Skeleton className='h-9 w-9 shrink-0 rounded-full bg-white/10' />
              <div className='flex-1 space-y-2 py-1'>
                <Skeleton className='h-3.5 w-2/3 bg-white/10' />
                <Skeleton className='h-3 w-1/3 bg-white/10' />
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className='space-y-4'>
        <Skeleton className='h-6 w-28 bg-white/10' />
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {STAFF_SKELETON_KEYS.map((skeletonKey) => (
            <div
              key={skeletonKey}
              className='flex gap-3 rounded-lg border border-white/[0.04] bg-white/[0.02] p-2'
            >
              <Skeleton className='h-9 w-9 shrink-0 rounded-full bg-white/10' />
              <div className='flex-1 space-y-2 py-1'>
                <Skeleton className='h-3.5 w-40 bg-white/10' />
                <Skeleton className='h-3 w-24 bg-white/10' />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PlatformsSkeleton() {
  return (
    <div className='space-y-4'>
      <Skeleton className='h-6 w-44 bg-white/10' />
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        {PLATFORM_SKELETON_KEYS.map((skeletonKey) => (
          <div
            key={skeletonKey}
            className='flex items-center gap-4 rounded-lg border border-white/[0.04] bg-white/[0.02] p-3'
          >
            <Skeleton className='h-10 w-10 shrink-0 rounded-lg bg-white/10' />
            <div className='flex-1 min-w-0 space-y-2'>
              <Skeleton className='h-4 w-32 bg-white/10' />
              <div className='flex gap-2'>
                <Skeleton className='h-5 w-16 rounded-md bg-white/10' />
                <Skeleton className='h-5 w-16 rounded-md bg-white/10' />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarizeLanguages(languages: string[]): string | null {
  if (languages.length === 0) return null;
  if (languages.length <= 3) return languages.join(', ');
  return `${languages.slice(0, 3).join(', ')} +${languages.length - 3}`;
}

export function AnimeMetadataSection({ enabled, mediaId }: AnimeMetadataSectionProps) {
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

export function AnimeMetadataPanel({
  errorMessage,
  isLoading,
  metadata,
  onRetry,
}: AnimeMetadataPanelProps) {
  if (isLoading) {
    return (
      <div className='space-y-6'>
        <div className='rounded-lg border border-white/[0.06] bg-white/[0.02] p-2'>
          <div className='grid w-full grid-cols-2 gap-2'>
            <Skeleton className='h-9 rounded-lg bg-white/10' />
            <Skeleton className='h-9 rounded-lg bg-white/10' />
          </div>
        </div>
        <CharactersSkeleton />
        <PlatformsSkeleton />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className='rounded-2xl border border-red-500/20 bg-red-500/5 p-6 text-center'>
        <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-300'>
          <AlertCircle className='h-5 w-5' />
        </div>
        <h3 className='mt-4 text-lg font-semibold text-white'>Anime metadata unavailable</h3>
        <p className='mx-auto mt-2 max-w-2xl text-sm text-zinc-400'>{errorMessage}</p>
        <Button variant='outline' className='mt-5' onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const characters = metadata?.characters ?? [];
  const staff = metadata?.staff ?? [];
  const productions = metadata?.productions ?? [];
  const platforms = metadata?.platforms ?? [];
  const hasOverview = characters.length > 0 || staff.length > 0 || productions.length > 0;
  const hasPlatforms = platforms.length > 0;

  if (!hasOverview && !hasPlatforms) {
    return (
      <div className='rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center text-sm text-zinc-500'>
        No supplemental Kitsu metadata is available for this title yet.
      </div>
    );
  }

  return (
    <Tabs defaultValue={hasOverview ? 'overview' : 'platforms'} className='space-y-6'>
      {hasOverview && hasPlatforms && (
        <TabsList className='h-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-1'>
          <TabsTrigger
            value='overview'
            className='rounded-md px-4 py-1.5 text-xs font-semibold text-zinc-400 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm'
          >
            Cast, Staff & Studios
          </TabsTrigger>
          <TabsTrigger
            value='platforms'
            className='rounded-md px-4 py-1.5 text-xs font-semibold text-zinc-400 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm'
          >
            Platforms
          </TabsTrigger>
        </TabsList>
      )}

      {hasOverview && (
        <TabsContent value='overview' className='mt-0 space-y-8'>
          {characters.length > 0 && (
            <section className='space-y-4'>
              <div className='flex items-center gap-2.5'>
                <span className='flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400'>
                  <Users className='h-4 w-4' />
                </span>
                <h3 className='text-base font-semibold text-white'>Characters</h3>
                <span className='text-xs text-zinc-600 font-medium tabular-nums'>
                  {characters.length}
                </span>
              </div>

              <div className='grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
                {characters.map((character) => (
                  <article
                    key={`${character.name}-${character.role ?? 'unknown'}`}
                    className='group flex items-center gap-2.5 rounded-lg border border-white/[0.04] bg-white/[0.015] p-2 hover:bg-white/[0.03] transition-colors'
                  >
                    <div className='h-9 w-9 shrink-0 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/5'>
                      {character.image ? (
                        <img
                          src={character.image}
                          alt={character.name}
                          className='h-full w-full object-cover group-hover:scale-105 transition-transform duration-300'
                          loading='lazy'
                          decoding='async'
                        />
                      ) : (
                        <div className='flex h-full w-full items-center justify-center text-[11px] text-zinc-600 font-semibold'>
                          {character.name.charAt(0)}
                        </div>
                      )}
                    </div>
                    <div className='flex flex-1 flex-col justify-center min-w-0'>
                      <span className='text-[13px] font-medium text-zinc-100 truncate leading-snug'>
                        {character.name}
                      </span>
                      {character.role && (
                        <span className='text-[11px] text-zinc-500 truncate leading-snug mt-0.5'>
                          {character.role}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {productions.length > 0 && (
            <section className='space-y-4'>
              <div className='flex items-center gap-2.5'>
                <span className='flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400'>
                  <Building2 className='h-4 w-4' />
                </span>
                <h3 className='text-base font-semibold text-white'>Studios & Producers</h3>
                <span className='text-xs text-zinc-600 font-medium tabular-nums'>
                  {productions.length}
                </span>
              </div>

              <div className='grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3'>
                {productions.map((company) => (
                  <article
                    key={`${company.name}-${company.roles.join('|')}`}
                    className='group flex items-center gap-2.5 rounded-lg border border-white/[0.04] bg-white/[0.015] p-2 hover:bg-white/[0.03] transition-colors'
                  >
                    <div className='flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/5'>
                      {company.logo ? (
                        <img
                          src={company.logo}
                          alt={company.name}
                          className='h-full w-full object-contain p-1.5 group-hover:scale-105 transition-transform duration-300'
                          loading='lazy'
                          decoding='async'
                        />
                      ) : (
                        <div className='flex h-full w-full items-center justify-center text-[11px] text-zinc-600 font-semibold'>
                          {company.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className='min-w-0 flex-1'>
                      <span className='text-[13px] font-medium text-zinc-100 truncate leading-snug'>
                        {company.name}
                      </span>
                      {company.roles.length > 0 && (
                        <span
                          className='mt-0.5 block truncate text-[11px] leading-snug text-zinc-500'
                          title={company.roles.join(', ')}
                        >
                          {company.roles.join(', ')}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {staff.length > 0 && (
            <section className='space-y-4'>
              <div className='flex items-center gap-2.5'>
                <span className='flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400'>
                  <Clapperboard className='h-4 w-4' />
                </span>
                <h3 className='text-base font-semibold text-white'>Key Staff</h3>
                <span className='text-xs text-zinc-600 font-medium tabular-nums'>
                  {staff.length}
                </span>
              </div>

              <div className='grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3'>
                {staff.map((member) => (
                  <article
                    key={`${member.name}-${member.roles.join('|')}`}
                    className='group flex items-center gap-2.5 rounded-lg border border-white/[0.04] bg-white/[0.015] p-2 hover:bg-white/[0.03] transition-colors'
                  >
                    <div className='h-9 w-9 shrink-0 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/5'>
                      {member.image ? (
                        <img
                          src={member.image}
                          alt={member.name}
                          className='h-full w-full object-cover group-hover:scale-105 transition-transform duration-300'
                          loading='lazy'
                          decoding='async'
                        />
                      ) : (
                        <div className='flex h-full w-full items-center justify-center text-[11px] text-zinc-600 font-semibold'>
                          {member.name.charAt(0)}
                        </div>
                      )}
                    </div>
                    <div className='flex flex-1 flex-col justify-center min-w-0'>
                      <span className='text-[13px] font-medium text-zinc-100 truncate leading-snug'>
                        {member.name}
                      </span>
                      <span
                        className='text-[11px] text-zinc-500 truncate leading-snug mt-0.5'
                        title={member.roles.join(', ')}
                      >
                        {member.roles.join(', ')}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </TabsContent>
      )}

      {hasPlatforms && (
        <TabsContent value='platforms' className='mt-0'>
          <div className='space-y-4'>
            <div className='flex items-center gap-2.5'>
              <span className='flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400'>
                <Tv className='h-4 w-4' />
              </span>
              <h3 className='text-base font-semibold text-white'>Where to Watch</h3>
              <span className='text-xs text-zinc-600 font-medium tabular-nums'>
                {platforms.length}
              </span>
            </div>

            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3'>
              {platforms.map((platform) => {
                const subSummary = summarizeLanguages(platform.subLanguages);
                const dubSummary = summarizeLanguages(platform.dubLanguages);

                return (
                  <a
                    key={`${platform.name}-${platform.url}`}
                    href={platform.url}
                    target='_blank'
                    rel='noreferrer'
                    className='group flex items-center gap-3.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 transition-all duration-150 hover:bg-white/[0.05] hover:border-white/[0.12]'
                  >
                    <div className='flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800/80 ring-1 ring-white/[0.06]'>
                      {platform.logo ? (
                        <img
                          src={platform.logo}
                          alt={platform.name}
                          className='h-8 w-8 object-contain'
                          loading='lazy'
                          decoding='async'
                        />
                      ) : (
                        <Tv className='h-4 w-4 text-zinc-500' />
                      )}
                    </div>

                    <div className='min-w-0 flex-1'>
                      <div className='flex items-center gap-1.5'>
                        <span className='text-[13px] font-semibold text-zinc-100 truncate'>
                          {platform.name}
                        </span>
                        <ExternalLink className='h-3 w-3 shrink-0 text-zinc-600 group-hover:text-zinc-400 transition-colors' />
                      </div>

                      {(subSummary || dubSummary) && (
                        <div className='mt-1 flex flex-wrap gap-1'>
                          {subSummary && (
                            <span className='inline-flex items-center rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 leading-none'>
                              SUB · {subSummary}
                            </span>
                          )}
                          {dubSummary && (
                            <span className='inline-flex items-center rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300 leading-none'>
                              DUB · {dubSummary}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}
