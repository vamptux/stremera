export interface Track {
  id: number;
  type: 'video' | 'audio' | 'sub';
  lang?: string;
  title?: string;
  selected?: boolean;
  external?: boolean;
  defaultTrack?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
}

const TRACK_TYPE_SORT_ORDER: Readonly<Record<Track['type'], number>> = {
  audio: 0,
  sub: 1,
  video: 2,
};

export function normalizeLanguageToken(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
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
    defaultTrack: !!candidate.defaultTrack,
    forced: !!candidate.forced,
    hearingImpaired: !!candidate.hearingImpaired,
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
    defaultTrack: !!(existing.defaultTrack || next.defaultTrack),
    forced: !!(existing.forced || next.forced),
    hearingImpaired: !!(existing.hearingImpaired || next.hearingImpaired),
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

export function areTrackListsEqual(left: readonly Track[], right: readonly Track[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftTrack = left[index];
    const rightTrack = right[index];

    if (
      leftTrack.id !== rightTrack.id ||
      leftTrack.type !== rightTrack.type ||
      leftTrack.lang !== rightTrack.lang ||
      leftTrack.title !== rightTrack.title ||
      !!leftTrack.selected !== !!rightTrack.selected ||
      !!leftTrack.external !== !!rightTrack.external ||
      !!leftTrack.defaultTrack !== !!rightTrack.defaultTrack ||
      !!leftTrack.forced !== !!rightTrack.forced ||
      !!leftTrack.hearingImpaired !== !!rightTrack.hearingImpaired
    ) {
      return false;
    }
  }

  return true;
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

export function buildTrackLabelMap(tracks: Track[]): Map<number, string> {
  const counts = new Map<string, number>();

  for (const track of tracks) {
    const label = formatTrackLabel(track);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return new Map<number, string>(
    tracks.map((track) => {
      const label = formatTrackLabel(track);
      if ((counts.get(label) ?? 0) > 1) {
        return [track.id, `${label} #${track.id}`];
      }
      return [track.id, label];
    }),
  );
}
