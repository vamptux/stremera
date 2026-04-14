import { getProperty, type MpvConfig, type MpvObservableProperty } from 'tauri-plugin-libmpv-api';

import { normalizeLanguageToken, normalizeTrackList, type Track } from '@/lib/player-track-utils';

const BASE_PLAYER_OBSERVED_PROPERTIES = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['percent-pos', 'double', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['eof-reached', 'flag'],
  ['idle-active', 'flag'],
  ['speed', 'double'],
  ['core-idle', 'flag'],
] as const satisfies MpvObservableProperty[];

const TRACK_REFRESH_OBSERVED_PROPERTIES = [
  ['current-tracks/audio/id', 'int64', 'none'],
  ['current-tracks/sub/id', 'int64', 'none'],
] as const satisfies MpvObservableProperty[];

export const PLAYER_MPV_OBSERVED_PROPERTIES = [
  ...BASE_PLAYER_OBSERVED_PROPERTIES,
  ...TRACK_REFRESH_OBSERVED_PROPERTIES,
] as const satisfies MpvObservableProperty[];

const TRACK_REFRESH_PROPERTY_NAMES = new Set<string>(
  TRACK_REFRESH_OBSERVED_PROPERTIES.map(([name]) => name),
);

const NETWORK_CACHE_OPTIONS = {
  cache: 'auto',
  'cache-secs': 12,
  'demuxer-max-bytes': '96MiB',
  'demuxer-max-back-bytes': '24MiB',
} as const;

const MPV_LANGUAGE_PRIORITY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  en: ['en', 'eng'],
  ja: ['ja', 'jpn'],
  es: ['es', 'spa'],
  fr: ['fr', 'fra'],
  de: ['de', 'deu'],
  it: ['it', 'ita'],
  pt: ['pt', 'por'],
  ko: ['ko', 'kor'],
  zh: ['zh', 'zho'],
};

interface BuildPlayerMpvConfigOptions {
  initialVolume: number;
  startPaused: boolean;
  isOffline: boolean;
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

interface SelectedTrackIds {
  audio: number | null;
  sub: number | null;
}

function buildMpvLanguagePriorityList(preferredLanguage?: string): string | undefined {
  const normalized = normalizeLanguageToken(preferredLanguage);
  if (!normalized || normalized === 'off') {
    return undefined;
  }

  const aliases = MPV_LANGUAGE_PRIORITY_ALIASES[normalized] ?? [normalized];
  return Array.from(new Set(aliases)).join(',');
}

function buildPlayerLanguageSelectionOptions(
  preferredAudioLanguage?: string,
  preferredSubtitleLanguage?: string,
): Record<string, string> {
  const options: Record<string, string> = {};
  const audioLanguageList = buildMpvLanguagePriorityList(preferredAudioLanguage);
  const normalizedSubtitlePreference = preferredSubtitleLanguage?.trim().toLowerCase();
  const subtitleLanguageList = buildMpvLanguagePriorityList(preferredSubtitleLanguage);

  if (audioLanguageList) {
    options['track-auto-selection'] = 'yes';
    options.aid = 'auto';
    options.alang = audioLanguageList;
  }

  if (normalizedSubtitlePreference === 'off') {
    options['track-auto-selection'] = 'yes';
    options.sid = 'no';
  } else if (subtitleLanguageList) {
    options['track-auto-selection'] = 'yes';
    options.sid = 'auto';
    options.slang = subtitleLanguageList;
    options['subs-fallback'] = 'no';
  }

  return options;
}

export function buildPlayerMpvConfig({
  initialVolume,
  startPaused,
  isOffline,
  preferredAudioLanguage,
  preferredSubtitleLanguage,
}: BuildPlayerMpvConfigOptions): MpvConfig {
  return {
    initialOptions: {
      vo: 'gpu-next',
      hwdec: 'auto-safe',
      'gpu-api': 'd3d11',
      'gpu-context': 'd3d11',
      'keep-open': 'yes',
      volume: initialVolume.toString(),
      pause: startPaused ? 'yes' : 'no',
      osc: 'no',
      'osd-level': '0',
      'input-default-bindings': 'no',
      'input-builtin-bindings': 'no',
      'load-scripts': 'no',
      'load-stats-overlay': 'no',
      'load-console': 'no',
      'load-commands': 'no',
      'load-select': 'no',
      'load-positioning': 'no',
      'load-context-menu': 'no',
      'load-auto-profiles': 'no',
      'resume-playback': 'no',
      'save-position-on-quit': 'no',
      ytdl: 'no',
      'msg-level': 'all=warn',
      ...(isOffline ? { cache: 'no' } : NETWORK_CACHE_OPTIONS),
      ...buildPlayerLanguageSelectionOptions(preferredAudioLanguage, preferredSubtitleLanguage),
    },
    observedProperties: PLAYER_MPV_OBSERVED_PROPERTIES,
  };
}

export function isPlayerTrackRefreshProperty(name: string): boolean {
  return TRACK_REFRESH_PROPERTY_NAMES.has(name);
}

async function readIntProperty(name: string): Promise<number | null> {
  try {
    return await getProperty<number | null>(name, 'int64');
  } catch {
    return null;
  }
}

async function readStringProperty(name: string): Promise<string | null> {
  try {
    return await getProperty<string | null>(name, 'string');
  } catch {
    return null;
  }
}

async function readFlagProperty(name: string): Promise<boolean | null> {
  try {
    return await getProperty<boolean | null>(name, 'flag');
  } catch {
    return null;
  }
}

async function readSelectedTrackIds(): Promise<SelectedTrackIds> {
  const [audio, sub] = await Promise.all([
    readIntProperty('current-tracks/audio/id'),
    readIntProperty('current-tracks/sub/id'),
  ]);

  return { audio, sub };
}

async function readTrackAtIndex(
  index: number,
  selectedTrackIds: SelectedTrackIds,
): Promise<Track | null> {
  const prefix = `track-list/${index}`;
  const [id, type, lang, title, selected, defaultTrack, forced, hearingImpaired] =
    await Promise.all([
      readIntProperty(`${prefix}/id`),
      readStringProperty(`${prefix}/type`),
      readStringProperty(`${prefix}/lang`),
      readStringProperty(`${prefix}/title`),
      readFlagProperty(`${prefix}/selected`),
      readFlagProperty(`${prefix}/default`),
      readFlagProperty(`${prefix}/forced`),
      readFlagProperty(`${prefix}/hearing-impaired`),
    ]);

  if (id === null || (type !== 'audio' && type !== 'sub' && type !== 'video')) {
    return null;
  }

  const isSelected =
    !!selected ||
    (type === 'audio' && selectedTrackIds.audio === id) ||
    (type === 'sub' && selectedTrackIds.sub === id);

  return {
    id,
    type,
    lang: lang?.trim() || undefined,
    title: title?.trim() || undefined,
    selected: isSelected,
    defaultTrack: !!defaultTrack,
    forced: !!forced,
    hearingImpaired: !!hearingImpaired,
  };
}

export async function readPlayerTrackList(): Promise<Track[]> {
  const [trackCount, selectedTrackIds] = await Promise.all([
    readIntProperty('track-list/count'),
    readSelectedTrackIds(),
  ]);

  if (!trackCount || trackCount < 1) {
    return [];
  }

  const rawTracks = await Promise.all(
    Array.from({ length: trackCount }, (_, index) => readTrackAtIndex(index, selectedTrackIds)),
  );

  return normalizeTrackList(rawTracks.filter((track): track is Track => track !== null));
}
