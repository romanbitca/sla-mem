// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AppInfoDTO, SettingsDTO, StatsDTO, SyncStatusDTO, WorkspaceDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import HomePage from '../../pages/HomePage';
import {
  makeAppInfo,
  makeConnection,
  makeLoginStatus,
  makeRun,
  makeSettings,
  makeStats,
  makeStorage,
  makeSyncStatus,
  makeWorkspace,
  NOT_CONNECTED,
  renderWithProviders,
} from '../../test/helpers';
import {
  connectPrompt,
  formatDuration,
  phaseLabel,
  progressFraction,
  relativeTime,
  summarizeRun,
  timeAgo,
} from './runs';

const NOW = Date.now();
const DAY = 86_400_000;

const emptyStats = makeStats({
  messageCount: 0,
  conversationCount: 0,
  fileCount: 0,
  filesDownloaded: 0,
  filesBytes: 0,
  oldestTs: null,
  newestTs: null,
  beyondFreeWindowCount: 0,
});

const idle = makeSyncStatus({
  recentRuns: [
    makeRun({ id: 3, stats: { messagesInserted: 120, revisions: 2, apiCalls: 88 } }),
    makeRun({
      id: 2,
      status: 'error',
      error: 'ratelimited',
      startedAt: NOW - 26 * 3600_000,
      finishedAt: NOW - 26 * 3600_000 + 5000,
    }),
  ],
  lastSuccessAt: NOW - 58 * 60_000,
  nextRunAt: NOW + 30 * 60_000,
});

const running = makeSyncStatus({
  running: true,
  currentRun: makeRun({ id: 4, status: 'running', startedAt: NOW - 90_000, finishedAt: null }),
  progress: { phase: 'history', message: 'Fetching #general — 1,240 messages so far', current: 3, total: 12 },
});

const notConnected = makeWorkspace({
  teamId: null,
  teamName: null,
  teamDomain: null,
  selfUserId: null,
  connected: false,
});

function setup(
  status: SyncStatusDTO | Error = idle,
  {
    stats = makeStats(),
    workspace = makeWorkspace(),
    settings = makeSettings(),
    appInfo = makeAppInfo(),
  }: {
    stats?: StatsDTO | Error;
    workspace?: WorkspaceDTO;
    settings?: SettingsDTO | Error;
    appInfo?: AppInfoDTO;
  } = {},
) {
  const answer = <T,>(value: T | Error) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  vi.spyOn(api, 'getSyncStatus').mockImplementation(() => answer(status));
  vi.spyOn(api, 'getStats').mockImplementation(() => answer(stats));
  vi.spyOn(api, 'getWorkspace').mockResolvedValue(workspace);
  vi.spyOn(api, 'getSettings').mockImplementation(() => answer(settings));
  vi.spyOn(api, 'getStorage').mockResolvedValue(makeStorage());
  vi.spyOn(api, 'getAppInfo').mockResolvedValue(appInfo);
  return renderWithProviders(<HomePage />);
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // storage unavailable: nothing to reset
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('run helpers', () => {
  it('formats durations and progress', () => {
    expect(formatDuration(4_200)).toBe('4s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 4m');
    expect(progressFraction({ phase: 'files', message: '', current: 3, total: 12 })).toBe(0.25);
    expect(progressFraction({ phase: 'files', message: '', current: 3, total: null })).toBeNull();
  });

  it('never shows a past event as upcoming when the clock lags', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now + 10_000, now)).toBe('in a moment');
    expect(timeAgo(now + 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now + 12 * 60_000, now)).toBe('in 12 minutes');
  });

  it('summarizes runs in words, never counter names or API calls', () => {
    expect(summarizeRun(makeRun({ id: 1, stats: { messagesInserted: 1, apiCalls: 50, filesDownloaded: 2 } }))).toBe(
      '1 new message · 2 attachments saved',
    );
    expect(summarizeRun(makeRun({ id: 1, stats: { apiCalls: 50, threadsFetched: 3 } }))).toBe(
      'Up to date: nothing new',
    );
    expect(summarizeRun(makeRun({ id: 1, kind: 'import', stats: {} }))).toBe('Nothing new in the export');
    expect(summarizeRun(makeRun({ id: 1, status: 'error', stats: { messagesInserted: 5 } }))).toBe(
      'Didn’t finish · 5 new messages kept',
    );
    expect(summarizeRun(makeRun({ id: 1, status: 'cancelled', stats: {} }))).toBe('Cancelled');
    expect(summarizeRun(makeRun({ id: 1, status: 'running', stats: { messagesInserted: 9 } }))).toBe(
      'In progress · 9 new messages so far',
    );
    expect(phaseLabel('auth')).toBe('Checking your Slack connection');
    expect(phaseLabel('something_new')).toBe('Working…');
  });

  it('decides which Connect Slack prompt the home page shows', () => {
    const connection = makeConnection();
    expect(connectPrompt(makeWorkspace(), makeStats(), idle, connection)).toBeNull();
    expect(connectPrompt(notConnected, emptyStats, idle, NOT_CONNECTED)).toBe('first-run');
    expect(connectPrompt(notConnected, emptyStats, running, NOT_CONNECTED)).toBe('not-connected');
    expect(connectPrompt(notConnected, makeStats(), idle, undefined)).toBe('not-connected');
    expect(connectPrompt(undefined, emptyStats, idle, undefined)).toBeNull();
    expect(connectPrompt(makeWorkspace(), makeStats(), idle, { ...connection, expired: true })).toBe('expired');
  });
});

describe('HomePage', () => {
  it('shows the numbers and, prominently, what Slack no longer shows', async () => {
    setup();
    expect(await screen.findByText((48_213).toLocaleString())).toBeTruthy();
    const payoff = screen.getByRole('region', { name: 'Messages only in your archive' });
    expect(payoff.textContent).toContain(
      `${(31_337).toLocaleString()} messages older than 90 days — no longer visible in Slack`,
    );
    expect(screen.getByText('1.2 GB')).toBeTruthy(); // total from main's storage numbers
    expect(screen.getByText(/Messages 340 MB · attachments 880 MB/)).toBeTruthy();
    expect(screen.getByText(/Mar 3, 2024 – /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Slack' })).toBeNull(); // connected: no prompt
  });

  it('shows when the last sync ran and the next one will, and syncs now', async () => {
    const startSync = vi.spyOn(api, 'startSync').mockResolvedValue({ runId: 5 });
    setup();
    expect(await screen.findByText('58 minutes ago')).toBeTruthy();
    expect(screen.getByText('in 30 minutes')).toBeTruthy();
    expect(screen.getByText('Every hour')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(startSync).toHaveBeenCalledTimes(1));
  });

  it('keeps a compact history, folded, with plain summaries and the logs a click away', async () => {
    const showLogs = vi.spyOn(api, 'showLogs').mockResolvedValue({ ok: true });
    setup();
    const toggle = await screen.findByRole('button', { name: /Sync history/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('120 new messages · 2 edits saved');
    fireEvent.click(toggle);
    const history = screen.getByRole('region', { name: 'Sync history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(within(history).getByText('Didn’t finish', { selector: 'li > span:last-child' })).toBeTruthy();
    expect(history.textContent).not.toMatch(/apiCalls|API call|ratelimited/);
    fireEvent.click(within(history).getByRole('button', { name: 'Show logs' }));
    await waitFor(() => expect(showLogs).toHaveBeenCalledTimes(1));
  });

  it('shows live progress while syncing, with Cancel', async () => {
    const cancel = vi.spyOn(api, 'cancelSync').mockResolvedValue({ ok: true });
    setup(running);
    const bar = await screen.findByRole('progressbar', { name: 'Sync progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('Fetching messages')).toBeTruthy();
    expect(screen.getByText('Fetching #general — 1,240 messages so far')).toBeTruthy();
    expect(screen.getByText(/running for 1m \d+s/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Syncing…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('shows a signed-out problem with Reconnect, which starts the sign-in and opens Settings', async () => {
    const startLogin = vi.spyOn(api, 'startLogin').mockResolvedValue(makeLoginStatus({ state: 'opening' }));
    const { location } = setup(
      makeSyncStatus({
        problem: {
          kind: 'signed_out',
          message: 'Slack signed you out. Reconnect to keep archiving.',
          action: 'reconnect',
        },
      }),
      { settings: makeSettings({ connection: makeConnection({ expired: true }) }) },
    );
    const alert = await screen.findByText('Slack signed you out. Reconnect to keep archiving.');
    const callout = alert.closest('[role="alert"]') as HTMLElement;
    // Said once: the expired-connection card doesn't repeat it.
    expect(screen.queryByRole('heading', { name: 'Slack signed you out' })).toBeNull();
    fireEvent.click(within(callout).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith({ workspace: '9h.slack.com' }));
    await waitFor(() => expect(location.current?.pathname).toBe('/settings'));
  });

  it('offers Try again and Show logs after an unexpected failure', async () => {
    const startSync = vi.spyOn(api, 'startSync').mockResolvedValue({ runId: 6 });
    const showLogs = vi.spyOn(api, 'showLogs').mockResolvedValue({ ok: true });
    setup(
      makeSyncStatus({
        problem: { kind: 'unexpected', message: 'Something went wrong. Nothing was lost.', action: 'show_logs' },
      }),
    );
    const callout = (await screen.findByText('Something went wrong. Nothing was lost.')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    fireEvent.click(within(callout).getByRole('button', { name: 'Try again' }));
    fireEvent.click(within(callout).getByRole('button', { name: 'Show logs' }));
    await waitFor(() => expect(startSync).toHaveBeenCalledTimes(1));
    expect(showLogs).toHaveBeenCalledTimes(1);
  });

  it('warns clearly when the last successful sync is over a month old', async () => {
    const startSync = vi.spyOn(api, 'startSync').mockResolvedValue({ runId: 7 });
    setup(makeSyncStatus({ stale: true, lastSuccessAt: NOW - 34 * DAY }));
    expect(await screen.findByText('Your last successful sync was 34 days ago.')).toBeTruthy();
    const callout = screen
      .getByText(/Slack only keeps the last 90 days, so sync soon/)
      .closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(callout).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(startSync).toHaveBeenCalledTimes(1));
  });

  it('doesn’t offer a sync that can’t work while Slack needs reconnecting', async () => {
    setup(
      makeSyncStatus({
        stale: true,
        lastSuccessAt: NOW - 40 * DAY,
        problem: {
          kind: 'signed_out',
          message: 'Slack signed you out. Reconnect to keep archiving.',
          action: 'reconnect',
        },
      }),
    );
    const stale = (await screen.findByText('Your last successful sync was 40 days ago.')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(within(stale).queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('first run: makes Connect Slack the obvious next step, with the import alternative', async () => {
    const startLogin = vi.spyOn(api, 'startLogin').mockResolvedValue(makeLoginStatus({ state: 'opening' }));
    setup(makeSyncStatus({ recentRuns: [], lastSuccessAt: null, blockedReason: 'Connect Slack to start syncing.' }), {
      stats: emptyStats,
      workspace: notConnected,
      settings: makeSettings({ connection: NOT_CONNECTED }),
    });
    const cta = await screen.findByRole('region', { name: 'Connect Slack to start your archive' });
    // Zero-filled numbers and an empty history are noise before anything is archived.
    expect(screen.queryByRole('list', { name: 'Archive statistics' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Sync history' })).toBeNull();
    expect(within(cta).getByRole('link', { name: 'Import it in Settings' }).getAttribute('href')).toBe(
      '/settings#advanced',
    );
    expect(screen.getByText('Connect Slack to start syncing.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(cta).getByRole('button', { name: 'Connect Slack' }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith({}));
  });

  it('reports a refused sync in plain words', async () => {
    vi.spyOn(api, 'startSync').mockRejectedValue(new ApiError('conflict', 'A sync is already running.'));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('A sync is already running.')).toBeTruthy();
  });

  it('keeps the archive readable when status, numbers or settings can’t be loaded', async () => {
    const blocked = new ApiError('blocked', 'This isn’t available yet.');
    setup(blocked, {
      stats: new ApiError('internal', 'Something went wrong. Nothing was lost — please try again.'),
      settings: blocked,
    });
    expect(await screen.findByText('Couldn’t check on syncing')).toBeTruthy();
    expect(await screen.findByText('Couldn’t load archive numbers')).toBeTruthy();
    expect(await screen.findByText('Some settings couldn’t be loaded.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).not.toMatch(/blocked|internal|status \d/);
  });

  it('asks to move the app into Applications when it runs from the download', async () => {
    setup(idle, { appInfo: makeAppInfo({ installedProperly: false }) });
    expect(await screen.findByText(/running from the download/)).toBeTruthy();
  });
});
