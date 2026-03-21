import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Youtube, Check, Loader2, Star, ArrowLeft, ChevronDown, Search, X } from 'lucide-react';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { api, Episode, MediaItem, WatchProgress } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StreamSelector } from '@/components/stream-selector';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MediaCard } from '@/components/media-card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { usePrivacy } from '@/contexts/privacy-context';
import { useSpoilerProtection } from '@/hooks/use-spoiler-protection';
import { buildHistoryPlaybackPlan } from '@/lib/history-playback';

const EPISODES_PAGE_SIZE = 50;

function parseYearFromText(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFranchiseTokens(title: string): string[] {
  const stripped = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    // Strip common season/type markers
    .replace(/\b(season|part|cour|movie|ova|ona|special|specials|final|edition|arc|tv)\b/g, ' ')
    // Strip Roman numeral suffixes (II–X) so "Attack on Titan III" still matches "Attack on Titan"
    .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, ' ')
    // Strip trailing standalone digits 2–9 used as season numbers
    .replace(/\b([2-9])\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.split(' ').filter((token) => token.length >= 3);
}

function animeRelationScore(baseTokens: string[], relationTitle: string): number {
  if (baseTokens.length === 0) return 0;
  const relationTokens = new Set(normalizeFranchiseTokens(relationTitle));
  if (relationTokens.size === 0) return 0;
  let shared = 0;
  for (const token of baseTokens) {
    if (relationTokens.has(token)) shared += 1;
  }
  return shared / baseTokens.length;
}

// Maps lowercase Roman numeral suffixes (II–X) to season numbers.
// 'v' is intentionally excluded — it's too short and collision-prone (e.g. "Black Clover vs …").
const ROMAN_NUMERAL_SEASON: Readonly<Record<string, number>> = {
  ii: 2,
  iii: 3,
  iv: 4,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
} as const;

function extractSeasonNumberFromTitle(title: string): number | null {
  const normalized = title.toLowerCase().trim();

  // "Season N" with optional separator  (e.g. "Season 2", "Season: 3")
  const directSeason = normalized.match(/\bseason\s*[:\-\u2013]?\s*(\d{1,2})\b/);
  if (directSeason) {
    const parsed = Number(directSeason[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // "Nth Season"  (e.g. "2nd Season", "3rd Season")
  const ordinalSeason = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/);
  if (ordinalSeason) {
    const parsed = Number(ordinalSeason[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // "Part N"  (e.g. "Demon Slayer: Part 2", "Attack on Titan Final Part 3")
  const partNumber = normalized.match(/\bpart\s+(\d{1,2})\b/);
  if (partNumber) {
    const parsed = Number(partNumber[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // "Part Roman"  (e.g. "Part II", "Part III")
  const partRoman = normalized.match(/\bpart\s+(ii|iii|iv|vi|vii|viii|ix|x)\b/);
  if (partRoman) {
    const val = ROMAN_NUMERAL_SEASON[partRoman[1]];
    if (val) return val;
  }

  // Roman numeral suffix  (e.g. "Sword Art Online II", "Tokyo Ghoul:re III")
  // Must appear at the end or just before a subtitle separator to avoid false positives.
  const romanSuffix = normalized.match(/[\s:]+\s*(ii|iii|iv|vi|vii|viii|ix|x)\s*(?:[:\-\u2013]|$)/);
  if (romanSuffix) {
    const val = ROMAN_NUMERAL_SEASON[romanSuffix[1]];
    if (val) return val;
  }

  // Trailing lone digit 2–9  (e.g. "Re:Zero 2", "Overlord 4")
  // Only match if it is the very last token after a word boundary.
  const trailingDigit = normalized.match(/[\s:]([2-9])\s*$/);
  if (trailingDigit) {
    return Number(trailingDigit[1]);
  }

  return null;
}

// Returns season + optional part number for compound titles like "Season 3 Part 2".
function extractSeasonInfoFromTitle(title: string): { season: number; part?: number } | null {
  const normalized = title.toLowerCase().trim();

  // "Season N Part M"  (e.g. "Attack on Titan Season 3 Part 2")
  const seasonPart = normalized.match(/\bseason\s*[:\-\u2013]?\s*(\d{1,2})\s+part\s+(\d{1,2})\b/);
  if (seasonPart) {
    const season = Number(seasonPart[1]);
    const part = Number(seasonPart[2]);
    if (Number.isFinite(season) && season > 0 && Number.isFinite(part) && part > 0) {
      return { season, part };
    }
  }

  // "Season N Part Roman"  (e.g. "Season 3 Part II")
  const seasonPartRoman = normalized.match(
    /\bseason\s*[:\-\u2013]?\s*(\d{1,2})\s+part\s+(ii|iii|iv|vi|vii|viii|ix|x)\b/,
  );
  if (seasonPartRoman) {
    const season = Number(seasonPartRoman[1]);
    const part = ROMAN_NUMERAL_SEASON[seasonPartRoman[2]];
    if (Number.isFinite(season) && season > 0 && part) {
      return { season, part };
    }
  }

  // Fall back to single-number extraction (no part)
  const seasonNumber = extractSeasonNumberFromTitle(title);
  if (seasonNumber !== null) return { season: seasonNumber };

  return null;
}

interface RelatedSeasonCandidate {
  id: string;
  title: string;
  seasonNumber: number;
  part?: number;
  year: number | null;
  similarity: number;
  routeType: string;
  /** Unique key: `"${seasonNumber}-${part ?? 0}"` */
  itemKey: string;
}

function isLikelyStandaloneAnimeEntry(title: string): boolean {
  const normalized = title.toLowerCase();
  return (
    /\b(movie|film|ova|ona|special|specials|recap|compilation|prologue|epilogue|theatrical|uncut)\b/.test(normalized) ||
    /spin[\s-]?off/i.test(title)
  );
}

// Wrapper component to remount Details on id change
export function Details() {
  const { type, id } = useParams<{ type: string; id: string }>();
  // Scroll to top on mount
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [type, id]);

  return (
    <div className='min-h-screen bg-background selection:bg-white/20'>
      <DetailsContent key={`${type}-${id}`} />
    </div>
  );
}

function DetailsContent() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const baseRouteType = type || 'series';
  const baseRouteId = id || '';
  const baseRouteKey = `${baseRouteType}:${baseRouteId}`;
  const [inlineTarget, setInlineTarget] = useState<{
    type: string;
    id: string;
    originKey: string;
    originTitle: string;
  } | null>(null);
  const scopedInlineTarget = inlineTarget?.originKey === baseRouteKey ? inlineTarget : null;
  const effectiveRouteType = scopedInlineTarget?.type || baseRouteType;
  const effectiveRouteId = scopedInlineTarget?.id || baseRouteId;
  const isKitsuRoute = !!effectiveRouteId.startsWith('kitsu:');
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isIncognito } = usePrivacy();
  const { spoilerProtection } = useSpoilerProtection();

  const {
    data: item,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['details', effectiveRouteType, effectiveRouteId],
    queryFn: () =>
      api.getMediaDetails(effectiveRouteType, effectiveRouteId, {
        includeEpisodes: !(isKitsuRoute && effectiveRouteType === 'anime'),
      }),
    enabled: !!effectiveRouteType && !!effectiveRouteId,
    staleTime: 1000 * 60 * 30, // 30 minutes stale time for details
  });

  // Watch history (used for resume + episode progress)
  const { data: watchHistory } = useQuery({
    queryKey: ['watch-history'],
    queryFn: api.getWatchHistory,
    enabled: !isIncognito,
    staleTime: 1000 * 60 * 3,
  });

  const { data: watchHistoryForItem, isLoading: isLoadingWatchHistoryForItem } = useQuery({
    queryKey: ['watch-history-for-id', item?.id],
    queryFn: () => (item?.id ? api.getWatchHistoryForId(item.id) : Promise.resolve([])),
    enabled: !isIncognito && item?.type === 'series' && !!item?.id,
    staleTime: 1000 * 60 * 3,
  });

  const episodeProgressMap = useMemo(() => {
    const map = new Map<string, WatchProgress>();
    watchHistoryForItem?.forEach((entry) => {
      if (entry.type_ !== 'series') return;
      if (entry.season === undefined || entry.episode === undefined) return;
      map.set(`${entry.id}:${entry.season}:${entry.episode}`, entry);
    });
    return map;
  }, [watchHistoryForItem]);

  // Library State
  const { data: library } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
    staleTime: 1000 * 60 * 5,
  });

  const isInLibrary = useMemo(() => library?.some((l) => l.id === item?.id), [library, item]);

  const toggleLibrary = useMutation({
    mutationFn: async () => {
      if (!item) return;
      if (isInLibrary) {
        await api.removeFromLibrary(item.id);
        return 'removed';
      } else {
        await api.addToLibrary(item);
        return 'added';
      }
    },
    onSuccess: (action) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      toast.success(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        description: item?.title,
      });
    },
    onError: () => {
      toast.error('Failed to update library');
    },
  });

  const locationSeason = location.state?.season ? Number(location.state.season) : null;
  const [userSelectedSeason, setUserSelectedSeason] = useState<number | null>(null);
  // Controlled by the episode search input; reset when season changes.
  const [episodeSearch, setEpisodeSearch] = useState('');

  const shouldUsePagedEpisodes = !!(item?.id?.startsWith('kitsu:') && item?.type === 'series');

  // Trailer State
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);

  const [episodePagination, setEpisodePagination] = useState<
    Record<string, { count: number; pageIndex: number }>
  >({});
  // Snapshot of base-item seasons kept while an inline (related) entry is active
  const [baseSeasonsSnapshot, setBaseSeasonsSnapshot] = useState<number[]>([]);
  // itemKey of the related-season candidate currently viewed inline (null = base item)
  const [activeRelatedCandidateKey, setActiveRelatedCandidateKey] = useState<string | null>(null);
  // Stable label for the active related candidate — persists even after relatedSeasonCandidates recomputes
  const [activeCandidateLabel, setActiveCandidateLabel] = useState<string>('');
  const resumeSeasonFromHistory = watchHistory?.find(
    (w) => w.id === item?.id && w.type_ === 'series',
  )?.season;
  const normalizedLocationSeason =
    locationSeason !== null && Number.isFinite(locationSeason) ? locationSeason : null;
  const selectedSeasonHint =
    userSelectedSeason ?? normalizedLocationSeason ?? (typeof resumeSeasonFromHistory === 'number' ? resumeSeasonFromHistory : null);

  const currentEpisodeSeasonKey = `${item?.id || 'unknown'}:${selectedSeasonHint ?? 'none'}`;
  const seasonPagination = episodePagination[currentEpisodeSeasonKey];
  const requestEpisodePageIndex = shouldUsePagedEpisodes ? (seasonPagination?.pageIndex ?? 0) : 0;
  const requestSeasonHint = selectedSeasonHint ?? undefined;

  const { data: pagedEpisodesData } = useQuery({
    queryKey: ['media-episodes', type, item?.id, requestSeasonHint, requestEpisodePageIndex, EPISODES_PAGE_SIZE],
    queryFn: () =>
      api.getMediaEpisodes(
        type || 'anime',
        item!.id,
        requestSeasonHint,
        requestEpisodePageIndex,
        EPISODES_PAGE_SIZE,
      ),
    enabled: shouldUsePagedEpisodes && !!item?.id,
    staleTime: 1000 * 60 * 5,
  });

  const seasons = useMemo(() => {
    if (shouldUsePagedEpisodes) {
      return (pagedEpisodesData?.seasons ?? []).slice().sort((a, b) => a - b);
    }
    if (!item?.episodes) return [];
    return Array.from(new Set(item.episodes.map((e) => e.season))).sort((a, b) => a - b);
  }, [item, pagedEpisodesData?.seasons, shouldUsePagedEpisodes]);

  const selectedSeason = useMemo(() => {
    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) return selectedSeasonHint;
    if (seasons.length === 0) return null;
    return seasons.includes(1) ? 1 : seasons[0];
  }, [selectedSeasonHint, seasons]);

  useEffect(() => {
    if (!shouldUsePagedEpisodes) return;
    if (seasons.length === 0) return;

    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) return;

    const nextSeason = seasons.includes(1) ? 1 : seasons[0];
    const timer = window.setTimeout(() => {
      setUserSelectedSeason(nextSeason);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [shouldUsePagedEpisodes, selectedSeasonHint, seasons]);

  // Keep a snapshot of the base item's seasons so the dropdown can show them
  // even while a related (inline) entry has been loaded.
  useEffect(() => {
    if (scopedInlineTarget) return;
    if (seasons.length === 0) return;
    const timer = window.setTimeout(() => {
      setBaseSeasonsSnapshot((prev) => {
        if (prev.length === seasons.length && prev.every((s, i) => s === seasons[i])) return prev;
        return seasons;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [seasons, scopedInlineTarget]);

  const seasonYearLabelMap = useMemo(() => {
    const map = new Map<number, string>();

    Object.entries(pagedEpisodesData?.seasonYears ?? {}).forEach(([seasonKey, label]) => {
      const seasonNumber = Number(seasonKey);
      if (Number.isFinite(seasonNumber) && typeof label === 'string' && label.trim().length > 0) {
        map.set(seasonNumber, label.trim());
      }
    });

    const episodesForYearInference = shouldUsePagedEpisodes
      ? (pagedEpisodesData?.episodes ?? [])
      : (item?.episodes ?? []);

    const yearsBySeason = new Map<number, Set<number>>();
    episodesForYearInference.forEach((ep) => {
      const year = parseYearFromText(ep.released);
      if (!year) return;
      const existing = yearsBySeason.get(ep.season) ?? new Set<number>();
      existing.add(year);
      yearsBySeason.set(ep.season, existing);
    });

    yearsBySeason.forEach((years, seasonNumber) => {
      if (map.has(seasonNumber) || years.size === 0) return;
      const sorted = Array.from(years).sort((a, b) => a - b);
      const label =
        sorted.length > 1 && sorted[0] !== sorted[sorted.length - 1]
          ? `${sorted[0]}-${sorted[sorted.length - 1]}`
          : `${sorted[0]}`;
      map.set(seasonNumber, label);
    });

    return map;
  }, [pagedEpisodesData?.seasonYears, pagedEpisodesData?.episodes, shouldUsePagedEpisodes, item?.episodes]);

  const isAnimeLike = !!(isKitsuRoute || effectiveRouteType === 'anime' || item?.id?.startsWith('kitsu:'));
  const [activeTab, setActiveTab] = useState<'episodes' | 'relations'>('episodes');

  const formatSeasonLabel = useCallback(
    (seasonNumber: number) => {
      const yearLabel = seasonYearLabelMap.get(seasonNumber);
      if (!yearLabel) return `Season ${seasonNumber}`;
      return `Season ${seasonNumber} • ${yearLabel}`;
    },
    [seasonYearLabelMap],
  );

  const handleInlineDetailsSwitch = useCallback(
    (
      nextType: string,
      nextId: string,
      preferredSeason?: number | null,
      candidateItemKey?: string,
      candidateLabel?: string,
    ) => {
      const normalizedType = nextType.trim();
      const normalizedId = nextId.trim();
      if (!normalizedType || !normalizedId) return;

      if (normalizedType === effectiveRouteType && normalizedId === effectiveRouteId) {
        setActiveTab('episodes');
        if (typeof preferredSeason === 'number' && Number.isFinite(preferredSeason) && preferredSeason > 0) {
          setUserSelectedSeason(preferredSeason);
        }
        return;
      }

      setInlineTarget({
        type: normalizedType,
        id: normalizedId,
        originKey: baseRouteKey,
        originTitle: item?.title || baseRouteId,
      });
      setActiveRelatedCandidateKey(candidateItemKey ?? null);
      setActiveCandidateLabel(candidateLabel ?? '');
      setActiveTab('episodes');
      setEpisodePagination({});
      setEpisodeSearch('');
      if (typeof preferredSeason === 'number' && Number.isFinite(preferredSeason) && preferredSeason > 0) {
        setUserSelectedSeason(preferredSeason);
      } else {
        setUserSelectedSeason(null);
      }
    },
    [effectiveRouteId, effectiveRouteType, baseRouteKey, baseRouteId, item?.title],
  );

  const intelligentRelations = useMemo(() => {
    const relations = item?.relations ?? [];
    if (relations.length === 0) return [];

    const deduped = new Map<string, MediaItem>();
    relations.forEach((relation) => {
      if (!relation?.id) return;
      if (!deduped.has(relation.id)) deduped.set(relation.id, relation);
    });

    const relationItems = Array.from(deduped.values());
    if (!item) return relationItems;

    const baseTokens = normalizeFranchiseTokens(item.title || '');

    const scored = relationItems.map((relation) => {
      const score = isAnimeLike ? animeRelationScore(baseTokens, relation.title || '') : 1;
      return {
        relation,
        score,
        year: parseYearFromText(relation.year),
      };
    });

    const strictAnimeMatches = isAnimeLike
      ? scored.filter((entry) => entry.score >= 0.34)
      : scored;
    const effective = strictAnimeMatches.length > 0 ? strictAnimeMatches : scored;

    effective.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.year !== null && b.year !== null && a.year !== b.year) return a.year - b.year;
      if (a.year === null && b.year !== null) return 1;
      if (a.year !== null && b.year === null) return -1;
      return a.relation.title.localeCompare(b.relation.title);
    });

    return effective.map((entry) => entry.relation);
  }, [item, isAnimeLike]);

  const relatedSeasonCandidates = useMemo((): RelatedSeasonCandidate[] => {
    if (!item || !isAnimeLike || intelligentRelations.length === 0) return [];

    const baseTokens = normalizeFranchiseTokens(item.title || '');
    const existingSeasons = new Set(seasons);

    const candidates = intelligentRelations
      .map((relation): RelatedSeasonCandidate | null => {
        const seasonInfo = extractSeasonInfoFromTitle(relation.title || '');
        if (!seasonInfo) return null;
        const { season: seasonNumber, part } = seasonInfo;

        // Skip only when the season matches a local season AND there is no part suffix
        // ("Season 3 Part 1" and "Season 3 Part 2" must both be kept even when season 3 exists).
        if (!part && existingSeasons.has(seasonNumber)) return null;

        const similarity = animeRelationScore(baseTokens, relation.title || '');
        if (similarity < 0.45) return null;
        if (isLikelyStandaloneAnimeEntry(relation.title || '')) return null;

        return {
          id: relation.id,
          title: relation.title,
          seasonNumber,
          part,
          year: parseYearFromText(relation.year),
          similarity,
          routeType: relation.id.startsWith('kitsu:') ? 'anime' : relation.type,
          itemKey: `${seasonNumber}-${part ?? 0}`,
        };
      })
      .filter((entry): entry is RelatedSeasonCandidate => entry !== null);

    const dedupedBySeason = new Map<string, RelatedSeasonCandidate>();
    for (const candidate of candidates) {
      const existing = dedupedBySeason.get(candidate.itemKey);
      if (!existing || candidate.similarity > existing.similarity) {
        dedupedBySeason.set(candidate.itemKey, candidate);
      }
    }

    return Array.from(dedupedBySeason.values()).sort((a, b) => {
      if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
      if ((a.part ?? 0) !== (b.part ?? 0)) return (a.part ?? 0) - (b.part ?? 0);
      if (a.year !== null && b.year !== null && a.year !== b.year) return a.year - b.year;
      if (a.year === null && b.year !== null) return 1;
      if (a.year !== null && b.year === null) return -1;
      return a.title.localeCompare(b.title);
    });
  }, [item, isAnimeLike, intelligentRelations, seasons]);

  const hasEpisodesTab =
    item?.type === 'series' &&
    (shouldUsePagedEpisodes || !!item?.episodes?.length || seasons.length > 0);
  const hasRelationsTab = intelligentRelations.length > 0;
  const resolvedActiveTab: 'episodes' | 'relations' =
    activeTab === 'episodes' && !hasEpisodesTab && hasRelationsTab ? 'relations' : activeTab;

  const filteredEpisodes = useMemo(() => {
    if (selectedSeason === null) return [];
    if (shouldUsePagedEpisodes) {
      return (pagedEpisodesData?.episodes ?? []).slice().sort((a, b) => a.episode - b.episode);
    }
    if (!item?.episodes) return [];
    return item.episodes
      .filter((e) => e.season === selectedSeason)
      .sort((a, b) => a.episode - b.episode);
  }, [item, pagedEpisodesData?.episodes, selectedSeason, shouldUsePagedEpisodes]);

  // Search-filtered episodes — subset of filteredEpisodes matching the episode search query.
  const searchFilteredEpisodes = useMemo(() => {
    if (!episodeSearch.trim()) return filteredEpisodes;
    const q = episodeSearch.toLowerCase().trim();
    return filteredEpisodes.filter((ep) => {
      if (String(ep.episode).includes(q)) return true;
      if (ep.title?.toLowerCase().includes(q)) return true;
      if (ep.overview?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [filteredEpisodes, episodeSearch]);

  const resumeEpisodeRef = useRef<HTMLButtonElement | null>(null);

  const resumeEpisodeForSelectedSeason = useMemo(() => {
    if (!watchHistory || !item || item.type !== 'series' || selectedSeason === null) return null;
    const entry = watchHistory.find((w) => w.id === item.id && w.type_ === 'series');
    if (!entry || entry.season !== selectedSeason || entry.episode === undefined) return null;
    return entry.episode;
  }, [watchHistory, item, selectedSeason]);
  const resumeEpisodeIndexForDefaults = useMemo(() => {
    if (resumeEpisodeForSelectedSeason === null) return -1;
    return filteredEpisodes.findIndex((ep) => ep.episode === resumeEpisodeForSelectedSeason);
  }, [filteredEpisodes, resumeEpisodeForSelectedSeason]);
  const totalEpisodesForSeason = shouldUsePagedEpisodes
    ? (pagedEpisodesData?.totalInSeason ?? 0)
    : filteredEpisodes.length;
  const shouldUseLongSeasonPaging = totalEpisodesForSeason > 100;
  const totalEpisodePages = Math.max(1, Math.ceil(totalEpisodesForSeason / EPISODES_PAGE_SIZE));
  const defaultEpisodePageIndex =
    !shouldUsePagedEpisodes && shouldUseLongSeasonPaging && resumeEpisodeIndexForDefaults >= 0
      ? Math.floor(resumeEpisodeIndexForDefaults / EPISODES_PAGE_SIZE)
      : 0;
  const defaultEpisodeVisibleCount =
    !shouldUseLongSeasonPaging && resumeEpisodeIndexForDefaults >= 0
      ? Math.max(EPISODES_PAGE_SIZE, resumeEpisodeIndexForDefaults + 1)
      : EPISODES_PAGE_SIZE;
  const activeEpisodePageIndex =
    shouldUseLongSeasonPaging
      ? Math.min(seasonPagination?.pageIndex ?? defaultEpisodePageIndex, totalEpisodePages - 1)
      : 0;

  const episodeVisibleCount = shouldUseLongSeasonPaging
    ? EPISODES_PAGE_SIZE
    : seasonPagination?.count ?? defaultEpisodeVisibleCount;

  const visibleEpisodes = useMemo(
    () => {
      // When a search query is active, show all matching episodes without pagination.
      if (episodeSearch.trim()) return searchFilteredEpisodes;
      if (shouldUsePagedEpisodes) return filteredEpisodes;
      if (shouldUseLongSeasonPaging) {
        const start = activeEpisodePageIndex * EPISODES_PAGE_SIZE;
        return filteredEpisodes.slice(start, start + EPISODES_PAGE_SIZE);
      }
      return filteredEpisodes.slice(0, episodeVisibleCount);
    },
    [
      filteredEpisodes,
      searchFilteredEpisodes,
      episodeSearch,
      episodeVisibleCount,
      shouldUseLongSeasonPaging,
      activeEpisodePageIndex,
      shouldUsePagedEpisodes,
    ],
  );

  const hasMoreEpisodes =
    !episodeSearch.trim() &&
    !shouldUsePagedEpisodes && !shouldUseLongSeasonPaging && visibleEpisodes.length < filteredEpisodes.length;
  const remainingEpisodes = Math.max(0, totalEpisodesForSeason - visibleEpisodes.length);
  const visibleEpisodeStart =
    totalEpisodesForSeason === 0
      ? 0
      : shouldUseLongSeasonPaging
        ? activeEpisodePageIndex * EPISODES_PAGE_SIZE + 1
        : 1;
  const visibleEpisodeEnd = shouldUseLongSeasonPaging
    ? Math.min((activeEpisodePageIndex + 1) * EPISODES_PAGE_SIZE, totalEpisodesForSeason)
    : visibleEpisodes.length;
  const shouldShowEpisodeProgressSkeleton =
    item?.type === 'series' && !isIncognito && isLoadingWatchHistoryForItem;

  // Stream Selector State
  const [streamSelectorOpen, setStreamSelectorOpen] = useState(false);
  const [streamParams, setStreamParams] = useState<{
    id: string;
    streamId: string;
    season?: number;
    episode?: number;
    absoluteSeason?: number;
    absoluteEpisode?: number;
    aniskipEpisode?: number;
    startTime?: number;
    title: string;
    overview?: string;
  } | null>(null);

  const preferredStreamId = useMemo(() => {
    if (!item) return undefined;
    // Stream providers (Torrentio) key primarily on IMDb IDs; fall back to source ID.
    return item.imdbId || item.id;
  }, [item]);
  const [reopenSelectorConsumed, setReopenSelectorConsumed] = useState(false);

  // For Kitsu anime, episodes have imdbSeason/imdbEpisode that map to IMDB's
  // season/episode numbering. Torrentio uses IMDB-based IDs (tt:season:episode),
  // so we must translate Kitsu episodes to IMDB coordinates for stream lookups.
  const isKitsuAnime = !!(item?.id?.startsWith('kitsu:'));
  const streamSelectorType: 'movie' | 'series' | 'anime' =
    item?.type === 'movie'
      ? 'movie'
      : (isKitsuAnime || effectiveRouteType === 'anime' ? 'anime' : 'series');

  // Spoiler protection: determine the furthest watched episode in the selected season.
  // Episodes beyond that point will have thumbnails blurred and descriptions hidden.
  const maxWatchedEpisodeInSeason = useMemo(() => {
    if (!spoilerProtection || selectedSeason === null || !item) return null;
    let max: number | null = null;

    for (const ep of filteredEpisodes) {
      const prog = episodeProgressMap.get(`${item.id}:${ep.season}:${ep.episode}`);
      if (prog && prog.duration > 0 && prog.position / prog.duration > 0.05) {
        if (max === null || ep.episode > max) max = ep.episode;
      }
    }

    // Fallback to series-level progress entry when episode-scoped rows are sparse.
    const seriesResumeEpisode = watchHistory?.find(
      (w) => w.id === item.id && w.type_ === 'series' && w.season === selectedSeason,
    )?.episode;
    if (typeof seriesResumeEpisode === 'number') {
      if (max === null || seriesResumeEpisode > max) {
        max = seriesResumeEpisode;
      }
    }

    return max;
  }, [
    spoilerProtection,
    selectedSeason,
    item,
    filteredEpisodes,
    episodeProgressMap,
    watchHistory,
  ]);

  const isEpisodeSpoiler = useCallback(
    (ep: Episode): boolean => {
      if (!spoilerProtection || maxWatchedEpisodeInSeason === null || !item) return false;
      const prog = episodeProgressMap.get(`${item.id}:${ep.season}:${ep.episode}`);
      // Episodes the user has started watching are never considered spoilers
      if (prog && prog.duration > 0 && prog.position / prog.duration > 0.05) return false;
      return ep.episode > maxWatchedEpisodeInSeason;
    },
    [spoilerProtection, maxWatchedEpisodeInSeason, episodeProgressMap, item],
  );

  const handleWatchMovie = () => {
    if (!item || !preferredStreamId) return;
    setStreamParams({
      id: item.id,
      streamId: preferredStreamId,
      title: item.title,
      overview: item.description,
    });
    setStreamSelectorOpen(true);
  };

  const handleWatchEpisode = (ep: Episode) => {
    if (!item || !preferredStreamId) return;
    // For Kitsu anime with IMDB mapping, use the IMDB season/episode for stream lookup
    // so that Torrentio can find the correct streams (e.g. One Piece S21E5 instead of S1E1000)
    const streamSeason = (isKitsuAnime && ep.imdbSeason) ? ep.imdbSeason : ep.season;
    const streamEpisode = (isKitsuAnime && ep.imdbEpisode) ? ep.imdbEpisode : ep.episode;
    // When IMDB mapping exists, also use the IMDB ID for the stream lookup
    const effectiveStreamId = (isKitsuAnime && ep.imdbId) ? ep.imdbId : preferredStreamId;

    setStreamParams({
      id: item.id,
      streamId: effectiveStreamId,
      season: streamSeason,
      episode: streamEpisode,
      absoluteSeason: ep.season,
      absoluteEpisode: ep.episode,
      aniskipEpisode: ep.imdbEpisode || ep.episode,
      title: `${item.title} S${ep.season}E${ep.episode}`,
      overview: ep.overview || item.description,
    });
    setStreamSelectorOpen(true);
  };

  const handleBack = () => {
    const from = location.state?.from;
    if (
      typeof from === 'string' &&
      from.length > 0 &&
      from.startsWith('/') &&
      !from.startsWith('/player')
    ) {
      navigate(from, { replace: true });
      return;
    }
    navigate('/', { replace: true });
  };

  const autoReopenStreamParams = useMemo(() => {
    if (reopenSelectorConsumed || !item || !preferredStreamId || streamParams) return null;

    const navState = location.state as
      | {
          reopenStreamSelector?: boolean;
          reopenStreamSeason?: number;
          reopenStreamEpisode?: number;
          reopenStartTime?: number;
        }
      | undefined;

    if (!navState?.reopenStreamSelector) return null;

    const startTime =
      typeof navState.reopenStartTime === 'number' && navState.reopenStartTime > 0
        ? navState.reopenStartTime
        : undefined;

    if (item.type === 'movie') {
      return {
        id: item.id,
        streamId: preferredStreamId,
        title: item.title,
        overview: item.description,
        startTime,
      };
    }

    const reopenSeason =
      typeof navState.reopenStreamSeason === 'number' ? navState.reopenStreamSeason : undefined;
    const reopenEpisode =
      typeof navState.reopenStreamEpisode === 'number' ? navState.reopenStreamEpisode : undefined;

    const targetEpisode =
      reopenSeason !== undefined && reopenEpisode !== undefined
        ? item.episodes?.find((ep) => ep.season === reopenSeason && ep.episode === reopenEpisode)
        : undefined;

    const streamSeason = isKitsuAnime && targetEpisode?.imdbSeason ? targetEpisode.imdbSeason : reopenSeason;
    const streamEpisode =
      isKitsuAnime && targetEpisode?.imdbEpisode ? targetEpisode.imdbEpisode : reopenEpisode;
    const effectiveStreamId =
      isKitsuAnime && targetEpisode?.imdbId ? targetEpisode.imdbId : preferredStreamId;
    const aniskipEpisode =
      isKitsuAnime && targetEpisode?.imdbEpisode ? targetEpisode.imdbEpisode : reopenEpisode;

    return {
      id: item.id,
      streamId: effectiveStreamId,
      season: streamSeason,
      episode: streamEpisode,
      absoluteSeason: targetEpisode?.season ?? reopenSeason,
      absoluteEpisode: targetEpisode?.episode,
      aniskipEpisode,
      title:
        reopenSeason !== undefined && reopenEpisode !== undefined
          ? `${item.title} S${reopenSeason}E${reopenEpisode}`
          : item.title,
      overview: targetEpisode?.overview || item.description,
      startTime,
    };
  }, [
    reopenSelectorConsumed,
    item,
    preferredStreamId,
    streamParams,
    location.state,
    isKitsuAnime,
  ]);

  const effectiveStreamParams = streamParams || autoReopenStreamParams;
  const effectiveStreamSelectorOpen = streamSelectorOpen || !!autoReopenStreamParams;

  const progress = useMemo(() => {
    if (!watchHistory || !item) return null;
    if (item.type === 'movie') {
      return watchHistory.find((w) => w.id === item.id && w.type_ === 'movie') ?? null;
    }
    return null;
  }, [watchHistory, item]);

  const seriesProgress = useMemo(() => {
    if (!watchHistory || !item || item.type !== 'series') return null;
    return watchHistory.find((w) => w.id === item.id && w.type_ === 'series') ?? null;
  }, [watchHistory, item]);

  const formatTime = (seconds?: number) => {
    if (!seconds || Number.isNaN(seconds)) return null;
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const getResumeInfo = useCallback((entry: WatchProgress | null) => {
    if (!entry || entry.duration <= 0) {
      return { canResume: false, startTime: undefined as number | undefined };
    }
    const percent = entry.position / entry.duration;
    const canResume = percent > 0.05 && percent < 0.95 && entry.position > 10;
    return { canResume, startTime: canResume ? entry.position : undefined };
  }, []);

  const movieResume = getResumeInfo(progress);
  const seriesResume = getResumeInfo(seriesProgress);
  const resumeEpisodeCoords = useMemo(() => {
    if (!seriesProgress || !seriesResume.canResume) return null;
    if (seriesProgress.season === undefined || seriesProgress.episode === undefined) return null;
    return { season: seriesProgress.season, episode: seriesProgress.episode };
  }, [seriesProgress, seriesResume.canResume]);
  const canResumeInSelectedSeason =
    item?.type === 'series' &&
    !!seriesProgress &&
    seriesResume.canResume &&
    seriesProgress.season !== undefined &&
    (selectedSeason === null || seriesProgress.season === selectedSeason);

  // Determine button text
  const playButtonText = useMemo(() => {
    if (item?.type === 'series') return canResumeInSelectedSeason ? 'Continue' : 'Start Watching';
    if (!progress) return 'Play';
    const percent = progress.duration > 0 ? progress.position / progress.duration : 0;
    if (percent > 0.05 && percent < 0.95) return 'Continue';
    return 'Play';
  }, [item, progress, canResumeInSelectedSeason]);

  const formatEpisodeDuration = (seconds?: number) => {
    if (!seconds || Number.isNaN(seconds)) return null;
    const minutes = Math.round(seconds / 60);
    if (minutes <= 0) return null;
    return `${minutes}m`;
  };

  const handleRetryDetails = () => {
    if (!effectiveRouteType || !effectiveRouteId) return;
    queryClient.invalidateQueries({ queryKey: ['details', effectiveRouteType, effectiveRouteId] });
  };

  useEffect(() => {
    if (!resumeEpisodeCoords) return;
    if (selectedSeason !== resumeEpisodeCoords.season) return;
    if (!visibleEpisodes.some((ep) => ep.episode === resumeEpisodeCoords.episode)) return;

    const timer = window.setTimeout(() => {
      resumeEpisodeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [visibleEpisodes, resumeEpisodeCoords, selectedSeason, resumeEpisodeRef]);

  if (isLoading) return <DetailsSkeleton />;

  if (error) {
    return (
      <div className='min-h-screen bg-background flex flex-col items-center justify-center text-destructive gap-4'>
        <p className='text-xl font-bold'>Error loading details</p>
        <Button variant='outline' onClick={handleRetryDetails}>
          Retry
        </Button>
      </div>
    );
  }

  if (!item) return null;

  const backdropUrl = item.backdrop || item.poster;
  const from = `${location.pathname}${location.search}`;

  const handlePrimaryAction = async () => {
    if (!item) return;

    if (item.type === 'movie') {
      if (progress && movieResume.canResume) {
        try {
          const plan = await buildHistoryPlaybackPlan(progress, from);
          navigate(plan.target, { state: plan.state });
        } catch (err) {
          toast.error('Failed to continue movie', {
            description: err instanceof Error ? err.message : 'Please try again.',
          });
        }
        return;
      }
      handleWatchMovie();
      return;
    }

    // Series
    if (
      seriesProgress &&
      canResumeInSelectedSeason &&
      seriesProgress.season !== undefined &&
      seriesProgress.episode !== undefined
    ) {
      try {
        const plan = await buildHistoryPlaybackPlan(seriesProgress, from);
        if (plan.kind === 'details') {
          toast.info('Episode context missing', {
            description: 'Select an episode below to continue watching.',
          });
          document.getElementById('episodes-section')?.scrollIntoView({ behavior: 'smooth' });
          return;
        }

        navigate(plan.target, { state: plan.state });
      } catch (err) {
        toast.error('Failed to continue series', {
          description: err instanceof Error ? err.message : 'Please try again.',
        });
      }
      return;
    }

    document.getElementById('episodes-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className='relative pb-20'>
      {/* Back Button */}
      <motion.div
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.4, duration: 0.3 }}
        className='fixed top-5 left-4 md:left-[80px] z-50'
      >
        <Button
          variant='ghost'
          onClick={handleBack}
          className='h-9 px-3 gap-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 hover:text-white backdrop-blur-sm border border-white/5 hover:border-white/15 text-sm font-medium transition-colors shadow-sm'
        >
          <ArrowLeft className='h-4 w-4' />
          Back
        </Button>
      </motion.div>

      {/* Hero Section - Compact */}
      <div className='relative h-[65vh] w-full overflow-hidden'>
        {/* Backdrop */}
        {backdropUrl && (
          <motion.div
            initial={{ scale: 1.1, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className='absolute inset-0'
          >
            <div className='absolute inset-0 bg-black/20 z-10' />
            <div className='absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent z-10' />
            <div className='absolute inset-0 bg-gradient-to-r from-background via-background/40 to-transparent z-10' />
            <img
              src={backdropUrl}
              alt='Backdrop'
              className='w-full h-full object-cover'
              loading='eager'
              decoding='async'
            />
          </motion.div>
        )}

        {/* Content */}
        <div className='absolute inset-0 z-20 container flex flex-col justify-end pb-8'>
          <div className='flex flex-col md:flex-row gap-6 md:gap-8 items-end'>
            {/* Poster (Hidden on mobile, smaller on desktop) */}
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.6 }}
              className='shrink-0 w-48 aspect-[2/3] rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 hidden md:block bg-zinc-900'
            >
              {item.poster ? (
                <img
                  src={item.poster}
                  alt={item.title}
                  className='w-full h-full object-cover'
                  loading='eager'
                  decoding='async'
                />
              ) : (
                <div className='w-full h-full flex items-center justify-center text-white/20'>
                  No Poster
                </div>
              )}
            </motion.div>

            {/* Info */}
            <div className='flex-1 space-y-4 w-full'>
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.3, duration: 0.6 }}
              >
                {item.logo ? (
                  <img
                    src={item.logo}
                    alt={item.title}
                    className='h-24 md:h-32 object-contain origin-left mb-4 drop-shadow-2xl'
                  />
                ) : (
                  <h1 className='text-4xl md:text-6xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-white to-white/60 mb-2 leading-none drop-shadow-2xl'>
                    {item.title}
                  </h1>
                )}

                {/* Metadata Row */}
                <div className='flex flex-wrap items-center gap-3 text-xs md:text-sm font-medium text-white/90'>
                  {item.rating && (
                    <div className='flex items-center gap-1.5 text-amber-400'>
                      <Star className='w-3.5 h-3.5 fill-current' />
                      <span>{item.rating}</span>
                    </div>
                  )}
                  <div className='w-1 h-1 rounded-full bg-white/30' />
                  <span>{item.year?.split('-')[0] || 'Unknown'}</span>
                  <div className='w-1 h-1 rounded-full bg-white/30' />
                  <span>
                    {item.type === 'series'
                      ? filteredEpisodes.length > 0
                        ? `${filteredEpisodes.length} Eps`
                        : 'TV Series'
                      : 'Movie'}
                  </span>

                  {/* Genres */}
                  <div className='flex items-center gap-1.5 ml-2'>
                    {item.genres?.slice(0, 3).map((g) => (
                      <span
                        key={g}
                        className='px-2 py-0.5 rounded bg-white/10 text-[10px] md:text-xs text-white/80 border border-white/5 cursor-default'
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                </div>
              </motion.div>

              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.6 }}
                className='text-base md:text-lg text-white/80 max-w-3xl leading-relaxed line-clamp-3 font-light drop-shadow-md'
              >
                {item.description}
              </motion.p>

              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.6 }}
                className='flex flex-wrap items-center gap-3 pt-1'
              >
                <Button
                  size='lg'
                  className='h-12 px-8 text-base font-semibold rounded-md bg-white text-black hover:bg-zinc-200 transition-colors'
                  onClick={handlePrimaryAction}
                >
                  <Play className='w-5 h-5 mr-2 fill-current' /> {playButtonText}
                </Button>

                {item.type === 'movie' &&
                  progress &&
                  movieResume.canResume &&
                  formatTime(progress.position) && (
                    <span className='text-xs md:text-sm text-white/60 font-medium'>
                      Continue from {formatTime(progress.position)}
                    </span>
                  )}

                {item.type === 'series' &&
                  seriesProgress &&
                  canResumeInSelectedSeason &&
                  seriesProgress.season !== undefined &&
                  seriesProgress.episode !== undefined && (
                    <div className='flex items-center gap-2'>
                      <Badge variant='outline' className='rounded-md border-white/15 bg-white/5 text-white/80'>
                        S{seriesProgress.season} • E{seriesProgress.episode}
                      </Badge>
                      {formatTime(seriesProgress.position) && (
                        <span className='text-xs md:text-sm text-white/60 font-medium'>
                          {formatTime(seriesProgress.position)}
                        </span>
                      )}
                    </div>
                  )}

                <div className='flex gap-2'>
                  <Button
                    size='icon'
                    variant='outline'
                    className={cn(
                      'h-12 w-12 rounded-md bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white transition-colors backdrop-blur-sm',
                      isInLibrary &&
                        'bg-green-500/10 text-green-500 hover:bg-green-500/20 hover:text-green-400 border-green-500/20',
                    )}
                    onClick={() => toggleLibrary.mutate()}
                  >
                    {toggleLibrary.isPending ? (
                      <Loader2 className='w-5 h-5 animate-spin' />
                    ) : isInLibrary ? (
                      <Check className='w-5 h-5' />
                    ) : (
                      <Plus className='w-5 h-5' />
                    )}
                  </Button>

                  {item.trailers && item.trailers.length > 0 && (
                    <Button
                      size='icon'
                      variant='outline'
                      className='h-12 w-12 rounded-md bg-white/5 border-white/10 text-white hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition-colors backdrop-blur-sm'
                      onClick={() => {
                        const trailer = item.trailers![0];
                        const videoIdMatch = trailer.url.match(/(?:v=|\/)([\w-]{11})(?:\?|&|\/|$)/);
                        const videoId = videoIdMatch ? videoIdMatch[1] : null;
                        if (videoId) {
                          setTrailerUrl(`https://www.youtube.com/embed/${videoId}?autoplay=1`);
                          setTrailerOpen(true);
                        } else {
                          window.open(trailer.url, '_blank');
                        }
                      }}
                    >
                      <Youtube className='w-5 h-5' />
                    </Button>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>

      {/* Cast Section (Inline) */}
      {item.cast && item.cast.length > 0 && (
        <div className='container py-6 border-b border-white/5'>
          <div className='flex flex-wrap gap-x-6 gap-y-3 items-center text-sm md:text-base'>
            <span className='font-bold text-white/50 uppercase tracking-widest text-xs'>
              Starring
            </span>
            {item.cast.slice(0, 10).map((actor, i) => (
              <span
                key={i}
                className='text-zinc-300 hover:text-white transition-colors cursor-default font-medium'
              >
                {actor}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tabs Section */}
      {(hasEpisodesTab || hasRelationsTab) && (
        <div id='episodes-section' className='container py-8'>
          <Tabs
            value={resolvedActiveTab}
            onValueChange={(value) => setActiveTab(value as 'episodes' | 'relations')}
            className='w-full space-y-6'
          >
            <div className='flex items-center justify-between border-b border-white/5 pb-0'>
              <TabsList className='bg-transparent p-0 gap-8 h-auto'>
                {hasEpisodesTab && (
                  <TabsTrigger
                    value='episodes'
                    className='rounded-none border-b-2 border-transparent data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-white text-zinc-500 text-xl px-2 pb-4 font-bold transition-all hover:text-zinc-300'
                  >
                    Episodes
                  </TabsTrigger>
                )}
                {hasRelationsTab && (
                  <TabsTrigger
                    value='relations'
                    className='rounded-none border-b-2 border-transparent data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-white text-zinc-500 text-xl px-2 pb-4 font-bold transition-all hover:text-zinc-300'
                  >
                    Relations
                  </TabsTrigger>
                )}
              </TabsList>

              {/* Season Selector */}
              {hasEpisodesTab &&
                (scopedInlineTarget ? baseSeasonsSnapshot.length : seasons.length) +
                  relatedSeasonCandidates.length >
                  1 && (
                  <div className='flex items-center gap-2 ml-auto'>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-10 px-4 gap-2 rounded-xl bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white font-medium transition-all backdrop-blur-md shadow-sm max-w-[200px]'
                        >
                          <span className='truncate'>
                            {scopedInlineTarget && activeRelatedCandidateKey
                              ? (activeCandidateLabel || `Season ${activeRelatedCandidateKey.split('-')[0]}`)
                              : selectedSeason !== null
                                ? formatSeasonLabel(selectedSeason)
                                : 'Season'}
                          </span>
                          <ChevronDown className='h-4 w-4 opacity-50 shrink-0' />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align='end'
                        className='w-56 max-h-[350px] overflow-y-auto bg-zinc-950/98 border-white/10 backdrop-blur-xl rounded-xl shadow-2xl p-1.5 scrollbar-thin scrollbar-thumb-white/10'
                      >
                        {/* When inline, group base seasons under the original title as a "go back" section */}
                        {scopedInlineTarget && baseSeasonsSnapshot.length > 0 && (
                          <DropdownMenuLabel className='px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 select-none truncate'>
                            {scopedInlineTarget.originTitle || 'Original'}
                          </DropdownMenuLabel>
                        )}
                        {/* Local seasons (base-item seasons when inline, for navigating back) */}
                        {(scopedInlineTarget ? baseSeasonsSnapshot : seasons).map((s) => {
                          const isActive =
                            !scopedInlineTarget &&
                            activeRelatedCandidateKey === null &&
                            selectedSeason === s;
                          return (
                            <DropdownMenuItem
                              key={`season-${s}`}
                              onClick={() => {
                                if (scopedInlineTarget) {
                                  setInlineTarget(null);
                                  setActiveRelatedCandidateKey(null);
                                  setActiveCandidateLabel('');
                                  setUserSelectedSeason(s);
                                  setEpisodePagination({});
                                  setEpisodeSearch('');
                                  setActiveTab('episodes');
                                } else {
                                  setActiveRelatedCandidateKey(null);
                                  setActiveCandidateLabel('');
                                  setUserSelectedSeason(s);
                                  setEpisodeSearch('');
                                }
                              }}
                              className={cn(
                                'cursor-pointer rounded-lg px-3 py-2.5 text-sm transition-all duration-200 flex items-center justify-between gap-2',
                                isActive
                                  ? 'bg-white/10 text-white font-semibold'
                                  : 'text-zinc-400 hover:text-white hover:bg-white/5 focus:bg-white/5 focus:text-white',
                              )}
                            >
                              <span>{formatSeasonLabel(s)}</span>
                              {isActive && <Check className='h-3.5 w-3.5 shrink-0 opacity-80' />}
                            </DropdownMenuItem>
                          );
                        })}
                        {/* Related season candidates (cross-entry seasons: S3P1, S3P2, etc.) */}
                        {relatedSeasonCandidates.length > 0 && (
                          <>
                            <DropdownMenuSeparator className='my-1 bg-white/10' />
                            {relatedSeasonCandidates.map((cand) => {
                              const candLabel = `Season ${cand.seasonNumber}${cand.part ? ` Part ${cand.part}` : ''}${cand.year ? ` \u2022 ${cand.year}` : ''}`;
                              const isActive =
                                !!scopedInlineTarget && activeRelatedCandidateKey === cand.itemKey;
                              return (
                                <DropdownMenuItem
                                  key={`related-${cand.itemKey}`}
                                  onClick={() =>
                                    handleInlineDetailsSwitch(
                                      cand.routeType,
                                      cand.id,
                                      cand.seasonNumber,
                                      cand.itemKey,
                                      candLabel,
                                    )
                                  }
                                  className={cn(
                                    'cursor-pointer rounded-lg px-3 py-2.5 text-sm transition-all duration-200 flex items-center justify-between gap-2',
                                    isActive
                                      ? 'bg-white/10 text-white font-semibold'
                                      : 'text-zinc-300 hover:text-white hover:bg-white/5 focus:bg-white/5 focus:text-white',
                                  )}
                                >
                                  <span>{candLabel}</span>
                                  {isActive && <Check className='h-3.5 w-3.5 shrink-0 opacity-80' />}
                                </DropdownMenuItem>
                              );
                            })}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
            </div>

            <TabsContent
              value='episodes'
              className='mt-0 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-4 duration-500'
            >
              {item.type === 'series' && filteredEpisodes.length > 0 ? (
                <>
                {/* Episode search bar */}
                {filteredEpisodes.length > 5 && (
                  <div className='mb-4 relative'>
                    <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none z-10' />
                    <Input
                      placeholder='Search episodes…'
                      value={episodeSearch}
                      onChange={(e) => setEpisodeSearch(e.target.value)}
                      className='h-9 pl-9 pr-9 bg-white/[0.03] border-white/[0.08] text-sm text-white placeholder:text-zinc-600 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-xl'
                    />
                    {episodeSearch && (
                      <button
                        type='button'
                        onClick={() => setEpisodeSearch('')}
                        className='absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    )}
                  </div>
                )}
                {shouldUseLongSeasonPaging && !shouldShowEpisodeProgressSkeleton && !episodeSearch.trim() && (
                  <div className='mb-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2'>
                    <span className='text-xs text-zinc-400'>
                      Episodes {visibleEpisodeStart}-{visibleEpisodeEnd} of {filteredEpisodes.length}
                    </span>
                    <div className='flex items-center gap-2'>
                      <Button
                        variant='outline'
                        size='sm'
                        className='h-8 px-3 bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white disabled:text-zinc-500'
                        disabled={activeEpisodePageIndex <= 0}
                        onClick={() => {
                          setEpisodePagination((prev) => ({
                            ...prev,
                            [currentEpisodeSeasonKey]: {
                              count: EPISODES_PAGE_SIZE,
                              pageIndex: Math.max(0, activeEpisodePageIndex - 1),
                            },
                          }));
                        }}
                      >
                        Prev
                      </Button>
                      <span className='text-xs text-zinc-400 tabular-nums'>
                        Page {activeEpisodePageIndex + 1} / {totalEpisodePages}
                      </span>
                      <Button
                        variant='outline'
                        size='sm'
                        className='h-8 px-3 bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white disabled:text-zinc-500'
                        disabled={activeEpisodePageIndex >= totalEpisodePages - 1}
                        onClick={() => {
                          setEpisodePagination((prev) => ({
                            ...prev,
                            [currentEpisodeSeasonKey]: {
                              count: EPISODES_PAGE_SIZE,
                              pageIndex: Math.min(totalEpisodePages - 1, activeEpisodePageIndex + 1),
                            },
                          }));
                        }}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
                <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-3'>
                  {shouldShowEpisodeProgressSkeleton
                    ? visibleEpisodes.map((ep) => (
                        <div
                          key={`episode-skeleton-${ep.id}`}
                          className='flex w-full text-left gap-4 rounded-xl p-2.5 bg-transparent border border-transparent'
                        >
                          <Skeleton className='shrink-0 w-40 aspect-video rounded-lg bg-zinc-900/60' />
                          <div className='flex-1 min-w-0 flex flex-col justify-center gap-2'>
                            <Skeleton className='h-3 w-24 bg-white/10' />
                            <Skeleton className='h-4 w-4/5 bg-white/10' />
                            <Skeleton className='h-3 w-full bg-white/10' />
                            <Skeleton className='h-3 w-3/5 bg-white/10' />
                          </div>
                        </div>
                      ))
                    : visibleEpisodes.length === 0 && episodeSearch.trim()
                      ? (
                        <p className='col-span-full py-14 text-center text-sm text-zinc-600'>
                          No episodes match &ldquo;<span className='text-zinc-400'>{episodeSearch}</span>&rdquo;
                        </p>
                      )
                    : visibleEpisodes.map((ep) => {
                    const epProgress = episodeProgressMap.get(
                      `${item.id}:${ep.season}:${ep.episode}`,
                    );
                    const progressRaw =
                      epProgress && epProgress.duration > 0
                        ? (epProgress.position / epProgress.duration) * 100
                        : 0;
                    const progressPercent = Math.min(100, Math.max(0, progressRaw));
                    const isWatched =
                      epProgress &&
                      epProgress.duration > 0 &&
                      epProgress.position / epProgress.duration > 0.9;
                    const durationLabel = formatEpisodeDuration(epProgress?.duration);
                    const isResumeEp = !!(
                      seriesProgress &&
                      seriesProgress.season === ep.season &&
                      seriesProgress.episode === ep.episode &&
                      seriesResume.canResume
                    );
                    const isSpoiler = isEpisodeSpoiler(ep);

                    return (
                      <button
                        type='button'
                        key={ep.id}
                        ref={isResumeEp ? (el) => { resumeEpisodeRef.current = el; } : undefined}
                        className={cn(
                          'group flex w-full text-left gap-4 rounded-xl p-2.5',
                          'border border-transparent bg-transparent',
                          'hover:bg-white/[0.03] hover:border-white/[0.02]',
                          'transition-colors duration-200 cursor-pointer',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20',
                          isResumeEp && 'bg-primary/5 hover:bg-primary/10 border-primary/20 ring-1 ring-primary/20',
                        )}
                        onClick={() => handleWatchEpisode(ep)}
                      >
                        {/* Thumbnail */}
                        <div className='shrink-0 w-40 aspect-video rounded-lg bg-zinc-900/50 relative overflow-hidden'>
                          {ep.thumbnail ? (
                            <img
                              src={ep.thumbnail}
                              alt={`Ep ${ep.episode}`}
                              className={cn(
                                'w-full h-full object-cover transition-all duration-300',
                                isWatched && !isResumeEp
                                  ? 'opacity-45 saturate-[0.4] group-hover:opacity-70 group-hover:saturate-75'
                                  : 'opacity-100',
                                isSpoiler && 'blur-sm scale-110',
                              )}
                              loading='lazy'
                              decoding='async'
                              onError={(e) => {
                                // On load failure hide broken img and show placeholder
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                                const placeholder = e.currentTarget.nextElementSibling as HTMLElement | null;
                                if (placeholder) placeholder.style.display = 'flex';
                              }}
                            />
                          ) : null}
                          {/* Placeholder shown when no thumbnail or img fails */}
                          <div
                            className='absolute inset-0 flex items-center justify-center text-white/10 font-bold text-xl'
                            style={{ display: ep.thumbnail ? 'none' : 'flex' }}
                          >
                            EP {ep.episode}
                          </div>
                          {/* Progress Bar */}
                          {epProgress && progressPercent > 0 && (
                            <div className='absolute bottom-0 left-0 right-0 h-[3px] bg-black/40 overflow-hidden'>
                              <div
                                className='h-full bg-primary/90'
                                style={{ width: `${progressPercent}%` }}
                              />
                            </div>
                          )}
                          {/* Play Overlay */}
                          <div className='absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 bg-black/40'>
                            <div className='w-9 h-9 rounded-full bg-black/60 border border-white/25 flex items-center justify-center'>
                              <Play className='w-3.5 h-3.5 fill-white ml-0.5' />
                            </div>
                          </div>
                        </div>

                        {/* Episode Info */}
                        <div className='flex-1 min-w-0 flex flex-col justify-center gap-1.5'>
                          {/* Meta row: ep number + badges + duration */}
                          <div className='flex items-center justify-between gap-2'>
                            <div className='flex items-center gap-1.5 min-w-0'>
                              <span className='text-[11px] font-medium text-zinc-500 shrink-0'>
                                EP {ep.episode}
                              </span>
                              {isWatched && !isResumeEp && (
                                <Check className='w-3 h-3 text-green-400/70 flex-shrink-0' />
                              )}
                              {isResumeEp && (
                                <span className='inline-flex items-center text-[9px] font-bold text-primary uppercase tracking-wider bg-primary/15 border border-primary/25 px-1.5 py-0.5 rounded'>
                                  Resume
                                </span>
                              )}
                            </div>
                            {durationLabel && (
                              <span className='text-[11px] text-zinc-500 flex-shrink-0'>
                                {durationLabel}
                              </span>
                            )}
                          </div>
                          {/* Title */}
                          <h4
                            className={cn(
                              'text-sm font-semibold leading-snug truncate',
                              isWatched && !isResumeEp
                                ? 'text-zinc-400/90 group-hover:text-zinc-300'
                                : 'text-zinc-100 group-hover:text-white',
                            )}
                          >
                            {ep.title || `Episode ${ep.episode}`}
                          </h4>
                          {/* Description */}
                          <p className={cn(
                            'text-xs text-zinc-500 line-clamp-2 leading-relaxed',
                            isSpoiler && 'blur-sm select-none',
                          )}>
                            {isSpoiler
                              ? 'Episode description hidden (spoiler protection)'
                              : (ep.overview || '')}
                          </p>
                          {/* Air date */}
                          {ep.released && (
                            <span className='text-[10px] text-zinc-600'>
                              {new Date(ep.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {shouldUseLongSeasonPaging && !shouldShowEpisodeProgressSkeleton && !episodeSearch.trim() && (
                  <div className='mt-4 flex items-center justify-center gap-2'>
                    <Button
                      variant='outline'
                      className='bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white disabled:text-zinc-500'
                      disabled={activeEpisodePageIndex <= 0}
                      onClick={() => {
                        setEpisodePagination((prev) => ({
                          ...prev,
                          [currentEpisodeSeasonKey]: {
                            count: EPISODES_PAGE_SIZE,
                            pageIndex: Math.max(0, activeEpisodePageIndex - 1),
                          },
                        }));
                      }}
                    >
                      Previous 50
                    </Button>
                    <Button
                      variant='outline'
                      className='bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white disabled:text-zinc-500'
                      disabled={activeEpisodePageIndex >= totalEpisodePages - 1}
                      onClick={() => {
                        setEpisodePagination((prev) => ({
                          ...prev,
                          [currentEpisodeSeasonKey]: {
                            count: EPISODES_PAGE_SIZE,
                            pageIndex: Math.min(totalEpisodePages - 1, activeEpisodePageIndex + 1),
                          },
                        }));
                      }}
                    >
                      Next 50
                    </Button>
                  </div>
                )}
                {hasMoreEpisodes && !shouldShowEpisodeProgressSkeleton && (
                  <div className='mt-4 flex items-center justify-center'>
                    <Button
                      variant='outline'
                      className='bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08] hover:border-white/20 text-white'
                      onClick={() => {
                        setEpisodePagination((prev) => {
                          const baseCount =
                            prev[currentEpisodeSeasonKey]?.count ?? defaultEpisodeVisibleCount;
                          return {
                            ...prev,
                            [currentEpisodeSeasonKey]: {
                              count: baseCount + EPISODES_PAGE_SIZE,
                              pageIndex: 0,
                            },
                          };
                        });
                      }}
                    >
                      Show More Episodes ({remainingEpisodes} left)
                    </Button>
                  </div>
                )}
                </>
              ) : (
                <div className='text-center py-24 text-zinc-600'>
                  {item.type === 'movie'
                    ? "Movies typically don't have episodes."
                    : 'No episodes found for this season.'}
                </div>
              )}
            </TabsContent>

            <TabsContent
              value='relations'
              className='mt-0 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-4 duration-500'
            >
              <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4'>
                {intelligentRelations.map((rel, i) => (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.05 }}
                    key={rel.id}
                  >
                    <MediaCard
                      item={rel}
                      onPlay={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const preferredSeason = extractSeasonNumberFromTitle(rel.title || '');
                        const relationType = rel.id.startsWith('kitsu:') ? 'anime' : rel.type;
                        handleInlineDetailsSwitch(relationType, rel.id, preferredSeason);
                      }}
                    />
                  </motion.div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <StreamSelector
        open={effectiveStreamSelectorOpen}
        onClose={() => {
          setStreamSelectorOpen(false);
          setStreamParams(null);
          setReopenSelectorConsumed(true);
        }}
        type={streamSelectorType}
        id={effectiveStreamParams?.id || ''}
        streamId={effectiveStreamParams?.streamId || effectiveStreamParams?.id || ''}
        season={effectiveStreamParams?.season}
        episode={effectiveStreamParams?.episode}
        absoluteSeason={effectiveStreamParams?.absoluteSeason}
        absoluteEpisode={effectiveStreamParams?.absoluteEpisode}
        aniskipEpisode={effectiveStreamParams?.aniskipEpisode}
        startTime={effectiveStreamParams?.startTime}
        title={effectiveStreamParams?.title || ''}
        overview={effectiveStreamParams?.overview}
        poster={item.poster}
        backdrop={item.backdrop}
        logo={item.logo}
        from={`${location.pathname}${location.search}`}
      />

      <Dialog open={trailerOpen} onOpenChange={setTrailerOpen}>
        <DialogContent className='max-w-5xl p-0 overflow-hidden bg-black border-zinc-800'>
          {trailerUrl && (
            <div className='aspect-video w-full'>
              <iframe
                width='100%'
                height='100%'
                src={trailerUrl}
                title='Trailer'
                frameBorder='0'
                allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
                allowFullScreen
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className='min-h-screen bg-background animate-pulse'>
      <div className='h-[60vh] bg-secondary w-full' />
      <div className='container -mt-48 relative flex flex-col md:flex-row gap-8'>
        <div className='w-48 aspect-[2/3] bg-secondary rounded-xl shrink-0 hidden md:block ring-1 ring-white/5' />
        <div className='flex-1 space-y-6 pt-12'>
          <Skeleton className='h-12 w-3/4' />
          <div className='flex gap-3'>
            <Skeleton className='h-5 w-16' />
            <Skeleton className='h-5 w-16' />
            <Skeleton className='h-5 w-16' />
          </div>
          <div className='space-y-2'>
            <Skeleton className='h-4 w-full' />
            <Skeleton className='h-4 w-full' />
            <Skeleton className='h-4 w-2/3' />
          </div>
          <div className='flex gap-3 pt-2'>
            <Skeleton className='h-10 w-32 rounded-full' />
            <Skeleton className='h-10 w-10 rounded-full' />
          </div>
        </div>
      </div>
    </div>
  );
}
