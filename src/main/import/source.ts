import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { LISTING_FILES, isDayFileName } from './layout';

/**
 * Read-only view of a Slack export, either an extracted directory or a .zip archive.
 *
 * Entry paths are '/'-separated and relative to the export root: a single wrapper folder
 * ("my-export/users.json" when someone zipped the folder itself) is stripped, and macOS
 * metadata (__MACOSX, ._*, .DS_Store) is hidden. Only regular files are listed.
 */
export interface ExportSource {
  readonly kind: 'directory' | 'zip';
  /** Entry path → uncompressed size in bytes. */
  readonly entries: ReadonlyMap<string, number>;
  readText(entryPath: string): Promise<string>;
  /**
   * Streams an entry into `destFile` (created or truncated). `move` lets a directory source
   * rename instead of copy when the export is disposable; zip sources always copy.
   */
  copyTo(entryPath: string, destFile: string, opts?: { move?: boolean }): Promise<void>;
  close(): Promise<void>;
}

/** Opens `p` as a directory export or, for any regular file, as a zip archive. */
export async function openExportSource(p: string): Promise<ExportSource> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(p);
  } catch {
    throw new Error(`Not a Slack export: ${p} does not exist`);
  }
  if (stat.isDirectory()) return openDirectorySource(p);
  if (stat.isFile()) return openZipSource(p);
  throw new Error(`Not a Slack export: ${p} is neither a directory nor a .zip file`);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes an archive entry name to a safe relative path, or null when it could escape the
 * export root (absolute, drive-letter or '..' paths: "zip slip"). yauzl already rejects these,
 * this is defence in depth for anything that later builds paths from entry names.
 */
export function safeEntryPath(name: string): string | null {
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/** macOS/Windows metadata that zip tools and Finder sprinkle into archives. */
export function isJunkPath(p: string): boolean {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  return parts.includes('__MACOSX') || base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._');
}

/**
 * The prefix to strip so listing files / conversation folders sit at the root: '' for a plain
 * export, 'wrapper/' (possibly nested) when the export was zipped as its enclosing folder.
 * A lone top-level folder that itself holds day files is a conversation, not a wrapper.
 */
export function findExportRoot(paths: readonly string[], maxDepth = 3): string {
  let prefix = '';
  for (let depth = 0; depth < maxDepth; depth++) {
    const rel = paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    if (rel.some(isRootMarker)) return prefix;
    const topDirs = new Set<string>();
    let topFiles = 0;
    for (const p of rel) {
      const slash = p.indexOf('/');
      if (slash < 0) topFiles++;
      else topDirs.add(p.slice(0, slash));
    }
    if (topFiles > 0 || topDirs.size !== 1) return prefix;
    prefix += `${[...topDirs][0]}/`;
  }
  return prefix;
}

function isRootMarker(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.length === 1) return LISTING_FILES.has(parts[0]);
  return parts.length === 2 && isDayFileName(parts[1]);
}

/** Applies junk filtering and root stripping to `raw` (entry path → payload). */
function rootEntries<T>(raw: Map<string, T>): Map<string, T> {
  const clean = [...raw.keys()].filter((p) => !isJunkPath(p));
  const prefix = findExportRoot(clean);
  const out = new Map<string, T>();
  for (const p of clean) {
    if (p.startsWith(prefix) && p.length > prefix.length) out.set(p.slice(prefix.length), raw.get(p)!);
  }
  return out;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function missingEntry(entryPath: string): Error {
  return new Error(`Export entry not found: ${entryPath}`);
}

// ---------------------------------------------------------------------------------------------
// Directory exports
// ---------------------------------------------------------------------------------------------

interface DirFile {
  abs: string;
  size: number;
}

async function openDirectorySource(root: string): Promise<ExportSource> {
  const raw = new Map<string, DirFile>();
  await walk(root, '', raw);
  const files = rootEntries(raw);
  const get = (entryPath: string): DirFile => {
    const f = files.get(entryPath);
    if (!f) throw missingEntry(entryPath);
    return f;
  };
  return {
    kind: 'directory',
    entries: new Map([...files].map(([p, f]) => [p, f.size])),
    readText: async (entryPath) => stripBom(await fsp.readFile(get(entryPath).abs, 'utf8')),
    copyTo: (entryPath, destFile, opts) => transfer(get(entryPath).abs, destFile, opts?.move === true),
    close: async () => undefined,
  };
}

/** Rename when allowed (instant, no second copy on disk); copy across filesystems. */
async function transfer(src: string, dest: string, move: boolean): Promise<void> {
  if (move) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
  }
  await fsp.copyFile(src, dest);
}

/**
 * Symlinks are skipped on purpose: a link inside an export pointing at e.g. ~/.ssh would
 * otherwise be copied into the archive's file store and served by the web UI.
 */
async function walk(root: string, rel: string, out: Map<string, DirFile>): Promise<void> {
  const dir = path.join(root, rel);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  await Promise.all(
    dirents.map(async (d) => {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return walk(root, childRel, out);
      if (!d.isFile()) return;
      const abs = path.join(dir, d.name);
      out.set(childRel, { abs, size: (await fsp.stat(abs)).size });
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Zip exports
// ---------------------------------------------------------------------------------------------

/**
 * Reads the central directory once (entry metadata only) and then streams individual entries
 * on demand, so multi-GB exports never have to fit in memory. autoClose is off because entries
 * are opened after the directory listing finished.
 */
async function openZipSource(file: string): Promise<ExportSource> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, { autoClose: false, lazyEntries: true, validateEntrySizes: true });
  } catch (err) {
    throw new Error(`Not a Slack export: ${file} is not a readable zip archive (${errorMessage(err)})`, { cause: err });
  }
  let entries: Map<string, yauzl.Entry>;
  try {
    entries = rootEntries(await listZipEntries(zip));
  } catch (err) {
    zip.close();
    throw new Error(`Unsafe or corrupt zip archive ${file}: ${errorMessage(err)}`, { cause: err });
  }
  const open = async (entryPath: string): Promise<Readable> => {
    const entry = entries.get(entryPath);
    if (!entry) throw missingEntry(entryPath);
    return zip.openReadStreamPromise(entry);
  };
  return {
    kind: 'zip',
    entries: new Map([...entries].map(([p, e]) => [p, e.uncompressedSize])),
    readText: async (entryPath) => stripBom((await readAll(await open(entryPath))).toString('utf8')),
    copyTo: async (entryPath, destFile) => pipeline(await open(entryPath), fs.createWriteStream(destFile)),
    close: async () => zip.close(),
  };
}

async function listZipEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  const out = new Map<string, yauzl.Entry>();
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) continue; // directory entries are optional and carry no data
    const safe = safeEntryPath(entry.fileName);
    if (!safe) throw new Error(`unsafe entry path: ${entry.fileName}`);
    out.set(safe, entry);
  }
  return out;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
