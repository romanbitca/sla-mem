// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { writePref } from '../../lib/storage';
import {
  installFakeBridge,
  makeSettings,
  makeSyncStatus,
  makeUpdateInfo,
  renderWithProviders,
} from '../../test/helpers';
import { UpdateBanner, updateInstruction } from './UpdateBanner';

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

const available = makeUpdateInfo({
  latestVersion: '1.3.0',
  available: true,
  notes: 'Fixes search sometimes missing recent messages.\n<b>Faster</b> start-up.',
  downloadUrl: 'https://github.com/romanbitca/sla-mem/releases/download/v1.3.0/sla-mem-1.3.0-arm64.dmg',
});

describe('UpdateBanner', () => {
  it('stays hidden when there is nothing new (or the check failed)', async () => {
    const getUpdateInfo = vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(makeUpdateInfo());
    const { container } = renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(getUpdateInfo).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    vi.spyOn(api, 'getUpdateInfo').mockRejectedValue(new ApiError('blocked', 'This isn’t available yet.'));
    const second = renderWithProviders(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(second.container.textContent).toBe('');
  });

  it('offers the download with the one instruction for this computer (macOS)', async () => {
    installFakeBridge(() => undefined, 'darwin');
    vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(available);
    const download = vi.spyOn(api, 'openUpdateDownload').mockResolvedValue({ ok: true });
    renderWithProviders(<UpdateBanner />);
    const banner = await screen.findByRole('region', { name: 'Update available' });
    expect(within(banner).getByText(/Version 1\.3\.0 is available/)).toBeTruthy();
    expect(
      within(banner).getByText(
        'Quit Slamem, then open the download and drag Slamem to Applications, replacing the old one.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it('tells Windows users to run the installer', () => {
    expect(updateInstruction('win32')).toMatch(/^Run the installer/);
  });

  it('updates and restarts with one click when Slamem can install it itself', async () => {
    installFakeBridge(() => undefined, 'darwin');
    const installable = { ...available, canInstall: true };
    vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(installable);
    const install = vi.spyOn(api, 'installUpdate').mockResolvedValue({
      ...installable,
      install: { state: 'downloading', progress: 0.25, waitingFor: null, error: null },
    });
    const download = vi.spyOn(api, 'openUpdateDownload').mockResolvedValue({ ok: true });
    renderWithProviders(<UpdateBanner />);
    const banner = await screen.findByRole('region', { name: 'Update available' });
    expect(
      within(banner).getByText(
        'Slamem restarts to finish. If your Mac then asks whether it may use the keychain, click Always Allow.',
      ),
    ).toBeTruthy();
    expect(within(banner).queryByRole('button', { name: 'Download' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Update and restart' }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(await within(banner).findByText('Downloading version 1.3.0…')).toBeTruthy();
    expect(within(banner).getByRole('progressbar', { name: 'Update download' }).getAttribute('aria-valuenow')).toBe(
      '25',
    );
    expect(within(banner).getByText('25%')).toBeTruthy();
    // Under way: nothing to click twice, and it can't be hidden.
    expect((within(banner).getByRole('button', { name: 'Update and restart' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(banner).queryByRole('button', { name: 'Hide until the next version' })).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('says what the restart waits for, then that it is restarting', async () => {
    const bridge = installFakeBridge((method) => {
      if (method === 'getUpdateInfo') return { ...available, canInstall: true };
      if (method === 'getSettings') return makeSettings();
      if (method === 'getSyncStatus') return makeSyncStatus();
      throw { code: 'blocked', message: 'Not in this test.' };
    });
    const { AppEffects } = await import('../../App');
    renderWithProviders(
      <>
        <AppEffects />
        <UpdateBanner />
      </>,
    );
    const banner = await screen.findByRole('region', { name: 'Update available' });
    await waitFor(() => expect(bridge.listenerCount('update')).toBe(1));
    bridge.emit('update', {
      ...available,
      canInstall: true,
      install: { state: 'waiting', progress: null, waitingFor: 'sync', error: null },
    });
    expect(await within(banner).findByText('Version 1.3.0 is ready')).toBeTruthy();
    expect(within(banner).getByText('Slamem restarts as soon as the sync finishes.')).toBeTruthy();
    bridge.emit('update', {
      ...available,
      canInstall: true,
      install: { state: 'restarting', progress: null, waitingFor: null, error: null },
    });
    expect(await within(banner).findByText('Restarting to update…')).toBeTruthy();
  });

  it('offers Try again and the download when an update failed, even for a hidden version', async () => {
    writePref('update.dismissed', '1.3.0');
    const failed = {
      ...available,
      canInstall: true,
      install: {
        state: 'failed' as const,
        progress: null,
        waitingFor: null,
        error: 'The download didn’t finish. Check your internet connection and try again.',
      },
    };
    vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(failed);
    const install = vi.spyOn(api, 'installUpdate').mockResolvedValue({
      ...failed,
      install: { state: 'downloading', progress: 0, waitingFor: null, error: null },
    });
    const download = vi.spyOn(api, 'openUpdateDownload').mockResolvedValue({ ok: true });
    installFakeBridge(() => undefined, 'darwin');
    renderWithProviders(<UpdateBanner />);
    const banner = await screen.findByRole('region', { name: 'Update available' });
    expect(
      within(banner).getByText('The download didn’t finish. Check your internet connection and try again.'),
    ).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    // Downloading by hand: the steps for that.
    expect(
      await within(banner).findByText(
        'Quit Slamem, then open the download and drag Slamem to Applications, replacing the old one.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it('says what happens when Slamem installs the update itself on Windows', () => {
    expect(updateInstruction('win32', true)).toBe('Slamem restarts to finish. Your archive stays where it is.');
  });

  it('shows the release notes as text in a small dialog', async () => {
    vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(available);
    renderWithProviders(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'What’s new' }));
    const dialog = screen.getByRole('dialog', { name: 'What’s new in version 1.3.0' });
    expect(dialog.textContent).toContain('Fixes search sometimes missing recent messages.');
    expect(dialog.textContent).toContain('<b>Faster</b> start-up.');
    expect(dialog.querySelector('b')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can be dismissed until the next version', async () => {
    const getUpdateInfo = vi.spyOn(api, 'getUpdateInfo').mockResolvedValue(available);
    renderWithProviders(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide until the next version' }));
    expect(screen.queryByRole('region', { name: 'Update available' })).toBeNull();
    cleanup();

    renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(getUpdateInfo).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Update available' })).toBeNull();
    cleanup();

    getUpdateInfo.mockResolvedValue({ ...available, latestVersion: '1.4.0' });
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByText(/Version 1\.4\.0 is available/)).toBeTruthy();
  });

  it('appears as soon as main announces a new version', async () => {
    const bridge = installFakeBridge((method) => {
      if (method === 'getUpdateInfo') return makeUpdateInfo();
      if (method === 'getSettings') return makeSettings();
      if (method === 'getSyncStatus') return makeSyncStatus();
      throw { code: 'blocked', message: 'Not in this test.' };
    });
    const { AppEffects } = await import('../../App');
    renderWithProviders(
      <>
        <AppEffects />
        <UpdateBanner />
      </>,
    );
    await waitFor(() => expect(bridge.listenerCount('update')).toBe(1));
    bridge.emit('update', available);
    expect(await screen.findByRole('region', { name: 'Update available' })).toBeTruthy();
  });
});
