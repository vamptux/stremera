export const LEGACY_STORAGE_IMPORT_VERSION = 1;

export type LegacyStorageFeature =
  | 'app-ui-preferences'
  | 'app-update-last-notified-version'
  | 'profile-preferences'
  | 'search-history'
  | 'stream-selector-preferences';

export interface LegacyStorageReadResult<T> {
  hasLegacyData: boolean;
  value: T | null;
}

const LEGACY_STORAGE_FEATURE_PREFIX = 'stremera:legacy-storage-import:';

function getLegacyStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getLegacyStorageFeatureKey(feature: LegacyStorageFeature): string {
  return `${LEGACY_STORAGE_FEATURE_PREFIX}${feature}`;
}

function getLegacyStorageFeatureVersion(
  storage: Storage,
  feature: LegacyStorageFeature,
): number {
  const rawVersion = storage.getItem(getLegacyStorageFeatureKey(feature));
  const parsedVersion = Number.parseInt(rawVersion ?? '', 10);
  return Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 0;
}

export function readLegacyStorageFeature<T>(
  feature: LegacyStorageFeature,
  reader: (storage: Storage) => LegacyStorageReadResult<T>,
): LegacyStorageReadResult<T> {
  const storage = getLegacyStorage();
  if (!storage) {
    return { hasLegacyData: false, value: null };
  }

  if (getLegacyStorageFeatureVersion(storage, feature) >= LEGACY_STORAGE_IMPORT_VERSION) {
    return { hasLegacyData: false, value: null };
  }

  return reader(storage);
}

export function markLegacyStorageFeatureComplete(feature: LegacyStorageFeature) {
  const storage = getLegacyStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      getLegacyStorageFeatureKey(feature),
      String(LEGACY_STORAGE_IMPORT_VERSION),
    );
  } catch {
    // Ignore storage write failures and keep the runtime usable.
  }
}

export function clearLegacyStorageFeatureKeys(
  feature: LegacyStorageFeature,
  keys: readonly string[],
) {
  const storage = getLegacyStorage();
  if (!storage) {
    return;
  }

  try {
    for (const key of keys) {
      storage.removeItem(key);
    }

    storage.setItem(
      getLegacyStorageFeatureKey(feature),
      String(LEGACY_STORAGE_IMPORT_VERSION),
    );
  } catch {
    // Ignore storage cleanup failures and keep the runtime usable.
  }
}