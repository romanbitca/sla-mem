/**
 * The tray / menu-bar icon (PLAN §8.3): the app keeps syncing after its window is closed, so the
 * icon is how people reach it — Open, Sync now, when it last synced, Settings, Quit — and a small
 * badge shows while a sync runs.
 */
import path from 'node:path';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

export interface TrayState {
  syncing: boolean;
  connected: boolean;
  lastSuccessAt: number | null;
  /** A short problem line ("Slack signed you out"), shown instead of the last-sync time. */
  problem: string | null;
}

export interface TrayActions {
  open(): void;
  syncNow(): void;
  settings(): void;
  quit(): void;
}

export interface TrayController {
  update(state: TrayState): void;
  showBalloonOnce(title: string, content: string): void;
  destroy(): void;
}

export function createTray(resourcesDir: string, actions: TrayActions): TrayController {
  const mac = process.platform === 'darwin';
  const icon = (syncing: boolean): NativeImage => {
    const name = mac ? (syncing ? 'traySyncingTemplate' : 'trayTemplate') : syncing ? 'tray-win-syncing' : 'tray-win';
    const image = nativeImage.createFromPath(path.join(resourcesDir, `${name}.png`));
    if (mac) image.setTemplateImage(true);
    return image;
  };
  const tray = new Tray(icon(false));
  let state: TrayState = { syncing: false, connected: false, lastSuccessAt: null, problem: null };
  let lastIconSyncing = false;

  const render = () => {
    const status = state.syncing
      ? 'Syncing…'
      : state.problem
        ? state.problem
        : !state.connected
          ? 'Not connected to Slack'
          : state.lastSuccessAt
            ? `Last synced ${relativeTime(state.lastSuccessAt, Date.now())}`
            : 'Not synced yet';
    tray.setToolTip(`Slack Archive — ${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Slack Archive', click: actions.open },
        {
          label: state.syncing ? 'Syncing…' : 'Sync now',
          enabled: !state.syncing && state.connected,
          click: actions.syncNow,
        },
        { label: status, enabled: false },
        { type: 'separator' },
        { label: 'Settings…', click: actions.settings },
        { label: 'Quit Slack Archive', click: actions.quit },
      ]),
    );
    if (state.syncing !== lastIconSyncing) {
      tray.setImage(icon(state.syncing));
      lastIconSyncing = state.syncing;
    }
  };

  // Windows: a left click opens the window (the menu is on right click); macOS shows the menu.
  if (!mac) tray.on('click', actions.open);
  render();
  // "Last synced 3 minutes ago" goes stale on its own.
  const refresh = setInterval(render, 60_000);
  refresh.unref?.();

  return {
    update(next) {
      state = next;
      render();
    },
    showBalloonOnce(title, content) {
      if (process.platform === 'win32') tray.displayBalloon({ title, content, iconType: 'info' });
    },
    destroy() {
      clearInterval(refresh);
      tray.destroy();
    },
  };
}

export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
