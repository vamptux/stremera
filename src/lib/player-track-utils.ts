export interface Track {
  id: number;
  type: 'video' | 'audio' | 'sub';
  lang?: string;
  title?: string;
  selected?: boolean;
  external?: boolean;
}

const LANGUAGE_ALIASES: Record<string, string[]> = {
  en: ['en', 'eng', 'english'],
  ja: ['ja', 'jpn', 'japanese'],
  es: ['es', 'spa', 'spanish'],
  fr: ['fr', 'fra', 'fre', 'french'],
  de: ['de', 'deu', 'ger', 'german'],
  it: ['it', 'ita', 'italian'],
  pt: ['pt', 'por', 'portuguese'],
  ko: ['ko', 'kor', 'korean'],
  zh: ['zh', 'zho', 'chi', 'chinese'],
};

const LANGUAGE_ALIAS_TO_CANONICAL = Object.entries(LANGUAGE_ALIASES).reduce<Record<string, string>>(
  (acc, [canonical, aliases]) => {
    acc[canonical] = canonical;
    for (const alias of aliases) acc[alias] = canonical;
    return acc;
  },
  {},
);

const TRACK_TYPE_SORT_ORDER: Readonly<Record<Track['type'], number>> = {
  audio: 0,
  sub: 1,
  video: 2,
};

export function normalizeLanguageToken(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function tokenizeLanguageMeta(value?: string | null): string[] {
  const normalized = normalizeLanguageToken(value);
  if (!normalized) return [];
  return normalized
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function canonicalizeLanguage(value?: string | null): string {
  const normalized = normalizeLanguageToken(value);
  if (!normalized) return '';
  return LANGUAGE_ALIAS_TO_CANONICAL[normalized] ?? normalized;
}

function languageCandidates(preferred: string): string[] {
  const normalized = normalizeLanguageToken(preferred);
  if (!normalized) return [];
  const canonical = canonicalizeLanguage(normalized);
  const directAliases = LANGUAGE_ALIASES[canonical] ?? [];
  const set = new Set<string>([canonical, normalized, ...directAliases]);

  // Recover from persisted values that include extra metadata in one string.
  for (const token of tokenizeLanguageMeta(normalized)) {
    const tokenCanonical = canonicalizeLanguage(token);
    if (!tokenCanonical || tokenCanonical === token) continue;
    set.add(tokenCanonical);
    for (const alias of LANGUAGE_ALIASES[tokenCanonical] ?? []) set.add(alias);
  }

  return Array.from(set).filter(Boolean);
}

export function inferTrackPreferredLanguage(track: Track): string | undefined {
  const langTokens = [normalizeLanguageToken(track.lang), ...tokenizeLanguageMeta(track.lang)];
  for (const token of langTokens) {
    const canonical = LANGUAGE_ALIAS_TO_CANONICAL[token];
    if (canonical) return canonical;
  }

  const titleTokens = tokenizeLanguageMeta(track.title);
  for (const token of titleTokens) {
    const canonical = LANGUAGE_ALIAS_TO_CANONICAL[token];
    if (canonical) return canonical;
  }

  return undefined;
}

export function findTrackByLanguage(tracks: Track[], preferredLanguage: string): Track | null {
  const candidates = languageCandidates(preferredLanguage);
  if (!candidates.length) return null;

  let bestTrack: Track | null = null;
  let bestScore = -1;

  for (const track of tracks) {
    const lang = normalizeLanguageToken(track.lang);
    const titleTokens = tokenizeLanguageMeta(track.title);
    const titleTokenSet = new Set(titleTokens);
    let score = 0;

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (lang === candidate) score = Math.max(score, 120);
      else if (lang.startsWith(`${candidate}-`)) score = Math.max(score, 100);
      if (titleTokenSet.has(candidate)) score = Math.max(score, 80);
    }

    if (score > bestScore) {
      bestScore = score;
      bestTrack = track;
    }
  }

  return bestScore > 0 ? bestTrack : null;
}

export function trackMatchesPreferredLanguage(track: Track | null, preferredLanguage: string): boolean {
  if (!track) return false;
  const preferred = normalizeLanguageToken(preferredLanguage);
  if (!preferred) return false;

  const lang = normalizeLanguageToken(track.lang);
  if (lang === preferred || lang.startsWith(`${preferred}-`)) return true;

  const tokens = tokenizeLanguageMeta(track.title);
  return tokens.includes(preferred);
}

function normalizeTrackType(value: unknown): Track['type'] | null {
  if (value !== 'audio' && value !== 'sub' && value !== 'video') return null;
  return value;
}

function normalizeTrackCandidate(rawTrack: unknown): Track | null {
  if (!rawTrack || typeof rawTrack !== 'object') return null;

  const candidate = rawTrack as Partial<Track>;
  const type = normalizeTrackType(candidate.type);
  if (!type) return null;

  const idAsNumber = Number(candidate.id);
  if (!Number.isFinite(idAsNumber)) return null;

  const normalizedTitle = typeof candidate.title === 'string' ? candidate.title.trim() : undefined;
  const normalizedLang = typeof candidate.lang === 'string' ? candidate.lang.trim() : undefined;

  return {
    id: Math.trunc(idAsNumber),
    type,
    title: normalizedTitle || undefined,
    lang: normalizedLang || undefined,
    selected: !!candidate.selected,
    external: !!candidate.external,
  };
}

function mergeTrackVariants(existing: Track, next: Track): Track {
  return {
    id: existing.id,
    type: existing.type,
    title: next.title || existing.title,
    lang: next.lang || existing.lang,
    selected: !!(existing.selected || next.selected),
    external: !!(existing.external || next.external),
  };
}

export function normalizeTrackList(rawTracks: unknown): Track[] {
  if (!Array.isArray(rawTracks)) return [];

  const deduped = new Map<string, Track>();

  for (const rawTrack of rawTracks) {
    const normalized = normalizeTrackCandidate(rawTrack);
    if (!normalized) continue;

    const key = `${normalized.type}:${normalized.id}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, normalized);
      continue;
    }

    deduped.set(key, mergeTrackVariants(existing, normalized));
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const byType = TRACK_TYPE_SORT_ORDER[a.type] - TRACK_TYPE_SORT_ORDER[b.type];
    if (byType !== 0) return byType;
    return a.id - b.id;
  });
}

export function doesTrackSelectionMatch(
  tracks: Track[],
  type: 'audio' | 'sub',
  id: number | 'no',
): boolean {
  const scopedTracks = tracks.filter((track) => track.type === type);

  if (id === 'no') {
    return type === 'sub' && !scopedTracks.some((track) => !!track.selected);
  }

  return scopedTracks.some((track) => track.id === id && !!track.selected);
}

export function formatTrackLabel(track: Track): string {
  return track.title || track.lang?.toUpperCase() || `Track ${track.id}`;
}
