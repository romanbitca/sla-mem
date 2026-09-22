/**
 * "Open" and "Show in folder" for archived attachments. Attachments are untrusted (PLAN §3.6):
 * files that would *run* rather than open (programs, scripts, installers, shortcuts) are only ever
 * revealed in Finder/Explorer, never launched from the archive; and before either, the file gets
 * the mark a browser gives a download, so the system vets whatever it holds.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getFileRow, type DB } from './db';
import { notFound } from './errors';
import { isInside } from './paths';

const RUNNABLE = new Set([
  // Windows
  'exe',
  'msi',
  'msp',
  'mst',
  'msix',
  'msixbundle',
  'appx',
  'appxbundle',
  'appinstaller',
  'application',
  'xbap',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'ps1',
  'psm1',
  'psd1',
  'ps1xml',
  'psc1',
  'msh',
  'vb',
  'vbs',
  'vbe',
  'js',
  'jse',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  'sct',
  'hta',
  'chm',
  'lnk',
  'scf',
  'shb',
  'shs',
  'reg',
  'inf',
  'ins',
  'isp',
  'url',
  'website',
  'rdp',
  'jar',
  'jnlp',
  'appref-ms',
  'library-ms',
  'searchconnector-ms',
  'settingcontent-ms',
  'diagcab',
  'gadget',
  'msc',
  'xll',
  'iqy',
  'slk',
  // macOS and Unix
  'app',
  'command',
  'tool',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'tcsh',
  'pkg',
  'mpkg',
  'mobileconfig',
  'shortcut',
  'workflow',
  'action',
  'scpt',
  'scptd',
  'applescript',
  'terminal',
  'webloc',
  'inetloc',
  'fileloc',
  'afploc',
  'ftploc',
  'prefpane',
  'saver',
  'qlgenerator',
  'mdimporter',
  'plugin',
  'bundle',
  'kext',
  'osax',
  'desktop',
  'appimage',
  'py',
  'pyw',
  'pyz',
  'pl',
  'rb',
  'php',
]);

/**
 * Would opening this file with the system run it? Then it is only revealed, never opened.
 * Trailing dots and spaces don't hide an extension: Windows drops them ("setup.exe." runs).
 */
export function isRunnableFile(name: string): boolean {
  const ext = path
    .extname(name.replace(/[.\s]+$/, ''))
    .slice(1)
    .toLowerCase();
  return RUNNABLE.has(ext);
}

/** The absolute path of a downloaded attachment, confined to the files folder, or throws. */
export function localAttachmentPath(db: DB, filesDir: string, fileId: string): string {
  const row = getFileRow(db, fileId);
  if (!row || row.download_status !== 'done' || !row.local_path)
    throw notFound('That attachment isn’t saved in the archive.');
  const abs = path.resolve(filesDir, row.local_path);
  if (!isInside(filesDir, abs) || !fs.existsSync(abs))
    throw notFound('That attachment isn’t saved in the archive any more.');
  return abs;
}

// ─── the "downloaded from the internet" mark ──────────────────────────────────────────────────

/** macOS quarantine as a browser writes it (flags 0081: downloaded), without the user's approval flag. */
export function quarantineValue(nowMs: number): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};Slamem;`;
}

/** Windows' Mark of the Web: zone 3, the internet. */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://files.slack.com/\r\n';

export interface MarkOptions {
  platform?: NodeJS.Platform;
  execFile?: (file: string, args: string[]) => Promise<void>;
  writeFile?: (file: string, data: string) => Promise<void>;
  now?: () => number;
}

/**
 * Marks an attachment the way a browser marks a download. Slamem writes the file itself, so the
 * system doesn't know it came from the internet; marked, it gets the same checks as a download
 * from Slack's own app: macOS quarantine (Gatekeeper vets an app or script before it first runs,
 * also once unpacked from a zip or disk image), Windows' Mark of the Web (SmartScreen, Office's
 * Protected View with macros blocked).
 */
export async function markAsDownloaded(file: string, opts: MarkOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const run = opts.execFile ?? runQuietly;
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue((opts.now ?? Date.now)()), file]);
  } else if (platform === 'win32') {
    // An NTFS stream next to the file; other file systems have none, and the file just opens.
    await (opts.writeFile ?? ((f, data) => fs.promises.writeFile(f, data)))(`${file}:Zone.Identifier`, ZONE_IDENTIFIER);
  }
}

function runQuietly(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${String(stderr).trim() || err.message}`));
      else resolve();
    });
  });
}
