/** Small helpers shared by the Slack client, sync engine and downloader. */

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    if (ms <= 0) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The error to throw for an aborted signal: its reason when that is an Error, else an AbortError. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** True for cancellations (fetch, timers and `AbortSignal.throwIfAborted` all use this name). */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Slack file URLs can carry access tokens in their query string (`?t=xoxe-…`), so logged URLs
 * are reduced to origin + path.
 */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export { redactSecrets } from '../redact';

/**
 * Exponential backoff with "equal jitter": half the delay is fixed so retries never fire
 * immediately, the other half is random so parallel clients spread out.
 */
export function backoffMs(attempt: number, random: () => number = Math.random, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Parses a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value == null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** `plural(1, 'thread')` → "1 thread", `plural(2, 'thread')` → "2 threads". */
export function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Numeric Slack ts comparison (string order breaks when fractional digit counts differ). */
export function compareTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

/**
 * `ts - seconds` computed on the integer part so the 6-digit fraction survives exactly (a float
 * round-trip of a 16-significant-digit ts can drift by a microsecond).
 */
export function subtractSeconds(ts: string, seconds: number): string {
  const [whole, frac = '000000'] = ts.split('.');
  const shifted = Math.max(0, Number(whole) - Math.floor(seconds));
  return `${shifted}.${frac.padEnd(6, '0').slice(0, 6)}`;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight. After the first error no new
 * items start, and the promise settles only once every in-flight worker has finished, so the
 * caller never returns while work is still running in the background.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await worker(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane);
  const results = await Promise.allSettled(lanes);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}
