import { type SkipSegment } from '@/lib/api';

const MIN_SKIP_SEGMENT_DURATION_SECS = 1;
const SKIP_SEGMENT_OVERLAP_EPSILON_SECS = 0.25;

function normalizeSkipType(type: string): string | null {
  const normalized = type.trim().toLowerCase();
  if (!normalized || normalized === 'null' || normalized === 'undefined') {
    return null;
  }

  switch (normalized) {
    case 'opening':
      return 'op';
    case 'ending':
      return 'ed';
    default:
      return normalized;
  }
}

function normalizeSkipTime(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export function normalizeSkipSegments(
  segments: readonly SkipSegment[],
  duration?: number,
): SkipSegment[] {
  const durationLimit =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? duration
      : undefined;

  const normalizedSegments = segments
    .map((segment) => {
      const type = normalizeSkipType(segment.type);
      const startTime = normalizeSkipTime(segment.start_time);
      const endTime = normalizeSkipTime(segment.end_time);

      if (!type || startTime === null || endTime === null) {
        return null;
      }

      if (durationLimit !== undefined && startTime >= durationLimit) {
        return null;
      }

      const clampedEndTime = durationLimit === undefined ? endTime : Math.min(endTime, durationLimit);
      if (clampedEndTime - startTime < MIN_SKIP_SEGMENT_DURATION_SECS) {
        return null;
      }

      return {
        type,
        start_time: startTime,
        end_time: clampedEndTime,
      } satisfies SkipSegment;
    })
    .filter((segment): segment is SkipSegment => segment !== null)
    .sort((left, right) => {
      if (left.start_time !== right.start_time) {
        return left.start_time - right.start_time;
      }
      if (left.end_time !== right.end_time) {
        return left.end_time - right.end_time;
      }
      return left.type.localeCompare(right.type);
    });

  const mergedSegments: SkipSegment[] = [];

  for (const segment of normalizedSegments) {
    const previousSegment = mergedSegments[mergedSegments.length - 1];
    if (!previousSegment) {
      mergedSegments.push(segment);
      continue;
    }

    if (
      segment.type === previousSegment.type &&
      segment.start_time <= previousSegment.end_time + SKIP_SEGMENT_OVERLAP_EPSILON_SECS
    ) {
      previousSegment.end_time = Math.max(previousSegment.end_time, segment.end_time);
      continue;
    }

    const adjustedStartTime = Math.max(segment.start_time, previousSegment.end_time);
    if (segment.end_time - adjustedStartTime < MIN_SKIP_SEGMENT_DURATION_SECS) {
      continue;
    }

    mergedSegments.push({
      ...segment,
      start_time: adjustedStartTime,
    });
  }

  return mergedSegments;
}