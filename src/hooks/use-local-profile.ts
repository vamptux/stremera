import { useState, useCallback } from 'react';

export interface LocalProfile {
  username: string;
  memberSince: string; // ISO date string
  accentColor: string; // hex color
  bio: string;         // short tagline shown below username
}

const STORAGE_KEY = 'streamy_profile';
const PROFILE_NAME_MAX_LENGTH = 32;
const PROFILE_BIO_MAX_LENGTH = 80;
const PROFILE_ACCENT_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS: LocalProfile = {
  username: 'Guest User',
  memberSince: new Date().toISOString(),
  accentColor: '#ffffff',
  bio: '',
};

function normalizeMemberSince(value: unknown): string {
  if (typeof value !== 'string') return DEFAULTS.memberSince;

  const trimmed = value.trim();
  if (!trimmed) return DEFAULTS.memberSince;
  if (/^\d{4}$/.test(trimmed)) {
    return new Date(`${trimmed}-01-01T00:00:00.000Z`).toISOString();
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? DEFAULTS.memberSince : new Date(parsed).toISOString();
}

function sanitizeProfile(value: unknown): LocalProfile {
  const raw = typeof value === 'object' && value !== null
    ? (value as Partial<Record<keyof LocalProfile, unknown>>)
    : {};

  const username =
    typeof raw.username === 'string' && raw.username.trim().length > 0
      ? raw.username.trim().slice(0, PROFILE_NAME_MAX_LENGTH)
      : DEFAULTS.username;
  const bio = typeof raw.bio === 'string'
    ? raw.bio.trim().slice(0, PROFILE_BIO_MAX_LENGTH)
    : DEFAULTS.bio;
  const accentColor =
    typeof raw.accentColor === 'string' && PROFILE_ACCENT_COLOR_REGEX.test(raw.accentColor.trim())
      ? raw.accentColor.trim()
      : DEFAULTS.accentColor;

  return {
    username,
    memberSince: normalizeMemberSince(raw.memberSince),
    accentColor,
    bio,
  };
}

function load(): LocalProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return sanitizeProfile(JSON.parse(raw));
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

function save(profile: LocalProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeProfile(profile)));
  } catch {
    // ignore
  }
}

export function useLocalProfile() {
  const [profile, setProfileState] = useState<LocalProfile>(load);

  const updateProfile = useCallback((updates: Partial<LocalProfile>) => {
    setProfileState((prev) => {
      const next = sanitizeProfile({ ...prev, ...updates });
      save(next);
      return next;
    });
  }, []);

  return { profile, updateProfile };
}
