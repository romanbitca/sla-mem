// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FileDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { installFakeBridge, makeFile, makeImage, renderWithProviders } from '../../test/helpers';
import { FileList, fileStatusNote } from './FileList';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function card(name: string): HTMLElement {
  return screen.getByText(name).closest('div[data-file-status]') as HTMLElement;
}

function renderFiles(files: FileDTO[]) {
  return renderWithProviders(<FileList files={files} />);
}

describe('file cards', () => {
  it('opens a saved document with the system app or shows it in Finder', async () => {
    installFakeBridge(() => undefined, 'darwin');
    const openFile = vi.spyOn(api, 'openFile').mockResolvedValue({ ok: true });
    const revealFile = vi.spyOn(api, 'revealFile').mockResolvedValue({ ok: true });
    renderFiles([
      makeFile({
        id: 'F3',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 2_500_000,
        permalink: 'https://9h.slack.com/files/U1/F3/report.pdf',
      }),
    ]);
    const el = card('report.pdf');
    expect(el.textContent).toContain('PDF · 2.4 MB');
    fireEvent.click(within(el).getByRole('button', { name: 'Open' }));
    fireEvent.click(within(el).getByRole('button', { name: 'Show report.pdf in Finder' }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith({ fileId: 'F3' }));
    expect(revealFile).toHaveBeenCalledWith({ fileId: 'F3' });
    const slack = within(el).getByRole('link', { name: 'Open report.pdf in Slack' });
    expect(slack.getAttribute('href')).toBe('https://9h.slack.com/files/U1/F3/report.pdf');
    expect(slack.getAttribute('target')).toBe('_blank');
  });

  it('names the file browser the way Windows does', () => {
    installFakeBridge(() => undefined, 'win32');
    renderFiles([makeFile({ id: 'F3', name: 'report.pdf' })]);
    expect(within(card('report.pdf')).getByRole('button', { name: 'Show report.pdf in Explorer' })).toBeTruthy();
  });

  it('never renders a document inline: a PDF shows its saved thumbnail at most', () => {
    const { container } = renderFiles([
      makeFile({ id: 'F4', name: 'deck.pdf', mimetype: 'application/pdf', thumbUrl: 'archive://thumb/F4' }),
      makeFile({ id: 'F5', name: 'page.html', mimetype: 'text/html', filetype: 'html' }),
      makeFile({ id: 'F6', name: 'logo.svg', mimetype: 'image/svg+xml', filetype: 'svg', isImage: true }),
    ]);
    expect(container.querySelector('iframe, object, embed')).toBeNull();
    const thumbs = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(thumbs).toEqual(['archive://thumb/F4']);
    // An SVG without a raster thumbnail is a plain card too (never drawn from its markup).
    expect(card('logo.svg')).toBeTruthy();
  });

  it('plays saved video and audio inline from the archive', () => {
    const { container } = renderFiles([
      makeFile({ id: 'F7', name: 'demo.mp4', mimetype: 'video/mp4', url: 'archive://file/F7' }),
      makeFile({ id: 'F8', name: 'memo.m4a', mimetype: 'audio/mp4', url: 'archive://file/F8' }),
    ]);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('archive://file/F7');
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('archive://file/F8');
  });

  it('says why a file isn’t archived, in main’s words', () => {
    renderFiles([
      makeImage({
        id: 'F9',
        name: 'old.png',
        available: false,
        url: null,
        thumbUrl: null,
        status: 'unavailable',
        statusReason: 'Removed from Slack',
      }),
      makeFile({
        id: 'F10',
        name: 'movie.mov',
        available: false,
        status: 'skipped',
        statusReason: 'Too large (320 MB)',
      }),
      makeFile({
        id: 'F11',
        name: 'soon.zip',
        available: false,
        status: 'pending',
        statusReason: 'Waiting to be downloaded',
      }),
    ]);
    const old = card('old.png');
    expect(old.getAttribute('data-file-status')).toBe('unavailable');
    expect(old.textContent).toContain('Not archived · Removed from Slack');
    expect(within(old).queryByRole('button')).toBeNull();
    expect(card('movie.mov').textContent).toContain('Not archived · Too large (320 MB)');
    expect(card('soon.zip').textContent).toContain('Not downloaded yet · Waiting to be downloaded');
  });

  it('offers Retry on a failed download and says it’s on its way', async () => {
    const retryFile = vi.spyOn(api, 'retryFile').mockResolvedValue({ runId: 12 });
    renderFiles([
      makeFile({
        id: 'F12',
        name: 'notes.docx',
        available: false,
        status: 'failed',
        statusReason: 'Couldn’t download',
      }),
    ]);
    const el = card('notes.docx');
    expect(el.textContent).toContain('Couldn’t download');
    fireEvent.click(within(el).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryFile).toHaveBeenCalledWith({ fileId: 'F12' }));
    expect(await within(el).findByText(/Downloading again/)).toBeTruthy();
  });

  it('explains a failed action in plain words', async () => {
    vi.spyOn(api, 'openFile').mockRejectedValue(new ApiError('not_found', 'That file is no longer on this computer.'));
    renderFiles([makeFile({ id: 'F13', name: 'gone.txt' })]);
    fireEvent.click(within(card('gone.txt')).getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That file is no longer on this computer.');
  });
});

describe('fileStatusNote', () => {
  it('labels each status and drops a reason that only repeats the label', () => {
    expect(fileStatusNote({ available: true, status: 'done', statusReason: null })).toBeNull();
    expect(fileStatusNote({ available: false, status: 'failed', statusReason: 'Couldn’t download' })).toEqual({
      label: 'Couldn’t download',
      reason: null,
      retry: true,
    });
    expect(fileStatusNote({ available: false, status: 'unavailable', statusReason: null })).toEqual({
      label: 'Not archived',
      reason: null,
      retry: false,
    });
  });
});
