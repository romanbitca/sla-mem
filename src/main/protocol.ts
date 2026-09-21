/**
 * `archive://file/<id>` and `archive://thumb/<id>`: how the renderer shows downloaded attachments
 * without a local HTTP server (PLAN §3.3) and without file:// access.
 *
 * Attachments are untrusted (PLAN §3.6, pitfall 19): only raster images, video and audio are ever
 * served, always with `nosniff` and a sandboxing CSP. Everything else (HTML, SVG, PDFs, office
 * files…) is opened with the system app or revealed in the folder instead. Paths come from the
 * database, and are still confined to the files folder, case-insensitively on Windows and macOS
 * and after resolving symlinks (pitfall 23).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getFileRow, isInlineSafeMime, type DB } from './db';
import { isInside } from './paths';

export const ARCHIVE_SCHEME = 'archive';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const THUMB_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface FileProtocolDeps {
  db: DB;
  filesDir: string;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

export async function serveArchiveFile(request: Request, deps: FileProtocolDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  const id = safeDecode(url.pathname.replace(/^\/+/, ''));
  if (!id || !SAFE_ID.test(id)) return notFound();
  const row = getFileRow(deps.db, id);
  if (!row) return notFound();

  let rel: string | null = null;
  let type: string | null = null;
  const downloaded = row.download_status === 'done' && row.local_path != null;
  if (url.hostname === 'file') {
    if (!downloaded || !isInlineSafeMime(row.mimetype)) return notFound();
    rel = row.local_path;
    type = (row.mimetype ?? '').split(';')[0].trim().toLowerCase();
  } else if (url.hostname === 'thumb') {
    rel = row.thumb_local_path;
    // A downloaded image is its own thumbnail when Slack gave us no separate one.
    if (!rel && downloaded && isInlineSafeMime(row.mimetype) && (row.mimetype ?? '').startsWith('image/'))
      rel = row.local_path;
    type = rel ? (THUMB_TYPES[path.extname(rel).toLowerCase()] ?? null) : null;
    if (rel && !type && rel === row.local_path) type = (row.mimetype ?? '').toLowerCase();
  }
  if (!rel || !type) return notFound();

  const abs = await confinedPath(deps.filesDir, rel);
  if (!abs) return notFound();
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();
  return fileResponse(request, abs, stat.size, type);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Resolves `rel` under `root`, refusing anything (including a symlink) that escapes it. */
async function confinedPath(root: string, rel: string): Promise<string | null> {
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) return null;
  try {
    const [realRoot, realAbs] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(abs)]);
    return isInside(realRoot, realAbs) ? realAbs : null;
  } catch {
    return null;
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cache-Control': 'private, max-age=86400',
  'Accept-Ranges': 'bytes',
};

function fileResponse(request: Request, abs: string, size: number, type: string): Response {
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...BASE_HEADERS, 'Content-Range': `bytes */${size}` } });
  }
  const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': type };
  const [start, end] = range ?? [0, size - 1];
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });
  const stream = fs.createReadStream(abs, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` (one range only; multi-range isn't needed for media). */
export function parseRange(header: string | null, size: number): [number, number] | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return [start, end];
}
