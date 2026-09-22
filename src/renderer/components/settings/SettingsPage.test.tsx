// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SettingsDTO } from '../../../shared/types';
import { AppEffects } from '../../App';
import { api, ApiError } from '../../lib/api';
import SettingsPage from '../../pages/SettingsPage';
import {
  installFakeBridge,
  makeAppInfo,
  makeConnection,
  makeConversation,
  makeLoginStatus,
  makeSettings,
  makeStorage,
  makeSyncStatus,
  makeUpdateInfo,
  makeWorkspace,
  NOT_CONNECTED,
  renderWithProviders,
} from '../../test/helpers';
import {
  ATTACHMENT_OPTIONS,
  GUIDE_URL,
  intervalLabel,
  monthsLabel,
  validateCookie,
  validateWorkspace,
} from '../connect/connection';

const NOW = Date.now();

function setup(settings: SettingsDTO | Error = makeSettings(), route = '/settings', storage = makeStorage()) {
  vi.spyOn(api, 'getSettings').mockImplementation(() =>
    settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings),
  );
  vi.spyOn(api, 'getSyncStatus').mockResolvedValue(
    makeSyncStatus({ lastSuccessAt: NOW - 5 * 60_000, nextRunAt: NOW + 55 * 60_000 }),
  );
  vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace());
  vi.spyOn(api, 'getLoginStatus').mockResolvedValue(makeLoginStatus());
  vi.spyOn(api, 'getStorage').mockResolvedValue(storage);
  vi.spyOn(api, 'getAppInfo').mockResolvedValue(makeAppInfo());
  vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(makeUpdateInfo());
  return renderWithProviders(
    <>
      <AppEffects />
      <SettingsPage />
    </>,
    { route },
  );
}

const card = (name: string) => screen.findByRole('region', { name });
/** Answers with the patched settings, like main does. */
function acceptPatches(base: SettingsDTO = makeSettings()) {
  return vi.spyOn(api, 'updatePreferences').mockImplementation(async (patch) => ({
    ...base,
    preferences: { ...base.preferences, ...patch },
  }));
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // storage unavailable
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('settings helpers', () => {
  it('validates the advanced connect form', () => {
    expect(validateWorkspace('')).toMatch(/Enter your workspace/);
    expect(validateWorkspace('https://app.slack.com/client/T1')).toMatch(/not app\.slack\.com/);
    expect(validateWorkspace('9h.slack.com')).toBeNull();
    expect(validateCookie('')).toMatch(/Paste the value/);
    expect(validateCookie('xoxc-123')).toMatch(/starts with “xoxd-”/);
    expect(validateCookie(' xoxd-abc%2Fdef ')).toBeNull();
  });

  it('labels schedules, attachment choices and cleanup ages in words', () => {
    expect(intervalLabel(0)).toBe('Manual only');
    expect(intervalLabel(60)).toBe('Every hour');
    expect(intervalLabel(1440)).toBe('Daily');
    expect(intervalLabel(120)).toBe('Every 2 hours');
    expect(ATTACHMENT_OPTIONS.map((o) => o.label)).toEqual([
      'Don’t download attachments',
      'Images & documents up to 25 MB (recommended)',
      'Everything up to 200 MB',
    ]);
    expect([3, 6, 12, 24].map(monthsLabel)).toEqual(['3 months', '6 months', '1 year', '2 years']);
  });
});

describe('Settings — Slack connection', () => {
  it('shows the workspace and account, and reconnects through the sign-in window', async () => {
    const startLogin = vi
      .spyOn(api, 'startLogin')
      .mockResolvedValue(makeLoginStatus({ state: 'opening', startedAt: NOW }));
    setup();
    const connection = await card('Slack connection');
    expect(within(connection).getByText('Connected')).toBeTruthy();
    expect(within(connection).getByText('9H')).toBeTruthy();
    expect(within(connection).getByText('9h.slack.com')).toBeTruthy();
    expect(within(connection).getByText(/Signed in as roman · Signed in with Slack/)).toBeTruthy();
    fireEvent.click(within(connection).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith({ workspace: '9h.slack.com' }));
    expect(await within(connection).findByText('Opening the Slack sign-in window…')).toBeTruthy();
  });

  it('disconnects only after a confirmation that says the archive stays', async () => {
    let current = makeSettings();
    const disconnect = vi.spyOn(api, 'disconnect').mockImplementation(async () => {
      current = makeSettings({ connection: NOT_CONNECTED });
      return NOT_CONNECTED;
    });
    setup();
    vi.mocked(api.getSettings).mockImplementation(async () => current);
    const connection = await card('Slack connection');
    fireEvent.click(within(connection).getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect Slack?' });
    expect(dialog.textContent).toContain('Your archive stays on this computer — only the Slack login is removed.');
    // Focus starts on Cancel so Enter never disconnects by accident.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await within(connection).findByText('Not connected')).toBeTruthy();
    const connect = within(connection).getByRole('button', { name: 'Connect Slack' });
    // Focus stays in the card, on what comes next, instead of falling back to the page.
    await waitFor(() => expect(document.activeElement).toBe(connect));
  });

  it('asks to reconnect when Slack signed the session out', async () => {
    const startLogin = vi
      .spyOn(api, 'startLogin')
      .mockResolvedValue(makeLoginStatus({ state: 'opening', startedAt: NOW }));
    setup(makeSettings({ connection: makeConnection({ expired: true }) }));
    const connection = await card('Slack connection');
    expect(within(connection).getByText('Signed out')).toBeTruthy();
    const alert = within(connection).getByRole('alert');
    expect(alert.textContent).toContain('Slack signed you out. Reconnect to keep archiving.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
  });

  it('says why when the saved sign-in can’t be used any more', async () => {
    const reason = 'sla-mem needs you to sign in to Slack again. Reconnect to keep archiving.';
    setup(makeSettings({ connection: makeConnection({ expired: true, error: reason }) }));
    const connection = await card('Slack connection');
    const alert = within(connection).getByRole('alert');
    expect(alert.textContent).toContain(reason);
    expect(within(alert).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('offers Connect Slack with the email-code tip when nothing is connected', async () => {
    setup(makeSettings({ connection: NOT_CONNECTED }));
    const connection = await card('Slack connection');
    expect(within(connection).getByText('Not connected')).toBeTruthy();
    expect(within(connection).getByRole('button', { name: 'Connect Slack' })).toBeTruthy();
    expect(within(connection).getByText(/“Sign in with email”/)).toBeTruthy();
    expect(within(connection).queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });
});

describe('Settings — sync and attachments', () => {
  it('saves how often to sync and start-at-login as soon as they change', async () => {
    const update = acceptPatches();
    setup();
    const sync = await card('Sync');
    const select = within(sync).getByLabelText('How often to sync') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Manual only',
      'Every 15 minutes',
      'Every hour',
      'Every 6 hours',
      'Daily',
    ]);
    expect(select.value).toBe('60');
    fireEvent.change(select, { target: { value: '360' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ syncIntervalMinutes: 360 }));
    expect(await within(sync).findByText('Saved')).toBeTruthy();

    const login = within(sync).getByRole('switch', { name: 'Start sla-mem when I log in' }) as HTMLInputElement;
    expect(login.checked).toBe(true);
    fireEvent.click(login);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ launchAtLogin: false }));
    expect(within(sync).getByText('5 minutes ago')).toBeTruthy();
    expect(within(sync).getByText('in 55 minutes')).toBeTruthy();
  });

  it('can hide the menu bar icon, and then says how to open the app again', async () => {
    const update = acceptPatches();
    setup();
    const sync = await card('Sync');
    const icon = within(sync).getByRole('switch', {
      name: /^Show sla-mem in the (menu bar|system tray)$/,
    }) as HTMLInputElement;
    expect(icon.checked).toBe(true);
    fireEvent.click(icon);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ showTrayIcon: false }));
    expect(await within(sync).findByText(/keeps syncing in the background\. Open it from/)).toBeTruthy();
  });

  it('rolls back a choice main refuses, and says why', async () => {
    vi.spyOn(api, 'updatePreferences').mockRejectedValue(new ApiError('invalid', 'That schedule isn’t possible.'));
    setup();
    const sync = await card('Sync');
    const select = within(sync).getByLabelText('How often to sync') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '15' } });
    expect(await within(sync).findByText('Couldn’t save: That schedule isn’t possible.')).toBeTruthy();
    await waitFor(() => expect(select.value).toBe('60'));
  });

  it('chooses which attachments to keep, with the note about Slack’s 90 days', async () => {
    const update = acceptPatches();
    setup();
    const attachments = await card('Attachments');
    const recommended = within(attachments).getByRole('radio', {
      name: /Images & documents up to 25 MB \(recommended\)/,
    }) as HTMLInputElement;
    expect(recommended.checked).toBe(true);
    expect(attachments.textContent).toMatch(
      /can be downloaded later by choosing a bigger option — but only while Slack still has them/,
    );
    fireEvent.click(within(attachments).getByRole('radio', { name: /Everything up to 200 MB/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ attachmentPolicy: 'everything' }));
  });
});

describe('Settings — moving computers', () => {
  it('imports a backup made on another computer through main’s file picker', async () => {
    const restore = vi.spyOn(api, 'importBackup').mockResolvedValueOnce(null).mockResolvedValueOnce({ runId: 4 });
    setup();
    const storage = await card('Storage');
    const button = await within(storage).findByRole('button', { name: 'Import a backup…' });
    fireEvent.click(button); // cancelled in the picker: nothing to say
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(within(storage).queryByText(/Importing the backup/)).toBeNull();
    fireEvent.click(button);
    expect(
      await within(storage).findByText(/Importing the backup: you can follow it on the Archive page/),
    ).toBeTruthy();
  });
});

describe('Settings — what to archive', () => {
  const conversations = [
    makeConversation('C1', 'general', { messageCount: 30 }),
    makeConversation('C2', 'random', { messageCount: 0 }),
    makeConversation('D1', 'Priya', { type: 'im', messageCount: 5 }),
  ];

  function open(settings = makeSettings()) {
    vi.spyOn(api, 'getConversations').mockResolvedValue(conversations);
    const update = acceptPatches(settings);
    setup(settings);
    return update;
  }

  it('says everything is archived, and leaves out what is unticked in the list', async () => {
    const update = open();
    const region = await card('What to archive');
    expect(within(region).getByText('Every conversation you’re in is archived.')).toBeTruthy();
    fireEvent.click(await within(region).findByRole('button', { name: 'Choose conversations…' }));
    const dialog = await screen.findByRole('dialog', { name: 'What to archive' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /random/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ excludedConversationIds: ['C2'] }));
    // Nothing was archived from #random: nothing to offer to delete.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before deleting what is already archived, and deletes only on a yes', async () => {
    const update = open();
    const remove = vi.spyOn(api, 'deleteConversationArchive').mockResolvedValue({ messages: 5, files: 1 });
    const region = await card('What to archive');
    fireEvent.click(await within(region).findByRole('button', { name: 'Choose conversations…' }));
    const dialog = await screen.findByRole('dialog', { name: 'What to archive' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Priya/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ excludedConversationIds: ['D1'] }));
    const ask = await screen.findByRole('alertdialog', { name: 'Delete what’s already archived?' });
    expect(ask.textContent).toContain('Priya already has 5 messages in the archive');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(remove).not.toHaveBeenCalled();

    // What stayed is one click away from being deleted after all.
    fireEvent.click(await within(region).findByRole('button', { name: 'Delete them…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ conversationId: 'D1' }));
  });

  it('names what isn’t archived', async () => {
    open(makeSettings({ preferences: { excludedConversationIds: ['C2', 'D1'] } }));
    const region = await card('What to archive');
    expect(await within(region).findByText(/2 conversations aren’t archived/)).toBeTruthy();
    expect(within(region).getByText('#random and Priya')).toBeTruthy();
    expect(within(region).getByText('5 messages from before are still in the archive.')).toBeTruthy();
  });
});

describe('Settings — storage', () => {
  it('shows disk use split into messages and attachments, and the folder', async () => {
    installFakeBridge(() => undefined, 'darwin');
    const show = vi.spyOn(api, 'showDataFolder').mockResolvedValue({ ok: true });
    setup();
    const storage = await card('Storage');
    await within(storage).findByText('1.2 GB');
    expect(within(storage).getByText('340 MB')).toBeTruthy();
    expect(within(storage).getByText('880 MB')).toBeTruthy();
    expect(within(storage).getByText('200 GB')).toBeTruthy();
    expect(within(storage).getByText('/Users/me/Library/Application Support/sla-mem')).toBeTruthy();
    fireEvent.click(within(storage).getByRole('button', { name: 'Show in Finder' }));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });

  it('warns when the archive is getting big or the disk is nearly full', async () => {
    setup(makeSettings(), '/settings', makeStorage({ warning: 'Your disk is nearly full. Free up some space.' }));
    const storage = await card('Storage');
    expect(await within(storage).findByText('Your disk is nearly full. Free up some space.')).toBeTruthy();
  });

  it('deletes old attachments after a confirmation that messages are never deleted', async () => {
    const cleanupCall = vi
      .spyOn(api, 'deleteAttachmentsOlderThan')
      .mockResolvedValue({ filesRemoved: 42, bytesFreed: 1.5 * 1024 ** 3 });
    setup();
    const storage = await card('Storage');
    fireEvent.change(within(storage).getByLabelText('Delete downloaded attachments older than…'), {
      target: { value: '6' },
    });
    fireEvent.click(within(storage).getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete attachments older than 6 months?' });
    expect(dialog.textContent).toContain('Messages are never deleted.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete attachments' }));
    await waitFor(() => expect(cleanupCall).toHaveBeenCalledWith({ months: 6 }));
    expect(await within(storage).findByText('Deleted 42 attachments, freeing 1.5 GB.')).toBeTruthy();
  });

  it('backs up to a folder the reader picks (and does nothing when they cancel)', async () => {
    const backup = vi.spyOn(api, 'backupNow').mockResolvedValueOnce(null);
    setup();
    const storage = await card('Storage');
    fireEvent.click(within(storage).getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(backup).toHaveBeenCalledTimes(1));
    expect(within(storage).queryByText(/Backup saved/)).toBeNull();
    backup.mockResolvedValueOnce({ path: '/Volumes/Backup/sla-mem 2026-09-21.zip', bytes: 1.2 * 1024 ** 3 });
    fireEvent.click(within(storage).getByRole('button', { name: 'Back up now' }));
    expect(
      await within(storage).findByText('Backup saved (1.2 GB): /Volumes/Backup/sla-mem 2026-09-21.zip'),
    ).toBeTruthy();
  });
});

describe('Settings — about', () => {
  it('shows the version, checks for updates and links the guide and logs', async () => {
    const check = vi.spyOn(api, 'checkForUpdates').mockResolvedValue(makeUpdateInfo());
    const openExternal = vi.spyOn(api, 'openExternal').mockResolvedValue({ ok: true });
    const showLogs = vi.spyOn(api, 'showLogs').mockResolvedValue({ ok: true });
    setup();
    const about = await card('About');
    expect(await within(about).findByText('version 1.2.0')).toBeTruthy();
    fireEvent.click(within(about).getByRole('button', { name: 'Check for updates' }));
    expect(await within(about).findByText('You have the latest version.')).toBeTruthy();
    expect(check).toHaveBeenCalledTimes(1);
    fireEvent.click(within(about).getByRole('button', { name: 'Install and user guide' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith({ url: GUIDE_URL }));
    fireEvent.click(within(about).getByRole('button', { name: 'Show logs' }));
    await waitFor(() => expect(showLogs).toHaveBeenCalledTimes(1));
  });

  it('says plainly when no version has been published, instead of “try again later”', async () => {
    vi.spyOn(api, 'checkForUpdates').mockResolvedValue(makeUpdateInfo({ latestVersion: null, noRelease: true }));
    setup();
    const about = await card('About');
    fireEvent.click(within(about).getByRole('button', { name: 'Check for updates' }));
    expect(
      await within(about).findByText(
        'No version of sla-mem has been published yet, so there’s nothing newer to download.',
      ),
    ).toBeTruthy();
    expect(within(about).queryByText('You have the latest version.')).toBeNull();
    expect(within(about).queryByText(/tries again by itself later/)).toBeNull();
  });

  it('offers the download when a newer version exists', async () => {
    vi.spyOn(api, 'checkForUpdates').mockResolvedValue(
      makeUpdateInfo({ available: true, latestVersion: '1.3.0', downloadUrl: 'https://example.com/a.dmg' }),
    );
    const download = vi.spyOn(api, 'openUpdateDownload').mockResolvedValue({ ok: true });
    setup();
    const about = await card('About');
    fireEvent.click(within(about).getByRole('button', { name: 'Check for updates' }));
    expect(await within(about).findByText('Version 1.3.0 is available.')).toBeTruthy();
    fireEvent.click(within(about).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it('switches the theme at once and saves it in main', async () => {
    const update = acceptPatches();
    setup();
    const about = await card('About');
    const dark = within(about).getByRole('radio', { name: 'Dark' }) as HTMLInputElement;
    await waitFor(() => expect(dark.disabled).toBe(false));
    expect((within(about).getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dark);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ theme: 'dark' }));
    fireEvent.click(within(about).getByRole('radio', { name: 'System' }));
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
  });
});

describe('Settings — advanced', () => {
  it('is folded away, and names the session cookie only inside', async () => {
    setup();
    const toggle = await screen.findByRole('button', { name: 'Advanced' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await card('About');
    expect(document.body.textContent).not.toMatch(/cookie|token|xox/i);
    fireEvent.click(toggle);
    expect(screen.getByRole('heading', { name: 'Paste your session cookie' })).toBeTruthy();
  });

  it('opens from /settings#advanced', async () => {
    setup(makeSettings(), '/settings#advanced');
    expect((await screen.findByRole('button', { name: 'Advanced' })).getAttribute('aria-expanded')).toBe('true');
  });

  it('imports an export through main’s file picker', async () => {
    const importExport = vi.spyOn(api, 'importExport').mockResolvedValue(null);
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import a Slack export (folder or .zip)…' }));
    await waitFor(() => expect(importExport).toHaveBeenCalledTimes(1));
  });

  it('connects with a pasted session cookie, following the written steps', async () => {
    const connect = vi.spyOn(api, 'connectWithCookie').mockResolvedValue(makeConnection());
    setup(makeSettings({ connection: NOT_CONNECTED }));
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    const advanced = screen.getByRole('region', { name: 'Advanced' });
    expect(advanced.textContent).toMatch(/Application → Cookies →/);
    expect(within(advanced).getByText('https://app.slack.com')).toBeTruthy();

    // The archive's own workspace is filled in already.
    const workspace = within(advanced).getByLabelText('Workspace') as HTMLInputElement;
    expect(workspace.value).toBe('9h');
    fireEvent.change(workspace, { target: { value: '' } });
    fireEvent.click(within(advanced).getByRole('button', { name: 'Connect' }));
    expect(within(advanced).getByText(/Enter your workspace/)).toBeTruthy();
    expect(within(advanced).getByText(/Paste the value of the d cookie/)).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();

    fireEvent.change(workspace, { target: { value: '9h.slack.com' } });
    const secret = within(advanced).getByLabelText('Value of the d cookie') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: ' xoxd-abc ' } });
    fireEvent.click(within(advanced).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ workspace: '9h.slack.com', cookie: 'xoxd-abc' }));
    await waitFor(() => expect(secret.value).toBe(''));
  });

  it('shows why a pasted cookie was refused (this form may say “cookie”)', async () => {
    vi.spyOn(api, 'connectWithCookie').mockRejectedValue(
      new ApiError('invalid', 'Slack didn’t accept that cookie. Copy it again from a signed-in browser.'),
    );
    setup(makeSettings({ connection: NOT_CONNECTED }));
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    const advanced = screen.getByRole('region', { name: 'Advanced' });
    fireEvent.change(within(advanced).getByLabelText('Workspace'), { target: { value: '9h' } });
    fireEvent.change(within(advanced).getByLabelText('Value of the d cookie'), { target: { value: 'xoxd-abc' } });
    fireEvent.click(within(advanced).getByRole('button', { name: 'Connect' }));
    expect(
      await within(advanced).findByText('Slack didn’t accept that cookie. Copy it again from a signed-in browser.'),
    ).toBeTruthy();
  });
});

describe('Settings — when things fail', () => {
  it('still shows storage, about and advanced when the settings can’t be loaded', async () => {
    setup(new ApiError('blocked', 'This isn’t available yet.'));
    expect(await screen.findByText('Couldn’t load your settings')).toBeTruthy();
    expect(screen.getByText('This isn’t available yet.')).toBeTruthy();
    expect(await card('Storage')).toBeTruthy();
    expect(await card('About')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy();
    // Without the saved choice there's nothing to show as selected, so the theme waits.
    expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('says so in plain words when storage can’t be measured', async () => {
    setup();
    vi.mocked(api.getStorage).mockRejectedValue(
      new ApiError('internal', 'Something went wrong. Nothing was lost — please try again.'),
    );
    cleanup();
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    expect(await screen.findByText('Couldn’t measure the archive')).toBeTruthy();
    expect(screen.getByText('Something went wrong. Nothing was lost — please try again.')).toBeTruthy();
  });
});
