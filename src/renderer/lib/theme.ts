/**
 * Light/dark theme. The preference lives in main (`SettingsDTO.preferences.theme`), which also
 * applies it to Electron's nativeTheme, so `prefers-color-scheme` already matches it when the
 * window opens (no flash). The renderer additionally pins `<html data-theme>` from the setting so
 * a change in Settings is instant, before main's round trip. 'system' removes the pin.
 */
import { useEffect } from 'react';
import type { ThemePreference } from '../../shared/types';
import { useSettings } from './queries';

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
  else root.removeAttribute('data-theme');
}

export const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Mount once: keeps `<html data-theme>` in step with the saved (or optimistic) preference. */
export function useAppliedTheme(): void {
  const theme = useSettings().data?.preferences.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
}
