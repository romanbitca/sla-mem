import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from './import/attachments';
import { isRunnableFile, markAsDownloaded, quarantineValue, ZONE_IDENTIFIER } from './file-actions';

describe('isRunnableFile (never launched from the archive)', () => {
  it('knows programs, scripts, installers and shortcuts on every platform', () => {
    for (const name of [
      'setup.exe',
      'Update.MSI',
      'run.cmd',
      'invoice.pdf.js',
      'tool.ps1',
      'help.chm',
      'meeting.rdp',
      'app.appinstaller',
      'addin.xll',
      'Install.command',
      'profile.mobileconfig',
      'Clean up.shortcut',
      'launch.jnlp',
      'deploy.sh',
      'report.py',
    ]) {
      expect(isRunnableFile(name), name).toBe(true);
    }
  });

  it('isn’t fooled by trailing dots and spaces, which Windows drops', () => {
    expect(isRunnableFile('setup.exe.')).toBe(true);
    expect(isRunnableFile('setup.exe. . ')).toBe(true);
    expect(isRunnableFile('/files/F1/run.bat ')).toBe(true);
  });

  it('opens documents, images and archives', () => {
    for (const name of ['report.pdf', 'photo.JPG', 'notes.txt', 'deck.pptx', 'design.fig', 'backup.zip', 'README']) {
      expect(isRunnableFile(name), name).toBe(false);
    }
  });

  it('imports keep no trailing dots or spaces in names', () => {
    expect(sanitizeFileName('setup.exe.')).toBe('setup.exe');
    expect(sanitizeFileName('setup.exe . . ')).toBe('setup.exe');
    expect(sanitizeFileName('...')).toBe('file');
  });
});

describe('markAsDownloaded (the mark a browser gives a download)', () => {
  const now = () => Date.UTC(2026, 8, 22, 12, 0, 0);

  it('quarantines on macOS, like a browser download not yet opened', async () => {
    const calls: [string, string[]][] = [];
    await markAsDownloaded('/archive/files/F1/Setup.zip', {
      platform: 'darwin',
      now,
      execFile: async (file, args) => {
        calls.push([file, args]);
      },
    });
    expect(calls).toEqual([
      ['/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(now()), '/archive/files/F1/Setup.zip']],
    ]);
    expect(quarantineValue(now())).toBe(`0081;${(now() / 1000).toString(16)};Slamem;`);
  });

  it('adds the Mark of the Web on Windows (zone 3, the internet)', async () => {
    const writes: [string, string][] = [];
    await markAsDownloaded('C:\\archive\\files\\F1\\report.docm', {
      platform: 'win32',
      writeFile: async (file, data) => {
        writes.push([file, data]);
      },
    });
    expect(writes).toEqual([['C:\\archive\\files\\F1\\report.docm:Zone.Identifier', ZONE_IDENTIFIER]]);
    expect(ZONE_IDENTIFIER).toContain('ZoneId=3');
  });

  it('does nothing elsewhere', async () => {
    let touched = false;
    const touch = async () => {
      touched = true;
    };
    await markAsDownloaded('/archive/files/F1/a.pdf', { platform: 'linux', execFile: touch, writeFile: touch });
    expect(touched).toBe(false);
  });
});
