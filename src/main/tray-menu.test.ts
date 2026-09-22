import { describe, expect, it } from 'vitest';
import { IDLE_TRAY_STATE, trayMenu, type TrayMenuItem, type TrayState } from './tray-menu';

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const labels = (items: TrayMenuItem[]) => items.map((i) => ('separator' in i ? '—' : i.label));

describe('tray menu (PLAN §8.3)', () => {
  const connected: TrayState = { ...IDLE_TRAY_STATE, connected: true, lastSuccessAt: NOW - 5 * 60_000 };

  it('offers Sync now and says when the archive last synced', () => {
    expect(labels(trayMenu(connected, NOW))).toEqual([
      'Open Slamem',
      'Sync now',
      'Last synced 5 minutes ago',
      '—',
      'Settings…',
      'Quit Slamem',
    ]);
  });

  it('says "Syncing…" once while a sync runs, with how far it has got', () => {
    const syncing = { ...connected, syncing: true, progress: { current: 12, total: 111 } };
    const items = labels(trayMenu(syncing, NOW));
    expect(items).toEqual(['Open Slamem', 'Syncing… 12 of 111', '—', 'Settings…', 'Quit Slamem']);
    expect(labels(trayMenu({ ...syncing, progress: null }, NOW)).filter((l) => l.startsWith('Syncing'))).toEqual([
      'Syncing…',
    ]);
  });

  it('shows a problem instead of the last sync, and no Sync now without Slack', () => {
    const signedOut = { ...connected, problem: 'Slack signed you out' };
    expect(labels(trayMenu(signedOut, NOW))).toContain('Slack signed you out');
    const offline = trayMenu(IDLE_TRAY_STATE, NOW);
    expect(offline).toContainEqual({ label: 'Sync now', enabled: false, action: 'syncNow' });
    expect(labels(offline)).toContain('Not connected to Slack');
  });
});
