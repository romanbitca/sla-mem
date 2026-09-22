import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameReplacing } from '../fsx';
import { DownloadError } from './errors';
import { abortReason, formatBytes, parseRetryAfter } from './util';

/**
 * One attempt at downloading a URL to disk. Retries, pacing and the host trust policy live in
 * `SlackClient.downloadFile`; this module only moves bytes safely:
 *  - redirects are followed by hand so the caller decides, per hop, whether the token is sent;
 *  - the body streams to a temp file in the destination directory and is renamed into place only
 *    when complete, so a crash or abort never leaves a truncated file under the final name;
 *  - size limits are enforced on both Content-Length and the streamed byte count.
 */

export interface DownloadOptions {
  /** Refuse bodies larger than this (declared or streamed). Default: unlimited. */
  maxBytes?: number;
  /** Accept `text/html` bodies. Off by default because Slack answers with its login page when the token can't read a file. */
  allowHtml?: boolean;
  signal?: AbortSignal;
  /** Abort (as a retryable network error) when no bytes arrive for this long. Default 60s. */
  idleTimeoutMs?: number;
  /**
   * The size Slack reported for the file. An empty or shorter body is an incomplete download and
   * is never recorded as done (pitfall 5).
   */
  expectedBytes?: number | null;
}

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
}

export interface DownloadRequest extends DownloadOptions {
  url: string;
  destPath: string;
  fetch: typeof fetch;
  /**
   * Request headers for a hop, or null to refuse the host. `isRedirect` lets the caller accept
   * CDN redirects while never sending credentials to them.
   */
  headersFor(url: URL, isRedirect: boolean): Record<string, string> | null;
}

const MAX_REDIRECTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export async function downloadOnce(req: DownloadRequest): Promise<DownloadResult> {
  const idle = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal;
  const res = await fetchFollowingRedirects(req, signal);
  try {
    checkResponse(res, req);
  } catch (err) {
    await discardBody(res);
    throw err;
  }
  const bytes = await writeBodyAtomically(res, req, signal, idle);
  return { bytes, contentType: res.headers.get('content-type') };
}

async function fetchFollowingRedirects(req: DownloadRequest, signal: AbortSignal): Promise<Response> {
  let url = parseUrl(req.url);
  for (let hop = 0; ; hop++) {
    const headers = req.headersFor(url, hop > 0);
    if (!headers) throw new DownloadError('untrusted_url', `refusing to download from ${url.protocol}//${url.host}`);
    let res: Response;
    try {
      res = await req.fetch(url.href, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (err) {
      if (req.signal?.aborted) throw abortReason(req.signal);
      throw new DownloadError('network', describeFetchError(err));
    }
    if (!isRedirect(res.status)) return res;
    await discardBody(res);
    const location = res.headers.get('location');
    if (!location) throw new DownloadError('http', `HTTP ${res.status} redirect without a Location`, res.status);
    if (hop >= MAX_REDIRECTS) throw new DownloadError('http', 'too many redirects', res.status);
    url = parseUrl(location, url);
  }
}

function parseUrl(value: string, base?: URL): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new DownloadError('untrusted_url', 'invalid download URL');
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function checkResponse(res: Response, req: DownloadRequest): void {
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    throw new DownloadError('http', 'HTTP 429 (rate limited)', 429, retryAfter);
  }
  if (!res.ok) throw new DownloadError('http', `HTTP ${res.status}`, res.status);
  const declared = Number(res.headers.get('content-length'));
  if (req.maxBytes != null && Number.isFinite(declared) && declared > req.maxBytes) {
    throw new DownloadError('too_large', `${formatBytes(declared)} exceeds the ${formatBytes(req.maxBytes)} limit`);
  }
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!req.allowHtml && type.startsWith('text/html')) {
    // Slack's sign-in page: the token lacks files:read, or the browser session/cookie expired.
    throw new DownloadError(
      'html',
      'got an HTML page instead of the file (missing files:read scope, or the Slack session expired)',
    );
  }
}

async function writeBodyAtomically(
  res: Response,
  req: DownloadRequest,
  signal: AbortSignal,
  idle: AbortController,
): Promise<number> {
  const dir = path.dirname(req.destPath);
  await fs.promises.mkdir(dir, { recursive: true });
  // Same directory as the target so the final rename is atomic (same filesystem). The leading dot
  // can't collide with a sanitized file name (those never start with a dot).
  const tmp = path.join(dir, `.dl-${crypto.randomBytes(6).toString('hex')}.part`);
  const fh = await fs.promises.open(tmp, 'wx');
  let closed = false;
  try {
    const bytes = await streamToHandle(res, fh, req, signal, idle);
    await fh.sync();
    await fh.close();
    closed = true;
    // Windows refuses to rename over a file something holds open; retried there (pitfall 22).
    await renameReplacing(tmp, req.destPath);
    return bytes;
  } catch (err) {
    if (!closed) await fh.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

async function streamToHandle(
  res: Response,
  fh: fs.promises.FileHandle,
  req: DownloadRequest,
  signal: AbortSignal,
  idle: AbortController,
): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return 0;
  const idleMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new DownloadError('network', 'download stalled')), idleMs);
  };
  // Bodies that ignore the fetch signal still stop promptly: cancelling the reader ends read().
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  // Stopped while the file was being created: the event has already fired.
  if (signal.aborted) onAbort();
  let bytes = 0;
  try {
    arm();
    for (;;) {
      const chunk = await readChunk(reader, req, idle);
      if (chunk === null) break;
      bytes += chunk.byteLength;
      if (req.maxBytes != null && bytes > req.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('too_large', `larger than the ${formatBytes(req.maxBytes)} limit`);
      }
      await writeFully(fh, chunk);
      arm();
    }
    // A cancelled reader reports "done", so check before treating the body as complete.
    throwIfStopped(req, idle);
    assertComplete(res, bytes, req.expectedBytes);
    return bytes;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  req: DownloadRequest,
  idle: AbortController,
): Promise<Uint8Array | null> {
  try {
    const { done, value } = await reader.read();
    return done ? null : value;
  } catch (err) {
    throwIfStopped(req, idle);
    throw new DownloadError('network', describeFetchError(err));
  }
}

function throwIfStopped(req: DownloadRequest, idle: AbortController): void {
  if (req.signal?.aborted) throw abortReason(req.signal);
  if (idle.signal.aborted) throw abortReason(idle.signal);
}

/** A body shorter than its declared (or Slack-reported) length means the transfer broke off. */
function assertComplete(res: Response, bytes: number, expected: number | null | undefined): void {
  if (bytes === 0 && expected !== 0) throw new DownloadError('network', 'empty download');
  if (res.headers.get('content-encoding')) return; // fetch decodes; the declared length is of the encoded body
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && bytes < declared) {
    throw new DownloadError('network', `incomplete download (${bytes} of ${declared} bytes)`);
  }
  if (expected != null && expected > 0 && bytes < expected) {
    throw new DownloadError('network', `incomplete download (${bytes} of ${expected} bytes)`);
  }
}

async function writeFully(fh: fs.promises.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fh.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Undici hides the useful part (ECONNRESET, ENOTFOUND…) in `cause`. */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timed out';
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === 'string') return `network error (${cause.code})`;
  return `network error (${err instanceof Error ? err.message : String(err)})`;
}
