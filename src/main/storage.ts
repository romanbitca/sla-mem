/**
 * Disk usage and cleanup (PLAN §8.4 Storage, §10.5). Messages are never deleted: the only thing
 * the user can remove is downloaded attachments older than a cutoff, and their thumbnails stay.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CleanupResultDTO, StorageDTO } from '../shared/types';
import { listDownloadedFilesBefore, markFileRemoved, type DB } from './db';
import { directorySize } from './fsx';
import type { ArchivePaths } from './paths';
import { isInside } from './paths';

/** Past this, the UI suggests the cleanup (PLAN §10.5: "e.g. 20 GB"). */
export const LARGE_ARCHIVE_BYTES = 20 * 1024 ** 3;
/** Below this much free space the disk counts as nearly full. */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

export async function storageInfo(db: DB, paths: ArchivePaths): Promise<StorageDTO> {
  const size = (p: string) =>
    fs.promises.stat(p).then(
      (s) => s.size,
      () => 0,
    );
  const [dbMain, wal, shm, attachmentsBytes, logsBytes, diskFreeBytes] = await Promise.all([
    size(paths.dbPath),
    size(`${paths.dbPath}-wal`),
    size(`${paths.dbPath}-shm`),
    directorySize(paths.filesDir),
    directorySize(paths.logsDir),
    freeSpace(paths.dataDir),
  ]);
  const databaseBytes = dbMain + wal + shm;
  const totalBytes = databaseBytes + attachmentsBytes + logsBytes;
  const filesDownloaded =
    (db.prepare("SELECT count(*) AS n FROM files WHERE download_status = 'done'").get() as { n: number }).n ?? 0;
  return {
    dataDir: paths.dataDir,
    databaseBytes,
    attachmentsBytes,
    logsBytes,
    totalBytes,
    filesDownloaded,
    diskFreeBytes,
    warning: storageWarning(totalBytes, diskFreeBytes),
  };
}

export function storageWarning(totalBytes: number, diskFreeBytes: number | null): string | null {
  if (diskFreeBytes != null && diskFreeBytes < LOW_DISK_BYTES) {
    return 'Your disk is nearly full. Free up some space, or delete older downloaded attachments below.';
  }
  if (totalBytes > LARGE_ARCHIVE_BYTES) {
    return 'The archive is getting large. You can delete older downloaded attachments below; messages are always kept.';
  }
  return null;
}

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Deletes the local copies of attachments uploaded more than `months` months ago. Their rows
 * become `skipped / removed` (so no sync re-downloads them) and their thumbnails are kept.
 */
export async function deleteAttachmentsOlderThan(
  db: DB,
  filesDir: string,
  months: number,
  now: Date = new Date(),
): Promise<CleanupResultDTO> {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('Invalid number of months');
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const rows = listDownloadedFilesBefore(db, Math.floor(cutoff.getTime() / 1000));
  let filesRemoved = 0;
  let bytesFreed = 0;
  for (const row of rows) {
    if (!row.local_path) continue;
    const abs = path.resolve(filesDir, row.local_path);
    if (!isInside(filesDir, abs)) continue;
    const bytes = await fs.promises.stat(abs).then(
      (s) => s.size,
      () => 0,
    );
    try {
      await fs.promises.rm(abs, { force: true });
    } catch {
      continue; // locked (e.g. open in another app): leave it for next time
    }
    markFileRemoved(db, row.id);
    filesRemoved++;
    bytesFreed += bytes;
  }
  return { filesRemoved, bytesFreed };
}
