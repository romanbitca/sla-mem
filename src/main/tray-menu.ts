/**
 * What the tray / menu-bar menu says, as plain data (tray.ts turns it into Electron menu items).
 * Kept free of Electron so it can be tested.
 */

export interface TrayState {
  syncing: boolean;
  connected: boolean;
  lastSuccessAt: number | null;
  /** A short problem line ("Slack signed you out"), shown instead of the last-sync time. */
  problem: string | null;
  /** How far the running sync has got, when it knows ("12 of 111" conversations). */
  progress: { current: number; total: number } | null;
}

export const IDLE_TRAY_STATE: TrayState = {
  syncing: false,
  connected: false,
  lastSuccessAt: null,
  problem: null,
  progress: null,
};

export type TrayAction = 'open' | 'syncNow' | 'settings' | 'quit';

export type TrayMenuItem = { label: string; enabled: boolean; action: TrayAction | null } | { separator: true };

/** The one status line: sync progress, a problem, or when the archive last synced. */
export function trayStatus(state: TrayState, now: number): string {
  if (state.syncing) return syncingLabel(state.progress);
  if (state.problem) return state.problem;
  if (!state.connected) return 'Not connected to Slack';
  return state.lastSuccessAt ? `Last synced ${relativeTime(state.lastSuccessAt, now)}` : 'Not synced yet';
}

export function trayMenu(state: TrayState, now: number): TrayMenuItem[] {
  return [
    { label: 'Open sla-mem', enabled: true, action: 'open' },
    // While syncing, the progress line says it all; "Sync now" comes back when it's done.
    ...(state.syncing ? [] : [{ label: 'Sync now', enabled: state.connected, action: 'syncNow' as const }]),
    { label: trayStatus(state, now), enabled: false, action: null },
    { separator: true },
    { label: 'Settings…', enabled: true, action: 'settings' },
    { label: 'Quit sla-mem', enabled: true, action: 'quit' },
  ];
}

export function syncingLabel(progress: TrayState['progress']): string {
  return progress && progress.total > 0
    ? `Syncing… ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`
    : 'Syncing…';
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
