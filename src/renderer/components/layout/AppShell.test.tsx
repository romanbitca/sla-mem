// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, type Location } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { AppProviders, AppRoutes } from '../../App';
import {
  makeConversation,
  makeLoginStatus,
  makeMessage,
  makeSettings,
  makeStats,
  makeStorage,
  makeSyncStatus,
  makeWorkspace,
  testQueryClient,
  testUsers,
} from '../../test/helpers';
import { buildSections } from './Sidebar';
import { describeSync } from './SyncIndicator';

const conversations = [
  makeConversation('C2', 'random', { messageCount: 1200 }),
  makeConversation('C1', 'general', { messageCount: 42 }),
  makeConversation('G1', 'secret-plans', { type: 'private_channel' }),
  makeConversation('C3', 'old-stuff', { isArchived: true }),
  makeConversation('D1', 'Bob', { type: 'im', rawName: null, dmUserId: 'U2' }),
  makeConversation('M1', 'Bob, Carol', { type: 'mpim', rawName: 'mpdm-bob--carol-1' }),
];

let location: Location | null = null;
function LocationProbe() {
  location = useLocation();
  return null;
}

function renderApp(route = '/') {
  return render(
    <AppProviders client={testQueryClient()}>
      <MemoryRouter initialEntries={[route]} useTransitions={false}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  );
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(api, 'getUsers').mockResolvedValue(testUsers);
  vi.spyOn(api, 'getConversations').mockResolvedValue(conversations);
  vi.spyOn(api, 'getEmoji').mockResolvedValue({});
  vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace({ teamName: '9hdigital', teamDomain: '9hdigital' }));
  vi.spyOn(api, 'getSyncStatus').mockResolvedValue(makeSyncStatus());
  vi.spyOn(api, 'getSettings').mockResolvedValue(makeSettings());
  vi.spyOn(api, 'getStats').mockResolvedValue(makeStats());
  vi.spyOn(api, 'getStorage').mockResolvedValue(makeStorage());
  vi.spyOn(api, 'getAppInfo').mockRejectedValue(new ApiError('blocked', 'This isn’t available yet.'));
  vi.spyOn(api, 'getUpdateInfo').mockRejectedValue(new ApiError('blocked', 'This isn’t available yet.'));
  vi.spyOn(api, 'getLoginStatus').mockResolvedValue(makeLoginStatus());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe('buildSections', () => {
  it('groups channels (sorted), DMs and group DMs and filters by name', () => {
    const [channels, dms, groups] = buildSections(conversations, '');
    expect(channels.items.map((c) => c.id)).toEqual(['C1', 'C3', 'C2', 'G1']);
    expect(dms.items.map((c) => c.id)).toEqual(['D1']);
    expect(groups.items.map((c) => c.id)).toEqual(['M1']);
    const filtered = buildSections(conversations, 'CAROL');
    expect(filtered.flatMap((s) => s.items.map((c) => c.id))).toEqual(['M1']);
  });
});

describe('describeSync', () => {
  it('says what syncing is doing in a few words', () => {
    expect(describeSync(undefined, null, false)).toMatchObject({ text: 'Checking…' });
    expect(describeSync(undefined, new ApiError('blocked', 'x'), false)).toMatchObject({
      text: 'Sync status unavailable',
      tone: 'warn',
    });
    const running = makeSyncStatus({
      running: true,
      progress: { phase: 'history', message: '#general', current: 3, total: 12 },
    });
    expect(describeSync(running, null, false)).toMatchObject({ text: 'Syncing… 3 of 12', tone: 'busy' });
    const signedOut = makeSyncStatus({
      problem: { kind: 'signed_out', message: 'Slack signed you out.', action: 'reconnect' },
    });
    expect(describeSync(signedOut, null, false)).toMatchObject({ text: 'Reconnect Slack', toSettings: true });
    expect(describeSync(makeSyncStatus(), null, true)).toMatchObject({ text: 'Connect Slack', toSettings: true });
    const failed = makeSyncStatus({ problem: { kind: 'offline', message: 'Can’t reach Slack.', action: 'retry' } });
    expect(describeSync(failed, null, false)).toMatchObject({ text: 'Last sync didn’t finish', tone: 'bad' });
    expect(describeSync(makeSyncStatus({ stale: true }), null, false).tone).toBe('warn');
    expect(describeSync(makeSyncStatus({ lastSuccessAt: null, recentRuns: [] }), null, false).text).toBe(
      'Not synced yet',
    );
  });
});

describe('AppShell', () => {
  it('lists conversations by section with counts, lock icons and dimmed archived channels', async () => {
    renderApp();
    const nav = await screen.findByRole('link', { name: /general/ });
    expect(nav.getAttribute('href')).toBe('/c/C1');
    expect(screen.getByText('1.2k')).toBeTruthy();
    expect(screen.getByRole('link', { name: /old-stuff/ }).className).toContain('text-ink-faint');
    expect(screen.getByText('Direct messages')).toBeTruthy();
    expect(screen.getByText('Group DMs')).toBeTruthy();
    expect(screen.getAllByText('9hdigital').length).toBeGreaterThan(0);
    await screen.findByText(/Synced .* ago/);
  });

  it('focuses the search box on Ctrl/Cmd+K and submits to /search', async () => {
    renderApp();
    const search = screen.getByRole('searchbox', { name: 'Search archive' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.change(search, { target: { value: 'from:@bob deploy' } });
    fireEvent.submit(search.closest('form')!);
    await waitFor(() => expect(location?.pathname).toBe('/search'));
    expect(new URLSearchParams(location!.search).get('q')).toBe('from:@bob deploy');
  });

  it('moves through the filtered list with arrow keys and opens with Enter', async () => {
    vi.spyOn(api, 'getConversation').mockResolvedValue(conversations[0]);
    vi.spyOn(api, 'getMessages').mockResolvedValue({ messages: [], hasMoreBefore: false, hasMoreAfter: false });
    renderApp();
    await screen.findByRole('link', { name: /general/ });
    const filter = screen.getByRole('searchbox', { name: 'Filter conversations' });

    fireEvent.change(filter, { target: { value: 'e' } }); // general, secret-plans
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' }); // clamped at the last item
    expect(filter.getAttribute('aria-activedescendant')).toBe('sidebar-item-1');
    fireEvent.keyDown(filter, { key: 'ArrowUp' });
    expect(filter.getAttribute('aria-activedescendant')).toBe('sidebar-item-0');
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(location?.pathname).toBe('/c/G1'));

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect((filter as HTMLInputElement).value).toBe('');
  });

  it('collapses a section and remembers it', async () => {
    renderApp();
    await screen.findByRole('link', { name: /general/ });
    fireEvent.click(screen.getByRole('button', { name: /Channels/ }));
    expect(screen.queryByRole('link', { name: /general/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Bob' })).toBeTruthy();
    cleanup();
    renderApp();
    await screen.findByRole('link', { name: 'Bob' });
    expect(screen.queryByRole('link', { name: /general/ })).toBeNull();
  });

  it('routes channel links inside messages instead of leaving the app', async () => {
    const general = conversations[1];
    vi.spyOn(api, 'getConversation').mockResolvedValue(general);
    vi.spyOn(api, 'getMessages').mockResolvedValue({
      messages: [makeMessage({ ts: '1700000000.000100', conversationId: 'C1', text: 'see <#C2|random>' })],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    renderApp('/c/C1');
    const article = await screen.findByRole('article');
    const mention = within(article).getByRole('link', { name: '#random' });
    expect(mention.getAttribute('href')).toBe('/c/C2');
    fireEvent.click(mention);
    await waitFor(() => expect(location?.pathname).toBe('/c/C2'));
  });

  it('says so when sync status can’t be loaded, without blocking the archive', async () => {
    vi.spyOn(api, 'getSyncStatus').mockRejectedValue(new ApiError('blocked', 'This isn’t available yet.'));
    renderApp();
    expect(await screen.findByText('Sync status unavailable')).toBeTruthy();
    expect(await screen.findByRole('link', { name: /general/ })).toBeTruthy();
  });

  it('links to Settings from the footer and opens the settings page', async () => {
    renderApp();
    const gear = screen.getByRole('link', { name: 'Settings' });
    expect(gear.getAttribute('href')).toBe('/settings');
    fireEvent.click(gear);
    await waitFor(() => expect(location?.pathname).toBe('/settings'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Slack connection' })).toBeTruthy();
  });

  it('points the sync indicator at Settings while Slack isn’t connected', async () => {
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(
      makeWorkspace({ teamId: null, teamName: null, teamDomain: null, selfUserId: null, connected: false }),
    );
    vi.spyOn(api, 'getSyncStatus').mockResolvedValue(
      makeSyncStatus({ recentRuns: [], lastSuccessAt: null, blockedReason: 'Connect Slack to start syncing.' }),
    );
    renderApp();
    const indicator = (await screen.findByText('Connect Slack', { selector: '[role="status"]' })).closest('a')!;
    expect(indicator.getAttribute('href')).toBe('/settings');
    expect(screen.getAllByText('Slack Archive').length).toBeGreaterThan(0);
  });

  it('shows the workspace name and host', async () => {
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace({ teamName: '9H', teamDomain: '9h' }));
    renderApp();
    expect((await screen.findAllByText('9H')).length).toBeGreaterThan(0);
    expect(screen.getByText('9h.slack.com · archive')).toBeTruthy();
    expect((await screen.findByText(/Synced .* ago/)).closest('a')!.getAttribute('href')).toBe('/');
  });

  it('routes unknown paths to a not-found page', async () => {
    renderApp('/nope');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});
