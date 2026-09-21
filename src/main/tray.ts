/**
 * The tray / menu-bar icon (PLAN §8.3): the app keeps syncing after its window is closed, so the
 * icon is how people reach it — Open, Sync now, when it last synced (or how far a sync has got),
 * Settings, Quit — and a small badge shows while a sync runs. It can be turned off in Settings.
 */
import path from 'node:path';
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { IDLE_TRAY_STATE, trayMenu, trayStatus, type TrayAction, type TrayState } from './tray-menu';

export { IDLE_TRAY_STATE, type TrayState } from './tray-menu';

export type TrayActions = Record<TrayAction, () => void>;

export interface TrayController {
  update(state: TrayState): void;
  showBalloonOnce(title: string, content: string): void;
  destroy(): void;
}

export function createTray(
  resourcesDir: string,
  actions: TrayActions,
  initial: TrayState = IDLE_TRAY_STATE,
): TrayController {
  const mac = process.platform === 'darwin';
  const icon = (syncing: boolean): NativeImage => {
    const name = mac ? (syncing ? 'traySyncingTemplate' : 'trayTemplate') : syncing ? 'tray-win-syncing' : 'tray-win';
    const image = nativeImage.createFromPath(path.join(resourcesDir, `${name}.png`));
    if (mac) image.setTemplateImage(true);
    return image;
  };
  let state: TrayState = initial;
  const tray = new Tray(icon(state.syncing));
  let lastIconSyncing = state.syncing;

  const render = () => {
    const now = Date.now();
    tray.setToolTip(`sla-mem — ${trayStatus(state, now)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenu(state, now).map((item): MenuItemConstructorOptions =>
          'separator' in item
            ? { type: 'separator' }
            : {
                label: item.label,
                enabled: item.enabled,
                click: item.action ? actions[item.action] : undefined,
              },
        ),
      ),
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
