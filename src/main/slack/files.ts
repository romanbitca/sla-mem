import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentPolicy, SyncProgress } from '../../shared/types';
import {
  listDownloadCandidates,
  markFileDownloaded,
  markFileFailed,
  markFileSkipped,
  markFileUnavailable,
  setFileThumb,
  type DB,
  type FileRow,
} from '../db';
import { isDiskFullError } from '../errors';
import type { SlackClient } from './client';
import { DownloadError } from './errors';
import { decideDownload } from './policy';
import type { SlackFile } from './types';
import { forEachConcurrent, isAbortError, throwIfAborted } from './util';

export interface DownloadFilesOptions {
  db: DB;
  client: SlackClient;
  /** Where attachments live; stored paths are relative to it. */
  filesDir: string;
  /** Which files to download (PLAN §8.4). */
  policy: AttachmentPolicy;
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  log?: (line: string) => void;
  /** Parallel downloads (default 3). files.slack.com isn't tier-limited, but be polite. */
  concurrency?: number;
  /** Epoch ms clock (retry backoff, "older than Slack's window"). */
  now?: () => number;
  /** Conversations not to archive: files only they share aren't downloaded. */
  excludedConversationIds?: readonly string[];
}

export interface DownloadFilesStats {
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  filesUnavailable: number;
}

type FileOutcome = 'downloaded' | 'failed' | 'skipped' | 'unavailable' | 'unchanged';

const THUMB_MAX_BYTES = 20 * 1024 * 1024;
const MAX_NAME_CHARS = 150;
/** Keeps multi-byte names well under the 255-byte filename limit of APFS/NTFS/ext4. */
const MAX_NAME_BYTES = 200;
const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Slack Free stops serving files after 90 days; a definitive failure past that is final. */
const FREE_WINDOW_SECONDS = 90 * 86_400;

interface Context {
  db: DB;
  client: SlackClient;
  filesDir: string;
  policy: AttachmentPolicy;
  signal?: AbortSignal;
  log: (line: string) => void;
  now: () => number;
}

/**
 * Downloads every eligible file (oldest first: on the Free plan those disappear from Slack next)
 * into `filesDir/<id>/<sanitized name>`, plus its best thumbnail as `filesDir/<id>/thumb.<ext>`.
 * Each file's outcome is committed as soon as it's known, so an aborted run keeps its progress.
 * A full disk stops the pass (every other file would fail the same way).
 */
export async function downloadPendingFiles(opts: DownloadFilesOptions): Promise<DownloadFilesStats> {
  const ctx: Context = {
    db: opts.db,
    client: opts.client,
    filesDir: path.resolve(opts.filesDir),
    policy: opts.policy,
    signal: opts.signal,
    log: opts.log ?? (() => undefined),
    now: opts.now ?? Date.now,
  };
  const stats: DownloadFilesStats = { filesDownloaded: 0, filesFailed: 0, filesSkipped: 0, filesUnavailable: 0 };
  const rows = listDownloadCandidates(ctx.db, {
    now: ctx.now(),
    excludedConversationIds: opts.excludedConversationIds,
  });
  if (!rows.length) return stats;

  let finished = 0;
  let announced = false;
  await forEachConcurrent(rows, opts.concurrency ?? 3, async (row) => {
    throwIfAborted(ctx.signal);
    const outcome = await processFile(row, ctx);
    if (outcome !== 'unchanged') stats[STAT_KEY[outcome]]++;
    finished++;
    if (outcome === 'downloaded' || outcome === 'failed' || announced) {
      announced = true;
      opts.onProgress?.({
        phase: 'files',
        message: `Downloading attachments — ${finished.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}`,
        current: finished,
        total: rows.length,
      });
    }
  });
  if (stats.filesDownloaded || stats.filesFailed || stats.filesUnavailable) {
    ctx.log(
      `Files: ${stats.filesDownloaded} downloaded, ${stats.filesFailed} failed, ` +
        `${stats.filesSkipped} skipped, ${stats.filesUnavailable} unavailable`,
    );
  }
  return stats;
}

const STAT_KEY: Record<Exclude<FileOutcome, 'unchanged'>, keyof DownloadFilesStats> = {
  downloaded: 'filesDownloaded',
  failed: 'filesFailed',
  skipped: 'filesSkipped',
  unavailable: 'filesUnavailable',
};

async function processFile(row: FileRow, ctx: Context): Promise<FileOutcome> {
  const label = fileLabel(row);
  const unavailable = unavailableReason(row);
  if (unavailable) {
    markFileUnavailable(ctx.db, row.id, unavailable);
    return 'unavailable';
  }
  const decision = decideDownload(row, ctx.policy);
  if (!decision.download) {
    const already =
      row.download_status === 'skipped' &&
      row.skip_reason === decision.reason &&
      row.download_error === decision.detail;
    markFileSkipped(ctx.db, row.id, decision.reason, decision.detail);
    // A skipped video still gets its (small) preview image, unless attachments are off entirely.
    if (ctx.policy !== 'none' && !row.thumb_local_path && row.thumb_url) {
      const target = safeTarget(ctx.filesDir, row);
      const thumb = target ? await downloadThumb(row, target, ctx, label) : undefined;
      if (thumb) setFileThumb(ctx.db, row.id, thumb);
    }
    return already ? 'unchanged' : 'skipped';
  }
  let target: FileTarget;
  try {
    target = fileTarget(ctx.filesDir, row);
  } catch (err) {
    return recordFailure(row, err, ctx, label);
  }
  try {
    const url = (row.url_private_download ?? row.url_private)!;
    await ctx.client.downloadFile(url, target.absPath, {
      maxBytes: decision.maxBytes,
      allowHtml: isHtmlFile(row),
      signal: ctx.signal,
      expectedBytes: row.size,
    });
  } catch (err) {
    return recordFailure(row, err, ctx, label);
  }
  const thumb = await downloadThumb(row, target, ctx, label);
  markFileDownloaded(ctx.db, row.id, target.relPath, thumb);
  return 'downloaded';
}

function safeTarget(filesDir: string, row: FileRow): FileTarget | null {
  try {
    return fileTarget(filesDir, row);
  } catch {
    return null;
  }
}

function recordFailure(row: FileRow, err: unknown, ctx: Context, label: string): FileOutcome {
  if (isAbortError(err) || ctx.signal?.aborted) throw err;
  // A full disk fails every remaining file the same way; stop instead of burning their attempts.
  if (isDiskFullError(err)) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DownloadError && err.kind === 'too_large') {
    markFileSkipped(ctx.db, row.id, 'too_large', 'Larger than the attachment size limit');
    ctx.log(`${label}: skipped, ${message}`);
    return 'skipped';
  }
  const gone = err instanceof DownloadError && (err.status === 404 || err.status === 410);
  const pastWindow = row.created != null && row.created * 1000 < ctx.now() - FREE_WINDOW_SECONDS * 1000;
  const definitive = err instanceof DownloadError && (err.kind === 'http' || err.kind === 'html') && !err.retryable;
  if (gone || (pastWindow && definitive)) {
    // Deleted in Slack, or aged out of the Free plan. A later sync that sees a usable copy of the
    // file flips it back to pending.
    markFileUnavailable(ctx.db, row.id, 'No longer available from Slack');
    ctx.log(`${label}: no longer available from Slack (${message})`);
    return 'unavailable';
  }
  markFileFailed(ctx.db, row.id, message, ctx.now());
  ctx.log(`${label}: download failed, will retry later: ${message}`);
  return 'failed';
}

/** Why a queued row can't be fetched at all, based on the stored Slack file object. */
function unavailableReason(row: FileRow): string | null {
  const f = parseFile(row.raw);
  if (f?.mode === 'hidden_by_limit') return 'Hidden by Slack’s Free plan';
  if (f?.mode === 'tombstone') return 'Deleted in Slack';
  if (f?.mode === 'external' || f?.is_external === true) return 'Stored outside Slack (for example Google Drive)';
  if (!row.url_private_download && !row.url_private) return 'No longer available from Slack';
  return null;
}

function parseFile(raw: string): SlackFile | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as SlackFile) : null;
  } catch {
    return null;
  }
}

function isHtmlFile(row: FileRow): boolean {
  return (row.mimetype ?? '').toLowerCase().startsWith('text/html') || (row.filetype ?? '').toLowerCase() === 'html';
}

function fileLabel(row: FileRow): string {
  const name = row.name ?? row.title;
  return name ? `File ${row.id} (${name.length > 60 ? `${name.slice(0, 57)}…` : name})` : `File ${row.id}`;
}

// ---------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Thumbnail failures never fail the file itself. Returns the relative thumb path, or undefined
 * to leave whatever thumb is stored untouched.
 */
async function downloadThumb(
  row: FileRow,
  target: FileTarget,
  ctx: Context,
  label: string,
): Promise<string | undefined> {
  if (!row.thumb_url) return undefined;
  let name = `thumb.${extensionFromUrl(row.thumb_url) ?? 'jpg'}`;
  // A file literally named "thumb.png" must not be overwritten by its own thumbnail.
  if (name.toLowerCase() === path.basename(target.absPath).toLowerCase()) name = `thumb-1.${name.split('.').pop()}`;
  const absPath = path.join(target.dir, name);
  try {
    const result = await ctx.client.downloadFile(row.thumb_url, absPath, {
      maxBytes: THUMB_MAX_BYTES,
      signal: ctx.signal,
    });
    const type = (result.contentType ?? '').split(';')[0].trim().toLowerCase();
    if (type && !type.startsWith('image/')) {
      await fs.promises.rm(absPath, { force: true });
      ctx.log(`${label}: thumbnail ignored (got ${type})`);
      return undefined;
    }
    return path.relative(ctx.filesDir, absPath);
  } catch (err) {
    if (isAbortError(err) || ctx.signal?.aborted) throw err;
    ctx.log(`${label}: thumbnail not saved: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function extensionFromUrl(url: string): string | null {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    return Object.values(IMAGE_EXTENSIONS).includes(ext) ? ext : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------------------------

export interface FileTarget {
  /** Directory `filesDir/<id>`. */
  dir: string;
  absPath: string;
  /** Relative to filesDir, as stored in `files.local_path`. */
  relPath: string;
}

/** Where a file lives on disk. Throws for ids that aren't a safe single path segment. */
export function fileTarget(filesDir: string, row: Pick<FileRow, 'id' | 'name' | 'title' | 'filetype'>): FileTarget {
  if (!SAFE_FILE_ID.test(row.id)) throw new Error('unsafe file id');
  const root = path.resolve(filesDir);
  const name = sanitizeFileName(row.name ?? row.title, fallbackName(row));
  const dir = path.join(root, row.id);
  const absPath = path.join(dir, name);
  // Belt and braces: sanitization already rules this out.
  if (path.relative(root, absPath).startsWith('..') || path.dirname(absPath) !== dir) {
    throw new Error('file path escapes the files directory');
  }
  return { dir, absPath, relPath: path.relative(root, absPath) };
}

function fallbackName(row: Pick<FileRow, 'id' | 'filetype'>): string {
  const ext = row.filetype && /^[a-z0-9]{1,10}$/i.test(row.filetype) ? `.${row.filetype.toLowerCase()}` : '';
  return `${row.id}${ext}`;
}

/**
 * Turns an untrusted Slack file name into a single safe path segment: no separators, no `..`,
 * no control characters, no leading dot (hidden files, and our `.dl-*.part` temp names), at most
 * 150 characters / 200 UTF-8 bytes with the extension preserved.
 */
export function sanitizeFileName(name: string | null | undefined, fallback = 'file'): string {
  const cleaned = clean(name ?? '');
  if (cleaned) return truncateName(cleaned);
  return truncateName(clean(fallback) || 'file');
}

function clean(raw: string): string {
  const name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[/\\]/g, '_')
    // Reserved on Windows/SMB shares and shown as "/" by Finder; harmless to replace everywhere.
    .replace(/[:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with any extension) can't be created on Windows (pitfall 21).
  return WINDOWS_RESERVED.test(name) ? `_${name}` : name;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

function truncateName(name: string): string {
  if (fits(name)) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stem = Array.from(ext ? name.slice(0, dot) : name);
  while (stem.length > 1 && !fits(stem.join('') + ext)) stem.pop();
  return (stem.join('').replace(/[.\s]+$/, '') || 'file') + ext;
}

function fits(name: string): boolean {
  return Array.from(name).length <= MAX_NAME_CHARS && Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES;
}
