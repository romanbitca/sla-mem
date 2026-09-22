/**
 * Events main pushes to the window (src/shared/ipc.ts `ArchiveEvents`), written straight into
 * the react-query cache so every screen shows live sync progress, sign-in steps, settings and
 * update availability without polling. Ask AI's answers go to its chat (askChat.ts), which lives
 * outside any screen so an answer keeps arriving while the reader looks at a cited message.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SettingsDTO } from '../../shared/types';
import { applyAiEvent } from './askChat';
import { getBridge } from './bridge';
import { useStableCallback } from './hooks';
import { applyLoginStatus, qk } from './queries';

export { applyLoginStatus };

/** Routes main may ask for: app paths only (`/settings`, `/c/C123?ts=…`), never URLs. */
export function isAppPath(path: unknown): path is string {
  return typeof path === 'string' && /^\/(?!\/)[^\s\\]*$/.test(path) && path.length <= 2000;
}

function connectionChanged(prev: SettingsDTO | undefined, next: SettingsDTO): boolean {
  if (!prev) return false;
  const a = prev.connection;
  const b = next.connection;
  return a.connected !== b.connected || a.expired !== b.expired || a.teamId !== b.teamId;
}

export function applySettings(qc: QueryClient, settings: SettingsDTO): void {
  const prev = qc.getQueryData<SettingsDTO>(qk.settings);
  qc.setQueryData(qk.settings, settings);
  if (connectionChanged(prev, settings)) {
    void qc.invalidateQueries({ queryKey: qk.workspace });
    void qc.invalidateQueries({ queryKey: qk.syncStatus });
  }
}

/** Mount once, inside the router. A no-op outside the app (no bridge), e.g. in unit tests. */
export function useArchiveEvents(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const go = useStableCallback((path: string) => navigate(path));

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    const unsubscribe = [
      bridge.on('sync-status', (status) => qc.setQueryData(qk.syncStatus, status)),
      bridge.on('login-status', (status) => applyLoginStatus(qc, status)),
      bridge.on('settings', (settings) => applySettings(qc, settings)),
      bridge.on('update', (info) => qc.setQueryData(qk.updateInfo, info)),
      bridge.on('navigate', (payload) => {
        if (isAppPath(payload?.path)) go(payload.path);
      }),
      bridge.on('ai', applyAiEvent),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, [qc, go]);
}
