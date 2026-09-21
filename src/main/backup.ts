/**
 * "Back up now" (PLAN §8.4): a single .zip of the archive — a consistent database snapshot (taken
 * with SQLite's online backup, so syncing can continue), the downloaded attachments and the
 * preferences. The Slack sign-in is deliberately left out: it is encrypted for this computer's
 * account only, and a restored archive simply asks to reconnect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { BackupResultDTO } from '../shared/types';
import type { DB } from './db';
import { renameReplacing } from './fsx';
import type { ArchivePaths } from './paths';

export const RESTORE_README = `sla-mem backup
====================

This zip contains a complete copy of a sla-mem:

  archive.db    all archived messages, people and conversations
  files/        downloaded attachments
  config.json   your settings

To restore it:
  1. Quit sla-mem (tray icon → Quit).
  2. Open the archive folder (Settings → Storage → Show folder).
  3. Move the existing archive.db, archive.db-wal, archive.db-shm, files and config.json somewhere safe.
  4. Unzip this backup into that folder.
  5. Start sla-mem and click Reconnect to keep archiving.
`;

export interface BackupOptions {
  db: DB;
  paths: ArchivePaths;
  destDir: string;
  now?: Date;
  onProgress?: (message: string) => void;
}

export async function backupArchive(opts: BackupOptions): Promise<BackupResultDTO> {
  const stamp = timestamp(opts.now ?? new Date());
  const zipPath = uniquePath(path.join(opts.destDir, `sla-mem backup ${stamp}.zip`));
  const snapshot = path.join(opts.paths.tmpDir, `backup-${process.pid}-${Date.now()}.db`);
  const partial = `${zipPath}.part`;
  await fs.promises.mkdir(opts.paths.tmpDir, { recursive: true });
  try {
    opts.onProgress?.('Copying the database…');
    await opts.db.backup(snapshot);
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(partial));
    // The snapshot is already compressed poorly by nature; store attachments as-is (mostly media).
    zip.addFile(snapshot, 'archive.db', { compress: true });
    if (fs.existsSync(opts.paths.configPath)) zip.addFile(opts.paths.configPath, 'config.json');
    zip.addBuffer(Buffer.from(RESTORE_README), 'README.txt');
    opts.onProgress?.('Adding attachments…');
    for (const file of await listFiles(opts.paths.filesDir)) {
      const rel = path.relative(opts.paths.filesDir, file).split(path.sep).join('/');
      if (rel.split('/').some((part) => part.startsWith('.'))) continue; // temp downloads
      zip.addFile(file, `files/${rel}`, { compress: false });
    }
    zip.end();
    await done;
    await renameReplacing(partial, zipPath);
    const { size } = await fs.promises.stat(zipPath);
    return { path: zipPath, bytes: size };
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  } finally {
    await fs.promises.rm(snapshot, { force: true });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}

function timestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
