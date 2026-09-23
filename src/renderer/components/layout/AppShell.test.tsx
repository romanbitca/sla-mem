// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, type Location } from 'react-router';
import type { SearchParams, SearchResponse } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { resetSearchNav } from '../../lib/searchNav';
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
  tsAt,
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
  resetSearchNav();
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
    expect(describeSync(signedOut, null, false)).toMatchObject({ text: 'Reconnect Slack', tone: 'warn' });
    expect(describeSync(makeSyncStatus(), null, true)).toMatchObject({ text: 'Connect Slack', tone: 'warn' });
    const failed = makeSyncStatus({ problem: { kind: 'offline', message: 'Can’t reach Slack.', action: 'retry' } });
    expect(describeSync(failed, null, false)).toMatchObject({ text: 'Last sync didn’t finish', tone: 'bad' });
    expect(describeSync(makeSyncStatus({ stale: true }), null, false).tone).toBe('warn');
    expect(describeSync(makeSyncStatus({ lastSuccessAt: null, recentRuns: [] }), null, false).text).toBe(
      'Not synced yet',
    );
  });

  it('keeps “synced … ago” current and never announces the ticking parts', () => {
    const at = Date.now() - 10 * 60_000;
    const status = makeSyncStatus({ lastSuccessAt: at });
    expect(describeSync(status, null, false, at + 5 * 60_000).text).toBe('Synced 5 minutes ago');
    expect(describeSync(status, null, false, at + 2 * 3_600_000).text).toBe('Synced 2 hours ago');
    expect(describeSync(status, null, false).announce).toBe('Synced');
    const running = makeSyncStatus({
      running: true,
      progress: { phase: 'history', message: 'Fetching #general — 40 messages so far', current: 3, total: 12 },
    });
    expect(describeSync(running, null, false)).toMatchObject({
      announce: 'Syncing…',
      detail: 'Fetching #general — 40 messages so far',
    });
  });

  it('says when syncing is blocked instead of showing a green “synced”', () => {
    const blocked = makeSyncStatus({ blockedReason: 'Your disk is full, so new messages can’t be saved.' });
    expect(describeSync(blocked, null, false)).toMatchObject({
      text: 'Sync paused',
      tone: 'warn',
      detail: 'Your disk is full, so new messages can’t be saved.',
    });
    expect(describeSync(makeSyncStatus({ blockedReason: 'ENOSPC' }), null, false).detail).toBe(
      'Syncing isn’t possible right now.',
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

  it('opens search from the sidebar and with Ctrl/Cmd+K, with the cursor in the box', async () => {
    vi.spyOn(api, 'search').mockImplementation(async (params) => searchResponse(params, []));
    renderApp();
    const searchLink = await screen.findByRole('link', { name: /^Search/ });
    expect(searchLink.getAttribute('href')).toBe('/search');
    expect(screen.queryByRole('searchbox', { name: 'Search archive' })).toBeNull(); // no box in the sidebar

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(location?.pathname).toBe('/search'));
    const box = await screen.findByRole('combobox', { name: 'Search messages' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    // Ready to type, without the suggestions popping up before anything is typed.
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(box, { target: { value: 'from:@bob deploy' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(new URLSearchParams(location!.search).get('q')).toBe('from:@bob deploy'));

    // From anywhere else, Search comes back to that search.
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    await waitFor(() => expect(location?.pathname).toBe('/'));
    expect(screen.getByRole('link', { name: /^Search/ }).getAttribute('href')).toBe(
      `/search?${new URLSearchParams({ q: 'from:@bob deploy' }).toString()}`,
    );
  });

  it('has People in the sidebar, next to Ask AI', async () => {
    vi.spyOn(api, 'getPeople').mockResolvedValue([]);
    renderApp();
    const people = await screen.findByRole('link', { name: 'People' });
    expect(people.getAttribute('href')).toBe('/people');
    fireEvent.click(people);
    await waitFor(() => expect(location?.pathname).toBe('/people'));
    expect(await screen.findByRole('heading', { level: 1, name: 'People' })).toBeTruthy();
    expect(people.getAttribute('aria-current')).toBe('page');
  });

  it('goes back and forward through the pages visited, with the buttons, the keyboard and the mouse', async () => {
    vi.spyOn(api, 'getPeople').mockResolvedValue([]);
    vi.spyOn(api, 'getConversation').mockResolvedValue(conversations[1]);
    vi.spyOn(api, 'getMessages').mockResolvedValue({ messages: [], hasMoreBefore: false, hasMoreAfter: false });
    renderApp();
    // At the top of the sidebar, right of the workspace name; not in the page header.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const back = await within(sidebar).findByRole('button', { name: 'Back' });
    const forward = within(sidebar).getByRole('button', { name: 'Forward' });
    await waitFor(() =>
      expect(back.parentElement?.previousElementSibling?.textContent).toBe('9hdigital9hdigital.slack.com'),
    );
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
    expect((back as HTMLButtonElement).disabled).toBe(true);
    expect((forward as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('link', { name: 'People' }));
    await waitFor(() => expect(location?.pathname).toBe('/people'));
    fireEvent.click(screen.getByRole('link', { name: /general/ }));
    await waitFor(() => expect(location?.pathname).toBe('/c/C1'));

    const backNow = () => screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    const forwardNow = () => screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement;
    expect(backNow().disabled).toBe(false);
    fireEvent.click(backNow());
    await waitFor(() => expect(location?.pathname).toBe('/people'));
    expect(forwardNow().disabled).toBe(false);
    fireEvent.click(backNow());
    await waitFor(() => expect(location?.pathname).toBe('/'));
    expect(backNow().disabled).toBe(true);

    fireEvent.keyDown(window, { key: ']', metaKey: true });
    await waitFor(() => expect(location?.pathname).toBe('/people'));
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(location?.pathname).toBe('/c/C1'));
    expect(forwardNow().disabled).toBe(true);
    fireEvent.keyDown(window, { key: '[', metaKey: true });
    await waitFor(() => expect(location?.pathname).toBe('/people'));
    // A mouse's back button.
    fireEvent.mouseUp(window, { button: 3 });
    await waitFor(() => expect(location?.pathname).toBe('/'));
    expect(backNow().title).toMatch(/^Back \(/);
  });

  it('keeps Back and Forward in the page header while the sidebar is folded into a drawer', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, // a narrow window
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.spyOn(api, 'getPeople').mockResolvedValue([]);
    renderApp();
    const home = (await screen.findByRole('heading', { level: 1, name: 'Overview' })).closest('header')!;
    expect(within(home).getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar', hidden: true });
    expect(within(sidebar).queryByRole('button', { name: 'Back', hidden: true })).toBeNull();

    fireEvent.click(within(home).getByRole('button', { name: 'Show sidebar' }));
    fireEvent.click(screen.getByRole('link', { name: 'People' }));
    const people = (await screen.findByRole('heading', { level: 1, name: 'People' })).closest('header')!;
    fireEvent.click(within(people).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(location?.pathname).toBe('/'));
  });

  it('leaves the page shortcuts alone while a dialog is open', async () => {
    renderApp();
    await screen.findByRole('link', { name: /^Search/ });
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const inside = document.createElement('button');
    modal.append(inside);
    document.body.append(modal);
    try {
      inside.focus();
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      fireEvent.keyDown(window, { key: '/' });
      await new Promise((r) => setTimeout(r, 20));
      expect(document.activeElement).toBe(inside);
      expect(location?.pathname).toBe('/');
    } finally {
      modal.remove();
    }
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

  it('shows a clear button in the filter for as long as it holds text', async () => {
    renderApp();
    await screen.findByRole('link', { name: /general/ });
    const filter = screen.getByRole('searchbox', { name: 'Filter conversations' }) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();

    fireEvent.change(filter, { target: { value: 'gen' } });
    expect(screen.queryByRole('link', { name: 'Bob' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(filter.value).toBe('');
    expect(document.activeElement).toBe(filter);
    expect(screen.getByRole('link', { name: 'Bob' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
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

  it('says Slack needs connecting in the footer, as plain text', async () => {
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(
      makeWorkspace({ teamId: null, teamName: null, teamDomain: null, selfUserId: null, connected: false }),
    );
    vi.spyOn(api, 'getSyncStatus').mockResolvedValue(
      makeSyncStatus({ recentRuns: [], lastSuccessAt: null, blockedReason: 'Connect Slack to start syncing.' }),
    );
    renderApp();
    const line = await screen.findByText('Connect Slack', { selector: 'p span' });
    // Not a link or a button: Overview says what to do, and the gear beside it opens Settings.
    expect(line.closest('a, button')).toBeNull();
    // Screen readers hear the state once, from a live region.
    expect(screen.getByText('Connect Slack', { selector: '[role="status"]' })).toBeTruthy();
    expect(screen.getAllByText('Slamem').length).toBeGreaterThan(0);
  });

  it('shows the workspace name and host', async () => {
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace({ teamName: '9H', teamDomain: '9h' }));
    renderApp();
    expect((await screen.findAllByText('9H')).length).toBeGreaterThan(0);
    expect(screen.getByText('9h.slack.com')).toBeTruthy();
    const synced = await screen.findByText(/Synced .* ago/);
    expect(synced.closest('a, button')).toBeNull();
    expect(synced.parentElement!.hasAttribute('title')).toBe(false);
  });

  it('shows the workspace logo instead of its initial, and the initial when the logo can’t load', async () => {
    const logo = 'https://avatars.slack-edge.com/2024-01-01/9h_132.png';
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(
      makeWorkspace({ teamName: '9H', teamDomain: '9h', teamIcon: logo }),
    );
    renderApp();
    const sidebar = screen.getAllByRole('complementary', { name: 'Sidebar' })[0];
    await waitFor(() => expect(sidebar.querySelector(`img[src="${logo}"]`)).toBeTruthy());
    expect(within(sidebar).queryByText('9')).toBeNull();

    fireEvent.error(sidebar.querySelector(`img[src="${logo}"]`)!); // offline
    expect(sidebar.querySelector(`img[src="${logo}"]`)).toBeNull();
    expect(within(sidebar).getByText('9')).toBeTruthy();
  });

  it('routes unknown paths to a not-found page', async () => {
    renderApp('/nope');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});

function searchResponse(params: SearchParams, messages: ReturnType<typeof makeMessage>[]): SearchResponse {
  return {
    total: messages.length,
    hits: messages.map((message) => ({ message, snippet: message.text })),
    parsed: {
      text: params.q,
      conversationIds: [],
      userIds: [],
      after: null,
      before: null,
      has: [],
      unresolved: [],
    },
    tookMs: 1,
  };
}

describe('search results and the way back to them', () => {
  const found = [
    makeMessage({ ts: tsAt(1), conversationId: 'C1', userId: 'U2', text: 'deploy one' }),
    makeMessage({ ts: tsAt(2), conversationId: 'C2', userId: 'U2', text: 'deploy two' }),
    makeMessage({
      ts: tsAt(3),
      conversationId: 'C1',
      userId: 'U2',
      text: 'deploy reply',
      threadTs: tsAt(1),
      isReply: true,
    }),
  ];
  const results = async () => screen.findByRole('list', { name: 'Search results' });
  const params = () => new URLSearchParams(location!.search);

  beforeEach(() => {
    vi.spyOn(api, 'search').mockImplementation(async (p) => searchResponse(p, found));
    vi.spyOn(api, 'getConversation').mockImplementation(async (id) => conversations.find((c) => c.id === id)!);
    vi.spyOn(api, 'getMessages').mockImplementation(async (conversationId) => ({
      messages: found.filter((m) => m.conversationId === conversationId && !m.isReply),
      hasMoreBefore: false,
      hasMoreAfter: false,
    }));
    vi.spyOn(api, 'getThread').mockResolvedValue({ parent: found[0], replies: [found[2]] });
  });

  it('opens a result next to the list in a wide window, follows the next one, and Esc closes it', async () => {
    renderApp('/search?q=deploy');
    const [first, second] = within(await results()).getAllByRole('link');
    fireEvent.click(first);
    const preview = await screen.findByRole('region', { name: 'Search result preview' });
    expect(within(preview).getByRole('heading', { name: '#general' })).toBeTruthy();
    expect([params().get('q'), params().get('c'), params().get('ts')]).toEqual(['deploy', 'C1', tsAt(1)]);
    await waitFor(() => expect(within(preview).getByText('deploy one')).toBeTruthy());
    expect(first.getAttribute('aria-current')).toBe('true');

    fireEvent.click(second);
    await waitFor(() => expect(params().get('c')).toBe('C2'));
    expect(
      within(await results())
        .getAllByRole('link')[1]
        .getAttribute('aria-current'),
    ).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Search result preview' })).toBeNull());
    expect([params().get('q'), params().get('c')]).toEqual(['deploy', null]);
  });

  it('shows a reply in its thread, and opens the full conversation with a way back', async () => {
    renderApp('/search?q=deploy');
    fireEvent.click(within(await results()).getAllByRole('link')[2]);
    const preview = await screen.findByRole('region', { name: 'Search result preview' });
    const thread = await within(preview).findByRole('complementary', { name: 'Thread' });
    await waitFor(() => expect(within(thread).getByText('deploy reply')).toBeTruthy());

    fireEvent.click(within(preview).getByRole('button', { name: 'Open conversation' }));
    await waitFor(() => expect(location?.pathname).toBe('/c/C1'));
    expect([params().get('thread'), params().get('ts')]).toEqual([tsAt(1), tsAt(3)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Search results' }));
    await waitFor(() => expect(location?.pathname).toBe('/search'));
    expect([params().get('q'), params().get('c')]).toEqual(['deploy', 'C1']);
    await screen.findByRole('region', { name: 'Search result preview' });
  });

  it('in a narrower window opens the conversation, which keeps its way back through a thread', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1024px'), // a laptop-sized window: too narrow to show both
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderApp('/search?q=deploy');
    fireEvent.click(within(await results()).getAllByRole('link')[2]);
    await waitFor(() => expect(location?.pathname).toBe('/c/C1'));
    const thread = await screen.findByRole('complementary', { name: 'Thread' });
    fireEvent.click(within(thread).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(params().get('thread')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Search results' }));
    await waitFor(() => expect(location?.pathname).toBe('/search'));
    expect(params().get('q')).toBe('deploy');
    // The result that was opened has the focus again, for the next one with ↓.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-search-hit')).toBe(`C1:${tsAt(3)}`));
  });
});
