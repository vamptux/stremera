export const SEARCH_YEAR_MIN = 1889;
export const SEARCH_CURRENT_YEAR = new Date().getFullYear();
export const SEARCH_YEAR_OPTIONS: number[] = Array.from(
  { length: SEARCH_CURRENT_YEAR - SEARCH_YEAR_MIN + 1 },
  (_, index) => SEARCH_CURRENT_YEAR - index,
);

export interface SearchYearRange {
  yearFrom: number | null;
  yearTo: number | null;
}

export function normalizeSearchYearValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < SEARCH_YEAR_MIN || value > SEARCH_CURRENT_YEAR) return undefined;
  return value;
}

export function parseSearchYearParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return normalizeSearchYearValue(parsed) ?? null;
}

export function normalizeSearchYearRange(
  yearFrom: number | null,
  yearTo: number | null,
): SearchYearRange {
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    return {
      yearFrom: yearTo,
      yearTo: yearFrom,
    };
  }

  return { yearFrom, yearTo };
}

export function parseGenresParam(value: string | null): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(',')
        .map((genre) => genre.trim())
        .filter(Boolean),
    ),
  );
}

export function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function getPrimaryYear(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.split('-')[0] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}
