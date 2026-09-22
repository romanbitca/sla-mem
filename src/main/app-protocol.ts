/**
 * `slamem://app/…`: where the window loads the app's own pages from (PLAN §3.6). A page loaded
 * from file:// gets powers no web page has: Electron lets it read other local files, and "self"
 * in its Content-Security-Policy covers every file on the disk, attachments included. So the
 * renderer is served from this private origin instead, only the built renderer's own files, and
 * the packaged app switches Electron's file:// extras off (the GrantFileProtocolExtraPrivileges
 * fuse in electron-builder.yml).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './paths';

export const APP_SCHEME = 'slamem';
const APP_HOST = 'app';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** What the built renderer is made of (Vite output). Anything else isn't served. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

/** A page of the app itself (the main window's own address). */
export function isAppPageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

/** Serves a file of the built renderer (`rendererDir`, inside app.asar when packaged). */
export async function serveAppFile(request: Request, rendererDir: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  let url: URL;
  let pathname: string;
  try {
    url = new URL(request.url);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  if (url.host !== APP_HOST || pathname.includes('\0')) return notFound();
  const abs = path.resolve(rendererDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  const type = TYPES[path.extname(abs).toLowerCase()];
  if (!type || !isInside(rendererDir, abs)) return notFound();
  let body: Buffer;
  try {
    body = await fs.promises.readFile(abs);
  } catch {
    return notFound();
  }
  const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
}
