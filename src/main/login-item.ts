/**
 * "Start Slack Archive when I log in" (PLAN §5.3: default on, because a user who doesn't open the
 * app for three months loses that period for good). The app then starts in the background: no
 * window, just the tray icon and the scheduled syncs.
 */
import { app } from 'electron';

const HIDDEN_ARG = '--hidden';

/** Registers or removes the login item. Development builds never register the bare Electron binary. */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } else if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
  }
}

/** True when the OS started us at login (so the window stays hidden). */
export function wasOpenedAtLogin(argv: readonly string[] = process.argv): boolean {
  if (argv.includes(HIDDEN_ARG)) return true;
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }
  return false;
}
