// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { SettingsDTO } from '../shared/types';
import { App } from './App';
import {
  appFixtures,
  BLOCKED_ERROR,
  installFixtureBridge,
  makeConversation,
  makeRun,
  makeSettings,
  makeSyncStatus,
  NOT_CONNECTED,
} from './test/helpers';

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  window.location.hash = '';
});

describe('App', () => {
  it('shows onboarding (and nothing else) until it’s complete', async () => {
    installFixtureBridge(
      appFixtures({
        getSettings: makeSettings({ connection: NOT_CONNECTED, preferences: { onboardingComplete: false } }),
      }),
    );
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome to Slamem' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).toBeNull();
  });

  it('resumes onboarding at the last step for someone who already connected', async () => {
    installFixtureBridge(appFixtures({ getSettings: makeSettings({ preferences: { onboardingComplete: false } }) }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Getting your history' })).toBeTruthy();
  });

  it('opens the archive when onboarding is done', async () => {
    installFixtureBridge(appFixtures());
    render(<App />);
    expect(await screen.findByRole('link', { name: /general/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '9H archive' })).toBeTruthy();
  });

  it('never locks anyone out when settings can’t be loaded, and doesn’t retry in a loop', async () => {
    const bridge = installFixtureBridge(appFixtures({ getSettings: BLOCKED_ERROR }));
    render(<App />);
    expect(await screen.findByText('Some settings couldn’t be loaded.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /general/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    const settingsCalls = bridge.call.mock.calls.filter(([method]) => method === 'getSettings').length;
    expect(settingsCalls).toBeLessThanOrEqual(3);
  });

  it('applies pushed events: sync progress, settings (theme) and navigation', async () => {
    const bridge = installFixtureBridge(appFixtures());
    render(<App />);
    await screen.findByText(/Synced .* ago/);

    bridge.emit(
      'sync-status',
      makeSyncStatus({
        running: true,
        currentRun: makeRun({ id: 2, status: 'running', finishedAt: null }),
        progress: { phase: 'history', message: 'Fetching #general — 1,240 messages so far', current: 3, total: 12 },
      }),
    );
    expect(await screen.findByText('Syncing… 3 of 12')).toBeTruthy();

    const dark: SettingsDTO = makeSettings({ preferences: { theme: 'dark' } });
    bridge.emit('settings', dark);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    bridge.emit('settings', makeSettings({ preferences: { theme: 'system' } }));
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));

    bridge.emit('navigate', { path: '/settings' });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    // Anything that isn't an in-app path is ignored.
    bridge.emit('navigate', { path: 'https://evil.example.com/' });
    bridge.emit('navigate', { path: '//evil.example.com' });
    expect(window.location.hash).toBe('#/settings');
  });

  it('refreshes the archive when a sync finishes', async () => {
    let conversations = [makeConversation('C1', 'general', { messageCount: 3 })];
    const bridge = installFixtureBridge(appFixtures({ getConversations: () => conversations }));
    render(<App />);
    await screen.findByRole('link', { name: /general/ });

    bridge.emit('sync-status', makeSyncStatus({ running: true, currentRun: makeRun({ id: 2, status: 'running' }) }));
    await screen.findByText(/Syncing…/);
    conversations = [...conversations, makeConversation('C9', 'launch-party', { messageCount: 7 })];
    bridge.emit('sync-status', makeSyncStatus({ running: false }));
    expect(await screen.findByRole('link', { name: /launch-party/ })).toBeTruthy();
  });

  it('unsubscribes from main’s events when it goes away', async () => {
    const bridge = installFixtureBridge(appFixtures());
    const { unmount } = render(<App />);
    await waitFor(() => expect(bridge.listenerCount('sync-status')).toBe(1));
    unmount();
    expect(bridge.listenerCount('sync-status')).toBe(0);
    expect(bridge.listenerCount('navigate')).toBe(0);
  });
});
