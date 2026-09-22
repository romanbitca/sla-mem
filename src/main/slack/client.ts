import { redactSecrets } from '../redact';
import type { SlackParams } from './api-types';
import { downloadOnce, describeFetchError, type DownloadOptions, type DownloadResult } from './download';
import { DownloadError, SlackApiError, SlackHttpError } from './errors';
import type { SlackApiResponse } from './types';
import {
  abortableSleep,
  abortReason,
  backoffMs,
  formatDuration,
  parseRetryAfter,
  stripQuery,
  throwIfAborted,
} from './util';

export type { DownloadOptions, DownloadResult } from './download';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const SLACK_API_BASE_URL = 'https://slack.com/api';

export interface SlackClientOptions {
  token: string;
  /**
   * Value of the `d` session cookie (xoxd-…) that goes with a browser-session token (xoxc-…).
   * Sent as `Cookie: d=…` on API calls and file downloads, to Slack hosts only.
   */
  cookie?: string;
  /** Web API base, default https://slack.com/api (tests point it at the mock Slack server). */
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Cancels in-flight requests and pending waits. */
  signal?: AbortSignal;
  /** Space calls per method by Slack's rate-limit tiers (default true; tests turn it off). */
  throttle?: boolean;
  /** Attempts per call/download for network errors and 5xx (default 5). */
  maxAttempts?: number;
  /** 429 responses tolerated per call before giving up (default 10). */
  maxRateLimitRetries?: number;
  /** Per-request timeout for API calls (default 60s). Downloads use an idle timeout instead. */
  requestTimeoutMs?: number;
  /** Injectable for tests. */
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
}

/**
 * Minimum spacing between calls of one method. Slack budgets each method separately per
 * workspace: tier 2 ≈ 20/min, tier 3 ≈ 50/min, tier 4 ≈ 100/min. Pacing slightly under the
 * budget means a long sync almost never sees a 429.
 */
const TIER_INTERVAL_MS = { 2: 3_000, 3: 1_200, 4: 600 } as const;
const METHOD_TIER: Record<string, keyof typeof TIER_INTERVAL_MS> = {
  'users.list': 2,
  'emoji.list': 2,
  'conversations.list': 2,
  'conversations.history': 3,
  'conversations.replies': 3,
  'users.conversations': 3,
  'conversations.info': 3,
  'team.info': 3,
  'client.counts': 3,
  'conversations.members': 4,
  'users.info': 4,
};

export function methodIntervalMs(method: string): number {
  if (method === 'auth.test') return 0; // "special" tier: hundreds per minute
  return TIER_INTERVAL_MS[METHOD_TIER[method] ?? 3];
}

/** `ok:false` codes that describe a Slack-side hiccup rather than an answer about the request. */
const RETRYABLE_API_ERRORS = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

const SLACK_AUTH_HOSTS = ['slack.com'];
const SLACK_PUBLIC_HOSTS = ['slack-edge.com', 'slack-files.com'];
const MAX_API_REDIRECTS = 5;

/**
 * The Cookie header slackdump sends with a client token: `d` URL-escaped only when it isn't
 * already URL-safe (a value copied from DevTools is already encoded; a raw one has `/ + =`), plus
 * `d-s`, a recent Unix timestamp the web client also sends.
 */
export function slackCookieHeader(cookie: string, nowMs: number = Date.now()): string {
  const d = /^[-._~%a-zA-Z0-9]+$/.test(cookie) ? cookie : queryEscape(cookie);
  return `d=${d}; d-s=${Math.floor(nowMs / 1000) - 10}`;
}

/** Go's url.QueryEscape: like encodeURIComponent, but also escapes !'()* and uses + for spaces. */
function queryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** Masks the token, the cookie (in every encoding) and anything shaped like a Slack secret. */
export function redactSlackSecrets(line: string, secrets: readonly (string | undefined)[] = []): string {
  return redactSecrets(line, secrets);
}

type Attempt<T> =
  | { kind: 'ok'; body: T & SlackApiResponse }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'transient'; error: SlackHttpError };

/**
 * Minimal Slack Web API client: form-encoded POSTs with a bearer token, per-method pacing,
 * 429/`Retry-After` handling, retries with backoff for network errors and 5xx, cursor pagination
 * and authenticated file downloads. The token is never logged and is only sent to Slack hosts.
 */
export class SlackClient {
  /** HTTP requests sent to the Web API, retries included (they count against rate limits too). */
  apiCalls = 0;

  private readonly token: string;
  private readonly cookie?: string;
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logFn: (line: string) => void;
  private readonly signal?: AbortSignal;
  private readonly throttle: boolean;
  private readonly maxAttempts: number;
  private readonly maxRateLimitRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly sleepFn: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;
  /** Earliest time the next call of each method may start. */
  private readonly nextSlot = new Map<string, number>();

  constructor(opts: SlackClientOptions) {
    if (!opts.token) throw new Error('SlackClient: a token is required');
    this.token = opts.token;
    this.cookie = opts.cookie || undefined;
    this.baseUrl = (opts.baseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/, '');
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const log = opts.log ?? (() => undefined);
    this.logFn = (line) => log(redactSlackSecrets(line, [this.token, this.cookie]));
    this.signal = opts.signal;
    this.throttle = opts.throttle ?? true;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.maxRateLimitRetries = Math.max(0, opts.maxRateLimitRetries ?? 10);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.sleepFn = opts.sleep ?? abortableSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Calls a Web API method. Throws `SlackApiError` on `ok:false`, `SlackHttpError` when retries run out. */
  async call<T = object>(method: string, params: SlackParams = {}): Promise<T & SlackApiResponse> {
    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      throwIfAborted(this.signal);
      await this.waitForSlot(method);
      const outcome = await this.attempt<T>(method, params);
      if (outcome.kind === 'ok') return outcome.body;
      if (outcome.kind === 'rate_limited') {
        if (++rateLimits > this.maxRateLimitRetries) throw new SlackApiError(method, { error: 'ratelimited' });
        const wait = outcome.retryAfterMs ?? backoffMs(rateLimits, this.random, 5_000, 60_000);
        this.deferMethod(method, wait);
        this.logFn(`slack: ${method} rate limited, waiting ${formatDuration(wait)}`);
        continue;
      }
      if (++failures >= this.maxAttempts) throw outcome.error;
      const wait = backoffMs(failures, this.random);
      this.logFn(
        `slack: ${outcome.error.message}; retry ${failures}/${this.maxAttempts - 1} in ${formatDuration(wait)}`,
      );
      await this.sleepFn(wait, this.signal);
    }
  }

  /**
   * Yields every page of a cursor-paginated method. Pagination ends when
   * `response_metadata.next_cursor` is missing or empty (Slack's end marker).
   */
  async *pages<T = object>(method: string, params: SlackParams = {}): AsyncGenerator<T & SlackApiResponse> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.call<T>(method, cursor ? { ...params, cursor } : params);
      yield page;
      cursor = page.response_metadata?.next_cursor || undefined;
      if (cursor && seen.has(cursor)) {
        this.logFn(`slack: ${method} returned a cursor twice; stopping pagination`);
        return;
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  /** Like `pages`, yielding only the array under `key` (e.g. `members`, `channels`, `messages`). */
  async *paginate<T>(method: string, params: SlackParams, key: string): AsyncGenerator<T[]> {
    for await (const page of this.pages<Record<string, unknown>>(method, params)) {
      const items = page[key];
      yield Array.isArray(items) ? (items as T[]) : [];
    }
  }

  /**
   * Downloads a Slack-hosted file (with the auth header) to `destPath`, atomically. Retries
   * network errors, 429 and 5xx; throws `DownloadError` for everything else.
   */
  async downloadFile(url: string, destPath: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    const signal = combineSignals(this.signal, opts.signal);
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      try {
        return await downloadOnce({
          ...opts,
          url,
          destPath,
          signal,
          fetch: this.fetchImpl,
          headersFor: (u, isRedirect) => this.downloadHeaders(u, isRedirect),
        });
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal);
        if (!(err instanceof DownloadError) || !err.retryable || attempt >= this.maxAttempts) throw err;
        const wait = err.retryAfterMs ?? backoffMs(attempt, this.random);
        this.logFn(
          `download ${stripQuery(url)}: ${err.message}; retry ${attempt}/${this.maxAttempts - 1} in ${formatDuration(wait)}`,
        );
        await this.sleepFn(wait, signal);
      }
    }
  }

  /**
   * Credentials (token and session cookie) go only to slack.com hosts and the configured API
   * origin. Slack's public CDNs are fetched without them; any other starting host is refused so an
   * imported export can't point the downloader at arbitrary URLs. Redirects may leave Slack (CDNs)
   * but then carry no credentials, and never downgrade to http.
   */
  private downloadHeaders(url: URL, isRedirect: boolean): Record<string, string> | null {
    if (this.isCredentialHost(url)) return this.credentialHeaders();
    if (url.protocol !== 'https:') return null;
    if (hostMatches(url.hostname, SLACK_PUBLIC_HOSTS) || isRedirect) return {};
    return null;
  }

  /** The configured API origin, or an https host under slack.com. */
  private isCredentialHost(url: URL): boolean {
    if (url.origin === this.baseOrigin) return true;
    return url.protocol === 'https:' && hostMatches(url.hostname, SLACK_AUTH_HOSTS);
  }

  private credentialHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (this.cookie) headers.Cookie = slackCookieHeader(this.cookie, this.now());
    return headers;
  }

  private async attempt<T>(method: string, params: SlackParams): Promise<Attempt<T>> {
    this.apiCalls++;
    let res: Response;
    try {
      res = await this.post(method, encodeParams(params));
    } catch (err) {
      throwIfAborted(this.signal);
      return transient(method, null, describeFetchError(err));
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()) };
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      return transient(method, res.status, `HTTP ${res.status}`);
    }
    return this.interpretBody<T>(method, res);
  }

  /**
   * POSTs to the Web API following redirects by hand: credentials are re-sent only to Slack hosts
   * (fetch's own redirect handling would decide that for us, and differs between runtimes).
   */
  private async post(method: string, body: string): Promise<Response> {
    let url = new URL(`${this.baseUrl}/${method}`);
    const signal = this.requestSignal();
    let init: RequestInit = { method: 'POST', body, redirect: 'manual', signal };
    for (let hop = 0; ; hop++) {
      const credentials = this.isCredentialHost(url) ? this.credentialHeaders() : {};
      const contentType: Record<string, string> =
        init.body != null ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } : {};
      const res = await this.fetchImpl(url.href, { ...init, headers: { ...credentials, ...contentType } });
      const location = isRedirectStatus(res.status) ? res.headers.get('location') : null;
      if (!location || hop >= MAX_API_REDIRECTS) return res;
      await res.body?.cancel().catch(() => undefined);
      url = new URL(location, url);
      // 307/308 repeat the request as is; 301/302/303 turn it into a GET without a body (fetch semantics).
      if (res.status !== 307 && res.status !== 308) init = { method: 'GET', redirect: 'manual', signal };
    }
  }

  private async interpretBody<T>(method: string, res: Response): Promise<Attempt<T>> {
    let body: (T & SlackApiResponse) | null = null;
    try {
      body = (await res.json()) as T & SlackApiResponse;
    } catch (err) {
      throwIfAborted(this.signal);
      if (err instanceof Error && err.name === 'TimeoutError') return transient(method, res.status, 'timed out');
    }
    if (!body || typeof body !== 'object') {
      if (res.status >= 400) throw new SlackHttpError(method, res.status, `HTTP ${res.status}`);
      return transient(method, res.status, 'invalid JSON response');
    }
    if (body.ok) return { kind: 'ok', body };
    if (body.error === 'ratelimited') {
      return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()) };
    }
    if (RETRYABLE_API_ERRORS.has(body.error ?? '')) return transient(method, res.status, body.error ?? 'error');
    throw new SlackApiError(method, body);
  }

  /** Reserves the method's next slot synchronously, so concurrent callers queue instead of bursting. */
  private async waitForSlot(method: string): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextSlot.get(method) ?? 0);
    this.nextSlot.set(method, at + (this.throttle ? methodIntervalMs(method) : 0));
    if (at > now) await this.sleepFn(at - now, this.signal);
  }

  /** After a 429, every caller of that method waits out Retry-After, not just the one that got it. */
  private deferMethod(method: string, waitMs: number): void {
    const until = this.now() + waitMs;
    this.nextSlot.set(method, Math.max(this.nextSlot.get(method) ?? 0, until));
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }
}

function transient<T>(method: string, status: number | null, detail: string): Attempt<T> {
  return { kind: 'transient', error: new SlackHttpError(method, status, detail) };
}

function encodeParams(params: SlackParams): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, String(value));
  }
  return form.toString();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}
