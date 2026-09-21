/**
 * The real Slack sign-in window (PLAN §2.3–2.4): Slack's own pages in an app window with a
 * persistent partition (so reconnecting later doesn't always mean signing in again), a normal
 * Chrome user agent (Google blocks sign-in from "embedded browsers"), no preload and no Node — it's
 * an ordinary, sandboxed browsing window. Popups (SSO) stay inside the same locked-down session;
 * other URL schemes (e.g. slack:// "open the desktop app") are ignored.
 */
import { BrowserWindow, session, type Session } from 'electron';
import type { Logger } from '../logger';
import { isSessionCookieDomain, isDefaultWebOrigin } from './origin';
import { isWorkspaceHost, type SignInSurface } from './signin';

export const SLACK_PARTITION = 'persist:slack';

export interface ElectronSignInOptions {
  webOrigin: string;
  log: Logger;
  parent?: BrowserWindow | null;
}

const configured = new WeakSet<Session>();

/** A plain Chrome user agent for this Chromium: Electron's with the app and Electron tokens removed. */
export function chromeUserAgent(defaultUserAgent: string): string {
  return defaultUserAgent
    .split(' ')
    .filter((token) => !/^(Electron|sla-mem|Slack(%20|\s)?Archive)\//i.test(token))
    .join(' ');
}

/** The Slack session: our user agent, no permissions, no downloads. Configured once. */
export function slackSession(): Session {
  const ses = session.fromPartition(SLACK_PARTITION);
  if (!configured.has(ses)) {
    configured.add(ses);
    ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  }
  return ses;
}

/** Disconnect: forget the Slack web session kept for the sign-in window (PLAN §3.5). */
export async function clearSlackSession(): Promise<void> {
  const ses = session.fromPartition(SLACK_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
}

export function createElectronSignInSurface(opts: ElectronSignInOptions): SignInSurface {
  const ses = slackSession();
  let win: BrowserWindow | null = null;
  let closedListener: (() => void) | null = null;
  const visited: string[] = [];
  const webOriginHost = new URL(opts.webOrigin).hostname;

  const remember = (url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!isWorkspaceHost(host)) return;
      const i = visited.indexOf(host);
      if (i >= 0) visited.splice(i, 1);
      visited.unshift(host);
    } catch {
      // not a URL we care about
    }
  };

  const allowedNavigation = (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.href === 'about:blank') return true;
      // The development mock Slack runs on plain http on localhost.
      return !isDefaultWebOrigin(opts.webOrigin) && u.protocol === 'http:' && u.hostname === webOriginHost;
    } catch {
      return false;
    }
  };

  const secureWebPreferences = {
    session: ses,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    navigateOnDragDrop: false,
  } as const;

  return {
    open(url) {
      win = new BrowserWindow({
        width: 1000,
        height: 760,
        title: 'Sign in to Slack — sla-mem',
        autoHideMenuBar: true,
        show: true,
        webPreferences: secureWebPreferences,
      });
      const contents = win.webContents;
      contents.setWindowOpenHandler(({ url: target }) =>
        allowedNavigation(target)
          ? {
              action: 'allow',
              overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences },
            }
          : { action: 'deny' },
      );
      contents.on('will-navigate', (event, target) => {
        if (!allowedNavigation(target)) event.preventDefault();
      });
      contents.on('will-redirect', (event, target) => {
        if (!allowedNavigation(target)) event.preventDefault();
      });
      contents.on('did-navigate', (_event, target) => remember(target));
      contents.on('did-navigate-in-page', (_event, target) => remember(target));
      contents.on('will-attach-webview', (event) => event.preventDefault());
      win.on('closed', () => {
        win = null;
        closedListener?.();
      });
      void win
        .loadURL(url)
        .catch((err: unknown) => opts.log.warn(`Sign-in window: could not load Slack (${String(err)})`));
    },
    navigate(url) {
      if (win && !win.isDestroyed()) void win.loadURL(url).catch(() => undefined);
    },
    close() {
      const w = win;
      closedListener = null;
      if (w && !w.isDestroyed()) w.destroy();
      win = null;
    },
    isOpen() {
      return win != null && !win.isDestroyed();
    },
    currentUrl() {
      return win && !win.isDestroyed() ? win.webContents.getURL() : null;
    },
    async getSessionCookie() {
      const cookies = await ses.cookies.get({ name: 'd' });
      const match = cookies.find(
        (c) => c.domain && isSessionCookieDomain(c.domain, opts.webOrigin) && /^xoxd-|^xoxd%2D/i.test(c.value),
      );
      return match?.value ?? null;
    },
    async readLocalConfig() {
      if (!win || win.isDestroyed()) return null;
      try {
        if (new URL(win.webContents.getURL()).origin !== opts.webOrigin) return null;
        const value: unknown = await win.webContents.executeJavaScript(
          'window.localStorage.getItem("localConfig_v2")',
          true,
        );
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    },
    onClosed(listener) {
      closedListener = listener;
    },
    visitedWorkspaceHosts() {
      return [...visited];
    },
  };
}
