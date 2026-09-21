// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LoginStatusDTO, SettingsDTO } from '../../../shared/types';
import { App } from '../../App';
import { FIRST_SYNC_GRACE_MS } from './Onboarding';
import {
  appFixtures,
  installFixtureBridge,
  makeConnection,
  makeLoginStatus,
  makeRun,
  makeSettings,
  makeStats,
  makeSyncStatus,
  NOT_CONNECTED,
  type FakeBridge,
} from '../../test/helpers';

const fresh: SettingsDTO = makeSettings({
  connection: NOT_CONNECTED,
  preferences: { onboardingComplete: false, launchAtLogin: false },
});

const STARTED = 1_758_000_000_000;

let bridge: FakeBridge;
let settings: SettingsDTO;
let login: LoginStatusDTO;

function start(overrides: Record<string, unknown> = {}) {
  settings = fresh;
  login = makeLoginStatus();
  bridge = installFixtureBridge(
    appFixtures({
      getSettings: () => settings,
      getLoginStatus: () => login,
      getSyncStatus: makeSyncStatus({ recentRuns: [], lastSuccessAt: null, nextRunAt: null }),
      getStats: makeStats({ messageCount: 0 }),
      startLogin: () => (login = makeLoginStatus({ state: 'opening', startedAt: STARTED })),
      cancelLogin: () =>
        (login = makeLoginStatus({ state: 'cancelled', startedAt: STARTED, message: 'Sign-in was cancelled.' })),
      chooseLoginTeam: () => (login = makeLoginStatus({ state: 'verifying', startedAt: STARTED })),
      completeOnboarding: (req: unknown) =>
        (settings = {
          ...settings,
          preferences: {
            ...settings.preferences,
            onboardingComplete: true,
            launchAtLogin: (req as { launchAtLogin: boolean }).launchAtLogin,
          },
        }),
      ...overrides,
    }),
  );
  return render(<App />);
}

/** Main finished the sign-in: it pushes the new status and the settings with the connection. */
function connect() {
  const connection = makeConnection({ teamName: '9H', userName: 'roman' });
  login = makeLoginStatus({ state: 'connected', startedAt: STARTED, connection });
  settings = { ...settings, connection };
  bridge.emit('login-status', login);
  bridge.emit('settings', settings);
}

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
  window.location.hash = '';
});

async function toConnectStep() {
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
  return screen.findByRole('heading', { name: 'Connect Slack' });
}

describe('Onboarding', () => {
  it('welcomes with the promise and the one-time note about using your Slack login', async () => {
    start();
    expect(await screen.findByRole('heading', { name: 'Welcome to Slack Archive' })).toBeTruthy();
    expect(
      screen.getByText(
        'Slack Archive keeps a private copy of your Slack history on this computer, so you can still read and search it after Slack hides it. Your data never leaves your machine.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/uses your own Slack login to make a personal copy of your own history/)).toBeTruthy();
    expect(screen.getByText(/Nothing is uploaded anywhere/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Step 1 of 3' })).toBeTruthy();
    // No jargon anywhere in the flow.
    expect(document.body.textContent).not.toMatch(/token|cookie|xox|OAuth|API/i);
  });

  it('connects with one big button, follows the Slack window, then moves on by itself', async () => {
    start();
    await toConnectStep();
    expect(screen.getByText('You’ll sign in to Slack in a window, just like in your browser.')).toBeTruthy();
    expect(screen.getByText(/“Sign in with email”/)).toBeTruthy();
    expect(screen.getByText(/6-digit code/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('startLogin', {}));
    expect(await screen.findByText('Opening the Slack sign-in window…')).toBeTruthy();

    login = makeLoginStatus({ state: 'waiting', startedAt: STARTED });
    bridge.emit('login-status', login);
    expect(await screen.findByText('Finish signing in in the Slack window…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

    connect();
    expect(await screen.findByRole('heading', { name: 'Getting your history' })).toBeTruthy();
    expect(screen.getByText(/Connected to 9H as roman/)).toBeTruthy();
  });

  it('moves on from the sign-in’s own result even before the saved settings arrive', async () => {
    start();
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    const connection = makeConnection({ teamName: '9H', userName: 'roman' });
    login = makeLoginStatus({ state: 'connected', startedAt: STARTED, connection });
    bridge.emit('login-status', login);
    expect(await screen.findByRole('heading', { name: 'Getting your history' })).toBeTruthy();
    expect(screen.getByText(/Connected to 9H as roman/)).toBeTruthy();
  });

  it('lets people pick the workspace when they’re signed in to several', async () => {
    start();
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    login = makeLoginStatus({
      state: 'choose_team',
      startedAt: STARTED,
      teams: [
        { id: 'T1', name: 'Acme', domain: 'acme' },
        { id: 'T9H', name: '9H', domain: '9h' },
      ],
    });
    bridge.emit('login-status', login);
    const group = await screen.findByRole('group', { name: /more than one workspace/ });
    const continueButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: /9H/ }));
    fireEvent.click(continueButton);
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('chooseLoginTeam', { teamId: 'T9H' }));
    expect(await screen.findByText('Checking your sign-in with Slack…')).toBeTruthy();
  });

  it('refreshes the saved connection when the reply to Continue already says “connected”', async () => {
    const connection = makeConnection({ teamName: '9H', userName: 'roman' });
    start({
      chooseLoginTeam: () => {
        // Main saved the connection and answers; its pushes haven't arrived yet.
        settings = { ...settings, connection };
        return (login = makeLoginStatus({ state: 'connected', startedAt: STARTED, connection }));
      },
    });
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    login = makeLoginStatus({
      state: 'choose_team',
      startedAt: STARTED,
      teams: [
        { id: 'T1', name: 'Acme', domain: 'acme' },
        { id: 'T9H', name: '9H', domain: '9h' },
      ],
    });
    bridge.emit('login-status', login);
    const group = await screen.findByRole('group', { name: /more than one workspace/ });
    const settingsCalls = () => bridge.call.mock.calls.filter(([m]) => m === 'getSettings').length;
    const before = settingsCalls();
    fireEvent.click(within(group).getByRole('radio', { name: /9H/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Getting your history' })).toBeTruthy();
    await waitFor(() => expect(settingsCalls()).toBeGreaterThan(before));
  });

  it('keeps a step main already pushed when the reply to Start arrives late', async () => {
    let reply: (value: LoginStatusDTO) => void = () => {};
    start({ startLogin: () => new Promise<LoginStatusDTO>((resolve) => (reply = resolve)) });
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    bridge.emit('login-status', makeLoginStatus({ state: 'waiting', startedAt: STARTED }));
    expect(await screen.findByText('Finish signing in in the Slack window…')).toBeTruthy();
    reply(makeLoginStatus({ state: 'opening', startedAt: STARTED }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Finish signing in in the Slack window…')).toBeTruthy();
    expect(screen.queryByText('Opening the Slack sign-in window…')).toBeNull();
  });

  it('Cancel returns to the start without an error', async () => {
    start();
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('cancelLogin'));
    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never flashes a failure when main pushes “cancelled” before answering Cancel', async () => {
    let reply: (value: LoginStatusDTO) => void = () => {};
    start({
      cancelLogin: () => {
        login = makeLoginStatus({ state: 'cancelled', startedAt: STARTED, message: 'Sign-in was cancelled.' });
        bridge.emit('login-status', login);
        return new Promise<LoginStatusDTO>((resolve) => (reply = resolve));
      },
    });
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('cancelLogin'));
    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    reply(login);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect Slack' })).toBeTruthy();
  });

  it('after a cancelled or failed sign-in: plain words, Try again, and the other ways', async () => {
    start();
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await screen.findByText('Opening the Slack sign-in window…');
    login = makeLoginStatus({ state: 'error', startedAt: STARTED, error: 'Slack showed an error page. invalid_auth' });
    bridge.emit('login-status', login);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t connect to Slack')).toBeTruthy();
    // A technical message from main is replaced, never shown.
    expect(alert.textContent).not.toMatch(/invalid_auth/);
    expect(within(alert).getByText(/Try signing in with email/)).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: /Advanced: connect another way/ }));
    expect(within(alert).getByLabelText('Value of the d cookie')).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.call.mock.calls.filter(([m]) => m === 'startLogin')).toHaveLength(2));
  });

  it('shows the first sync live and finishes (start at login is on by default)', async () => {
    start({
      getSyncStatus: makeSyncStatus({
        running: true,
        currentRun: makeRun({ id: 1, status: 'running', finishedAt: null }),
        progress: { phase: 'history', message: 'Fetching #general — 1,240 messages so far', current: 3, total: 12 },
        recentRuns: [],
        lastSuccessAt: null,
      }),
    });
    await toConnectStep();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    connect();
    await screen.findByRole('heading', { name: 'Getting your history' });

    expect(await screen.findByText('Fetching #general — 1,240 messages so far')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(
      screen.getByText(/Slack only lets us see the last 90 days. From now on, everything we fetch is kept forever./),
    ).toBeTruthy();
    expect(screen.getByText(/You can finish now/)).toBeTruthy();

    const checkbox = screen.getByRole('checkbox', { name: /Start Slack Archive when I log in/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('completeOnboarding', { launchAtLogin: true }));
    // The archive opens right away; the first sync carries on.
    expect(await screen.findByRole('heading', { name: '9H archive' })).toBeTruthy();
  });

  it('respects unticking “start at login”', async () => {
    settings = fresh;
    start({ getSettings: () => ({ ...settings, connection: makeConnection() }) });
    await screen.findByRole('heading', { name: 'Getting your history' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Start Slack Archive when I log in/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('completeOnboarding', { launchAtLogin: false }));
  });

  it('offers to start the first sync by hand when it hasn’t started after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      start({
        getSettings: () => ({ ...fresh, connection: makeConnection() }),
        startSync: { code: 'conflict', message: 'A sync is already running.' },
      });
      expect(await screen.findByText('Starting the first sync…')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Start it now' })).toBeNull();
      act(() => vi.advanceTimersByTime(FIRST_SYNC_GRACE_MS));
      fireEvent.click(await screen.findByRole('button', { name: 'Start it now' }));
      await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('startSync'));
      // "Already running" isn't an error worth showing: the progress takes over.
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a first-sync problem with its fix', async () => {
    start({
      getSettings: () => ({ ...fresh, connection: makeConnection() }),
      getSyncStatus: makeSyncStatus({
        recentRuns: [makeRun({ id: 1, status: 'error' })],
        lastSuccessAt: null,
        problem: {
          kind: 'offline',
          message: 'Can’t reach Slack right now. We’ll try again automatically.',
          action: 'retry',
        },
      }),
    });
    expect(await screen.findByText('Can’t reach Slack right now. We’ll try again automatically.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('startSync'));
  });
});
