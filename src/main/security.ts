/**
 * Security posture of the main window (PLAN §3.6): it loads local files only, never navigates,
 * never opens windows, and hands links to the system browser after checking the scheme.
 */
import { shell, type Session, type WebContents } from 'electron';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Only http(s) and mailto links may leave the app; everything else is ignored. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return EXTERNAL_SCHEMES.has(url.protocol) && (url.protocol === 'mailto:' || url.hostname !== '');
  } catch {
    return false;
  }
}

export async function openExternalSafe(raw: string): Promise<boolean> {
  if (!isSafeExternalUrl(raw)) return false;
  await shell.openExternal(new URL(raw).href);
  return true;
}

/**
 * Locks down a window that shows the archive UI: no popups, no navigation away from the app, no
 * webviews. Links clicked anyway (e.g. middle-click) go to the system browser.
 */
export function hardenWebContents(contents: WebContents, isAppUrl: (url: string) => boolean): void {
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void openExternalSafe(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** The archive UI needs no device or web permissions; only writing to the clipboard (Copy link). */
export function denyPermissions(session: Session): void {
  const allowed = new Set(['clipboard-sanitized-write']);
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}
