import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExportSource } from './source';

/** Slack file ids are short upper-case alphanumerics; anything else must not become a path. */
const SAFE_FILE_ID_RE = /^[A-Z0-9]{2,40}$/;
const MAX_NAME_LENGTH = 150;
const MAX_EXTENSION_LENGTH = 20;

export function isSafeFileId(id: string): boolean {
  return SAFE_FILE_ID_RE.test(id);
}

/**
 * A file name that is safe as the last segment of `filesDir/<id>/<name>`: no path separators,
 * no control characters, never '.'/'..' or a dotfile, at most 150 chars (extension kept).
 */
export function sanitizeFileName(name: string | null | undefined): string {
  const base =
    String(name ?? '')
      .split(/[/\\]/)
      .pop() ?? '';
  let safe = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  if (!safe) safe = 'file';
  if (safe.length <= MAX_NAME_LENGTH) return safe;
  const ext = path.extname(safe);
  const keepExt = ext.length > 1 && ext.length <= MAX_EXTENSION_LENGTH ? ext : '';
  return safe.slice(0, MAX_NAME_LENGTH - keepExt.length) + keepExt;
}

/** Picks the local copy whose name matches the file's name, else the first candidate. */
export function pickLocalCopy(candidates: readonly string[], fileName: string | null | undefined): string {
  if (fileName && candidates.length > 1) {
    const wanted = sanitizeFileName(fileName);
    const match = candidates.find(
      (p) => p.endsWith(`/${fileName}`) || p.endsWith(`-${fileName}`) || p.endsWith(wanted),
    );
    if (match) return match;
  }
  return candidates[0];
}

/**
 * Copies (or, for disposable exports, moves) an export entry to `filesDir/<fileId>/<name>`
 * via a temp file + rename, so a crash
 * or cancel never leaves a truncated file under the final name. Returns the path relative to
 * filesDir, the form stored in `files.local_path`.
 */
export async function copyIntoFilesDir(
  source: ExportSource,
  entryPath: string,
  filesDir: string,
  fileId: string,
  name: string,
  opts: { move?: boolean } = {},
): Promise<string> {
  if (!isSafeFileId(fileId)) throw new Error(`refusing unsafe file id ${JSON.stringify(fileId)}`);
  const safeName = sanitizeFileName(name);
  const root = path.resolve(filesDir);
  const dir = path.join(root, fileId);
  const dest = path.join(dir, safeName);
  if (!dest.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}`);
  await fsp.mkdir(dir, { recursive: true });
  // Temp names start with a dot, which sanitized names never do, so they can't collide.
  const tmp = path.join(dir, `.import-${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    await source.copyTo(entryPath, tmp, opts);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return `${fileId}/${safeName}`;
}

export function localCopyExists(filesDir: string, localPath: string | null): boolean {
  return localPath != null && fs.existsSync(path.resolve(filesDir, localPath));
}
