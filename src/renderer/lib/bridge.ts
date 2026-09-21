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

/** What the OS calls its file browser, for "Show in Finder" / "Show in Explorer" (PLAN §3.4). */
export function fileBrowserName(platform: Platform = currentPlatform()): string | null {
  if (platform === 'darwin') return 'Finder';
  if (platform === 'win32') return 'Explorer';
  return null;
}

/** Where the app's icon lives while it runs in the background: "menu bar" (macOS) or "system tray". */
export function trayPlaceName(platform: Platform = currentPlatform()): string {
  return platform === 'darwin' ? 'menu bar' : 'system tray';
}

/** Where people open the app from again when it has no icon in the menu bar / tray. */
export function reopenHint(platform: Platform = currentPlatform()): string {
  return platform === 'win32' ? 'the Start menu' : 'Applications or the Dock';
}

/** The OS the app runs on: from the bridge, or guessed from the user agent (tests, previews). */
export function currentPlatform(): Platform {
  const fromBridge = getBridge()?.platform;
  if (fromBridge) return fromBridge;
  const ua = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`;
  // Careful: "darwin" contains "win".
  if (/Mac|darwin|iPhone|iPad/i.test(ua)) return 'darwin';
  if (/Windows|Win32|Win64/i.test(ua)) return 'win32';
  return 'linux';
}
