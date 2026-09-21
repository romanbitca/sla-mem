/**
 * "Open" and "Show in folder" for archived attachments. Attachments are untrusted (PLAN §3.6):
 * files that would *run* rather than open (programs, scripts, installers, shortcuts) are only ever
 * revealed in Finder/Explorer, never launched from the archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getFileRow, type DB } from './db';
import { notFound } from './errors';
import { isInside } from './paths';

const RUNNABLE = new Set([
  // Windows
  'exe',
  'msi',
  'msix',
  'appx',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'reg',
  'inf',
  'url',
  'jar',
  'appref-ms',
  'gadget',
  'msc',
  // macOS and Unix
  'app',
  'command',
  'tool',
  'sh',
  'bash',
  'zsh',
  'csh',
  'pkg',
  'mpkg',
  'workflow',
  'scpt',
  'applescript',
  'terminal',
  'webloc',
  'inetloc',
  'fileloc',
  'py',
  'pl',
  'rb',
  'php',
]);

/** Would opening this file with the system run it? Then it is only revealed, never opened. */
export function isRunnableFile(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
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
