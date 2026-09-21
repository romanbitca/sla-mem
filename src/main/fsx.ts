/**
 * File-system helpers that behave the same on macOS and Windows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY']);

/**
 * Renames `src` over `dest`. On Windows a rename onto an existing file fails with EPERM/EBUSY
 * while anything (antivirus, the indexer, our own file viewer) holds it open, so this retries with
 * a short backoff and, as a last resort, removes the target first (pitfall 22).
 */
export async function renameReplacing(src: string, dest: string, attempts = 6): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || i >= attempts) throw err;
      if (i === attempts - 1) await fs.promises.rm(dest, { force: true }).catch(() => undefined);
      await sleep(25 * 2 ** i);
    }
  }
}

/** Synchronous variant for small files written during startup/shutdown (config.json). */
export function renameReplacingSync(src: string, dest: string, attempts = 5): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || i >= attempts) throw err;
      if (i === attempts - 1) fs.rmSync(dest, { force: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i);
    }
  }
}

/** Writes via a temp file in the same folder and renames it into place (never a half-written file). */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, data, mode != null ? { mode } : undefined);
  try {
    renameReplacingSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Total size of the files under `dir` (0 when it doesn't exist). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await fs.promises.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
