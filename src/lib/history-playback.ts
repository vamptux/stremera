import { api, type EpisodeStreamMapping, type WatchProgress } from '@/lib/api';
import { buildPlayerNavigationTarget, type PlayerRouteState } from '@/lib/player-navigation';

const MIN_RESUME_POSITION_SECS = 5;
const MAX_RESUME_PROGRESS_RATIO = 0.95;

export interface HistoryPlaybackPlan {
	kind: 'details' | 'player';
	reason?: 'missing-episode-context' | 'missing-saved-stream';
	target: string;
	state: DetailsHistoryRouteState | PlayerRouteState;
}

export interface DetailsHistoryRouteState {
	from: string;
	season?: number;
	reopenStreamSelector?: boolean;
	reopenStreamSeason?: number;
	reopenStreamEpisode?: number;
	reopenStartTime?: number;
}

interface BuildDetailsReopenSelectorStateArgs {
	from: string;
	season?: number;
	episode?: number;
	startTime?: number;
}

export type HistoryPlaybackFallbackNoticeMode = 'open-details' | 'select-episode';

export function getHistoryPlaybackFallbackNotice(
	reason: HistoryPlaybackPlan['reason'],
	mode: HistoryPlaybackFallbackNoticeMode = 'open-details',
): { title: string; description: string } {
	const normalizedReason = reason ?? 'missing-episode-context';

	if (normalizedReason === 'missing-saved-stream') {
		return mode === 'select-episode'
			? {
					title: 'Saved stream unavailable',
					description: 'Select the episode below to continue with a fresh stream.',
				}
			: {
					title: 'Saved stream unavailable',
					description: 'Opening details so you can choose a fresh stream to continue.',
				};
	}

	return mode === 'select-episode'
		? {
				title: 'Episode context missing',
				description: 'Select the episode below to continue watching.',
			}
		: {
				title: 'Episode context missing',
				description: 'Opening details so you can select the episode to continue.',
			};
}

type HistoryPlaybackMediaType = 'movie' | 'series' | 'anime';

function normalizeHistoryType(type: string): string {
	return type.trim().toLowerCase();
}

function normalizeSavedValue(value?: string | null): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const normalized = trimmed.toLowerCase();
	if (normalized === 'null' || normalized === 'undefined') {
		return undefined;
	}

	return trimmed;
}

function isKitsuId(id: string): boolean {
	return id.trim().toLowerCase().startsWith('kitsu:');
}

function normalizeHistoryMediaType(type: string, id: string): HistoryPlaybackMediaType {
	const normalized = normalizeHistoryType(type);
	if (normalized === 'movie') return 'movie';
	if (normalized === 'anime') return 'anime';
	if (normalized === 'series' && isKitsuId(id)) return 'anime';
	return 'series';
}

function isSeriesLikeType(type: string): boolean {
	const normalized = normalizeHistoryType(type);
	return normalized === 'series' || normalized === 'anime';
}

function getImmediateHistoryStreamLookupId(item: WatchProgress): string {
	const savedLookupId = normalizeSavedValue(item.last_stream_lookup_id);
	if (savedLookupId) {
		return savedLookupId;
	}

	return item.id.trim();
}

interface HistoryEpisodeContext {
	absoluteSeason?: number;
	absoluteEpisode?: number;
	streamSeason?: number;
	streamEpisode?: number;
	aniskipEpisode?: number;
}

interface ResolvedHistoryEpisodeContext extends HistoryEpisodeContext {
	streamLookupId: string;
}

function hasExplicitStreamEpisodeContext(item: WatchProgress): boolean {
	return typeof item.stream_season === 'number' && typeof item.stream_episode === 'number';
}

function isMappedAnimeHistoryItem(item: WatchProgress, lookupId?: string): boolean {
	return (
		normalizeHistoryMediaType(item.type_, item.id) === 'anime' &&
		!!lookupId?.startsWith('tt') &&
		!item.id.trim().startsWith('tt')
	);
}

function getEpisodeContext(item: WatchProgress): HistoryEpisodeContext {
	const absoluteSeason =
		typeof item.absolute_season === 'number' ? item.absolute_season : item.season;
	const absoluteEpisode =
		typeof item.absolute_episode === 'number' ? item.absolute_episode : item.episode;
	const explicitLookupId = normalizeSavedValue(item.last_stream_lookup_id);
	const shouldDeferMappedAnimeCoords =
		!hasExplicitStreamEpisodeContext(item) && isMappedAnimeHistoryItem(item, explicitLookupId);
	const streamSeason =
		typeof item.stream_season === 'number'
			? item.stream_season
			: shouldDeferMappedAnimeCoords
				? undefined
				: absoluteSeason;
	const streamEpisode =
		typeof item.stream_episode === 'number'
			? item.stream_episode
			: shouldDeferMappedAnimeCoords
				? undefined
				: absoluteEpisode;

	return {
		absoluteSeason,
		absoluteEpisode,
		streamSeason,
		streamEpisode,
		aniskipEpisode:
			typeof item.aniskip_episode === 'number'
				? item.aniskip_episode
				: shouldDeferMappedAnimeCoords
					? absoluteEpisode
					: streamEpisode,
	};
}

function hasEpisodeContext(item: WatchProgress): boolean {
	if (!isSeriesLikeType(item.type_)) return true;
	const { absoluteSeason, absoluteEpisode } = getEpisodeContext(item);
	return absoluteSeason !== undefined && absoluteEpisode !== undefined;
}

function getMediaDetailsType(item: WatchProgress): HistoryPlaybackMediaType {
	return normalizeHistoryMediaType(item.type_, item.id);
}

function applyEpisodeStreamMapping(mapping: EpisodeStreamMapping): HistoryEpisodeContext {
	return {
		absoluteSeason: mapping.canonicalSeason,
		absoluteEpisode: mapping.canonicalEpisode,
		streamSeason: mapping.sourceSeason,
		streamEpisode: mapping.sourceEpisode,
		aniskipEpisode: mapping.aniskipEpisode,
	};
}

async function resolveHistoryEpisodeContext(
	item: WatchProgress,
): Promise<ResolvedHistoryEpisodeContext> {
	const baseContext = getEpisodeContext(item);
	const streamLookupId = getImmediateHistoryStreamLookupId(item);
	const hasCanonicalEpisodeContext =
		baseContext.absoluteSeason !== undefined && baseContext.absoluteEpisode !== undefined;
	const needsMappedCoordinates =
		hasCanonicalEpisodeContext &&
		(baseContext.streamSeason === undefined || baseContext.streamEpisode === undefined);

	if (needsMappedCoordinates) {
		try {
			const mapping = await api.getEpisodeStreamMapping(
				getMediaDetailsType(item),
				item.id,
				baseContext.absoluteSeason!,
				baseContext.absoluteEpisode!,
			);

			if (mapping) {
				return {
					...applyEpisodeStreamMapping(mapping),
					streamLookupId: mapping.lookupId,
				};
			}
		} catch {
			// Best-effort mapping only.
		}
	}

	return {
		...baseContext,
		streamLookupId,
	};
}

export function getPlayableResumeStartTime(
	item?: Pick<WatchProgress, 'position' | 'duration'> | null,
): number | undefined {
	if (!item || !Number.isFinite(item.position) || item.position < MIN_RESUME_POSITION_SECS) {
		return undefined;
	}

	if (
		Number.isFinite(item.duration) &&
		item.duration > 0 &&
		item.position / item.duration >= MAX_RESUME_PROGRESS_RATIO
	) {
		return undefined;
	}

	return item.position;
}

function getResumeStartTime(item: WatchProgress): number {
	return getPlayableResumeStartTime(item) ?? 0;
}

async function getLatestHistoryPlaybackItem(item: WatchProgress): Promise<WatchProgress> {
	const episodeContext = getEpisodeContext(item);

	try {
		const latest = await api.getWatchProgress(
			item.id,
			item.type_,
			episodeContext.absoluteSeason,
			episodeContext.absoluteEpisode,
		);

		if (!latest) {
			return item;
		}

		return {
			...latest,
			title: latest.title.trim() || item.title,
			poster: latest.poster ?? item.poster,
			backdrop: latest.backdrop ?? item.backdrop,
		};
	} catch {
		return item;
	}
}

export async function getLatestEpisodeResumeStartTime(
	mediaId: string,
	mediaType: string,
	season?: number,
	episode?: number,
): Promise<number | undefined> {
	try {
		const progress = await api.getWatchProgress(mediaId, mediaType, season, episode);
		return getPlayableResumeStartTime(progress);
	} catch {
		return undefined;
	}
}

function hasSavedStream(item: WatchProgress): boolean {
	return !!normalizeSavedValue(item.last_stream_url);
}

export function buildDetailsReopenSelectorState({
	from,
	season,
	episode,
	startTime,
}: BuildDetailsReopenSelectorStateArgs): DetailsHistoryRouteState {
	const state: DetailsHistoryRouteState = {
		from,
		reopenStreamSelector: true,
	};

	if (typeof season === 'number' && Number.isFinite(season)) {
		state.season = season;
		state.reopenStreamSeason = season;
	}

	if (typeof episode === 'number' && Number.isFinite(episode) && state.reopenStreamSeason !== undefined) {
		state.reopenStreamEpisode = episode;
	}

	if (typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0) {
		state.reopenStartTime = startTime;
	}

	return state;
}

function buildDetailsFallbackState(
	item: WatchProgress,
	from: string,
	reason: 'missing-episode-context' | 'missing-saved-stream',
): DetailsHistoryRouteState {
	const state: DetailsHistoryRouteState = { from };
	const episodeContext = getEpisodeContext(item);
	const detailsSeason = episodeContext.absoluteSeason;
	const detailsEpisode = episodeContext.absoluteEpisode;
	const resumeStartTime = getResumeStartTime(item);

	if (detailsSeason !== undefined) {
		state.season = detailsSeason;
	}

	if (reason === 'missing-saved-stream') {
		return buildDetailsReopenSelectorState({
			from,
			season: detailsSeason,
			episode:
				isSeriesLikeType(item.type_) && detailsEpisode !== undefined ? detailsEpisode : undefined,
			startTime: resumeStartTime > 0 ? resumeStartTime : undefined,
		});
	}

	return state;
}

export async function buildHistoryPlaybackPlan(
	item: WatchProgress,
	from: string,
): Promise<HistoryPlaybackPlan> {
	const latestItem = await getLatestHistoryPlaybackItem(item);
	const playbackType = getMediaDetailsType(latestItem);

	if (!hasEpisodeContext(latestItem)) {
		return {
			kind: 'details',
			reason: 'missing-episode-context',
			target: `/details/${playbackType}/${latestItem.id}`,
			state: buildDetailsFallbackState(latestItem, from, 'missing-episode-context'),
		};
	}

	if (!hasSavedStream(latestItem)) {
		return {
			kind: 'details',
			reason: 'missing-saved-stream',
			target: `/details/${playbackType}/${latestItem.id}`,
			state: buildDetailsFallbackState(latestItem, from, 'missing-saved-stream'),
		};
	}

	const {
		absoluteSeason,
		absoluteEpisode,
		streamSeason,
		streamEpisode,
		aniskipEpisode,
		streamLookupId,
	} = await resolveHistoryEpisodeContext(latestItem);

	const playerNavigation = buildPlayerNavigationTarget(playbackType, latestItem.id, {
		streamUrl: normalizeSavedValue(latestItem.last_stream_url),
		streamSourceName: normalizeSavedValue(latestItem.source_name),
		streamFamily: normalizeSavedValue(latestItem.stream_family),
		title: latestItem.title,
		poster: latestItem.poster,
		backdrop: latestItem.backdrop,
		format: normalizeSavedValue(latestItem.last_stream_format),
		selectedStreamKey: normalizeSavedValue(latestItem.last_stream_key),
		streamLookupId,
		streamSeason,
		streamEpisode,
		absoluteSeason,
		absoluteEpisode,
		aniskipEpisode,
		startTime: getResumeStartTime(latestItem),
		resumeFromHistory: true,
		from,
	});

	return {
		kind: 'player',
		target: playerNavigation.target,
		state: playerNavigation.state,
	};
}
