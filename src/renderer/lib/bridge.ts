/**
 * Access to `window.archive`, the bridge the preload script exposes (src/preload/index.ts). It is
 * absent in unit tests (and would be if this page were ever opened outside the app), so callers
 * go through here and cope with null instead of crashing on an undefined global.
 */
import type { ArchiveBridge } from '../../shared/ipc';

export type Platform = ArchiveBridge['platform'];

export function getBridge(): ArchiveBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Partial<Window>).archive;
  return bridge ?? null;
}

/** The OS the app runs on: from the bridge, or guessed from the user agent (tests, previews). */
export function currentPlatform(): Platform {
  const fromBridge = getBridge()?.platform;
  if (fromBridge) return fromBridge;
  const ua = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/i.test(ua)) return 'darwin';
  if (/Win/i.test(ua)) return 'win32';
  return 'linux';
}
