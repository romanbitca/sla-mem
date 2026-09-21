/**
 * localStorage wrappers. Storage can throw (Safari private mode, disabled cookies, quota),
 * and a preference that fails to persist must never break the UI.
 */

const PREFIX = 'slack-archive:';

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Preference simply won't survive a reload.
  }
}

export function readJsonPref<T>(key: string, fallback: T): T {
  const raw = readPref(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonPref(key: string, value: unknown): void {
  writePref(key, JSON.stringify(value));
}
